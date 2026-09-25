import { describe, expect, it } from "vitest";
import { destContentionItTimeout } from "./dest-contention-it-timeout.js";

export {
  DEST_CONTENTION_IT_TIMEOUT_MS,
  destContentionItTimeout,
  WIN32_SPAWN_IT_TIMEOUT_MS,
} from "./dest-contention-it-timeout.js";

describe("dest-contention timeout helper module", () => {
  it("exports a positive platform timeout", () => {
    expect(destContentionItTimeout().timeout).toBeGreaterThan(0);
  });
});
