// transfer math — pure

/** bytes to fetch for an N-second preview: moov headroom + 2x the average byte rate */
export function previewBytes(sizeMB: number, duration: number, seconds: number): number {
  return 3 * 1024 * 1024 + Math.trunc(((sizeMB * 1024 * 1024 * seconds) / Math.max(duration, 1)) * 2);
}

/** append only when the server confirmed our resume offset (206); anything else starts over */
export function writeMode(partialBytes: number, status: number): "a" | "w" {
  return partialBytes > 0 && status === 206 ? "a" : "w";
}

/** total size N from a 416 Content-Range reply (bytes-star-slash-N), NaN when absent */
export function rangeTotal(contentRange: string | string[] | undefined): number {
  return Number((Array.isArray(contentRange) ? contentRange[0] : contentRange)?.split("/")[1]);
}
