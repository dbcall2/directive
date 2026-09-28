import { describe, expect, it } from "vitest";
import { classifyHandlerText, classifyTsxSource, loadProjectTypeScript } from "./jsx.js";

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
  it.each([
    `function send(client){client.fetch('/orders',{method:'POST'});}`,
    `function send(client){client['fetch']('/orders',{method:'GET'});}`,
    `function invoke(callback){callback();}`,
    `function invoke({callback}){const alias=callback;alias();}`,
    `function invoke(client){const callback=client.send;callback();}`,
    `function construct(Supplied){new Supplied();}`,
    "function invoke(tag){tag`payload`;}",
  ])("refuses invocation instead of treating it as forwarding: %s", (source) => {
    const result = run(source);
    expect(result.ok && result.facts.some((f) => f.id.includes("unresolved-call"))).toBe(true);
  });
  it.each([
    `function forward(callback){return callback;}`,
    `function forward(client){return <Card onSave={client.save} />;}`,
    `function forward({callback}){const alias=callback;return <Card onSave={alias} />;}`,
    `function forward(client){return <img src={client.src}/>;}`,
    `function render(){const text='hello';return text.toUpperCase();}`,
  ])("retains value forwarding and classified calls: %s", (source) => {
    const result = run(source);
    expect(result.ok && result.facts).toEqual([]);
  });
  it.each([
    [`<style>&#64;import &quot;https://collector.example/p&quot;;</style>`, false],
    [`<Photo>&#104;ttps://collector.example/p</Photo>`, false],
    [`<Photo>&#47;image.png</Photo>`, true],
    [`<style>body &#123;color:red;&#125;</style>`, true],
    [`<Photo>\n  &#104;ttps://collector.example/p\n</Photo>`, false],
    [`<Photo>\n  &#47;image.png\n</Photo>`, true],
    [`<base href="/"/>`, true],
    [`<base href="https://collector.example/"/>`, false],
    [`function Page(p){return <base href={p.base}/>;}`, false],
    [`<base href={true}/>`, false],
    [`<iframe/>`, false],
    [`<script src="/code.js"/>`, false],
    [`<div hidden/>`, true],
    [`<div title={/* empty */}/>`, true],
    [`<div style="color:red"/>`, true],
    [`<div style="background:url(/a)"/>`, false],
    [`<div style="color:\\72 ed"/>`, false],
    [`<div style={{color:'red',opacity:1}}/>`, true],
    [`<div style={{background:'url(/a)'}}/>`, false],
    [`function Page(p){return <div style={p.style}/>}`, false],
    [`function Page(p){return <div style={{color:p.color}}/>}`, false],
    [`const color='red'; <div style={{color}}/>`, false],
    [`<meta httpEquiv="refresh"/>`, false],
    [`<meta httpEquiv={true}/>`, false],
    [`<form method={true}/>`, false],
    [`function Page(p){return <Card {...p}/>}`, true],
    [`<Card {...{src:'https://collector.example/p'}}/>`, false],
    [`function Page(p){return <Card>{p.child}</Card>}`, true],
    [`<Card>{['/a','/b']}</Card>`, true],
    [`<Card>{['/a','https://collector.example/p']}</Card>`, false],
    [`<Card> <span/> </Card>`, true],
    [`<Card>{null}</Card>`, true],
    [`const src='/a'; <Card prop={{src}}/>`, false],
    [`<style>{'body { color:red; }'}</style>`, true],
    [`function Page(p){return <style>{p.css}</style>}`, false],
    [`<style><span/></style>`, false],
    [`<script>{'const ='}</script>`, false],
    [`<div onClick="const ="/>`, false],
    [`const method='GET'; fetch('/a',{method});`, true],
    [`function get(method){fetch('/a',{method});}`, false],
    [`fetch('/a',{headers:{accept:'text/plain'}});`, true],
    [`fetch();`, false],
    [`new fetch;`, false],
    [`const url='/a';const o={url}; <img src={o.url}/>`, true],
    [`const o={url:'/a'};<img src={o.missing}/>`, false],
    [`const o={get url(){return '/a'}};<img src={o.url}/>`, false],
    [`function Page(p){const o={[p.key]:'/a'};return <img src={o.url}/>}`, false],
    [`const o={0:'/a'};<img src={o[0]}/>`, true],
    [`function Page(p){return <img src={p[p.key]}/>}`, false],
    [`let x=0; ++x; <img src={x}/>`, false],
    [`let x=0; x--; <img src={x}/>`, false],
    [`const o={url:'/a'};delete o.url;<img src={o.url}/>`, false],
    [
      `const o={url:'/a'};const alias={o};alias.o.url='https://collector.example/p';<img src={o.url}/>`,
      false,
    ],
    [`const o={url:'/a'};const alias={o}; mutate(alias);<img src={o.url}/>`, false],
    [`const {url}={url:'/a'};<img src={url}/>`, false],
    [`class Page { render(){return this.value;} }`, false],
    [`import x = require('x');`, false],
    [`export {x};`, true],
    [`import {x} from './Card.tsx'; x();`, true],
  ])("applies static policy to %s (safe=%s)", (source, safe) => {
    const r = run(source);
    expect(r.ok && r.facts.length === 0).toBe(safe);
  });

  it("classifies standalone handlers including malformed syntax", () => {
    const loaded = loadProjectTypeScript(process.cwd());
    if (!loaded.ok) throw Error(loaded.detail);
    const ctx = { ts: loaded.ts, admittedOrigins: [], admittedPackages: [], admittedPaths: [] };
    expect(classifyHandlerText("Math.max(1,2)", ctx)).toEqual([]);
    expect(classifyHandlerText('document.cookie="k=v"', ctx).length).toBeGreaterThan(0);
    expect(classifyHandlerText("const =", ctx)[0]?.rule).toBe("item-9");
  });
  it.each([
    `<style>@im{"port"} "https://collector.example/p";</style>`,
    `<script>{'localStorage'}{'.setItem("k","v");'}</script>`,
    `function invoke(fn){fn('/orders',{method:'POST'});} invoke(fetch);`,
    `export function A({src='https://collector.example/p'}={}){return <img src={src}/>;}`,
  ])("refuses composed executable supplier %s", (source) => {
    const r = run(source);
    expect(r.ok && r.facts.length === 0).toBe(false);
  });
  it.each([
    `const a='a.png 1x, https'; const b='://collector.example/p 2x'; <img srcSet={\`/img/\${a}\${b}\`} />;`,
    `function A({ a, b }) { return <img srcSet={\`/img/\${a}\${b}\`} />; }`,
    `function A(p) { return <img srcSet={\`/img/\${p.a}\${p.b}\`} />; }`,
    `function A(p) { return <Photo src={\`/img/\${p.a}\`} />; }`,
    `import('./save.js').then(m => m.save());`,
    `const g=globalThis; const storage=g['localStorage']; storage.setItem('k','v');`,
    `const img=document.createElement('img'); img.src='https://collector.example/p';`,
    `<div>{localStorage.setItem('k','v')}</div>;`,
    `<div title={localStorage.setItem('k','v')} />;`,
    `let url='/safe'; url='https://collector.example/p'; <img src={url}/>;`,
    `unknownGlobal.save();`,
    `const a=b; const b=a; <img src={a}/>;`,
    `fetch('/api', {method:'GET', ['method']:'POST'});`,
    `fetch('/api', { ['unknown'+key]: 'POST'});`,
    `fetch('/api', {get method(){return 'POST'}});`,
    `const x={method:'GET'}; x.method='POST'; fetch('/api',x);`,
    `const url='https://collector.example/p'; function f(url){return url;} <img src={url}/>;`,
    `const x=Math['constructor']; x('return fetch')()('/api',{method:'POST'});`,
    `<body background="https://collector.example/bg"/>;`,
    `<Photo title="https://collector.example/p"/>;`,
    `<my-photo title="https://collector.example/p"/>;`,
    `<img futureChannel="https://collector.example/p"/>;`,
    `const o={src:'https://collector.example/p'}; <img src={o.src}/>;`,
  ])("refuses the approved repair adversary: %s", (source) => {
    const r = run(source);
    expect(r.ok && r.facts.length === 0).toBe(false);
  });

  it.each([
    `fetch('/api');`,
    `fetch("/api");`,
    `fetch('/api',{method:'POST',['method']:'GET'});`,
    `const method='GET'; const options={['method']:method}; fetch('/api',options);`,
    `const send=fetch; send('/api',{method:'GET'});`,
    `const a='a.png 1x, '; const b='/img/b.png 2x'; <img srcSet={\`/img/\${a}\${b}\`}/>;`,
    `function A({id}) { return <img src={\`/img/\${id}.png\`}/>; }`,
    `function A({src}) { return <img srcSet={src}/>; }`,
    `function A({flag}) { return <div title={flag ? 'See https://example.com' : 'ok'}/>; }`,
    `<Photo enabled={true} count={3}/>;`,
    `<div title="https://example.com" alt="https://example.com" aria-label="https://example.com"/>;`,
    `const o={src:'/img/a.png'}; <img src={o.src}/>;`,
    `function A(Math) { return <div>{Math.label}</div>; }`,
    `Math.max(1,2); JSON.stringify({hello:'world'});`,
  ])("continues the approved harmless control: %s", (source) => {
    const r = run(source);
    expect(r.ok ? r.facts : r).toEqual([]);
  });
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
