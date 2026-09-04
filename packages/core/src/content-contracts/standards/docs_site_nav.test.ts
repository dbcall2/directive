import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readText, repoRoot } from "./_helpers.js";

/**
 * Canonical public nav inventory for docs-site (#4100 / #2906 keep matrix).
 * HTML primary-bar links must equal this list. Best practices is dropped.
 * Architecture is maintainer-tier, not a consumer-nav page.
 */
export const DOCS_SITE_PRIMARY_NAV = [
  { href: "index.html", label: "What it is" },
  { href: "install.html", label: "Install" },
  { href: "concepts.html", label: "Concepts" },
  { href: "gates.html", label: "Gates" },
  { href: "upgrade.html", label: "Upgrade" },
  { href: "license.html", label: "License" },
] as const;

const PRIMARY_NAV_RE = /<nav class="nav" aria-label="Primary">([\s\S]*?)<\/nav>/i;
const NAV_LINK_RE = /<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

function htmlPages(): string[] {
  return readdirSync(join(repoRoot(), "docs-site"))
    .filter((name) => name.endsWith(".html"))
    .sort();
}

function primaryNav(html: string): Array<{ href: string; label: string }> {
  const block = html.match(PRIMARY_NAV_RE)?.[1];
  expect(block, 'missing <nav aria-label="Primary">').toBeTruthy();
  const links: Array<{ href: string; label: string }> = [];
  const re = new RegExp(NAV_LINK_RE.source, NAV_LINK_RE.flags);
  let match: RegExpExecArray | null = re.exec(block ?? "");
  while (match) {
    links.push({
      href: match[1] ?? "",
      label: (match[2] ?? "").replace(/\s+/g, " ").trim(),
    });
    match = re.exec(block ?? "");
  }
  return links;
}

describe("docs-site canonical nav inventory (#4100)", () => {
  it("every inventory route exists as a docs-site HTML page", () => {
    const pages = new Set(htmlPages());
    for (const item of DOCS_SITE_PRIMARY_NAV) {
      expect(pages.has(item.href), `inventory route missing file: ${item.href}`).toBe(true);
    }
  });

  it("every docs-site HTML page is in the canonical inventory", () => {
    const inventory = new Set(DOCS_SITE_PRIMARY_NAV.map((item) => item.href));
    for (const page of htmlPages()) {
      expect(inventory.has(page), `HTML page missing from inventory: ${page}`).toBe(true);
    }
  });

  it("each page primary nav equals the inventory in order", () => {
    for (const page of htmlPages()) {
      const nav = primaryNav(readText(`docs-site/${page}`));
      expect(
        nav.map((item) => ({ href: item.href, label: item.label })),
        `primary nav drift on ${page}`,
      ).toEqual(DOCS_SITE_PRIMARY_NAV.map((item) => ({ href: item.href, label: item.label })));
    }
  });

  it("does not put Best practices or Architecture on the primary bar", () => {
    for (const page of htmlPages()) {
      const nav = primaryNav(readText(`docs-site/${page}`));
      const haystack = nav.map((item) => `${item.href} ${item.label}`).join("\n");
      expect(haystack, `${page} primary nav includes Best practices`).not.toMatch(
        /best\s*practices/i,
      );
      expect(haystack, `${page} primary nav includes Architecture`).not.toMatch(/architecture/i);
    }
  });

  it("index names extra journeys outside the primary bar", () => {
    const index = readText("docs-site/index.html");
    const nav = primaryNav(index);
    expect(nav.some((item) => /getting-started|SUPPORT|capabilities/i.test(item.href))).toBe(false);
    expect(index).toContain("content/docs/getting-started.md");
    expect(index).toContain("content/docs/SUPPORT.md");
    expect(index).toContain("content/docs/capabilities.md");
  });
});
