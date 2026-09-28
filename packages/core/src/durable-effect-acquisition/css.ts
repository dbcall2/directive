/** Bounded CSS acquisition occurrences, not a general CSS equivalence checker. */
import { type AcquisitionFact, CSS_FETCH_FUNCTIONS } from "./types.js";

type Token = { kind: "word" | "string" | "symbol" | "url"; value: string };
const FUNCTIONS = new Set(
  CSS_FETCH_FUNCTIONS.filter((v) => v.endsWith("(")).map((v) => v.slice(0, -1)),
);
const canonical = (tokens: readonly Token[]): string =>
  JSON.stringify(tokens.map((t) => [t.kind, t.value]));

/** Strings and unquoted URL payloads retain their bytes; only outside trivia disappears. */
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let at = 0;
  const trivia = (): boolean => {
    while (at < text.length) {
      if (/\s/.test(text[at] ?? "")) at += 1;
      else if (text.startsWith("/*", at)) {
        const end = text.indexOf("*/", at + 2);
        if (end === -1) return false;
        at = end + 2;
      } else break;
    }
    return true;
  };
  const quoted = (): string | null => {
    const quote = text[at];
    const start = ++at;
    while (at < text.length && text[at] !== quote) at += 1;
    if (at === text.length) return null;
    const value = text.slice(start, at);
    at += 1;
    return value;
  };
  while (at < text.length) {
    if (!trivia()) return null;
    if (at === text.length) break;
    const char = text[at] ?? "";
    if (char === '"' || char === "'") {
      const value = quoted();
      if (value === null) return null;
      tokens.push({ kind: "string", value });
    } else if (/[\w-]/.test(char)) {
      const start = at++;
      while (at < text.length && /[\w-]/.test(text[at] ?? "")) at += 1;
      const value = text.slice(start, at);
      if (value.toLowerCase() !== "url" || text[at] !== "(") {
        tokens.push({ kind: "word", value });
        continue;
      }
      at += 1;
      while (at < text.length && /\s/.test(text[at] ?? "")) at += 1;
      let target: string;
      if (text[at] === '"' || text[at] === "'") {
        const value = quoted();
        if (value === null || !trivia() || text[at] !== ")") return null;
        target = value;
      } else {
        const end = text.indexOf(")", at);
        if (end === -1) return null;
        target = text.slice(at, end).trim();
        // Unquoted parentheses/quotes require CSS escapes, which this language refuses.
        if (/[('"\n\r]/.test(target)) return null;
        at = end;
      }
      at += 1;
      tokens.push({ kind: "url", value: target });
    } else {
      tokens.push({ kind: "symbol", value: char });
      at += 1;
    }
  }
  return tokens;
}

export function classifyCssEffects(text: string, channel: string): readonly AcquisitionFact[] {
  const refusal = (id: string, detail: string): readonly AcquisitionFact[] => [
    { id: `css:${channel}:${id}:${text}`, rule: "item-4", detail },
  ];
  if (text.includes("\\")) return refusal("escape", "CSS escape sequence");
  const tokens = tokenize(text);
  if (tokens === null) return refusal("unresolved", "unresolved CSS token or URL");
  const facts: AcquisitionFact[] = [];
  const blocks: string[] = [];
  let statement = 0;
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (!token) continue;
    if (token.kind === "symbol") {
      if (token.value === "{") {
        blocks.push(canonical(tokens.slice(statement, at)));
        statement = at + 1;
      } else if (token.value === "}") {
        blocks.pop();
        statement = at + 1;
      } else if (token.value === ";") statement = at + 1;
    }
    const imported =
      token.kind === "symbol" &&
      token.value === "@" &&
      tokens[at + 1]?.value.toLowerCase() === "import";
    const fn = token.kind === "word" ? token.value.toLowerCase() : "";
    if (!imported && token.kind !== "url" && !(FUNCTIONS.has(fn) && tokens[at + 1]?.value === "("))
      continue;
    let end = at;
    if (imported) {
      let depth = 0;
      end = at + 2;
      while (end < tokens.length) {
        const next = tokens[end];
        if (next?.kind === "symbol") {
          if (depth === 0 && [";", "{", "}"].includes(next.value)) break;
          if (next.value === "(") depth += 1;
          if (next.value === ")") depth -= 1;
        }
        end += 1;
      }
      if (depth !== 0) return refusal("unresolved", "unresolved CSS import");
      end -= 1;
    } else if (token.kind !== "url") {
      let depth = 1;
      end = at + 2;
      for (; end < tokens.length; end += 1) {
        const next = tokens[end];
        if (next?.kind === "symbol" && next.value === "(") depth += 1;
        if (next?.kind === "symbol" && next.value === ")") depth -= 1;
        if (depth === 0) break;
      }
      if (depth !== 0) return refusal("unresolved", "unresolved CSS fetch function");
    }
    const prefix = tokens.slice(statement, at);
    const colon = prefix.findIndex((t) => t.kind === "symbol" && t.value === ":");
    const property = colon === -1 ? "" : canonical(prefix.slice(0, colon));
    const kind = imported ? "@import" : token.kind === "url" ? "url" : fn;
    const args =
      token.kind === "url"
        ? token.value
        : canonical(tokens.slice(at + 2, imported ? end + 1 : end));
    facts.push({
      id: `css:${JSON.stringify([channel, blocks, property, kind, args])}`,
      rule: "item-4",
      detail: `CSS fetch construct ${kind}`,
    });
    at = end;
  }
  return facts;
}
