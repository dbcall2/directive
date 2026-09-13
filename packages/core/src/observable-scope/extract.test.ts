import { describe, expect, it } from "vitest";
import { extractMarkupFacts, extractSurface, isMarkupPath } from "./extract.js";

const PAGE = `
<nav aria-label="Primary">
  <button role="tab" aria-selected="true">Overview</button>
  <button role="tab">Details</button>
</nav>
<main>
  <h1>Dashboard</h1>
  <section id="card">
    <input name="title" />
    <button>Save</button>
    <table><thead><tr><th>Name</th><th>Status</th></tr></thead></table>
  </section>
</main>
`;

describe("committed-markup oracle (#4495)", () => {
  it("recognizes markup extensions", () => {
    expect(isMarkupPath("src/App.tsx")).toBe(true);
    expect(isMarkupPath("templates/page.html")).toBe(true);
    expect(isMarkupPath("src/app.ts")).toBe(false);
  });

  it("extracts tabs, headings, controls, columns, landmarks, containers", () => {
    const facts = extractMarkupFacts(PAGE);
    const ids = facts.map((f) => f.id);
    expect(ids).toContain("tab:Overview");
    expect(ids).toContain("tab:Details");
    expect(ids).toContain("tab-selected:Overview");
    expect(ids).toContain("heading:1:Dashboard");
    expect(ids).toContain("control:input:title");
    expect(ids).toContain("control:button:Save");
    expect(ids).toContain("table-column:Name");
    expect(ids).toContain("table-column:Status");
    expect(ids.some((id) => id.startsWith("landmark:nav:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("landmark:main:"))).toBe(true);
    expect(ids).toContain("container:section:card");
  });

  it("sees markup-visible selected tab, not runtime-only JS state", () => {
    const facts = extractMarkupFacts(`<Tab>A</Tab><Tab selected>B</Tab>`);
    expect(facts.map((f) => f.id)).toEqual(["tab:A", "tab:B", "tab-selected:B"]);
  });

  it("snapshots path + facts", () => {
    const surface = extractSurface("src/App.tsx", "<h2>Hello</h2>");
    expect(surface.path).toBe("src/App.tsx");
    expect(surface.facts).toEqual([{ kind: "heading", id: "heading:2:Hello" }]);
  });

  it("extracts Heading, TableHead, and role landmarks", () => {
    const facts = extractMarkupFacts(
      `<Heading level="2">Stats</Heading><TableHead>Owner</TableHead><div role="navigation" aria-label="Side">x</div>`,
    );
    const ids = facts.map((f) => f.id);
    expect(ids).toContain("heading:2:Stats");
    expect(ids).toContain("table-column:Owner");
    expect(ids).toContain("landmark:navigation:Side");
  });
});
