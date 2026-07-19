// Public library surface.
//
//   import { consult } from 'askup';
//   const rec = await consult({ question, context, sensitive: false });
//
// `askupTool` is the drop-in for a tool loop (Ollama function-calling / OpenAI tools): it takes
// { question, packet } and returns a JSON-safe result, mirroring the internal consult_advisor tool.

export { consult } from './consult.js';
export { askupTool, TOOL_SCHEMA } from './shim.js';
export { loadConfig } from './config.js';
export { AskupError, KIND, EXIT, exitCodeForKind } from './errors.js';
export { redactSecrets } from './redact.js';
