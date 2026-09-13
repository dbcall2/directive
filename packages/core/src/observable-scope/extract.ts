/**
 * Committed-markup oracle (#4495).
 *
 * Parses HTML/JSX/template source for tabs, headings, controls, table columns,
 * landmarks, and major containers. No browser, jsdom, playwright, or axe.
 */

import {
  OBSERVABLE_UI_ARTIFACT_SCHEMA,
  OBSERVABLE_UI_PROVIDER,
  OBSERVABLE_UI_PROVIDER_VERSION,
  type ObservableArtifact,
  type StructureFact,
  type StructureKind,
  type SurfaceSnapshot,
} from "./types.js";

const MARKUP_EXT = /\.(html?|jsx|tsx|vue|svelte|njk|hbs|handlebars|ejs|astro)$/i;

export function isMarkupPath(path: string): boolean {
  return MARKUP_EXT.test(path.replace(/\\/g, "/"));
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attr(open: string, name: string): string | undefined {
  const dq = open.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  if (dq?.[1] !== undefined) return dq[1];
  const sq = open.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"));
  if (sq?.[1] !== undefined) return sq[1];
  const jsx = open.match(new RegExp(`${name}\\s*=\\s*\\{["']([^"']+)["']\\}`, "i"));
  return jsx?.[1];
}

function hasFlag(open: string, name: string): boolean {
  const re = new RegExp(`(?:^|\\s)${name}(?:\\s|=|>|$)`, "i");
  return re.test(open) || attr(open, name)?.toLowerCase() === "true";
}

function isSelected(open: string): boolean {
  if (hasFlag(open, "selected")) return true;
  const aria = attr(open, "aria-selected");
  return aria !== undefined && aria.toLowerCase() === "true";
}

function fact(kind: StructureKind, id: string): StructureFact {
  return { kind, id };
}

function controlName(open: string, inner: string): string {
  return (
    attr(open, "name") ??
    attr(open, "aria-label") ??
    attr(open, "id") ??
    attr(open, "placeholder") ??
    stripTags(inner)
  );
}

function pushUnique(out: StructureFact[], next: StructureFact): void {
  if (out.some((f) => f.id === next.id && f.kind === next.kind)) return;
  out.push(next);
}

/** Extract a versioned committed-markup snapshot from one source file. */
export function extractMarkupFacts(source: string): StructureFact[] {
  const facts: StructureFact[] = [];

  const headingRe = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  for (const m of source.matchAll(headingRe)) {
    const level = m[1] ?? "1";
    const text = stripTags(m[3] ?? "");
    if (text.length === 0) continue;
    pushUnique(facts, fact("heading", `heading:${level}:${text}`));
  }

  const headingCompRe = /<Heading\b([^>]*)>([\s\S]*?)<\/Heading>/gi;
  for (const m of source.matchAll(headingCompRe)) {
    const open = m[1] ?? "";
    const text = stripTags(m[2] ?? "");
    if (text.length === 0) continue;
    const level = attr(open, "level") ?? attr(open, "as") ?? "1";
    pushUnique(facts, fact("heading", `heading:${level}:${text}`));
  }

  const tabRoleRe = /<([A-Za-z][\w.]*)\b([^>]*\brole\s*=\s*["']tab["'][^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const m of source.matchAll(tabRoleRe)) {
    const open = m[2] ?? "";
    const text = stripTags(m[3] ?? "") || attr(open, "aria-label") || attr(open, "data-tab") || "";
    if (text.length === 0) continue;
    pushUnique(facts, fact("tab", `tab:${text}`));
    if (isSelected(open)) pushUnique(facts, fact("tab", `tab-selected:${text}`));
  }

  const tabCompRe = /<(Tabs\.Tab|Tab)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const m of source.matchAll(tabCompRe)) {
    const open = m[2] ?? "";
    const text =
      stripTags(m[3] ?? "") ||
      attr(open, "label") ||
      attr(open, "title") ||
      attr(open, "name") ||
      "";
    if (text.length === 0) continue;
    pushUnique(facts, fact("tab", `tab:${text}`));
    if (isSelected(open)) pushUnique(facts, fact("tab", `tab-selected:${text}`));
  }

  const buttonRe = /<(button|Button)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const m of source.matchAll(buttonRe)) {
    const open = m[2] ?? "";
    const name = controlName(open, m[3] ?? "");
    if (name.length === 0) continue;
    pushUnique(facts, fact("control", `control:button:${name}`));
  }

  const inputRe = /<(input|Input|select|Select|textarea|Textarea)\b([^>]*?)(?:\/>|>)/gi;
  for (const m of source.matchAll(inputRe)) {
    const tag = (m[1] ?? "input").toLowerCase();
    const open = m[2] ?? "";
    const kind = tag === "select" ? "select" : tag === "textarea" ? "textarea" : "input";
    const name = controlName(open, "");
    if (name.length === 0) continue;
    pushUnique(facts, fact("control", `control:${kind}:${name}`));
  }

  const thRe = /<(th|Th|TableHead|TableHeaderCell)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const m of source.matchAll(thRe)) {
    const text = stripTags(m[3] ?? "") || attr(m[2] ?? "", "aria-label") || "";
    if (text.length === 0) continue;
    pushUnique(facts, fact("table-column", `table-column:${text}`));
  }

  const landmarkRe = /<(header|nav|main|footer|aside)\b([^>]*)>/gi;
  for (const m of source.matchAll(landmarkRe)) {
    const tag = (m[1] ?? "").toLowerCase();
    const open = m[2] ?? "";
    const name = attr(open, "aria-label") ?? attr(open, "id") ?? tag;
    pushUnique(facts, fact("landmark", `landmark:${tag}:${name}`));
  }

  const roleLandmarkRe =
    /<([A-Za-z][\w.]*)\b([^>]*\brole\s*=\s*["'](banner|navigation|main|contentinfo|complementary|tablist)["'][^>]*)>/gi;
  for (const m of source.matchAll(roleLandmarkRe)) {
    const open = m[2] ?? "";
    const role = (m[3] ?? "").toLowerCase();
    const name = attr(open, "aria-label") ?? attr(open, "id") ?? role;
    pushUnique(facts, fact("landmark", `landmark:${role}:${name}`));
  }

  const containerRe = /<(section|article)\b([^>]*)>/gi;
  for (const m of source.matchAll(containerRe)) {
    const tag = (m[1] ?? "").toLowerCase();
    const open = m[2] ?? "";
    const name =
      attr(open, "aria-label") ??
      attr(open, "id") ??
      attr(open, "className") ??
      attr(open, "class") ??
      tag;
    pushUnique(facts, fact("container", `container:${tag}:${name}`));
  }

  return facts;
}

export function extractSurface(path: string, source: string): SurfaceSnapshot {
  return { path: path.replace(/\\/g, "/"), facts: extractMarkupFacts(source) };
}

export function buildArtifact(surfaces: readonly SurfaceSnapshot[]): ObservableArtifact {
  return {
    schema: OBSERVABLE_UI_ARTIFACT_SCHEMA,
    provider: OBSERVABLE_UI_PROVIDER,
    version: OBSERVABLE_UI_PROVIDER_VERSION,
    surfaces: [...surfaces].sort((a, b) => a.path.localeCompare(b.path)),
  };
}
