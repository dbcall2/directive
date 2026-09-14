/**
 * Dest-placed worker App installation token allowlist (#4494).
 * Omit of `permissions` is refuse. Returned permissions must match.
 */

export const WORKER_INSTALLATION_PERMISSION_ALLOWLIST = {
  contents: "write",
  issues: "none",
} as const;

export interface DestTokenDecision {
  readonly ok: boolean;
  readonly code:
    | "allow-allowlist"
    | "deny-permissions-omitted"
    | "deny-permissions-mismatch"
    | "deny-forbidden-permission"
    | "deny-returned-mismatch";
  readonly message: string;
}

function permissionMap(value: unknown): Record<string, string> | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") return null;
    out[key] = raw;
  }
  return out;
}

function allowlistEquals(map: Record<string, string>): boolean {
  const keys = Object.keys(map).sort();
  const expected = Object.keys(WORKER_INSTALLATION_PERMISSION_ALLOWLIST).sort();
  if (keys.length !== expected.length) return false;
  return (
    map.contents === WORKER_INSTALLATION_PERMISSION_ALLOWLIST.contents &&
    map.issues === WORKER_INSTALLATION_PERMISSION_ALLOWLIST.issues
  );
}

/**
 * Verify a dest-worker installation-token mint request and GitHub's returned permissions.
 * Local PreToolUse / `.deft-directive-disable` are not this host.
 */
export function evaluateWorkerInstallationPermissions(input: {
  readonly requested?: unknown;
  readonly returned?: unknown;
}): DestTokenDecision {
  if (input.requested === undefined || input.requested === null) {
    return {
      ok: false,
      code: "deny-permissions-omitted",
      message:
        "dest-placed worker installation token mint omitted `permissions`; omit is refuse (full App permission set would be granted)",
    };
  }
  const requested = permissionMap(input.requested);
  if (requested === null) {
    return {
      ok: false,
      code: "deny-permissions-omitted",
      message: "dest-placed worker installation token `permissions` must be an object",
    };
  }
  for (const key of Object.keys(requested)) {
    if (key === "contents" || key === "issues") continue;
    return {
      ok: false,
      code: "deny-forbidden-permission",
      message: `dest-placed worker token requested forbidden permission ${key} (no pull_requests, checks, administration, or ruleset-bypass)`,
    };
  }
  if (!allowlistEquals(requested)) {
    return {
      ok: false,
      code: "deny-permissions-mismatch",
      message:
        "dest-placed worker token permissions must be exactly contents:write and issues:none",
    };
  }
  if (input.returned !== undefined) {
    const returned = permissionMap(input.returned);
    if (returned === null || !allowlistEquals(returned)) {
      return {
        ok: false,
        code: "deny-returned-mismatch",
        message:
          "GitHub returned installation permissions that do not match the dest-worker allowlist",
      };
    }
    for (const key of Object.keys(returned)) {
      if (key === "contents" || key === "issues") continue;
      return {
        ok: false,
        code: "deny-forbidden-permission",
        message: `GitHub returned extra permission ${key} on dest-worker installation token`,
      };
    }
  }
  return {
    ok: true,
    code: "allow-allowlist",
    message: "dest-placed worker installation token permissions match contents:write issues:none",
  };
}

export interface DestTokenMintRequest {
  readonly permissions?: unknown;
}

export interface DestTokenMintResponse {
  readonly token: string;
  readonly permissions: Record<string, string>;
}

export type DestTokenMintFn = (request: DestTokenMintRequest) => DestTokenMintResponse;

/** Mint a dest-worker installation token through a seam; omit permissions is refuse. */
export function mintDestWorkerInstallationToken(
  request: DestTokenMintRequest,
  mint: DestTokenMintFn,
): DestTokenMintResponse {
  const before = evaluateWorkerInstallationPermissions({ requested: request.permissions });
  if (!before.ok) {
    throw new Error(before.message);
  }
  const minted = mint(request);
  const after = evaluateWorkerInstallationPermissions({
    requested: request.permissions,
    returned: minted.permissions,
  });
  if (!after.ok) {
    throw new Error(after.message);
  }
  return minted;
}
