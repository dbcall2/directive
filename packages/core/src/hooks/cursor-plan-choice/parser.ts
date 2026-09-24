/**
 * Exact current-prompt parser for DEFT-PLAN-CHOICE answers (#4973).
 * Reads only beforeSubmitPrompt.prompt. Never reads attachments.
 */

import { PRODUCT_COMMANDS } from "../../slash/product-set.js";
import { PLAN_CHOICE_ANSWER_PREFIX, type PlanChoice } from "./types.js";

const ANSWER_RE = /^DEFT-PLAN-CHOICE ([0-9a-f]{32}) ([1-4])$/;

export type ParsedPlanChoiceAnswer = {
  readonly token: string;
  readonly choice: PlanChoice;
  readonly canonical: string;
};

export function parsePlanChoiceAnswer(prompt: string): ParsedPlanChoiceAnswer | null {
  const trimmed = prompt.trim();
  const match = ANSWER_RE.exec(trimmed);
  if (match === null) return null;
  const token = match[1];
  const choiceRaw = match[2];
  if (token === undefined || choiceRaw === undefined) return null;
  const choice = Number(choiceRaw) as PlanChoice;
  return {
    token,
    choice,
    canonical: `${PLAN_CHOICE_ANSWER_PREFIX} ${token} ${choiceRaw}`,
  };
}

function interviewCommands(): readonly string[] {
  const interview = PRODUCT_COMMANDS.find(
    (cmd) => cmd.logicalId === "/deft:directive:run:interview",
  );
  if (interview === undefined)
    return ["/deft:directive:run:interview", "/deft-directive-run-interview"];
  return [interview.logicalId, `/${interview.filenameStem}`];
}

export type InterviewHandoffParse =
  | { readonly ok: true; readonly request: string; readonly command: string }
  | { readonly ok: false };

export function parseInterviewHandoffPrompt(prompt: string): InterviewHandoffParse {
  const trimmed = prompt.trim();
  for (const command of interviewCommands()) {
    if (!trimmed.startsWith(command)) continue;
    const rest = trimmed.slice(command.length);
    if (rest.length === 0) return { ok: false };
    const lead = rest[0];
    if (lead === undefined || !/\s/.test(lead)) return { ok: false };
    const request = rest.trim();
    if (request.length === 0) return { ok: false };
    return { ok: true, request, command };
  }
  return { ok: false };
}

export function interviewCommandStems(): readonly string[] {
  return interviewCommands();
}
