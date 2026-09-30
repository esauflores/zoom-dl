// response → recording identity — pure

import type { MediaMeta, ZoomResponse, ZoomResult } from "../types.ts";

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
