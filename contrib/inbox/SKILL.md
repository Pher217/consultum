---
name: inbox
description: Open an asynchronous, folder-backed request/answer channel so an AGENT can ask a HUMAN a question and get an answer later, without blocking the agent's process. Use when an agent hits a decision that needs a human call (approval, ambiguous scope, a judgment the agent shouldn't make alone) and the human is not watching the terminal right now. Trigger on "ask the human", "open the inbox", "check if it's been answered", "queue this for review".
---

# /inbox — ask a human, asynchronously

`consultum consult` is synchronous and model-to-model. `contrib/pair` is synchronous-ish between
two live sessions that are both watching. Neither fits an agent that needs to ask a human who
might not look for hours: a CI bot flagging a risky migration, a long-running batch job hitting
an ambiguous case, a sandboxed worker that should not guess on a judgment call.

The inbox is a mailbox with no daemon requirement for the request/answer path itself: `ask`
writes a question and returns immediately; the human answers whenever they get to it; the agent
polls with `check` or blocks with `wait --timeout`.

**Full protocol, layout, and rationale: [`docs/human-inbox.md`](../../docs/human-inbox.md).** Read
it before wiring this into an unattended pipeline.

`S=contrib/inbox/inbox.sh` — or copy this directory to `~/.claude/skills/inbox/` and use
`S=$HOME/.claude/skills/inbox/inbox.sh`.

## 1. Ask — when the agent needs a human call

Write the body with the `Write` tool to a scratch file (shell quoting mangles multiline bodies),
then:

```bash
id=$(bash "$S" ask --slug approve-migration --urgency blocking --file /path/to/body.md)
echo "$id"
```

`ask` prints **only the id** on stdout — safe to capture with `id=$(...)`. Everything
human-facing goes to stderr. The body is redacted (`consultum`'s `redactSecrets`) before it ever
touches disk; if redaction cannot be resolved, `ask` hard-fails and writes nothing.

## 2. Get the answer back — poll or block

`check` is non-blocking and distinguishes "still pending" from every other failure by exit code:

```bash
if answer=$(bash "$S" check "$id"); then
  printf '%s\n' "$answer"
else
  status=$?
  [ "$status" = 20 ] && echo "still pending" || echo "check failed ($status)"
fi
```

**Do not run `answer=$(bash "$S" check "$id")` under `set -e`** — a pending question exits 20,
which `set -e` treats as a script-ending failure, not a status to branch on. Use the `if`/`case`
pattern above, or `check "$id" || status=$?`.

`wait` blocks until answered or the deadline:

```bash
bash "$S" wait "$id" --timeout 600 && echo answered || {
  status=$?
  [ "$status" = 21 ] && echo "no answer within 600s — fall back or escalate"
}
```

`wait` **requires** `--timeout`; omitting it is a usage error (exit 10), not an infinite wait.

## 3. Answer — the human side

```bash
bash "$S" list                              # what's open
bash "$S" show <ID>                         # read the full question
bash "$S" answer <ID> --file /path/to/answer.md
```

`answer` refuses to overwrite an existing answer (exit 10) — if the first answer was wrong, `close`
the question and `ask` a fresh one instead of trying to edit history.

## 4. Root — for callers outside this repo

**External callers (a different repo/tool, e.g. a CI job or another agent framework) must
discover the root by calling `inbox.sh root`, never by hardcoding the default path.** The default
lives in exactly one place — this script — precisely because a second hardcoded copy silently
drifts from it:

```bash
ROOT="$(bash "$S" root)"
```

`root` is a pure query — no side effects, safe to call before anything exists on disk. It prints
`$CONSULTUM_INBOX` if set, else the default (`~/.claude/inbox`).

## 5. Housekeeping

```bash
bash "$S" list --all              # open and closed
bash "$S" close <ID>              # move a question to closed/ (answered or not)
bash "$S" prune --days 30         # delete closed questions older than N days; never touches open/
bash "$S" watch                   # one line per new ask/answer (feed to Monitor)
```

## Exit codes

`0` ok · `10` usage error (bad flags, `answer` on an already-answered/closed question, `wait`
without `--timeout`) · `11` refused by policy (`ask --sensitive` while
`CONSULTUM_INBOX_REFUSE_SENSITIVE=1`) · `20` pending (expected, not an error) · `21` wait-timeout.

## Hard rules

- **Not the pair channel.** `contrib/pair` is for two *live* sessions watching each other.
  This is for one side that may not look for hours. Don't mix roots — see `docs/human-inbox.md`
  for why the default root is deliberately not nested under pair's.
- **Body via stdin or `--file`, never argv.** Argv leaks to `ps`.
- **Redaction is not optional and is not vendored.** `ask` calls consultum's real
  `redactSecrets` by resolving the installed binary's path; it never ships its own copy.
- **PATH is trusted input.** The binary resolution walk (`command -v consultum` → real path →
  package root → `src/redact.js`) verifies the resolved package is actually named `consultum`
  and that the resolved module exports a callable `redactSecrets` before trusting it — a fake
  `consultum` earlier on `PATH` is rejected, not silently followed.
- **Ids are identifiers, not timestamps.** Never sort by them or derive elapsed time from them.
- **`check`/`wait` print only the answer body on stdout** — script-parseable by design.
