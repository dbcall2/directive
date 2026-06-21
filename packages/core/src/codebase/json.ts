/** Deep-sort object keys (mirrors Python json.dumps sort_keys=True). */
export function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rec).sort()) {
    out[key] = sortKeysDeep(rec[key]);
  }
  return out;
}

/**
 * Escape every non-ASCII code unit to a `\uXXXX` sequence, mirroring Python's
 * `json.dumps(..., ensure_ascii=True)` (the default). Iterating by UTF-16 code
 * unit reproduces Python's surrogate-pair escaping for astral characters, so a
 * digest taken over this output matches the Python oracle byte-for-byte.
 */
export function ensureAscii(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += text[i];
    }
  }
  return out;
}

/** JSON.stringify with sorted keys and 2-space indent (mirrors Python sort_keys + indent=2). */
export function sortedStringifyPretty(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

/** Compact JSON with sorted keys (mirrors Python json.dumps sort_keys=True). */
export function sortedStringifyCompact(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
    .replace(/,/g, ", ")
    .replace(/:(?=["[\-{0-9ntf])/g, ": ");
}
