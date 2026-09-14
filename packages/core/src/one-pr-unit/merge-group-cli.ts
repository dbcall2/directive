import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
/**
 * merge_group.checks_requested entry. Check-runs are a projection, not the store.
 * Live App + org ruleset app-restriction + merge queue enablement remain deploy gaps.
 */

import { defaultRunGh } from "../pr-closing-keywords/gh.js";
import { fetchClosingIssuesReferences } from "../pr-protected-issues/gh.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import type { OnePrUnitAppStore } from "./app-store.js";
import {
  type ConstituentPrCensus,
  evaluateMergeGroupCheck,
  type MergeGroupCheckResult,
} from "./merge-group.js";
import { getDefaultAppStore } from "./simulator.js";

export interface MergeGroupEventLike {
  readonly action?: string;
  readonly merge_group?: {
    readonly head_sha?: string;
  };
  readonly repository?: {
    readonly full_name?: string;
  };
}

export interface MergeGroupCliSeams {
  readonly store?: OnePrUnitAppStore;
  readonly loadConstituents?: (sha: string) => ConstituentPrCensus[];
  readonly runGh?: RunGhFn;
}

export function loadMergeGroupEventFromPath(eventPath: string): MergeGroupEventLike {
  const raw = readFileSync(eventPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as MergeGroupEventLike;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parsePullsPayload(
  stdout: string,
): { readonly number: number; readonly node_id: string; readonly body: string }[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];
  const out: { number: number; node_id: string; body: string }[] = [];
  for (const item of parsed) {
    const rec = asRecord(item);
    if (rec === null) continue;
    const n = rec.number;
    const node = rec.node_id;
    if (typeof n !== "number" || typeof node !== "string" || node.trim().length === 0) continue;
    out.push({
      number: n,
      node_id: node.trim(),
      body: typeof rec.body === "string" ? rec.body : "",
    });
  }
  return out;
}

function parseCommitMessages(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];
  const msgs: string[] = [];
  for (const item of parsed) {
    const rec = asRecord(item);
    const commit = rec === null ? null : asRecord(rec.commit);
    const message = commit === null ? null : commit.message;
    if (typeof message === "string") msgs.push(message);
  }
  return msgs;
}

/**
 * Production constituent loader: REST commit→pulls, REST commit messages,
 * existing closing-reference helper. Empty/unreadable is fail-closed upstream.
 */
export function loadConstituentsFromGithub(
  sha: string,
  repo: string,
  runGh: RunGhFn = defaultRunGh,
): ConstituentPrCensus[] {
  const pulls = runGh(["gh", "api", `repos/${repo}/commits/${sha}/pulls`]);
  if (pulls.returncode !== 0) {
    return [];
  }
  let listed: ReturnType<typeof parsePullsPayload>;
  try {
    listed = parsePullsPayload(pulls.stdout);
  } catch {
    return [];
  }
  const census: ConstituentPrCensus[] = [];
  for (const pr of listed) {
    const linked = fetchClosingIssuesReferences(pr.number, repo, runGh);
    const commits = runGh(["gh", "api", `repos/${repo}/pulls/${pr.number}/commits`]);
    let commitMessages: string[] | null = null;
    if (commits.returncode === 0) {
      try {
        commitMessages = parseCommitMessages(commits.stdout);
      } catch {
        commitMessages = null;
      }
    }
    census.push({
      prNodeId: pr.node_id,
      repo,
      closingIssuesReferences: linked,
      body: pr.body,
      commitMessages,
    });
  }
  return census;
}

export function runMergeGroupCheckFromEvent(
  event: MergeGroupEventLike,
  seams: MergeGroupCliSeams = {},
): MergeGroupCheckResult {
  const sha = event.merge_group?.head_sha?.trim() ?? "";
  if (sha.length === 0) {
    return {
      conclusion: "failure",
      title: "one-pr-unit",
      summary: "unreadable merge_group.head_sha",
      sha: "",
    };
  }
  const store = seams.store ?? getDefaultAppStore();
  const repo = event.repository?.full_name?.trim() ?? "";
  const load =
    seams.loadConstituents ??
    ((headSha: string) => loadConstituentsFromGithub(headSha, repo, seams.runGh ?? defaultRunGh));
  const constituentPrs = repo.length === 0 && seams.loadConstituents === undefined ? [] : load(sha);
  return evaluateMergeGroupCheck({ mergeGroupSha: sha, constituentPrs, store });
}

export function main(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): number {
  void argv;
  const eventPath = env.GITHUB_EVENT_PATH?.trim() ?? "";
  if (eventPath.length === 0) {
    process.stderr.write("one-pr-unit merge-group: GITHUB_EVENT_PATH is required\n");
    return 1;
  }
  let event: MergeGroupEventLike;
  try {
    event = loadMergeGroupEventFromPath(eventPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`one-pr-unit merge-group: failed to read event: ${message}\n`);
    return 1;
  }
  const result = runMergeGroupCheckFromEvent(event);
  process.stdout.write(`${result.conclusion} ${result.sha} ${result.title}\n${result.summary}\n`);
  return result.conclusion === "success" ? 0 : 1;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main());
}
