import { describe, expect, it } from "vitest";
import { evaluateDurableEffectAcquisition } from "./evaluate.js";
import { classifyHtmlUrlsForTest } from "./html.js";
import { classifyTsxSource, loadProjectTypeScript } from "./jsx.js";
import { PRESENTATION_CEILING_ARTIFACT_REL, PRESENTATION_CEILING_SCHEMA } from "./types.js";

const CEILING = `${JSON.stringify({
  schema: PRESENTATION_CEILING_SCHEMA,
  changeClass: "presentation",
})}\n`;

function ev(
  head: Record<string, string>,
  extra?: { base?: Record<string, string>; presentation?: string[] },
) {
  const changed = Object.keys(head);
  const baseFiles: Record<string, string> = {
    [PRESENTATION_CEILING_ARTIFACT_REL]: CEILING,
    ...(extra?.base ?? {}),
  };
  return evaluateDurableEffectAcquisition({
    projectRoot: process.cwd(),
    mergeBase: "injected",
    changedFiles: changed,
    presentationFiles: extra?.presentation ?? changed.filter((p) => /\.(html|jsx|tsx)$/i.test(p)),
    readAtBase: (rel) => baseFiles[rel] ?? null,
    readAtHead: (rel) => head[rel] ?? baseFiles[rel] ?? null,
  });
}

function tsx(source: string) {
  const ts = loadProjectTypeScript(process.cwd());
  if (!ts.ok) throw new Error(ts.detail);
  return classifyTsxSource("src/A.tsx", source, {
    ts: ts.ts,
    admittedOrigins: [],
    admittedPackages: [],
    admittedPaths: [],
  });
}

describe("bound table HTML (#5080 item 11)", () => {
  it("refuses decoded protocol-relative and collector srcset tokens", () => {
    expect(classifyHtmlUrlsForTest(`<form action="&#47;&#47;collector.example/c">`).ok).toBe(true);
    const a = classifyHtmlUrlsForTest(`<form action="&#47;&#47;collector.example/c">`);
    expect(a.ok && a.facts.length > 0).toBe(true);
    const s = classifyHtmlUrlsForTest(
      `<img srcset="/safe.png 1x, https://collector.example/p?u=demo 2x">`,
    );
    expect(s.ok && s.facts.length > 0).toBe(true);
    const n = classifyHtmlUrlsForTest(`<img src="https:/&#10;/collector.example/p?u=demo">`);
    expect(n.ok && n.facts.length > 0).toBe(true);
  });

  it("continues ordinary same-origin and non-request schemes", () => {
    const html = `<a href="/search?q=a:b"></a><img src="/img/a.png" srcset="/a.png 1x, /b.png 2x"><form action="/search"></form><a href="mailto:hi@example.com"></a>`;
    const r = classifyHtmlUrlsForTest(html);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.facts.filter((f) => f.rule === "item-3")).toEqual([]);
  });

  it("refuses template contents and picture source srcset", () => {
    const t = classifyHtmlUrlsForTest(
      `<template><img src="https://collector.example/t.png"></template>`,
    );
    expect(t.ok && t.facts.length > 0).toBe(true);
    const p = classifyHtmlUrlsForTest(
      `<picture><source srcset="//collector.example/a.png 1x"></picture>`,
    );
    expect(p.ok && p.facts.length > 0).toBe(true);
  });
});

describe("bound table JSX (#5080 item 11)", () => {
  it("refuses formMethod, post forms, unpinned template heads", () => {
    expect(tsx(`export const B = () => <button formMethod="post">x</button>;`).ok).toBe(true);
    const a = tsx(`export const B = () => <button formMethod="post">x</button>;`);
    expect(a.ok && a.facts.length > 0).toBe(true);
    const b = tsx(`export const F = () => <form method="post" />;`);
    expect(b.ok && b.facts.length > 0).toBe(true);
    const c = tsx(`export const A = (p: {x: string}) => <a href={\`/\${p.x}\`} />;`);
    expect(c.ok && c.facts.length > 0).toBe(true);
  });

  it("refuses component child collector URL and continues same-origin child", () => {
    const bad =
      tsx(`function Photo({ children }: { children?: unknown }) { return <img src={children as string} />; }
export const P = () => <Photo>https://collector.example/p</Photo>;`);
    expect(bad.ok && bad.facts.length > 0).toBe(true);
    const ok =
      tsx(`function Photo({ children }: { children?: unknown }) { return <img src={children as string} />; }
export const P = () => <Photo>/img/a.png</Photo>;`);
    expect(ok.ok && (ok as { facts: unknown[] }).facts.length === 0).toBe(true);
  });

  it("refuses derived a+b and continues identity/member forwarding", () => {
    const bad =
      tsx(`function Photo({ a, b }: { a: string; b: string }) { return <img src={a + b} />; }
export const P = () => <Photo a="https" b="://collector.example/p" />;`);
    expect(bad.ok && bad.facts.length > 0).toBe(true);
    const ok =
      tsx(`function Photo({ a, item }: { a: string; item: { src: string } }) { return <><img src={a} /><img src={item.src} /></>; }
export const P = () => <Photo a="/img/a.png" item={{ src: "/img/b.png" }} />;`);
    expect(ok.ok && (ok as { facts: unknown[] }).facts.length === 0).toBe(true);
  });

  it("refuses emitter-kept &sol; and continues &amp; query", () => {
    const bad = tsx(
      `export const I = () => <img src="https://deft.invalid&sol;.collector.example/p" />;`,
    );
    expect(bad.ok && bad.facts.length > 0).toBe(true);
    const ok = tsx(`export const A = () => <a href="/search?a=1&amp;b=2" />;`);
    expect(ok.ok && (ok as { facts: unknown[] }).facts.length === 0).toBe(true);
  });

  it("classifies local srcSet suffix initializers", () => {
    const bad = tsx(`const suffix = ", https://collector.example/p 2x";
export const I = () => <img srcSet={\`/img/\${suffix}\`} />;`);
    expect(bad.ok && bad.facts.length > 0).toBe(true);
    const ok = tsx(`const suffix = "a.png 1x, /img/b.png 2x";
export const I = () => <img srcSet={\`/img/\${suffix}\`} />;`);
    expect(ok.ok && (ok as { facts: unknown[] }).facts.length === 0).toBe(true);
  });

  it("refuses srcSet templates whose static head contains a list boundary", () => {
    const bad = tsx(`function Photo({ scheme }: { scheme: string }) {
  return <img srcSet={\`/img/a.png 1x, \${scheme}://collector.example/p 2x\`} />;
}
export const P = () => <Photo scheme="https" />;`);
    expect(bad.ok && bad.facts.length > 0).toBe(true);
  });

  it("refuses SVG onbegin and html onclick storage", () => {
    const a = tsx(`export const S = () => <animate onbegin="localStorage.setItem('k','v')" />;`);
    expect(a.ok && a.facts.length > 0).toBe(true);
    const b = tsx(
      `export const B = () => <button onclick="localStorage.setItem('k','v')">x</button>;`,
    );
    expect(b.ok && b.facts.length > 0).toBe(true);
  });

  it("refuses host spreads and continues forwarded props", () => {
    const bad = tsx(`const attrs = { method: "post", action: "/save" };
export const F = () => <form {...attrs} />;`);
    expect(bad.ok && bad.facts.length > 0).toBe(true);
    const ok = tsx(
      `export const I = (props: { src: string; onSelect: () => void }) => <img src={props.src} onClick={props.onSelect} />;`,
    );
    expect(ok.ok && (ok as { facts: unknown[] }).facts.length === 0).toBe(true);
  });

  it("continues Map in-memory residual and pinned-head templates", () => {
    const ok = tsx(`const cache = new Map();
export const A = (p: { q: string; item: { id: string } }) => (
  <>
    <a href={\`/search?q=\${p.q}\`} />
    <img src={\`/img/\${p.item.id}.png\`} />
    <span>{String(cache.size)}</span>
  </>
);`);
    expect(ok.ok && (ok as { facts: unknown[] }).facts.length === 0).toBe(true);
  });
});

