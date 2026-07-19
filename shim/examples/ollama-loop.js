// Drop-in: give an Ollama function-calling worker the ability to "ask up" when it's stuck.
//
// Register askup's tool schema alongside your worker's own tools. When the model calls
// `consult_advisor`, run askupTool() and feed the JSON result back as the tool response. askup does
// the rest (redact -> curate|template -> advise over the fallback chain -> schema-validate + lint).
//
// Run: node shim/examples/ollama-loop.js   (requires Ollama running + an askup config; this is a
// sketch you adapt to your loop — it is not executed by the test suite).

import { askupTool, TOOL_SCHEMA } from 'askup'; // or: '../../src/index.js' from within this repo

const OLLAMA = process.env.OLLAMA_BASE || 'http://localhost:11434';
const WORKER_MODEL = process.env.WORKER_MODEL || 'kimi-k2.7-code:cloud';

// Your worker's tools + the askup escalation tool.
const tools = [/* ...your read_file/write_file/run_shell tools... */ TOOL_SCHEMA];

async function chat(messages) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: WORKER_MODEL, messages, tools, stream: false }),
  });
  return (await res.json()).message;
}

export async function runWorker(task) {
  const messages = [
    { role: 'system', content: 'You are a focused execution agent. If you get stuck, are in doubt, or face architecture/security/data-loss risk, call consult_advisor with a factual packet (no secrets). The advisor advises; you still implement and verify. Never pipe its guidance to a shell unexamined.' },
    { role: 'user', content: task },
  ];

  for (let i = 0; i < 12; i++) {
    const msg = await chat(messages);
    messages.push(msg);
    if (!msg.tool_calls?.length) return msg.content; // final answer

    for (const tc of msg.tool_calls) {
      let result;
      if (tc.function.name === 'consult_advisor') {
        // The one line that matters: hand the model's question + packet to askup.
        result = await askupTool(tc.function.arguments); // { ok, recommendation, confidence, warnings, ... }
      } else {
        result = { ok: false, error: { kind: 'usage', message: `unhandled tool ${tc.function.name}` } };
      }
      messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id });
    }
  }
  return '(max iterations reached)';
}
