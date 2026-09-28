/**
 * In-class durable-effect acquisition under a presentation ceiling (#5080).
 *
 * Consumes the #5056 presentation-ceiling artifact. Does not mint a second store.
 * Returned failures only — no throw/reject/abort/numeric-const facts.
 */

export const PRESENTATION_CEILING_ARTIFACT_REL = ".deft/presentation-ceiling.json";
export const PRESENTATION_CEILING_SCHEMA = "deft.presentation-ceiling.v1" as const;

export const SENTINEL_BASE = "https://deft.invalid/";
export const SENTINEL_ORIGIN = "https://deft.invalid";

export const IN_CLASS_EXT = /\.(html|jsx|tsx)$/i;

export const REQUEST_CAPABLE_SCHEMES = [
  "http",
  "https",
  "ws",
  "wss",
  "ftp",
  "file",
  "data",
  "blob",
  "about",
  "javascript",
] as const;

/** Positive native inert-value exemption. Unknown/custom attributes stay conservative. */
const INERT_NATIVE_ATTRIBUTES = new Set([
  "title",
  "alt",
  "class",
  "classname",
  "id",
  "role",
  "lang",
  "dir",
  "hidden",
  "tabindex",
  "width",
  "height",
  "disabled",
  "checked",
  "selected",
  "readonly",
  "placeholder",
  "name",
  "value",
  "type",
  "for",
  "htmlfor",
  "rel",
]);
export function isInertNativeAttribute(name: string): boolean {
  return INERT_NATIVE_ATTRIBUTES.has(name) || /^aria-[a-z]+$/.test(name);
}
/** Attributes that identify an element-level acquisition. Other attributes are analyzed independently. */
export const MARKUP_CHANNEL_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  form: ["method", "action", "target", "enctype"],
  meta: ["http-equiv", "httpequiv", "content"],
  script: ["src"],
  iframe: ["src", "srcdoc"],
  embed: ["src"],
  object: ["data", "codebase"],
};
export const CSS_FETCH_FUNCTIONS = [
  "url(",
  "image-set(",
  "image(",
  "src(",
  "cross-fade(",
  "@import",
] as const;

export const META_HTTP_EQUIV_ALLOW = ["content-type", "x-ua-compatible"] as const;

export const VERIFIER_PATHS = [
  "packages/core/src/durable-effect-acquisition/",
  "packages/cli/src/verify-durable-effect-acquisition.ts",
] as const;

export const DURABLE_EFFECT_REMEDIATION =
  "DURABLE_EFFECT_ACQUISITION: under an armed presentation ceiling, rewrite the in-class " +
  ".tsx/.jsx/.html acquisition (storage, cookies, non-GET or non-sentinel network, markup " +
  "submission) to a pinned-head same-origin value, identity/member forwarding, or a merge-base " +
  "human-origin amendment on the #5056 presentation-ceiling artifact. skipped/N/A is not an exit.";

export type PresentationCeiling = {
  readonly schema: typeof PRESENTATION_CEILING_SCHEMA;
  readonly changeClass: "presentation";
  readonly admittedOrigins?: readonly string[];
  readonly admittedPackages?: readonly string[];
  readonly admittedGlobals?: readonly {
    readonly name: string;
    readonly members?: readonly string[];
  }[];
  readonly admittedPaths?: readonly string[];
  readonly humanOrigin?: boolean;
  readonly humanApproval?: {
    readonly kind: string;
    readonly actor: string;
    readonly mintedAt: string;
    readonly mintedVia?: string;
  };
};

export type AcquisitionFact = {
  readonly id: string;
  readonly rule: string;
  readonly detail: string;
};

export type ClassifyOk = {
  readonly ok: true;
  readonly facts: readonly AcquisitionFact[];
};

export type ClassifyErr = {
  readonly ok: false;
  readonly rule: string;
  readonly detail: string;
};

export type ClassifyResult = ClassifyOk | ClassifyErr;

export type OutputStream = "stdout" | "stderr" | "none";

export type EvaluateResult = {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  readonly findings?: readonly AcquisitionFact[];
};

export type CeilingLoad =
  | {
      readonly ok: true;
      readonly ceiling: PresentationCeiling | null;
      readonly rel: string | null;
      readonly records: ReadonlyMap<string, PresentationCeiling>;
    }
  | { readonly ok: false; readonly detail: string };
