/** Darwin/Linux dest-contention budget for named its (#4847). Live-pack walk needs 20s. */
export const DEST_CONTENTION_IT_TIMEOUT_MS = 20_000;

/** Windows spawn-throughput suite cap (#3616). Per-it overrides must not lower it (#4194). */
export const WIN32_SPAWN_IT_TIMEOUT_MS = 240_000;

/** #4638 object-form `{ timeout }` for dest-class its. One exported Darwin/win32 pairing. */
export function destContentionItTimeout(): { timeout: number } {
  return {
    timeout:
      process.platform === "win32" ? WIN32_SPAWN_IT_TIMEOUT_MS : DEST_CONTENTION_IT_TIMEOUT_MS,
  };
}
