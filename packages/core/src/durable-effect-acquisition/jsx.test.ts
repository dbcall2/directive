import { describe, expect, it } from "vitest";
import { classifyTsxSource, loadProjectTypeScript } from "./jsx.js";

function run(source: string) {
  const ts = loadProjectTypeScript(process.cwd());
  if (!ts.ok) throw new Error(ts.detail);
  return classifyTsxSource("src/A.tsx", source, {
    ts: ts.ts,
    admittedOrigins: [],
    admittedPackages: [],
    admittedPaths: [],
  });
}

describe("jsx classify (#5080)", () => {
  it("refuses formMethod and unpinned template heads", () => {
    const a = run(`export const B = () => <button formMethod="post">x</button>;`);
    expect(a.ok && a.facts.length > 0).toBe(true);
    const b = run(`export const A = (p: {x: string}) => <a href={\`/\${p.x}\`} />;`);
    expect(b.ok && b.facts.length > 0).toBe(true);
  });

  it("continues identity forwarding and refuses derived concatenation", () => {
    const ok = run(`export const I = (props: { src: string }) => <img src={props.src} />;`);
    expect(ok.ok && ok.facts.length === 0).toBe(true);
    const bad = run(`export const I = (a: string, b: string) => <img src={a + b} />;`);
    expect(bad.ok && bad.facts.length > 0).toBe(true);
  });

  it("refuses quoted-key and spread POST fetch options", () => {
    const quoted = run(`export function f(){ void fetch('/api/orders', { "method": "POST" }); }\n`);
    expect(quoted.ok && quoted.facts.length > 0).toBe(true);
    const spread = run(
      `const postOptions = { method: "POST" };\nexport function f(){ void fetch('/api/orders', { ...postOptions }); }\n`,
    );
    expect(spread.ok && spread.facts.length > 0).toBe(true);
  });

  it("refuses XMLHttpRequest.open POST", () => {
    const r = run(
      `export function f(){ const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/orders'); }\n`,
    );
    expect(r.ok && r.facts.some((f) => f.id.includes("js-network:open"))).toBe(true);
  });

  it("follows a fetch alias initializer", () => {
    const r = run(
      `const send = fetch;\nexport function f(){ void send('/api/orders', { method: 'POST' }); }\n`,
    );
    expect(r.ok && r.facts.some((f) => f.id.includes("js-fetch-non-get"))).toBe(true);
  });

  it("does not let an inner same-name binding hide an outer external URL", () => {
    const r = run(`const url = "https://collector.example/p";
function Inner() {
  const url = "/ok";
  return <span>{url}</span>;
}
export const A = () => <a href={url} />;
`);
    expect(r.ok && r.facts.length > 0).toBe(true);
  });

  it("continues title text with an external URL and refuses href", () => {
    const title = run(`export const A = () => <a title="See https://example.com">x</a>;`);
    expect(title.ok && title.facts.length === 0).toBe(true);
    const href = run(`export const A = () => <a href="https://example.com">x</a>;`);
    expect(href.ok && href.facts.length > 0).toBe(true);
  });
});
