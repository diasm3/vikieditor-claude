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

The session appears in VikiEditor under **Settings → Connections** while it is listening. Its name is the folder Claude Code runs in; set `VIKIEDITOR_SESSION` to choose another. A second window with the same name gets `-2`, `-3` …; see [Session names](#session-names).

## Several sessions: who gets which feedback

With several Claude Code windows listening (tmux, different repositories), each comment goes to the session that knows the document:

1. the session that has taken the thread;
2. else the session that last wrote the document (the agent names its VikiEditor MCP session after the channel's session, as the channel asks it to);
3. else **one** of the sessions whose **scope** covers the document (its folders, or its tags) — the most recently active;
4. else **one** of the sessions without a scope — the most recently active.

One session at a time, so two windows (or two computers) never both answer. If the chosen session has not taken the thread within 10 minutes, the next candidate in that order hears it. Nobody fits: the comment waits until a session takes it. Events without a document (a handoff with none) go to every session.

Each event names the session it was sent to (`targetSession`). Since 0.2.1 the plugin shows an event meant for another session as information only, without the "take it" instruction; the server also refuses `feedback action=take` on a thread another session has answered or is handling, so the agent skips it.

### Session names

The plugin always connects with its base name (the folder, the config's `session` or `VIKIEDITOR_SESSION`) and a stable per-process instance id; the name the server gives back is only shown. A window that reconnects (network hiccup, server restart) is recognised by its instance and keeps the name it had. A base name no live window holds is given as is, also when asked for with an old suffix (`haist-2-2` → `haist`; a trailing `-<number>` counts as a window suffix), and `-2`, `-3` … (the lowest free number) only go to a real second window with the same base name. A stream the server has not heard from for 2.5 minutes holds no name. Before 0.2.2 the plugin reconnected with the suffixed name it had been given, and names grew to `haist-2-2-2` ….

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
| `VIKIEDITOR_INSTANCE` | a random id per process | Tells the server a reconnect is the same window, so it keeps the session's name; set it only to pin one |

Requires Node.js 18 or later. No other dependencies.
