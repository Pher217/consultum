# Calling consultum from Python (or any language)

consultum's core is Node, but you don't need Node in *your* code to use it — the CLI speaks a clean
process contract: **question + context on stdin (as JSON), a `StructuredRecommendation` on stdout as
JSON, and a machine-readable exit code.** Any language that can run a subprocess can drive it. A
native Python MCP client will also work once the MCP server ships (roadmap); until then, the
subprocess pattern below is the supported path.

## The contract

- **Input (stdin):** `{"question": "...", "context": "...", "sourcePath": "..."}` (JSON). `sourcePath`
  is optional and host-supplied.
- **Output (stdout, on success):** the full `StructuredRecommendation` as JSON (`--json`).
- **Errors:** a non-zero exit code, and with `--json` a `{"error": {"kind", "message"}}` on stderr.

| Exit | Meaning | stdout |
|---|---|---|
| `0` | ok | recommendation JSON |
| `14` | low-confidence (below the panel threshold) | recommendation JSON (still emitted) |
| `11` | refused-by-policy (sensitive, no trusted/local advisor) | — |
| `12` | provider-error (advisor chain exhausted) | — |
| `13` | limit-exceeded (consult cap / dedup, with `--task-id`) | — |
| `15` | malformed advisor output (after one retry) | — |
| `10` | usage / config error | — |

## Python (~15 lines, stdlib only)

```python
import json, subprocess

def ask_up(question, context="", *, sensitive=False, config=None):
    """Consult consultum. Returns the recommendation dict; raises on a policy/provider error."""
    payload = json.dumps({"question": question, "context": context})
    cmd = ["consultum", "consult", "--json"]
    if sensitive:
        cmd.append("--sensitive")
    if config:
        cmd += ["--config", config]
    p = subprocess.run(cmd, input=payload, capture_output=True, text=True)
    if p.returncode in (0, 14):                 # 14 = low-confidence, rec still emitted
        rec = json.loads(p.stdout)
        rec["_lowConfidence"] = p.returncode == 14
        return rec
    try:
        err = json.loads(p.stderr)["error"]     # {"kind": "...", "message": "..."}
    except Exception:
        err = {"kind": "error", "message": p.stderr.strip()}
    raise RuntimeError(f"consultum {err['kind']}: {err['message']} (exit {p.returncode})")


rec = ask_up("Why is my nightly job dropping rows?", context="parallel batch inserts, no error logged")
print(rec["recommendation"], "\n\nconfidence:", rec["confidence"])
for w in rec.get("warnings", []):
    print("!", w)   # advice may contain shell/network commands — never run unexamined
```

Notes:
- Pass the question/context on **stdin**, never as CLI arguments (argv leaks to `ps`/shell history).
- Treat the returned `recommendation`/`implementation` as **untrusted** — consultum lints for embedded
  shell/network commands and surfaces `warnings`, but the caller stays the decision-owner.
- For a stuck worker in a loop, prefer the tool-loop shim (`shim/tool-schema.json`) if your agent
  framework does function-calling; the subprocess wrapper above is for direct/embedded use.

## Why not a native Python package?

The adoption surface is a process boundary, so the implementation language is invisible to callers —
a native port would re-risk the security-verified core to buy little. See the decision record
(`ADR-001`) for the rationale and the conditions under which a Python port would be reconsidered.