describe("evaluate table rows (#5080)", () => {
  it("refuses cookie assignment, POST fetch, host-runtime, and out-of-class save import", () => {
    expect(ev({ "src/A.tsx": "export function f(){ document.cookie = 'a=1'; }\n" }).code).toBe(1);
    expect(
      ev({ "src/A.tsx": "export function f(){ void fetch('/api/orders', { method: 'POST' }); }\n" })
        .code,
    ).toBe(1);
    expect(
      ev({
        "src/A.tsx":
          "export const B = () => <button onClick={(e) => e.view.localStorage.setItem('k','v')}>x</button>;\n",
      }).code,
    ).toBe(1);
    expect(
      ev({
        "src/A.tsx":
          "import { save } from '@/lib/save';\nexport const B = () => <button onClick={() => save()}>x</button>;\n",
      }).code,
    ).toBe(1);
  });

  it("continues className-only when a pre-existing import is unchanged", () => {
    const srcBase = `import { save } from '@/lib/save';\nexport const B = () => <button className="a">x</button>;\n`;
    const srcHead = `import { save } from '@/lib/save';\nexport const B = () => <button className="b">x</button>;\n`;
    const result = ev({ "src/A.tsx": srcHead }, { base: { "src/A.tsx": srcBase } });
    expect(result.code).toBe(0);
  });

  it("admits a merge-base origin amendment for an own-domain absolute link", () => {
    const ceiling = `${JSON.stringify({
      schema: PRESENTATION_CEILING_SCHEMA,
      changeClass: "presentation",
      admittedOrigins: ["https://example.com"],
      humanApproval: { kind: "human", actor: "David", mintedAt: "2026-09-28T00:00:00Z" },
    })}\n`;
    const result = evaluateDurableEffectAcquisition({
      projectRoot: process.cwd(),
      mergeBase: "injected",
      changedFiles: ["src/A.tsx"],
      presentationFiles: ["src/A.tsx"],
      readAtBase: (rel) => (rel === PRESENTATION_CEILING_ARTIFACT_REL ? ceiling : null),
      readAtHead: (rel) =>
        rel === "src/A.tsx"
          ? `export const A = () => <a href="https://example.com/docs">d</a>;\n`
          : rel === PRESENTATION_CEILING_ARTIFACT_REL
            ? ceiling
            : null,
    });
    expect(result.code).toBe(0);
  });

  it("admits a merge-base package allowlist npm import", () => {
    const ceiling = `${JSON.stringify({
      schema: PRESENTATION_CEILING_SCHEMA,
      changeClass: "presentation",
      admittedPackages: ["clsx"],
      humanApproval: { kind: "human", actor: "David", mintedAt: "2026-09-28T00:00:00Z" },
    })}\n`;
    const result = evaluateDurableEffectAcquisition({
      projectRoot: process.cwd(),
      mergeBase: "injected",
      changedFiles: ["src/A.tsx"],
      presentationFiles: ["src/A.tsx"],
      readAtBase: (rel) => (rel === PRESENTATION_CEILING_ARTIFACT_REL ? ceiling : null),
      readAtHead: (rel) =>
        rel === "src/A.tsx"
          ? `import clsx from 'clsx';\nexport const A = () => <div className="a" />;\n`
          : rel === PRESENTATION_CEILING_ARTIFACT_REL
            ? ceiling
            : null,
    });
    expect(result.code).toBe(0);
  });
});
