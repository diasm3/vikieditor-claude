// VikiEditor for OpenCode — the plugin's core, kept apart from index.mjs so tests can drive it with
// a fake OpenCode client and a fake event stream. index.mjs is the only module OpenCode loads.
//
// It listens to your VikiEditor account (server-sent events, authenticated with your API key) and
// pushes what people ask for into the running OpenCode session:
//   - feedback: someone commented on a document (or asked again)
//   - handoff: someone wrote a handoff for the next session
// Events queue up while a turn is running and go in as ONE prompt when the session is idle, telling
// the agent which ids wait and which VikiEditor MCP tools to use (feedback take/reply, handoff
// take/done). With the permission relay, OpenCode's tool-approval prompts can be answered from the
// VikiEditor app on your phone; unanswered ones fall back to the terminal.
//
// Mirrors integrations/claude-code-channel/server.mjs: same env names, same API host, same
// .vikieditor.json scope rules, same /api/agent-events endpoints.

import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

export const VERSION = "0.1.0"
export const CLIENT_NAME = "opencode"
export const LOG_PREFIX = "[vikieditor-opencode]"
// The API host, not the web app: the event stream is long-lived and the app's /api rewrite is not
export const DEFAULT_URL = "https://api.piai.company"
export const HEARTBEAT_MS = 60_000
// VikiEditor forgets an unanswered permission request after 10 minutes (PERMISSION_TTL_MS on the
// server); after that the terminal prompt is the only way to answer, so we forget it too.
export const PERMISSION_TTL_MS = 10 * 60_000
const MAX_RECONNECT_DELAY_MS = 60_000
// The same event (same id, same text) arriving twice within this window is one event
const DUPLICATE_WINDOW_MS = 60_000
const DELIVERED_MEMORY = 200
// VikiEditor accepts Claude Code's five-letter request ids: /^[a-km-z]{5}$/ (no "l")
const REQUEST_ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz"

const defaultFs = { existsSync, readFileSync }
const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval }
const defaultLog = (...args) => process.stderr.write(`${LOG_PREFIX} ${args.join(" ")}\n`)

export const quote = (text, max = 400) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text ?? "")
export const short = (id) => String(id).slice(0, 8)

/**
 * What this session looks after: .vikieditor.json in the working folder or above (checked into the
 * repository, so every window on it gets the same).
 *   { "session": "vikieditor", "folders": ["VikiEditor"], "tags": ["vikieditor"] }
 */
export function findConfig(dir, fs = defaultFs, log = defaultLog) {
  for (let at = dir; ; at = dirname(at)) {
    const file = join(at, ".vikieditor.json")
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"))
      } catch {
        log(`could not read ${file}`)
        return {}
      }
    }
    if (dirname(at) === at) return {}
  }
}

/**
 * Settings, in the channel plugin's order: environment, then plugin options from opencode.json
 * (["file:///…/index.mjs", { "session": "…" }]), then .vikieditor.json, then defaults.
 */
export function resolveSettings({ directory = process.cwd(), env = process.env, options = {}, fs = defaultFs, log = defaultLog } = {}) {
  const config = findConfig(directory, fs, log)
  const apiKey = String(env.VIKIEDITOR_API_KEY || options.apiKey || "").trim()
  const baseUrl = String(env.VIKIEDITOR_URL || options.url || DEFAULT_URL).replace(/\/+$/, "")
  const scope = env.VIKIEDITOR_SCOPE
    ? env.VIKIEDITOR_SCOPE
    : Array.isArray(config.folders) || Array.isArray(config.tags)
      ? JSON.stringify({ folders: config.folders ?? [], tags: config.tags ?? [] })
      : ""
  // The session's name in VikiEditor: VIKIEDITOR_SESSION, the option, the config's "session", or the
  // folder OpenCode runs in. The server adds "-2" … when another window already has it.
  const session = String(
    env.VIKIEDITOR_SESSION ||
      options.session ||
      (typeof config.session === "string" && config.session) ||
      basename(directory) ||
      CLIENT_NAME,
  ).slice(0, 100)
  return { apiKey, baseUrl, scope, session }
}

