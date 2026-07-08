import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { referenceTypeMatches } from "@deftai/directive-types";
import { CACHE_DIR_NAME, CACHE_SOURCE_GITHUB_ISSUE } from "../triage/queue/constants.js";
import { parseGithubIssueUri } from "../triage/reconcile/parse-uri.js";
import { collectChildUris, collectPlanRefs, resolveVbriefRef } from "./vbrief-ref.js";

interface IssueRef {
  readonly repo: string | null;
  readonly number: number;
}

interface CachedIssuePayload {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly labels: readonly string[];
  readonly body: string;
}

export interface ScopeCompleteUmbrellaWarningOptions {
  readonly projectRoot: string;
  readonly vbriefRoot: string;
  readonly oldPath: string;
  readonly newPath: string;
  readonly scopeData: Record<string, unknown>;
}

function asPlan(data: Record<string, unknown>): Record<string, unknown> | null {
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return null;
  }
  return plan as Record<string, unknown>;
}

function issueRefsFromPlan(plan: Record<string, unknown>): IssueRef[] {
  const refs = plan.references;
  if (!Array.isArray(refs)) {
    return [];
  }
  const out: IssueRef[] = [];
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      continue;
    }
    const rec = ref as Record<string, unknown>;
    if (!referenceTypeMatches(String(rec.type ?? ""), "github-issue")) {
      continue;
    }
    const [repo, number] = parseGithubIssueUri(rec.uri);
    if (number !== null) {
      out.push({ repo, number });
    }
  }
  return out;
}

function issueKey(ref: IssueRef): string {
  return `${ref.repo ?? ""}#${ref.number}`;
}

function planReferencesMovedScope(
  plan: Record<string, unknown>,
  oldPath: string,
  newPath: string,
  vbriefRoot: string,
): boolean {
  const oldResolved = resolve(oldPath);
  const newResolved = resolve(newPath);
  const refs = [...collectPlanRefs(plan), ...collectChildUris(plan)];
  for (const ref of refs) {
    const resolved = resolveVbriefRef(ref, vbriefRoot);
    if (resolved === null) {
      continue;
    }
    const normalized = resolve(resolved);
    if (normalized === oldResolved || normalized === newResolved) {
      return true;
    }
  }
  return false;
}

function planReferencesCompletedIssue(
  plan: Record<string, unknown>,
  completedRefs: readonly IssueRef[],
): boolean {
  const completedKeys = new Set(completedRefs.map(issueKey));
  const completedNumbers = new Set(completedRefs.map((ref) => ref.number));
  for (const ref of issueRefsFromPlan(plan)) {
    if (completedKeys.has(issueKey(ref))) {
      return true;
    }
    if (ref.repo === null && completedNumbers.has(ref.number)) {
      return true;
    }
  }
  return false;
}

function cachedIssuePath(projectRoot: string, repo: string, issueNumber: number): string {
  const [owner, name] = repo.split("/", 2);
  return join(
    projectRoot,
    CACHE_DIR_NAME,
    CACHE_SOURCE_GITHUB_ISSUE,
    owner ?? "",
    name ?? "",
    String(issueNumber),
    "raw.json",
  );
}

function labelsFromRaw(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const label of raw) {
    if (typeof label === "string") {
      out.push(label);
    } else if (typeof label === "object" && label !== null) {
      const name = (label as Record<string, unknown>).name;
      if (typeof name === "string") {
        out.push(name);
      }
    }
  }
  return out;
}

