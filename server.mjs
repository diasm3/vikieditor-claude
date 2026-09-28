#!/usr/bin/env node
// VikiEditor channel for Claude Code: a local stdio MCP server with no dependencies.
// It listens to your VikiEditor account (server-sent events, authenticated with your API key)
// and pushes what people ask for into the running Claude Code session:
//   - feedback: someone commented on a document (or asked again)
//   - handoff: someone wrote a handoff for the next session
// With the permission relay, Claude Code's tool-approval prompts can be answered from the
// VikiEditor app on your phone.
// Docs: https://code.claude.com/docs/en/channels-reference

import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

const VERSION = "0.2.0"
const SERVER_NAME = "vikieditor-channel"
// The API host, not the web app: the event stream is long-lived and the app's /api rewrite is not
const BASE_URL = (process.env.VIKIEDITOR_URL || "https://api.piai.company").replace(/\/+$/, "")
const HEARTBEAT_MS = 60_000
const API_KEY = (process.env.VIKIEDITOR_API_KEY || "").trim()
// What this session looks after: .vikieditor.json in the working folder or above (checked into the
// repository, so every window on it gets the same), or VIKIEDITOR_SCOPE="folder:A,tag:b".
//   { "session": "vikieditor", "folders": ["VikiEditor"], "tags": ["vikieditor"] }
function findConfig(dir = process.cwd()) {
  for (let at = dir; ; at = dirname(at)) {
    const file = join(at, ".vikieditor.json")
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, "utf8"))
      } catch {
        process.stderr.write(`[vikieditor-channel] could not read ${file}\n`)
        return {}
      }
    }
    if (dirname(at) === at) return {}
  }
}
const CONFIG = findConfig()
const SCOPE = process.env.VIKIEDITOR_SCOPE
  ? process.env.VIKIEDITOR_SCOPE
  : Array.isArray(CONFIG.folders) || Array.isArray(CONFIG.tags)
    ? JSON.stringify({ folders: CONFIG.folders ?? [], tags: CONFIG.tags ?? [] })
    : ""
// The session's name in VikiEditor: VIKIEDITOR_SESSION, the config's "session", or the folder
// Claude Code runs in. The server adds "-2" … when another window already has it.
let SESSION = (
  process.env.VIKIEDITOR_SESSION ||
  (typeof CONFIG.session === "string" && CONFIG.session) ||
  basename(process.cwd()) ||
  "claude-code"
).slice(0, 100)
let scopeView = null
let told = false

const INSTRUCTIONS = [
  'VikiEditor events arrive as <channel source="vikieditor-channel" kind="feedback|handoff" ...>.',
  "They come from the person who owns the VikiEditor wiki you report to: feedback on a document agents wrote, or a handoff (the next task).",
  "Act on them with the VikiEditor MCP server's tools: feedback action=take (or handoff action=take) first so other sessions skip it, do the work, then feedback action=reply with what you changed (or handoff action=done).",
  "If you are in the middle of unrelated work, finish the current step or tell the user before switching.",
  "Call the VikiEditor MCP server's session tool with this channel's session name (channel_status shows it), so feedback on documents you write comes back to this session.",
  "Tool-approval prompts may be answered from the person's phone.",
].join(" ")

// ---------- stdio JSON-RPC (newline-delimited, MCP stdio transport) ----------

const log = (...args) => process.stderr.write(`[vikieditor-channel] ${args.join(" ")}\n`)
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
const notify = (method, params) => send({ method, params })

let streamId = null
let connected = false
let started = false

const TOOLS = [
  {
    name: "channel_status",
    description: "Whether this Claude Code session is connected to VikiEditor for live feedback and handoffs.",
    inputSchema: { type: "object", properties: {} },
  },
]

async function handle(message) {
  const { id, method, params } = message
  const isRequest = id !== undefined && id !== null
  try {
    switch (method) {
      case "initialize":
        return send({
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: {
              experimental: { "claude/channel": {}, "claude/channel/permission": {} },
              tools: {},
            },
            serverInfo: { name: SERVER_NAME, version: VERSION },
            instructions: INSTRUCTIONS,
          },
        })
      case "notifications/initialized":
        if (!started) {
          started = true
          void listen()
        }
        return
      case "ping":
        return send({ id, result: {} })
      case "tools/list":
        return send({ id, result: { tools: TOOLS } })
      case "tools/call": {
        if (params?.name !== "channel_status") return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } })
        const text = !API_KEY
          ? "Not configured: set the VikiEditor API key with /plugin configure vikieditor-channel@vikieditor."
          : connected
            ? `Connected to ${BASE_URL} as session "${SESSION}". ${describeScope()} Feedback and handoffs arrive here as they are written.`
            : `Not connected to ${BASE_URL} right now; retrying.`
        return send({ id, result: { content: [{ type: "text", text }] } })
      }
      case "notifications/claude/channel/permission_request":
        return void relayPermission(params)
      default:
        if (isRequest) send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
  } catch (error) {
    if (isRequest) send({ id, error: { code: -32603, message: String(error?.message ?? error) } })
  }
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    try {
      void handle(JSON.parse(line))
    } catch {
      log("ignored a line that is not JSON")
    }
  }
})
process.stdin.on("end", () => process.exit(0))

