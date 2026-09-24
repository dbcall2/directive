import { describe, expect, it } from "vitest";
import { parseInterviewHandoffPrompt, parsePlanChoiceAnswer } from "./parser.js";

describe("parsePlanChoiceAnswer", () => {
  const token = "a".repeat(32);

  it("accepts an exact trimmed token and number", () => {
    const parsed = parsePlanChoiceAnswer(`  DEFT-PLAN-CHOICE ${token} 1\n`);
    expect(parsed).toEqual({
      token,
      choice: 1,
      canonical: `DEFT-PLAN-CHOICE ${token} 1`,
    });
  });

  it("rejects quoted, code-fenced, prefixed, and suffixed text", () => {
    expect(parsePlanChoiceAnswer(`"${`DEFT-PLAN-CHOICE ${token} 1`}"`)).toBeNull();
    expect(
      parsePlanChoiceAnswer(["```", `DEFT-PLAN-CHOICE ${token} 1`, "```"].join("\n")),
    ).toBeNull();
    expect(parsePlanChoiceAnswer(`please DEFT-PLAN-CHOICE ${token} 1`)).toBeNull();
    expect(parsePlanChoiceAnswer(`DEFT-PLAN-CHOICE ${token} 1 thanks`)).toBeNull();
  });

  it("rejects uppercase tokens and out-of-range numbers", () => {
    expect(parsePlanChoiceAnswer(`DEFT-PLAN-CHOICE ${"A".repeat(32)} 1`)).toBeNull();
    expect(parsePlanChoiceAnswer(`DEFT-PLAN-CHOICE ${token} 5`)).toBeNull();
    expect(parsePlanChoiceAnswer(`DEFT-PLAN-CHOICE ${token} 0`)).toBeNull();
  });
});

describe("parseInterviewHandoffPrompt", () => {
  it("accepts the canonical command with a nonempty request", () => {
    const parsed = parseInterviewHandoffPrompt(
      "/deft:directive:run:interview ship a planning workflow",
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request).toBe("ship a planning workflow");
      expect(parsed.command).toBe("/deft:directive:run:interview");
    }
  });

  it("accepts the native Cursor wrapper stem with a newline-separated request", () => {
    const parsed = parseInterviewHandoffPrompt("/deft-directive-run-interview\nplan the slice");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request).toBe("plan the slice");
      expect(parsed.command).toBe("/deft-directive-run-interview");
    }
  });

  it("rejects a command with no request and a substring match", () => {
    expect(parseInterviewHandoffPrompt("/deft:directive:run:interview").ok).toBe(false);
    expect(parseInterviewHandoffPrompt("/deft:directive:run:interview   ").ok).toBe(false);
    expect(parseInterviewHandoffPrompt("please run /deft:directive:run:interview next").ok).toBe(
      false,
    );
  });
});
