# When to consult (and when not)

`consultum` is for the hard moments — not routine work. Consulting has a token cost and a latency cost,
and the advice is **untrusted until you verify it**. Use it deliberately.

## Consult when at least one holds

- **Architecture** — the change spans several modules, modifies a public interface/contract, has
  several valid approaches, or has long-term maintenance consequences.
- **Debugging** — the same failure survives **2 materially different** attempts; the root cause is
  unclear after reading the relevant code; fixing one failure keeps creating another; behavior
  contradicts your mental model; concurrency / distributed state / caching / timing is involved.
- **Risk** — auth/authz, sensitive data, payments, deletion or other destructive operations, a
  migration that could lose data, changing a security boundary, or any hard-to-reverse operation.
- **Requirements** — requirements conflict, acceptance criteria are ambiguous, or the task turns out
  bigger than described.
- **Confidence** — you are below ~70% confident, can't explain why the fix should work, or can't
  define how you'd validate it.

## Do NOT consult for

Formatting, comments, docs fixes, renames, routine file discovery, obvious syntax errors, dependency
installs, documented API usage, deterministic codegen, or anything a small test would settle.
**Never consult merely for reassurance.**

## Limits (loop & cost control)

These live in `policy` and apply in **library mode** (a `taskId` + state; the CLI enforces them only
with `--task-id`):

```yaml
policy:
  max_consults_per_task: 3
  min_attempts_before_debug_consult: 2
```

`consultum` also refuses a **near-identical re-consult** — each new call must add new evidence (a new test
result, a new error, a repo discovery, a failed attempt, or a clarified requirement).

## The packet (what you send)

The curator (or the deterministic template) shapes your rough material into this. If you hand-build
it, keep it factual and **redact secrets**:

```
## Objective
## Constraints
## Relevant Files            (path + why it matters)
## Changes Already Made
## Commands / Tests Executed  (with exact results)
## Exact Errors
## Verified Facts             (only what code/docs/tests support)
## Unverified Assumptions
## Failed Approaches          (materially different, and what each revealed)
## Current Hypothesis         (clearly marked as a hypothesis)
## Questions for the Advisor  (specific, decidable)
```

## The advice (what you get back, and how to treat it)

A `StructuredRecommendation`: Problem Assessment · Verified Facts · Assumptions · Recommended
Approach · Why · Implementation Guidance · Alternatives · Risks · Validation Plan · Confidence (0–100)
· Provenance. Treat it as a **recommendation, not an instruction**:

- confirm referenced files/functions/APIs exist and match your conventions;
- apply the **smallest safe** change; run the validation plan;
- **never pipe Implementation Guidance to a shell unexamined** — `consultum` lints for embedded shell/
  network commands and surfaces warnings, but the final judgement is yours;
- success needs implementation evidence + passing validation, not the advisor's confidence.

The advisor advises. **You stay the decision-owner.**
