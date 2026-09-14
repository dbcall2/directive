import { execFileSync } from "node:child_process";

/**
 * Return raw `git status --porcelain` output, or `null` when undeterminable.
 * Maps to config error (exit 2) at the evaluator — fail closed, never assume clean.
 */
export function gitPorcelain(projectRoot: string): string | null {
  try {
    const proc = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return proc;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { status?: number };
    if (e.code === "ENOENT") {
      return null;
    }
    if (typeof e.status === "number" && e.status !== 0) {
      return null;
    }
    return null;
  }
}

/** Current branch name, or null when undeterminable / detached. */
export function gitRevParseAbbrev(projectRoot: string): string | null {
  try {
    const proc = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const name = (typeof proc === "string" ? proc : "").trim();
    if (name.length === 0 || name === "HEAD") return null;
    return name;
  } catch {
    return null;
  }
}
