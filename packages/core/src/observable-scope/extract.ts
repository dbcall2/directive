/**
 * First-ship observable UI oracle (#4495 later-arc).
 *
 * Closed suffix/parser pairs: `.html` via inert jsdom, `.jsx`/`.tsx` via
 * TypeScript parse-only. HTML `template` elements inside `.html` are in
 * scope; undeclared dialects (vue/svelte/njk/hbs/ejs/astro) are not.
 * Embedded scripts and subresource loading stay off. Extractor output is data.
 */

import { JSDOM } from "jsdom";
import ts from "typescript";
import {
  OBSERVABLE_UI_ARTIFACT_SCHEMA,
  OBSERVABLE_UI_PROVIDER,
  OBSERVABLE_UI_PROVIDER_VERSION,
  type ObservableArtifact,
  type StructureFact,
  type StructureKind,
  type SurfaceSnapshot,
} from "./types.js";

const MARKUP_EXT = /\.(html|jsx|tsx)$/i;
const UNDECLARED_TEMPLATE_EXT = /\.(vue|svelte|njk|hbs|handlebars|ejs|astro)$/i;
const SCRIPT_SENTINEL = "__OBSERVABLE_SCOPE_SENTINEL";

interface MarkupEl {
  readonly tagName: string;
  readonly textContent: string | null;
  readonly content?: { querySelectorAll(sel: string): ArrayLike<MarkupEl> };
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelectorAll(selectors: string): ArrayLike<MarkupEl>;
}

export function isMarkupPath(path: string): boolean {
  return MARKUP_EXT.test(path.replace(/\\/g, "/"));
}

export function isUndeclaredTemplatePath(path: string): boolean {
  return UNDECLARED_TEMPLATE_EXT.test(path.replace(/\\/g, "/"));
}

function fact(kind: StructureKind, id: string): StructureFact {
  return { kind, id };
}

