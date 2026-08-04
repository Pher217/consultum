#!/usr/bin/env bash
# pair.sh — file-based bidirectional channel between two long-running agent sessions.
# No API, no auth, no network. Two sessions that share a filesystem can talk.
set -euo pipefail

ROOT="${PAIR_HOME:-$HOME/.claude/consult}"
ME="${PAIR_NAME:-$(hostname -s 2>/dev/null || echo session)-$$}"

die() { printf 'pair: %s\n' "$*" >&2; exit 1; }
chan() { [ -n "${1:-}" ] || die "no topic given"; printf '%s/%s' "$ROOT" "$1"; }
need() { [ -d "$(chan "$1")" ] || die "no channel '$1' — run: pair.sh init $1"; }

# Collision-safe ID. A bare UTC timestamp collides within the same second, and a
# sandboxed agent's clock can run hours ahead of the filesystem's, so IDs are
# identifiers only — never sort by them or derive elapsed time from them.
newid() { printf '%s-%s-%s' "$(date -u +%Y%m%dT%H%M%S)" "$$" "${RANDOM}"; }

# Creation time, epoch seconds. macOS birth time, else Linux, else mtime.
btime() {
  local t=''
  # Probe GNU first. BSD stat has no -c, so it fails cleanly and we fall through.
  # The reverse is NOT safe: GNU reads -f as --file-system and *succeeds*, printing
  # prose ("File: ...") that then blows up the caller's arithmetic under `set -u`.
  if t="$(stat -c %W "$1" 2>/dev/null)"; then
    # %W is 0 or '-' on filesystems that don't record a birth time.
    case "$t" in ''|0|-) t="$(stat -c %Y "$1" 2>/dev/null || echo '')" ;; esac
  else
    t="$(stat -f %B "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo '')"
  fi
  case "$t" in ''|*[!0-9]*) t=0 ;; esac   # never hand a non-number to $(( ))
  printf '%s\n' "$t"
}

# Atomic publish: write to a temp file on the same filesystem, then rename.
# A reader polling with [ -f ] can then never observe a half-written message.
publish() { # publish <dest> <src>
  mv -f "$2" "$1"
}

body_from() { # body_from [--file PATH] ; falls back to stdin
  if [ "${1:-}" = "--file" ]; then
    [ -f "${2:-}" ] || die "no such file: ${2:-}"
    cat "$2"
  else
    cat
  fi
}

