import { describe, expect, it } from "vitest";

import { gateOf, mediaMeta, pageVal, parseUrl, previewBytes, resolveStart, slug } from "./zoom-dl";

const PLAY_URL =
  "https://us02web.zoom.us/rec/play/AbC.123?accessLevel=meeting&canPlayFromShare=true&continueMode=true&iet=TOK.ET&componentName=rec-play&originRequestUrl=https%3A%2F%2Fus02web.zoom.us%2Frec%2Fshare%2Fx%3Fiet%3Dinner";

describe("parseUrl", () => {
  it("keeps query params but drops originRequestUrl", () => {
    const { host, query, iet } = parseUrl(PLAY_URL);
    expect(host).toBe("https://us02web.zoom.us");
    expect(query).toEqual({
      accessLevel: "meeting",
      canPlayFromShare: "true",
      continueMode: "true",
      iet: "TOK.ET",
      componentName: "rec-play",
    });
    expect(iet).toBe("TOK.ET");
  });
});

describe("resolveStart", () => {
  it("unwraps passcode gate pages to the real link", () => {
    const gate =
      "https://us02web.zoom.us/rec/component-page?componentName=need-password&meetingId=m-1&originRequestUrl=https%3A%2F%2Fus02web.zoom.us%2Frec%2Fshare%2Fabc%3Fiet%3Dtok";
    expect(resolveStart(gate)).toBe("https://us02web.zoom.us/rec/share/abc?iet=tok");
  });
  it("leaves play/share links alone", () => {
    expect(resolveStart(PLAY_URL)).toBe(PLAY_URL);
  });
});

describe("pageVal", () => {
  it("reads window.__data__ string values", () => {
    const html = `window.__data__ = {\n  meetingId: 'm-1',\n  fileId: '',\n  useWhichPasswd: "meeting"\n}`;
    expect(pageVal("meetingId", html)).toBe("m-1");
    expect(pageVal("fileId", html)).toBe("");
    expect(pageVal("meeting_id", html)).toBe("");
    expect(pageVal("useWhichPasswd", html)).toBe("meeting");
  });
});

describe("gateOf", () => {
  it("returns the gate payload and nothing else", () => {
    const gate = { componentName: "need-password", redirectUrl: "/rec/component-page" };
    expect(gateOf({ result: gate })).toEqual(gate);
    expect(gateOf({ result: { componentName: "rec-play" } })).toBeNull();
    expect(gateOf({ result: null })).toBeNull();
    expect(gateOf({})).toBeNull();
  });
});

describe("mediaMeta", () => {
  it("extracts playback fields", () => {
    const meta = mediaMeta({
      viewMp4Url: "https://cdn/x.mp4",
      accessId: "acc",
      duration: 5242,
      recording: { playId: "pid", fileSizeInMB: "184 MB" },
      meet: { topic: "CURSO XTRAIL" },
    });
    expect(meta).toEqual({
      viewUrl: "https://cdn/x.mp4",
      playId: "pid",
      accessId: "acc",
      duration: 5242,
      sizeMB: 184,
      topic: "CURSO XTRAIL",
    });
  });

  it("falls back to mp4Url, zero values and a default topic", () => {
    const meta = mediaMeta({ mp4Url: "https://cdn/y.mp4" });
    expect(meta.viewUrl).toBe("https://cdn/y.mp4");
    expect(meta.playId).toBe("");
    expect(meta.duration).toBe(0);
    expect(meta.sizeMB).toBe(0);
    expect(meta.topic).toBe("zoom-recording");
    expect(mediaMeta({}).viewUrl).toBe("");
  });
});

describe("slug", () => {
  it("turns a topic into a filename", () => {
    expect(slug("CURSO XTRAIL ROGUE CLASE 2")).toBe("CURSO-XTRAIL-ROGUE-CLASE-2");
    expect(slug("Clase/Virtualización?")).toBe("Clase-Virtualización");
  });
  it("never returns empty", () => {
    expect(slug("??? / \\")).toBe("----");
    expect(slug("")).toBe("zoom-recording");
  });
});

describe("previewBytes", () => {
  it("covers the moov plus twice the average byte rate", () => {
    const bytes = previewBytes(184, 5242, 5);
    expect(bytes).toBeGreaterThan(3 * 1024 * 1024);
    expect(bytes).toBeLessThan(4 * 1024 * 1024);
  });
  it("survives a zero duration", () => {
    expect(previewBytes(10, 0, 5)).toBeGreaterThan(3 * 1024 * 1024);
  });
});
