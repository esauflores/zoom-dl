// error plumbing

export function die(msg: string): never {
  console.error(`zoom-dl: ${msg}`);
  process.exit(1);
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
