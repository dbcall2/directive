import { applyWorktreeOccupancy, readOccupancy } from "./occupancy.js";

export function runSiblingFenceClaim(
  root: string,
  sessionId: string,
): {
  readonly code: number;
  readonly action: string;
  readonly sessionId: string | null;
  readonly claimedAt: string | null;
} {
  const result = applyWorktreeOccupancy(root, {
    sessionId,
    now: new Date(),
    intent: "mutation",
  });
  const record = readOccupancy(root);
  return {
    code: result.code,
    action: result.action,
    sessionId: record?.sessionId ?? null,
    claimedAt: record?.claimedAt.toISOString() ?? null,
  };
}

const invokedRoot = process.env.OCCUPANCY_FENCE_ROOT ?? "";
if (invokedRoot.length > 0) {
  process.stdout.write(
    `${JSON.stringify(runSiblingFenceClaim(invokedRoot, process.env.OCCUPANCY_FENCE_SESSION ?? ""))}\n`,
  );
}
