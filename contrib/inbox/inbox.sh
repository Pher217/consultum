#!/usr/bin/env bash
# inbox.sh — asynchronous, folder-backed request/answer channel from an AGENT to a HUMAN.
# No API, no network, no daemon required for the request/answer path. An agent asks a question
# and moves on; a human answers whenever they get to it; the agent polls or blocks with `wait`.
#
# This is deliberately NOT part of the consultum CLI (npm `bin`) — it lives in contrib/, is not
# published, and has no compatibility guarantee. See docs/human-inbox.md.
set -euo pipefail

# Root is independent of pair.sh's channel root ($HOME/.claude/consult) on purpose. pair.sh's
# `close <topic>` (no --force) counts request-*.md files directly under the topic dir to decide
# whether work is unanswered — a layout this tool never produces. Nesting the inbox under
# pair.sh's root lets `pair.sh close inbox` silently rm -rf a populated inbox because it sees
# zero request-*.md files and concludes nothing is open. Reproduced live — keep the roots apart.
ROOT="${CONSULTUM_INBOX:-$HOME/.claude/inbox}"

die() { # die <message> [exit-code, default 10]
  local msg="$1" code="${2:-10}"
  printf 'inbox: %s\n' "$msg" >&2
  exit "$code"
}

validate_id() {
  case "$1" in
    ''|*[!A-Za-z0-9_-]*) die "invalid id: ${1:-<empty>}" ;;
  esac
}

validate_slug() {
  case "$1" in
    ''|*[!A-Za-z0-9_-]*) die "invalid slug: ${1:-<empty>}" ;;
  esac
}

# Prints the path of <ROOT>/{open,closed}/<id> on stdout; fails if neither exists.
find_qdir() {
  local id="$1"
  if [ -d "$ROOT/open/$id" ]; then printf '%s\n' "$ROOT/open/$id"; return 0; fi
  if [ -d "$ROOT/closed/$id" ]; then printf '%s\n' "$ROOT/closed/$id"; return 0; fi
  return 1
}

# Ids are identifiers ONLY — never sort by them or derive elapsed time from them. A sandboxed
# agent's clock can run hours ahead of the filesystem's; order by file birth time instead.
newid() { # newid <slug>
  printf '%s-%s-%s-%s%s' "$(date -u +%Y%m%dT%H%M%SZ)" "$1" "$$" "$RANDOM" "$RANDOM"
}

# Resolve consultum's redact.js by walking from the binary on PATH — `import("consultum")` does
# not resolve outside this repo. Hard-fails (writes nothing) if any hop is missing: a redaction
# control that silently no-ops is worse than no control.
#
# PATH IS TRUSTED INPUT. A caller that controls PATH ahead of the real consultum install (a fake
# `<dir>/bin/consultum` or a fake `node`) could otherwise make this resolve to an attacker-chosen
# `src/redact.js` that writes unredacted content while claiming `redacted: true`. After resolving
# the package root, verify its identity (`package.json` name is literally "consultum") and verify
# the resolved module actually exports a callable `redactSecrets` before trusting it — see
# docs/threat-model.md §A8.
resolve_redact_js() {
  local bin real pkg rj
  bin="$(command -v consultum 2>/dev/null)" || die "cannot resolve redaction: 'consultum' not found on PATH — refusing to write unredacted content"
  real="$(node -e '
    const fs = require("fs");
    try { process.stdout.write(fs.realpathSync(process.argv[1])); } catch { process.exit(1); }
  ' "$bin" 2>/dev/null || true)"
  [ -n "$real" ] || die "cannot resolve the real path of the consultum binary — refusing to write unredacted content"
  pkg="$(dirname "$(dirname "$real")")"

  [ -f "$pkg/package.json" ] || die "cannot verify package identity: no $pkg/package.json — refusing to write unredacted content (PATH is trusted input; see docs/threat-model.md §A8)"
  node -e '
    const fs = require("fs");
    const pkgJson = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (pkgJson.name !== "consultum") process.exit(1);
  ' "$pkg/package.json" 2>/dev/null \
    || die "PATH resolves to a package named other than 'consultum' at $pkg — refusing to write unredacted content (PATH is trusted input; see docs/threat-model.md §A8)"

  rj="$pkg/src/redact.js"
  [ -f "$rj" ] || die "cannot locate redact.js at $rj — refusing to write unredacted content"

  node --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const rjPath = process.argv[1];
    const mod = await import(pathToFileURL(rjPath).href);
    if (typeof mod.redactSecrets !== "function") process.exit(1);
  ' "$rj" 2>/dev/null \
    || die "redact.js at $rj does not export a callable redactSecrets — refusing to write unredacted content"

  printf '%s\n' "$rj"
}

