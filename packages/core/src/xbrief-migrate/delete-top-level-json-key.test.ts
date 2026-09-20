import { describe, expect, it } from "vitest";
import { deleteTopLevelJsonKey } from "./delete-top-level-json-key.js";

const KEY = "vBRIEFInfo";

describe("deleteTopLevelJsonKey (#4163)", () => {
  it("keeps compact JSON byte-identical except the deleted key", () => {
    const source =
      '{"vBRIEFInfo":{"version":"0.6"},"plan":{"title":"T","status":"running","items":[]},"xBRIEFInfo":{"version":"0.8"}}';
    const expected =
      '{"plan":{"title":"T","status":"running","items":[]},"xBRIEFInfo":{"version":"0.8"}}';
    const result = deleteTopLevelJsonKey(source, KEY);
    expect(result).toEqual({ ok: true, body: expected });
  });

  it("keeps tab-indented JSON byte-identical except the deleted key", () => {
    const source = [
      "{",
      '\t"vBRIEFInfo": {',
      '\t\t"version": "0.6"',
      "\t},",
      '\t"plan": {',
      '\t\t"title": "T",',
      '\t\t"status": "running",',
      '\t\t"items": []',
      "\t},",
      '\t"xBRIEFInfo": {',
      '\t\t"version": "0.8"',
      "\t}",
      "}",
      "",
    ].join("\n");
    const expected = [
      "{",
      '\t"plan": {',
      '\t\t"title": "T",',
      '\t\t"status": "running",',
      '\t\t"items": []',
      "\t},",
      '\t"xBRIEFInfo": {',
      '\t\t"version": "0.8"',
      "\t}",
      "}",
      "",
    ].join("\n");
    const result = deleteTopLevelJsonKey(source, KEY);
    expect(result).toEqual({ ok: true, body: expected });
  });

  it("deletes a trailing leftover key including the preceding comma", () => {
    const source =
      '{"plan":{"title":"T"},"xBRIEFInfo":{"version":"0.8"},"vBRIEFInfo":{"version":"0.6"}}';
    const expected = '{"plan":{"title":"T"},"xBRIEFInfo":{"version":"0.8"}}';
    expect(deleteTopLevelJsonKey(source, KEY)).toEqual({ ok: true, body: expected });
  });

  it("preserves nested braces inside leftover values and string escapes", () => {
    const source =
      '{"vBRIEFInfo":{"version":"0.6","description":"has } and \\"quotes\\""},"plan":{"title":"T"}}';
    const expected = '{"plan":{"title":"T"}}';
    expect(deleteTopLevelJsonKey(source, KEY)).toEqual({ ok: true, body: expected });
  });

  it("fails closed on a missing key", () => {
    const result = deleteTopLevelJsonKey('{"plan":{}}', KEY);
    expect(result.ok).toBe(false);
  });

  it("skips numbers, arrays, literals, and escaped string values before the key", () => {
    const source =
      '{"n":0,"m":-1.5e+2,"a":[true,false,null,"q\\"s"],"s":"ok","vBRIEFInfo":{"version":"0.6"},"plan":{}}';
    expect(deleteTopLevelJsonKey(source, KEY)).toEqual({
      ok: true,
      body: '{"n":0,"m":-1.5e+2,"a":[true,false,null,"q\\"s"],"s":"ok","plan":{}}',
    });
  });

  it("matches a unicode-escaped leftover key and keeps a BOM", () => {
    const source = '\uFEFF{"vBRIEF\\u0049nfo":{"version":"0.6"},"plan":{}}';
    expect(deleteTopLevelJsonKey(source, KEY)).toEqual({
      ok: true,
      body: '\uFEFF{"plan":{}}',
    });
  });

  it("fails closed on non-object JSON, trailing commas, and duplicate keys", () => {
    expect(deleteTopLevelJsonKey("[]", KEY).ok).toBe(false);
    expect(deleteTopLevelJsonKey('{"a":1,}', KEY).ok).toBe(false);
    expect(deleteTopLevelJsonKey('{"vBRIEFInfo":{},"vBRIEFInfo":{}}', KEY).ok).toBe(false);
    expect(deleteTopLevelJsonKey('{"a" 1}', KEY).ok).toBe(false);
    expect(deleteTopLevelJsonKey("{1:2}", KEY).ok).toBe(false);
    expect(deleteTopLevelJsonKey('{"a":1 "b":2}', KEY).ok).toBe(false);
    expect(deleteTopLevelJsonKey('{"a":}', KEY).ok).toBe(false);
    expect(deleteTopLevelJsonKey('{"a":"', KEY).ok).toBe(false);
    expect(deleteTopLevelJsonKey('{"a":"\\', KEY).ok).toBe(false);
    expect(deleteTopLevelJsonKey('{"a":"\\x"}', KEY).ok).toBe(false);
    expect(deleteTopLevelJsonKey('{"a":"\\uZZZZ"}', KEY).ok).toBe(false);
    expect(deleteTopLevelJsonKey('{"a":"\n"}', KEY).ok).toBe(false);
    expect(deleteTopLevelJsonKey('{"a":1.', KEY).ok).toBe(false);
    expect(deleteTopLevelJsonKey('{"a":1e', KEY).ok).toBe(false);
    expect(deleteTopLevelJsonKey('{"a":-}', KEY).ok).toBe(false);
    expect(deleteTopLevelJsonKey('{"a":{', KEY).ok).toBe(false);
  });
});
