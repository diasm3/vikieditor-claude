# VikiEditor channel for Claude Code

Your running Claude Code session hears about VikiEditor as it happens:

- **Feedback**: someone commented on a document an agent wrote (or asked again). The session can take it, fix the document and reply, without being asked in the terminal.
- **Handoffs**: someone wrote the next task for a session.
- **Tool approvals from your phone** (permission relay): when the session needs your OK for a tool call, VikiEditor notifies you and you allow or deny it in the app.

The channel only delivers events. The work itself goes through the VikiEditor MCP server (`feedback`, `handoff`, `update_document` …), so connect that too.

## Setup

1. In VikiEditor: **Settings → Connections → Create New Key**. Copy the key (`vk_…`).
2. Connect the VikiEditor MCP server to Claude Code, if you have not yet:

   ```bash
   claude mcp add --transport http vikieditor https://vikieditor.piai.company/api/mcp --header "Authorization: Bearer vk_YOUR_KEY"
   ```

3. Install the channel plugin (inside Claude Code):

   ```
   /plugin marketplace add diasm3/vikieditor-claude
   /plugin install vikieditor-channel@vikieditor
   ```

   Enter the API key when asked.
4. Start Claude Code with the channel on:

   ```bash
   claude --dangerously-load-development-channels plugin:vikieditor-channel@vikieditor
   ```

   Channels are a research preview. Plugins outside Anthropic's allowlist need this flag. On Team and Enterprise plans an admin must turn on channels (`channelsEnabled`) and can add this plugin to `allowedChannelPlugins`, after which `--channels plugin:vikieditor-channel@vikieditor` is enough.

The session appears in VikiEditor under **Settings → Connections** while it is listening. Its name is the folder Claude Code runs in; set `VIKIEDITOR_SESSION` to choose another.

## Settings

| Variable | Default | |
|---|---|---|
| `VIKIEDITOR_API_KEY` | (from the plugin setting) | Your key |
| `VIKIEDITOR_URL` | `https://api.piai.company` | VikiEditor's API host, if self-hosted |
| `VIKIEDITOR_SESSION` | the working folder's name | Session name shown in VikiEditor |

Requires Node.js 18 or later. No other dependencies.
