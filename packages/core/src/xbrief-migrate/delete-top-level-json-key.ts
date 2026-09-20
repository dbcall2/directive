/**
 * Surgical top-level JSON key deletion (#4163).
 *
 * Removes one object property from the original file bytes so remaining
 * keys keep their original spelling, indent, and separators. Used by the
 * leftover-`vBRIEFInfo` strip so canonical `xBRIEFInfo` / `plan` stay
 * byte-for-byte intact aside from deleting that leftover key.
 */

function isJsonWs(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function isOneToNine(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "1" && ch <= "9";
}

function readJsonString(
  source: string,
  start: number,
): { ok: true; value: string; end: number } | { ok: false; error: string } {
  if (source[start] !== '"') {
    return { ok: false, error: "expected JSON string" };
  }
  let i = start + 1;
  let value = "";
  while (i < source.length) {
    const ch = source[i];
    if (ch === undefined) {
      break;
    }
    if (ch === '"') {
      return { ok: true, value, end: i + 1 };
    }
    if (ch === "\\") {
      const esc = source[i + 1];
      if (esc === undefined) {
        return { ok: false, error: "unterminated string escape" };
      }
      const simple: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      if (Object.hasOwn(simple, esc)) {
        value += simple[esc];
        i += 2;
        continue;
      }
      if (esc === "u") {
        const hex = source.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          return { ok: false, error: "invalid unicode escape" };
        }
        value += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      return { ok: false, error: "invalid string escape" };
    }
    if (ch < " ") {
      return { ok: false, error: "unescaped control in string" };
    }
    value += ch;
    i += 1;
  }
  return { ok: false, error: "unterminated string" };
}

function skipJsonNumber(source: string, start: number): number {
  let i = start;
  if (source[i] === "-") i += 1;
  if (source[i] === "0") {
    i += 1;
  } else if (isOneToNine(source[i])) {
    i += 1;
    while (isDigit(source[i])) i += 1;
  } else {
    return -1;
  }
  if (source[i] === ".") {
    i += 1;
    if (!isDigit(source[i])) return -1;
    while (isDigit(source[i])) i += 1;
  }
  if (source[i] === "e" || source[i] === "E") {
    i += 1;
    if (source[i] === "+" || source[i] === "-") i += 1;
    if (!isDigit(source[i])) return -1;
    while (isDigit(source[i])) i += 1;
  }
  return i;
}

function skipJsonValue(source: string, start: number): number {
  const ch = source[start];
  if (ch === undefined) return -1;
  if (ch === '"') {
    const parsed = readJsonString(source, start);
    return parsed.ok ? parsed.end : -1;
  }
  if (ch === "{" || ch === "[") return skipJsonContainer(source, start);
  if (ch === "t" && source.startsWith("true", start)) return start + 4;
  if (ch === "f" && source.startsWith("false", start)) return start + 5;
  if (ch === "n" && source.startsWith("null", start)) return start + 4;
  if (ch === "-" || (ch >= "0" && ch <= "9")) return skipJsonNumber(source, start);
  return -1;
}

function skipJsonContainer(source: string, start: number): number {
  let i = start + 1;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === undefined) {
      break;
    }
    if (ch === '"') {
      const parsed = readJsonString(source, i);
      if (!parsed.ok) return -1;
      i = parsed.end;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return depth === 0 ? i : -1;
}

/**
 * Delete one top-level object key from `source`, preserving every other byte.
 * Fails closed on duplicate keys, missing keys, or non-object JSON.
 */
export function deleteTopLevelJsonKey(
  source: string,
  key: string,
): { ok: true; body: string } | { ok: false; error: string } {
  let i = 0;
  const n = source.length;
  const skipWs = (): void => {
    while (i < n && isJsonWs(source[i])) i += 1;
  };

  skipWs();
  if (source[i] === "\uFEFF") {
    i += 1;
    skipWs();
  }
  if (source[i] !== "{") {
    return { ok: false, error: "expected a top-level JSON object" };
  }
  i += 1;

  let foundStart = -1;
  let foundEnd = -1;
  let commaBeforeKey = -1;
  let lastComma = -1;
  let sawProperty = false;

  while (i < n) {
    skipWs();
    if (source[i] === "}") {
      break;
    }
    if (sawProperty) {
      if (source[i] !== ",") {
        return { ok: false, error: "expected comma between object properties" };
      }
      lastComma = i;
      i += 1;
      skipWs();
      if (source[i] === "}") {
        return { ok: false, error: "trailing comma in JSON object" };
      }
    }
    if (source[i] !== '"') {
      return { ok: false, error: "expected object key string" };
    }
    const keyStart = i;
    const parsedKey = readJsonString(source, i);
    if (!parsedKey.ok) return parsedKey;
    i = parsedKey.end;
    skipWs();
    if (source[i] !== ":") {
      return { ok: false, error: "expected colon after object key" };
    }
    i += 1;
    skipWs();
    const valueEnd = skipJsonValue(source, i);
    if (valueEnd < 0) {
      return { ok: false, error: `invalid JSON value while locating ${key}` };
    }
    i = valueEnd;
    if (parsedKey.value === key) {
      if (foundStart !== -1) {
        return { ok: false, error: `duplicate top-level key ${key}` };
      }
      foundStart = keyStart;
      foundEnd = valueEnd;
      commaBeforeKey = lastComma;
    }
    sawProperty = true;
  }

  if (foundStart < 0) {
    return { ok: false, error: `top-level key ${key} not found` };
  }

  let spliceStart = foundStart;
  let spliceEnd = foundEnd;
  let j = foundEnd;
  while (j < n && isJsonWs(source[j])) j += 1;
  if (source[j] === ",") {
    j += 1;
    while (j < n && isJsonWs(source[j])) j += 1;
    spliceEnd = j;
  } else if (commaBeforeKey >= 0) {
    spliceStart = commaBeforeKey;
  }

  return { ok: true, body: source.slice(0, spliceStart) + source.slice(spliceEnd) };
}
