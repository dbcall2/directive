/**
 * Two-phase committed lifecycle input validation for native release readers (#4317 / #4164).
 *
 * Census is the union of gitignore-blind filesystem readdir+lstat, the Git index,
 * and pinned HEAD. Payload reads happen only after type/membership/size checks.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIFECYCLE_FOLDERS } from "../intake/reconcile-issues.js";
import { hasArtifactSuffix } from "../layout/resolve.js";
import { COMPLETED_WRITE_GUARD_MAX_BYTES } from "../lifecycle/completed-write-guard.js";
import { LEGACY_ARTIFACT_DIR, MIGRATED_ARTIFACT_DIR } from "../xbrief-migrate/constants.js";
import { GIT_LS_FILES_Z_ENCODING, splitGitLsFilesZRecords } from "./build-dist.js";
import { EXIT_OK, EXIT_VIOLATION } from "./constants.js";

export const RELEASE_INPUT_PER_FILE_MAX_BYTES = COMPLETED_WRITE_GUARD_MAX_BYTES;
export const RELEASE_INPUT_PER_VIEW_MAX_BYTES = 67_108_864;
const CAT_FILE_FRAMING_BUDGET_BYTES = 1_048_576;
const GIT_Z_LIST_MAX_BUFFER = 16 * 1024 * 1024;
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

/** Five-folder Step 3 scanner census — production `LIFECYCLE_FOLDERS`. */
export const SCANNER_FOLDERS = LIFECYCLE_FOLDERS;

/** Four-folder ROADMAP census — matches `renderRoadmapToBuffer` load calls. */
export const ROADMAP_FOLDERS = ["pending", "proposed", "active", "completed"] as const;

export type ReleaseInputPhase = "scanner" | "roadmap";

export interface ReleaseInputViolation {
  readonly code: string;
  readonly path: string;
  readonly remedy: string;
}

export interface ReleaseInputResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly code: string;
  readonly violations: readonly ReleaseInputViolation[];
  readonly selectedPaths: readonly string[];
  readonly payloadReads: number;
}

export interface ReleaseInputMetaSeams {
  readonly diskSizeOf?: (absPath: string) => number | undefined;
  readonly headBlobSizeOf?: (oid: string) => number | undefined;
}

const SUFFIX_BUFFERS = [Buffer.from(".xbrief.json"), Buffer.from(".vbrief.json")] as const;
const XBRIEF_PREFIX = `${MIGRATED_ARTIFACT_DIR}/`;

function defined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(label);
  return value;
}

function byteAt(buf: Buffer, i: number): number {
  return defined(buf[i], "buffer index");
}

export function foldersForPhase(phase: ReleaseInputPhase): readonly string[] {
  return phase === "scanner" ? SCANNER_FOLDERS : ROADMAP_FOLDERS;
}

export function passReleaseInputs(
  _projectRoot?: string,
  _phase?: ReleaseInputPhase,
): ReleaseInputResult {
  return {
    ok: true,
    exitCode: EXIT_OK,
    code: "ok",
    violations: [],
    selectedPaths: [],
    payloadReads: 0,
  };
}

/** Escape newline/tab/control/invalid bytes so a path cannot forge status lines. */
export function escapeReleaseDisplay(input: string | Buffer): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  let out = "";
  for (let i = 0; i < buf.length; i += 1) {
    const b = byteAt(buf, i);
    if (b === 0x5c) out += "\\\\";
    else if (b === 0x0a) out += "\\n";
    else if (b === 0x0d) out += "\\r";
    else if (b === 0x09) out += "\\t";
    else if (b < 0x20 || b === 0x7f) out += `\\x${b.toString(16).padStart(2, "0")}`;
    else if (b < 0x80) out += String.fromCharCode(b);
    else {
      const slice = tryUtf8Slice(buf, i);
      if (slice) {
        out += slice.text;
        i += slice.consumed - 1;
      } else {
        out += `\\x${b.toString(16).padStart(2, "0")}`;
      }
    }
  }
  return out;
}