header() { # header <kind> <id>
  local cwd branch
  cwd="$(pwd)"
  branch="$(git branch --show-current 2>/dev/null || true)"
  printf '# %s %s\n\n' "$1" "$2"
  printf '<!-- from:%s cwd:%s branch:%s utc:%s -->\n\n' \
    "$ME" "$cwd" "${branch:-none}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

cmd_init() {
  local t="${1:-}" d
  [ -n "$t" ] || die "usage: pair.sh init <topic>"
  d="$(chan "$t")"
  mkdir -p "$d/.seen"
  # Messages carry working context and sometimes file paths into private repos.
  # Keep the channel readable only by its owner.
  chmod 700 "$d" "$d/.seen"
  cat > "$d/README.txt" <<EOF
Channel '$t' — two agent sessions talking through files.
  request-<ID>.md   a question, awaiting an answer
  response-<ID>.md  the answer to that ID
  note-<slug>.md    unsolicited message, no answer expected
  task-<slug>.md    a task spec either side can execute from
Either side may ask or answer; the roles are symmetric.
EOF
  printf 'channel ready: %s\n\n' "$d"
  printf 'Give the OTHER session this line:\n'
  printf '  join the pair channel "%s" (skill: pair)\n' "$t"
}

cmd_ask() {
  local t="${1:-}"; shift || true
  need "$t"
  local d id tmp; d="$(chan "$t")"; id="$(newid)"; tmp="$d/.tmp.$$"
  { header "Consult" "$id"; body_from "$@"; } > "$tmp"
  publish "$d/request-$id.md" "$tmp"
  printf '%s\n' "$id"
}

cmd_answer() {
  local t="${1:-}" id="${2:-}"; shift 2 || true
  need "$t"; [ -n "$id" ] || die "usage: pair.sh answer <topic> <ID> [--file PATH]"
  local d tmp; d="$(chan "$t")"; tmp="$d/.tmp.$$"
  [ -f "$d/request-$id.md" ] || die "no open request $id in '$t'"
  { header "Response" "$id"; body_from "$@"; } > "$tmp"
  publish "$d/response-$id.md" "$tmp"
  printf 'answered %s\n' "$id"
}

cmd_note() {
  local t="${1:-}" slug="${2:-}"; shift 2 || true
  need "$t"; [ -n "$slug" ] || die "usage: pair.sh note <topic> <slug> [--file PATH]"
  local d tmp; d="$(chan "$t")"; tmp="$d/.tmp.$$"
  { header "Note" "$slug"; body_from "$@"; } > "$tmp"
  publish "$d/note-$slug.md" "$tmp"
  printf 'note-%s.md\n' "$slug"
}

# Blocks until the answer lands. Because responses are published by rename,
# seeing the file means the whole message is there.
cmd_wait() {
  local t="${1:-}" id="${2:-}" secs="${3:-600}"
  need "$t"; [ -n "$id" ] || die "usage: pair.sh wait <topic> <ID> [seconds]"
  local d f i=0; d="$(chan "$t")"; f="$d/response-$id.md"
  while [ "$i" -lt "$secs" ]; do
    [ -f "$f" ] && { cat "$f"; return 0; }
    sleep 5; i=$((i + 5))
  done
  printf 'TIMEOUT after %ss — no response-%s.md.\n' "$secs" "$id" >&2
  printf 'Take the safest reversible option and record the unanswered consult.\n' >&2
  return 2
}

cmd_status() {
  local t="${1:-}" d; need "$t"; d="$(chan "$t")"
  local open=0 done=0
  printf '%-40s %-9s %s\n' ID STATE LATENCY
  for f in $(find "$d" -maxdepth 1 -name 'request-*.md' 2>/dev/null | sort); do
    local id r; id="$(basename "$f")"; id="${id#request-}"; id="${id%.md}"
    r="$d/response-$id.md"
    if [ -f "$r" ]; then
      printf '%-40s %-9s %ss\n' "$id" answered "$(( $(btime "$r") - $(btime "$f") ))"
      done=$((done + 1))
    else
      printf '%-40s %-9s %ss waiting\n' "$id" OPEN "$(( $(date +%s) - $(btime "$f") ))"
      open=$((open + 1))
    fi
  done
  printf '\n%s answered, %s open — %s\n' "$done" "$open" "$d"
}

# Emit one line per new message. Feed this to the Monitor tool so each line
# becomes a chat notification. Seen-markers live on disk, so re-arming the
# watcher after a restart does not re-announce every message.
cmd_watch() {
  local t="${1:-}" d; need "$t"; d="$(chan "$t")"
  mkdir -p "$d/.seen"
  while true; do
    for f in $(find "$d" -maxdepth 1 \( -name 'request-*.md' -o -name 'response-*.md' -o -name 'note-*.md' \) 2>/dev/null | sort); do
      local b="$(basename "$f")"
      if [ ! -e "$d/.seen/$b" ]; then
        : > "$d/.seen/$b"
        printf 'PAIR[%s] %s :: %s\n' "$t" "$b" \
          "$( (grep -v -e '^<!--' -e '^#' -e '^$' "$f" || true) | head -c 200 | tr '\n' ' ')"
      fi
    done
    sleep 5
  done
}

# Answered pairs are transcript, not state. Keep them while the work is live,
# then prune — an unbounded channel makes `status` useless for spotting the one
# request someone is still blocked on. Open requests are never pruned.
cmd_prune() {
  local t="${1:-}" days="${2:-7}" d n=0; need "$t"; d="$(chan "$t")"
  for r in $(find "$d" -maxdepth 1 -name 'response-*.md' -mtime +"$days" 2>/dev/null); do
    local id; id="$(basename "$r")"; id="${id#response-}"; id="${id%.md}"
    rm -f "$r" "$d/request-$id.md" "$d/.seen/request-$id.md" "$d/.seen/response-$id.md"
    n=$((n + 1))
  done
  printf 'pruned %s answered exchange(s) older than %s days from %s\n' "$n" "$days" "$t"
}

cmd_close() {
  local t="${1:-}" force="${2:-}" d; need "$t"; d="$(chan "$t")"
  [ "$force" = "--force" ] && { rm -rf "$d"; printf 'closed %s (forced)\n' "$t"; return 0; }
  local open; open=$(comm -23 \
    <(find "$d" -maxdepth 1 -name 'request-*.md' | sed 's/.*request-//;s/\.md//' | sort) \
    <(find "$d" -maxdepth 1 -name 'response-*.md' | sed 's/.*response-//;s/\.md//' | sort) | wc -l | tr -d ' ')
  [ "$open" = "0" ] || die "$open unanswered request(s) in '$t' — answer them or pass --force"
  rm -rf "$d"; printf 'closed %s\n' "$t"
}

cmd_list() {
  [ -d "$ROOT" ] || { printf 'no channels yet (%s)\n' "$ROOT"; return 0; }
  for d in "$ROOT"/*/; do
    [ -d "$d" ] || continue
    local t="$(basename "$d")" q a
    q=$(find "$d" -maxdepth 1 -name 'request-*.md' | wc -l | tr -d ' ')
    a=$(find "$d" -maxdepth 1 -name 'response-*.md' | wc -l | tr -d ' ')
    printf '%-28s %s asked, %s answered\n' "$t" "$q" "$a"
  done
}

case "${1:-}" in
  init)   shift; cmd_init "$@" ;;
  ask)    shift; cmd_ask "$@" ;;
  answer) shift; cmd_answer "$@" ;;
  note)   shift; cmd_note "$@" ;;
  wait)   shift; cmd_wait "$@" ;;
  status) shift; cmd_status "$@" ;;
  watch)  shift; cmd_watch "$@" ;;
  prune)  shift; cmd_prune "$@" ;;
  close)  shift; cmd_close "$@" ;;
  list)   shift; cmd_list "$@" ;;
  *) cat >&2 <<'EOF'
pair.sh — file channel between two agent sessions

  init <topic>                      create the channel
  list                              all channels
  ask <topic> [--file F]            write a question, print its ID (body: file or stdin)
  wait <topic> <ID> [secs]          block until the answer lands, print it
  answer <topic> <ID> [--file F]    answer an open question
  note <topic> <slug> [--file F]    unsolicited message, no answer expected
  status <topic>                    open vs answered, with latencies
  watch <topic>                     one line per new message (feed to Monitor)
  prune <topic> [days]              delete answered exchanges older than N days (default 7)
  close <topic> [--force]           delete the channel; refuses while requests are open

Env: PAIR_HOME (default ~/.claude/consult), PAIR_NAME (this session's label)
EOF
    exit 1 ;;
esac
