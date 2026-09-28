import { expect, it } from "vitest";
import { evaluateIsolatedScope } from "./isolated-scope.js";

const tree = { paths: [], errors: [], read: () => null };
it("fails closed when a coherent Git snapshot cannot be materialized", () => {
  const r = evaluateIsolatedScope(
    {
      projectRoot: "/path/that/does/not/exist",
      mergeBase: "base",
      candidate: "head",
      changed: [],
      base: tree,
      head: tree,
    },
    {},
  );
  expect(r.exitCode).toBe(2);
  expect(r.message).toContain("snapshot objects unavailable");
});