# Reads its own stdin, writes the redacted text to stdout. Caller controls what's on stdin.
redact_stdin() { # redact_stdin <redact.js path>
  local rj="$1"
  node --input-type=module -e '
import { pathToFileURL } from "node:url";
const rjPath = process.argv[1];
const mod = await import(pathToFileURL(rjPath).href);
let data = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) data += chunk;
process.stdout.write(mod.redactSecrets(data));
' "$rj"
}

body_from() { # body_from [--file PATH] ; falls back to stdin
  if [ "${1:-}" = "--file" ]; then
    [ -f "${2:-}" ] || die "no such file: ${2:-}"
    cat "$2"
  else
    cat
  fi
}

cmd_ask() {
  local slug="q" from="" sensitive=0 urgency="" file=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --slug) [ $# -ge 2 ] || die "ask: --slug needs a value"; slug="$2"; shift 2 ;;
      --from) [ $# -ge 2 ] || die "ask: --from needs a value"; from="$2"; shift 2 ;;
      --sensitive) sensitive=1; shift ;;
      --urgency) [ $# -ge 2 ] || die "ask: --urgency needs a value"; urgency="$2"; shift 2 ;;
      --file) [ $# -ge 2 ] || die "ask: --file needs a value"; file="$2"; shift 2 ;;
      *) die "ask: unknown argument: $1" ;;
    esac
  done
  case "$urgency" in ''|blocking|fyi) : ;; *) die "ask: --urgency must be 'blocking' or 'fyi'" ;; esac
  validate_slug "$slug"

  if [ "$sensitive" = 1 ] && [ "${CONSULTUM_INBOX_REFUSE_SENSITIVE:-0}" = "1" ]; then
    die "ask: sensitive question refused by policy (CONSULTUM_INBOX_REFUSE_SENSITIVE=1)" 11
  fi

  # Resolve redaction BEFORE any filesystem mutation. If this fails, nothing is written anywhere.
  local rj; rj="$(resolve_redact_js)"

  local id cwd branch
  id="$(newid "$slug")"
  cwd="$(pwd)"
  branch="$(git branch --show-current 2>/dev/null || true)"

  mkdir -p "$ROOT/open"
  # A question body carries repo paths and working context — 0700 is the stated protection
  # (B3). Both directories are guaranteed to exist at this point, so a chmod failure here is a
  # real, actionable error, not a "target doesn't exist yet" race: fail loudly, don't publish.
  chmod 700 "$ROOT" "$ROOT/open" \
    || die "ask: could not set 0700 permissions on $ROOT — refusing to publish"

  # Build in a temp dir ON THE SAME FILESYSTEM as the destination (inside ROOT/open), then mv it
  # into place — question.md + meta.json must never be observable as a partial record, and a
  # cross-filesystem mv (e.g. from $TMPDIR) would not be atomic.
  local tmpdir="$ROOT/open/.tmp.$$-$RANDOM"
  mkdir "$tmpdir" || die "ask: could not create working directory"
  chmod 700 "$tmpdir"

  if [ -n "$file" ]; then
    [ -f "$file" ] || { rm -rf "$tmpdir"; die "ask: no such file: $file"; }
    redact_stdin "$rj" < "$file" > "$tmpdir/question.md" || { rm -rf "$tmpdir"; die "ask: redaction failed"; }
  else
    redact_stdin "$rj" > "$tmpdir/question.md" || { rm -rf "$tmpdir"; die "ask: redaction failed"; }
  fi

  # schemaVersion is present from day one — adding it later would itself be the breaking change
  # (same reasoning as StructuredRecommendation in consult.js). `redacted: true` records that the
  # redaction control actually ran, so it's auditable after the fact rather than merely claimed.
  # No `answered` field here (B2): it was written false at ask time and never flipped, so it was
  # simply false information sitting next to the question. `[ -f answer.md ]` is already the sole
  # source of truth for "answered" — don't keep a second, driftable copy of the same fact.
  node -e '
    const fs = require("fs");
    const [, metaPath, id, slug, from, sensitive, urgency, cwd, branch] = process.argv;
    fs.writeFileSync(metaPath, JSON.stringify({
      schemaVersion: 1,
      id, slug,
      from: from || null,
      sensitive: sensitive === "1",
      urgency: urgency || null,
      cwd, branch: branch || null,
      created: new Date().toISOString(),
      redacted: true,
    }, null, 2) + "\n");
  ' "$tmpdir/meta.json" "$id" "$slug" "$from" "$sensitive" "$urgency" "$cwd" "$branch" \
    || { rm -rf "$tmpdir"; die "ask: could not write meta.json"; }

  mv -f "$tmpdir" "$ROOT/open/$id"
  printf '%s\n' "$id"
}

