import { describe, expect, it } from "vitest";
import { classifyHtmlUrlsForTest } from "./html.js";

describe("html classify (#5080)", () => {
  it("refuses collector srcset tokens and continues same-origin forms", () => {
    const bad = classifyHtmlUrlsForTest(
      `<img srcset="/safe.png 1x, https://collector.example/p 2x">`,
    );
    expect(bad.ok).toBe(true);
    if (bad.ok) expect(bad.facts.length).toBeGreaterThan(0);
    const ok = classifyHtmlUrlsForTest(`<form method="get" action="/search"></form>`);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.facts.filter((f) => f.rule === "item-3")).toEqual([]);
  });

  it("refuses noscript and formmethod regardless of value", () => {
    const n = classifyHtmlUrlsForTest(`<noscript><p>x</p></noscript>`);
    expect(n.ok && n.facts.some((f) => f.id.includes("noscript"))).toBe(true);
    const m = classifyHtmlUrlsForTest(`<button formmethod="post">x</button>`);
    expect(m.ok && m.facts.some((f) => f.id.includes("formmethod"))).toBe(true);
  });

  it("does not treat title/alt/aria text as a request-capable URL", () => {
    const r = classifyHtmlUrlsForTest(
      `<img alt="https://example.com/img.png" title="See https://example.com" aria-label="https://example.com">`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.facts.filter((f) => f.rule === "item-3")).toEqual([]);
    const href = classifyHtmlUrlsForTest(`<a href="https://example.com">x</a>`);
    expect(href.ok && href.facts.length > 0).toBe(true);
  });
});
