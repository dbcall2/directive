import { describe, expect, it } from "vitest";
import {
  evaluateWorkerInstallationPermissions,
  mintDestWorkerInstallationToken,
  WORKER_INSTALLATION_PERMISSION_ALLOWLIST,
} from "./dest-token.js";

describe("dest-placed worker installation token allowlist", () => {
  it("refuses omitted permissions", () => {
    const d = evaluateWorkerInstallationPermissions({});
    expect(d.ok).toBe(false);
    expect(d.code).toBe("deny-permissions-omitted");
  });

  it("refuses extra pull_requests / checks / administration", () => {
    const d = evaluateWorkerInstallationPermissions({
      requested: { ...WORKER_INSTALLATION_PERMISSION_ALLOWLIST, pull_requests: "write" },
    });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("deny-forbidden-permission");
  });

  it("accepts contents:write issues:none and verifies returned permissions", () => {
    const d = evaluateWorkerInstallationPermissions({
      requested: { ...WORKER_INSTALLATION_PERMISSION_ALLOWLIST },
      returned: { ...WORKER_INSTALLATION_PERMISSION_ALLOWLIST },
    });
    expect(d.ok).toBe(true);
    expect(d.code).toBe("allow-allowlist");
  });

  it("refuses when GitHub returns extra permissions", () => {
    const d = evaluateWorkerInstallationPermissions({
      requested: { ...WORKER_INSTALLATION_PERMISSION_ALLOWLIST },
      returned: { ...WORKER_INSTALLATION_PERMISSION_ALLOWLIST, administration: "write" },
    });
    expect(d.ok).toBe(false);
  });

  it("mintDestWorkerInstallationToken refuses omitted permissions before calling GitHub", () => {
    expect(() =>
      mintDestWorkerInstallationToken({}, () => {
        throw new Error("should not mint");
      }),
    ).toThrow(/omitted/);
  });
});
