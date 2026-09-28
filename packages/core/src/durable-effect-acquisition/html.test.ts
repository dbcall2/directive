import { describe, expect, it } from "vitest";
import { classifyHtmlDocument, classifyHtmlUrlsForTest } from "./html.js";

describe("html classify (#5080)", () => {
  it("supplies inline handlers and scripts to the executable analyzer", () => {
    const seen: string[] = [];
    const result = classifyHtmlDocument(
      '<p onclick="save()"></p><script>write()</script><script> </script>',
      {
        admittedOrigins: [],
        jsFacts: (source, via) => {
          seen.push(`${via}:${source}`);
          return [{ id: source, rule: "item-2", detail: via }];
        },
      },
    );
    expect(result.ok && result.facts.length).toBe(2);
    expect(seen).toContain("handler:onclick:save()");
    expect(seen).toContain("script:write()");
  });
  it.each([
    "<iframe></iframe>",
    "<embed>",
    "<object></object>",
    '<script src="/a.js"></script>',
    '<style>@import "/a.css";</style>',
    "<style>.a{color:\\72 ed}</style>",
    '<div style="background:url(/a.png)"></div>',
    '<div style="color:\\72 ed"></div>',
    '<meta http-equiv="refresh" content="0;url=/a">',
    '<a ping="/a">a</a>',
    '<div srcdoc="hello"></div>',
    '<body background="https://collector.example/p">',
    '<my-card title="https://collector.example/p"></my-card>',
    '<svg><image xlink:href="https://collector.example/p"/></svg>',
    '<template><img src="https://collector.example/p"></template>',
  ])("refuses preserved markup channel %s", (source) => {
    const r = classifyHtmlUrlsForTest(source);
    expect(r.ok && r.facts.length > 0).toBe(true);
  });
  it.each([
    '<base href="/">',
    '<meta http-equiv="content-type" content="text/html">',
    "<style>.a{color:red}</style>",
    '<div style="color:blue"></div>',
    "<p>Text <span>nested</span></p>",
    '<base><meta charset="utf-8"><meta httpequiv="content-type"><x:tag x:title="/safe" on="/safe"/>',
  ])("continues harmless HTML %s", (source) => {
    const r = classifyHtmlUrlsForTest(source);
    expect(r.ok && r.facts.length === 0).toBe(true);
  });
  it("refuses incomplete HTML and retains duplicate embedded channels", () => {
    expect(classifyHtmlUrlsForTest('<img src="unterminated').ok).toBe(false);
    const one = classifyHtmlUrlsForTest("<iframe></iframe>");
    const two = classifyHtmlUrlsForTest("<iframe></iframe><iframe></iframe>");
    expect(one.ok && two.ok && two.facts.length === one.facts.length * 2).toBe(true);
  });
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
