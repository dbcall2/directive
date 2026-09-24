/**
 * Directive-authored planning-choice copy. Framework strings and the generated
 * token only — never original prompt, issue, or attachment content (#4973).
 */

import { interviewCommandStems } from "./parser.js";

export function planningChoiceQuestionMessage(token: string): string {
  return [
    "Directive planning choice for this Cursor conversation.",
    "",
    "How should this Plan request be handled?",
    "1. Directive planning (recommended)",
    "2. Host-only planning",
    "3. Discuss",
    "4. Back",
    "",
    "Reply with exactly this prompt (nothing else):",
    "",
    `DEFT-PLAN-CHOICE ${token} <number>`,
    "",
    "No default is selected. This question is not stored in the host transcript.",
  ].join("\n");
}

export function directiveSelectionReceiptMessage(): string {
  const [canonical, native] = interviewCommandStems();
  return [
    "Recorded: Directive planning.",
    "",
    "This answer is recorded and this Plan request stays blocked.",
    "",
    "Next, submit a new Plan prompt that starts with:",
    `${canonical ?? "/deft:directive:run:interview"} <your planning request>`,
    "",
    `Native Cursor command: ${native ?? "/deft-directive-run-interview"} <your planning request>`,
    "",
    "That command loads strategies/interview.md. The previous blocked prompt is not resent.",
    "Existing product-write gates still apply. This is not implementation approval.",
  ].join("\n");
}

export function hostOnlySelectionReceiptMessage(): string {
  return [
    "Recorded: host-only planning.",
    "",
    "This answer is recorded and this Plan request stays blocked.",
    "",
    "Submit your next Plan prompt when ready. Existing product-write gates still apply.",
    "This is not implementation approval.",
  ].join("\n");
}

export function discussMessage(): string {
  return [
    "No planning choice was recorded.",
    "",
    "Switch to Agent or Ask to discuss the options. Returning to Plan asks again with a new token.",
  ].join("\n");
}

export function backMessage(): string {
  return [
    "Planning choice cancelled.",
    "",
    "This conversation is back to no recorded choice. Submit a Plan prompt to be asked again.",
  ].join("\n");
}

export function handoffRequiredMessage(): string {
  const [canonical, native] = interviewCommandStems();
  return [
    "Directive planning is recorded for this conversation.",
    "",
    "Submit a Plan prompt that starts with:",
    `${canonical ?? "/deft:directive:run:interview"} <your planning request>`,
    `or ${native ?? "/deft-directive-run-interview"} <your planning request>`,
    "",
    "A matching agent response records transport progress only. It is not strategy completion or implementation approval.",
  ].join("\n");
}

export function storageFailureMessage(): string {
  return "Directive blocked this Plan request: planning-choice state could not be stored safely. Retry. No success receipt was issued.";
}

export function lockBusyMessage(): string {
  return "Directive blocked this Plan request: planning-choice state is busy. Retry the Plan submission.";
}

export function lockAmbiguousMessage(): string {
  return "Directive blocked this Plan request: planning-choice lock ownership is ambiguous. Close other Cursor processes using this conversation and retry. Do not delete lock files by hand.";
}

export function storeDenyMessage(toolName: string): string {
  return (
    `Directive denied ${toolName}: the Cursor planning-choice store is host-owned process metadata. ` +
    "Recognized agent tools cannot write that path, including with an active scope. " +
    "The adapter owns pending and selected records."
  );
}
