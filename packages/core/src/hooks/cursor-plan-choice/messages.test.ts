import { describe, expect, it } from "vitest";
import {
  backMessage,
  directiveSelectionReceiptMessage,
  discussMessage,
  handoffRequiredMessage,
  hostOnlySelectionReceiptMessage,
  planningChoiceQuestionMessage,
  storeDenyMessage,
} from "./messages.js";

describe("planning-choice messages", () => {
  it("renders the numbered menu and exact reply form without prompt text", () => {
    const token = "ab".repeat(16);
    const text = planningChoiceQuestionMessage(token);
    expect(text).toContain("1. Directive planning (recommended)");
    expect(text).toContain("2. Host-only planning");
    expect(text).toContain("3. Discuss");
    expect(text).toContain("4. Back");
    expect(text).toContain(`DEFT-PLAN-CHOICE ${token} <number>`);
    expect(text).not.toContain("plan the leftover");
  });

  it("names the interview command on Directive receipt and handoff", () => {
    expect(directiveSelectionReceiptMessage()).toContain("/deft:directive:run:interview");
    expect(directiveSelectionReceiptMessage()).toContain("/deft-directive-run-interview");
    expect(handoffRequiredMessage()).toContain("/deft:directive:run:interview");
    expect(hostOnlySelectionReceiptMessage()).toContain("host-only planning");
    expect(discussMessage()).toContain("Agent or Ask");
    expect(backMessage()).toContain("cancelled");
    expect(storeDenyMessage("Write")).toContain("Write");
    expect(storeDenyMessage("Write")).toContain("planning-choice store");
  });
});
