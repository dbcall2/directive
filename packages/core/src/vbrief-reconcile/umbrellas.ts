import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { referenceTypeMatches } from "@deftai/directive-types";
import { hasArtifactSuffix, resolveLifecycleRoot, stripArtifactSuffix } from "../layout/resolve.js";
import { call } from "../scm/call.js";
import { extractIssueRef, parseGithubIssueUri } from "../triage/reconcile/parse-uri.js";
import type { Child, ReconcileUmbrellasOutcome, UmbrellaChange, UmbrellaClient } from "./types.js";

export const OPEN_FOLDERS = ["proposed", "pending", "active"] as const;
export const CLOSED_FOLDERS = ["completed", "cancelled"] as const;
export const LIFECYCLE_FOLDERS = [...OPEN_FOLDERS, ...CLOSED_FOLDERS] as const;
export const CHILD_REF_TYPE = "x-xbrief/plan";
const SCM_SOURCE = "github-issue";

const HEADER_RE = /^## Current shape \(as of pass-(\d+)\)/m;
// ReDoS-hardened (#1782 s4 / CodeQL js/polynomial-redos): the original
// `\s*(.*)$` let `\s*` and `.*` both match horizontal whitespace (overlapping
// repetitions). Replacing the capture with `(\S.*|)` makes `\s*`'s successor
// disjoint (starts with a non-whitespace char) while the empty alternation
// preserves the exact `""`-not-undefined capture of an all-whitespace tail.
// Captured language is byte-identical to the frozen Python oracle
// (`r"^...:\s*(.*)$"`, re.MULTILINE) for every input.
const HISTORY_RE = /^Child-count history:\s*(\S.*|)$/m;
const LAST_UPDATED_RE = /^Last updated:\s*(\S.*|)$/m;
const LAST_PASS_TYPE_RE = /^Last pass type:\s*(\S.*|)$/m;
const HISTORY_TOKEN_RE = /^\s*pass-(\d+):\s*(\d+)\s*$/;
const CHECKBOX_LINE_RE = /^(\s*[-*]\s+\[)([ xX])(\]\s+.*)$/;
const ISSUE_MENTION_RE =
  /(?:(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/|\/issues\/|#)(\d+)\b/g;

const READING_ORDER =
  "1. Read the umbrella issue body.\n" +
  "2. Read this current-shape comment.\n" +
  "3. Read the amendment comments in chronological order for the full audit trail.";

export class UmbrellaScmError extends Error {
  override name = "UmbrellaScmError";
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function storyKey(storyId: string): string {
  return `story:${storyId}`;
}

function issueKey(repo: string | null, issueNumber: number): string {
  return repo === null ? `issue:${issueNumber}` : `issue:${repo}:${issueNumber}`;
}

function addChild(index: Record<string, Child>, key: string, child: Child): void {
  if (index[key] === undefined) index[key] = child;
}

function addIssueKeys(index: Record<string, Child>, child: Child): void {
  if (child.issue_number === undefined || child.issue_number === null) return;
  addChild(index, issueKey(child.issue_repo ?? null, child.issue_number), child);
  if (child.issue_repo !== undefined && child.issue_repo !== null) {
    addChild(index, issueKey(null, child.issue_number), child);
  }
}

export function childFromData(
  data: Record<string, unknown>,
  folder: string,
  fallbackId: string,
): Child {
  const plan =
    typeof data.plan === "object" && data.plan !== null && !Array.isArray(data.plan)
      ? (data.plan as Record<string, unknown>)
      : {};
  const metadata =
    typeof plan.metadata === "object" && plan.metadata !== null && !Array.isArray(plan.metadata)
      ? (plan.metadata as Record<string, unknown>)
      : {};
  const swarm =
    typeof metadata.swarm === "object" && metadata.swarm !== null && !Array.isArray(metadata.swarm)
      ? (metadata.swarm as Record<string, unknown>)
      : {};
  const rawDeps = swarm.depends_on;
  const dependsOn = Array.isArray(rawDeps) ? rawDeps.map((d) => String(d)) : [];
  const [issueRepo, issueNumber] = extractIssueRef(data);
  return {
    story_id: String(plan.id ?? fallbackId),
    title: String(plan.title ?? plan.id ?? fallbackId),
    kind: String(metadata.kind ?? "story"),
    folder,
    depends_on: dependsOn,
    issue_repo: issueRepo,
    issue_number: issueNumber,
  };
}

export function buildChildIndex(vbriefDir: string): Record<string, Child> {
  const index: Record<string, Child> = {};
  for (const folder of LIFECYCLE_FOLDERS) {
    const folderPath = join(vbriefDir, folder);
    if (!existsSync(folderPath)) continue;
    const files = readdirSync(folderPath)
      .filter((f) => hasArtifactSuffix(f))
      .sort();
    for (const file of files) {
      const path = join(folderPath, file);
      const data = readJson(path);
      if (!data) continue;
      const fallbackId = stripArtifactSuffix(file);
      const child = childFromData(data, folder, fallbackId);
      addChild(index, file, child);
      addChild(index, storyKey(child.story_id), child);
      addIssueKeys(index, child);
    }
  }
  return index;
}

export function computeChildren(
  epicData: Record<string, unknown>,
  index: Record<string, Child>,
): Child[] {
  const plan =
    typeof epicData.plan === "object" && epicData.plan !== null && !Array.isArray(epicData.plan)
      ? (epicData.plan as Record<string, unknown>)
      : {};
  const refs = plan.references;
  const children: Child[] = [];
  const seen = new Set<string>();
  const epicStoryId = String(plan.id ?? "");

  const addResolvedChild = (child: Child | undefined): void => {
    if (!child || child.story_id === epicStoryId || seen.has(child.story_id)) return;
    seen.add(child.story_id);
    children.push(child);
  };

  const edges = plan.edges;
  if (Array.isArray(edges)) {
    for (const edge of edges) {
      if (typeof edge !== "object" || edge === null || Array.isArray(edge)) continue;
      const rec = edge as Record<string, unknown>;
      if (String(rec.type ?? "") !== "contains") continue;
      if (rec.from !== undefined && String(rec.from) !== epicStoryId) continue;
      addResolvedChild(index[storyKey(String(rec.to ?? ""))]);
    }
  }

  if (!Array.isArray(refs)) return children;
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) continue;
    const rec = ref as Record<string, unknown>;
    const refType = String(rec.type ?? "");
    if (referenceTypeMatches(refType, "plan")) {
      addResolvedChild(index[basename(String(rec.uri ?? ""))]);
      continue;
    }
    if (referenceTypeMatches(refType, "github-issue")) {
      const [repo, number] = parseGithubIssueUri(rec.uri);
      if (number === null) continue;
      addResolvedChild(index[issueKey(repo, number)] ?? index[issueKey(null, number)]);
    }
  }
  return children;
}

export function computeWaves(children: readonly Child[]): string[][] {
  const ids = new Set(children.map((c) => c.story_id));
  const deps: Record<string, string[]> = {};
  for (const c of children) {
    deps[c.story_id] = c.depends_on.filter((d) => ids.has(d));
  }
  const resolved = new Set<string>();
  const remaining = new Set(ids);
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const layer = [...remaining]
      .filter((r) => (deps[r] ?? []).every((d) => resolved.has(d)))
      .sort();
    if (layer.length === 0) {
      waves.push([...remaining].sort());
      break;
    }
    waves.push(layer);
    for (const id of layer) {
      resolved.add(id);
      remaining.delete(id);
    }
  }
  return waves;
}

