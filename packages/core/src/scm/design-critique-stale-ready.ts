/**
 * Read-only scan for standing ingest-ready chips the live record no longer admits (#4970).
 *
 * Labels select candidates. Evaluators stay label-blind. No label, comment, body,
 * or scope writes.
 */

import {
  evaluateCompletedArcRecord,
  evaluateTargetDigestAdmission,
  type ThreadComment,
  threadCommentsFromIssueComments,
} from "../design-critique/completed-arc-record.js";
import {
  formatStaleIngestReadyDiagnostic,
  INGEST_READY_CHIP,
  type StaleReadyDiagnostic,
} from "../design-critique/stale-ingest-ready-diagnostic.js";
import { fetchIssueComments } from "../intake/issue-ingest.js";
import { extractFlag, extractRepoFlag } from "./argv.js";
import { resolveRepoFromGitOrigin } from "./design-critique-chip.js";
import {
  GhRestError,
  type GhRestSeams,
  InvalidRepoError,
  type RestIssueListPaginatedOptions,
  restIssueListPaginated,
  restIssueView,
  splitRepo,
} from "./gh-rest.js";
import { pyRepr } from "./py-format.js";

export const DESIGN_CRITIQUE_STALE_READY_VERB = "design-critique-stale-ready" as const;

export const DESIGN_CRITIQUE_STALE_READY_USAGE =
  "usage: scm issue design-critique-stale-ready [--repo OWNER/NAME] [--json]\n" +
  "       Read-only scan of open issues carrying design-critique:ingest-ready.\n" +
  "       Reports standing chips whose live completed-arc record no longer admits ingest.\n" +
  "       Labels select candidates. Evaluators stay label-blind. No writes.\n";

export interface StaleReadyArgs {
  readonly repo: string | null;
  readonly json: boolean;
}

export interface StaleReadyCandidate {
  readonly number: number;
  readonly body: string;
  readonly labels: readonly string[];
}

export interface StaleReadyScanSeams {
  readonly resolveDefaultRepo?: () => string | null;
  readonly listOpenIngestReady?: (repo: string) => readonly StaleReadyCandidate[];
  readonly fetchIssue?: (repo: string, issueNumber: number) => StaleReadyCandidate;
  readonly fetchComments?: (repo: string, issueNumber: number) => readonly ThreadComment[];
  readonly ghRest?: GhRestSeams;
}

export interface StaleReadyScanReport {
  readonly issueNumber: number;
  readonly diagnostic: StaleReadyDiagnostic;
}

export interface StaleReadyScanResult {
  readonly complete: boolean;
  readonly repo: string;
  readonly checked: number;
  readonly mismatch: number;
  readonly unknown: number;
  readonly reports: readonly StaleReadyScanReport[];
  readonly error?: string;
}

