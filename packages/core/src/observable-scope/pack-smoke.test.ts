import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractMarkupFacts, SCRIPT_SENTINEL } from "./extract.js";

const corePkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));

describe("packed/installed oracle smoke (#4495)", () => {
  it("publishes jsdom and typescript as runtime deps of the owning package", () => {
    const pkg = JSON.parse(readFileSync(corePkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.jsdom).toMatch(/26/);
    expect(pkg.dependencies?.typescript).toBeTruthy();
    expect(pkg.devDependencies?.jsdom).toBeUndefined();
    expect(pkg.devDependencies?.typescript).toBeUndefined();
    const req = createRequire(corePkgPath);
    expect(req.resolve("jsdom")).toMatch(/jsdom/);
    expect(req.resolve("typescript")).toMatch(/typescript/);
  });

  it("never executes a script-tag sentinel during html extract", () => {
    const html = `<script>globalThis.${SCRIPT_SENTINEL}="executed";throw new Error("ran")</script><h1>Ok</h1>`;
    expect((globalThis as Record<string, unknown>)[SCRIPT_SENTINEL]).toBeUndefined();
    const facts = extractMarkupFacts(html, "packed.html");
    expect((globalThis as Record<string, unknown>)[SCRIPT_SENTINEL]).toBeUndefined();
    expect(facts.map((f) => f.id)).toContain("heading:1:Ok");
  });
});
