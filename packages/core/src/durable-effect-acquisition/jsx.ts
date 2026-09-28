/**
 * JSX/TSX + in-file JS text classifier (#5080 items 2, 3, 4, 5).
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import type * as TS from "typescript";
import {
  type AcquisitionFact,
  type ClassifyResult,
  CSS_FETCH_FUNCTIONS,
  META_HTTP_EQUIV_ALLOW,
} from "./types.js";
import { classifyLiteralUrlValue, listBoundaryInText, templateHeadPinsOrigin } from "./url.js";

type TSModule = typeof TS;

const TS_CACHE = new Map<string, TSModule>();

export type TsLoad =
  | { readonly ok: true; readonly ts: TSModule }
  | { readonly ok: false; readonly detail: string };

export function loadProjectTypeScript(projectRoot: string): TsLoad {
  const cached = TS_CACHE.get(projectRoot);
  if (cached !== undefined) return { ok: true, ts: cached };
  const req = createRequire(join(projectRoot, "package.json"));
  let resolved: string;
  try {
    resolved = req.resolve("typescript");
  } catch {
    return { ok: false, detail: `no typescript resolvable from ${projectRoot}` };
  }
  const mod = req(resolved) as TSModule | { default?: TSModule };
  const ts = "createSourceFile" in mod ? mod : (mod as { default?: TSModule }).default;
  if (ts === undefined || typeof ts.createSourceFile !== "function") {
    return { ok: false, detail: `module at ${resolved} is not a TypeScript parser` };
  }
  TS_CACHE.set(projectRoot, ts);
  return { ok: true, ts };
}

const DURABLE_GLOBALS = new Set([
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "cookieStore",
  "caches",
]);
const NETWORK_CALLEES = new Set(["fetch", "XMLHttpRequest", "WebSocket"]);
const HOST_RUNTIME = new Set([
  "view",
  "target",
  "currentTarget",
  "nativeEvent",
  "ownerDocument",
  "defaultView",
  "contentWindow",
  "opener",
]);
const REFUSED_PROPS = new Set(["cookie", ...HOST_RUNTIME, ...DURABLE_GLOBALS]);
const SAFE_GLOBALS: Readonly<Record<string, ReadonlySet<string>>> = {
  console: new Set(["log", "info", "warn", "error", "debug", "dir", "table", "time", "timeEnd"]),
  Math: new Set(),
  JSON: new Set(),
  Object: new Set(),
  Array: new Set(),
  Number: new Set(),
  String: new Set(),
  Boolean: new Set(),
  Date: new Set(),
  Intl: new Set(),
  Map: new Set(),
  Set: new Set(),
  WeakMap: new Set(),
  WeakSet: new Set(),
  Promise: new Set(),
  Error: new Set(),
  URL: new Set(),
  URLSearchParams: new Set(),
  document: new Set([
    "getElementById",
    "querySelector",
    "querySelectorAll",
    "createElement",
    "createTextNode",
    "addEventListener",
    "removeEventListener",
    "body",
    "documentElement",
    "head",
    "title",
  ]),
  window: new Set([
    "addEventListener",
    "removeEventListener",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "console",
    "document",
    "Math",
    "JSON",
    "Map",
    "Set",
  ]),
  globalThis: new Set(),
};

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

export type JsxContext = {
  readonly ts: TSModule;
  readonly admittedOrigins: readonly string[];
  readonly admittedPackages: readonly string[];
  readonly admittedPaths: readonly string[];
};

function decodeJsxStringLiteral(
  ts: TSModule,
  literal: TS.StringLiteralLike,
): ClassifyResult & { value?: string } {
  const raw = literal.getText();
  const source = `export default <x a=${raw} />;`;
  const emitted = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
    },
    reportDiagnostics: true,
    fileName: "durable-effect-decode.tsx",
  });
  const diags = emitted.diagnostics ?? [];
  if (diags.length > 0) {
    return {
      ok: false,
      rule: "item-3",
      detail: "JSX emitter diagnostic while decoding a string literal",
    };
  }
  const m = /\ba\s*:\s*("(?:\\.|[^"\\])*")/.exec(emitted.outputText);
  if (m === null || m[1] === undefined) {
    return { ok: false, rule: "item-3", detail: "JSX emitter did not produce a string attribute" };
  }
  try {
    return { ok: true, facts: [], value: JSON.parse(m[1]) as string };
  } catch {
    return { ok: false, rule: "item-3", detail: "JSX emitter string is not JSON-decodable" };
  }
}

function isHostTag(ts: TSModule, tag: TS.JsxTagNameExpression): boolean {
  if (ts.isIdentifier(tag)) {
    const name = tag.text;
    return name.length > 0 && name[0] === name[0]?.toLowerCase();
  }
  return false;
}

function tagNameText(tag: TS.JsxTagNameExpression): string {
  return tag.getText();
}

type BindingKind =
  | { readonly kind: "param" }
  | { readonly kind: "local"; readonly init: TS.Expression | undefined }
  | { readonly kind: "global"; readonly name: string };

function collectBindings(ts: TSModule, sf: TS.SourceFile): Map<string, BindingKind> {
  const map = new Map<string, BindingKind>();
  for (const name of Object.keys(SAFE_GLOBALS)) map.set(name, { kind: "global", name });
  for (const name of DURABLE_GLOBALS) map.set(name, { kind: "global", name });
  map.set("document", { kind: "global", name: "document" });
  map.set("window", { kind: "global", name: "window" });
  map.set("globalThis", { kind: "global", name: "globalThis" });
  map.set("navigator", { kind: "global", name: "navigator" });
  map.set("location", { kind: "global", name: "location" });
  map.set("fetch", { kind: "global", name: "fetch" });
  map.set("XMLHttpRequest", { kind: "global", name: "XMLHttpRequest" });
  map.set("WebSocket", { kind: "global", name: "WebSocket" });

  const visit = (node: TS.Node, params: ReadonlySet<string>): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const next = new Set(params);
      for (const p of node.parameters) {
        if (ts.isIdentifier(p.name)) {
          next.add(p.name.text);
          map.set(p.name.text, { kind: "param" });
        } else if (ts.isObjectBindingPattern(p.name)) {
          for (const el of p.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
              next.add(el.name.text);
              map.set(el.name.text, { kind: "param" });
            }
          }
        }
      }
      if (node.body !== undefined) visit(node.body, next);
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      map.set(node.name.text, { kind: "local", init: node.initializer });
    }
    ts.forEachChild(node, (c) => visit(c, params));
  };
  visit(sf, new Set());
  return map;
}

function rootOfAccess(ts: TSModule, expr: TS.Expression): TS.Expression {
  let cur: TS.Expression = expr;
  while (
    ts.isPropertyAccessExpression(cur) ||
    ts.isElementAccessExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isParenthesizedExpression(cur)
  ) {
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    cur = cur.expression;
  }
  return cur;
}

function accessNames(ts: TSModule, expr: TS.Expression): string[] {
  const names: string[] = [];
  let cur: TS.Expression = expr;
  while (
    ts.isPropertyAccessExpression(cur) ||
    ts.isElementAccessExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isParenthesizedExpression(cur)
  ) {
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(cur)) names.push(cur.name.text);
    else if (ts.isElementAccessExpression(cur)) {
      const arg = cur.argumentExpression;
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) names.push(arg.text);
      else if (ts.isNumericLiteral(arg)) names.push(arg.text);
      else names.push("*");
    }
    cur = cur.expression;
  }
  if (ts.isIdentifier(cur)) names.push(cur.text);
  return names.reverse();
}

function isIdentityOrMember(ts: TSModule, expr: TS.Expression): boolean {
  if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr))
    return isIdentityOrMember(ts, expr.expression);
  if (ts.isIdentifier(expr)) return true;
  if (ts.isPropertyAccessExpression(expr)) return isIdentityOrMember(ts, expr.expression);
  if (ts.isElementAccessExpression(expr)) {
    const arg = expr.argumentExpression;
    if (
      ts.isStringLiteral(arg) ||
      ts.isNumericLiteral(arg) ||
      ts.isNoSubstitutionTemplateLiteral(arg)
    ) {
      return isIdentityOrMember(ts, expr.expression);
    }
    return false;
  }
  return false;
}

function classifyJsExpression(
  ts: TSModule,
  expr: TS.Expression,
  bindings: Map<string, BindingKind>,
  ctx: JsxContext,
  via: string,
): AcquisitionFact[] {
  const facts: AcquisitionFact[] = [];
  const names = accessNames(ts, expr);
  const rootName = names[0];
  if (rootName !== undefined) {
    const allow = SAFE_GLOBALS[rootName];
    if (allow !== undefined && allow.size > 0) {
      for (const n of names.slice(1)) {
        if (!allow.has(n)) {
          facts.push({
            id: `js-member:${names.join(".")}`,
            rule: "item-2",
            detail: `member ${n} is outside the ${rootName} allowlist`,
          });
          return facts;
        }
      }
    }
  }
  if (names.includes("*") || names.some((n) => /^\d+$/.test(n))) {
    facts.push({
      id: `js-computed:${via}:${expr.getText()}`,
      rule: "item-2",
      detail: "numeric-only or unclassifiable computed access",
    });
    return facts;
  }
  for (const n of names) {
    if (REFUSED_PROPS.has(n) || DURABLE_GLOBALS.has(n) || n === "cookie") {
      facts.push({
        id: `js-root:${via}:${names.join(".")}`,
        rule: "item-2",
        detail: `durable or host-runtime access ${names.join(".")}`,
      });
      return facts;
    }
  }
  if (ts.isCallExpression(expr) || ts.isNewExpression(expr)) {
    const callee = expr.expression;
    const calleeNames = accessNames(ts, callee);
    const last = calleeNames[calleeNames.length - 1] ?? callee.getText();
    if (NETWORK_CALLEES.has(last) || last === "sendBeacon" || last === "open") {
      const args = expr.arguments ?? [];
      if (last === "WebSocket" || last === "XMLHttpRequest" || last === "sendBeacon") {
        facts.push({
          id: `js-network:${last}`,
          rule: "item-2",
          detail: `${last} is a non-GET network acquisition`,
        });
        return facts;
      }
      if (last === "fetch") {
        const opts = args[1];
        if (opts !== undefined) {
          if (ts.isObjectLiteralExpression(opts)) {
            const method = opts.properties.find(
              (p) =>
                ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "method",
            );
            if (method !== undefined && ts.isPropertyAssignment(method)) {
              const init = method.initializer;
              const lit =
                ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)
                  ? init.text.toLowerCase()
                  : null;
              if (lit !== "get") {
                facts.push({
                  id: "js-fetch-non-get",
                  rule: "item-2",
                  detail: "fetch with a non-GET method",
                });
                return facts;
              }
            }
          } else {
            facts.push({
              id: "js-fetch-opts",
              rule: "item-2",
              detail: "unclassifiable fetch options",
            });
            return facts;
          }
        }
        const urlArg = args[0];
        if (urlArg !== undefined)
          facts.push(...classifyValueExpression(ts, urlArg, bindings, ctx, "fetch-url"));
        return facts;
      }
    }
    if (last === "setItem" || last === "removeItem" || last === "clear" || last === "getItem") {
      if (calleeNames.some((n) => DURABLE_GLOBALS.has(n))) {
        facts.push({
          id: `js-storage:${calleeNames.join(".")}`,
          rule: "item-2",
          detail: "storage API acquisition",
        });
        return facts;
      }
    }
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const leftNames = accessNames(ts, expr.left);
    if (leftNames.includes("cookie") || leftNames.some((n) => DURABLE_GLOBALS.has(n))) {
      facts.push({
        id: `js-assign:${leftNames.join(".")}`,
        rule: "item-2",
        detail: "cookie or storage assignment",
      });
    }
  }
  return facts;
}

function walkJs(
  ts: TSModule,
  node: TS.Node,
  bindings: Map<string, BindingKind>,
  ctx: JsxContext,
  facts: AcquisitionFact[],
): void {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
    return;
  }
  if (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isBinaryExpression(node) ||
    ts.isPropertyAccessExpression(node)
  ) {
    facts.push(...classifyJsExpression(ts, node as TS.Expression, bindings, ctx, "js"));
  }
  ts.forEachChild(node, (c) => walkJs(ts, c, bindings, ctx, facts));
}

function classifyValueExpression(
  ts: TSModule,
  expr: TS.Expression,
  bindings: Map<string, BindingKind>,
  ctx: JsxContext,
  via: string,
): AcquisitionFact[] {
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isAsExpression(expr)
  ) {
    return classifyValueExpression(ts, expr.expression, bindings, ctx, via);
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    const decoded = ts.isStringLiteral(expr)
      ? decodeJsxStringLiteral(ts, expr)
      : { ok: true as const, facts: [] as AcquisitionFact[], value: expr.text };
    if (!decoded.ok) return [{ id: `decode:${via}`, rule: decoded.rule, detail: decoded.detail }];
    const value = decoded.value ?? expr.text;
    const hit = classifyLiteralUrlValue(value, "item-3", ctx.admittedOrigins);
    return hit === null ? [] : [{ ...hit, id: `${via}:${hit.id}` }];
  }
  if (ts.isTemplateExpression(expr)) {
    const chunks = [expr.head.text, ...expr.templateSpans.map((s) => s.literal.text)];
    if (chunks.some((c) => listBoundaryInText(c))) {
      return [
        {
          id: `tpl-list:${via}`,
          rule: "item-5",
          detail: "template static chunks contain a list boundary",
        },
      ];
    }
    if (!templateHeadPinsOrigin(expr.head.text)) {
      return [
        { id: `tpl-head:${via}`, rule: "item-5", detail: "template head does not pin origin" },
      ];
    }
    const out: AcquisitionFact[] = [];
    for (const span of expr.templateSpans) {
      out.push(...classifyInterpolation(ts, span.expression, bindings, ctx, via));
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(expr) || ts.isArrayLiteralExpression(expr)) {
    const out: AcquisitionFact[] = [];
    const kids = ts.isObjectLiteralExpression(expr)
      ? expr.properties.map((p) => (ts.isPropertyAssignment(p) ? p.initializer : undefined))
      : expr.elements.map((el) => (ts.isSpreadElement(el) ? el.expression : el));
    for (const kid of kids) {
      if (kid !== undefined) out.push(...classifyValueExpression(ts, kid, bindings, ctx, via));
    }
    return out;
  }
  if (isIdentityOrMember(ts, expr)) {
    const root = rootOfAccess(ts, expr);
    if (!ts.isIdentifier(root)) {
      return [{ id: `unresolved:${via}`, rule: "item-5", detail: "unclassifiable identity root" }];
    }
    const binding = bindings.get(root.text);
    if (binding?.kind === "param") return [];
    if (binding?.kind === "local") {
      if (binding.init === undefined) {
        return [{ id: `local-uninit:${root.text}`, rule: "item-5", detail: "uninitialized local" }];
      }
      return classifyValueExpression(ts, binding.init, bindings, ctx, `local:${root.text}`);
    }
    return classifyJsExpression(ts, expr, bindings, ctx, via);
  }
  return [
    {
      id: `derived:${via}:${expr.getText()}`,
      rule: "item-5",
      detail: "derived expression at a value position",
    },
  ];
}

function classifyInterpolation(
  ts: TSModule,
  expr: TS.Expression,
  bindings: Map<string, BindingKind>,
  ctx: JsxContext,
  via: string,
): AcquisitionFact[] {
  if (!isIdentityOrMember(ts, expr)) {
    return [
      {
        id: `tpl-expr:${via}`,
        rule: "item-5",
        detail: "template interpolation is not identity or member",
      },
    ];
  }
  return classifyValueExpression(ts, expr, bindings, ctx, via);
}

function isOnHandlerName(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("on") && n.length > 2;
}

function classifyJsxAttributes(
  ts: TSModule,
  attrs: TS.JsxAttributes,
  host: boolean,
  tag: string,
  bindings: Map<string, BindingKind>,
  ctx: JsxContext,
  facts: AcquisitionFact[],
): void {
  for (const prop of attrs.properties) {
    if (ts.isJsxSpreadAttribute(prop)) {
      if (host) {
        facts.push({
          id: `spread-host:${tag}`,
          rule: "item-5",
          detail: "spread on a host element",
        });
        continue;
      }
      if (ts.isIdentifier(prop.expression) && bindings.get(prop.expression.text)?.kind === "param")
        continue;
      facts.push({
        id: `spread-component:${tag}`,
        rule: "item-5",
        detail: "component spread is not unmodified caller props",
      });
      continue;
    }
    if (!ts.isJsxAttribute(prop)) continue;
    const name = prop.name.getText();
    const lower = name.toLowerCase();
    if (
      lower === "formaction" ||
      lower === "formmethod" ||
      lower === "ping" ||
      lower === "srcdoc" ||
      lower === "dangerouslysetinnerhtml"
    ) {
      facts.push({
        id: `jsx-attr:${tag}:${name}`,
        rule: "item-4",
        detail: `${name} refuses regardless of value`,
      });
      continue;
    }
    if (host && tag.toLowerCase() === "base") {
      facts.push({ id: "jsx-base", rule: "item-4", detail: "base in JSX refuses" });
      continue;
    }
    if (host && tag.toLowerCase() === "form" && lower === "method") {
      const init = prop.initializer;
      if (init === undefined) continue;
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
        if (init.text.trim().toLowerCase() !== "get") {
          facts.push({
            id: `form-method:${init.text}`,
            rule: "item-4",
            detail: `form method ${init.text} is not GET`,
          });
        }
        continue;
      }
      if (ts.isJsxExpression(init) && init.expression !== undefined) {
        if (
          ts.isStringLiteral(init.expression) ||
          ts.isNoSubstitutionTemplateLiteral(init.expression)
        ) {
          if (init.expression.text.trim().toLowerCase() !== "get") {
            facts.push({
              id: `form-method:${init.expression.text}`,
              rule: "item-4",
              detail: `form method ${init.expression.text} is not GET`,
            });
          }
          continue;
        }
        facts.push({
          id: "form-method-nonliteral",
          rule: "item-4",
          detail: "form method is not a static literal get",
        });
      }
      continue;
    }
    if ((lower === "http-equiv" || lower === "httpequiv") && tag.toLowerCase() === "meta") {
      const init = prop.initializer;
      const lit =
        init !== undefined && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))
          ? init.text
          : init !== undefined &&
              ts.isJsxExpression(init) &&
              init.expression !== undefined &&
              (ts.isStringLiteral(init.expression) ||
                ts.isNoSubstitutionTemplateLiteral(init.expression))
            ? init.expression.text
            : null;
      if (
        lit === null ||
        !(META_HTTP_EQUIV_ALLOW as readonly string[]).includes(lit.trim().toLowerCase())
      ) {
        facts.push({
          id: `meta-http-equiv:${lit ?? "nonliteral"}`,
          rule: "item-4",
          detail: "meta httpEquiv outside the benign allowlist",
        });
      }
      continue;
    }
    if (lower === "style") {
      const init = prop.initializer;
      if (
        init !== undefined &&
        (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))
      ) {
        const css = classifyCssText(init.text);
        if (css !== null) facts.push(css);
      } else if (init !== undefined && ts.isJsxExpression(init) && init.expression !== undefined) {
        if (
          ts.isStringLiteral(init.expression) ||
          ts.isNoSubstitutionTemplateLiteral(init.expression)
        ) {
          const css = classifyCssText(init.expression.text);
          if (css !== null) facts.push(css);
        } else if (ts.isObjectLiteralExpression(init.expression)) {
          for (const p of init.expression.properties) {
            if (
              ts.isPropertyAssignment(p) &&
              (ts.isStringLiteral(p.initializer) ||
                ts.isNoSubstitutionTemplateLiteral(p.initializer))
            ) {
              const css = classifyCssText(p.initializer.text);
              if (css !== null) facts.push(css);
            }
          }
        } else {
          facts.push({ id: "style-nonliteral", rule: "item-4", detail: "non-literal style value" });
        }
      }
      continue;
    }
    if (isOnHandlerName(name)) {
      const init = prop.initializer;
      if (init === undefined) continue;
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
        facts.push(...classifyJsSource(ts, init.text, bindings, ctx, `handler:${name}`));
        continue;
      }
      if (ts.isJsxExpression(init) && init.expression !== undefined) {
        facts.push(...classifyJsExpression(ts, init.expression, bindings, ctx, `handler:${name}`));
        walkJs(ts, init.expression, bindings, ctx, facts);
      }
      continue;
    }
    const init = prop.initializer;
    if (init === undefined) continue;
    if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
      let value = init.text;
      if (ts.isStringLiteral(init)) {
        const decoded = decodeJsxStringLiteral(ts, init);
        if (!decoded.ok) {
          facts.push({ id: `decode:${name}`, rule: decoded.rule, detail: decoded.detail });
          continue;
        }
        value = decoded.value ?? init.text;
      }
      const hit = classifyLiteralUrlValue(value, "item-3", ctx.admittedOrigins);
      if (hit !== null) facts.push({ ...hit, id: `jsx:${tag}:${name}:${hit.id}` });
      continue;
    }
    if (ts.isJsxExpression(init) && init.expression !== undefined) {
      facts.push(
        ...classifyValueExpression(ts, init.expression, bindings, ctx, `jsx:${tag}:${name}`),
      );
    }
  }
}

function classifyJsSource(
  ts: TSModule,
  source: string,
  _bindings: Map<string, BindingKind>,
  ctx: JsxContext,
  via: string,
): AcquisitionFact[] {
  const sf = ts.createSourceFile(
    `${via}.ts`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const facts: AcquisitionFact[] = [];
  const bindings = collectBindings(ts, sf);
  walkJs(ts, sf, bindings, ctx, facts);
  return facts;
}

function walkJsx(
  ts: TSModule,
  node: TS.Node,
  bindings: Map<string, BindingKind>,
  ctx: JsxContext,
  facts: AcquisitionFact[],
): void {
  if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
    const host = isHostTag(ts, node.tagName);
    const tag = tagNameText(node.tagName);
    const lower = tag.toLowerCase();
    if (
      host &&
      (lower === "noscript" || lower === "iframe" || lower === "embed" || lower === "object")
    ) {
      facts.push({ id: `elem:${lower}`, rule: "item-4", detail: `<${lower}> refuses` });
    }
    if (host && lower === "script") {
      const hasSrc = node.attributes.properties.some(
        (p) => ts.isJsxAttribute(p) && p.name.getText().toLowerCase() === "src",
      );
      if (hasSrc)
        facts.push({ id: "elem:script[src]", rule: "item-4", detail: "script[src] refuses" });
    }
    classifyJsxAttributes(ts, node.attributes, host, tag, bindings, ctx, facts);
  }
  if (ts.isJsxElement(node)) {
    const open = node.openingElement;
    const host = isHostTag(ts, open.tagName);
    if (!host) {
      for (const child of node.children) {
        if (ts.isJsxText(child)) {
          const text = child.text;
          if (text.trim().length === 0) continue;
          const hit = classifyLiteralUrlValue(text, "item-3", ctx.admittedOrigins);
          if (hit !== null) facts.push({ ...hit, id: `child:${hit.id}` });
        } else if (ts.isJsxExpression(child) && child.expression !== undefined) {
          facts.push(...classifyValueExpression(ts, child.expression, bindings, ctx, "child"));
        }
      }
    }
    if (host && tagNameText(open.tagName).toLowerCase() === "style") {
      const text = node.children.map((c) => (ts.isJsxText(c) ? c.text : "")).join("");
      const css = classifyCssText(text);
      if (css !== null) facts.push(css);
    }
    if (host && tagNameText(open.tagName).toLowerCase() === "script") {
      const text = node.children.map((c) => (ts.isJsxText(c) ? c.text : "")).join("");
      if (text.trim().length > 0)
        facts.push(...classifyJsSource(ts, text, bindings, ctx, "script"));
    }
  }
  ts.forEachChild(node, (c) => walkJsx(ts, c, bindings, ctx, facts));
}

export function classifyTsxSource(path: string, source: string, ctx: JsxContext): ClassifyResult {
  const ts = ctx.ts;
  const kind = path.toLowerCase().endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const parseDiags =
    (sf as TS.SourceFile & { parseDiagnostics?: readonly TS.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiags.length > 0) {
    return { ok: false, rule: "item-9", detail: "TypeScript parse error" };
  }
  const facts: AcquisitionFact[] = [];
  const bindings = collectBindings(ts, sf);
  walkJsx(ts, sf, bindings, ctx, facts);
  walkJs(ts, sf, bindings, ctx, facts);
  const imports = collectImports(ts, sf);
  for (const spec of imports) {
    facts.push(...classifyImport(spec, ctx));
  }
  return { ok: true, facts: dedupe(facts) };
}

function collectImports(ts: TSModule, sf: TS.SourceFile): string[] {
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      stmt.moduleSpecifier !== undefined &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      out.push(stmt.moduleSpecifier.text);
      if (
        stmt.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(stmt.importClause.namedBindings)
      ) {
        for (const el of stmt.importClause.namedBindings.elements) {
          out.push(`name:${el.name.text}`);
        }
      }
    }
  }
  return out;
}

function classifyImport(spec: string, ctx: JsxContext): AcquisitionFact[] {
  if (spec.startsWith("name:")) {
    const name = spec.slice("name:".length);
    if (DURABLE_GLOBALS.has(name) || name === "cookie") {
      return [
        {
          id: `import-name:${name}`,
          rule: "item-2",
          detail: `import name ${name} is on the durable set`,
        },
      ];
    }
    return [];
  }
  if (ctx.admittedPackages.includes(spec)) return [];
  const inRepo = spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/");
  if (inRepo && !IN_CLASS_IMPORT.test(spec)) {
    return [
      {
        id: `import-helper:${spec}`,
        rule: "item-2",
        detail: `new in-repo out-of-class import ${spec}`,
      },
    ];
  }
  if (!inRepo) {
    return [
      {
        id: `import-npm:${spec}`,
        rule: "item-2",
        detail: `npm import ${spec} is not on the merge-base package allowlist`,
      },
    ];
  }
  return [];
}

const IN_CLASS_IMPORT = /\.(html|jsx|tsx)(\?|$)/i;

function dedupe(facts: readonly AcquisitionFact[]): AcquisitionFact[] {
  const seen = new Set<string>();
  const out: AcquisitionFact[] = [];
  for (const f of facts) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

export function classifyHandlerText(source: string, ctx: JsxContext): readonly AcquisitionFact[] {
  return classifyJsSource(ctx.ts, source, new Map(), ctx, "handler");
}