export interface StaleReadyCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function restLabelNames(issue: Record<string, unknown>): string[] {
  const labels = issue.labels;
  if (!Array.isArray(labels)) return [];
  const names: string[] = [];
  for (const entry of labels) {
    if (typeof entry === "string") {
      names.push(entry);
      continue;
    }
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const name = (entry as Record<string, unknown>).name;
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

function candidateFromRestIssue(issue: Record<string, unknown>): StaleReadyCandidate | null {
  const number = issue.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
  const body = typeof issue.body === "string" ? issue.body : "";
  return { number, body, labels: restLabelNames(issue) };
}

function defaultListOpenIngestReady(repo: string, ghRest: GhRestSeams): StaleReadyCandidate[] {
  const options: RestIssueListPaginatedOptions = {
    state: "open",
    labels: [INGEST_READY_CHIP],
  };
  const listed = restIssueListPaginated(repo, options, ghRest);
  const out: StaleReadyCandidate[] = [];
  for (const item of listed) {
    const candidate = candidateFromRestIssue(item);
    if (candidate !== null) out.push(candidate);
  }
  return out;
}

function defaultFetchIssue(
  repo: string,
  issueNumber: number,
  ghRest: GhRestSeams,
): StaleReadyCandidate {
  const viewed = restIssueView(repo, issueNumber, ghRest);
  const candidate = candidateFromRestIssue(viewed);
  if (candidate === null) {
    return { number: issueNumber, body: "", labels: [] };
  }
  return candidate;
}

function defaultFetchComments(repo: string, issueNumber: number): ThreadComment[] {
  return threadCommentsFromIssueComments(fetchIssueComments(repo, issueNumber));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function scanStaleIngestReady(
  repo: string,
  seams: StaleReadyScanSeams = {},
): StaleReadyScanResult {
  const ghRest = seams.ghRest ?? {};
  const listOpen = seams.listOpenIngestReady ?? ((r) => defaultListOpenIngestReady(r, ghRest));
  const fetchIssue = seams.fetchIssue ?? ((r, n) => defaultFetchIssue(r, n, ghRest));
  const fetchComments = seams.fetchComments ?? defaultFetchComments;

  let listed: readonly StaleReadyCandidate[];
  try {
    listed = listOpen(repo);
  } catch (err: unknown) {
    const message =
      err instanceof GhRestError ? err.message : `candidate-list fetch failed: ${errMessage(err)}`;
    return {
      complete: false,
      repo,
      checked: 0,
      mismatch: 0,
      unknown: 0,
      reports: [],
      error: message,
    };
  }

  let checked = 0;
  let mismatch = 0;
  let unknown = 0;
  const reports: StaleReadyScanReport[] = [];

  for (const listedCandidate of listed) {
    let viewed: StaleReadyCandidate;
    let comments: readonly ThreadComment[];
    try {
      viewed = fetchIssue(repo, listedCandidate.number);
      comments = fetchComments(repo, listedCandidate.number);
    } catch (err: unknown) {
      unknown += 1;
      const diagnostic = formatStaleIngestReadyDiagnostic({
        repo,
        issueNumber: listedCandidate.number,
        labels: listedCandidate.labels,
        verdict: { status: "unknown", detail: errMessage(err) },
      });
      reports.push({ issueNumber: listedCandidate.number, diagnostic });
      continue;
    }

    if (!viewed.labels.includes(INGEST_READY_CHIP)) {
      checked += 1;
      continue;
    }

    const verdict = evaluateCompletedArcRecord({
      comments,
      issueNumber: viewed.number,
    });

    if (verdict.status === "complete") {
      const cited = comments.find((comment) => comment.id === verdict.citedLeanId);
      const citedLeanBody = cited?.body ?? "";
      const digestAdmission = evaluateTargetDigestAdmission({
        citedLeanBody,
        liveIssueBody: viewed.body,
      });
      if (digestAdmission.status !== "blocked") {
        checked += 1;
        continue;
      }
      checked += 1;
      mismatch += 1;
      const diagnostic = formatStaleIngestReadyDiagnostic({
        repo,
        issueNumber: viewed.number,
        labels: viewed.labels,
        verdict,
        digestAdmission,
        liveIssueBody: viewed.body,
        citedLeanBody,
      });
      reports.push({ issueNumber: viewed.number, diagnostic });
      continue;
    }

    checked += 1;
    mismatch += 1;
    const diagnostic = formatStaleIngestReadyDiagnostic({
      repo,
      issueNumber: viewed.number,
      labels: viewed.labels,
      verdict,
    });
    reports.push({ issueNumber: viewed.number, diagnostic });
  }

  return {
    complete: true,
    repo,
    checked,
    mismatch,
    unknown,
    reports,
  };
}

export function formatStaleReadyScanText(result: StaleReadyScanResult): string {
  const lines: string[] = [];
  for (const report of result.reports) {
    const prefix = report.diagnostic.kind === "unknown" ? "unknown" : "mismatch";
    lines.push(`${prefix} ${report.diagnostic.text}`);
  }
  if (result.complete) {
    lines.push(
      `design-critique stale-ready scan complete for ${result.repo}: ` +
        `checked=${String(result.checked)} mismatch=${String(result.mismatch)} ` +
        `unknown=${String(result.unknown)}`,
    );
  } else {
    lines.push(
      `design-critique stale-ready scan incomplete for ${result.repo}: ${result.error ?? "unknown error"}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

type ParseOk = { readonly ok: true; readonly args: StaleReadyArgs };
type ParseErr = {
  readonly ok: false;
  readonly exitCode: 0 | 2;
  readonly stdout: string;
  readonly stderr: string;
};

export function parseDesignCritiqueStaleReadyArgs(extra: readonly string[]): ParseOk | ParseErr {
  let remainder = [...extra];
  const [help] = extractFlag(remainder, "--help");
  const [helpShort] = extractFlag(remainder, "-h");
  if (help || helpShort) {
    return {
      ok: false,
      exitCode: 0,
      stdout: `${DESIGN_CRITIQUE_STALE_READY_USAGE.trimEnd()}\n`,
      stderr: "",
    };
  }

  const [json, afterJson] = extractFlag(remainder, "--json");
  remainder = afterJson;
  const [repoRaw, afterRepo] = extractRepoFlag(remainder);
  remainder = afterRepo;

  const leftoverFlags = remainder.filter((t) => t.startsWith("-"));
  if (leftoverFlags.length > 0) {
    return {
      ok: false,
      exitCode: 2,
      stdout: "",
      stderr: `error: unrecognized flags: ${pyRepr(leftoverFlags)}. Supported: --repo, -R, --json.\n`,
    };
  }
  if (remainder.filter((t) => !t.startsWith("-")).length > 0) {
    return {
      ok: false,
      exitCode: 2,
      stdout: "",
      stderr: `error: unexpected positional arguments: ${pyRepr(remainder)}\n`,
    };
  }

  if (repoRaw !== null && repoRaw.length > 0) {
    try {
      splitRepo(repoRaw);
    } catch (err: unknown) {
      if (err instanceof InvalidRepoError) {
        return {
          ok: false,
          exitCode: 2,
          stdout: "",
          stderr: `error: invalid --repo value: ${err.message}\n`,
        };
      }
      return {
        ok: false,
        exitCode: 2,
        stdout: "",
        stderr: `error: invalid --repo value: ${errMessage(err)}\n`,
      };
    }
  }

  return {
    ok: true,
    args: {
      repo: repoRaw !== null && repoRaw.length > 0 ? repoRaw : null,
      json,
    },
  };
}

export function runDesignCritiqueStaleReady(
  extra: readonly string[],
  seams: StaleReadyScanSeams = {},
): StaleReadyCliResult {
  const parsed = parseDesignCritiqueStaleReadyArgs(extra);
  if (!parsed.ok) {
    return { exitCode: parsed.exitCode, stdout: parsed.stdout, stderr: parsed.stderr };
  }

  const repo = parsed.args.repo ?? (seams.resolveDefaultRepo ?? resolveRepoFromGitOrigin)();
  if (repo === null || repo.length === 0) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "error: missing --repo OWNER/NAME (could not resolve from git origin)\n",
    };
  }
  try {
    splitRepo(repo);
  } catch (err: unknown) {
    if (err instanceof InvalidRepoError) {
      return { exitCode: 2, stdout: "", stderr: `error: invalid --repo value: ${err.message}\n` };
    }
    return { exitCode: 2, stdout: "", stderr: `error: invalid --repo value: ${errMessage(err)}\n` };
  }

  const result = scanStaleIngestReady(repo, seams);
  if (!result.complete) {
    const text = formatStaleReadyScanText(result);
    if (parsed.args.json) {
      return { exitCode: 2, stdout: `${JSON.stringify(result)}\n`, stderr: text };
    }
    return { exitCode: 2, stdout: "", stderr: text };
  }

  const text = formatStaleReadyScanText(result);
  const dirty = result.mismatch > 0 || result.unknown > 0;
  const exitCode = dirty ? 1 : 0;
  if (parsed.args.json) {
    return { exitCode, stdout: `${JSON.stringify({ ...result, text })}\n`, stderr: "" };
  }
  return { exitCode, stdout: text, stderr: "" };
}
