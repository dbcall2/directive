/**
 * HTML acquisition walk: parse5 both scripting modes, every namespace (#5080).
 */
import { type DefaultTreeAdapterMap, type ParserError, parse } from "parse5";
import {
  type AcquisitionFact,
  type ClassifyResult,
  CSS_FETCH_FUNCTIONS,
  META_HTTP_EQUIV_ALLOW,
} from "./types.js";
import { classifyLiteralUrlValue } from "./url.js";

type P5Node = DefaultTreeAdapterMap["node"];
type P5Element = DefaultTreeAdapterMap["element"];
type P5Parent = DefaultTreeAdapterMap["parentNode"];
type P5Template = DefaultTreeAdapterMap["template"];
type P5Text = DefaultTreeAdapterMap["textNode"];

const INCOMPLETE_PARSE_CODES: ReadonlySet<string> = new Set([
  "eof-in-tag",
  "eof-before-tag-name",
  "eof-in-doctype",
  "eof-in-comment",
  "eof-in-cdata",
  "eof-in-script-html-comment-like-text",
  "eof-in-element-that-can-contain-only-text",
]);

function isElement(node: P5Node): node is P5Element {
  return "tagName" in node && typeof (node as P5Element).tagName === "string";
}

function isTemplate(node: P5Element): node is P5Template {
  return node.tagName === "template" && "content" in node;
}

function isText(node: P5Node): node is P5Text {
  return node.nodeName === "#text";
}

function localName(el: P5Element): string {
  const raw = el.tagName;
  const colon = raw.indexOf(":");
  return (colon === -1 ? raw : raw.slice(colon + 1)).toLowerCase();
}

