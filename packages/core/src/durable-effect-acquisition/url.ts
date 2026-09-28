/**
 * WHATWG URL preprocessing + request-capable origin check (#5080 item 3).
 */
import {
  type AcquisitionFact,
  REQUEST_CAPABLE_SCHEMES,
  SENTINEL_BASE,
  SENTINEL_ORIGIN,
} from "./types.js";

const REQUEST_SET = new Set<string>(REQUEST_CAPABLE_SCHEMES);

/** Trim C0-or-space, then remove ASCII tab/LF/CR (WHATWG URL parser order). */
export function preprocessUrlInput(input: string): string {
  let start = 0;
  let end = input.length;
  while (start < end && (input.charCodeAt(start) ?? 0) <= 0x20) start += 1;
  while (end > start && (input.charCodeAt(end - 1) ?? 0) <= 0x20) end -= 1;
  let out = "";
  for (let i = start; i < end; i += 1) {
    const c = input.charCodeAt(i) ?? 0;
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
    out += input[i];
  }
  return out;
}

export function listBoundaryInText(text: string): boolean {
  return /[\s,]/.test(preprocessUrlInput(text));
}

export function splitUrlCandidates(preprocessed: string): string[] {
  const tokens = preprocessed.split(/[\s,]+/).filter((t) => t.length > 0);
  const out = [preprocessed, ...tokens];
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const c of out) {
    if (seen.has(c)) continue;
    seen.add(c);
    uniq.push(c);
  }
  return uniq;
}

export type ResolveOk = {
  readonly ok: true;
  readonly href: string;
  readonly origin: string;
  readonly scheme: string;
};

export type ResolveErr = { readonly ok: false; readonly detail: string };

export function resolveAgainstSentinel(candidate: string): ResolveOk | ResolveErr {
  try {
    const u = new URL(candidate, SENTINEL_BASE);
    return {
      ok: true,
      href: u.href,
      origin: u.origin,
      scheme: u.protocol.replace(/:$/, "").toLowerCase(),
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function requestCapableNonSentinel(
  resolved: ResolveOk,
  admittedOrigins: readonly string[],
): boolean {
  if (!REQUEST_SET.has(resolved.scheme)) return false;
  if (resolved.origin === SENTINEL_ORIGIN) return false;
  if (admittedOrigins.includes(resolved.origin)) return false;
  return true;
}

export function classifyLiteralUrlValue(
  raw: string,
  rule: string,
  admittedOrigins: readonly string[],
  grammar: "single" | "list" = "list",
): AcquisitionFact | null {
  const pre = preprocessUrlInput(raw);
  for (const candidate of grammar === "single" ? [pre] : splitUrlCandidates(pre)) {
    const resolved = resolveAgainstSentinel(candidate);
    if (!resolved.ok) {
      return {
        id: `url-resolve:${candidate}`,
        rule,
        detail: `URL resolve failed: ${resolved.detail}`,
      };
    }
    if (requestCapableNonSentinel(resolved, admittedOrigins)) {
      return {
        id: `url-origin:${resolved.origin}:${candidate}`,
        rule,
        detail: `request-capable non-sentinel origin ${resolved.origin} (${candidate})`,
      };
    }
  }
  return null;
}

export function templateHeadPinsOrigin(head: string): boolean {
  const pre = preprocessUrlInput(head);
  if (!pre.includes("/")) return false;
  if (pre.includes("\\")) return false;
  const slash = pre.indexOf("/");
  const colon = pre.indexOf(":");
  if (colon !== -1 && colon < slash) return false;
  if (pre.startsWith("/")) {
    if (pre.length < 2) return false;
    const second = pre[1];
    if (second === "/" || second === "\\") return false;
  }
  const resolved = resolveAgainstSentinel(pre);
  if (!resolved.ok) return false;
  return resolved.origin === SENTINEL_ORIGIN;
}
