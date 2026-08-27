/**
 * Package-manager abstraction for the resolution spine (#2197, from #2264).
 *
 * The documented install/upgrade path historically hard-coded npm
 * (`npm i -g @deftai/directive`). pnpm-managed setups have no first-class
 * flow, and mixing an npm global into a pnpm environment breaks PATH/shim/store
 * consistency. This module makes the *command rendering* package-manager aware
 * so the resolution plan and doctor emit the right form for the active manager.
 *
 * Two load-bearing facts keep this small (locked on issue #2197):
 *   1. NO additional registry. pnpm resolves from the same npm registry
 *      (`registry.npmjs.org`) by default; the published `@deftai/directive`
 *      tarball is unchanged. No renderer here ever emits a `--registry` flag.
 *   2. The internal `.deft/.cli/<platform>` sandbox vendoring STAYS on npm
 *      (its `node_modules/.bin` layout is validated by `integrity.ts` and is
 *      gitignored / package-manager-invisible). Only the global, project-local,
 *      ephemeral, and upgrade command forms vary by package manager.
 *
 * Detection from an injected fact-set remains pure. The project resolver is the
 * single filesystem boundary used by consumer gates so package.json and lockfile
 * precedence cannot drift across callers (#3610).
 */

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type PackageManager = "npm" | "pnpm";

export const PACKAGE_MANAGERS: readonly PackageManager[] = ["npm", "pnpm"];

export const DEFAULT_PACKAGE_MANAGER: PackageManager = "npm";

/** Canonical published engine package name. */
export const ENGINE_PACKAGE = "@deftai/directive";

export interface DetectPackageManagerInput {
  /** Environment map (reads `DEFT_PACKAGE_MANAGER` and `npm_config_user_agent`). */
  readonly env?: NodeJS.ProcessEnv;
  /** The `packageManager` field from the project package.json (Corepack), if any. */
  readonly packageManagerField?: string | null;
  /** Whether a `pnpm-lock.yaml` is present at the project root. */
  readonly pnpmLockPresent?: boolean;
}

export type PackageManagerResolutionSource =
  | "env-override"
  | "package-manager-field"
  | "pnpm-lock"
  | "user-agent"
  | "default";

export type PackageManagerResolutionErrorSource =
  | "env-override"
  | "package-manager-field"
  | "package-json"
  | "project-filesystem";

export type PackageManagerResolution =
  | {
      readonly ok: true;
      readonly packageManager: PackageManager;
      readonly source: PackageManagerResolutionSource;
    }
  | {
      readonly ok: false;
      readonly source: PackageManagerResolutionErrorSource;
      readonly message: string;
    };

export interface ResolveProjectPackageManagerOptions {
  /** Consumer project root. Defaults to the current working directory. */
  readonly projectRoot?: string;
  /** Environment map used for override and user-agent precedence. */
  readonly env?: NodeJS.ProcessEnv;
  /** Text-read seam. `null` means the file is absent. */
  readonly readText?: (path: string) => string | null;
  /** File-existence seam used for pnpm-lock.yaml. */
  readonly isFile?: (path: string) => boolean;
}

const EXPLICIT_PACKAGE_MANAGER_RE = /^(npm|pnpm)(?:@[0-9A-Za-z][0-9A-Za-z._+/=-]*)?$/i;

function normalizePackageManager(value: string): PackageManager | null {
  const v = value.trim().toLowerCase();
  if (v.startsWith("pnpm")) return "pnpm";
  if (v.startsWith("npm")) return "npm";
  return null;
}

function normalizeExplicitPackageManager(value: string): PackageManager | null {
  const match = EXPLICIT_PACKAGE_MANAGER_RE.exec(value.trim());
  const name = match?.[1]?.toLowerCase();
  return name === "npm" || name === "pnpm" ? name : null;
}

function unsupportedPackageManager(
  value: string,
  source: "env-override" | "package-manager-field",
): PackageManagerResolution {
  if (source === "env-override") {
    return {
      ok: false,
      source,
      message: "Unsupported DEFT_PACKAGE_MANAGER value; supported managers are npm and pnpm.",
    };
  }
  const safeValue = sanitizeSingleLineDiagnostic(JSON.stringify(value));
  return {
    ok: false,
    source,
    message: `Unsupported package manager ${safeValue} from package.json#packageManager; supported managers are npm and pnpm.`,
  };
}

