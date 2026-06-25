import { describe, expect, it } from "vitest";
import { normalizeOutput } from "./swarm-parity.js";

describe("swarm parity helpers", () => {
  it("normalizeOutput strips volatile macOS swarm temp roots", () => {
    const raw =
      "error at /private/var/folders/0z/example/T/swarm-wt-abc123/wt-shared\n" +
      '"worktree_path": "/var/folders/0z/example/T/swarm-launch-def456/.deft-scratch/worktrees/solo-a"\n';

    expect(normalizeOutput(raw)).toBe('error at <TMP> "worktree_path": "<TMP>"');
  });
});