export function describeScope(scopeView) {
  if (!scopeView) return "No scope: this session gets feedback that no other session looks after."
  const parts = [...(scopeView.folders ?? []).map((f) => `folder "${f.title}"`), ...(scopeView.tags ?? []).map((t) => `tag "${t}"`)]
  const missing = scopeView.unresolved?.length ? ` Not found: ${scopeView.unresolved.join(", ")}.` : ""
  return `Looks after ${parts.join(", ") || "nothing found"}.${missing}`
}

const whoDidWhat = (event) => `${event.author || "Someone"} ${event.again ? "asked again on" : "left feedback on"}`

/** One line for a toast. */
export function headline(kind, event) {
  if (kind === "feedback") return `${whoDidWhat(event)} "${event.documentTitle}"`
  return `Handoff: ${event.title}`
}

const indent = (text) =>
  String(text ?? "")
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n")

/**
 * The one prompt that goes into the idle session: which feedback/handoffs wait, and the VikiEditor
 * MCP tool calls that handle them (feedback action=take / reply, handoff action=take / done).
 */
export function buildPrompt(items, session) {
  const n = items.length
  const lines = [
    `VikiEditor: ${n === 1 ? "one item is" : `${n} items are`} waiting for this session ("${session}"). Handle ${n === 1 ? "it" : "them"} with the VikiEditor MCP tools.`,
    "",
  ]
  items.forEach(({ kind, event }, i) => {
    if (kind === "feedback") {
      const where = `"${event.documentTitle}"${event.heading ? ` › ${event.heading}` : ""}`
      lines.push(`${i + 1}. ${whoDidWhat(event)} ${where}:`, indent(quote(event.body, 2000)))
      if (event.quote) lines.push(indent(`On: "${quote(event.quote)}"`))
      lines.push(indent(`→ feedback action=take commentId=${short(event.threadId)}, fix the document, then feedback action=reply with what you changed.`))
    } else {
      lines.push(`${i + 1}. Handoff: ${event.title}`, indent(quote(event.body, 3000)))
      lines.push(indent(`→ handoff action=take id=${short(event.handoffId)}, do the work, then handoff action=done.`))
    }
    lines.push("")
  })
  lines.push(
    "Take each item first (feedback action=take / handoff action=take) so other sessions skip it; finish with feedback action=reply or handoff action=done.",
    `If you have not called the VikiEditor session tool in this session yet, call it first with label "${session}", so feedback on documents you write comes back here.`,
    "If you were in the middle of unrelated work, finish the current step first.",
  )
  return lines.join("\n")
}

export function newRequestId(taken = new Set(), random = Math.random) {
  for (;;) {
    let id = ""
    for (let i = 0; i < 5; i++) id += REQUEST_ID_ALPHABET[Math.floor(random() * REQUEST_ID_ALPHABET.length)]
    if (!taken.has(id)) return id
  }
}

/** Splits a text/event-stream body into (event name, parsed JSON) pairs. Heartbeat comments are skipped. */
export async function* readEvents(body) {
  const decoder = new TextDecoder()
  let pending = ""
  for await (const chunk of body) {
    pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    let boundary
    while ((boundary = pending.indexOf("\n\n")) >= 0) {
      const block = pending.slice(0, boundary)
      pending = pending.slice(boundary + 2)
      let name = "message"
      const data = []
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim()
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
      }
      if (!data.length) continue
      let parsed
      try {
        parsed = JSON.parse(data.join("\n"))
      } catch {
        yield { name, data: undefined, malformed: true }
        continue
      }
      yield { name, data: parsed }
    }
  }
}

/** The SDK's { data, error } result → data, or a thrown error. */
export function unwrap(result) {
  if (result && typeof result === "object" && "error" in result && result.error) {
    const detail = result.error?.data?.message ?? result.error?.message ?? JSON.stringify(result.error)
    throw new Error(`OpenCode: ${detail}`)
  }
  return result && typeof result === "object" && "data" in result ? result.data : result
}

/**
 * Builds the plugin: `hooks` is what OpenCode gets, `start()` opens the VikiEditor stream, `stop()`
 * closes everything. Everything the plugin touches (fetch, timers, fs, clock, logger) is injectable.
 */
