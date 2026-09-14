import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractMarkupFacts as viaLite } from "../extract.js";
import { extractMarkupFacts as viaJsdom } from "./extract-jsdom.js";

const dir = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(dir, "corpus");

const snippets: Record<string, string> = {
  "adversarial-1": `<script>document.write("<h1>Injected</h1>")</script><h1>Real</h1><p>1 < 2 && 3 > 2</p>`,
  "adversarial-2": `<!-- <button role="tab">Ghost</button> --><table><tr><th>A<th>B<tr><td>1<td>2</table>`,
  "adversarial-3": `<template><h2>T</h2><template><h3>Nested</h3></template></template><h2>Live</h2>`,
  "adversarial-4": `<div ROLE=tab aria-selected=true>Home</div><INPUT NAME="q"><textarea id="t"><h1>not heading</h1></textarea>`,
  "adversarial-5": `<h1>Tom &amp; Jerry &#8212; caf&eacute; &nbsp;x</h1><button aria-label="Save &quot;now&quot;">S</button>`,
  "adversarial-6": `<ul><li><button>A</button><li><button>B</button></ul><select name=s><option selected>x<option>y</select>`,
  "adversarial-7": `<h1>Unclosed <button role="tab" aria-selected="tr`,
  "adversarial-8": `<svg><title>svg title</title><text>x</text></svg><h1>After svg</h1><math><mi>x</mi></math>`,
  "adversarial-9": `<p>para<h2>Heading after open p</h2><section class="a b">S</section><article id=z class=q></article>`,
  "adversarial-10": `<header><nav aria-label="Main"><a href="#">x</a></nav></header><main><aside id="side"></aside><footer>f</footer></main>`,
};

describe("parent corpus parity vs jsdom reference (#4495 recut)", () => {
  it("matches jsdom on all 18 page files plus 10 inline snippets", () => {
    const files = readdirSync(corpusDir)
      .filter((n) => n.endsWith(".html"))
      .sort()
      .map((n) => [n, readFileSync(join(corpusDir, n), "utf8")] as const);
    const corpus: Array<readonly [string, string]> = [...files, ...Object.entries(snippets)];
    expect(files.length).toBe(18);
    expect(corpus.length).toBe(28);
    const diffs: string[] = [];
    for (const [name, src] of corpus) {
      const a = viaJsdom(src, "x.html").map((f) => f.id);
      const b = viaLite(src, "x.html").map((f) => f.id);
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(name);
    }
    expect(diffs).toEqual([]);
  });
});