function attrLocal(name: string): string {
  const colon = name.indexOf(":");
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

function collectText(parent: P5Parent): string {
  let out = "";
  for (const child of parent.childNodes) {
    if (isText(child)) out += child.value;
    else if (isElement(child) && !isTemplate(child)) out += collectText(child);
  }
  return out;
}

function classifyCssText(text: string): AcquisitionFact | null {
  if (text.includes("\\")) {
    return { id: "css-escape", rule: "item-4", detail: "CSS escape sequence" };
  }
  const lower = text.toLowerCase();
  for (const fn of CSS_FETCH_FUNCTIONS) {
    if (lower.includes(fn)) {
      return { id: `css-fetch:${fn}`, rule: "item-4", detail: `CSS fetch function ${fn}` };
    }
  }
  return null;
}

function isOnHandler(attrName: string): boolean {
  const local = attrLocal(attrName);
  return local.startsWith("on") && local.length > 2;
}

export type HtmlWalkContext = {
  readonly admittedOrigins: readonly string[];
  readonly jsFacts: (source: string, via: string) => readonly AcquisitionFact[];
};

function walkElement(el: P5Element, ctx: HtmlWalkContext, facts: AcquisitionFact[]): void {
  const tag = localName(el);
  if (tag === "noscript") {
    facts.push({ id: "elem:noscript", rule: "item-4", detail: "noscript is parse-mode ambiguous" });
  }
  if (tag === "iframe" || tag === "embed" || tag === "object") {
    facts.push({ id: `elem:${tag}`, rule: "item-4", detail: `<${tag}> refuses` });
  }
  if (tag === "style") {
    const css = classifyCssText(collectText(el));
    if (css !== null) facts.push(css);
  }
  if (tag === "script") {
    const src = el.attrs.find((a) => attrLocal(a.name) === "src");
    if (src !== undefined) {
      facts.push({ id: "elem:script[src]", rule: "item-4", detail: "script[src] refuses" });
    } else {
      const body = collectText(el);
      if (body.trim().length > 0) facts.push(...ctx.jsFacts(body, "script"));
    }
  }
  if (tag === "form") {
    const methodAttr = el.attrs.find((a) => attrLocal(a.name) === "method");
    if (methodAttr !== undefined && methodAttr.value.trim().toLowerCase() !== "get") {
      facts.push({
        id: `form-method:${methodAttr.value}`,
        rule: "item-4",
        detail: `form method ${methodAttr.value} is not GET`,
      });
    }
  }
  if (tag === "meta") {
    const http = el.attrs.find((a) => {
      const n = attrLocal(a.name);
      return n === "http-equiv" || n === "httpequiv";
    });
    if (http !== undefined) {
      const v = http.value.trim().toLowerCase();
      if (!(META_HTTP_EQUIV_ALLOW as readonly string[]).includes(v)) {
        facts.push({
          id: `meta-http-equiv:${v}`,
          rule: "item-4",
          detail: `meta http-equiv ${http.value} is not on the benign allowlist`,
        });
      }
    }
  }
  if (tag === "base") {
    const href = el.attrs.find((a) => attrLocal(a.name) === "href");
    const value = href?.value ?? "";
    const hit = classifyLiteralUrlValue(value, "item-6", ctx.admittedOrigins);
    if (hit !== null) {
      facts.push({
        id: `base:${hit.id}`,
        rule: "item-6",
        detail: `non-sentinel document base: ${hit.detail}`,
      });
    }
  }

  for (const attr of el.attrs) {
    const local = attrLocal(attr.name);
    if (
      local === "formaction" ||
      local === "formmethod" ||
      local === "ping" ||
      local === "srcdoc" ||
      local === "dangerouslysetinnerhtml"
    ) {
      facts.push({
        id: `attr:${tag}:${local}`,
        rule: "item-4",
        detail: `${attr.name} refuses regardless of value`,
      });
      continue;
    }
    if (local === "style") {
      const css = classifyCssText(attr.value);
      if (css !== null) facts.push(css);
      continue;
    }
    if (isOnHandler(attr.name)) {
      facts.push(...ctx.jsFacts(attr.value, `handler:${attr.name}`));
      continue;
    }
    const urlHit = classifyLiteralUrlValue(attr.value, "item-3", ctx.admittedOrigins);
    if (urlHit !== null) facts.push({ ...urlHit, id: `attr:${tag}:${local}:${urlHit.id}` });
  }

  if (isTemplate(el)) walkTree(el.content, ctx, facts);
  for (const child of el.childNodes) {
    if (isElement(child)) walkElement(child, ctx, facts);
  }
}

function walkTree(parent: P5Parent, ctx: HtmlWalkContext, facts: AcquisitionFact[]): void {
  for (const child of parent.childNodes) {
    if (isElement(child)) walkElement(child, ctx, facts);
  }
}

export function classifyHtmlDocument(source: string, ctx: HtmlWalkContext): ClassifyResult {
  const facts: AcquisitionFact[] = [];
  for (const scriptingEnabled of [false, true]) {
    const anomalies: string[] = [];
    const doc = parse(source, {
      scriptingEnabled,
      onParseError: (err: ParserError) => {
        if (INCOMPLETE_PARSE_CODES.has(err.code)) anomalies.push(err.code);
      },
    });
    if (anomalies.length > 0) {
      return {
        ok: false,
        rule: "item-9",
        detail: `HTML parse error scriptingEnabled=${String(scriptingEnabled)} (${anomalies.join(",")})`,
      };
    }
    walkTree(doc, ctx, facts);
  }
  return { ok: true, facts: dedupeFacts(facts) };
}

export function dedupeFacts(facts: readonly AcquisitionFact[]): AcquisitionFact[] {
  const seen = new Set<string>();
  const out: AcquisitionFact[] = [];
  for (const f of facts) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

/** Used by tests that only need parse-mode union of markup URLs. */
export function classifyHtmlUrlsForTest(
  source: string,
  admittedOrigins: readonly string[] = [],
): ClassifyResult {
  return classifyHtmlDocument(source, { admittedOrigins, jsFacts: () => [] });
}