export function createVikiEditor({
  client,
  directory = process.cwd(),
  options = {},
  env = process.env,
  fetch: fetchFn = globalThis.fetch,
  fs = defaultFs,
  timers = defaultTimers,
  now = Date.now,
  random = Math.random,
  log = defaultLog,
} = {}) {
  const settings = resolveSettings({ directory, env, options, fs, log })
  const state = {
    session: settings.session,
    streamId: null,
    connected: false,
    scopeView: null,
    told: false,
    stopped: false,
    /** The top-level session that events go to: the one the person used last */
    active: null,
    /** sessionID → { idle: true | false | undefined (never heard), parentID } */
    sessions: new Map(),
    /** "feedback:<threadId>" | "handoff:<handoffId>" → { key, kind, event, body } */
    queue: new Map(),
    /** what went in, to drop the same event arriving twice */
    delivered: new Map(),
    /** VikiEditor request_id → { sessionID, permissionID, timer } */
    permissions: new Map(),
    injecting: false,
  }
  let abort = null
  let heartbeat = null
  let reconnect = null

  // ---------- OpenCode side ----------

  function toast(message, variant = "info") {
    const tui = client?.tui
    if (typeof tui?.showToast !== "function") return
    try {
      Promise.resolve(tui.showToast({ body: { title: "VikiEditor", message: quote(message, 200), variant } })).catch(() => {})
    } catch {
      // no TUI (opencode serve): nothing to show
    }
  }

  const isTopLevel = (id) => !state.sessions.get(id)?.parentID
  const setIdle = (id, idle) => {
    const info = state.sessions.get(id)
    if (info) info.idle = idle
    else state.sessions.set(id, { idle, parentID: null })
  }
  // Only a session we have heard go idle (session.idle / session.status / a fresh session.created)
  // is idle: a prompt never goes in on a guess
  const isIdle = (id) => state.sessions.get(id)?.idle === true

  // POST /session/:id/prompt_async: queues the message and returns at once (prompt() would only
  // answer when the turn ends)
  async function inject(id, text) {
    if (typeof client?.session?.promptAsync !== "function") throw new Error("this OpenCode SDK has no session.promptAsync")
    unwrap(await client.session.promptAsync({ path: { id }, body: { parts: [{ type: "text", text }] } }))
  }

  /** Hands the queue to the active session, as one prompt, when it is idle. */
  async function flush() {
    if (state.stopped || state.injecting || state.queue.size === 0) return
    const id = state.active
    if (!id) return
    if (!isIdle(id)) return
    state.injecting = true
    // Busy from here: the turn starts as soon as the prompt lands, and a late session.idle for the
    // previous turn must not read as "idle again"
    setIdle(id, false)
    try {
      const items = [...state.queue.values()]
      try {
        await inject(id, buildPrompt(items, state.session))
      } catch (error) {
        setIdle(id, true) // nothing started; try again on the next idle
        throw error
      }
      const at = now()
      for (const item of items) {
        if (state.queue.get(item.key) === item) state.queue.delete(item.key)
        state.delivered.set(item.key, { at, body: item.body })
      }
      while (state.delivered.size > DELIVERED_MEMORY) state.delivered.delete(state.delivered.keys().next().value)
    } catch (error) {
      log(`could not hand ${state.queue.size} item(s) to session ${short(id)}: ${error?.message ?? error}`)
    } finally {
      state.injecting = false
    }
  }

  function onOpenCodeEvent(event) {
    const type = event?.type
    const p = event?.properties ?? {}
    switch (type) {
      case "session.created": {
        const info = p.info
        if (!info?.id) return
        state.sessions.set(info.id, { idle: true, parentID: info.parentID ?? null })
        if (!info.parentID) {
          state.active = info.id
          return flush()
        }
        return
      }
      case "session.deleted": {
        const id = p.info?.id ?? p.sessionID
        if (!id) return
        state.sessions.delete(id)
        if (state.active === id) state.active = null
        return
      }
      case "message.updated": {
        const info = p.info
        if (!info?.sessionID || info.role !== "user" || !isTopLevel(info.sessionID)) return
        // The person just sent something: this is the session, and a turn is about to start
        state.active = info.sessionID
        setIdle(info.sessionID, false)
        return
      }
      case "session.status": {
        const id = p.sessionID
        if (!id) return
        const idle = p.status?.type === "idle"
        setIdle(id, idle)
        if (!isTopLevel(id)) return
        if (!idle) state.active = id
        else if (state.active === id || !state.active) {
          state.active = id
          return flush()
        }
        return
      }
      case "session.idle": {
        const id = p.sessionID
        if (!id) return
        setIdle(id, true)
        if (!isTopLevel(id)) return
        if (!state.active) state.active = id
        if (state.active === id) return flush()
        return
      }
      case "permission.asked":
      case "permission.updated":
        return relayPermission(p)
      case "permission.replied":
        // Answered in the terminal (or by us): the phone's answer, if it still comes, is dropped
        return forgetPermission(p.permissionID ?? p.requestID)
      default:
        return
    }
  }

  // ---------- VikiEditor events ----------

  function enqueue(kind, event) {
    const id = kind === "feedback" ? event?.threadId : event?.handoffId
    if (!id) return
    // The server may name the one session that acts (targetSession); the others only watch.
    // Absent or null: this session acts, as before.
    if (typeof event.targetSession === "string" && event.targetSession && event.targetSession.toLowerCase() !== state.session.toLowerCase()) {
      log(`${kind} ${short(id)} is for session "${event.targetSession}"; watching only`)
      toast(`${headline(kind, event)} → "${event.targetSession}"`)
      return
    }
    const key = `${kind}:${id}`
    const body = String(event.body ?? "")
    const recent = state.delivered.get(key)
    if (recent && recent.body === body && now() - recent.at < DUPLICATE_WINDOW_MS) return
    state.queue.set(key, { key, kind, event, body })
    toast(headline(kind, event))
    return flush()
  }

  async function relayPermission(p) {
    if (!settings.apiKey || !state.streamId || state.stopped) return
    const permissionID = p?.id
    const sessionID = p?.sessionID
    if (!permissionID || !sessionID) return
    for (const pending of state.permissions.values()) if (pending.permissionID === permissionID) return
    const requestId = newRequestId(new Set(state.permissions.keys()), random)
    const patterns = Array.isArray(p.patterns) ? p.patterns : Array.isArray(p.pattern) ? p.pattern : p.pattern ? [p.pattern] : []
    const toolName = String(p.type ?? p.permission ?? "Tool").slice(0, 100)
    const description = String(p.title ?? p.metadata?.title ?? patterns[0] ?? "").slice(0, 1000)
    let metadata = ""
    try {
      metadata = p.metadata && Object.keys(p.metadata).length ? JSON.stringify(p.metadata) : ""
    } catch {
      metadata = ""
    }
    const preview = [patterns.join("\n"), metadata].filter(Boolean).join("\n").slice(0, 3500)
    const entry = { sessionID, permissionID, timer: null }
    entry.timer = timers.setTimeout(() => state.permissions.delete(requestId), PERMISSION_TTL_MS)
    entry.timer?.unref?.()
    state.permissions.set(requestId, entry)
    try {
      const response = await fetchFn(`${settings.baseUrl}/api/agent-events/permissions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ stream: state.streamId, request_id: requestId, tool_name: toolName, description, input_preview: preview }),
      })
      if (!response.ok) {
        log(`permission relay refused (${response.status})`)
        forgetPermission(permissionID)
      }
    } catch (error) {
      log(`permission relay failed: ${error?.message ?? error}`)
      forgetPermission(permissionID)
    }
  }

  function forgetPermission(permissionID) {
    if (!permissionID) return
    for (const [requestId, pending] of state.permissions) {
      if (pending.permissionID !== permissionID) continue
      timers.clearTimeout(pending.timer)
      state.permissions.delete(requestId)
    }
  }

  // POST /session/:id/permissions/:permissionID { response: once | always | reject } (SDK v1, the
  // client plugins get); the v2 client names it permission.reply({ requestID, reply })
  async function respondPermission(sessionID, permissionID, response) {
    if (typeof client?.postSessionIdPermissionsPermissionId === "function")
      return unwrap(await client.postSessionIdPermissionsPermissionId({ path: { id: sessionID, permissionID }, body: { response } }))
    if (typeof client?.permission?.reply === "function") return unwrap(await client.permission.reply({ requestID: permissionID, reply: response }))
    throw new Error("this OpenCode SDK has no permission respond method")
  }

  /** The person answered on their phone. */
  async function applyPermission(data) {
    const pending = state.permissions.get(data?.request_id)
    if (!pending) return // answered in the terminal already, or expired
    if (data.behavior !== "allow" && data.behavior !== "deny") return
    forgetPermission(pending.permissionID)
    const response = data.behavior === "allow" ? "once" : "reject"
    try {
      await respondPermission(pending.sessionID, pending.permissionID, response)
      toast(data.behavior === "allow" ? "Allowed from your phone" : "Denied from your phone", data.behavior === "allow" ? "success" : "warning")
    } catch (error) {
      log(`could not apply the phone's answer: ${error?.message ?? error}`)
    }
  }

  function onVikiEvent(name, data) {
    if (name === "ready") {
      state.streamId = data.stream
      state.connected = true
      const renamed = typeof data.session === "string" && data.session !== state.session
      if (typeof data.session === "string") state.session = data.session
      state.scopeView = data.scope ?? null
      log(`connected to ${settings.baseUrl} as session "${state.session}". ${describeScope(state.scopeView)}`)
      if (!state.told || renamed) {
        state.told = true
        toast(`Connected as session "${state.session}"`)
      }
      return flush()
    }
    if (name === "permission") return applyPermission(data)
    if (name === "feedback" || name === "handoff") return enqueue(name, data)
  }

  async function listen() {
    if (!settings.apiKey) {
      log("VIKIEDITOR_API_KEY is not set; not connecting")
      return
    }
    let delay = 1000
    while (!state.stopped) {
      try {
        const scope = settings.scope ? `&scope=${encodeURIComponent(settings.scope)}` : ""
        const url = `${settings.baseUrl}/api/agent-events?client=${CLIENT_NAME}&session=${encodeURIComponent(state.session)}${scope}`
        abort = new AbortController()
        const response = await fetchFn(url, {
          headers: { Authorization: `Bearer ${settings.apiKey}`, Accept: "text/event-stream" },
          signal: abort.signal,
        })
        if (response.status === 401) {
          log("the API key was refused; check it in VikiEditor → Settings → Connections")
          return
        }
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        delay = 1000
        // Tell the server we are alive; proxies may never report a dropped connection. A 404 means
        // the server forgot this stream (restart, timeout): reconnect.
        const controller = abort
        heartbeat = timers.setInterval(async () => {
          if (!state.streamId) return
          try {
            const alive = await fetchFn(`${settings.baseUrl}/api/agent-events/streams/${state.streamId}/alive`, {
              method: "POST",
              headers: { Authorization: `Bearer ${settings.apiKey}` },
            })
            if (alive.status === 404) controller.abort()
          } catch {
            // the stream itself will notice
          }
        }, HEARTBEAT_MS)
        heartbeat?.unref?.()
        try {
          for await (const { name, data, malformed } of readEvents(response.body)) {
            if (malformed) {
              log(`could not read a ${name} event`)
              continue
            }
            try {
              await onVikiEvent(name, data)
            } catch (error) {
              log(`${name} event failed: ${error?.message ?? error}`)
            }
          }
        } finally {
          timers.clearInterval(heartbeat)
          heartbeat = null
        }
      } catch (error) {
        if (!state.stopped) log(`stream ended: ${error?.message ?? error}`)
      }
      state.connected = false
      state.streamId = null
      if (state.stopped) return
      await new Promise((resolve) => {
        reconnect = timers.setTimeout(resolve, delay)
        reconnect?.unref?.()
      })
      delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS)
    }
  }

  let listening = false
  const plugin = {
    settings,
    state,
    flush,
    start() {
      if (!listening) {
        listening = true
        void listen()
      }
      return plugin
    },
    stop() {
      state.stopped = true
      abort?.abort()
      timers.clearInterval(heartbeat)
      timers.clearTimeout(reconnect)
      for (const pending of state.permissions.values()) timers.clearTimeout(pending.timer)
      state.permissions.clear()
    },
    hooks: {
      event: async ({ event }) => {
        try {
          await onOpenCodeEvent(event)
        } catch (error) {
          log(`${event?.type ?? "event"} failed: ${error?.message ?? error}`)
        }
      },
      dispose: () => plugin.stop(),
    },
  }
  return plugin
}