function pushUnique(out: StructureFact[], next: StructureFact): void {
  if (out.some((f) => f.id === next.id && f.kind === next.kind)) return;
  out.push(next);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function listOf(nodes: ArrayLike<MarkupEl>): MarkupEl[] {
  const out: MarkupEl[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const item = nodes[i];
    if (item !== undefined) out.push(item);
  }
  return out;
}

function controlNameFromAttrs(
  name: string | undefined,
  ariaLabel: string | undefined,
  id: string | undefined,
  placeholder: string | undefined,
  inner: string,
): string {
  return name || ariaLabel || id || placeholder || inner;
}

function htmlSelected(el: MarkupEl): boolean {
  if (el.hasAttribute("selected")) {
    const v = el.getAttribute("selected");
    if (v === null || v === "" || v.toLowerCase() === "true" || v.toLowerCase() === "selected") {
      return true;
    }
  }
  const aria = el.getAttribute("aria-selected");
  return aria !== null && aria.toLowerCase() === "true";
}

function walkHtmlRoot(root: MarkupEl, facts: StructureFact[]): void {
  for (const el of listOf(root.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    const level = el.tagName.toLowerCase().slice(1) || "1";
    const text = normalizeText(el.textContent ?? "");
    if (text.length === 0) continue;
    pushUnique(facts, fact("heading", `heading:${level}:${text}`));
  }

  for (const el of listOf(root.querySelectorAll('[role="tab"]'))) {
    const text =
      normalizeText(el.textContent ?? "") ||
      el.getAttribute("aria-label") ||
      el.getAttribute("data-tab") ||
      "";
    if (text.length === 0) continue;
    pushUnique(facts, fact("tab", `tab:${text}`));
    if (htmlSelected(el)) pushUnique(facts, fact("tab", `tab-selected:${text}`));
  }

  for (const el of listOf(root.querySelectorAll("button"))) {
    const name = controlNameFromAttrs(
      el.getAttribute("name") ?? undefined,
      el.getAttribute("aria-label") ?? undefined,
      el.getAttribute("id") ?? undefined,
      undefined,
      normalizeText(el.textContent ?? ""),
    );
    if (name.length === 0) continue;
    pushUnique(facts, fact("control", `control:button:${name}`));
  }

  for (const el of listOf(root.querySelectorAll("input,select,textarea"))) {
    const tag = el.tagName.toLowerCase();
    const kind = tag === "select" ? "select" : tag === "textarea" ? "textarea" : "input";
    const name = controlNameFromAttrs(
      el.getAttribute("name") ?? undefined,
      el.getAttribute("aria-label") ?? undefined,
      el.getAttribute("id") ?? undefined,
      el.getAttribute("placeholder") ?? undefined,
      "",
    );
    if (name.length === 0) continue;
    pushUnique(facts, fact("control", `control:${kind}:${name}`));
  }

  for (const el of listOf(root.querySelectorAll("th"))) {
    const text = normalizeText(el.textContent ?? "") || el.getAttribute("aria-label") || "";
    if (text.length === 0) continue;
    pushUnique(facts, fact("table-column", `table-column:${text}`));
  }

  for (const el of listOf(root.querySelectorAll("header,nav,main,footer,aside"))) {
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute("aria-label") ?? el.getAttribute("id") ?? tag;
    pushUnique(facts, fact("landmark", `landmark:${tag}:${name}`));
  }

  for (const el of listOf(
    root.querySelectorAll(
      '[role="banner"],[role="navigation"],[role="main"],[role="contentinfo"],[role="complementary"],[role="tablist"]',
    ),
  )) {
    const role = (el.getAttribute("role") ?? "").toLowerCase();
    if (role.length === 0) continue;
    const name = el.getAttribute("aria-label") ?? el.getAttribute("id") ?? role;
    pushUnique(facts, fact("landmark", `landmark:${role}:${name}`));
  }

  for (const el of listOf(root.querySelectorAll("section,article"))) {
    const tag = el.tagName.toLowerCase();
    const name =
      el.getAttribute("aria-label") ?? el.getAttribute("id") ?? el.getAttribute("class") ?? tag;
    pushUnique(facts, fact("container", `container:${tag}:${name}`));
  }
}

function extractHtmlFacts(source: string): StructureFact[] {
  const facts: StructureFact[] = [];
  const before = (globalThis as Record<string, unknown>)[SCRIPT_SENTINEL];
  const dom = new JSDOM(source, {
    url: "https://observable-scope.invalid/",
    contentType: "text/html",
    pretendToBeVisual: false,
  });
  if ((globalThis as Record<string, unknown>)[SCRIPT_SENTINEL] !== before) {
    throw new Error("jsdom executed embedded script during extract; scripts must stay off");
  }
  const document = dom.window.document as unknown as MarkupEl;
  walkHtmlRoot(document, facts);
  for (const tmpl of listOf(document.querySelectorAll("template"))) {
    if (tmpl.content !== undefined) walkHtmlRoot(tmpl.content as MarkupEl, facts);
  }
  return facts;
}

function jsxTagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

function jsxAttr(
  node: ts.JsxOpeningLikeElement,
  name: string,
): { kind: "flag" | "literal" | "expr"; value?: string } | undefined {
  for (const attr of node.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    if (attr.name.getText() !== name) continue;
    if (attr.initializer === undefined) return { kind: "flag" };
    if (
      ts.isStringLiteral(attr.initializer) ||
      ts.isNoSubstitutionTemplateLiteral(attr.initializer)
    ) {
      return { kind: "literal", value: attr.initializer.text };
    }
    if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression !== undefined) {
      const expr = attr.initializer.expression;
      if (expr.kind === ts.SyntaxKind.TrueKeyword) return { kind: "literal", value: "true" };
      if (expr.kind === ts.SyntaxKind.FalseKeyword) return { kind: "literal", value: "false" };
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
        return { kind: "literal", value: expr.text };
      }
      return { kind: "expr" };
    }
  }
  return undefined;
}

