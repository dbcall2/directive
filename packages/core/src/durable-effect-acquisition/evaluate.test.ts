import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateDurableEffectAcquisition, readLivePresentationSource } from "./evaluate.js";
import { PRESENTATION_CEILING_ARTIFACT_REL, PRESENTATION_CEILING_SCHEMA } from "./types.js";

const CEILING = `${JSON.stringify({
  schema: PRESENTATION_CEILING_SCHEMA,
  changeClass: "presentation",
})}\n`;

function files(head: Record<string, string>, base?: Record<string, string>) {
  const changed = Object.keys(head);
  const baseFiles: Record<string, string> = {
    [PRESENTATION_CEILING_ARTIFACT_REL]: CEILING,
    ...(base ?? {}),
  };
  return {
    projectRoot: process.cwd(),
    mergeBase: "injected",
    changedFiles: changed,
    presentationFiles: changed.filter((p) => /\.(html|jsx|tsx)$/i.test(p)),
    readAtBase: (rel: string) => baseFiles[rel] ?? null,
    readAtHead: (rel: string) => head[rel] ?? baseFiles[rel] ?? null,
  };
}

describe("evaluateDurableEffectAcquisition (#5080)", () => {
  it("passes off-ceiling in-class localStorage", () => {
    const result = evaluateDurableEffectAcquisition({
      projectRoot: process.cwd(),
      mergeBase: "injected",
      changedFiles: ["src/Prefs.tsx"],
      presentationFiles: ["src/Prefs.tsx"],
      readAtBase: () => null,
      readAtHead: (rel) =>
        rel === "src/Prefs.tsx" ? "export function f(){ localStorage.setItem('k','v'); }\n" : null,
    });
    expect(result.code).toBe(0);
    expect(result.message).toMatch(/off-ceiling/);
  });

  it("refuses localStorage under an armed ceiling", () => {
    const result = evaluateDurableEffectAcquisition(
      files({ "src/Prefs.tsx": "export function f(){ localStorage.setItem('k','v'); }\n" }),
    );
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/durable-effect/);
  });

  it("refuses submitter formMethod", () => {
    const result = evaluateDurableEffectAcquisition(
      files({ "src/Form.tsx": 'export const B = () => <button formMethod="post">Go</button>;\n' }),
    );
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/formMethod|formmethod|item-4/i);
  });

  it("refuses a non-sentinel base anywhere in-class", () => {
    const result = evaluateDurableEffectAcquisition({
      ...files({
        "src/Search.tsx": 'export const F = () => <form method="get" action="collect" />;\n',
      }),
      presentationFiles: ["index.html", "src/Search.tsx"],
      readAtBase: (rel) =>
        rel === PRESENTATION_CEILING_ARTIFACT_REL
          ? CEILING
          : rel === "index.html"
            ? '<base href="https://collector.example/">\n'
            : null,
      readAtHead: (rel) =>
        rel === "src/Search.tsx"
          ? 'export const F = () => <form method="get" action="collect" />;\n'
          : rel === PRESENTATION_CEILING_ARTIFACT_REL
            ? CEILING
            : rel === "index.html"
              ? '<base href="https://collector.example/">\n'
              : null,
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/base/i);
  });

  it("cannot disarm by deleting the merge-base ceiling", () => {
    const result = evaluateDurableEffectAcquisition({
      projectRoot: process.cwd(),
      mergeBase: "injected",
      changedFiles: ["src/Prefs.tsx", PRESENTATION_CEILING_ARTIFACT_REL],
      presentationFiles: ["src/Prefs.tsx"],
      readAtBase: (rel) =>
        rel === PRESENTATION_CEILING_ARTIFACT_REL
          ? CEILING
          : rel === "src/Prefs.tsx"
            ? "export const A = () => <div />;\n"
            : null,
      readAtHead: (rel) =>
        rel === "src/Prefs.tsx" ? "export function f(){ localStorage.setItem('k','v'); }\n" : null,
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/durable-effect|localStorage|js-root/i);
  });

  it("refuses same-PR allowlist widening", () => {
    const result = evaluateDurableEffectAcquisition({
      projectRoot: process.cwd(),
      mergeBase: "injected",
      changedFiles: [PRESENTATION_CEILING_ARTIFACT_REL, "src/A.tsx"],
      presentationFiles: ["src/A.tsx"],
      readAtBase: (rel) =>
        rel === PRESENTATION_CEILING_ARTIFACT_REL
          ? CEILING
          : rel === "src/A.tsx"
            ? 'export const A = () => <a href="/x" />;\n'
            : null,
      readAtHead: (rel) =>
        rel === PRESENTATION_CEILING_ARTIFACT_REL
          ? `${JSON.stringify({
              schema: PRESENTATION_CEILING_SCHEMA,
              changeClass: "presentation",
              admittedOrigins: ["https://example.com"],
            })}\n`
          : rel === "src/A.tsx"
            ? 'export const A = () => <a href="/x" />;\n'
            : null,
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/allowlist/);
  });

  it("ignores head-only admitted origins on an add-only ceiling", () => {
    const headCeiling = `${JSON.stringify({
      schema: PRESENTATION_CEILING_SCHEMA,
      changeClass: "presentation",
      admittedOrigins: ["https://example.com"],
    })}\n`;
    const result = evaluateDurableEffectAcquisition({
      projectRoot: process.cwd(),
      mergeBase: "injected",
      changedFiles: [PRESENTATION_CEILING_ARTIFACT_REL, "src/A.tsx"],
      presentationFiles: ["src/A.tsx"],
      readAtBase: () => null,
      readAtHead: (rel) =>
        rel === PRESENTATION_CEILING_ARTIFACT_REL
          ? headCeiling
          : rel === "src/A.tsx"
            ? 'export const A = () => <a href="https://example.com/docs">d</a>;\n'
            : null,
    });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/durable-effect|origin|example.com/i);
  });

  it("continues a same-origin ordinary page under a ceiling", () => {
    const src = `export const Page = () => (
  <main>
    <a href="/search?q=a:b">s</a>
    <img src="/img/a.png" srcSet="/a.png 1x, /b.png 2x" />
    <form action="/search"><button>ok</button></form>
    <link rel="stylesheet" href="/app.css" />
    <meta httpEquiv="content-type" content="text/html" />
  </main>
);
`;
    const result = evaluateDurableEffectAcquisition(files({ "src/Page.tsx": src }));
    expect(result.code).toBe(0);
    expect(result.message).toMatch(/pass/);
  });

  it("refuses a second POST form as a new channel", () => {
    const one = `<form method="post" action="/a"></form>\n`;
    const two = `<form method="post" action="/a"></form>\n<form method="post" action="/b"></form>\n`;
    const result = evaluateDurableEffectAcquisition(
      files({ "src/A.html": two }, { "src/A.html": one }),
    );
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/form-method|durable-effect/);
  });

  it("reads working-tree bytes before committed HEAD", () => {
    const root = mkdtempSync(join(tmpdir(), "dea-live-"));
    try {
      execFileSync("git", ["init", "-b", "master"], { cwd: root, stdio: "ignore" });
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/A.tsx"), "export const A = () => <a href='/ok' />;\n");
      execFileSync("git", ["add", "src/A.tsx"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-m", "a"], {
        cwd: root,
        stdio: "ignore",
      });
      writeFileSync(
        join(root, "src/A.tsx"),
        "export const A = () => <a href='https://collector.example/p' />;\n",
      );
      const live = readLivePresentationSource(root, "src/A.tsx");
      expect(live).toContain("collector.example");
      expect(live).not.toContain("/ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
