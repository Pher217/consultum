# Paired sessions — a file channel between two long-running agents

> **Experimental companion pattern — not part of the consultum CLI contract.** No
> compatibility guarantee; it may change or move to its own package. It ships here because it
> solves the same problem from the other end, and because the mechanics below were learned the
> expensive way.

`consultum consult` is **synchronous, one-shot, and model-to-model**: a stuck worker sends a
curated packet, a stronger advisor answers, the worker continues. The whole exchange is one
process lifetime.

That shape doesn't fit when both ends are **long-running interactive sessions** — say an
OpenHands coding agent grinding through a task in one window, and a Claude/Opus chat holding the
strategic context in another. Neither is a subprocess of the other. Neither can wait on the
other's process. There is no model call to make: the "advisor" is a session a human is also
reading.

For that, the cheapest thing that works is a **mailbox**: a directory both sides can see.

```
Session A  ──ask──▶  <channel>/request-<ID>.md   ──▶  Session B (notified)
Session A  ◀─wait──  <channel>/response-<ID>.md  ◀─answer──  Session B
```

Roles are symmetric — either side may ask or answer. Asynchronous, no network, no auth, no
daemon. The transcript is just files you can read afterwards.

## Does it work?

It ran for a week between an OpenHands agent and an Opus session on a public-procurement
analysis: **6 consults, 6 answers, median turnaround 1m28s, no unanswered questions.** Its most
valuable single moment was a course correction — the agent had written ~10 scripts hammering a
rate-limited API into `HTTP 429`, and one message redirected it onto the lawful bulk download,
preserving a provenance chain the scraping would have destroyed.

The pattern is proven enough to document. It is **not** proven enough to be a supported CLI
surface — see *Graduation* at the bottom.

## Use it

`pair.sh` lives in the repository at
[`contrib/pair/`](https://github.com/Pher217/consultum/tree/main/contrib/pair),
with a `SKILL.md` for agents that load skills. **It is not in the npm package** — the published
tarball is the CLI, and this is an experimental pattern; copy the script out of the repo.

```bash
S=contrib/pair/pair.sh

bash "$S" init review              # create the channel; both sides run this
ID=$(bash "$S" ask review --file question.md)
bash "$S" wait review "$ID" 600    # blocks; prints the answer when it lands

bash "$S" answer review "$ID" --file answer.md   # the other side
bash "$S" status review            # open vs answered, with real latencies
bash "$S" watch review             # one line per new message — pipe to your notifier
```

Channels live under `$PAIR_HOME` (default `~/.claude/consult/<topic>/`), **outside any repo**, so
one channel spans worktrees, repos, and engines.

### The message

```markdown
## Question
<the single decision you are blocked on>
## Context
<what you're doing, what you tried, why you're stuck — 3-6 lines>
## Files
<paths, PR URL, a small snippet>
## Options I'm considering
<your candidate answers>
```

`## Options I'm considering` is the load-bearing field. It turns an open question into
*pick-or-correct*, which is far cheaper to answer — and when the other side rejects **all** the
options, that rejection is the highest-signal event in the channel. In the run above it happened
once, and it replaced a weak positive result with a null result plus three named methodology
defects. Never omit the field.

### Wiring up a non-Claude agent

Put the protocol in the agent's `AGENTS.md` — **not** in a per-task file. A standing rule
copy-pasted into each task file gives every new task a chance to drop it or let copies drift;
that is exactly what happened in the run above (`grep -c consult AGENTS.md` → `0`).

```
On any STOP-AND-ASK, never guess and never stop silently:
  ID=$(date -u +%Y%m%dT%H%M%S)-$$-$RANDOM
  C=~/.claude/consult/<topic>
  # write $C/.tmp.$$ with: ## Question / ## Context / ## Files / ## Options I'm considering
  mv $C/.tmp.$$ $C/request-$ID.md        # rename LAST — never publish a half-written question
  for i in $(seq 1 120); do [ -f $C/response-$ID.md ] && break; sleep 5; done
  cat $C/response-$ID.md                 # then follow it
If nothing arrives, take the safest reversible option and record the unanswered consult.
```

If that agent runs in a container, the channel directory **must be mounted into it at the same
path**. Otherwise each side writes into its own inbox and the failure mode is silence — which is
indistinguishable from "the other session is still thinking."

## The mechanics, and why

Every one of these is a bug that shipped in the naive version and lost or corrupted messages.

**Publish by rename.** Write a temp file on the same filesystem, then `mv` it into place. A
reader polling `[ -f response-$ID.md ]` sees the file the instant it is *created*, not when it is
finished — so a directly-written answer hands the other side a truncated directive it treats as
complete. Rename is atomic; there is no partial state to observe.

**IDs need entropy.** A bare `date -u +%Y%m%dT%H%M%S` collides for two messages in the same
second, and the second silently overwrites the first. Append `-$$-$RANDOM`.

**IDs are not timestamps.** A sandboxed agent's clock is not the filesystem's. In the run above,
two of six request IDs ran **1h30m and 2h21m ahead** of the file's real creation time, which put
the filenames in the wrong chronological order on disk. Never sort by an ID or compute elapsed
time from one; `stat` the file.

**Seen-markers on disk, not in a variable.** A watcher that tracks announced messages in a shell
variable re-announces the entire history every time it restarts.

**Mode 700.** Messages quote working context and paths into private repos. The channel is
created `chmod 700`.

**Prune.** `pair.sh prune <topic> [days]` drops answered exchanges older than N days (never open
ones). An unbounded channel makes `status` useless for spotting the one request someone is still
blocked on. `pair.sh close <topic>` deletes a finished channel and refuses while anything is
unanswered.

## Rules

- **It is a message channel, not a workspace.** Never point committed code at a path inside it.
  This bit for real: a committed analysis script read its primary-source input from the channel
  directory, which was git-excluded — so the repo did not build for anyone else, and the input to
  the headline finding had no version history. It was described as 47, 50, and 52 rows in three
  places while actually holding 52.
- **One question per file.** Two questions get one answer.
- **No secrets, no named allegations** — reference file paths. Unlike `consultum consult`, this
  channel has **no curator and no redaction pass**: whatever you write is what the other session
  reads. If the content needs redacting, use `consultum consult`.
- **Close the loop.** After acting on an answer, raise a *new* consult saying what you changed.
  That is what makes a misapplied answer catchable — better than an `outcome` file, because it is
  checkable by the other side.
- **Don't consult on what the code or `AGENTS.md` already answers.** Frequent consults mean the
  task spec was underspecified. Fix the spec.
- **The watcher dies with the session.** Re-arm it after any restart; `status` shows what you
  missed.

## Graduation

This stays a documented pattern plus a shell script until it earns more. It becomes real
software — most likely a **separate package sharing consultum's packet format**, rather than
`consultum pair` — when either of these holds:

- **25–50 successful exchanges** across more than one project, or
- **users other than the author** running it.

Until then, adding six verbs to a v0.1 CLI whose identity is *"route a packet to a stronger
model"* would trade a sharp product sentence for a broad coordination runtime. The mailbox makes
no model call at all; it does not belong in that contract yet.

## See also

- [`when-to-consult.md`](when-to-consult.md) — whether to escalate at all
- [`architecture.md`](architecture.md) — how the real (synchronous, model-to-model) channel works
- [`sandboxed-callers.md`](sandboxed-callers.md) — the other hard case: a worker behind a sandbox