cmd_list() {
  local all=0
  case "${1:-}" in --all) all=1 ;; esac
  if [ ! -d "$ROOT/open" ] && [ ! -d "$ROOT/closed" ]; then
    printf 'no questions (%s)\n' "$ROOT"
    return 0
  fi
  local d id status
  if [ -d "$ROOT/open" ]; then
    for d in "$ROOT"/open/*/; do
      [ -d "$d" ] || continue
      id="$(basename "$d")"
      [ -f "$d/answer.md" ] && status=answered || status=pending
      printf '%-8s %-60s %s\n' open "$id" "$status"
    done
  fi
  if [ "$all" = 1 ] && [ -d "$ROOT/closed" ]; then
    for d in "$ROOT"/closed/*/; do
      [ -d "$d" ] || continue
      id="$(basename "$d")"
      [ -f "$d/answer.md" ] && status=answered || status=pending
      printf '%-8s %-60s %s\n' closed "$id" "$status"
    done
  fi
}

cmd_show() {
  local id="${1:-}"
  [ -n "$id" ] || die "usage: inbox.sh show <ID>"
  validate_id "$id"
  local d; d="$(find_qdir "$id")" || die "show: no such id: $id"
  printf '== question (%s) ==\n' "$id"
  cat "$d/question.md"
  if [ -f "$d/answer.md" ]; then
    printf '\n== answer ==\n'
    cat "$d/answer.md"
  else
    printf '\n(pending — no answer yet)\n'
  fi
}

# check: source of truth for "answered" is [ -f answer.md ], never meta.json's `answered` field
# (which is a derived, hand-editable mirror). A forged meta.json must never flip this.
cmd_check() {
  local id="${1:-}"
  [ -n "$id" ] || die "usage: inbox.sh check <ID>"
  validate_id "$id"
  local d; d="$(find_qdir "$id")" || die "check: no such id: $id"
  if [ -f "$d/answer.md" ]; then
    cat "$d/answer.md"
    exit 0
  fi
  exit 20
}

cmd_wait() {
  local id="" timeout=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --timeout) [ $# -ge 2 ] || die "wait: --timeout needs a value"; timeout="$2"; shift 2 ;;
      -*) die "wait: unknown argument: $1" ;;
      *) [ -z "$id" ] || die "wait: unexpected argument: $1"; id="$1"; shift ;;
    esac
  done
  [ -n "$id" ] || die "usage: inbox.sh wait <ID> --timeout SECONDS"
  # No --timeout is a usage error, checked BEFORE any loop — wait must not poll without one.
  [ -n "$timeout" ] || die "usage: inbox.sh wait <ID> --timeout SECONDS (missing --timeout)"
  case "$timeout" in *[!0-9]*|'') die "wait: --timeout must be a non-negative integer" ;; esac
  validate_id "$id"

  local d elapsed=0 interval=2 step
  while :; do
    d="$(find_qdir "$id")" || die "wait: no such id: $id"
    if [ -f "$d/answer.md" ]; then
      cat "$d/answer.md"
      exit 0
    fi
    if [ "$elapsed" -ge "$timeout" ]; then
      printf 'inbox: wait timed out after %ss for %s\n' "$timeout" "$id" >&2
      exit 21
    fi
    step=$interval
    [ $((elapsed + step)) -gt "$timeout" ] && step=$((timeout - elapsed))
    [ "$step" -le 0 ] && step=1
    sleep "$step"
    elapsed=$((elapsed + step))
  done
}

