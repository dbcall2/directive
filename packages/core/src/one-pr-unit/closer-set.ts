/**
 * Explicit closer grammar for one-PR-unit census (#4494).
 * Not `CLOSING_KEYWORD_RE` — that first-#N detector is not the closer-set.
 */

import { normalizeOrigin, uniqueOrigins } from "./origin-set.js";
import type { OriginRef } from "./types.js";

const KEYWORD_RE = /\b(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\b/gi;
const HASH_ISSUE_RE = /^#(\d+)\b/;
const SLUG_ISSUE_RE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/;
const COMMA_HASH_RE = /^,\s*#(\d+)\b/;
const COMMA_SLUG_RE = /^,\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/;

function skipWs(text: string, index: number): number {
  let i = index;
  while (
    i < text.length &&
    (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")
  ) {
    i += 1;
  }
  return i;
}

/**
 * Intent closer-set from body/commit text, including one-keyword comma lists
 * (`Closes #4204, #4218, …`) and `owner/repo#N`.
 */
export function extractIntentCloserSet(texts: readonly string[], repo: string): OriginRef[] {
  const origins: OriginRef[] = [];
  for (const text of texts) {
    KEYWORD_RE.lastIndex = 0;
    let match = KEYWORD_RE.exec(text);
    while (match !== null) {
      let i = skipWs(text, (match.index ?? 0) + match[0].length);
      const slug = SLUG_ISSUE_RE.exec(text.slice(i));
      const hash = HASH_ISSUE_RE.exec(text.slice(i));
      if (slug !== null && slug[1] !== undefined && slug[2] !== undefined) {
        origins.push(normalizeOrigin(slug[1], Number(slug[2])));
        i += slug[0].length;
      } else if (hash !== null && hash[1] !== undefined) {
        origins.push(normalizeOrigin(repo, Number(hash[1])));
        i += hash[0].length;
      } else {
        match = KEYWORD_RE.exec(text);
        continue;
      }
      while (true) {
        const rest = text.slice(i);
        const commaSlug = COMMA_SLUG_RE.exec(rest);
        const commaHash = COMMA_HASH_RE.exec(rest);
        if (commaSlug !== null && commaSlug[1] !== undefined && commaSlug[2] !== undefined) {
          origins.push(normalizeOrigin(commaSlug[1], Number(commaSlug[2])));
          i += commaSlug[0].length;
          continue;
        }
        if (commaHash !== null && commaHash[1] !== undefined) {
          origins.push(normalizeOrigin(repo, Number(commaHash[1])));
          i += commaHash[0].length;
          continue;
        }
        break;
      }
      match = KEYWORD_RE.exec(text);
    }
  }
  return uniqueOrigins(origins);
}

export function closerSetFromIssueIds(repo: string, issueIds: readonly number[]): OriginRef[] {
  return uniqueOrigins(issueIds.map((issueId) => normalizeOrigin(repo, issueId)));
}

export function closerSetFromReferences(
  repo: string,
  issueIds: readonly number[] | null,
  texts: readonly string[] | null,
): { readonly origins: OriginRef[]; readonly unreadable: boolean } {
  if (issueIds === null || texts === null) {
    return { origins: [], unreadable: true };
  }
  return {
    origins: uniqueOrigins([
      ...closerSetFromIssueIds(repo, issueIds),
      ...extractIntentCloserSet(texts, repo),
    ]),
    unreadable: false,
  };
}
