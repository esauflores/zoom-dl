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
import got, { HTTPError, type Got, type OptionsInit, type Response } from "got";
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { CookieJar } from "tough-cookie";

import {
  gateOf,
  mediaMeta,
  outName,
  pageVal,
  parseSeconds,
  parseUrl,
  previewBytes,
  resolveStart,
  safeUrl,
  writeMode,
} from "./helpers.ts";
import type { ZoomResponse, ZoomResult } from "./types.ts";

function die(msg: string): never {
  console.error(`zoom-dl: ${msg}`);
  process.exit(1);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isHttp(e: unknown, status: number): boolean {
  return e instanceof HTTPError && e.response.statusCode === status;
}

async function run(url: string, pass: string, secs: number, outDir: string): Promise<void> {
  const start = resolveStart(url);
  const ctx = parseUrl(start);
  const { host } = ctx;
  if (!host) die(`invalid url: ${url}`);
  const work = mkdtempSync(join(tmpdir(), "zoom-dl-"));
  process.on("exit", () => rmSync(work, { recursive: true, force: true }));

  const client = got.extend({
    cookieJar: new CookieJar(),
    followRedirect: true,
    retry: { limit: 2 },
  });

  const fetchPage = async (u: string): Promise<string> => {
    try {
      return (await client.get(u)).body;
    } catch (e) {
      return die(`fetch failed: ${errMsg(e)}`);
    }
  };
  const fetchJson = async (u: string, opts: OptionsInit = {}): Promise<ZoomResponse> => {
    let parsed: unknown;
    try {
      parsed = (await client(u, { responseType: "json", ...opts })).body;
    } catch (e) {
      return die(`request failed: ${errMsg(e)}`);
    }
    if (!parsed || typeof parsed !== "object") return die(`unexpected response from ${u}`);
    return parsed as ZoomResponse;
  };

  // 1. CSRF token (zoom validates POSTs through CSRFGuard)
  const csrfResp = await client
    .post(`${host}/csrf_js?t_x_zm_rid=1`, { headers: { "FETCH-CSRF-TOKEN": "1" }, throwHttpErrors: false })
    .catch(() => ({ body: "" }));
  const csrf = csrfResp.body.trim();
  const csrfAt = csrf.indexOf(":");
  const csrfHeaders: Record<string, string> = csrfAt > 0 ? { [csrf.slice(0, csrfAt)]: csrf.slice(csrfAt + 1) } : {};

  // 2. passcode gate: the player points at a component page holding the id to
  //    validate; /rec/validate_meet_passwd (old flow) is long dead.
  const passGate = async (gate: ZoomResult): Promise<void> => {
    if (!pass) die("passcode protected — pass it as argument 2");
    const pageUrl = safeUrl(gate.redirectUrl ?? "", host);
    if (!pageUrl) die(`bad gate redirect: ${gate.redirectUrl}`);
    for (const [k, v] of Object.entries(gate)) if (v != null) pageUrl.searchParams.set(k, String(v));
    const compHtml = await fetchPage(pageUrl.toString());
    const meetId = pageVal("meeting_id", compHtml);
    const compFileId = pageVal("fileId", compHtml);
    if (!meetId) die("could not read meeting_id from passcode page");
    const useW = gate.useWhichPasswd || "meeting";
    const vctx = await fetchJson(`${host}/nws/recording/1.0/validate-context`, {
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
      `${host}/nws/recording/1.0/${useW === "meeting" ? "validate-meeting-passwd" : "validate-passwd"}`,
      {
        method: "post",
        headers: csrfHeaders,
        form: { id: vid, passwd: pass, action: gate.action || "viewdetailpage", recaptcha: "" },
      },
    );
    if (!ok.status) die(`passcode rejected: ${ok.errorMessage}`);
  };

  // 3. page -> fileId; share links have none and bounce through play/share-info
  //    (which may itself be the gate) before landing on the play page.
  let html = await fetchPage(start);
  let fileId = pageVal("fileId", html);
  if (!fileId) {
    const meeting = pageVal("meetingId", html);
    if (!meeting) die("no fileId on page — link expired or wrong url");
    const sinfoUrl = `${host}/nws/recording/1.0/play/share-info/${meeting}`;
    let sinfo = await fetchJson(sinfoUrl);
    const shareGate = gateOf(sinfo);
    if (shareGate) {
      await passGate(shareGate);
      sinfo = await fetchJson(sinfoUrl);
    }
    let redir = sinfo.result?.redirectUrl ?? "";
    if (!redir) die("share-info returned no redirect");
    if (!redir.startsWith("http")) redir = host + redir;
    const from = parseUrl(redir);
    if (Object.keys(from.query).length) {
      ctx.query = from.query;
      ctx.iet = from.iet;
    }
    html = await fetchPage(redir);
    fileId = pageVal("fileId", html);
  }
  if (!fileId) die("no fileId on page — link expired or wrong url");

  const playInfo = async (): Promise<ZoomResponse> =>
    fetchJson(
      `${host}/nws/recording/1.0/play/info/${fileId}?${new URLSearchParams(ctx.query)}&originDomain=${ctx.hostname}`,
      { headers: csrfHeaders },
    );
  let info = await playInfo();
  const infoGate = gateOf(info);
  if (infoGate) {
    await passGate(infoGate);
    info = await playInfo();
  }

  // 4. media info + CDN unlock (without playcheck the CDN 403s)
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
  const referer = `${host}/`;
  if (secs) {
    const part = join(work, "part.mp4");
    // ponytail: the CDN honors Range (verified); one that ignores it just fills tmp, the trim still works
    await transfer(
      client,
      meta.viewUrl,
      part,
      { referer, range: `bytes=0-${previewBytes(meta.sizeMB, meta.duration, secs)}` },
      0,
    );
    const ff = spawnSync(
      ffmpegPath ?? "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        part,
        "-t",
        String(secs),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        out,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (ff.status !== 0) die("ffmpeg failed");
  } else if (!existsSync(out)) {
    // .part + rename: an existing .mp4 is complete by construction, no size guesswork
    const part = `${out}.part`;
    await transfer(client, meta.viewUrl, part, { referer }, existsSync(part) ? statSync(part).size : 0);
    renameSync(part, out);
  }
  console.log(out);
}

/** stream a URL to a file; partialBytes > 0 resumes with a Range request */
async function transfer(
  client: Got,
  url: string,
  out: string,
  headers: Record<string, string>,
  partialBytes: number,
): Promise<void> {
  const reqHeaders = partialBytes > 0 ? { ...headers, range: `bytes=${partialBytes}-` } : headers;
  await new Promise<void>((resolve, reject) => {
    const req = client.stream.get(url, { headers: reqHeaders, retry: { limit: 3 } });
    req.on("response", (resp: Response) => {
      pipeline(req, createWriteStream(out, { flags: writeMode(partialBytes, resp.statusCode ?? 200) })).then(
        resolve,
        reject,
      );
    });
    req.on("error", (e: unknown) => (partialBytes > 0 && isHttp(e, 416) ? resolve() : reject(e)));
  }).catch((e) => {
    if (partialBytes > 0 && isHttp(e, 416)) return; // already fully retrieved
    die(`download failed: ${errMsg(e)}`);
  });
}

if (import.meta.main) {
  await new Command()
    .name("zoom-dl")
    .description("Download a Zoom cloud recording (passcode-protected / download-disabled friendly)")
    .argument("<url>", "/rec/play/..., /rec/share/... or the passcode page link")
    .argument("[passcode]", "meeting passcode; omit if the recording is not protected")
    .argument("[seconds]", "only grab the first N seconds (quick preview)")
    .option("-o, --out-dir <dir>", "output directory", process.env.ZOOM_DL_DIR || join(homedir(), "Downloads"))
    .action(
      async (url: string, passcode: string | undefined, seconds: string | undefined, opts: { outDir: string }) => {
        const secs = parseSeconds(seconds);
        if (secs == null) die(`invalid seconds: ${seconds}`);
        await run(url, passcode ?? "", secs, opts.outDir);
      },
    )
    .parseAsync();
}
