---
name: pair
description: Open a file-based two-way channel so two long-running agent sessions working the same topic can talk — ask each other blocking questions, answer them, and push unsolicited course corrections. Use when running two sessions (Claude + Claude, or Claude + OpenHands/Codex/any agent with shell access) on one problem and they need to coordinate instead of guessing or dead-ending. No API, no network — just files both sides can see. Trigger on "pair these sessions", "let the two agents talk", "open a consult channel", "join the pair channel".
---

# /pair — two sessions, one channel

Two agent sessions on the same topic cannot see each other. One holds the strategic context, the other is deep in a tool loop; when the second hits a decision above its weight class it either **guesses** or **stops silently**. Both are expensive. This gives them a mailbox.

Roles are symmetric — either side may ask or answer. Channels live under `$PAIR_HOME` (default `~/.claude/consult/<topic>/`), outside any repo, so one channel spans worktrees, repos, and engines.

**Rationale, evidence, and the full protocol for non-Claude agents: [`docs/paired-sessions.md`](../../docs/paired-sessions.md).** Read it before wiring up an external agent or a container. This file is the operating manual.

`S=contrib/pair/pair.sh` — or copy this directory to `~/.claude/skills/pair/` and use `S=$HOME/.claude/skills/pair/pair.sh`.

## 1. Start / join

```bash
bash "$S" init <topic>      # idempotent — both sides run it
```

Then **arm the watcher**, or the channel is silent and you will never learn a question arrived:

```
Monitor({ command: 'bash "$S" watch <topic>', description: 'pair channel <topic>',
          persistent: true, timeout_ms: 3600000 })
```

Tell the user verbatim what to paste into the other session: `/pair join <topic>`. Both sides watch — that is what makes it bidirectional.

## 2. Ask — when blocked, never guess

Write the body with the `Write` tool to a scratch file (shell quoting mangles multiline bodies), then:

```bash
ID=$(bash "$S" ask <topic> --file /path/to/body.md); echo "$ID"
bash "$S" wait <topic> "$ID" 600
```

All four sections, every time:

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

`## Options I'm considering` is load-bearing: it converts an open question into pick-or-correct, and a rejection of *all* your options is the highest-signal answer you can get. Never omit it.

On timeout (`exit 2`): take the safest reversible option, and say plainly — in your next message and in the PR — that the consult went unanswered.

## 3. Answer — when the Monitor pings you

```bash
cat "$PAIR_HOME/<topic>/request-<ID>.md"        # read the whole thing first
bash "$S" answer <topic> <ID> --file /path/to/answer.md
```

Lead with the decision, then the reasoning. Picking none of the offered options is legitimate and often correct — say so and give the replacement.

## 4. Interrupt a session that is mid-loop

A session only reliably reads when it has an open request, so a note may sit unseen. To reach one that is **already executing**, put the override where it must look — prepend to the task file it is working from:

```markdown
# ⛔ URGENT — READ FIRST, OVERRIDES EVERYTHING BELOW
```

`bash "$S" note <topic> <slug> --file F` is for corrections that can wait for the next checkpoint.

## 5. Close the loop

There is no `outcome` file by design: **after acting on an answer, raise a new consult saying what you changed.** That is what makes a misapplied answer catchable. A task is not done when the work compiles; it is done when the review is closed out.

## 6. Housekeeping

```bash
bash "$S" status <topic>          # open vs answered, real latencies
bash "$S" prune <topic> [days]    # drop answered exchanges older than N days (never open ones)
bash "$S" close <topic>           # delete the channel; refuses while anything is unanswered
bash "$S" list                    # all channels
```

Run `status` before ending a session — an open request means the other side is still blocked on you.

## Hard rules

- **A message channel, not a workspace.** Never point committed code at a path inside it; it is outside git on purpose, so anything living there has no version history and the repo stops building for anyone else.
- **IDs are identifiers, never timestamps.** Do not sort by them or derive elapsed time from them — a sandboxed agent's clock can run hours ahead of the filesystem's. `status` stats real file times.
- **One question per file.** Two questions get one answer.
- **No secrets, no named allegations** — reference file paths. This channel has no curator and no redaction pass; if content needs redacting, use `consultum consult` instead.
- **Don't consult on what the code or `AGENTS.md` already answers.** Frequent consults mean the spec was underspecified — fix the spec.
- **The watcher dies with the session.** Re-arm the Monitor after any restart.
