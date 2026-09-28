import { describe, expect, it } from "vitest";
import { classifyCssEffects } from "./css.js";

const facts = (source: string) => classifyCssEffects(source, "test");
const ids = (source: string) => facts(source).map((f) => f.id);

describe("CSS acquisition occurrences (#5080)", () => {
  it.each([
    ["background:url(/a)", "background: URL( '/a' /* note */ ); color:red"],
    [".a{background:url(/a)}", "/*before*/ .a { color:red; background : url( /a ); }"],
    ['@import "/a";', "/*before*/ @IMPORT '/a'; .a{color:red}"],
    ["@import url(/a) screen;", '@import URL("/a") /*note*/ screen;'],
    [
      'background:image-set("/a" 1x,url(/b) 2x)',
      "background: image-set('/a' 1x, url('/b') 2x);color:red",
    ],
    [
      "background:cross-fade(url(/a),url(/b),50%)",
      "background:cross-fade( url('/a'), /*note*/ url('/b'), 50% );",
    ],
  ])("normalizes trivia outside the acquisition: %s", (base, head) => {
    expect(ids(head)).toEqual(ids(base));
  });
  it.each([
    "url(/a)",
    'image-set("/a" 1x)',
    'image("/a")',
    'src("/a")',
    "cross-fade(url(/a),url(/b),50%)",
    '@import "/a";',
  ])("keeps targets and repeated constructs: %s", (value) => {
    expect(facts(value)).toHaveLength(1);
    expect(ids(value.replace("/a", "/new"))).not.toEqual(ids(value));
    expect(ids(`${value};${value}`)).toEqual([...ids(value), ...ids(value)]);
  });
  it("preserves quoted URL punctuation, comment-looking bytes and case", () => {
    const value = 'background:url("/A(x);/*literal*/.png")';
    expect(ids(`${value};color:red`)).toEqual(ids(value));
    expect(ids(value.replace("/A", "/a"))).not.toEqual(ids(value));
    expect(ids(value.replace("/*literal*/", "/*different*/"))).not.toEqual(ids(value));
    expect(ids("background:url(/a/*literal*/.png)")).not.toEqual(ids("background:url(/a.png)"));
  });
  it("retains rule, property and caller channel context", () => {
    expect(ids("background:url(/a)")).not.toEqual(ids("mask:url(/a)"));
    expect(ids(".a{background:url(/a)}")).not.toEqual(ids(".b{background:url(/a)}"));
    expect(classifyCssEffects("url(/a)", "one")).not.toEqual(classifyCssEffects("url(/a)", "two"));
    expect(ids("@media screen {.a{background:url(/a)}}")).toHaveLength(1);
    expect(ids('@import "/a" layer(foo) screen')).not.toEqual(
      ids('@import "/a" layer(bar) screen'),
    );
  });
  it.each([
    "color:\\72 ed",
    'url("/a)',
    "url(/a",
    "url(/a(b))",
    'url("/a" extra)',
    'image-set("/a" 1x',
    '@import "/a" layer(',
    "/*unfinished",
    'content:"unfinished',
    'url("/a" /*unfinished)',
    "url(/a\nmore)",
  ])("refuses escaped or unresolved CSS: %s", (value) => {
    expect(facts(value).some((f) => /CSS escape|unresolved CSS/.test(f.detail))).toBe(true);
  });
  it.each([
    "",
    " \n /* safe */ ",
    "color:red",
    'content:"url(/a)"',
    'content:"@"',
    "/*url(/a)*/color:red",
  ])("does not acquire effects from ordinary text/trivia: %s", (value) => {
    expect(facts(value)).toEqual([]);
  });
});
