// VikiEditor for OpenCode: feedback and handoffs from your VikiEditor wiki go into the running
// OpenCode session when it is idle; tool approvals can be answered from your phone.
// The work itself goes through the VikiEditor MCP server (feedback, handoff, update_document …).
//
// opencode.json:  { "plugin": ["file:///absolute/path/to/integrations/opencode-plugin/index.mjs"] }
// Settings: VIKIEDITOR_API_KEY (required), VIKIEDITOR_URL, VIKIEDITOR_SESSION, VIKIEDITOR_SCOPE,
// and .vikieditor.json in the project (see README.md).
//
// OpenCode calls every function this module exports as a plugin (the same function under two names
// is loaded once), so this file exports nothing else. The logic lives in lib.mjs.

import { createVikiEditor } from "./lib.mjs"

/** @type {import("@opencode-ai/plugin").Plugin} */
export const VikiEditorPlugin = async ({ client, directory }, options) =>
  createVikiEditor({ client, directory, options: options ?? {} }).start().hooks

export default VikiEditorPlugin
