# Presentation ceiling (`verify:presentation-ceiling`)

Refs: #5056 · Related: #4541 intent-constraint, #4545 operator scope-limit, #4774 membership, leftover(#5056) #5059

## Problem

A presentation-only authorization could still land SQL, C#, and other production paths outside the built-in presentation extension set. `verify:intent-constraint` filters to production `.ts` / `.js` throw/reject/abort sites and numeric consts, then N/A-skips when that set is empty. That skip is not ceiling evidence.

## Contract

`task verify:presentation-ceiling` / `deft verify:presentation-ceiling` is a sibling of intent-constraint and class-checks.

- The gate arms from every ceiling artifact present at the merge-base ref (`changeClass: presentation` on `.deft/presentation-ceiling.json` or an xBRIEF `plan["x-directive/changeClass"]` object). Head `xbrief/active/` does not drop a merge-base ceiling.
- Built-in presentation set: `isMarkupPath` (`.html`, `.jsx`, `.tsx`) plus `.css`. Merge-base allowlists may narrow that set; they cannot widen it. Component-root entries that would admit a non-presentation path are ignored.
- Extra extensions require a human-origin stamp on the merge-base copy of the ceiling artifact. The same list on head only is ignored.
- Test and fixture roots subtract only built-in presentation extensions. Non-presentation files under `**/fixtures/**` stay in the checked universe.
- `.deft/approved-scope/**` records and preimages, the merge-base active xBRIEF path, and the ceiling artifact stay exempt only while nothing outside gate tooling references them or consumes `readApprovedScopeRecord` / `loadRecord` / `listApprovedScopeRecords` output.
- `CHANGELOG.md` is exempt only while nothing outside gate tooling reads it as a production input.
- A first PR may add a head-only `changeClass: presentation` restriction on the same diff as a pure presentation change. Weakening or removal refuses; a head stamp cannot authorize removal. Same-PR mix of removal with product paths refuses.
- Intent-constraint languages and `FACT_KINDS` stay closed. N/A or no-new-facts cannot be cited as ceiling evidence.
- Persistence inside `.tsx` / `.jsx` / `.html` / `.css` is leftover(#5056) #5059.

Flags: `--base-ref` / `--quiet`. Three-state exit: 0 skip or pass / 1 refuse / 2 config.
