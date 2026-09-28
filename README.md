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

   Then enter the API key: `/plugin configure vikieditor-channel@vikieditor`.
4. Start Claude Code with the channel on:

   ```bash
   claude --dangerously-load-development-channels plugin:vikieditor-channel@vikieditor
   ```

   Channels are a research preview. Plugins outside Anthropic's allowlist need this flag. On Team and Enterprise plans an admin must turn on channels (`channelsEnabled`) and can add this plugin to `allowedChannelPlugins`, after which `--channels plugin:vikieditor-channel@vikieditor` is enough.

The session appears in VikiEditor under **Settings → Connections** while it is listening. Its name is the folder Claude Code runs in; set `VIKIEDITOR_SESSION` to choose another. A second window with the same name gets `-2`, `-3` ….

## Several sessions: who gets which feedback

With several Claude Code windows listening (tmux, different repositories), each comment goes to the session that knows the document:

1. the session that has taken the thread;
2. else the session that last wrote the document (the agent names its VikiEditor MCP session after the channel's session, as the channel asks it to);
3. else the sessions whose **scope** covers the document (its folders, or its tags);
4. else the sessions without a scope.

Nobody fits: the comment waits until a session takes it. Events without a document (a handoff with none) go to every session.

Put the scope in the repository, so every window on it gets the same, as `.vikieditor.json` at its root (the plugin looks in the working folder and above):

```json
{ "session": "vikieditor", "folders": ["VikiEditor"], "tags": ["vikieditor"] }
```

- `folders`: document ids (or their first 8 characters) or title paths such as `VikiEditor/Design`. Everything under them is covered.
- `tags`: a document with one of these tags is covered.
- `session`: the session name, instead of the folder name.

For one window only: `VIKIEDITOR_SCOPE="folder:VikiEditor,tag:vikieditor"`. The `channel_status` tool shows the session's name and scope, including folders that were not found.

## Settings

| Variable | Default | |
|---|---|---|
| `VIKIEDITOR_API_KEY` | (from the plugin setting) | Your key |
| `VIKIEDITOR_URL` | `https://api.piai.company` | VikiEditor's API host, if self-hosted |
| `VIKIEDITOR_SESSION` | `.vikieditor.json` `session`, else the working folder's name | Session name shown in VikiEditor |
| `VIKIEDITOR_SCOPE` | `.vikieditor.json` `folders`/`tags` | `folder:A,tag:b` or JSON; what this session looks after |

Requires Node.js 18 or later. No other dependencies.
