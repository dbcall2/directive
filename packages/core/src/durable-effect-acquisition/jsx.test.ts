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
});
