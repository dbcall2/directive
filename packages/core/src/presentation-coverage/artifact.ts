/** Strict reader of #5056's singular file and xBRIEF changeClass forms.
 * No plural store or alternative amendment vocabulary. Invalid discovered
 * authority is a configuration error, including malformed optional fields.
 */
import { isHumanApprovalStamp } from "../scope-provenance/digest.js";
import { isCeilingArtifactRel, isRecord } from "./paths.js";
import {
  type LoadedArtifact,
  PRESENTATION_CEILING_PLAN_KEY,
  PRESENTATION_CEILING_SCHEMA,
  type PresentationCeilingArtifact,
} from "./types.js";

function humanStamp(raw: unknown): boolean {
  if (
    !isRecord(raw) ||
    typeof raw.kind !== "string" ||
    typeof raw.actor !== "string" ||
    typeof raw.mintedAt !== "string"
  )
    return false;
  return isHumanApprovalStamp({
    kind: raw.kind,
    actor: raw.actor,
    mintedAt: raw.mintedAt,
    mintedVia: typeof raw.mintedVia === "string" ? raw.mintedVia : undefined,
  });
}
function strings(raw: unknown, label: string): string[] | { error: string } {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || x.trim().length === 0))
    return { error: `${label} must be an array of nonempty strings` };
  return [...new Set((raw as string[]).map((s) => s.trim()))];
}
function extensions(raw: unknown, label: string): string[] | { error: string } {
  const arr = strings(raw, label);
  if (!Array.isArray(arr)) return arr;
  if (arr.some((s) => !/^\.?[a-zA-Z0-9]+$/.test(s)))
    return { error: `${label} must contain extension tokens, not paths/globs` };
  return arr.map((s) => (s.startsWith(".") ? s : `.${s}`).toLowerCase());
}
export function parseArtifactText(
  text: string,
  rel: string,
): { artifact: PresentationCeilingArtifact | null } | { error: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { error: `${rel}: invalid JSON` };
  }
  if (!isRecord(payload)) return { error: `${rel}: expected JSON object` };
  let raw: unknown = payload;
  if (rel.endsWith(".xbrief.json") && payload.changeClass !== "presentation") {
    if (!isRecord(payload.plan)) return { error: `${rel}: invalid plan` };
    const plan = payload.plan;
    raw =
      plan[PRESENTATION_CEILING_PLAN_KEY] ??
      (isRecord(plan.metadata) ? plan.metadata[PRESENTATION_CEILING_PLAN_KEY] : undefined);
    if (raw === undefined) return { artifact: null };
    if (typeof raw === "string") raw = { changeClass: raw };
  }
  if (!isRecord(raw)) return { error: `${rel}: invalid changeClass record` };
  if (raw.changeClass !== "presentation") {
    // Other declared classes are not presentation restrictions; a transition
    // from a base presentation record is still detected as removal.
    if (typeof raw.changeClass === "string" && raw.changeClass.length > 0)
      return { artifact: null };
    return { error: `${rel}: changeClass must be declared` };
  }
  if (raw.schema !== undefined && raw.schema !== PRESENTATION_CEILING_SCHEMA)
    return { error: `${rel}: unsupported schema` };
  if (raw.extraExtensions !== undefined)
    return { error: `${rel}: use supplier extensionAmendment with humanApproval` };
  const allowed = extensions(raw.allowedExtensions ?? raw.allowlist, "allowedExtensions");
  if (!Array.isArray(allowed)) return allowed;
  const roots = strings(raw.componentRoots, "componentRoots");
  if (!Array.isArray(roots)) return roots;
  if (roots.some((r) => r.startsWith("/") || r.split("/").includes("..") || r.includes("\\")))
    return { error: `${rel}: componentRoots must be repository relative` };
  let amendment: PresentationCeilingArtifact["extensionAmendment"] = null;
  if (raw.extensionAmendment !== undefined && raw.extensionAmendment !== null) {
    if (!isRecord(raw.extensionAmendment)) return { error: `${rel}: invalid extensionAmendment` };
    const ext = extensions(raw.extensionAmendment.extensions, "extensionAmendment.extensions");
    if (!Array.isArray(ext)) return ext;
    if (!humanStamp(raw.extensionAmendment.humanApproval))
      return { error: `${rel}: extensionAmendment requires a humanApproval stamp` };
    amendment = { extensions: ext, humanApproval: raw.extensionAmendment.humanApproval };
  }
  const removalStamp = raw.removalStamp ?? raw.humanApproval ?? null;
  if (removalStamp !== null && !humanStamp(removalStamp))
    return { error: `${rel}: invalid removal stamp` };
  return {
    artifact: {
      hasExtensionRestriction: raw.allowedExtensions !== undefined || raw.allowlist !== undefined,
      allowedExtensions: allowed,
      componentRoots: roots,
      extensionAmendment: amendment,
      removalStamp,
    },
  };
}
export function loadArtifactsFromTexts(
  texts: ReadonlyMap<string, string>,
): { loaded: LoadedArtifact[] } | { error: string } {
  const loaded: LoadedArtifact[] = [];
  for (const [rel, text] of texts) {
    if (!isCeilingArtifactRel(rel)) continue;
    const p = parseArtifactText(text, rel);
    if ("error" in p) return p;
    if (p.artifact !== null) loaded.push({ rel, artifact: p.artifact });
  }
  return { loaded };
}
