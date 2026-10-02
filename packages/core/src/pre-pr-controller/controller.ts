/**
 * Repository-controlled pre-PR controller (#4912 Limbs 1 and 3).
 * Code/policy bind to an approved protected revision independent of the PR
 * under review. Incomplete, failed, and interrupted runs mint no pass.
 * Opening the skill file and generic mark-complete cannot mint a pass.
 */

import {
  isAllowedSkip,
  PRE_PR_CONTROLLER_VERSION,
  PRE_PR_PHASES,
  PRE_PR_WORKFLOW_VERSION,
  type PrePrPhaseId,
  phaseSpec,
} from "./phases.js";
import {
  isPublisher,
  mintPublisher,
  opaqueRunId,
  type PrePrExecutionStore,
  type PrePrPublisher,
  requirePublisher,
} from "./store.js";
import {
  type ApprovedCriteria,
  type CommandObservation,
  deny,
  inputBindingHash,
  MARK_COMPLETE_NOT_AUTHORITY,
  type PrePrDecision,
  type PrePrExecutionRecord,
  type PrePrInputBinding,
  PUBLISHER_REQUIRED,
  type SemanticEvidence,
  SKILL_FILE_OPEN_NOT_COMPLETION,
  utcIso,
} from "./types.js";

export interface StartControllerRunInput {
  readonly repo: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly prBodyHash: string;
  readonly prNodeId: string | null;
  readonly criteria: ApprovedCriteria;
  readonly skillVersion: string;
  readonly policyVersion: string;
  readonly approvedRevisionSha: string;
  readonly now?: Date;
  readonly runId?: string;
}

export interface StartControllerRunResult {
  readonly ok: boolean;
  readonly runId: string | null;
  readonly decision: PrePrDecision;
}

export function startControllerRun(
  store: PrePrExecutionStore,
  input: StartControllerRunInput,
): StartControllerRunResult {
  const id = opaqueRunId(input.runId);
  const binding: PrePrInputBinding = {
    repo: input.repo,
    baseSha: input.baseSha,
    headSha: input.headSha,
    treeHash: input.treeHash,
    prBodyHash: input.prBodyHash,
    criteriaDigest: input.criteria.digest,
    skillVersion: input.skillVersion,
    policyVersion: input.policyVersion,
    controllerVersion: PRE_PR_CONTROLLER_VERSION,
    approvedRevisionSha: input.approvedRevisionSha,
  };
  const record: PrePrExecutionRecord = {
    schema: "deft.pre-pr-execution.v1",
    id,
    state: "started",
    outcome: "none",
    repo: input.repo,
    baseSha: input.baseSha,
    headSha: input.headSha,
    treeHash: input.treeHash,
    inputHash: inputBindingHash(binding),
    prNodeId: input.prNodeId,
    prBodyHash: input.prBodyHash,
    criteria: input.criteria,
    skillVersion: input.skillVersion,
    policyVersion: input.policyVersion,
    controllerVersion: PRE_PR_CONTROLLER_VERSION,
    workflowVersion: PRE_PR_WORKFLOW_VERSION,
    approvedRevisionSha: input.approvedRevisionSha,
    evaluationGeneration: input.criteria.generation,
    phaseEvidence: { commands: [], semantic: [] },
    reviewedFileManifest: [],
    reviewReportRef: null,
    finalNoChange: false,
    startedAt: utcIso(input.now),
    completedAt: null,
    interruptedAt: null,
    failedAt: null,
    publishedAt: null,
  };
  store.put(record);
  return {
    ok: true,
    runId: id,
    decision: { ok: true, code: "allow-pass", message: `started ${id}` },
  };
}