function bulletBlock(lines: readonly string[]): string {
  return lines.length > 0 ? lines.join("\n") : "- none";
}

export function renderBody(options: {
  passN: number;
  lastPassType: string;
  lastUpdated: string;
  openChildren: readonly Child[];
  closedChildren: readonly Child[];
  waves: readonly (readonly string[])[];
  history: readonly (readonly [number, number])[];
}): string {
  const total = options.openChildren.length + options.closedChildren.length;
  const historyStr = options.history.map(([n, count]) => `pass-${n}: ${count}`).join(", ");
  const openLines = options.openChildren.map((c) => `- ${c.story_id}: ${c.title} (${c.kind})`);
  const closedLines = options.closedChildren.map(
    (c) => `- ${c.story_id}: ${c.title} (${c.folder})`,
  );
  const waveLines = options.waves.map((layer, i) => `- Wave ${i + 1}: ${layer.join(", ")}`);
  return (
    `## Current shape (as of pass-${options.passN})\n` +
    "\n" +
    `Last updated: ${options.lastUpdated}\n` +
    `Last pass type: ${options.lastPassType}\n` +
    `Child count: ${total} (${options.openChildren.length}/${options.closedChildren.length})\n` +
    `Child-count history: ${historyStr}\n` +
    "\n" +
    "### Open children\n" +
    "\n" +
    `${bulletBlock(openLines)}\n` +
    "\n" +
    "### Closed children\n" +
    "\n" +
    `${bulletBlock(closedLines)}\n` +
    "\n" +
    "### Wave order\n" +
    "\n" +
    `${bulletBlock(waveLines)}\n` +
    "\n" +
    "### Open questions\n" +
    "\n" +
    "- none\n" +
    "\n" +
    "### Reading order for fresh contributors\n" +
    "\n" +
    READING_ORDER
  );
}