/** Human-readable, non-executable label for a resolution source. */
export function packageManagerSourceLabel(source: PackageManagerResolutionSource): string {
  switch (source) {
    case "env-override":
      return "DEFT_PACKAGE_MANAGER override";
    case "package-manager-field":
      return "packageManager field";
    case "pnpm-lock":
      return "pnpm-lock.yaml";
    case "user-agent":
      return "npm_config_user_agent";
    case "default":
      return "default";
  }
}

/**
 * Strict package-manager resolution for execution boundaries.
 *
 * Explicit override/declaration values fail closed when unsupported. The
 * returned manager is a closed union and callers map it to fixed argv; raw
 * package.json or environment text is never executable (#2761/#2765/#3610).
 */
function packageManagerConflictResolution(): PackageManagerResolution {
  return {
    ok: false,
    source: "env-override",
    message:
      "DEFT_PACKAGE_MANAGER conflicts with package.json#packageManager; the declaration is authoritative.",
  };
}

function resolveExplicitOverride(override: string): PackageManagerResolution | null {
  if (override.trim() === "") return null;
  const packageManager = normalizeExplicitPackageManager(override);
  if (packageManager === null) return unsupportedPackageManager(override, "env-override");
  return { ok: true, packageManager, source: "env-override" };
}

export function resolvePackageManager(
  input: DetectPackageManagerInput = {},
): PackageManagerResolution {
  const env = input.env ?? {};
  const override = env.DEFT_PACKAGE_MANAGER;
  const overrideText = typeof override === "string" ? override : "";
  const field = input.packageManagerField;

  if (field != null && field.trim() !== "") {
    const declared = normalizeExplicitPackageManager(field);
    if (declared === null) return unsupportedPackageManager(field, "package-manager-field");
    if (overrideText.trim() !== "") {
      const overridden = normalizeExplicitPackageManager(overrideText);
      if (overridden !== null && overridden !== declared) {
        return packageManagerConflictResolution();
      }
    }
    return { ok: true, packageManager: declared, source: "package-manager-field" };
  }

  const overrideResolution = resolveExplicitOverride(overrideText);
  if (overrideResolution !== null) return overrideResolution;

  if (input.pnpmLockPresent) {
    return { ok: true, packageManager: "pnpm", source: "pnpm-lock" };
  }

  const userAgent = env.npm_config_user_agent;
  if (typeof userAgent === "string" && userAgent.trim() !== "") {
    const packageManager = normalizePackageManager(userAgent);
    if (packageManager !== null) {
      return { ok: true, packageManager, source: "user-agent" };
    }
  }

  return { ok: true, packageManager: DEFAULT_PACKAGE_MANAGER, source: "default" };
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const UNSAFE_DIAGNOSTIC_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Render untrusted diagnostic text as one bounded terminal-safe line. */
export function sanitizeSingleLineDiagnostic(text: string): string {
  const printable = [...text]
    .map((character) => (UNSAFE_DIAGNOSTIC_CHARACTER.test(character) ? " " : character))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const codePoints = [...printable];
  return codePoints.length > 240 ? `${codePoints.slice(0, 237).join("")}...` : printable;
}

function singleLineErrorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeSingleLineDiagnostic(raw) || "unknown error";
}

/** Resolve a consumer project's package manager from package.json and lockfile facts. */
export function resolveProjectPackageManager(
  options: ResolveProjectPackageManagerOptions = {},
): PackageManagerResolution {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const env = options.env ?? process.env;
  const readText = options.readText ?? defaultReadText;
  const isFile = options.isFile ?? defaultIsFile;
  const packageJsonPath = join(projectRoot, "package.json");

  let packageManagerField: string | null = null;
  let packageJsonText: string | null;
  try {
    packageJsonText = readText(packageJsonPath);
  } catch (error: unknown) {
    const detail = singleLineErrorDetail(error);
    return {
      ok: false,
      source: "package-json",
      message: `Could not read package.json for package-manager selection: ${detail}`,
    };
  }
  if (packageJsonText !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(packageJsonText);
    } catch (error: unknown) {
      const detail = singleLineErrorDetail(error);
      return {
        ok: false,
        source: "package-json",
        message: `Could not parse package.json for package-manager selection: ${detail}`,
      };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        source: "package-json",
        message:
          "Could not parse package.json for package-manager selection: root must be an object.",
      };
    }
    const packageRecord = parsed as Record<string, unknown>;
    if (Object.hasOwn(packageRecord, "packageManager")) {
      const field = packageRecord.packageManager;
      if (typeof field !== "string" || field.trim() === "") {
        return {
          ok: false,
          source: "package-manager-field",
          message: "package.json#packageManager must be a non-empty string naming npm or pnpm.",
        };
      }
      packageManagerField = field;
    }
  }

  if (packageManagerField !== null) {
    return resolvePackageManager({ env, packageManagerField });
  }

  let pnpmLockPresent: boolean;
  try {
    pnpmLockPresent = isFile(join(projectRoot, "pnpm-lock.yaml"));
  } catch (error: unknown) {
    const detail = singleLineErrorDetail(error);
    return {
      ok: false,
      source: "project-filesystem",
      message: `Could not inspect pnpm-lock.yaml for package-manager selection: ${detail}`,
    };
  }

  return resolvePackageManager({
    env,
    pnpmLockPresent,
  });
}

