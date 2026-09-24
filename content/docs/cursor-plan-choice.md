# Cursor planning choice (#4973)

A Cursor conversation records whether to use Directive planning or host-only
planning **before the first submitted Plan request**. Literal mode-picker entry
is outside this promise.

## Supported surface

Observed local Cursor IDE **3.21.16** on macOS. The adapter keys on
`composer_mode: "plan"`, `conversation_id`, and `workspace_roots`. Extending
versions or platforms needs equivalent observed fixtures. Unverified surfaces
are blocked on Plan and are not reported as covered. Known Agent/Ask modes
pass without creating or consuming choice state.

## How it works

1. The managed deposit registers Cursor `beforeSubmitPrompt` and
   `afterAgentResponse` (timeout 5s, same as session hooks). `failClosed` is
   omitted: this event was not proven fail-closed on the measured host.
2. With no valid selected record, the hook returns `continue: false` and a
   numbered menu (Directive planning, host-only, Discuss, Back) plus a
   `DEFT-PLAN-CHOICE <token> <number>` reply form.
3. The parser reads only the current `prompt` after trim. Global-rule
   attachments must not veto an exact answer. Attachment contents are never
   an answer.
4. State lives in `platformUserConfigDir()/runtime/cursor-plan-choice/v1/`
   (not USER.md, not the project, not Git). Pending tokens expire after 24
   hours. Selected records idle-expire after 30 days. Discuss/Back do not
   select.
5. A Directive selection still blocks that answer turn. The next Plan prompt
   must start with `/deft:directive:run:interview` (native wrapper
   `/deft-directive-run-interview`) plus a nonempty request. A matching
   `afterAgentResponse` records transport progress only — not strategy
   completion or implementation approval. Host-only allows the next ordinary
   Plan prompt.
6. Product-write, ritual, occupancy, and scope gates stay in force. An
   unrelated active brief is not this conversation's choice. Recognized agent
   tools cannot write the store path.

## Runtime failure

Missing executable, timeout, nonzero exit, and malformed stdout follow Cursor
host rules for command hooks. Without `failClosed`, those failures are
fail-open on this event. Do not hand-edit `failClosed`. Recover missing
`deft-hook` with [hook-runtime-unavailable.md](./hook-runtime-unavailable.md).
Live UI proof of the normal choice flow remains a release acceptance test.

## Reset

Delete the conversation file under the v1 store, or wait for documented
expiry. Do not treat deletion as consent.

## Out of scope

Grok/Claude adapters, literal Plan entry/re-entry, leftover #1708
discoverability, `afterFileEdit` conversion, `planBridge`,
`session:start --defer`, and #1563/#4544.
