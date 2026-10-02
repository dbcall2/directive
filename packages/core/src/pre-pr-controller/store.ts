/**
 * Private pre-PR execution store (#4912 Limb 1).
 * Reuses the Directive App/operator private-store boundary with a distinct
 * execution record. Disk `.deft/pre-pr-controller` is not SoT.
 * Author-supplied run ids are lookup hints. Publisher credentials never
 * leave this module's factory.
 */

import { randomBytes } from "node:crypto";
import {
  DISK_STORE_NOT_SOT,
  deny,
  type PrePrDecision,
  type PrePrExecutionRecord,
  RUN_ID_LOOKUP_HINT,
} from "./types.js";

const PUBLISHER_BRAND = Symbol("deft.pre-pr.publisher");

export interface PrePrPublisher {
  readonly [PUBLISHER_BRAND]: true;
}

export interface PrePrExecutionStore {
  put(record: PrePrExecutionRecord): PrePrDecision;
  getById(id: string): PrePrExecutionRecord | null;
  getByPrNodeId(prNodeId: string): PrePrExecutionRecord | null;
  list(): readonly PrePrExecutionRecord[];
}

export class InProcessPrePrStore implements PrePrExecutionStore {
  private readonly records = new Map<string, PrePrExecutionRecord>();
  private readonly byPrNode = new Map<string, string>();

  put(record: PrePrExecutionRecord): PrePrDecision {
    this.records.set(record.id, record);
    if (record.prNodeId !== null && record.prNodeId.length > 0) {
      this.byPrNode.set(record.prNodeId, record.id);
    }
    return { ok: true, code: "allow-pass", message: `stored ${record.id}` };
  }

  getById(id: string): PrePrExecutionRecord | null {
    return this.records.get(id) ?? null;
  }

  getByPrNodeId(prNodeId: string): PrePrExecutionRecord | null {
    const id = this.byPrNode.get(prNodeId.trim());
    if (id === undefined) return null;
    return this.getById(id);
  }

  list(): readonly PrePrExecutionRecord[] {
    return [...this.records.values()];
  }
}

let defaultStore: PrePrExecutionStore = new InProcessPrePrStore();

export function getDefaultPrePrStore(): PrePrExecutionStore {
  return defaultStore;
}

export function setDefaultPrePrStore(store: PrePrExecutionStore): void {
  defaultStore = store;
}

export function resetDefaultPrePrStore(): InProcessPrePrStore {
  const next = new InProcessPrePrStore();
  defaultStore = next;
  return next;
}

/**
 * Publisher factory. Implementing-agent APIs never receive this object.
 * Tests and the controller complete path hold it.
 */
export function mintPublisher(): PrePrPublisher {
  return { [PUBLISHER_BRAND]: true };
}

export function isPublisher(value: unknown): value is PrePrPublisher {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [PUBLISHER_BRAND]?: unknown })[PUBLISHER_BRAND] === true
  );
}

export function requirePublisher(value: unknown): PrePrDecision {
  if (isPublisher(value)) {
    return { ok: true, code: "allow-pass", message: "publisher present" };
  }
  return deny("deny-publisher-required", "passing pre-PR records require controller publisher credentials");
}

export function opaqueRunId(explicit?: string): string {
  const given = explicit?.trim() ?? "";
  if (given.length > 0) return given;
  return `ppr_${randomBytes(8).toString("hex")}`;
}

export function resolveRecordFromStore(
  store: PrePrExecutionStore,
  input: { readonly id?: string | null; readonly prNodeId?: string | null },
): PrePrExecutionRecord | null {
  const node = input.prNodeId?.trim() ?? "";
  if (node.length > 0) {
    const byNode = store.getByPrNodeId(node);
    if (byNode !== null) return byNode;
  }
  const id = input.id?.trim() ?? "";
  if (id.length > 0) return store.getById(id);
  return null;
}

export function loadPrePrRecord(
  _projectRoot: string,
  runId: string,
  store: PrePrExecutionStore = getDefaultPrePrStore(),
): PrePrExecutionRecord | null {
  return store.getById(runId);
}

export function writePrePrRecordDisk(_projectRoot: string, _record: PrePrExecutionRecord): PrePrDecision {
  return deny("deny-disk-not-sot", DISK_STORE_NOT_SOT);
}

export function prePrDir(_projectRoot: string): PrePrDecision {
  return deny("deny-disk-not-sot", DISK_STORE_NOT_SOT);
}

export { RUN_ID_LOOKUP_HINT };