cmd_answer() {
  local id="" file=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --file) [ $# -ge 2 ] || die "answer: --file needs a value"; file="$2"; shift 2 ;;
      -*) die "answer: unknown argument: $1" ;;
      *) [ -z "$id" ] || die "answer: unexpected argument: $1"; id="$1"; shift ;;
    esac
  done
  [ -n "$id" ] || die "usage: inbox.sh answer <ID> [--file F]"
  validate_id "$id"

  local d
  if [ -d "$ROOT/open/$id" ]; then
    d="$ROOT/open/$id"
  elif [ -d "$ROOT/closed/$id" ]; then
    die "answer: $id is already closed"
  else
    die "answer: no such id: $id"
  fi

  # Atomic claim BEFORE writing — mkdir is an atomic exclusive-create at the filesystem level, so
  # two concurrent answerers cannot both pass a check-then-write race.
  if ! mkdir "$d/answer.claim" 2>/dev/null; then
    die "answer: $id is already answered or is being answered right now"
  fi

  if [ -f "$d/answer.md" ]; then
    rmdir "$d/answer.claim" 2>/dev/null || true
    die "answer: $id already has an answer — refusing to overwrite"
  fi

  local tmp="$d/.answer.tmp.$$"
  if [ -n "$file" ]; then
    if [ ! -f "$file" ]; then
      rmdir "$d/answer.claim" 2>/dev/null || true
      die "answer: no such file: $file"
    fi
    cat "$file" > "$tmp"
  else
    cat > "$tmp"
  fi

  # B1: publication is a transaction. Stage the COMPLETE answer.meta.json first and verify it
  # actually landed as a regular, non-empty file — only THEN move answer.md into place. This
  # way a reader can never observe answer.md with no (or partial) metadata. answer.md remains
  # the single source of truth for "answered"; the ordering exists only to make the record
  # complete before it becomes observable, not to create a second source of truth.
  local meta_tmp="$d/.answer.meta.tmp.$$"
  if ! node -e '
    const fs = require("fs");
    const [, metaPath, id] = process.argv;
    fs.writeFileSync(metaPath, JSON.stringify({
      schemaVersion: 1,
      id,
      ts: new Date().toISOString(),
      by: "human:cli",
      surface: "cli",
      note: null,
    }, null, 2) + "\n");
  ' "$meta_tmp" "$id"; then
    rm -f "$tmp" "$meta_tmp"
    rmdir "$d/answer.claim" 2>/dev/null || true
    die "answer: could not write answer.meta.json — refusing to publish answer.md"
  fi

  if ! mv -f "$meta_tmp" "$d/answer.meta.json" \
     || [ ! -f "$d/answer.meta.json" ] || [ ! -s "$d/answer.meta.json" ]; then
    rm -f "$tmp" "$meta_tmp"
    rmdir "$d/answer.claim" 2>/dev/null || true
    die "answer: could not publish answer.meta.json — refusing to publish answer.md"
  fi

  mv -f "$tmp" "$d/answer.md"
  rmdir "$d/answer.claim" 2>/dev/null || true
  printf 'answered %s\n' "$id"
}

# Pure query: prints the resolved absolute inbox root and exits. No side effects — must be safe
# to call before anything exists on disk. This is the ONE place the default lives; an external
# caller (a different repo, e.g. vigil) must call `inbox.sh root` instead of hardcoding the
# default, or its copy silently drifts from this one.
cmd_root() {
  printf '%s\n' "$ROOT"
}

cmd_close() {
  local id="${1:-}"
  [ -n "$id" ] || die "usage: inbox.sh close <ID>"
  validate_id "$id"
  if [ -d "$ROOT/closed/$id" ]; then
    die "close: $id is already closed"
  fi
  [ -d "$ROOT/open/$id" ] || die "close: no such id: $id"
  mkdir -p "$ROOT/closed"
  mv -f "$ROOT/open/$id" "$ROOT/closed/$id"
  printf 'closed %s\n' "$id"
}