function tryUtf8Slice(buf: Buffer, i: number): { text: string; consumed: number } | null {
  const b = byteAt(buf, i);
  let need = 0;
  if ((b & 0xe0) === 0xc0) need = 2;
  else if ((b & 0xf0) === 0xe0) need = 3;
  else if ((b & 0xf8) === 0xf0) need = 4;
  else return null;
  if (i + need > buf.length) return null;
  const slice = buf.subarray(i, i + need);
  const text = slice.toString("utf8");
  if (Buffer.from(text, "utf8").equals(slice) && !text.includes("\uFFFD")) {
    return { text, consumed: need };
  }
  return null;
}

export function writeEscapedReleaseLine(text: string, target = process.stderr): void {
  target.write(`${escapeReleaseDisplay(text)}\n`);
}

export function writeReleaseInputDetails(
  result: ReleaseInputResult,
  target = process.stderr,
): void {
  for (const v of result.violations) {
    target.write(
      `[release-input] ${v.code}: ${escapeReleaseDisplay(v.path)} -- ${escapeReleaseDisplay(v.remedy)}\n`,
    );
  }
  if (!result.ok) {
    target.write(
      "[release-input] release-artifact phase did not promote CHANGELOG or write ROADMAP\n",
    );
  }
}

/**
 * Lone-LF expansion: a HEAD LF not preceded by CR may match disk LF or CRLF.
 * Existing HEAD CRLF stays exact. Both buffers must exhaust together.
 */
export function loneLfEquals(head: Buffer, disk: Buffer): boolean {
  let hi = 0;
  let di = 0;
  while (hi < head.length) {
    const hb = head[hi];
    if (hb === 0x0a && (hi === 0 || head[hi - 1] !== 0x0d)) {
      if (di >= disk.length) return false;
      if (disk[di] === 0x0a) di += 1;
      else if (disk[di] === 0x0d && di + 1 < disk.length && disk[di + 1] === 0x0a) di += 2;
      else return false;
      hi += 1;
      continue;
    }
    if (di >= disk.length || disk[di] !== hb) return false;
    hi += 1;
    di += 1;
  }
  return di === disk.length;
}

