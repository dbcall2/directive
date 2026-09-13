/**
 * Disk store for one-PR-unit grants under `.deft/one-pr-unit/`.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isHumanOrigin, isRejectedOriginKind } from "../authz/origin.js";
import type { GrantOrigin } from "../authz/types.js";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";
import { uniqueOrigins } from "./origin-set.js";
import { ONE_PR_UNIT_SCHEMA, type OnePrUnitGrant, type OriginRef } from "./types.js";

export const ONE_PR_UNIT_DIR = ".deft/one-pr-unit";

export function onePrUnitDir(projectRoot: string): string {
  return join(resolve(projectRoot), ...ONE_PR_UNIT_DIR.split("/"));
}

export function onePrUnitGrantPath(projectRoot: string, grantId: string): string {
  const safe = grantId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(onePrUnitDir(projectRoot), `${safe}.json`);
}

function utcIso(now?: Date): string {
  const dt = now ?? new Date();
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function writeJsonContained(projectRoot: string, targetPath: string, payload: unknown): void {
  const root = resolve(projectRoot);
  const abs = resolve(targetPath);
  assertWriteTargetSafe(root, abs);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(
    dirname(abs),
    `.${basename(abs)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    containedWrite({
      root,
      target: tmp,
      data: `${JSON.stringify(payload, null, 2)}\n`,
      mode: "create",
    });
    renameSync(tmp, abs);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    if (err instanceof ContainedWriteError) {
      throw err;
    }
    throw err;
  }
}

function readString(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function parseOrigin(raw: unknown): OriginRef | null {
  const rec = record(raw);
  if (rec === null) return null;
  const repo = readString(rec, "repo");
  const issueId = rec.issueId;
  if (repo === null || typeof issueId !== "number" || !Number.isInteger(issueId) || issueId < 1) {
    return null;
  }
  return { repo, issueId };
}

function parseOriginKind(raw: unknown): GrantOrigin | null {
  const rec = record(raw);
  if (rec === null) return null;
  const kind = readString(rec, "kind");
  const actor = readString(rec, "actor");
  const mintedAt = readString(rec, "mintedAt");
  const mintedVia = readString(rec, "mintedVia");
  if (kind === null || actor === null || mintedAt === null || mintedVia === null) {
    return null;
  }
  const eventRef = readString(rec, "eventRef");
  return { kind, actor, mintedAt, mintedVia, eventRef };
}

export function parseOnePrUnitGrant(raw: unknown): OnePrUnitGrant | null {
  const rec = record(raw);
  if (rec === null) return null;
  if (rec.schema !== ONE_PR_UNIT_SCHEMA) return null;
  const id = readString(rec, "id");
  const approvalRef = readString(rec, "approvalRef");
  const rationale = readString(rec, "rationale");
  const repo = readString(rec, "repo");
  const mintedAt = readString(rec, "mintedAt");
  const origin = parseOriginKind(rec.origin);
  if (
    id === null ||
    approvalRef === null ||
    rationale === null ||
    repo === null ||
    mintedAt === null ||
    origin === null
  ) {
    return null;
  }
  if (isRejectedOriginKind(origin.kind) || !isHumanOrigin(origin)) {
    return null;
  }
  const originsRaw = rec.origins;
  if (!Array.isArray(originsRaw)) return null;
  const origins = uniqueOrigins(
    originsRaw.map(parseOrigin).filter((x): x is OriginRef => x !== null),
  );
  const branch = readString(rec, "branch");
  const prNumber =
    typeof rec.prNumber === "number" && Number.isInteger(rec.prNumber) ? rec.prNumber : null;
  return {
    schema: ONE_PR_UNIT_SCHEMA,
    id,
    origin,
    approvalRef,
    rationale,
    origins,
    repo,
    branch,
    prNumber,
    singleUse: rec.singleUse === true,
    usedAt: readString(rec, "usedAt"),
    revokedAt: readString(rec, "revokedAt"),
    mintedAt,
  };
}

export function loadOnePrUnitGrant(projectRoot: string, grantId: string): OnePrUnitGrant | null {
  const path = onePrUnitGrantPath(projectRoot, grantId);
  if (!existsSync(path)) return null;
  try {
    return parseOnePrUnitGrant(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function writeOnePrUnitGrant(projectRoot: string, grant: OnePrUnitGrant): string {
  const path = onePrUnitGrantPath(projectRoot, grant.id);
  writeJsonContained(projectRoot, path, grant);
  return path;
}

export function listOnePrUnitGrants(projectRoot: string): OnePrUnitGrant[] {
  const dir = onePrUnitDir(projectRoot);
  if (!existsSync(dir)) return [];
  const out: OnePrUnitGrant[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const grant = loadOnePrUnitGrant(projectRoot, entry.slice(0, -".json".length));
    if (grant !== null) out.push(grant);
  }
  return out;
}

export { utcIso };
