// helpers — plumbing and pure logic; zoom-dl.ts keeps the core flow only

import { HTTPError, type Got, type OptionsInit } from "got";

import type { MediaMeta, ZoomResponse, ZoomResult } from "./types.ts";

export function die(msg: string): never {
  console.error(`zoom-dl: ${msg}`);
  process.exit(1);
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function isHttp(e: unknown, status: number): boolean {
  return e instanceof HTTPError && e.response.statusCode === status;
}

export async function fetchPage(client: Got, u: string): Promise<string> {
  try {
    return (await client.get(u)).body;
  } catch (e) {
    return die(`fetch failed: ${errMsg(e)}`);
  }
}

export async function fetchJson(client: Got, u: string, opts: OptionsInit = {}): Promise<ZoomResponse> {
  let parsed: unknown;
  try {
    parsed = (await client(u, { responseType: "json", ...opts })).body;
  } catch (e) {
    return die(`request failed: ${errMsg(e)}`);
  }
  if (!parsed || typeof parsed !== "object") return die(`unexpected response from ${u}`);
  return parsed as ZoomResponse;
}

export function safeUrl(raw: string, base?: string): URL | null {
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
  return html.match(new RegExp(`\\b${key}:\\s*['"]([^'"]*)['"]`))?.[1] ?? "";
}

/** the new player answers componentName=need-password when gated */
export function gateOf(res: ZoomResponse): ZoomResult | null {
  return res.result?.componentName === "need-password" ? res.result : null;
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