function mutate(
  store: PrePrExecutionStore,
  runId: string,
  fn: (record: PrePrExecutionRecord) => PrePrExecutionRecord | PrePrDecision,
): { record: PrePrExecutionRecord | null; decision: PrePrDecision } {
  const current = store.getById(runId);
  if (current === null) {
    return {
      record: null,
      decision: deny("deny-missing-record", `pre-PR run ${runId} is not in the private store`),
    };
  }
  if (current.outcome === "pass") {
    return { record: current, decision: deny("deny-incomplete", "pass already published") };
  }
  const next = fn(current);
  if ("ok" in next && "code" in next && !("schema" in next)) {
    return { record: current, decision: next };
  }
  const record = next as PrePrExecutionRecord;
  store.put(record);
  return { record, decision: { ok: true, code: "allow-pass", message: `updated ${runId}` } };
}

export function observeCommandPhase(
  store: PrePrExecutionStore,
  runId: string,
  observation: Omit<CommandObservation, "completedAt"> & { readonly now?: Date },
): PrePrDecision {
  const spec = phaseSpec(observation.phaseId);
  if (spec.kind !== "command-observable") {
    return deny(
      "deny-input-mismatch",
      `phase ${observation.phaseId} is semantic, not command-observable`,
    );
  }
  const { decision } = mutate(store, runId, (record) => {
    if (observation.inputHash !== record.inputHash) {
      return deny(
        "deny-input-mismatch",
        "command observation input hash does not match the run binding",
      );
    }
    const failed =
      observation.exitCode !== 0 && !isAllowedSkip(observation.phaseId, observation.skipReason);
    const row: CommandObservation = {
      phaseId: observation.phaseId,
      command: observation.command,
      exitCode: observation.exitCode,
      inputHash: observation.inputHash,
      skipReason: observation.skipReason,
      completedAt: utcIso(observation.now),
    };
    const next: PrePrExecutionRecord = {
      ...record,
      state: failed ? "failed" : "running",
      outcome: "none",
      failedAt: failed ? utcIso(observation.now) : record.failedAt,
      phaseEvidence: {
        commands: [...record.phaseEvidence.commands.filter((c) => c.phaseId !== row.phaseId), row],
        semantic: record.phaseEvidence.semantic,
      },
    };
    return next;
  });
  return decision;
}

export function submitReviewerReport(
  store: PrePrExecutionStore,
  runId: string,
  evidence: Omit<SemanticEvidence, "recordedAt"> & { readonly now?: Date },
): PrePrDecision {
  const spec = phaseSpec(evidence.phaseId);
  if (spec.kind !== "semantic") {
    return deny("deny-input-mismatch", `phase ${evidence.phaseId} is command-observable`);
  }
  const { decision } = mutate(store, runId, (record) => {
    if (evidence.criteriaDigest !== record.criteria.digest) {
      return deny(
        "deny-criteria-invalidated",
        "semantic evidence criteria digest does not match approved criteria",
      );
    }
    const row: SemanticEvidence = {
      phaseId: evidence.phaseId,
      reviewedFileManifest: evidence.reviewedFileManifest,
      suppliedContentsHash: evidence.suppliedContentsHash,
      criteriaDigest: evidence.criteriaDigest,
      reviewerReportRef: evidence.reviewerReportRef,
      controllerObservedHash: evidence.controllerObservedHash,
      recordedAt: utcIso(evidence.now),
    };
    const hashesMatch = evidence.suppliedContentsHash === evidence.controllerObservedHash;
    let finalNoChange = record.finalNoChange;
    if (evidence.phaseId === "write" && !hashesMatch) {
      finalNoChange = false;
    }
    if (evidence.phaseId === "loop") {
      finalNoChange = hashesMatch;
    }
    const manifest =
      evidence.reviewedFileManifest.length > 0
        ? evidence.reviewedFileManifest
        : record.reviewedFileManifest;
    const next: PrePrExecutionRecord = {
      ...record,
      state: "running",
      finalNoChange,
      reviewedFileManifest: manifest,
      reviewReportRef: evidence.reviewerReportRef ?? record.reviewReportRef,
      phaseEvidence: {
        commands: record.phaseEvidence.commands,
        semantic: [...record.phaseEvidence.semantic.filter((s) => s.phaseId !== row.phaseId), row],
      },
    };
    return next;
  });
  return decision;
}

