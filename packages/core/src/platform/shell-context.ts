import { userInfo } from "node:os";
import { posix, win32 } from "node:path";

const MAX_SHELL_CANDIDATE_LENGTH = 4096;

/** Describes whether a shell signal names the executor, a user default, or no known shell. */
export type ShellContextKind = "execution" | "default" | "unknown";

/** Names the source used to resolve shell orientation. */
export type ShellContextSource =
  | "DEFT_EXECUTION_SHELL"
  | "SHELL"
  | "os.userInfo().shell"
  | "ComSpec"
  | "unknown";

/** Validated shell orientation with explicit semantics and provenance. */
export interface ShellContext {
  readonly name: string;
  readonly path: string | null;
  readonly kind: ShellContextKind;
  readonly source: ShellContextSource;
}

/** Host platform and shell facts safe to surface in session orientation. */
export interface EnvironmentContext {
  readonly hostPlatform: NodeJS.Platform;
  readonly shell: ShellContext;
}

/** Injectable inputs for deterministic shell-context detection. */
export interface DetectEnvironmentContextOptions {
  readonly environ?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly userShell?: string | null;
  readonly readUserShell?: () => string | null;
}

interface Candidate {
  readonly value: string | null | undefined;
  readonly kind: Exclude<ShellContextKind, "unknown">;
  readonly source: Exclude<ShellContextSource, "unknown">;
}

function readAccountShell(readUserShell: () => string | null): string | null {
  try {
    return readUserShell();
  } catch {
    return null;
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      return true;
    }
  }
  return false;
}

function normalizeCandidate(candidate: Candidate): ShellContext | null {
  const raw = candidate.value;
  if (raw === null || raw === undefined) return null;
  if (raw.length > MAX_SHELL_CANDIDATE_LENGTH || hasControlCharacter(raw)) return null;
  const value = raw.trim();
  if (!value) return null;

  const lastSeparator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  const basename = value.slice(lastSeparator + 1);
  if (!basename) return null;
  const name = basename.replace(/\.exe$/i, "");
  if (!name || name === "." || name === "..") return null;

  return {
    name,
    path: lastSeparator >= 0 && (posix.isAbsolute(value) || win32.isAbsolute(value)) ? value : null,
    kind: candidate.kind,
    source: candidate.source,
  };
}

function renderValue(value: string): string {
  return /^[A-Za-z0-9_./:\\+()-]+$/.test(value) ? value : JSON.stringify(value);
}

/** Detect host platform and the best validated shell signal without inferring executor semantics. */
export function detectEnvironmentContext(
  options: DetectEnvironmentContextOptions = {},
): EnvironmentContext {
  const environ = options.environ ?? process.env;
  const hostPlatform = options.platform ?? process.platform;
  const accountShell =
    hostPlatform === "win32"
      ? null
      : options.userShell === undefined
        ? readAccountShell(options.readUserShell ?? (() => userInfo().shell || null))
        : options.userShell;
  const candidates: Candidate[] = [
    {
      value: environ.DEFT_EXECUTION_SHELL,
      kind: "execution",
      source: "DEFT_EXECUTION_SHELL",
    },
    { value: environ.SHELL, kind: "default", source: "SHELL" },
    ...(hostPlatform === "win32"
      ? [
          {
            value: environ.ComSpec ?? environ.COMSPEC,
            kind: "default" as const,
            source: "ComSpec" as const,
          },
        ]
      : [
          {
            value: accountShell,
            kind: "default" as const,
            source: "os.userInfo().shell" as const,
          },
        ]),
  ];

  for (const candidate of candidates) {
    const shell = normalizeCandidate(candidate);
    if (shell) return { hostPlatform, shell };
  }

  return {
    hostPlatform,
    shell: { name: "unknown", path: null, kind: "unknown", source: "unknown" },
  };
}

/** Convert environment orientation to the stable snake-case CLI JSON contract. */
export function environmentContextToDict(context: EnvironmentContext): Record<string, unknown> {
  return {
    host_platform: context.hostPlatform,
    shell: {
      name: context.shell.name,
      path: context.shell.path,
      kind: context.shell.kind,
      source: context.shell.source,
    },
  };
}

/** Format one injection-safe, source-attributed session orientation line. */
export function formatEnvironmentContext(context: EnvironmentContext): string {
  const path = context.shell.path === null ? "unknown" : renderValue(context.shell.path);
  return (
    `[deft environment] os=${renderValue(context.hostPlatform)}; ` +
    `shell=${renderValue(context.shell.name)}; kind=${context.shell.kind}; ` +
    `path=${path}; source=${context.shell.source}`
  );
}
