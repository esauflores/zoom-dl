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
// needs: curl (+ ffmpeg only for the seconds mode)

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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

/** recording id in the name makes it unique per recording, so curl -C - only ever resumes itself */
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

// ---------- cli ----------

function die(msg: string): never {
  console.error(`zoom-dl: ${msg}`);
  process.exit(1);
}

/** curl does HTTP (resume/retry/cookies); --fail so error pages never end up as .mp4 */
function curl(jar: string, args: string[], outFile?: string, allowFail = false): string {
  const res = spawnSync(
    "curl",
    ["-sS", "--fail", "--compressed", "-b", jar, "-c", jar, "-A", UA, ...(outFile ? ["-o", outFile] : []), ...args],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.status !== 0 && !allowFail) die(`curl failed: ${res.stderr?.trim() || res.status}`);
  return res.stdout ?? "";
}

function run(url: string, pass: string, secs: number, outDir: string): void {
  const start = resolveStart(url);
  const ctx = parseUrl(start);
  const { host } = ctx;
  if (!host) die(`invalid url: ${url}`);
  const work = mkdtempSync(join(tmpdir(), "zoom-dl-"));
  process.on("exit", () => rmSync(work, { recursive: true, force: true }));
  const jar = join(work, "cookies.txt");

  const fetchPage = (u: string): string => {
    const f = join(work, "page.html");
    curl(jar, ["-L", u], f);
    return readFileSync(f, "utf8");
  };
  const fetchJson = (u: string, args: string[], name: string): ZoomResponse => {
    const f = join(work, name);
    curl(jar, [...args, u], f);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      return die(`invalid json from ${u}`);
    }
    if (!parsed || typeof parsed !== "object") return die(`unexpected response from ${u}`);
    return parsed as ZoomResponse;
  };

  // 1. CSRF token (zoom validates POSTs through CSRFGuard)
  const csrf = curl(
    jar,
    ["-X", "POST", "-H", "FETCH-CSRF-TOKEN: 1", `${host}/csrf_js?t_x_zm_rid=1`],
    undefined,
    true,
  ).trim();
  const csrfH = csrf.includes(":") ? ["-H", csrf] : [];
  const formH = ["-X", "POST", "-H", "Content-Type: application/x-www-form-urlencoded; charset=UTF-8", ...csrfH];

  // 2. passcode gate: the player points at a component page holding the id to
  //    validate; /rec/validate_meet_passwd (old flow) is long dead.
  const passGate = (gate: ZoomResult): void => {
    if (!pass) die("passcode protected — pass it as argument 2");
    const pageUrl = safeUrl(gate.redirectUrl ?? "", host);
    if (!pageUrl) die(`bad gate redirect: ${gate.redirectUrl}`);
    for (const [k, v] of Object.entries(gate)) if (v != null) pageUrl.searchParams.set(k, String(v));
    const compHtml = fetchPage(pageUrl.toString());
    const meetId = pageVal("meeting_id", compHtml);
    const compFileId = pageVal("fileId", compHtml);
    if (!meetId) die("could not read meeting_id from passcode page");
    const useW = gate.useWhichPasswd || "meeting";
    const vctx = fetchJson(
      `${host}/nws/recording/1.0/validate-context`,
      [
        ...formH,
        ...form({
          meetingId: meetId,
          fileId: compFileId,
          useWhichPasswd: useW,
          sharelevel: gate.sharelevel || "meeting",
          iet: ctx.iet,
        }),
      ],
      "vctx.json",
    );
    const vid = useW === "meeting" ? vctx.result?.encryptMeetId : vctx.result?.fileId || compFileId;
    if (!vid) die("validate-context failed (wrong passcode or dead link)");
    const ok = fetchJson(
      `${host}/nws/recording/1.0/${useW === "meeting" ? "validate-meeting-passwd" : "validate-passwd"}`,
      [...formH, ...form({ id: vid, passwd: pass, action: gate.action || "viewdetailpage", recaptcha: "" })],
      "validate.json",
    );
    if (!ok.status) die(`passcode rejected: ${ok.errorMessage}`);
  };

  // 3. page -> fileId; share links have none and bounce through play/share-info
  //    (which may itself be the gate) before landing on the play page.
  let html = fetchPage(start);
  let fileId = pageVal("fileId", html);
  if (!fileId) {
    const meeting = pageVal("meetingId", html);
    if (!meeting) die("no fileId on page — link expired or wrong url");
    const sinfoUrl = `${host}/nws/recording/1.0/play/share-info/${meeting}`;
    let sinfo = fetchJson(sinfoUrl, [], "sinfo.json");
    const shareGate = gateOf(sinfo);
    if (shareGate) {
      passGate(shareGate);
      sinfo = fetchJson(sinfoUrl, [], "sinfo.json");
    }
    let redir = sinfo.result?.redirectUrl ?? "";
    if (!redir) die("share-info returned no redirect");
    if (!redir.startsWith("http")) redir = host + redir;
    const from = parseUrl(redir);
    if (Object.keys(from.query).length) {
      ctx.query = from.query;
      ctx.iet = from.iet;
    }
    html = fetchPage(redir);
    fileId = pageVal("fileId", html);
  }
  if (!fileId) die("no fileId on page — link expired or wrong url");

  const playInfo = (): ZoomResponse =>
    fetchJson(
      `${host}/nws/recording/1.0/play/info/${fileId}?${new URLSearchParams(ctx.query)}&originDomain=${ctx.hostname}`,
      csrfH,
      "info.json",
    );
  let info = playInfo();
  const infoGate = gateOf(info);
  if (infoGate) {
    passGate(infoGate);
    info = playInfo();
  }

  // 4. media info + CDN unlock (without playcheck the CDN 403s)
  const meta = mediaMeta(info.result ?? {});
  if (!meta.viewUrl) die("no playable media url in play/info response");
  if (!meta.playId || !meta.accessId) die("play/info missing playId/accessId");
  curl(
    jar,
    [
      ...csrfH,
      "--get",
      "--data-urlencode",
      `accid=${meta.accessId}`,
      "--data",
      "dur=0",
      `${host}/nws/recording/1.0/playcheck/${meta.playId}`,
    ],
    undefined,
    true,
  );

  // 5. download (cdn wants cookie jar + referer; ffmpeg's own http client gets 403'd)
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, outName(meta, secs));
  if (secs) {
    const part = join(work, "part.mp4");
    curl(
      jar,
      ["-H", `Referer: ${host}/`, "-r", `0-${previewBytes(meta.sizeMB, meta.duration, secs)}`, meta.viewUrl],
      part,
    );
    const ff = spawnSync(
      "ffmpeg",
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
    if (!(expected && have >= expected * 0.95)) {
      curl(jar, ["-H", `Referer: ${host}/`, "--retry", "3", "-C", "-", meta.viewUrl], out);
    }
  }
  console.log(out);
}

/** curl form args for application/x-www-form-urlencoded POSTs */
const form = (data: Record<string, string>): string[] =>
  Object.entries(data).flatMap(([k, v]) => ["--data-urlencode", `${k}=${v}`]);

if (import.meta.main) {
  new Command()
    .name("zoom-dl")
    .description("Download a Zoom cloud recording (passcode-protected / download-disabled friendly)")
    .argument("<url>", "/rec/play/..., /rec/share/... or the passcode page link")
    .argument("[passcode]", "meeting passcode; omit if the recording is not protected")
    .argument("[seconds]", "only grab the first N seconds (quick preview)")
    .option("-o, --out-dir <dir>", "output directory", process.env.ZOOM_DL_DIR || join(homedir(), "Downloads"))
    .action((url: string, passcode: string | undefined, seconds: string | undefined, opts: { outDir: string }) => {
      const secs = parseSeconds(seconds);
      if (secs == null) die(`invalid seconds: ${seconds}`);
      run(url, passcode ?? "", secs, opts.outDir);
    })
    .parse();
}
