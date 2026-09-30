// http plumbing: fetch pages/json, stream transfers

import type { Got, OptionsInit, Response } from "got";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import type { ZoomResponse } from "../types.ts";
import { rangeTotal, writeMode } from "./download.ts";
import { die, errMsg } from "./errors.ts";

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

/** stream a URL to a file; partialBytes > 0 resumes with a Range request */
export async function transfer(
  client: Got,
  url: string,
  out: string,
  headers: Record<string, string>,
  partialBytes: number,
): Promise<void> {
  const reqHeaders = partialBytes > 0 ? { ...headers, range: `bytes=${partialBytes}-` } : headers;
  await new Promise<void>((resolve, reject) => {
    const req = client.stream.get(url, { headers: reqHeaders, retry: { limit: 3 }, throwHttpErrors: false });
    req.on("response", (resp: Response) => {
      const status = resp.statusCode;
      if (status === 416 && partialBytes > 0) {
        // range not satisfiable: provably complete only when the server's total matches our bytes
        const total = rangeTotal(resp.headers["content-range"]);
        if (total === partialBytes) resolve();
        else reject(new Error(`resume mismatch: local ${partialBytes}B vs server total ${total}B`));
        req.resume();
        return;
      }
      if (status >= 200 && status < 300) {
        pipeline(req, createWriteStream(out, { flags: writeMode(partialBytes, status) })).then(resolve, reject);
        return;
      }
      req.resume();
      reject(new Error(`http ${status}`)); // error pages never become .mp4
    });
    req.on("error", reject);
  }).catch((e) => {
    die(`download failed: ${errMsg(e)}`);
  });
}