export interface ParsedShape {
  passN: number | null;
  history: Array<[number, number]>;
  lastUpdated: string | null;
  lastPassType: string | null;
}

function parseHistory(raw: string): Array<[number, number]> {
  const history: Array<[number, number]> = [];
  for (const token of raw.split(",")) {
    const match = HISTORY_TOKEN_RE.exec(token);
    if (match?.[1] && match[2]) history.push([Number(match[1]), Number(match[2])]);
  }
  return history;
}

export function parseCurrentShape(body: string): ParsedShape {
  const header = HEADER_RE.exec(body);
  if (!header?.[1]) return { passN: null, history: [], lastUpdated: null, lastPassType: null };
  const historyMatch = HISTORY_RE.exec(body);
  const updatedMatch = LAST_UPDATED_RE.exec(body);
  const passTypeMatch = LAST_PASS_TYPE_RE.exec(body);
  return {
    passN: Number(header[1]),
    history: historyMatch?.[1] ? parseHistory(historyMatch[1]) : [],
    lastUpdated: updatedMatch?.[1]?.trim() ?? null,
    lastPassType: passTypeMatch?.[1]?.trim() ?? null,
  };
}

export function classifyPassType(prevTotal: number | null, total: number): string {
  if (prevTotal === null) return "refactor";
  if (total > prevTotal) return "additive";
  if (total < prevTotal) return "subtractive";
  return "refactor";
}

function hasCurrentShape(body: string): boolean {
  return HEADER_RE.test(body);
}

export class ScmUmbrellaClient implements UmbrellaClient {
  fetchIssue(repo: string, issueNumber: number): { state: string; body: string } | null {
    const proc = call(SCM_SOURCE, "api", [`repos/${repo}/issues/${issueNumber}`]);
    if (proc.returncode !== 0) {
      throw new UmbrellaScmError(
        `fetch issue #${issueNumber} (${repo}) failed: ${(proc.stderr || "").trim()}`,
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(proc.stdout || "{}");
    } catch (exc) {
      throw new UmbrellaScmError(
        `fetch issue #${issueNumber} (${repo}) returned non-JSON: ${String(exc)}`,
      );
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const rec = data as Record<string, unknown>;
    return {
      state: typeof rec.state === "string" ? rec.state.toLowerCase() : "open",
      body: typeof rec.body === "string" ? rec.body : "",
    };
  }

  fetchComments(repo: string, issueNumber: number): Array<{ id: number; body: string }> {
    const proc = call(SCM_SOURCE, "api", [
      `repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
    ]);
    if (proc.returncode !== 0) {
      throw new UmbrellaScmError(
        `list comments #${issueNumber} (${repo}) failed: ${(proc.stderr || "").trim()}`,
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(proc.stdout || "[]");
    } catch (exc) {
      throw new UmbrellaScmError(
        `list comments #${issueNumber} (${repo}) returned non-JSON: ${String(exc)}`,
      );
    }
    if (!Array.isArray(data)) return [];
    const comments: Array<{ id: number; body: string }> = [];
    for (const entry of data) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>).id === "number" &&
        typeof (entry as Record<string, unknown>).body === "string"
      ) {
        const rec = entry as Record<string, unknown>;
        comments.push({ id: rec.id as number, body: rec.body as string });
      }
    }
    return comments;
  }