function readCachedIssue(
  projectRoot: string,
  repo: string | null,
  issueNumber: number,
): CachedIssuePayload | null {
  if (repo === null || !repo.includes("/")) {
    return null;
  }
  const rawPath = cachedIssuePath(projectRoot, repo, issueNumber);
  if (!existsSync(rawPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(rawPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const issue = parsed as Record<string, unknown>;
    const number = typeof issue.number === "number" ? issue.number : issueNumber;
    return {
      number,
      title: typeof issue.title === "string" ? issue.title : "",
      state: typeof issue.state === "string" ? issue.state.toLowerCase() : "open",
      labels: labelsFromRaw(issue.labels),
      body: typeof issue.body === "string" ? issue.body : "",
    };
  } catch {
    return null;
  }
}

function isOpenUmbrella(issue: CachedIssuePayload | null): issue is CachedIssuePayload {
  if (issue === null || issue.state !== "open") {
    return false;
  }
  const labels = issue.labels.map((label) => label.toLowerCase());
  if (labels.some((label) => ["epic", "meta", "tracker", "umbrella"].includes(label))) {
    return true;
  }
  return /\b(umbrella|tracker)\b/i.test(issue.title);
}

function bodyMentionsIssue(body: string, issueNumber: number): boolean {
  const escaped = String(issueNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`(^|[^0-9])#${escaped}\\b`).test(body) ||
    new RegExp(`/issues/${escaped}(\\b|/)`).test(body)
  );
}

function readLifecycleScopeFiles(vbriefRoot: string): string[] {
  const out: string[] = [];
  for (const folder of ["proposed", "pending", "active"]) {
    const dir = join(vbriefRoot, folder);
    if (!existsSync(dir)) {
      continue;
    }
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".xbrief.json") || name.endsWith(".vbrief.json")) {
        out.push(join(dir, name));
      }
    }
  }
  return out;
}

function addOpenUmbrella(
  out: Map<number, CachedIssuePayload>,
  issue: CachedIssuePayload | null,
): void {
  if (isOpenUmbrella(issue)) {
    out.set(issue.number, issue);
  }
}

function scanLocalScopeReferences(
  options: ScopeCompleteUmbrellaWarningOptions,
  completedRefs: readonly IssueRef[],
  umbrellas: Map<number, CachedIssuePayload>,
): void {
  const completedKeys = new Set(completedRefs.map(issueKey));
  for (const file of readLifecycleScopeFiles(options.vbriefRoot)) {
    if (resolve(file) === resolve(options.newPath)) {
      continue;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const plan = asPlan(data);
    if (plan === null) {
      continue;
    }
    const referencesScope =
      planReferencesMovedScope(plan, options.oldPath, options.newPath, options.vbriefRoot) ||
      planReferencesCompletedIssue(plan, completedRefs);
    if (!referencesScope) {
      continue;
    }
    const ownRefs = issueRefsFromPlan(plan).filter((ref) => !completedKeys.has(issueKey(ref)));
    for (const ref of ownRefs) {
      const repo =
        ref.repo ?? completedRefs.find((completed) => completed.repo !== null)?.repo ?? null;
      addOpenUmbrella(umbrellas, readCachedIssue(options.projectRoot, repo, ref.number));
    }
  }
}

function scanCachedUmbrellaBodies(
  options: ScopeCompleteUmbrellaWarningOptions,
  completedRefs: readonly IssueRef[],
  umbrellas: Map<number, CachedIssuePayload>,
): void {
  const repos = new Set(
    completedRefs.map((ref) => ref.repo).filter((repo): repo is string => repo !== null),
  );
  for (const repo of repos) {
    const [owner, name] = repo.split("/", 2);
    const repoDir = join(
      options.projectRoot,
      CACHE_DIR_NAME,
      CACHE_SOURCE_GITHUB_ISSUE,
      owner ?? "",
      name ?? "",
    );
    if (!existsSync(repoDir)) {
      continue;
    }
    for (const entry of readdirSync(repoDir)) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      const issue = readCachedIssue(options.projectRoot, repo, Number(entry));
      if (!isOpenUmbrella(issue)) {
        continue;
      }
      if (completedRefs.some((ref) => bodyMentionsIssue(issue.body, ref.number))) {
        umbrellas.set(issue.number, issue);
      }
    }
  }
}

export function scopeCompleteUmbrellaWarnings(
  options: ScopeCompleteUmbrellaWarningOptions,
): string[] {
  try {
    const plan = asPlan(options.scopeData);
    if (plan === null) {
      return [];
    }
    const completedRefs = issueRefsFromPlan(plan);
    const umbrellas = new Map<number, CachedIssuePayload>();
    scanLocalScopeReferences(options, completedRefs, umbrellas);
    scanCachedUmbrellaBodies(options, completedRefs, umbrellas);
    return [...umbrellas.values()]
      .sort((a, b) => a.number - b.number)
      .map(
        (issue) =>
          `Warning: scope completed but referenced by OPEN umbrella #${issue.number} -- run task vbrief:reconcile:umbrellas`,
      );
  } catch {
    return [];
  }
}
