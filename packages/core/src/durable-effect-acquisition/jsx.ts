/**
 * Bounded, deny-by-default executable JS and JSX analysis (#5080).
 * Lexical symbols identify bindings. Only immutable, unmutated aliases resolve;
 * unsupported provenance is a refusal, never an effect-free assumption.
 * Parameters retain supplying-edge ownership except host/reflection members.
 */
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import type * as TS from "typescript";
import { classifyCssEffects } from "./css.js";
import {
  type AcquisitionFact,
  type ClassifyResult,
  isInertNativeAttribute,
  MARKUP_CHANNEL_ATTRIBUTES,
  META_HTTP_EQUIV_ALLOW,
} from "./types.js";
import { classifyLiteralUrlValue, templateHeadPinsOrigin } from "./url.js";

type TSModule = typeof TS;
const TS_CACHE = new Map<string, TSModule>();
export type TsLoad =
  | { readonly ok: true; readonly ts: TSModule }
  | { readonly ok: false; readonly detail: string };
export function loadProjectTypeScript(projectRoot: string): TsLoad {
  const cached = TS_CACHE.get(projectRoot);
  if (cached !== undefined) return { ok: true, ts: cached };
  try {
    const req = createRequire(join(projectRoot, "package.json"));
    const mod = req(req.resolve("typescript")) as TSModule;
    if (typeof mod.createSourceFile !== "function")
      return { ok: false, detail: "TypeScript parser unavailable" };
    TS_CACHE.set(projectRoot, mod);
    return { ok: true, ts: mod };
  } catch (err) {
    return { ok: false, detail: `no typescript resolvable from ${projectRoot}: ${String(err)}` };
  }
}
export type JsxContext = {
  readonly ts: TSModule;
  readonly admittedOrigins: readonly string[];
  readonly admittedPackages: readonly string[];
  readonly admittedPaths: readonly string[];
  readonly admittedGlobals?: readonly {
    readonly name: string;
    readonly members?: readonly string[];
  }[];
};
const SAFE_GLOBALS: Readonly<Record<string, readonly string[]>> = {
  console: ["log", "info", "warn", "error", "debug", "dir", "table", "time", "timeEnd"],
  Math: [
    "abs",
    "ceil",
    "floor",
    "round",
    "trunc",
    "max",
    "min",
    "pow",
    "sqrt",
    "sign",
    "sin",
    "cos",
    "tan",
    "random",
    "PI",
    "E",
  ],
  JSON: ["parse", "stringify"],
  Object: ["keys", "values", "entries", "fromEntries", "is", "hasOwn", "freeze"],
  Array: ["isArray", "from", "of"],
  Number: ["isFinite", "isInteger", "isNaN", "parseInt", "parseFloat"],
  String: ["fromCharCode", "fromCodePoint"],
  Boolean: [],
  Date: ["now", "parse", "UTC"],
  Map: [],
  Set: [],
  WeakMap: [],
  WeakSet: [],
  Error: [],
  URL: [],
  URLSearchParams: [],
  Intl: ["NumberFormat", "DateTimeFormat", "Collator", "RelativeTimeFormat"],
  Promise: ["all", "allSettled", "race", "resolve", "reject"],
  undefined: [],
  NaN: [],
  Infinity: [],
  parseInt: [],
  parseFloat: [],
  isNaN: [],
  isFinite: [],
  encodeURIComponent: [],
  decodeURIComponent: [],
  encodeURI: [],
  decodeURI: [],
};
const REFUSED_MEMBERS = new Set([
  "constructor",
  "prototype",
  "__proto__",
  "cookie",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "cookieStore",
  "caches",
  "view",
  "target",
  "currentTarget",
  "nativeEvent",
  "current",
  "ownerDocument",
  "defaultView",
  "contentWindow",
  "opener",
]);
const SINGLE_URL_ATTRIBUTES = new Set([
  "src",
  "href",
  "action",
  "poster",
  "cite",
  "background",
  "data",
  "xlink:href",
]);
const PURE_VALUE_MEMBERS = new Set([
  "length",
  "toString",
  "trim",
  "toLowerCase",
  "toUpperCase",
  "slice",
  "substring",
  "includes",
  "startsWith",
  "endsWith",
  "split",
  "join",
  "map",
  "filter",
  "reduce",
  "find",
  "some",
  "every",
  "at",
]);
const MEMORY_INSTANCE_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  Map: ["size", "get", "set", "has", "delete", "clear", "keys", "values", "entries", "forEach"],
  Set: ["size", "add", "has", "delete", "clear", "keys", "values", "entries", "forEach"],
  WeakMap: ["get", "set", "has", "delete"],
  WeakSet: ["add", "has", "delete"],
};
type Provenance = {
  kind: "parameter" | "local" | "import" | "global" | "unknown";
  name?: string;
  members: string[];
  value?: TS.Expression;
  declaration?: TS.Declaration;
};
type StaticValue = string | number | boolean | null;
type ValueResult = { known: true; value: StaticValue } | { known: false };

