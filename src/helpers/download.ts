// transfer math — pure

/** bytes to fetch for an N-second preview: moov headroom + 2x the average byte rate */
export function previewBytes(sizeMB: number, duration: number, seconds: number): number {
  return 3 * 1024 * 1024 + Math.trunc(((sizeMB * 1024 * 1024 * seconds) / Math.max(duration, 1)) * 2);
}

/** append only when the server confirmed our resume offset (206); anything else starts over */
export function writeMode(partialBytes: number, status: number): "a" | "w" {
  return partialBytes > 0 && status === 206 ? "a" : "w";
}