  editIssueBody(repo: string, issueNumber: number, body: string): void {
    const proc = call(
      SCM_SOURCE,
      "api",
      ["-X", "PATCH", `repos/${repo}/issues/${issueNumber}`, "--input", "-"],
      { input: JSON.stringify({ body }) },
    );
    if (proc.returncode !== 0) {
      throw new UmbrellaScmError(
        `edit issue #${issueNumber} (${repo}) body failed: ${(proc.stderr || "").trim()}`,
      );
    }
  }

  editComment(repo: string, commentId: number, body: string): void {
    const proc = call(
      SCM_SOURCE,
      "api",
      ["-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "--input", "-"],
      { input: JSON.stringify({ body }) },
    );
    if (proc.returncode !== 0) {
      throw new UmbrellaScmError(
        `edit comment ${commentId} (${repo}) failed: ${(proc.stderr || "").trim()}`,
      );
    }
  }

  createComment(repo: string, issueNumber: number, body: string): number | null {
    const proc = call(
      SCM_SOURCE,
      "api",
      ["-X", "POST", `repos/${repo}/issues/${issueNumber}/comments`, "--input", "-"],
      { input: JSON.stringify({ body }) },
    );
    if (proc.returncode !== 0) {
      throw new UmbrellaScmError(
        `create comment #${issueNumber} (${repo}) failed: ${(proc.stderr || "").trim()}`,
      );
    }
    try {
      const data = JSON.parse(proc.stdout || "{}") as Record<string, unknown>;
      return typeof data.id === "number" ? data.id : null;
    } catch {
      return null;
    }
  }
}

type ChildOpenClosedState = "open" | "closed";

function fetchIssueCached(
  client: UmbrellaClient,
  repo: string,
  issueNumber: number,
  cache: Map<string, { readonly state: string; readonly body: string } | null>,
): { readonly state: string; readonly body: string } | null {
  if (client.fetchIssue === undefined) return null;
  const key = `${repo}:${issueNumber}`;
  if (!cache.has(key)) cache.set(key, client.fetchIssue(repo, issueNumber));
  return cache.get(key) ?? null;
}

function childIssueRepo(child: Child, fallbackRepo: string): string {
  return child.issue_repo ?? fallbackRepo;
}

function childIssueKey(repo: string, issueNumber: number): string {
  return `${repo}:${issueNumber}`;
}

function childOpenClosedState(
  child: Child,
  fallbackRepo: string,
  client: UmbrellaClient,
  issueCache: Map<string, { readonly state: string; readonly body: string } | null>,
): ChildOpenClosedState {
  if (child.issue_number !== undefined && child.issue_number !== null) {
    const issue = fetchIssueCached(
      client,
      childIssueRepo(child, fallbackRepo),
      child.issue_number,
      issueCache,
    );
    if (issue !== null) return issue.state.toLowerCase() === "closed" ? "closed" : "open";
  }
  return (OPEN_FOLDERS as readonly string[]).includes(child.folder) ? "open" : "closed";
}

function findChecklistIssueState(
  text: string,
  fallbackRepo: string,
  childIssueStates: ReadonlyMap<string, ChildOpenClosedState>,
): ChildOpenClosedState | undefined {
  for (const match of text.matchAll(ISSUE_MENTION_RE)) {
    const rawNumber = match[2];
    if (rawNumber === undefined) continue;
    const repo = match[1] ?? fallbackRepo;
    const state = childIssueStates.get(childIssueKey(repo, Number(rawNumber)));
    if (state !== undefined) return state;
  }
  return undefined;
}

function reconcileChecklistBody(
  body: string,
  repo: string,
  childIssueStates: ReadonlyMap<string, ChildOpenClosedState>,
): { readonly changed: boolean; readonly body: string } {
  let changed = false;
  const lines = body.split("\n").map((rawLine) => {
    const cr = rawLine.endsWith("\r") ? "\r" : "";
    const line = cr ? rawLine.slice(0, -1) : rawLine;
    const checkbox = CHECKBOX_LINE_RE.exec(line);
    if (!checkbox?.[1] || !checkbox[2] || !checkbox[3]) return rawLine;
    const state = findChecklistIssueState(checkbox[3], repo, childIssueStates);
    if (state === undefined) return rawLine;
    const desiredMark = state === "closed" ? "x" : " ";
    if (checkbox[2] === desiredMark) return rawLine;
    changed = true;
    return `${checkbox[1]}${desiredMark}${checkbox[3]}${cr}`;
  });
  return { changed, body: lines.join("\n") };
}

function reconcileUmbrellaIssueChecklist(options: {
  repo: string;
  issueNumber: number;
  client: UmbrellaClient;
  dryRun: boolean;
  childIssueStates: ReadonlyMap<string, ChildOpenClosedState>;
  issueCache: Map<string, { readonly state: string; readonly body: string } | null>;
}): { readonly action: "edited" | "unchanged" | "skipped"; readonly body: string | null } {
  if (
    options.client.fetchIssue === undefined ||
    options.client.editIssueBody === undefined ||
    options.childIssueStates.size === 0
  ) {
    return { action: "skipped", body: null };
  }
  const issue = fetchIssueCached(
    options.client,
    options.repo,
    options.issueNumber,
    options.issueCache,
  );
  if (issue === null) return { action: "skipped", body: null };
  const next = reconcileChecklistBody(issue.body, options.repo, options.childIssueStates);
  if (!next.changed) return { action: "unchanged", body: issue.body };
  if (!options.dryRun) options.client.editIssueBody(options.repo, options.issueNumber, next.body);
  return { action: "edited", body: next.body };
}

function planShape(
  epicData: Record<string, unknown>,
  index: Record<string, Child>,
  options: { repo: string; client: UmbrellaClient },
): [Child[], Child[], string[][], Map<string, ChildOpenClosedState>] {
  const children = computeChildren(epicData, index);
  const issueCache = new Map<string, { readonly state: string; readonly body: string } | null>();
  const childIssueStates = new Map<string, ChildOpenClosedState>();
  const openChildren: Child[] = [];
  const closedChildren: Child[] = [];
  for (const child of children) {
    const state = childOpenClosedState(child, options.repo, options.client, issueCache);
    if (child.issue_number !== undefined && child.issue_number !== null) {
      childIssueStates.set(
        childIssueKey(childIssueRepo(child, options.repo), child.issue_number),
        state,
      );
    }
    if (state === "closed") closedChildren.push(child);
    else openChildren.push(child);
  }
  openChildren.sort((a, b) => a.story_id.localeCompare(b.story_id));
  closedChildren.sort((a, b) => a.story_id.localeCompare(b.story_id));
  const waves = computeWaves(children);
  return [openChildren, closedChildren, waves, childIssueStates];
}

function reconcileOneEpic(
  epicData: Record<string, unknown>,
  index: Record<string, Child>,
  options: {
    storyId: string;
    repo: string;
    number: number;
    client: UmbrellaClient;
    dryRun: boolean;
    now: string;
  },
): UmbrellaChange {
  const [openChildren, closedChildren, waves, childIssueStates] = planShape(epicData, index, {
    repo: options.repo,
    client: options.client,
  });
  const total = openChildren.length + closedChildren.length;
  const checklist = reconcileUmbrellaIssueChecklist({
    repo: options.repo,
    issueNumber: options.number,
    client: options.client,
    dryRun: options.dryRun,
    childIssueStates,
    issueCache: new Map<string, { readonly state: string; readonly body: string } | null>(),
  });

  const comments = options.client.fetchComments(options.repo, options.number);
  const existing = comments.find((c) => hasCurrentShape(c.body));

  if (!existing) {
    const body = renderBody({
      passN: 1,
      lastPassType: "additive",
      lastUpdated: options.now,
      openChildren,
      closedChildren,
      waves,
      history: [[1, total]],
    });
    if (!options.dryRun) options.client.createComment(options.repo, options.number, body);
    return {
      story_id: options.storyId,
      repo: options.repo,
      issue_number: options.number,
      action: "created",
      checklist_action: checklist.action,
      pass_n: 1,
      body,
    };
  }

  const parsed = parseCurrentShape(existing.body);
  const prevPass = parsed.passN ?? 1;
  const prevTotal =
    parsed.history.length > 0 ? (parsed.history[parsed.history.length - 1]?.[1] ?? null) : null;

  const candidate = renderBody({
    passN: prevPass,
    lastPassType: parsed.lastPassType ?? "refactor",
    lastUpdated: parsed.lastUpdated ?? options.now,
    openChildren,
    closedChildren,
    waves,
    history: parsed.history.length > 0 ? parsed.history : [[prevPass, total]],
  });

  if (candidate === existing.body) {
    return {
      story_id: options.storyId,
      repo: options.repo,
      issue_number: options.number,
      action: "unchanged",
      checklist_action: checklist.action,
      pass_n: prevPass,
      body: candidate,
    };
  }

  const passN = prevPass + 1;
  const body = renderBody({
    passN,
    lastPassType: classifyPassType(prevTotal, total),
    lastUpdated: options.now,
    openChildren,
    closedChildren,
    waves,
    history: [...parsed.history, [passN, total]],
  });
  if (!options.dryRun) options.client.editComment(options.repo, existing.id, body);
  return {
    story_id: options.storyId,
    repo: options.repo,
    issue_number: options.number,
    action: "edited",
    checklist_action: checklist.action,
    pass_n: passN,
    body,
  };
}

export function nowIso(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface ReconcileUmbrellasOptions {
  readonly repo?: string | null;
  readonly dryRun?: boolean;
  readonly client?: UmbrellaClient;
  readonly now?: string;
}

export function reconcileUmbrellas(
  projectRoot: string,
  options: ReconcileUmbrellasOptions = {},
): [number, ReconcileUmbrellasOutcome] {
  const root = resolve(projectRoot);
  let vbriefDir: string;
  try {
    vbriefDir = resolveLifecycleRoot(root);
  } catch {
    return [
      2,
      {
        changed: [],
        unchanged: [],
        skipped_no_ref: [],
        errors: [],
        dry_run: options.dryRun ?? false,
      },
    ];
  }
  if (!existsSync(vbriefDir)) {
    return [
      2,
      {
        changed: [],
        unchanged: [],
        skipped_no_ref: [],
        errors: [],
        dry_run: options.dryRun ?? false,
      },
    ];
  }

  const client = options.client ?? new ScmUmbrellaClient();
  const now = options.now ?? nowIso();
  const index = buildChildIndex(vbriefDir);
  const outcome: ReconcileUmbrellasOutcome = {
    changed: [],
    unchanged: [],
    skipped_no_ref: [],
    errors: [],
    dry_run: options.dryRun ?? false,
  };
  const seenIssues = new Set<string>();

  for (const folder of LIFECYCLE_FOLDERS) {
    const folderPath = join(vbriefDir, folder);
    if (!existsSync(folderPath)) continue;
    const files = readdirSync(folderPath)
      .filter((f) => hasArtifactSuffix(f))
      .sort();
    for (const file of files) {
      const path = join(folderPath, file);
      const data = readJson(path);
      if (!data) continue;
      const plan =
        typeof data.plan === "object" && data.plan !== null && !Array.isArray(data.plan)
          ? (data.plan as Record<string, unknown>)
          : {};
      const metadata =
        typeof plan.metadata === "object" && plan.metadata !== null && !Array.isArray(plan.metadata)
          ? (plan.metadata as Record<string, unknown>)
          : {};
      if (metadata.kind !== "epic") continue;
      const storyId = String(plan.id ?? stripArtifactSuffix(file));

      const [refRepo, number] = extractIssueRef(data);
      const effectiveRepo = refRepo ?? options.repo ?? null;
      if (number === null || effectiveRepo === null) {
        outcome.skipped_no_ref.push(storyId);
        continue;
      }
      const key = `${effectiveRepo}:${number}`;
      if (seenIssues.has(key)) continue;
      seenIssues.add(key);

      try {
        const change = reconcileOneEpic(data, index, {
          storyId,
          repo: effectiveRepo,
          number,
          client,
          dryRun: options.dryRun ?? false,
          now,
        });
        if (change.action === "unchanged" && change.checklist_action !== "edited") {
          outcome.unchanged.push(change);
        } else {
          outcome.changed.push(change);
        }
      } catch (exc) {
        outcome.errors.push({ story_id: storyId, message: String(exc) });
      }
    }
  }

  return [outcome.errors.length > 0 ? 1 : 0, outcome];
}

export function renderUmbrellasReport(outcome: ReconcileUmbrellasOutcome): string {
  const lines: string[] = ["vBRIEF reconcile umbrellas", ""];
  const suffix = outcome.dry_run ? " (dry-run)" : "";
  const inline = (value: string | number): string => String(value).replace(/[\r\n]+/g, " ");

  lines.push(`Changed${suffix}:`);
  if (outcome.changed.length > 0) {
    for (const c of outcome.changed) {
      const checklist =
        c.checklist_action !== undefined && c.checklist_action !== "skipped"
          ? `, checklist ${inline(c.checklist_action)}`
          : "";
      lines.push(
        `- #${inline(c.issue_number)} (${inline(c.repo)}) [${inline(c.story_id)}]: ${inline(c.action)}${checklist} -> pass-${inline(c.pass_n)}`,
      );
    }
  } else {
    lines.push("- none");
  }
  lines.push("");

  lines.push("Unchanged:");
  if (outcome.unchanged.length > 0) {
    for (const c of outcome.unchanged) {
      const checklist =
        c.checklist_action !== undefined && c.checklist_action !== "skipped"
          ? `, checklist ${inline(c.checklist_action)}`
          : "";
      lines.push(
        `- #${inline(c.issue_number)} (${inline(c.repo)}) [${inline(c.story_id)}]: pass-${inline(c.pass_n)}${checklist}`,
      );
    }
  } else {
    lines.push("- none");
  }

  if (outcome.skipped_no_ref.length > 0) {
    lines.push("");
    lines.push("Skipped (no github-issue reference / repo):");
    for (const sid of outcome.skipped_no_ref) lines.push(`- ${inline(sid)}`);
  }

  if (outcome.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const err of outcome.errors)
      lines.push(`- ${inline(err.story_id)}: ${inline(err.message)}`);
  }

  return lines.join("\n");
}

export function umbrellasOutcomeToJson(
  outcome: ReconcileUmbrellasOutcome,
): Record<string, unknown> {
  const toChange = (c: UmbrellaChange) => ({
    story_id: c.story_id,
    repo: c.repo,
    issue_number: c.issue_number,
    action: c.action,
    checklist_action: c.checklist_action,
    pass_n: c.pass_n,
  });
  return {
    changed: outcome.changed.map(toChange),
    unchanged: outcome.unchanged.map(toChange),
    skipped_no_ref: [...outcome.skipped_no_ref],
    errors: outcome.errors.map((e) => ({ story_id: e.story_id, message: e.message })),
    dry_run: outcome.dry_run,
  };
}
