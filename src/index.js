// Public library surface.
//
//   import { consult } from 'consultum';
//   const rec = await consult({ question, context, sensitive: false });
//
// `consultumTool` is the drop-in for a tool loop (Ollama function-calling / OpenAI tools): it takes
// { question, packet } and returns a JSON-safe result, mirroring the internal consult_advisor tool.

export { consult } from './consult.js';
export { consultumTool, TOOL_SCHEMA } from './shim.js';
// parseConfig lets a consumer build a config from a YAML string (or a generated one) without
// touching disk — previously that meant reaching into consultum/src/config.js past the export map.
export { loadConfig, parseConfig } from './config.js';
export { ConsultumError, KIND, EXIT, exitCodeForKind } from './errors.js';
export { redactSecrets } from './redact.js';
