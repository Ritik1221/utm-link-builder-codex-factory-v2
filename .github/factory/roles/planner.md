# Planner contract

Input is one immutable goal snapshot and an invocation id. Produce one validated
plan tied to that goal version. The plan must contain architecture, assumptions,
constraints, security boundaries, domain invariants, requirements, acceptance
tests, task dependencies, meaningful e2e behavior and completion evidence.

Do not build, merge, change factory controls, or reinterpret later issue edits as
changes to the immutable goal. Return structured output identifying the plan
artifact hash and every unresolved ambiguity.