# prune only ever touches closed/ — open questions are never pruned, answered or not.
cmd_prune() {
  local days=30
  case "${1:-}" in --days) [ $# -ge 2 ] || die "prune: --days needs a value"; days="$2" ;; esac
  case "$days" in *[!0-9]*|'') die "prune: --days must be a non-negative integer" ;; esac
  if [ ! -d "$ROOT/closed" ]; then
    printf 'nothing to prune (%s)\n' "$ROOT"
    return 0
  fi
  # Manual mtime comparison, not `find -mtime +N` — find's +N means "more than N whole days ago"
  # and truncates, so `--days 0` (prune everything closed, right now) would match nothing for a
  # dir that is only seconds old. Mirrors pair.sh's btime probe: macOS stat first, then Linux.
  local cutoff n=0 d mtime
  cutoff=$(( $(date +%s) - days * 86400 ))
  for d in "$ROOT"/closed/*/; do
    [ -d "$d" ] || continue
    mtime="$(stat -f %m "$d" 2>/dev/null || stat -c %Y "$d" 2>/dev/null || echo 0)"
    if [ "$mtime" -le "$cutoff" ]; then
      rm -rf "$d"
      n=$((n + 1))
    fi
  done
  printf 'pruned %s closed question(s) older than %s days from %s\n' "$n" "$days" "$ROOT/closed"
}

# is_sensitive <dir> — true if <dir>/meta.json marks the question sensitive. `watch` uses this to
# withhold a content preview: watch's whole purpose is to echo excerpts into a chat feed (via
# Monitor), and a question marked sensitive must never have its body surface there.
is_sensitive() {
  local d="$1"
  [ -f "$d/meta.json" ] || return 1
  node -e '
    const fs = require("fs");
    try {
      const meta = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.exit(meta.sensitive === true ? 0 : 1);
    } catch { process.exit(1); }
  ' "$d/meta.json" 2>/dev/null
}

# One line per new event. Feed this to the Monitor tool so each line becomes a chat
# notification. Seen-markers live on disk under ROOT/.seen, so restarting the watcher does not
# re-announce old events.
cmd_watch() {
  mkdir -p "$ROOT/open" "$ROOT/.seen"
  # Same 0700 rationale as cmd_ask (B3): both dirs are guaranteed to exist here, so a chmod
  # failure is real and actionable — fail loudly rather than run a watcher over an unprotected
  # root.
  chmod 700 "$ROOT" "$ROOT/.seen" \
    || die "watch: could not set 0700 permissions on $ROOT — refusing to start"
  while true; do
    local d id
    for d in "$ROOT"/open/*/; do
      [ -d "$d" ] || continue
      id="$(basename "$d")"
      if [ -f "$d/question.md" ] && [ ! -e "$ROOT/.seen/$id.asked" ]; then
        : > "$ROOT/.seen/$id.asked"
        if is_sensitive "$d"; then
          printf 'INBOX[ask] %s :: [sensitive question — see `inbox.sh show %s`]\n' "$id" "$id"
        else
          printf 'INBOX[ask] %s :: %s\n' "$id" \
            "$( (grep -v -e '^$' "$d/question.md" || true) | head -c 200 | tr '\n' ' ')"
        fi
      fi
      if [ -f "$d/answer.md" ] && [ ! -e "$ROOT/.seen/$id.answered" ]; then
        : > "$ROOT/.seen/$id.answered"
        if is_sensitive "$d"; then
          printf 'INBOX[answer] %s :: [sensitive question — see `inbox.sh show %s`]\n' "$id" "$id"
        else
          printf 'INBOX[answer] %s :: %s\n' "$id" \
            "$( (grep -v -e '^$' "$d/answer.md" || true) | head -c 200 | tr '\n' ' ')"
        fi
      fi
    done
    sleep 5
  done
}

case "${1:-}" in
  ask)    shift; cmd_ask "$@" ;;
  list)   shift; cmd_list "$@" ;;
  show)   shift; cmd_show "$@" ;;
  check)  shift; cmd_check "$@" ;;
  wait)   shift; cmd_wait "$@" ;;
  answer) shift; cmd_answer "$@" ;;
  root)   shift; cmd_root "$@" ;;
  close)  shift; cmd_close "$@" ;;
  prune)  shift; cmd_prune "$@" ;;
  watch)  shift; cmd_watch "$@" ;;
  *) cat >&2 <<'EOF'
inbox.sh — asynchronous request/answer channel from an agent to a human

  ask [--slug S] [--from KIND:REF] [--sensitive] [--urgency blocking|fyi] [--file F]
                                      write a question (body: file or stdin, redacted first),
                                      print its ID on stdout — human-facing text goes to stderr
  list [--all]                       open questions (add --all for closed too)
  show <ID>                          print the question, and the answer if present
  check <ID>                         print the answer to stdout, exit 20 if still pending
  wait <ID> --timeout SECONDS        block until answered or the timeout, exit 21 on timeout
  answer <ID> [--file F]             answer an open question (body: file or stdin)
  root                                print the resolved inbox root and exit (no side effects —
                                      external callers use this instead of hardcoding the default)
  close <ID>                         move a question from open/ to closed/
  prune [--days N]                   delete closed questions older than N days (default 30)
  watch                              one line per new ask/answer (feed to Monitor)

Exit codes: 0 ok, 10 usage/setup error, 11 refused by policy, 20 pending, 21 wait-timeout.

Env: CONSULTUM_INBOX (default ~/.claude/inbox), CONSULTUM_INBOX_REFUSE_SENSITIVE=1 to refuse
     `ask --sensitive`.
EOF
    exit 10 ;;
esac
