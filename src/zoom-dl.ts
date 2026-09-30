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
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { CookieJar } from "tough-cookie";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

// ---------- response contracts (only the fields we read) ----------

export interface ZoomResult {
  componentName?: string;
  redirectUrl?: string;
  useWhichPasswd?: string;
  sharelevel?: string;
  action?: string;
  encryptMeetId?: string;
  fileId?: string;
  viewMp4Url?: string;
  mp4Url?: string;
  accessId?: string;
  duration?: number;
  recording?: { id?: string; playId?: string; fileSizeInMB?: string };
  meet?: { topic?: string };
}

export interface ZoomResponse {
  status?: boolean;
  errorMessage?: string;
  result?: ZoomResult | null;
}

// ---------- pure helpers (tested) ----------

function safeUrl(raw: string, base?: string): URL | null {
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

export function parseUrl(raw: string): { host: string; hostname: string; query: Record<string, string>; iet: string } {
  const u = safeUrl(raw);
  if (!u) return { host: "", hostname: "", query: {}, iet: "" };
  const query: Record<string, string> = {};
  for (const [k, v] of u.searchParams) if (k !== "originRequestUrl") query[k] = v;
  return { host: `${u.protocol}//${u.host}`, hostname: u.hostname, query, iet: u.searchParams.get("iet") ?? "" };
}

/** gate pages (/rec/component-page) carry the real link in originRequestUrl */
export function resolveStart(raw: string): string {
  const u = safeUrl(raw);
  return u?.pathname.includes("/rec/component-page") ? u.searchParams.get("originRequestUrl") || raw : raw;
}

/** value of a `key: '...'` entry in window.__data__ */
export function pageVal(key: string, html: string): string {
  return html.match(new RegExp(`${key}:\\s*['"]([^'"]*)['"]`))?.[1] ?? "";
}

/** the new player answers componentName=need-password when gated */
export function gateOf(res: ZoomResponse): ZoomResult | null {
  return res.result?.componentName === "need-password" ? res.result : null;
}

export interface MediaMeta {
  viewUrl: string;
  playId: string;
  accessId: string;
  recordingId: string;
  duration: number;
  sizeMB: number;
  topic: string;
}

export function mediaMeta(r: ZoomResult): MediaMeta {
  return {
    viewUrl: r.viewMp4Url || r.mp4Url || "",
    playId: r.recording?.playId ?? "",
    accessId: r.accessId ?? "",
    recordingId: r.recording?.id ?? "",
    duration: Number(r.duration ?? 0),
    sizeMB: parseFloat(String(r.recording?.fileSizeInMB ?? "0")) || 0,
    topic: r.meet?.topic || "zoom-recording",
  };
}

export function slug(topic: string): string {
  return topic.replace(/[ /\\]/g, "-").replace(/[^A-Za-z0-9Á-ÿ._-]/g, "") || "zoom-recording";
}

/** recording id in the name makes it unique per recording, so a resume can only ever resume itself */
export function outName(meta: MediaMeta, secs: number): string {
  return `${slug(meta.topic)}${meta.recordingId ? `-${meta.recordingId.slice(0, 8)}` : ""}${secs ? `-first${secs}s` : ""}.mp4`;
}

/** bytes to fetch for an N-second preview: moov headroom + 2x the average byte rate */
export function previewBytes(sizeMB: number, duration: number, seconds: number): number {
  return 3 * 1024 * 1024 + Math.trunc(((sizeMB * 1024 * 1024 * seconds) / Math.max(duration, 1)) * 2);
}

/** 0 = full download, null = invalid */
export function parseSeconds(raw: string | undefined): number | null {
  if (raw == null || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** append only when the server confirmed our resume offset (206); anything else starts over */
export function writeMode(partialBytes: number, status: number): "a" | "w" {
  return partialBytes > 0 && status === 206 ? "a" : "w";
}

// ---------- cli ----------

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
    headers: { "user-agent": UA },
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
      {
        headers: csrfHeaders,
      },
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
  } else {
    const have = existsSync(out) ? statSync(out).size : 0;
    const expected = meta.sizeMB * 1024 * 1024;
    if (!(expected && have >= expected * 0.95)) await transfer(client, meta.viewUrl, out, { referer }, have);
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