/**
 * Detect the active package manager. Precedence (first match wins):
 *   1. `packageManager` field / Corepack shim (authoritative when present)
 *   2. `DEFT_PACKAGE_MANAGER` env override
 *   3. `pnpm-lock.yaml` present
 *   4. `npm_config_user_agent` (set by the manager that spawned the process)
 *   5. default: npm
 */
export function detectPackageManager(input: DetectPackageManagerInput = {}): PackageManager {
  const env = input.env ?? {};

  if (input.packageManagerField != null && input.packageManagerField.trim() !== "") {
    const pm = normalizePackageManager(input.packageManagerField);
    if (pm) return pm;
  }

  const override = env.DEFT_PACKAGE_MANAGER;
  if (typeof override === "string" && override.trim() !== "") {
    const pm = normalizePackageManager(override);
    if (pm) return pm;
  }

  if (input.pnpmLockPresent) return "pnpm";

  const ua = env.npm_config_user_agent;
  if (typeof ua === "string" && ua.trim() !== "") {
    const pm = normalizePackageManager(ua);
    if (pm) return pm;
  }

  return DEFAULT_PACKAGE_MANAGER;
}

/**
 * Render a global install command, e.g. `npm i -g @deftai/directive@0.65.0`
 * (npm) or `pnpm add -g @deftai/directive@0.65.0` (pnpm). `spec` is the full
 * package spec including any `@version` suffix.
 */
export function renderGlobalInstall(pm: PackageManager, spec: string = ENGINE_PACKAGE): string {
  return pm === "pnpm" ? `pnpm add -g ${spec}` : `npm i -g ${spec}`;
}

/**
 * Render a project-local (dev-dependency) install command. pnpm-managed repos
 * that prefer not to install globally use this.
 */
export function renderProjectInstall(pm: PackageManager, spec: string = ENGINE_PACKAGE): string {
  return pm === "pnpm" ? `pnpm add -D ${spec}` : `npm install --save-dev ${spec}`;
}

/**
 * Render an ephemeral (no-install) invocation, e.g. `npx @deftai/directive update`
 * (npm) or `pnpm dlx @deftai/directive update` (pnpm).
 */
export function renderEphemeral(
  pm: PackageManager,
  subcommand: string,
  pkg: string = ENGINE_PACKAGE,
): string {
  const runner = pm === "pnpm" ? "pnpm dlx" : "npx";
  const tail = subcommand.trim() === "" ? "" : ` ${subcommand.trim()}`;
  return `${runner} ${pkg}${tail}`;
}

export interface PackageManagerCommands {
  readonly packageManager: PackageManager;
  /** Global install of the engine at the given spec. */
  readonly globalInstall: string;
  /** Project-local (dev-dependency) install of the engine. */
  readonly projectInstall: string;
  /** Ephemeral `update` invocation. */
  readonly ephemeralUpdate: string;
  /** The canonical upgrade one-liner (global install of `@latest`). */
  readonly upgradeOneLiner: string;
}

/**
 * Render the full command matrix for a package manager at a given spec
 * (defaults to `@latest`). Single-sourced so docs, doctor, and the plan all
 * derive from the same renderers.
 */
export function renderPackageManagerCommands(
  pm: PackageManager,
  spec: string = `${ENGINE_PACKAGE}@latest`,
): PackageManagerCommands {
  return {
    packageManager: pm,
    globalInstall: renderGlobalInstall(pm, spec),
    projectInstall: renderProjectInstall(pm, spec),
    ephemeralUpdate: renderEphemeral(pm, "update"),
    upgradeOneLiner: renderGlobalInstall(pm, `${ENGINE_PACKAGE}@latest`),
  };
}
