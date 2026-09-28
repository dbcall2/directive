# Durable-effect acquisition (`verify:durable-effect-acquisition`)

Refs: #5080 · Related: [intent-constraint.md](./intent-constraint.md) (#4541), [observable-scope.md](./observable-scope.md) (#4495), [consumer-check-contract.md](./consumer-check-contract.md) (#3145)

Under a recorded presentation ceiling, a changed in-class `.tsx` / `.jsx` / `.html` file must not acquire a durable-effect capability versus merge-base: storage APIs, cookies, network with a non-GET method or a non-sentinel origin, or markup submission and navigation channels.

Same-origin GET is owned by the server endpoint. In-memory state is #5079. `.css` is #5056. Do not widen `FACT_KINDS`. Do not harvest `.tsx` / `.jsx` into production intent-constraint suffixes.

## Contract

1. Consume the #5056 presentation-ceiling artifact (`.deft/presentation-ceiling.json`). Do not mint a second store.
2. Arming follows #5079: a merge-base artifact, or an add-only / tightening head restriction, arms. Head deletion or weakening cannot disarm.
3. Under an armed ceiling the exits are refuse or pass citing the recomputed rule. `skipped` / N/A is not an exit.
4. Markup values are decoded, WHATWG-preprocessed, and resolved against sentinel `https://deft.invalid/`. Request-capable non-sentinel origins refuse.
5. Submitter `formmethod` / `formMethod`, new non-sentinel `<base href>`, and any-namespace `on*` handler source (including SVG `onbegin`) refuse.
6. Same-PR rewrite of the ceiling allowlists or of this verifier refuses when the verifier already exists on the merge base.

The verb is composed on `task check` (`FRAMEWORK_CHECK_GATES`, `CONSUMER_CHECK_GATES`, and required consumer enforcement).

Three-state exit: `0` off-ceiling or pass / `1` refuse / `2` invalid configuration.
