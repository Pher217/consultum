# Human inbox — an asynchronous request/answer channel from an agent to a human

> **Experimental companion pattern — not part of the consultum CLI contract.** No compatibility
> guarantee. It ships in `contrib/` for the same reason `contrib/pair` does: it solves a real
> coordination problem and the mechanics are worth documenting even before the shape is final.

`consultum consult` is synchronous and model-to-model: a curated packet goes out, an advisor
answers, the calling process is still running the whole time. `contrib/pair` is asynchronous but
assumes **both** sides are live sessions, each polling or watching.

Neither fits an agent that needs a **human** decision when the human might not be looking —
a batch job hitting an ambiguous case at 2am, a CI bot that should not auto-approve a risky
migration, a sandboxed worker that should escalate rather than guess. For that, the cheapest thing
that works is a mailbox with no daemon requirement on the request/answer path itself: `ask`
returns immediately with an id; the human answers whenever they get to it; the agent polls
(`check`) or blocks with a bound (`wait --timeout`).

```
Agent  ──ask────▶  open/<id>/question.md   ──▶  Human (via list/show)
Agent  ◀─check/wait─  open/<id>/answer.md  ◀──answer──  Human
```

## Layout

```
$CONSULTUM_INBOX/
  open/<id>/
    question.md          the redacted question body
    meta.json             id, slug, from, sensitive, urgency, cwd, branch, created, answered
    answer.md              (once answered)
    answer.meta.json        (once answered)
  closed/<id>/            same shape, moved here by `close`
```

`<id>` = `YYYYMMDDTHHMMSSZ-<slug>-<pid>-<rand>`. **Ids are identifiers only** — never sort by them
or derive elapsed time from them. A sandboxed agent's clock can run hours ahead of the
filesystem's; order by file birth time if you need chronology.

`meta.json`'s `answered` field is a **derived mirror**, written for convenience. The source of
truth everywhere in this tool is `[ -f answer.md ]`. A hand-edited or corrupted `meta.json` that
claims `"answered": true` with no `answer.md` on disk still reports pending.

## Root — one definition, discovered, not hardcoded

Default: `$CONSULTUM_INBOX`, else `$HOME/.claude/inbox`.

**This root is deliberately independent of `contrib/pair`'s root** (`$HOME/.claude/consult`).
`pair.sh close <topic>` (no `--force`) decides whether a channel is safe to delete by counting
`request-*.md` files directly under the topic directory — a filename this tool never produces
(it uses `open/<id>/question.md`, not `request-<id>.md`). Nesting the inbox under pair's root as
`$HOME/.claude/consult/inbox/` would make `pair.sh close inbox` see **zero** `request-*.md` files
and conclude the channel is empty — then `rm -rf` a populated inbox. This was reproduced live.
Keep the roots apart; `test/inbox-channel.test.mjs` asserts the default is not nested under
pair's.

**External callers (another repo, another tool) must resolve the root by calling `inbox.sh
root`,** not by hardcoding `~/.claude/inbox`. The default lives in exactly one place — this
script — because a second hardcoded copy of the same constant silently drifts from it the moment
either side changes. `root` is a pure query: no side effects, safe to call before the directory
exists.

```bash
ROOT="$(bash contrib/inbox/inbox.sh root)"
```

## Redaction — not optional, not vendored

`ask` pipes the question body through consultum's real `redactSecrets` (`src/redact.js`) before
anything touches disk. Because `import("consultum")` does not resolve from outside this repo,
`inbox.sh` resolves the path by walking from the installed binary:

```
bin=$(command -v consultum)
real=$(readlink -f "$bin")                 # GNU; macOS falls back to a python3 os.path.realpath
pkg=$(dirname $(dirname "$real"))           # …/bin/consultum.js -> package root
redact_js="$pkg/src/redact.js"
```

If any hop fails — `consultum` not on `PATH`, the resolved path missing, `redact.js` not where
expected — **`ask` hard-fails and writes nothing.** A redaction control that silently no-ops on
failure is worse than no control at all; see `docs/threat-model.md` §A8.