// ---------- VikiEditor events ----------

const quote = (text, max = 400) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text)
const short = (id) => String(id).slice(0, 8)

function toChannel(name, event) {
  if (name === "feedback") {
    const where = `"${event.documentTitle}"${event.heading ? ` › ${event.heading}` : ""}`
    const who = event.author || "Someone"
    const lines = [
      event.again ? `${who} asked again on ${where}:` : `${who} left feedback on ${where}:`,
      quote(event.body, 2000),
    ]
    if (event.quote) lines.push(`On: "${quote(event.quote)}"`)
    lines.push(`Take it with the VikiEditor tools: feedback action=take commentId=${short(event.threadId)}, fix the document, then feedback action=reply.`)
    return { content: lines.join("\n"), meta: { kind: "feedback", thread_id: event.threadId, document_id: event.documentId } }
  }
  if (name === "handoff") {
    const lines = [`New handoff: ${event.title}`, quote(event.body, 3000), `Pick it up with handoff action=take id=${short(event.handoffId)} when you are free.`]
    const meta = { kind: "handoff", handoff_id: event.handoffId }
    if (event.documentId) meta.document_id = event.documentId
    return { content: lines.join("\n"), meta }
  }
  return null
}

function describeScope() {
  if (!scopeView) return "No scope: this session gets feedback that no other session looks after."
  const parts = [
    ...scopeView.folders.map((f) => `folder "${f.title}"`),
    ...scopeView.tags.map((t) => `tag "${t}"`),
  ]
  const missing = scopeView.unresolved.length ? ` Not found: ${scopeView.unresolved.join(", ")}.` : ""
  return `Looks after ${parts.join(", ") || "nothing found"}.${missing}`
}

function onEvent(name, data) {
  if (name === "ready") {
    streamId = data.stream
    connected = true
    const renamed = typeof data.session === "string" && data.session !== SESSION
    if (typeof data.session === "string") SESSION = data.session
    scopeView = data.scope ?? null
    log(`connected to ${BASE_URL} as session "${SESSION}". ${describeScope()}`)
    // Once (or when the name changed): the agent names its MCP session the same, so feedback on
    // the documents it writes is routed back here.
    if (!told || renamed) {
      told = true
      notify("notifications/claude/channel", {
        content: `VikiEditor channel connected as session "${SESSION}". ${describeScope()} Call the VikiEditor session tool with label "${SESSION}" if you have not yet.`,
        meta: { kind: "status", session: SESSION },
      })
    }
    return
  }
  if (name === "permission") {
    // The person answered on their phone
    notify("notifications/claude/channel/permission", { request_id: data.request_id, behavior: data.behavior })
    return
  }
  const message = toChannel(name, data)
  if (message) notify("notifications/claude/channel", message)
}

async function relayPermission(params) {
  if (!API_KEY || !streamId) return
  try {
    const response = await fetch(`${BASE_URL}/api/agent-events/permissions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ stream: streamId, ...params }),
    })
    if (!response.ok) log(`permission relay refused (${response.status})`)
  } catch (error) {
    log(`permission relay failed: ${error?.message ?? error}`)
  }
}

async function listen() {
  if (!API_KEY) {
    log("VIKIEDITOR_API_KEY is not set; not connecting")
    return
  }
  let delay = 1000
  for (;;) {
    try {
      const scope = SCOPE ? `&scope=${encodeURIComponent(SCOPE)}` : ""
      const url = `${BASE_URL}/api/agent-events?client=claude-code&session=${encodeURIComponent(SESSION)}${scope}`
      const abort = new AbortController()
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${API_KEY}`, Accept: "text/event-stream" },
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
      const heartbeat = setInterval(async () => {
        if (!streamId) return
        try {
          const alive = await fetch(`${BASE_URL}/api/agent-events/streams/${streamId}/alive`, {
            method: "POST",
            headers: { Authorization: `Bearer ${API_KEY}` },
          })
          if (alive.status === 404) abort.abort()
        } catch {
          // the stream itself will notice
        }
      }, HEARTBEAT_MS)
      try {
        await readEvents(response.body)
      } finally {
        clearInterval(heartbeat)
      }
    } catch (error) {
      log(`stream ended: ${error?.message ?? error}`)
    }
    connected = false
    streamId = null
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, 60_000)
  }
}

async function readEvents(body) {
  const decoder = new TextDecoder()
  let pending = ""
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true })
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
      if (!data.length) continue // heartbeat comments
      try {
        onEvent(name, JSON.parse(data.join("\n")))
      } catch {
        log(`could not read a ${name} event`)
      }
    }
  }
}