function analyze(path: string, source: string, ctx: JsxContext): ClassifyResult {
  const ts = ctx.ts;
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const errors =
    (sf as TS.SourceFile & { parseDiagnostics?: readonly TS.Diagnostic[] }).parseDiagnostics ?? [];
  if (errors.length > 0) return { ok: false, rule: "item-9", detail: "TypeScript parse error" };
  // An isolated compiler program supplies lexical binding identity without loading/executing project code.
  const host: TS.CompilerHost = {
    getSourceFile: (name) => (name === path ? sf : undefined),
    getDefaultLibFileName: () => "",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (name) => name === path,
    readFile: (name) => (name === path ? source : undefined),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const checker = ts
    .createProgram([path], { noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve }, host)
    .getTypeChecker();
  const symbolAt = (node: TS.Identifier): TS.Symbol | undefined =>
    ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
  const facts: AcquisitionFact[] = [];
  const mutations = new Set<TS.Symbol>();
  const unwrap = (expr: TS.Expression): TS.Expression => {
    let out = expr;
    while (
      ts.isParenthesizedExpression(out) ||
      ts.isAsExpression(out) ||
      ts.isNonNullExpression(out) ||
      ts.isTypeAssertionExpression(out) ||
      ts.isSatisfiesExpression(out)
    )
      out = out.expression;
    return out;
  };
  const root = (expr: TS.Expression): TS.Expression => {
    let out = unwrap(expr);
    while (ts.isPropertyAccessExpression(out) || ts.isElementAccessExpression(out))
      out = unwrap(out.expression);
    return out;
  };
  const markMutation = (expr: TS.Expression, seen = new Set<TS.Symbol>()): void => {
    const r = root(expr);
    if (!ts.isIdentifier(r)) return;
    const symbol = symbolAt(r);
    if (!symbol || seen.has(symbol)) return;
    mutations.add(symbol);
    const next = new Set(seen);
    next.add(symbol);
    const d = symbol.valueDeclaration;
    if (d && ts.isVariableDeclaration(d) && d.initializer) {
      const init = unwrap(d.initializer);
      if (
        ts.isIdentifier(init) ||
        ts.isPropertyAccessExpression(init) ||
        ts.isElementAccessExpression(init)
      )
        markMutation(init, next);
      if (ts.isObjectLiteralExpression(init))
        for (const prop of init.properties) {
          if (ts.isPropertyAssignment(prop)) markMutation(prop.initializer, next);
          else if (ts.isShorthandPropertyAssignment(prop)) markMutation(prop.name, next);
        }
    }
  };
  const scanMutation = (node: TS.Node): void => {
    let target: TS.Expression | undefined;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      target = node.left;
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    )
      target = node.operand;
    if (ts.isDeleteExpression(node)) target = node.expression;
    if (target !== undefined) markMutation(target);
    ts.forEachChild(node, scanMutation);
  };
  scanMutation(sf);
  // Passing a local object to an unmodelled call forfeits the immutable-object
  // assumption, even when that call/assignment already existed at merge-base.
  const objectBinding = (expr: TS.Expression, seen = new Set<TS.Symbol>()): boolean => {
    const value = unwrap(expr);
    if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)) return true;
    if (!ts.isIdentifier(value)) return false;
    const sym = symbolAt(value);
    if (!sym || seen.has(sym)) return false;
    const d = sym.valueDeclaration;
    if (!d || !ts.isVariableDeclaration(d) || !d.initializer) return false;
    const next = new Set(seen);
    next.add(sym);
    return objectBinding(d.initializer, next);
  };
  const scanEscape = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = resolve(node.expression);
      const known =
        callee.kind === "global" &&
        (callee.name === "fetch" || SAFE_GLOBALS[callee.name ?? ""] !== undefined);
      if (!known) for (const arg of node.arguments) if (objectBinding(arg)) markMutation(arg);
    }
    ts.forEachChild(node, scanEscape);
  };
  const normalized = (node: TS.Node, seen = new Set<TS.Declaration>()): string => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const relevant = MARKUP_CHANNEL_ATTRIBUTES[node.tagName.getText(sf)] ?? [];
      return JSON.stringify([
        node.tagName.getText(sf),
        node.attributes.properties
          .filter(
            (p) => !ts.isJsxAttribute(p) || relevant.includes(p.name.getText(sf).toLowerCase()),
          )
          .map((p) => normalized(p, seen))
          .sort(),
      ]);
    }
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      true,
      ts.LanguageVariant.JSX,
      node.getText(sf),
    );
    const tokens: string[] = [];
    let token = scanner.scan();
    while (token !== ts.SyntaxKind.EndOfFileToken) {
      tokens.push(
        token === ts.SyntaxKind.StringLiteral ||
          token === ts.SyntaxKind.NoSubstitutionTemplateLiteral
          ? JSON.stringify(scanner.getTokenValue())
          : scanner.getTokenText(),
      );
      token = scanner.scan();
    }
    const dependencies: string[] = [];
    const visit = (child: TS.Node): void => {
      if (ts.isIdentifier(child)) {
        const d = symbolAt(child)?.valueDeclaration;
        if (
          d &&
          ts.isVariableDeclaration(d) &&
          d.initializer &&
          ts.isVariableDeclarationList(d.parent) &&
          d.parent.flags & ts.NodeFlags.Const &&
          !seen.has(d)
        ) {
          const next = new Set(seen);
          next.add(d);
          dependencies.push(`${child.text}=${normalized(d.initializer, next)}`);
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return tokens.join(" ") + JSON.stringify(dependencies);
  };
  const site = (node: TS.Node): TS.Node => {
    let out = node;
    while (
      out.parent &&
      (ts.isPropertyAccessExpression(out.parent) ||
        ts.isElementAccessExpression(out.parent) ||
        ts.isParenthesizedExpression(out.parent) ||
        ts.isCallExpression(out.parent) ||
        ts.isNewExpression(out.parent) ||
        ts.isBinaryExpression(out.parent))
    )
      out = out.parent;
    return out;
  };
  const seenSites = new Set<string>();
  const add = (node: TS.Node, id: string, detail: string, rule = "item-2"): void => {
    const location = site(node);
    const key = `${location.pos}:${id}`;
    if (seenSites.has(key)) return;
    seenSites.add(key);
    facts.push({ id: `${id}:${normalized(location)}`, rule, detail });
  };
  const propertyKey = (name: TS.PropertyName, seen: Set<TS.Node>): string | undefined => {
    if (
      ts.isIdentifier(name) ||
      ts.isStringLiteral(name) ||
      ts.isNumericLiteral(name) ||
      ts.isNoSubstitutionTemplateLiteral(name)
    )
      return name.text;
    if (ts.isComputedPropertyName(name)) {
      const v = staticValue(name.expression, seen);
      if (v.known && (typeof v.value === "string" || typeof v.value === "number"))
        return String(v.value);
    }
    return undefined;
  };
  const resolve = (input: TS.Expression, seen = new Set<TS.Node>()): Provenance => {
    const expr = unwrap(input);
    if (seen.has(expr)) return { kind: "unknown", members: [] };
    const next = new Set(seen);
    next.add(expr);
    if (ts.isIdentifier(expr)) {
      const symbol = symbolAt(expr);
      if (!symbol) return { kind: "global", name: expr.text, members: [] };
      if (mutations.has(symbol)) return { kind: "unknown", members: [] };
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (!declaration) return { kind: "unknown", members: [] };
      if (ts.isParameter(declaration)) return { kind: "parameter", members: [], declaration };
      if (ts.isBindingElement(declaration)) {
        let parent: TS.Node = declaration.parent;
        while (
          ts.isObjectBindingPattern(parent) ||
          ts.isArrayBindingPattern(parent) ||
          ts.isBindingElement(parent)
        )
          parent = parent.parent;
        if (ts.isParameter(parent)) return { kind: "parameter", members: [], declaration };
        return { kind: "unknown", members: [] };
      }
      if (ts.isVariableDeclaration(declaration)) {
        if (
          !ts.isVariableDeclarationList(declaration.parent) ||
          !(declaration.parent.flags & ts.NodeFlags.Const) ||
          !declaration.initializer
        )
          return { kind: "unknown", members: [] };
        return resolve(declaration.initializer, next);
      }
      if (
        ts.isImportSpecifier(declaration) ||
        ts.isImportClause(declaration) ||
        ts.isNamespaceImport(declaration)
      )
        return { kind: "import", members: [], declaration };
      if (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration))
        return { kind: "local", members: [], declaration };
      return { kind: "unknown", members: [] };
    }
    if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      const base = resolve(expr.expression, next);
      const key = ts.isPropertyAccessExpression(expr)
        ? expr.name.text
        : staticValue(expr.argumentExpression, next);
      const member =
        typeof key === "string"
          ? key
          : key.known && (typeof key.value === "string" || typeof key.value === "number")
            ? String(key.value)
            : undefined;
      if (member === undefined) return { kind: "unknown", members: [] };
      if (base.kind === "local" && base.value && ts.isObjectLiteralExpression(base.value)) {
        let found: TS.Expression | undefined;
        for (const prop of base.value.properties) {
          if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop))
            return { kind: "unknown", members: [] };
          const key = propertyKey(prop.name, next);
          if (key === undefined) return { kind: "unknown", members: [] };
          if (key === member) found = ts.isPropertyAssignment(prop) ? prop.initializer : prop.name;
        }
        return found ? resolve(found, next) : { kind: "unknown", members: [] };
      }
      return { ...base, members: [...base.members, member] };
    }
    if (
      ts.isStringLiteral(expr) ||
      ts.isNoSubstitutionTemplateLiteral(expr) ||
      ts.isNumericLiteral(expr) ||
      ts.isObjectLiteralExpression(expr) ||
      ts.isArrayLiteralExpression(expr) ||
      ts.isArrowFunction(expr) ||
      ts.isFunctionExpression(expr) ||
      ts.isTemplateExpression(expr) ||
      expr.kind === ts.SyntaxKind.TrueKeyword ||
      expr.kind === ts.SyntaxKind.FalseKeyword ||
      expr.kind === ts.SyntaxKind.NullKeyword
    )
      return { kind: "local", members: [], value: expr };
    if (ts.isNewExpression(expr)) {
      const p = resolve(expr.expression, next);
      if (p.kind === "global" && p.members.length === 0 && MEMORY_INSTANCE_MEMBERS[p.name ?? ""])
        return { kind: "local", members: [], value: expr, name: p.name };
    }
    return { kind: "unknown", members: [] };
  };
  function staticValue(input: TS.Expression, seen = new Set<TS.Node>()): ValueResult {
    const expr = unwrap(input);
    if (seen.has(expr)) return { known: false };
    const next = new Set(seen);
    next.add(expr);
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
      return { known: true, value: expr.text };
    if (ts.isNumericLiteral(expr)) return { known: true, value: Number(expr.text) };
    if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword)
      return { known: true, value: expr.kind === ts.SyntaxKind.TrueKeyword };
    if (expr.kind === ts.SyntaxKind.NullKeyword) return { known: true, value: null };
    if (ts.isTemplateExpression(expr)) {
      let value = expr.head.text;
      for (const span of expr.templateSpans) {
        const v = staticValue(span.expression, next);
        if (!v.known) return { known: false };
        value += String(v.value) + span.literal.text;
      }
      return { known: true, value };
    }
    const provenance = resolve(expr, seen);
    if (
      provenance.kind === "local" &&
      provenance.value &&
      provenance.value !== expr &&
      provenance.members.length === 0
    )
      return staticValue(provenance.value, next);
    return { known: false };
  }
  const approvedGlobal = (p: Provenance): boolean => {
    const name = p.name ?? "";
    const admitted = ctx.admittedGlobals?.find((g) => g.name === name);
    const allowed = admitted?.members ?? SAFE_GLOBALS[name];
    return (
      (admitted !== undefined || allowed !== undefined) &&
      (p.members.length === 0 ||
        (p.members.length === 1 && (allowed ?? []).includes(p.members[0] ?? "")))
    );
  };
  const reference = (expr: TS.Expression): void => {
    const p = resolve(expr);
    if (p.kind === "global" && approvedGlobal(p)) return;
    if (p.members.some((m) => REFUSED_MEMBERS.has(m))) {
      add(expr, "js-root", "durable, reflection, or host-runtime member");
      return;
    }
    if (p.kind === "parameter" || p.kind === "import") return;
    if (
      p.kind === "local" &&
      (p.members.length === 0 ||
        p.members.every(
          (m) =>
            PURE_VALUE_MEMBERS.has(m) ||
            /^\d+$/.test(m) ||
            (MEMORY_INSTANCE_MEMBERS[p.name ?? ""] ?? []).includes(m),
        ))
    )
      return;
    // A fetch reference may only be used as a call target or an immutable alias. The call is checked separately.
    if (p.kind === "global" && p.name === "fetch" && p.members.length === 0) {
      let use: TS.Node = expr;
      while (
        use.parent &&
        (ts.isParenthesizedExpression(use.parent) ||
          ts.isAsExpression(use.parent) ||
          ts.isNonNullExpression(use.parent))
      )
        use = use.parent;
      const parent = use.parent;
      if (parent && ts.isCallExpression(parent) && parent.expression === use) return;
      if (
        parent &&
        ts.isVariableDeclaration(parent) &&
        parent.initializer === use &&
        ts.isVariableDeclarationList(parent.parent) &&
        parent.parent.flags & ts.NodeFlags.Const
      )
        return;
    }
    add(
      expr,
      "js-root",
      p.kind === "global"
        ? `unapproved global/member ${p.name}.${p.members.join(".")}`
        : "unclassifiable executable provenance",
    );
  };
  const identityForward = (expr: TS.Expression): boolean => {
    const p = resolve(expr);
    return p.kind === "parameter" && !p.members.some((m) => REFUSED_MEMBERS.has(m));
  };
  const urlValue = (expr: TS.Expression, via: string, single: boolean): void => {
    const v = staticValue(expr);
    if (v.known) {
      if (typeof v.value !== "string") return;
      const hit = classifyLiteralUrlValue(
        v.value,
        "item-3",
        ctx.admittedOrigins,
        single ? "single" : "list",
      );
      if (hit) add(expr, `${via}:${hit.id}`, hit.detail, hit.rule);
      return;
    }
    if (identityForward(expr)) return;
    const resolved = resolve(expr);
    const value =
      resolved.kind === "local" && resolved.members.length === 0 && resolved.value
        ? resolved.value
        : unwrap(expr);
    if (
      ts.isTemplateExpression(value) &&
      single &&
      templateHeadPinsOrigin(value.head.text) &&
      value.templateSpans.every(
        (s) => identityForward(s.expression) || staticValue(s.expression).known,
      )
    )
      return;
    if (ts.isObjectLiteralExpression(value)) {
      for (const p of value.properties) {
        if (ts.isPropertyAssignment(p)) urlValue(p.initializer, via, false);
        else add(p, `derived:${via}`, "unsupported object supplier", "item-5");
      }
      return;
    }
    if (ts.isArrayLiteralExpression(value)) {
      for (const el of value.elements) urlValue(el, via, false);
      return;
    }
    add(
      expr,
      `derived:${via}`,
      "unresolved or derived URL value (list interpolation requires a complete static value)",
      "item-5",
    );
  };
  const fetchCall = (node: TS.CallExpression | TS.NewExpression): void => {
    const args = node.arguments ?? [];
    const options = args[1];
    if (options) {
      const p = resolve(options);
      if (
        p.kind !== "local" ||
        p.members.length > 0 ||
        !p.value ||
        !ts.isObjectLiteralExpression(p.value)
      )
        add(node, "js-fetch-opts", "unclassifiable fetch options");
      else {
        let method: ValueResult = { known: true, value: "GET" };
        let complete = true;
        for (const prop of p.value.properties) {
          if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) {
            complete = false;
            continue;
          }
          const key = propertyKey(prop.name, new Set());
          if (key === undefined) {
            complete = false;
            continue;
          }
          if (key === "method")
            method = staticValue(ts.isPropertyAssignment(prop) ? prop.initializer : prop.name);
        }
        if (!complete)
          add(node, "js-fetch-opts", "unclassifiable fetch options keys/spreads/getters");
        else if (
          !method.known ||
          typeof method.value !== "string" ||
          method.value.toUpperCase() !== "GET"
        )
          add(
            node,
            "js-fetch-non-get",
            `fetch non-GET method ${method.known ? String(method.value) : "unknown"}`,
          );
      }
    }
    if (args[0]) urlValue(args[0], "fetch-url", true);
    else add(node, "js-fetch-url", "missing fetch URL");
  };
  const decodeAttribute = (literal: TS.StringLiteral): string | undefined => {
    const emitted = ts.transpileModule(`export default <x a=${literal.getText(sf)} />;`, {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
      },
      reportDiagnostics: true,
      fileName: "decode.tsx",
    });
    if ((emitted.diagnostics ?? []).length > 0) return undefined;
    const out = ts.createSourceFile(
      "decode.js",
      emitted.outputText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    let value: string | undefined;
    const visit = (node: TS.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "a" &&
        ts.isStringLiteral(node.initializer)
      )
        value = node.initializer.text;
      ts.forEachChild(node, visit);
    };
    visit(out);
    return value;
  };
  const nativeTag = (tag: TS.JsxTagNameExpression): boolean =>
    ts.isIdentifier(tag) && /^[a-z][a-z0-9]*$/.test(tag.text);
  const decodeChildText = (node: TS.JsxText): string | undefined => {
    // JSX child entities and line trimming differ from both JS literals and
    // quoted attributes. Let the same compiler that emits JSX determine bytes.
    const emitted = ts.transpileModule(`export default <x>${node.text}</x>;`, {
      compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 },
      reportDiagnostics: true,
      fileName: "decode.tsx",
    });
    if ((emitted.diagnostics ?? []).length > 0) return undefined;
    const out = ts.createSourceFile(
      "decode.js",
      emitted.outputText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    let value: string | undefined;
    const visit = (n: TS.Node): void => {
      if (
        ts.isCallExpression(n) &&
        n.arguments[0] &&
        ts.isStringLiteral(n.arguments[0]) &&
        n.arguments[0].text === "x"
      ) {
        const child = n.arguments[2];
        if (!child) value = "";
        else if (ts.isStringLiteral(child)) value = child.text;
      }
      ts.forEachChild(n, visit);
    };
    visit(out);
    return value;
  };
  const jsx = (node: TS.JsxOpeningElement | TS.JsxSelfClosingElement): void => {
    const tag = node.tagName.getText(sf);
    const native = nativeTag(node.tagName);
    if (native && ["noscript", "iframe", "embed", "object"].includes(tag))
      add(node, `elem:${tag}`, `<${tag}> refuses`, "item-4");
    for (const prop of node.attributes.properties) {
      if (ts.isJsxSpreadAttribute(prop)) {
        if (native || !identityForward(prop.expression))
          add(prop, "spread", "unclassified JSX spread", "item-5");
        continue;
      }
      const name = prop.name.getText(sf).toLowerCase();
      const init = prop.initializer;
      if (
        ["formaction", "formmethod", "ping", "srcdoc", "dangerouslysetinnerhtml"].includes(name) ||
        (tag === "script" && name === "src")
      ) {
        add(prop, `jsx-attr:${name}`, `${name} refuses`, "item-4");
        continue;
      }
      if (!init) continue;
      const expr = ts.isJsxExpression(init) ? init.expression : undefined;
      const literal = ts.isStringLiteral(init) ? decodeAttribute(init) : undefined;
      if (ts.isStringLiteral(init) && literal === undefined) {
        add(init, "decode", "JSX emitter diagnostic", "item-9");
        continue;
      }
      const value =
        literal !== undefined
          ? { known: true as const, value: literal }
          : expr
            ? staticValue(expr)
            : { known: false as const };
      if (tag === "base" && name === "href") {
        const hit =
          value.known && typeof value.value === "string"
            ? classifyLiteralUrlValue(value.value, "item-6", [], "single")
            : { id: "base-nonliteral", detail: "unresolved document base" };
        if (hit) add(node, hit.id, hit.detail, "item-6");
        continue;
      }
      if (name.startsWith("on")) {
        if (literal !== undefined) {
          const r = analyze("handler.tsx", literal, ctx);
          if (r.ok) facts.push(...r.facts);
          else add(init, "handler-parse", r.detail, "item-9");
        }
        continue;
      }
      if (
        (tag === "form" && name === "method") ||
        (tag === "meta" && ["http-equiv", "httpequiv"].includes(name))
      ) {
        const text =
          value.known && typeof value.value === "string"
            ? value.value.trim().toLowerCase()
            : undefined;
        if (tag === "form" ? text !== "get" : !META_HTTP_EQUIV_ALLOW.some((v) => v === text))
          add(
            node,
            tag === "form" ? "form-method" : "meta-http-equiv",
            "submission or meta directive",
            "item-4",
          );
        continue;
      }
      if (name === "style") {
        if (value.known) {
          facts.push(...classifyCssEffects(String(value.value), `${tag}:style-attribute`));
        } else if (expr && ts.isObjectLiteralExpression(expr)) {
          for (const p of expr.properties) {
            if (ts.isPropertyAssignment(p)) {
              const v = staticValue(p.initializer);
              const key = propertyKey(p.name, new Set());
              if (v.known && key !== undefined) {
                facts.push(...classifyCssEffects(String(v.value), `${tag}:style-property:${key}`));
              } else add(p, "style-nonliteral", "unresolved style value", "item-4");
            } else add(p, "style-nonliteral", "unresolved style property", "item-4");
          }
        } else add(init, "style-nonliteral", "unresolved style value", "item-4");
        continue;
      }
      if (native && isInertNativeAttribute(name)) continue;
      const single = native && SINGLE_URL_ATTRIBUTES.has(name);
      if (literal !== undefined) {
        const hit = classifyLiteralUrlValue(
          literal,
          "item-3",
          ctx.admittedOrigins,
          single ? "single" : "list",
        );
        if (hit) add(init, `jsx:${tag}:${name}:${hit.id}`, hit.detail, hit.rule);
      } else if (expr) urlValue(expr, `jsx:${tag}:${name}`, single);
    }
  };
  const importFact = (node: TS.ImportDeclaration | TS.ExportDeclaration): void => {
    const spec = node.moduleSpecifier;
    if (!spec || !ts.isStringLiteral(spec)) return;
    const name = spec.text;
    const relative = name.startsWith(".")
      ? posix.normalize(posix.join(posix.dirname(path), name))
      : name.startsWith("@/")
        ? name.slice(2)
        : name;
    if (ctx.admittedPackages.includes(name) || ctx.admittedPaths.includes(relative)) return;
    if (
      (name.startsWith(".") || name.startsWith("/") || name.startsWith("@/")) &&
      /\.(tsx|jsx|html)$/.test(name)
    )
      return;
    add(
      node,
      `import:${name}`,
      `import is not an admitted package/path or in-class module: ${name}`,
    );
  };
  const walk = (node: TS.Node): void => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
      return;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      importFact(node);
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      add(node, "import-equals", "ESM-only classifier");
      return;
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      jsx(node);
      for (const p of node.attributes.properties) {
        if (ts.isJsxSpreadAttribute(p)) walk(p.expression);
        else if (p.initializer && ts.isJsxExpression(p.initializer) && p.initializer.expression)
          walk(p.initializer.expression);
      }
      return;
    }
    if (ts.isJsxClosingElement(node) || ts.isJsxText(node)) return;
    if (ts.isJsxElement(node)) {
      const native = nativeTag(node.openingElement.tagName);
      const tag = node.openingElement.tagName.getText(sf);
      if (!native)
        for (const child of node.children) {
          if (ts.isJsxText(child) && child.text.trim()) {
            const text = decodeChildText(child);
            if (text === undefined)
              add(child, "child-decode", "JSX text emitter diagnostic", "item-9");
            else {
              const hit = classifyLiteralUrlValue(text, "item-3", ctx.admittedOrigins);
              if (hit) add(child, hit.id, hit.detail, hit.rule);
            }
          } else if (ts.isJsxExpression(child) && child.expression)
            urlValue(child.expression, "child", false);
        }
      if (tag === "style" || tag === "script") {
        let body = "";
        let complete = true;
        for (const child of node.children)
          if (ts.isJsxText(child)) {
            const text = decodeChildText(child);
            if (text === undefined) complete = false;
            else body += text;
          } else if (ts.isJsxExpression(child) && child.expression) {
            const v = staticValue(child.expression);
            if (v.known) body += String(v.value);
            else complete = false;
          } else if (!ts.isJsxExpression(child)) complete = false;
        if (!complete) add(node, `${tag}-unresolved`, `unresolved ${tag} body`, "item-4");
        if (tag === "style") {
          facts.push(...classifyCssEffects(body, "style-element"));
        }
        if (tag === "script" && body.trim()) {
          const r = analyze("script.tsx", body, ctx);
          if (r.ok) facts.push(...r.facts);
          else add(node, "script-parse", r.detail, "item-9");
        }
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const p = resolve(node.expression);
      if (p.kind === "parameter")
        add(node, "unresolved-call", "invocation of a supplied callable is not value forwarding");
      else if (p.kind === "global" && p.name === "fetch" && p.members.length === 0) fetchCall(node);
      else if (p.kind === "global" && (p.name === "XMLHttpRequest" || p.name === "WebSocket"))
        add(node, "js-network:open", "network constructor acquisition");
      else if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        add(node, "dynamic-import", "dynamic import refuses");
      else reference(node.expression);
    }
    if (ts.isTaggedTemplateExpression(node) && resolve(node.tag).kind === "parameter")
      add(node, "unresolved-call", "invocation of a supplied tag is not value forwarding");
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      reference(node);
      if (ts.isElementAccessExpression(node)) walk(node.argumentExpression);
      // Base expressions still execute (including calls and computed indices).
      if (!ts.isIdentifier(node.expression)) walk(node.expression);
      return;
    }
    if (ts.isIdentifier(node)) {
      const p = node.parent;
      const declarationName =
        "name" in p && p.name === node && !ts.isShorthandPropertyAssignment(p);
      if (
        !declarationName &&
        !ts.isBindingElement(p) &&
        !ts.isJsxAttribute(p) &&
        !ts.isJsxNamespacedName(p) &&
        !ts.isLabeledStatement(p) &&
        !ts.isBreakStatement(p) &&
        !ts.isContinueStatement(p)
      )
        reference(node);
      return;
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword)
      add(node, "host-this", "unclassified this/super provenance");
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
    ) {
      if (resolve(node.left.expression).kind !== "local")
        add(node, "mutation-provenance", "assignment to an unresolved receiver");
    }
    // Parameter defaults are supplying edges, including destructuring defaults.
    if ((ts.isParameter(node) || ts.isBindingElement(node)) && node.initializer)
      urlValue(node.initializer, "parameter-default", false);
    ts.forEachChild(node, walk);
  };
  scanEscape(sf);
  walk(sf);
  return { ok: true, facts };
}
export function classifyTsxSource(path: string, source: string, ctx: JsxContext): ClassifyResult {
  return analyze(path, source, ctx);
}
export function classifyHandlerText(source: string, ctx: JsxContext): readonly AcquisitionFact[] {
  const result = analyze("handler.tsx", source, ctx);
  return result.ok
    ? result.facts
    : [{ id: `handler-parse:${source}`, rule: result.rule, detail: result.detail }];
}
