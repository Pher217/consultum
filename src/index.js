// Public library surface.
//
//   import { consult } from 'askup';
//   const rec = await consult({ question, context, sensitive: false });
//
// `askupTool` is the drop-in for a tool loop (Ollama function-calling / OpenAI tools): it takes
// { question, packet } and returns a JSON-safe result, mirroring the internal consult_advisor tool.

export { consult } from './consult.js';
export { askupTool, TOOL_SCHEMA } from './shim.js';
// parseConfig lets a consumer build a config from a YAML string (or a generated one) without
// touching disk — previously that meant reaching into askup/src/config.js past the export map.
export { loadConfig, parseConfig } from './config.js';
export { AskupError, KIND, EXIT, exitCodeForKind } from './errors.js';
export { redactSecrets } from './redact.js';