function jsxInnerText(node: ts.JsxElement): string {
  const parts: string[] = [];
  for (const child of node.children) {
    if (ts.isJsxText(child)) parts.push(child.text);
    else if (ts.isJsxExpression(child) && child.expression !== undefined) {
      if (
        ts.isStringLiteral(child.expression) ||
        ts.isNoSubstitutionTemplateLiteral(child.expression)
      ) {
        parts.push(child.expression.text);
      }
    }
  }
  return normalizeText(parts.join(" "));
}

function jsxSelected(open: ts.JsxOpeningLikeElement): boolean {
  const selected = jsxAttr(open, "selected");
  if (selected?.kind === "flag") return true;
  if (selected?.kind === "literal" && selected.value?.toLowerCase() === "true") return true;
  const aria = jsxAttr(open, "aria-selected");
  return aria?.kind === "literal" && aria.value?.toLowerCase() === "true";
}

function jsxControlName(open: ts.JsxOpeningLikeElement, inner: string): string {
  const literal = (name: string): string | undefined => {
    const a = jsxAttr(open, name);
    return a?.kind === "literal" ? a.value : undefined;
  };
  return controlNameFromAttrs(
    literal("name"),
    literal("aria-label"),
    literal("id"),
    literal("placeholder") ?? literal("label") ?? literal("title"),
    inner,
  );
}

function visitJsx(node: ts.Node, facts: StructureFact[]): void {
  if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
    const open = ts.isJsxSelfClosingElement(node) ? node : node;
    const parent = ts.isJsxOpeningElement(node) ? node.parent : undefined;
    const inner = parent !== undefined && ts.isJsxElement(parent) ? jsxInnerText(parent) : "";
    collectJsxFacts(open, inner, facts);
  }
  ts.forEachChild(node, (child) => visitJsx(child, facts));
}

