import { describe, expect, it } from "vitest";
import {
  getDefaultPrePrStore,
  InProcessPrePrStore,
  isPublisher,
  loadPrePrRecord,
  mintPublisher,
  opaqueRunId,
  prePrDir,
  requirePublisher,
  resetDefaultPrePrStore,
  resolveRecordFromStore,
  setDefaultPrePrStore,
  writePrePrRecordDisk,
} from "./store.js";
import { DISK_STORE_NOT_SOT, type PrePrExecutionRecord } from "./types.js";

describe("pre-pr private store", () => {
  it("treats run ids as lookup hints and disk as non-SoT", () => {
    const store = new InProcessPrePrStore();
    expect(resolveRecordFromStore(store, { id: "missing" })).toBeNull();
    expect(loadPrePrRecord(".", "missing", store)).toBeNull();
    expect(prePrDir(".").message).toBe(DISK_STORE_NOT_SOT);
    expect(writePrePrRecordDisk(".", {} as PrePrExecutionRecord).code).toBe("deny-disk-not-sot");
    expect(opaqueRunId("  ppr_hint  ")).toBe("ppr_hint");
    expect(opaqueRunId().startsWith("ppr_")).toBe(true);
    expect(isPublisher({})).toBe(false);
    expect(requirePublisher({}).ok).toBe(false);
    expect(isPublisher(mintPublisher())).toBe(true);
    const def = resetDefaultPrePrStore();
    expect(getDefaultPrePrStore()).toBe(def);
    const other = new InProcessPrePrStore();
    setDefaultPrePrStore(other);
    expect(getDefaultPrePrStore()).toBe(other);
    resetDefaultPrePrStore();
  });

  it("indexes by PR node id after put", () => {
    const store = new InProcessPrePrStore();
    const record = {
      id: "ppr_node",
      prNodeId: "PR_kwDOX",
    } as PrePrExecutionRecord;
    store.put(record);
    expect(store.getByPrNodeId("PR_kwDOX")?.id).toBe("ppr_node");
    expect(store.getByPrNodeId("missing")).toBeNull();
    expect(resolveRecordFromStore(store, { prNodeId: "PR_kwDOX" })?.id).toBe("ppr_node");
    expect(resolveRecordFromStore(store, { id: "ppr_node" })?.id).toBe("ppr_node");
    expect(resolveRecordFromStore(store, {})).toBeNull();
    expect(store.list()).toHaveLength(1);
  });
});