export function interruptRun(store: PrePrExecutionStore, runId: string, now?: Date): PrePrDecision {
  const { decision } = mutate(store, runId, (record) => ({
    ...record,
    state: "interrupted" as const,
    outcome: "none" as const,
    interruptedAt: utcIso(now),
  }));
  return decision;
}

export function failRun(store: PrePrExecutionStore, runId: string, now?: Date): PrePrDecision {
  const { decision } = mutate(store, runId, (record) => ({
    ...record,
    state: "failed" as const,
    outcome: "none" as const,
    failedAt: utcIso(now),
  }));
  return decision;
}

/** Agent-callable. Never mints a pass. */
export function markComplete(_store: PrePrExecutionStore, _runId: string): PrePrDecision {
  return deny("deny-mark-complete", MARK_COMPLETE_NOT_AUTHORITY);
}

/** Opening the skill file is not completion. */
export function noteSkillFileOpen(): PrePrDecision {
  return deny("deny-skill-file-open", SKILL_FILE_OPEN_NOT_COMPLETION);
}

function commandSatisfied(record: PrePrExecutionRecord, phaseId: PrePrPhaseId): boolean {
  const row = record.phaseEvidence.commands.find((c) => c.phaseId === phaseId);
  if (row === undefined) return false;
  if (row.inputHash !== record.inputHash) return false;
  if (row.exitCode === 0) return true;
  return isAllowedSkip(phaseId, row.skipReason);
}

function semanticSatisfied(record: PrePrExecutionRecord, phaseId: PrePrPhaseId): boolean {
  const row = record.phaseEvidence.semantic.find((s) => s.phaseId === phaseId);
  if (row === undefined) return false;
  if (row.criteriaDigest !== record.criteria.digest) return false;
  if (phaseId === "loop") {
    return record.finalNoChange && row.suppliedContentsHash === row.controllerObservedHash;
  }
  return row.suppliedContentsHash.length > 0 && row.controllerObservedHash.length > 0;
}

export function runObservablesComplete(record: PrePrExecutionRecord): PrePrDecision {
  if (record.state === "failed" || record.failedAt !== null) {
    return deny("deny-failed", "failed pre-PR run mints no pass");
  }
  if (record.state === "interrupted" || record.interruptedAt !== null) {
    return deny("deny-interrupted", "interrupted pre-PR run mints no pass");
  }
  for (const spec of PRE_PR_PHASES) {
    if (!spec.required) continue;
    const ok =
      spec.kind === "command-observable"
        ? commandSatisfied(record, spec.id)
        : semanticSatisfied(record, spec.id);
    if (!ok) {
      return deny(
        "deny-omitted-phase",
        `required phase ${spec.id} has no controller-observed pass`,
      );
    }
  }
  if (!record.finalNoChange) {
    return deny("deny-incomplete", "completion requires the skill final no-change pass");
  }
  return { ok: true, code: "allow-pass", message: "observables complete" };
}

/**
 * Mint a pass only with publisher credentials. Incomplete/failed/interrupted
 * runs stay non-pass. Agent shells do not receive `publisher`.
 */
export function completeRun(
  store: PrePrExecutionStore,
  publisher: unknown,
  runId: string,
  now?: Date,
): PrePrDecision {
  const creds = requirePublisher(publisher);
  if (!creds.ok) {
    return deny("deny-publisher-required", PUBLISHER_REQUIRED);
  }
  const current = store.getById(runId);
  if (current === null) {
    return deny("deny-missing-record", `pre-PR run ${runId} is not in the private store`);
  }
  const observables = runObservablesComplete(current);
  if (!observables.ok) return observables;
  const published: PrePrExecutionRecord = {
    ...current,
    state: "complete",
    outcome: "pass",
    completedAt: utcIso(now),
    publishedAt: utcIso(now),
  };
  store.put(published);
  return { ok: true, code: "allow-pass", message: `published ${runId}` };
}

export function controllerPublisher(): PrePrPublisher {
  return mintPublisher();
}

export { isPublisher };
