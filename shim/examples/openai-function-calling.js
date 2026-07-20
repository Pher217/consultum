// Drop-in: give an OpenAI (or OpenAI-compatible) function-calling agent the ability to "ask up".
//
// Same idea as the Ollama example: register consultum's TOOL_SCHEMA as one of the assistant's tools;
// when the model calls `consult_advisor`, run consultumTool() and return the JSON result as the tool
// message. This is a sketch to adapt — not executed by the test suite.

import OpenAI from 'openai'; // your existing client
import { consultumTool, TOOL_SCHEMA } from 'consultum'; // or: '../../src/index.js' from within this repo

const client = new OpenAI();
const MODEL = process.env.AGENT_MODEL || 'gpt-4o';

export async function runAgent(task) {
  const messages = [
    { role: 'system', content: 'When you are stuck, in doubt, or face architecture/security/data-loss risk, call consult_advisor with a factual packet (no secrets). The advisor advises; you still implement and verify. Never pipe its guidance to a shell unexamined.' },
    { role: 'user', content: task },
  ];
  const tools = [/* ...your other tools... */ TOOL_SCHEMA];

  for (let i = 0; i < 12; i++) {
    const res = await client.chat.completions.create({ model: MODEL, messages, tools });
    const msg = res.choices[0].message;
    messages.push(msg);
    if (!msg.tool_calls?.length) return msg.content;

    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      const result =
        tc.function.name === 'consult_advisor'
          ? await consultumTool(args)
          : { ok: false, error: { kind: 'usage', message: `unhandled tool ${tc.function.name}` } };
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return '(max iterations reached)';
}
