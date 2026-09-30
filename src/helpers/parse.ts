// url / page / arg parsing — pure

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

/** 0 = full download, null = invalid */
export function parseSeconds(raw: string | undefined): number | null {
  if (raw == null || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}