function collectJsxFacts(
  open: ts.JsxOpeningLikeElement,
  inner: string,
  facts: StructureFact[],
): void {
  const tag = jsxTagName(open);
  const lower = tag.toLowerCase();

  if (/^h[1-6]$/.test(lower) || tag === "Heading") {
    const levelAttr = jsxAttr(open, "level") ?? jsxAttr(open, "as");
    const level =
      lower.startsWith("h") && lower.length === 2
        ? lower.slice(1)
        : levelAttr?.kind === "literal"
          ? (levelAttr.value ?? "1")
          : "1";
    const text =
      inner ||
      (jsxAttr(open, "aria-label")?.kind === "literal"
        ? (jsxAttr(open, "aria-label")?.value ?? "")
        : "");
    if (text.length > 0) pushUnique(facts, fact("heading", `heading:${level}:${text}`));
  }

  const role = jsxAttr(open, "role");
  const isTab =
    (role?.kind === "literal" && role.value === "tab") || tag === "Tab" || tag === "Tabs.Tab";
  if (isTab) {
    const text =
      inner ||
      (jsxAttr(open, "aria-label")?.kind === "literal"
        ? (jsxAttr(open, "aria-label")?.value ?? "")
        : "") ||
      (jsxAttr(open, "label")?.kind === "literal" ? (jsxAttr(open, "label")?.value ?? "") : "") ||
      (jsxAttr(open, "title")?.kind === "literal" ? (jsxAttr(open, "title")?.value ?? "") : "") ||
      (jsxAttr(open, "name")?.kind === "literal" ? (jsxAttr(open, "name")?.value ?? "") : "") ||
      (jsxAttr(open, "data-tab")?.kind === "literal"
        ? (jsxAttr(open, "data-tab")?.value ?? "")
        : "");
    if (text.length > 0) {
      pushUnique(facts, fact("tab", `tab:${text}`));
      if (jsxSelected(open)) pushUnique(facts, fact("tab", `tab-selected:${text}`));
    }
  }

  if (lower === "button" || tag === "Button") {
    const name = jsxControlName(open, inner);
    if (name.length > 0) pushUnique(facts, fact("control", `control:button:${name}`));
  }

  if (
    lower === "input" ||
    tag === "Input" ||
    lower === "select" ||
    tag === "Select" ||
    lower === "textarea" ||
    tag === "Textarea"
  ) {
    const kind =
      lower === "select" || tag === "Select"
        ? "select"
        : lower === "textarea" || tag === "Textarea"
          ? "textarea"
          : "input";
    const name = jsxControlName(open, "");
    if (name.length > 0) pushUnique(facts, fact("control", `control:${kind}:${name}`));
  }

  if (lower === "th" || tag === "Th" || tag === "TableHead" || tag === "TableHeaderCell") {
    const text =
      inner ||
      (jsxAttr(open, "aria-label")?.kind === "literal"
        ? (jsxAttr(open, "aria-label")?.value ?? "")
        : "");
    if (text.length > 0) pushUnique(facts, fact("table-column", `table-column:${text}`));
  }

  if (
    lower === "header" ||
    lower === "nav" ||
    lower === "main" ||
    lower === "footer" ||
    lower === "aside"
  ) {
    const name =
      (jsxAttr(open, "aria-label")?.kind === "literal"
        ? jsxAttr(open, "aria-label")?.value
        : undefined) ??
      (jsxAttr(open, "id")?.kind === "literal" ? jsxAttr(open, "id")?.value : undefined) ??
      lower;
    pushUnique(facts, fact("landmark", `landmark:${lower}:${name}`));
  }

  if (role?.kind === "literal") {
    const r = role.value ?? "";
    if (["banner", "navigation", "main", "contentinfo", "complementary", "tablist"].includes(r)) {
      const name =
        (jsxAttr(open, "aria-label")?.kind === "literal"
          ? jsxAttr(open, "aria-label")?.value
          : undefined) ??
        (jsxAttr(open, "id")?.kind === "literal" ? jsxAttr(open, "id")?.value : undefined) ??
        r;
      pushUnique(facts, fact("landmark", `landmark:${r}:${name}`));
    }
  }

  if (lower === "section" || lower === "article") {
    const name =
      (jsxAttr(open, "aria-label")?.kind === "literal"
        ? jsxAttr(open, "aria-label")?.value
        : undefined) ??
      (jsxAttr(open, "id")?.kind === "literal" ? jsxAttr(open, "id")?.value : undefined) ??
      (jsxAttr(open, "className")?.kind === "literal"
        ? jsxAttr(open, "className")?.value
        : undefined) ??
      lower;
    pushUnique(facts, fact("container", `container:${lower}:${name}`));
  }
}

function extractJsxFacts(source: string, path: string): StructureFact[] {
  const facts: StructureFact[] = [];
  const kind = path.replace(/\\/g, "/").toLowerCase().endsWith(".jsx")
    ? ts.ScriptKind.JSX
    : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  visitJsx(sf, facts);
  return facts;
}

/** Extract a versioned snapshot from one first-ship source file. */
export function extractMarkupFacts(source: string, path = "snippet.html"): StructureFact[] {
  const norm = path.replace(/\\/g, "/");
  if (norm.toLowerCase().endsWith(".html")) return extractHtmlFacts(source);
  if (norm.toLowerCase().endsWith(".jsx") || norm.toLowerCase().endsWith(".tsx")) {
    return extractJsxFacts(source, norm);
  }
  return [];
}

export function extractSurface(path: string, source: string): SurfaceSnapshot {
  return { path: path.replace(/\\/g, "/"), facts: extractMarkupFacts(source, path) };
}

export function buildArtifact(surfaces: readonly SurfaceSnapshot[]): ObservableArtifact {
  return {
    schema: OBSERVABLE_UI_ARTIFACT_SCHEMA,
    provider: OBSERVABLE_UI_PROVIDER,
    version: OBSERVABLE_UI_PROVIDER_VERSION,
    surfaces: [...surfaces].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export { SCRIPT_SENTINEL };
