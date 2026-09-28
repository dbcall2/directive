import { describe, expect, it } from "vitest";
import { loadArtifactsFromTexts, parseArtifactText } from "./artifact.js";

const rel = ".deft/presentation-ceiling.json";
const stamp = { kind: "operator", actor: "David", mintedAt: "2026-09-28T00:00:00Z" };
const parse = (raw: unknown, path = rel) => parseArtifactText(JSON.stringify(raw), path);
describe("supplier artifact contract", () => {
  it.each([
    { changeClass: "presentation" },
    {
      schema: "deft.presentation-ceiling.v1",
      changeClass: "presentation",
      allowedExtensions: ["html"],
      componentRoots: ["public/**"],
    },
    { changeClass: "presentation", allowlist: [".html"] },
    {
      changeClass: "presentation",
      extensionAmendment: { extensions: ["sql"], humanApproval: stamp },
    },
  ])("accepts supplier form %j", (raw) => expect(parse(raw)).toHaveProperty("artifact"));
  it.each([
    { plan: { "x-directive/changeClass": "presentation" } },
    { plan: { "x-directive/changeClass": { changeClass: "presentation" } } },
    { plan: { metadata: { "x-directive/changeClass": { changeClass: "presentation" } } } },
    { changeClass: "presentation" },
  ])("discovers xBRIEF form %j", (raw) =>
    expect(parse(raw, "xbrief/active/story.xbrief.json")).toMatchObject({
      artifact: { allowedExtensions: [] },
    }));
  it.each([
    { changeClass: "presentation", extraExtensions: [".sql"] },
    { changeClass: "presentation", extensionAmendment: { extensions: [".sql"] } },
    { changeClass: "presentation", allowedExtensions: ["src/**"] },
    { changeClass: "presentation", allowedExtensions: ".html" },
    { changeClass: "presentation", componentRoots: ["../outside"] },
    { changeClass: "presentation", removalStamp: {} },
    { schema: "unknown", changeClass: "presentation" },
  ])("refuses malformed/unsigned authority %j", (raw) =>
    expect(parse(raw)).toHaveProperty("error"));
  it("distinguishes valid non-ceiling briefs from malformed discovery", () => {
    expect(parse({ plan: { status: "running" } }, "xbrief/active/story.xbrief.json")).toEqual({
      artifact: null,
    });
    expect(parse({ changeClass: "backend" })).toEqual({ artifact: null });
    expect(parseArtifactText("{", rel)).toHaveProperty("error");
    expect(parse([])).toHaveProperty("error");
    expect(parse({})).toHaveProperty("error");
  });
  it("does not invent a plural artifact store", () => {
    expect(
      loadArtifactsFromTexts(
        new Map([[".deft/presentation-ceilings/story.json", '{"changeClass":"presentation"}']]),
      ),
    ).toEqual({ loaded: [] });
  });
});