export function splitGitNulRecordsStrict(stdout: Buffer): Buffer[] {
  if (stdout.length === 0) return [];
  if (stdout[stdout.length - 1] !== 0) {
    throw new Error("truncated git -z framing");
  }
  return splitGitLsFilesZRecords(stdout).map((r) => r.bytes);
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function utf8RoundTrip(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

function hasSuffixBytes(name: Buffer): boolean {
  for (const suffix of SUFFIX_BUFFERS) {
    if (name.length >= suffix.length && name.subarray(name.length - suffix.length).equals(suffix)) {
      return true;
    }
  }
  return false;
}

function posixKey(folder: string, nameBytes: Buffer): string {
  return `${XBRIEF_PREFIX}${folder}/${nameBytes.toString("latin1")}`;
}

function displayPath(folder: string, nameBytes: Buffer): string {
  const name = utf8RoundTrip(nameBytes);
  if (name !== null) return `${XBRIEF_PREFIX}${folder}/${name}`;
  return `${XBRIEF_PREFIX}${folder}/${escapeReleaseDisplay(nameBytes)}`;
}

/** Git `-z` paths use `/` as the only separator. Do not rewrite `\` (#4317). */
function gitPathText(pathBytes: Buffer): string {
  return utf8RoundTrip(pathBytes) ?? pathBytes.toString("latin1");
}

function parseOneComponent(relPosix: string): { folder: string; name: string } | null {
  const parts = relPosix.split("/");
  if (parts.length !== 3) return null;
  const dir = parts[0];
  const folder = parts[1];
  const name = parts[2];
  if (dir !== MIGRATED_ARTIFACT_DIR || folder === undefined || name === undefined) return null;
  if (folder.length === 0 || name.length === 0) return null;
  return { folder, name };
}

interface Candidate {
  folder: string;
  nameBytes: Buffer;
  rel: string;
  display: string;
  fs: boolean;
  index: boolean;
  head: boolean;
  indexMode: string | null;
  indexOid: string | null;
  indexStage: number | null;
  indexCount: number;
  headMode: string | null;
  headOid: string | null;
  headType: string | null;
}

function ensureCandidate(
  map: Map<string, Candidate>,
  folder: string,
  nameBytes: Buffer,
): Candidate {
  const key = posixKey(folder, nameBytes);
  let c = map.get(key);
  if (!c) {
    c = {
      folder,
      nameBytes,
      rel: key,
      display: displayPath(folder, nameBytes),
      fs: false,
      index: false,
      head: false,
      indexMode: null,
      indexOid: null,
      indexStage: null,
      indexCount: 0,
      headMode: null,
      headOid: null,
      headType: null,
    };
    map.set(key, c);
  }
  return c;
}

function runGitBytes(
  projectRoot: string,
  args: readonly string[],
  maxBuffer: number,
  input?: Buffer,
): Buffer {
  const result = spawnSync("git", ["-C", projectRoot, ...args], {
    encoding: GIT_LS_FILES_Z_ENCODING,
    maxBuffer,
    timeout: 30_000,
    stdio: input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    input,
  });
  if (result.status !== 0 || result.error) {
    const errText = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : String(result.stderr ?? result.error?.message ?? "git failed");
    throw new Error(errText.trim() || "git failed");
  }
  if (Buffer.isBuffer(result.stdout)) return result.stdout;
  if (typeof result.stdout === "string") return Buffer.from(result.stdout, "utf8");
  return Buffer.alloc(0);
}

function parseStageRecord(rec: Buffer): {
  mode: string;
  oid: string;
  stage: number;
  pathBytes: Buffer;
} | null {
  const tab = rec.indexOf(0x09);
  if (tab < 0) return null;
  const meta = rec.subarray(0, tab).toString("ascii");
  const m = /^([0-7]{6}) ([0-9a-f]+) ([0-3])$/i.exec(meta);
  if (!m) return null;
  return {
    mode: defined(m[1], "stage mode"),
    oid: defined(m[2], "stage oid").toLowerCase(),
    stage: Number(defined(m[3], "stage")),
    pathBytes: Buffer.from(rec.subarray(tab + 1)),
  };
}

function parseLsTreeRecord(rec: Buffer): {
  mode: string;
  type: string;
  oid: string;
  pathBytes: Buffer;
} | null {
  const tab = rec.indexOf(0x09);
  if (tab < 0) return null;
  const meta = rec.subarray(0, tab).toString("ascii");
  const m = /^([0-7]{6}) (blob|tree|commit|tag) ([0-9a-f]+)$/i.exec(meta);
  if (!m) return null;
  return {
    mode: defined(m[1], "tree mode"),
    type: defined(m[2], "tree type"),
    oid: defined(m[3], "tree oid").toLowerCase(),
    pathBytes: Buffer.from(rec.subarray(tab + 1)),
  };
}

function parseCatFileBatch(stdout: Buffer, oids: readonly string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let offset = 0;
  for (const _oid of oids) {
    const nl = stdout.indexOf(0x0a, offset);
    if (nl < 0) throw new Error("truncated git cat-file --batch header");
    const header = stdout.subarray(offset, nl).toString("ascii");
    offset = nl + 1;
    if (/\smissing$/.test(header)) {
      throw new Error(`missing git object in cat-file --batch: ${header}`);
    }
    const parts = header.split(" ");
    if (parts.length !== 3) throw new Error(`malformed cat-file header: ${header}`);
    const gotOid = defined(parts[0], "cat-file oid");
    const type = defined(parts[1], "cat-file type");
    const sizeStr = defined(parts[2], "cat-file size");
    if (!/^[0-9a-f]+$/i.test(gotOid)) throw new Error("cat-file object id is not hex");
    const size = Number(sizeStr);
    if (!Number.isInteger(size) || size < 0) throw new Error("cat-file size is not an integer");
    if (type !== "blob") throw new Error(`cat-file type ${type} is not blob`);
    if (size > RELEASE_INPUT_PER_FILE_MAX_BYTES) throw new Error("oversized-head-blob");
    if (offset + size + 1 > stdout.length)
      throw new Error("truncated git cat-file --batch payload");
    const payload = Buffer.from(stdout.subarray(offset, offset + size));
    if (byteAt(stdout, offset + size) !== 0x0a)
      throw new Error("malformed cat-file payload trailer");
    offset += size + 1;
    out.set(gotOid.toLowerCase(), payload);
  }
  if (offset !== stdout.length) throw new Error("extra cat-file --batch bytes after payloads");
  return out;
}

function parseCatFileCheck(
  stdout: Buffer,
  oids: readonly string[],
): Map<string, { type: string; size: number }> {
  const out = new Map<string, { type: string; size: number }>();
  const text = stdout.toString("ascii");
  if (text.length === 0) {
    if (oids.length === 0) return out;
    throw new Error("truncated git cat-file --batch-check");
  }
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.length !== oids.length) throw new Error("cat-file --batch-check count mismatch");
  for (const header of lines) {
    if (/\smissing$/.test(header)) throw new Error(`missing git object: ${header}`);
    const parts = header.split(" ");
    if (parts.length !== 3) throw new Error(`malformed batch-check header: ${header}`);
    const oid = defined(parts[0], "batch-check oid");
    const type = defined(parts[1], "batch-check type");
    const sizeStr = defined(parts[2], "batch-check size");
    const size = Number(sizeStr);
    if (!Number.isInteger(size) || size < 0) throw new Error("batch-check size is not an integer");
    out.set(oid.toLowerCase(), { type, size });
  }
  return out;
}

function remedyFor(code: string): string {
  switch (code) {
    case "missing-lifecycle-root":
      return "initialize the canonical xbrief/ layout, review and commit any intended lifecycle artifacts, then rerun";
    case "legacy-only":
      return "migrate the layout through deft migrate:xbrief, review and commit its artifacts, then rerun";
    case "untracked":
      return "remove or relocate only after confirming the candidate is unintended, then rerun";
    case "uncommitted":
    case "staged":
    case "missing-view":
      return "review and commit the lifecycle change, then rerun";
    case "unmerged":
      return "resolve the unmerged index entry, then rerun";
    default:
      return "repair the named condition, then rerun";
  }
}

function fail(
  code: string,
  path: string,
  extra: Partial<ReleaseInputResult> = {},
): ReleaseInputResult {
  return {
    ok: false,
    exitCode: EXIT_VIOLATION,
    code,
    violations: [{ code, path, remedy: remedyFor(code) }],
    selectedPaths: extra.selectedPaths ?? [],
    payloadReads: extra.payloadReads ?? 0,
  };
}

function failMany(
  code: string,
  violations: ReleaseInputViolation[],
  selectedPaths: string[],
): ReleaseInputResult {
  return {
    ok: false,
    exitCode: EXIT_VIOLATION,
    code,
    violations,
    selectedPaths,
    payloadReads: 0,
  };
}

function nameBytesFromGitPath(pathBytes: Buffer): Buffer {
  const slash = pathBytes.lastIndexOf(0x2f);
  return slash < 0 ? pathBytes : Buffer.from(pathBytes.subarray(slash + 1));
}

export function validateReleaseInputs(
  projectRoot: string,
  phase: ReleaseInputPhase,
  meta: ReleaseInputMetaSeams = {},
): ReleaseInputResult {
  const folders = foldersForPhase(phase);
  const xbriefRoot = join(projectRoot, MIGRATED_ARTIFACT_DIR);
  let rootStat: ReturnType<typeof lstatSync> | null;
  try {
    rootStat = lstatOrNull(xbriefRoot);
  } catch {
    return fail("unsafe-node", MIGRATED_ARTIFACT_DIR);
  }

  if (rootStat == null) {
    let legacy: ReturnType<typeof lstatSync> | null;
    try {
      legacy = lstatOrNull(join(projectRoot, LEGACY_ARTIFACT_DIR));
    } catch {
      return fail("unsafe-node", LEGACY_ARTIFACT_DIR);
    }
    if (legacy !== null) return fail("legacy-only", LEGACY_ARTIFACT_DIR);
    return fail("missing-lifecycle-root", MIGRATED_ARTIFACT_DIR);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return fail("unsafe-node", MIGRATED_ARTIFACT_DIR);
  }

  const candidates = new Map<string, Candidate>();
  for (const folder of folders) {
    const bucket = join(xbriefRoot, folder);
    let st: ReturnType<typeof lstatSync> | null;
    try {
      st = lstatOrNull(bucket);
    } catch {
      return fail("unsafe-node", `${XBRIEF_PREFIX}${folder}`);
    }
    if (st == null) continue;
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return fail("unsafe-node", `${XBRIEF_PREFIX}${folder}`);
    }
    let names: Array<string | Buffer>;
    try {
      names = readdirSync(bucket, { encoding: "buffer" }) as unknown as Array<string | Buffer>;
    } catch {
      return fail("unsafe-node", `${XBRIEF_PREFIX}${folder}`);
    }
    for (const nameBuf of names) {
      const nameBytes = Buffer.isBuffer(nameBuf) ? nameBuf : Buffer.from(String(nameBuf), "utf8");
      if (!hasSuffixBytes(nameBytes)) continue;
      ensureCandidate(candidates, folder, nameBytes).fs = true;
    }
  }

  let headSha: string;
  try {
    headSha = runGitBytes(projectRoot, ["--no-replace-objects", "rev-parse", "HEAD"], 64 * 1024)
      .toString("utf8")
      .trim();
    if (!/^[0-9a-f]+$/i.test(headSha)) return fail("git-error", "HEAD");
  } catch {
    return fail("git-error", "HEAD");
  }

  const folderPathspecs = folders.map((f) => `${MIGRATED_ARTIFACT_DIR}/${f}`);
  let indexOut: Buffer;
  let treeOut: Buffer;
  try {
    indexOut = runGitBytes(
      projectRoot,
      ["ls-files", "--stage", "-z", "--", ...folderPathspecs],
      GIT_Z_LIST_MAX_BUFFER,
    );
    treeOut = runGitBytes(
      projectRoot,
      ["--no-replace-objects", "ls-tree", "-z", "-r", headSha, "--", ...folderPathspecs],
      GIT_Z_LIST_MAX_BUFFER,
    );
  } catch {
    return fail("git-error", "HEAD");
  }

  let indexRecords: Buffer[];
  let treeRecords: Buffer[];
  try {
    indexRecords = splitGitNulRecordsStrict(indexOut);
    treeRecords = splitGitNulRecordsStrict(treeOut);
  } catch {
    return fail("git-framing", "HEAD");
  }

  const folderSet = new Set(folders);
  for (const rec of indexRecords) {
    const parsed = parseStageRecord(rec);
    if (!parsed) return fail("git-framing", "index");
    const rel = gitPathText(parsed.pathBytes);
    const one = parseOneComponent(rel);
    if (!one || !folderSet.has(one.folder)) continue;
    const nameBytes = nameBytesFromGitPath(parsed.pathBytes);
    if (!hasSuffixBytes(nameBytes)) continue;
    const c = ensureCandidate(candidates, one.folder, nameBytes);
    c.index = true;
    c.indexCount += 1;
    c.indexMode = parsed.mode;
    c.indexOid = parsed.oid;
    c.indexStage = parsed.stage;
  }

  for (const rec of treeRecords) {
    const parsed = parseLsTreeRecord(rec);
    if (!parsed) return fail("git-framing", "HEAD");
    const rel = gitPathText(parsed.pathBytes);
    const one = parseOneComponent(rel);
    if (!one || !folderSet.has(one.folder)) continue;
    const nameBytes = nameBytesFromGitPath(parsed.pathBytes);
    if (!hasSuffixBytes(nameBytes)) continue;
    const c = ensureCandidate(candidates, one.folder, nameBytes);
    c.head = true;
    c.headMode = parsed.mode;
    c.headOid = parsed.oid;
    c.headType = parsed.type;
  }

  const selected = [...candidates.values()].sort((a, b) => a.display.localeCompare(b.display));
  const selectedPaths = selected.map((c) => c.display);
  if (selected.length === 0) {
    return {
      ok: true,
      exitCode: EXIT_OK,
      code: "ok",
      violations: [],
      selectedPaths,
      payloadReads: 0,
    };
  }

  const violations: ReleaseInputViolation[] = [];
  const readable: Candidate[] = [];
  for (const c of selected) {
    if (utf8RoundTrip(c.nameBytes) === null) {
      violations.push({
        code: "unsupported-path-encoding",
        path: c.display,
        remedy: remedyFor("unsupported-path-encoding"),
      });
      continue;
    }
    const name = c.nameBytes.toString("utf8");
    if (!hasArtifactSuffix(name)) {
      violations.push({
        code: "unsupported-name",
        path: c.display,
        remedy: remedyFor("unsupported-name"),
      });
      continue;
    }
    if (!c.fs || !c.index || !c.head) {
      const code = c.fs && !c.index && !c.head ? "untracked" : "missing-view";
      violations.push({ code, path: c.display, remedy: remedyFor(code) });
      continue;
    }
    if (c.indexCount !== 1 || c.indexStage !== 0) {
      violations.push({ code: "unmerged", path: c.display, remedy: remedyFor("unmerged") });
      continue;
    }
    if (
      c.headType !== "blob" ||
      c.headMode === null ||
      !REGULAR_FILE_MODES.has(c.headMode) ||
      c.indexMode === null ||
      !REGULAR_FILE_MODES.has(c.indexMode)
    ) {
      violations.push({ code: "unsafe-node", path: c.display, remedy: remedyFor("unsafe-node") });
      continue;
    }
    if (c.indexMode !== c.headMode || c.indexOid !== c.headOid) {
      violations.push({ code: "staged", path: c.display, remedy: remedyFor("staged") });
      continue;
    }
    const abs = join(projectRoot, MIGRATED_ARTIFACT_DIR, c.folder, name);
    let leaf: ReturnType<typeof lstatSync> | null;
    try {
      leaf = lstatOrNull(abs);
    } catch {
      violations.push({ code: "unsafe-node", path: c.display, remedy: remedyFor("unsafe-node") });
      continue;
    }
    if (leaf == null || leaf.isSymbolicLink() || !leaf.isFile()) {
      const code = leaf == null ? "missing-view" : "unsafe-node";
      violations.push({ code, path: c.display, remedy: remedyFor(code) });
      continue;
    }
    readable.push(c);
  }

  const firstViolation = violations[0];
  if (firstViolation !== undefined) {
    return failMany(firstViolation.code, violations, selectedPaths);
  }

  let diskTotal = 0;
  let headTotal = 0;
  const diskSizes = new Map<string, number>();
  const uniqueOids: string[] = [];
  const oidSeen = new Set<string>();
  for (const c of readable) {
    const name = c.nameBytes.toString("utf8");
    const abs = join(projectRoot, MIGRATED_ARTIFACT_DIR, c.folder, name);
    const diskSize = meta.diskSizeOf?.(abs) ?? lstatSync(abs).size;
    if (diskSize > RELEASE_INPUT_PER_FILE_MAX_BYTES) {
      return fail("oversized", c.display, { selectedPaths, payloadReads: 0 });
    }
    diskSizes.set(c.rel, diskSize);
    diskTotal += diskSize;
    const oid = c.headOid as string;
    if (!oidSeen.has(oid)) {
      oidSeen.add(oid);
      uniqueOids.push(oid);
    }
  }
  const firstSelected = selected[0];
  if (firstSelected === undefined) {
    return {
      ok: true,
      exitCode: EXIT_OK,
      code: "ok",
      violations: [],
      selectedPaths,
      payloadReads: 0,
    };
  }
  if (diskTotal > RELEASE_INPUT_PER_VIEW_MAX_BYTES) {
    return fail("oversized", firstSelected.display, { selectedPaths, payloadReads: 0 });
  }

  const allHeadInjected =
    uniqueOids.length > 0 && uniqueOids.every((oid) => meta.headBlobSizeOf?.(oid) !== undefined);
  let headMeta = new Map<string, { type: string; size: number }>();
  if (allHeadInjected) {
    for (const oid of uniqueOids) {
      headMeta.set(oid, { type: "blob", size: meta.headBlobSizeOf?.(oid) as number });
    }
  } else if (uniqueOids.length > 0) {
    try {
      const checkOut = runGitBytes(
        projectRoot,
        ["--no-replace-objects", "cat-file", "--batch-check"],
        GIT_Z_LIST_MAX_BUFFER,
        Buffer.from(`${uniqueOids.join("\n")}\n`, "utf8"),
      );
      headMeta = parseCatFileCheck(checkOut, uniqueOids);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("oversized")) return fail("oversized", "HEAD", { selectedPaths });
      return fail("git-error", "HEAD", { selectedPaths });
    }
  }

  for (const c of readable) {
    const row = headMeta.get(c.headOid as string);
    const size = meta.headBlobSizeOf?.(c.headOid as string) ?? row?.size;
    if (size === undefined || (row && row.type !== "blob")) {
      return fail(row && row.type !== "blob" ? "unsafe-node" : "git-error", c.display, {
        selectedPaths,
      });
    }
    if (size > RELEASE_INPUT_PER_FILE_MAX_BYTES) {
      return fail("oversized", c.display, { selectedPaths, payloadReads: 0 });
    }
    headTotal += size;
  }
  if (headTotal > RELEASE_INPUT_PER_VIEW_MAX_BYTES) {
    return fail("oversized", firstSelected.display, { selectedPaths, payloadReads: 0 });
  }

  let payloads = new Map<string, Buffer>();
  if (uniqueOids.length > 0) {
    try {
      const batch = runGitBytes(
        projectRoot,
        ["--no-replace-objects", "cat-file", "--batch"],
        RELEASE_INPUT_PER_VIEW_MAX_BYTES + CAT_FILE_FRAMING_BUDGET_BYTES,
        Buffer.from(`${uniqueOids.join("\n")}\n`, "utf8"),
      );
      payloads = parseCatFileBatch(batch, uniqueOids);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("oversized")) return fail("oversized", "HEAD", { selectedPaths });
      return fail("git-error", "HEAD", { selectedPaths });
    }
  }

  let payloadReads = 0;
  for (const c of readable) {
    const name = c.nameBytes.toString("utf8");
    const abs = join(projectRoot, MIGRATED_ARTIFACT_DIR, c.folder, name);
    let disk: Buffer;
    try {
      disk = readFileSync(abs);
    } catch {
      return fail("unsafe-node", c.display, { selectedPaths, payloadReads });
    }
    payloadReads += 1;
    if (disk.length > RELEASE_INPUT_PER_FILE_MAX_BYTES) {
      return fail("oversized", c.display, { selectedPaths, payloadReads });
    }
    const declared = diskSizes.get(c.rel);
    if (declared !== undefined && disk.length !== declared) {
      return fail("uncommitted", c.display, { selectedPaths, payloadReads });
    }
    const head = payloads.get(c.headOid as string);
    if (!head) return fail("git-error", c.display, { selectedPaths, payloadReads });
    payloadReads += 1;
    if (head.length > RELEASE_INPUT_PER_FILE_MAX_BYTES) {
      return fail("oversized", c.display, { selectedPaths, payloadReads });
    }
    if (!loneLfEquals(head, disk)) {
      return fail("uncommitted", c.display, { selectedPaths, payloadReads });
    }
  }

  return {
    ok: true,
    exitCode: EXIT_OK,
    code: "ok",
    violations: [],
    selectedPaths,
    payloadReads,
  };
}
