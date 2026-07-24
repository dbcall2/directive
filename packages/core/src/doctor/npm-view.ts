import { spawnSync } from "node:child_process";
import { NPM_PACKAGE_NAME, PUBLIC_NPM_REGISTRY } from "./constants.js";

export interface NpmViewVersionResult {
  readonly ok: boolean;
  readonly version: string;
}

/**
 * Query the canonical public registry for the latest published Directive
 * version, independent of the consumer's configured corporate mirror.
 */
export function defaultNpmViewVersion(): NpmViewVersionResult {
  try {
    const proc = spawnSync(
      "npm",
      [
        "view",
        NPM_PACKAGE_NAME,
        "version",
        `--registry=${PUBLIC_NPM_REGISTRY}`,
        "--ignore-scripts",
      ],
      {
        encoding: "utf8",
        shell: false,
        timeout: 15_000,
        windowsHide: true,
      },
    );
    if (proc.error !== undefined || proc.status !== 0) {
      return { ok: false, version: "" };
    }
    const version =
      (typeof proc.stdout === "string" ? proc.stdout : "").trim().split("\n")[0]?.trim() ?? "";
    return { ok: version.length > 0, version };
  } catch {
    return { ok: false, version: "" };
  }
}
