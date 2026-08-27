import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { pythonJsonPretty } from "./json.js";
import {
  atomicWriteProjectDefinition,
  loadProjectDefinitionForMutation,
  projectDefinitionMutationLock,
  projectDefinitionPath,
} from "./project-definition-io.js";
import { ProjectDefinitionIOError } from "./types.js";

describe("projectDefinitionIO", () => {
  it("round-trips policy mutations under lock", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-"));
    const path = projectDefinitionPath(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    writeFileSync(
      path,
      pythonJsonPretty({
        xBRIEFInfo: { version: "0.8" },
        plan: { title: "T", status: "running", policy: { wipCap: 10 }, items: [] },
      }),
      "utf8",
    );
    projectDefinitionMutationLock(root, () => {
      const [data, pdPath] = loadProjectDefinitionForMutation(root);
      (data.plan as Record<string, unknown>).policy = { wipCap: 12 };
      atomicWriteProjectDefinition(pdPath, data);
    });
    expect(existsSync(`${path}.lock`)).toBe(false);
    const roundtrip = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect((roundtrip.plan as Record<string, unknown>).policy).toEqual({ wipCap: 12 });
    rmSync(root, { recursive: true, force: true });
  });

  it("raises when project definition missing", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-miss-"));
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(ProjectDefinitionIOError);
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves the xbrief path on a migrated tree, vbrief otherwise (#2302)", () => {
    const legacyRoot = mkdtempSync(join(tmpdir(), "vb-pd-legacy-"));
    expect(
      projectDefinitionPath(legacyRoot).endsWith(`xbrief${sep}PROJECT-DEFINITION.xbrief.json`),
    ).toBe(true);
    rmSync(legacyRoot, { recursive: true, force: true });

    const migratedRoot = mkdtempSync(join(tmpdir(), "vb-pd-migrated-"));
    mkdirSync(join(migratedRoot, "xbrief", "active"), { recursive: true });
    writeFileSync(join(migratedRoot, "xbrief", "active", "some.xbrief.json"), "{}", "utf8");
    expect(
      projectDefinitionPath(migratedRoot).endsWith(`xbrief${sep}PROJECT-DEFINITION.xbrief.json`),
    ).toBe(true);
    rmSync(migratedRoot, { recursive: true, force: true });
  });

  it("uses DEFT_PROJECT_PATH for both mutation and locking (#3609)", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-override-"));
    const configuredPath = join(root, "config", "custom-project.xbrief.json");
    const previous = process.env.DEFT_PROJECT_PATH;
    process.env.DEFT_PROJECT_PATH = join("config", "custom-project.xbrief.json");
    try {
      mkdirSync(join(root, "config"), { recursive: true });
      writeFileSync(
        configuredPath,
        pythonJsonPretty({
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "T", status: "running", items: [] },
        }),
        "utf8",
      );
      expect(projectDefinitionPath(root)).toBe(configuredPath);
      projectDefinitionMutationLock(root, () => {
        const [data, path] = loadProjectDefinitionForMutation(root);
        (data.plan as Record<string, unknown>).title = "Updated";
        atomicWriteProjectDefinition(path, data);
      });
      expect(existsSync(`${configuredPath}.lock`)).toBe(false);
      const roundtrip = JSON.parse(readFileSync(configuredPath, "utf8")) as {
        plan: { title: string };
      };
      expect(roundtrip.plan.title).toBe("Updated");
    } finally {
      if (previous === undefined) delete process.env.DEFT_PROJECT_PATH;
      else process.env.DEFT_PROJECT_PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds a configured symlink to one artifact identity through the lock callback (#3609)", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-symlink-retarget-"));
    const targetA = join(root, "target-a.xbrief.json");
    const targetB = join(root, "target-b.xbrief.json");
    const configuredLink = join(root, "configured.xbrief.json");
    const previous = process.env.DEFT_PROJECT_PATH;
    process.env.DEFT_PROJECT_PATH = configuredLink;
    try {
      for (const [path, title] of [
        [targetA, "A"],
        [targetB, "B"],
      ] as const) {
        writeFileSync(
          path,
          pythonJsonPretty({
            xBRIEFInfo: { version: "0.8" },
            plan: { title, status: "running", items: [] },
          }),
          "utf8",
        );
      }
      symlinkSync(targetA, configuredLink);
      const boundTarget = projectDefinitionPath(root);

      projectDefinitionMutationLock(root, (lockedPath) => {
        expect(lockedPath).toBe(boundTarget);
        unlinkSync(configuredLink);
        symlinkSync(targetB, configuredLink);
        const data = JSON.parse(readFileSync(lockedPath, "utf8")) as Record<string, unknown>;
        (data.plan as Record<string, unknown>).title = "A-updated";
        atomicWriteProjectDefinition(lockedPath, data);
      });

      const a = JSON.parse(readFileSync(targetA, "utf8")) as { plan: { title: string } };
      const b = JSON.parse(readFileSync(targetB, "utf8")) as { plan: { title: string } };
      expect(a.plan.title).toBe("A-updated");
      expect(b.plan.title).toBe("B");
      expect(existsSync(`${targetA}.lock`)).toBe(false);
      expect(existsSync(`${targetB}.lock`)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.DEFT_PROJECT_PATH;
      else process.env.DEFT_PROJECT_PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes separate processes including two stale reapers (#3609)", async () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-multiprocess-"));
    const logPath = join(root, "critical-sections.log");
    const workerPath = join(root, "lock-worker.mjs");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    const moduleUrl = new URL("./project-definition-io.ts", import.meta.url).href;
    writeFileSync(
      workerPath,
      `import { appendFileSync, existsSync, writeFileSync } from "node:fs";\n` +
        `import { join } from "node:path";\n` +
        `import { projectDefinitionMutationLock } from ${JSON.stringify(moduleUrl)};\n` +
        `const [root, logPath, label, holdRaw, barrierDir] = process.argv.slice(2);\n` +
        `const waitCell = new Int32Array(new SharedArrayBuffer(4));\n` +
        `const deps = barrierDir === "-" ? {} : { isProcessAlive: (pid) => pid !== 2147483647, beforeStaleReap: () => {\n` +
        `  writeFileSync(join(barrierDir, label), "ready");\n` +
        `  while (!existsSync(join(barrierDir, label === "a" ? "b" : "a"))) {\n` +
        `    Atomics.wait(waitCell, 0, 0, 5);\n` +
        `  }\n` +
        `} };\n` +
        `projectDefinitionMutationLock(root, () => {\n` +
        `  const expectedLock = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json.lock");\n` +
        `  if (!existsSync(expectedLock)) throw new Error("temp fixture lock was not acquired");\n` +
        `  appendFileSync(logPath, label + ":enter:" + Date.now() + "\\n");\n` +
        `  const until = Date.now() + Number(holdRaw);\n` +
        `  while (Date.now() < until) {}\n` +
        `  appendFileSync(logPath, label + ":exit:" + Date.now() + "\\n");\n` +
        `}, deps);\n`,
      "utf8",
    );

    const runWorker = (label: string, barrierDir = "-"): Promise<void> =>
      new Promise((resolveWorker, rejectWorker) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", workerPath, root, logPath, label, "200", barrierDir],
          {
            env: { ...process.env, DEFT_PROJECT_PATH: "" },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", rejectWorker);
        child.on("exit", (code) => {
          if (code === 0) resolveWorker();
          else rejectWorker(new Error(`${label} exited ${code}: ${stderr}`));
        });
      });

    const expectSerializedEvents = (): void => {
      const events = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(":"))
        .map(([label, event, rawTime]) => ({ label, event, time: Number(rawTime) }));
      expect(events).toHaveLength(4);
      const eventTime = (label: string, event: string): number => {
        const match = events.find((entry) => entry.label === label && entry.event === event);
        if (match === undefined) throw new Error(`missing ${label}:${event}`);
        return match.time;
      };
      const a = { enter: eventTime("a", "enter"), exit: eventTime("a", "exit") };
      const b = { enter: eventTime("b", "enter"), exit: eventTime("b", "exit") };
      expect(a.exit <= b.enter || b.exit <= a.enter).toBe(true);
      expect(existsSync(join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json.lock"))).toBe(false);
    };

    try {
      await Promise.all([runWorker("a"), runWorker("b")]);
      expectSerializedEvents();

      rmSync(logPath, { force: true });
      const lockPath = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json.lock");
      const barrierDir = join(root, "reap-barrier");
      mkdirSync(lockPath);
      mkdirSync(barrierDir);
      writeFileSync(
        join(lockPath, `${2_147_483_647}-${"a".repeat(32)}`),
        `${JSON.stringify({ pid: 2_147_483_647, token: "a".repeat(32) })}\n`,
        "utf8",
      );

      await Promise.all([runWorker("a", barrierDir), runWorker("b", barrierDir)]);
      expectSerializedEvents();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names the resolved xbrief path in the not-found error on a migrated tree (#2302)", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-migrated-miss-"));
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(join(root, "xbrief", "active", "some.xbrief.json"), "{}", "utf8");
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(
      /xbrief[/\\]PROJECT-DEFINITION\.xbrief\.json/,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("raises on invalid JSON and non-object payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-pd-badjson-"));
    const path = projectDefinitionPath(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "seed.xbrief.json"), "{}", { encoding: "utf8" });
    writeFileSync(path, "not-json", "utf8");
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(/not valid JSON/);
    writeFileSync(path, "[]", "utf8");
    expect(() => loadProjectDefinitionForMutation(root)).toThrow(/not a JSON object/);
    rmSync(root, { recursive: true, force: true });
  });
});