Redaction applies to `ask` only. `answer` is written by a human and is not passed through the
redactor — see *Non-goals* below.

## Atomicity and concurrency

- `ask` builds `question.md` + `meta.json` in a temp directory **on the same filesystem as the
  destination** (inside `open/`, not `$TMPDIR`), then `mv`s the whole directory into place. A
  reader can never observe a half-written question — either `open/<id>/` doesn't exist yet, or it
  exists complete.
- `answer` takes an atomic claim (`mkdir "$d/answer.claim"`, which is an atomic exclusive-create
  at the filesystem level) **before** writing. Two concurrent `answer` invocations cannot both
  pass a check-then-write race — only one wins the `mkdir`.
- `answer` **refuses to overwrite** an existing `answer.md` (exit 10), leaving the original bytes
  untouched. If an answer was wrong, `close` the question and `ask` a new one.
- `meta.json` is written via `node -e … JSON.stringify(...)`, never shell string interpolation —
  `cwd` and `branch` can contain quotes or newlines that would corrupt hand-built JSON.
- Every question directory and the root are `chmod 700` — the body can contain repo paths, file
  contents, and working context.
- Ids and slugs are validated against a strict charset (`[A-Za-z0-9_-]` only); `..` and `/` are
  rejected outright, closing the path-traversal route through `--slug`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | ok |
| `10` | usage error — bad flags, `answer` on an already-answered/closed question, `wait` without `--timeout` |
| `11` | refused by policy — `ask --sensitive` while `CONSULTUM_INBOX_REFUSE_SENSITIVE=1` |
| `20` | pending — `check` on an unanswered question. Expected, not an error. |
| `21` | `wait` hit its timeout with no answer |

Codes `12`–`15` are reserved and never emitted by this tool.

### The `set -e` trap

`check`'s exit `20` is a **status**, not a failure — but a caller running under `set -e` doesn't
know that:

```bash
set -e
answer=$(bash contrib/inbox/inbox.sh check "$id")   # script exits here while pending — silently
```

Use the `if`/`case` pattern instead:

```bash
if answer=$(bash contrib/inbox/inbox.sh check "$id"); then
  echo "$answer"
else
  status=$?
  case "$status" in
    20) echo "still pending" ;;
    *)  echo "check failed ($status)"; exit "$status" ;;
  esac
fi
```

## Verbs

```
inbox.sh ask    [--slug S] [--from KIND:REF] [--sensitive] [--urgency blocking|fyi] [--file F]
inbox.sh list   [--all]
inbox.sh show   <ID>
inbox.sh check  <ID>
inbox.sh wait   <ID> --timeout SECONDS
inbox.sh answer <ID> [--file F]
inbox.sh root
inbox.sh close  <ID>
inbox.sh prune  [--days N]
inbox.sh watch
```

Bodies arrive on **stdin or `--file`, never argv** — argv leaks via `ps`. `ask` prints only the
id on stdout; all human-facing text goes to stderr. `check`/`wait` print only the answer body on
stdout, so `answer=$(inbox.sh check "$id")` composes cleanly once the exit code is handled.

## Non-goals

Not a notification system on its own — pair `watch` with the `Monitor` tool (or a cron-style
poller) if you need a human to be paged rather than checking `list`. Not a review/approval
workflow with audit trail beyond the files themselves — the `open/`/`closed/` split and
`meta.json` are enough for a single human working alone, not a multi-approver process. `answer`
bodies are not redacted (a human typed them; redaction targets agent-sourced content flowing
toward a model, per `docs/threat-model.md` §A8) — don't paste secrets into an answer.

## Related

- `contrib/pair/pair.sh` + `docs/paired-sessions.md` — the sibling pattern for two *live* sessions
  watching each other, not an agent asking a human who may be away.
- `docs/threat-model.md` §A8 — the adversary analysis for this channel.
