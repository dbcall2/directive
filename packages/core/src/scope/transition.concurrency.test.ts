import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { destContentionItTimeout } from "../vitest-runner/dest-contention-it-timeout.helper.test.js";
import { formatBriefJson } from "./vbrief-json.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function spawnWorker(args: {
  readonly workerFile: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [tsxCli, args.workerFile], {
      env: { ...process.env, ...args.env },
      cwd: dirname(args.workerFile),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

describe("scope dest exclusive-create concurrency (#3908)", () => {
  it(
    "two processes cannot both exclusive-create the same dest",
    destContentionItTimeout(),
    async () => {
      const root = tempDir("scope-3908-excl-");
      mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
      const destPath = join(root, "xbrief", "completed", "race.xbrief.json");
      const workerDir = tempDir("scope-3908-worker-");
      const transitionAbs = fileURLToPath(new URL("./transition.ts", import.meta.url));
      const workerFile = join(workerDir, "publish-dest-worker.ts");
      writeFileSync(
        workerFile,
        `import { publishScopeDestExclusive } from ${JSON.stringify(transitionAbs)};
const destPath = process.env.SCOPE_3908_DEST ?? "";
const projectRoot = process.env.SCOPE_3908_ROOT ?? "";
const formatted = process.env.SCOPE_3908_PAYLOAD ?? "";
const result = publishScopeDestExclusive({ destPath, formatted, projectRoot });
process.stdout.write(JSON.stringify(result) + "\\n");
`,
        "utf8",
      );
      const [a, b] = await Promise.all([
        spawnWorker({
          workerFile,
          env: {
            SCOPE_3908_DEST: destPath,
            SCOPE_3908_ROOT: root,
            SCOPE_3908_PAYLOAD: "payload-a\n",
          },
        }),
        spawnWorker({
          workerFile,
          env: {
            SCOPE_3908_DEST: destPath,
            SCOPE_3908_ROOT: root,
            SCOPE_3908_PAYLOAD: "payload-b\n",
          },
        }),
      ]);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      const ra = JSON.parse(a.stdout.trim()) as { ok: boolean; message: string };
      const rb = JSON.parse(b.stdout.trim()) as { ok: boolean; message: string };
      const oks = [ra, rb].filter((r) => r.ok);
      const fails = [ra, rb].filter((r) => !r.ok);
      expect(oks).toHaveLength(1);
      expect(fails).toHaveLength(1);
      expect(fails[0]?.message).toContain("Target already exists");
      const destBytes = readFileSync(destPath, "utf8");
      expect(destBytes === "payload-a\n" || destBytes === "payload-b\n").toBe(true);
    },
  );

  it(
    "two complete processes leave one dest and cannot unlink the winner",
    destContentionItTimeout(),
    async () => {
      const root = tempDir("scope-3908-complete-");
      for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
        mkdirSync(join(root, "xbrief", folder), { recursive: true });
      }
      const name = "2026-01-01-race-complete.xbrief.json";
      const source = join(root, "xbrief", "active", name);
      const dest = join(root, "xbrief", "completed", name);
      writeFileSync(
        source,
        formatBriefJson({
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "T", status: "running", items: [] },
        }),
        "utf8",
      );
      const workerDir = tempDir("scope-3908-complete-worker-");
      const transitionAbs = fileURLToPath(new URL("./transition.ts", import.meta.url));
      const workerFile = join(workerDir, "complete-worker.ts");
      writeFileSync(
        workerFile,
        `import { runTransition } from ${JSON.stringify(transitionAbs)};
const file = process.env.SCOPE_3908_FILE ?? "";
const result = runTransition("complete", file, new Date("2026-10-15T12:00:00.000Z"));
process.stdout.write(JSON.stringify(result) + "\\n");
`,
        "utf8",
      );
      const [a, b] = await Promise.all([
        spawnWorker({ workerFile, env: { SCOPE_3908_FILE: source } }),
        spawnWorker({ workerFile, env: { SCOPE_3908_FILE: source } }),
      ]);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      const ra = JSON.parse(a.stdout.trim()) as { ok: boolean; message: string };
      const rb = JSON.parse(b.stdout.trim()) as { ok: boolean; message: string };
      const oks = [ra, rb].filter((r) => r.ok);
      expect(oks.length).toBeGreaterThanOrEqual(1);
      expect(readFileSync(dest, "utf8").length).toBeGreaterThan(0);
      const destBytes = readFileSync(dest, "utf8");
      const parsed = JSON.parse(destBytes) as { plan: { status: string } };
      expect(parsed.plan.status).toBe("completed");
    },
  );
});
