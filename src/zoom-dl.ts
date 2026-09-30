#!/usr/bin/env bun
// zoom-dl — download a Zoom cloud recording.
// Works on passcode-protected recordings and when the owner disabled the download button.
//
// usage: zoom-dl <url> [passcode] [seconds] [-o dir]
//   url      /rec/play/..., /rec/share/... or the passcode page link
//           (the one carrying ?iet=... is fine)
//   passcode meeting passcode; omit if the recording is not protected
//   seconds  only grab the first N seconds (quick preview)
//
// needs: bun (the seconds preview uses the bundled ffmpeg)

import { Command } from "commander";
import ffmpegPath from "ffmpeg-static";
import got from "got";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar } from "tough-cookie";

import { previewBytes } from "./helpers/download.ts";
import { die } from "./helpers/errors.ts";
import { fetchJson, fetchPage, transfer } from "./helpers/http.ts";
import { gateOf, mediaMeta, outName } from "./helpers/media.ts";
import { pageVal, parseSeconds, parseUrl, resolveStart, safeUrl } from "./helpers/parse.ts";
import type { ZoomResponse, ZoomResult } from "./types.ts";

// flow: page -> (passcode gate) -> fileId -> play/info -> playcheck -> transfer
async function run(url: string, pass: string, secs: number, outDir: string): Promise<void> {
  const start = resolveStart(url);
  const ctx = parseUrl(start);
  const { host } = ctx;
  if (!host) die(`invalid url: ${url}`);
  // scratch dir for the preview's byte range; cleaned up however we exit
  const work = mkdtempSync(join(tmpdir(), "zoom-dl-"));
  process.on("exit", () => rmSync(work, { recursive: true, force: true }));

  const client = got.extend({
    cookieJar: new CookieJar(),
    followRedirect: true,
    retry: { limit: 2 },
  });

  // 1. CSRF token: CSRFGuard answers the FETCH-CSRF-TOKEN request with "NAME:value";
  //    that pair becomes a request header on every POST below (split at the first
  //    colon — the value may contain more). No token = those POSTs 403.
  const csrfResp = await client
    .post(`${host}/csrf_js?t_x_zm_rid=1`, { headers: { "FETCH-CSRF-TOKEN": "1" }, throwHttpErrors: false })
    .catch(() => ({ body: "" }));
  const csrf = csrfResp.body.trim();
  const csrfAt = csrf.indexOf(":");
  const csrfHeaders: Record<string, string> = csrfAt > 0 ? { [csrf.slice(0, csrfAt)]: csrf.slice(csrfAt + 1) } : {};

  // 2. passcode gate (componentName=need-password): follow the redirect to the
  //    component page, echo the gate's query params back at it, read meeting_id
  //    from window.__data__. Then two POSTs: validate-context exchanges the meeting
  //    id for the id to check (encryptMeetId for meeting passcodes, fileId for
  //    recording-level ones), and validate-meeting-passwd / validate-passwd checks
  //    the passcode itself. (/rec/validate_meet_passwd, the old flow, is long dead.)
  const passGate = async (gate: ZoomResult): Promise<void> => {
    if (!pass) die("passcode protected — pass it as argument 2");
    const pageUrl = safeUrl(gate.redirectUrl ?? "", host);
    if (!pageUrl) die(`bad gate redirect: ${gate.redirectUrl}`);
    // the component page expects the gate's own params echoed in its query
    for (const [k, v] of Object.entries(gate)) if (v != null) pageUrl.searchParams.set(k, String(v));
    const compHtml = await fetchPage(client, pageUrl.toString());
    const meetId = pageVal("meeting_id", compHtml);
    const compFileId = pageVal("fileId", compHtml);
    if (!meetId) die("could not read meeting_id from passcode page");
    const useW = gate.useWhichPasswd || "meeting";
    const vctx = await fetchJson(client, `${host}/nws/recording/1.0/validate-context`, {
      method: "post",
      headers: csrfHeaders,
      form: {
        meetingId: meetId,
        fileId: compFileId,
        useWhichPasswd: useW,
        sharelevel: gate.sharelevel || "meeting",
        iet: ctx.iet,
      },
    });
    const vid = useW === "meeting" ? vctx.result?.encryptMeetId : vctx.result?.fileId || compFileId;
    if (!vid) die("validate-context failed (wrong passcode or dead link)");
    const ok = await fetchJson(
      client,
      `${host}/nws/recording/1.0/${useW === "meeting" ? "validate-meeting-passwd" : "validate-passwd"}`,
      {
        method: "post",
        headers: csrfHeaders,
        form: { id: vid, passwd: pass, action: gate.action || "viewdetailpage", recaptcha: "" },
      },
    );
    if (!ok.status) die(`passcode rejected: ${ok.errorMessage}`);
  };

  // 3. find fileId in window.__data__. Play links carry it directly; share links
  //    (/rec/share/...) don't and bounce through play/share-info/<meetingId>, which
  //    redirects to the play page and can itself be the passcode gate. The play/info
  //    call below needs the query params that come with the redirect, so keep them.
  let html = await fetchPage(client, start);
  let fileId = pageVal("fileId", html);
  if (!fileId) {
    const meeting = pageVal("meetingId", html);
    if (!meeting) die("no fileId on page — link expired or wrong url");
    const sinfoUrl = `${host}/nws/recording/1.0/play/share-info/${meeting}`;
    let sinfo = await fetchJson(client, sinfoUrl);
    const shareGate = gateOf(sinfo);
    if (shareGate) {
      await passGate(shareGate);
      sinfo = await fetchJson(client, sinfoUrl);
    }
    let redir = sinfo.result?.redirectUrl ?? "";
    if (!redir) die("share-info returned no redirect");
    if (!redir.startsWith("http")) redir = host + redir;
    const from = parseUrl(redir);
    if (Object.keys(from.query).length) {
      ctx.query = from.query;
      ctx.iet = from.iet;
    }
    html = await fetchPage(client, redir);
    fileId = pageVal("fileId", html);
  }
  if (!fileId) die("no fileId on page — link expired or wrong url");

  // play/info wants the page's query params + originDomain; retried after the gate opens
  const playInfo = async (): Promise<ZoomResponse> =>
    fetchJson(
      client,
      `${host}/nws/recording/1.0/play/info/${fileId}?${new URLSearchParams(ctx.query)}&originDomain=${ctx.hostname}`,
      { headers: csrfHeaders },
    );
  let info = await playInfo();
  const infoGate = gateOf(info);
  if (infoGate) {
    await passGate(infoGate);
    info = await playInfo();
  }

  // 4. media info + CDN unlock: playcheck marks the session as really playing;
  //    without it the CDN 403s the transfer. Best effort — transfer fails loudly anyway.
  const meta = mediaMeta(info.result ?? {});
  if (!meta.viewUrl) die("no playable media url in play/info response");
  if (!meta.playId || !meta.accessId) die("play/info missing playId/accessId");
  await client
    .get(`${host}/nws/recording/1.0/playcheck/${meta.playId}`, {
      searchParams: { accid: meta.accessId, dur: 0 },
      headers: csrfHeaders,
      throwHttpErrors: false,
    })
    .catch(() => undefined);

  // 5. transfer: stream to disk (non-2xx throws, so error pages never end up as .mp4)
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, outName(meta, secs));
  const referer = `${host}/`; // the CDN checks Referer
  if (secs) {
    const part = join(work, "part.mp4");
    // fetch only the first N-seconds of bytes for the preview trim
    const range = `bytes=0-${previewBytes(meta.sizeMB, meta.duration, secs)}`;
    await transfer(client, meta.viewUrl, part, { referer, range }, 0);

    const ff = spawnSync(
      ffmpegPath ?? "ffmpeg",
      ["-loglevel", "error", "-y", "-i", part, "-t", String(secs), "-c", "copy", out],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (ff.status !== 0) die("ffmpeg failed");
  } else if (!existsSync(out)) {
    // .part + rename: an existing .mp4 is complete by construction, no size guesswork
    const part = `${out}.part`;
    await transfer(client, meta.viewUrl, part, { referer }, existsSync(part) ? statSync(part).size : 0);
    renameSync(part, out);
  }
  console.log(out); // the one stdout line: where the recording landed
}

if (import.meta.main) {
  await new Command()
    .name("zoom-dl")
    .description("Download a Zoom cloud recording (passcode-protected / download-disabled friendly)")
    .argument("<url>", "/rec/play/..., /rec/share/... or the passcode page link")
    .argument("[passcode]", "meeting passcode; omit if the recording is not protected")
    .argument("[seconds]", "only grab the first N seconds (quick preview)")
    .option("-o, --out-dir <dir>", "output directory", process.env.ZOOM_DL_DIR || join(homedir(), "Downloads"))
    .addHelpText(
      "after",
      `
examples:
  zoom-dl 'https://.../rec/play/...' 'KD+ZLT1s'          # full recording
  zoom-dl 'https://.../rec/share/...' '*8q*n4mW' 10      # 10s preview
  zoom-dl 'https://.../rec/component-page?...' '...' -o /tmp`,
    )
    .action(
      async (url: string, passcode: string | undefined, seconds: string | undefined, opts: { outDir: string }) => {
        const secs = parseSeconds(seconds);
        if (secs == null) die(`invalid seconds: ${seconds}`);
        await run(url, passcode ?? "", secs, opts.outDir);
      },
    )
    .parseAsync();
}
