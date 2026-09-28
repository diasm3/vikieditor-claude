// node --test — no dependencies: a fake OpenCode client, a fake VikiEditor event stream, fake timers.
import { test } from "node:test"
import assert from "node:assert/strict"
import { PERMISSION_TTL_MS, buildPrompt, createVikiEditor, newRequestId, readEvents, resolveSettings } from "../lib.mjs"

const encoder = new TextEncoder()
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(condition, what = "condition", ms = 1000) {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`)
    await wait(2)
  }
}

/** A text/event-stream we write to. */
function fakeStream() {
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  return {
    body: readable,
    push: (name, data) => writer.write(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)),
    ping: () => writer.write(encoder.encode(": ping\n\n")),
    close: () => writer.close(),
  }
}

function fakeTimers() {
  const timeouts = new Map()
  let n = 0
  return {
    timeouts,
    setTimeout(fn, ms) {
      timeouts.set(++n, { fn, ms })
      return n
    },
    clearTimeout(id) {
      timeouts.delete(id)
    },
    setInterval() {
      return ++n
    },
    clearInterval() {},
    /** Fires every pending timeout with this delay */
    fire(ms) {
      for (const [id, t] of [...timeouts]) {
        if (t.ms !== ms) continue
        timeouts.delete(id)
        t.fn()
      }
    },
  }
}

function fakeClient() {
  const calls = { prompts: [], toasts: [], permissions: [] }
  return {
    calls,
    session: {
      async promptAsync(request) {
        calls.prompts.push(request)
        return { data: undefined, error: undefined }
      },
    },
    tui: {
      async showToast(request) {
        calls.toasts.push(request.body)
        return { data: true }
      },
    },
    async postSessionIdPermissionsPermissionId(request) {
      calls.permissions.push(request)
      return { data: true }
    },
  }
}

const FEEDBACK = {
  threadId: "aaaaaaaa-1111-4111-8111-111111111111",
  documentId: "dddddddd-1111-4111-8111-111111111111",
  documentTitle: "Design",
  heading: "Goals",
  quote: "the old sentence",
  body: "Please say why.",
  author: "Kim",
  again: false,
}
const HANDOFF = { handoffId: "bbbbbbbb-2222-4222-8222-222222222222", title: "Next: settings page", body: "Build it.", documentId: null }
const READY = { stream: "stream-1", session: "vikieditor", scope: null }

function harness({ env = {}, directory = "/repo/app", files = {} } = {}) {
  const stream = fakeStream()
  const requests = []
  const fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if (String(url).endsWith("/api/agent-events/permissions")) return new Response(JSON.stringify({ id: "perm-1" }), { status: 200 })
    if (String(url).includes("/alive")) return new Response(null, { status: 204 })
    if (String(url).includes("/api/agent-events?")) return new Response(stream.body, { status: 200 })
    return new Response("not found", { status: 404 })
  }
  const client = fakeClient()
  const timers = fakeTimers()
  const logs = []
  const plugin = createVikiEditor({
    client,
    directory,
    env: { VIKIEDITOR_API_KEY: "vk_test", ...env },
    fetch,
    fs: { existsSync: (path) => path in files, readFileSync: (path) => files[path] },
    timers,
    log: (...args) => logs.push(args.join(" ")),
  })
  const event = (type, properties) => plugin.hooks.event({ event: { type, properties } })
  const posted = () => requests.filter((r) => r.url.endsWith("/api/agent-events/permissions")).map((r) => JSON.parse(r.init.body))
  return { plugin, client, stream, requests, timers, logs, event, posted }
}

/** Connected, with one idle top-level session the person is using. */
async function connected(options) {
  const h = harness(options)
  h.plugin.start()
  await until(() => h.requests.length > 0, "the stream request")
  await h.stream.push("ready", READY)
  await until(() => h.plugin.state.connected, "ready")
  await h.event("session.created", { info: { id: "ses_1", title: "x" } })
  return h
}

test("settings: .vikieditor.json above the working folder names the session and its scope; the environment wins", () => {
  const files = { "/repo/.vikieditor.json": JSON.stringify({ session: "vikieditor", folders: ["VikiEditor"], tags: ["vikieditor"] }) }
  const fs = { existsSync: (path) => path in files, readFileSync: (path) => files[path] }
  const fromFile = resolveSettings({ directory: "/repo/app", env: { VIKIEDITOR_API_KEY: "vk_1" }, fs })
  assert.equal(fromFile.session, "vikieditor")
  assert.equal(fromFile.scope, JSON.stringify({ folders: ["VikiEditor"], tags: ["vikieditor"] }))
  assert.equal(fromFile.baseUrl, "https://api.piai.company")

  const fromEnv = resolveSettings({
    directory: "/repo/app",
    env: { VIKIEDITOR_API_KEY: "vk_1", VIKIEDITOR_SCOPE: "folder:Other,tag:x", VIKIEDITOR_SESSION: "window-2", VIKIEDITOR_URL: "http://localhost:3000/" },
    fs,
  })
  assert.equal(fromEnv.session, "window-2")
  assert.equal(fromEnv.scope, "folder:Other,tag:x")
  assert.equal(fromEnv.baseUrl, "http://localhost:3000")

  const bare = resolveSettings({ directory: "/somewhere/my-app", env: {}, fs: { existsSync: () => false } })
  assert.equal(bare.session, "my-app")
  assert.equal(bare.scope, "")
  assert.equal(bare.apiKey, "")

  const optioned = resolveSettings({ directory: "/somewhere/my-app", env: {}, options: { session: "opt", apiKey: "vk_opt" }, fs: { existsSync: () => false } })
  assert.equal(optioned.session, "opt")
  assert.equal(optioned.apiKey, "vk_opt")
})

test("scope: the stream is opened as client=opencode with the session name and the scope", async () => {
  const files = { "/repo/.vikieditor.json": JSON.stringify({ session: "vikieditor", folders: ["VikiEditor"], tags: ["vikieditor"] }) }
  const h = harness({ files, env: { VIKIEDITOR_URL: "https://viki.test" } })
  h.plugin.start()
  await until(() => h.requests.length > 0, "the stream request")
  const [first] = h.requests
  const url = new URL(first.url)
  assert.equal(url.origin + url.pathname, "https://viki.test/api/agent-events")
  assert.equal(url.searchParams.get("client"), "opencode")
  assert.equal(url.searchParams.get("session"), "vikieditor")
  assert.deepEqual(JSON.parse(url.searchParams.get("scope")), { folders: ["VikiEditor"], tags: ["vikieditor"] })
  assert.equal(first.init.headers.Authorization, "Bearer vk_test")
  assert.equal(first.init.headers.Accept, "text/event-stream")
  h.plugin.stop()
})

test("no API key: nothing is opened", async () => {
  const h = harness({ env: { VIKIEDITOR_API_KEY: "" } })
  h.plugin.start()
  await wait(10)
  assert.equal(h.requests.length, 0)
  assert.ok(h.logs.some((line) => line.includes("VIKIEDITOR_API_KEY is not set")))
})

test("ready: the server's session name (with its -2 suffix) is adopted; a toast says so", async () => {
  const h = harness()
  h.plugin.start()
  await until(() => h.requests.length > 0, "the stream request")
  await h.stream.push("ready", { ...READY, session: "app-2", scope: { folders: [{ id: "d1", title: "VikiEditor" }], tags: ["vikieditor"], unresolved: ["Gone"] } })
  await until(() => h.plugin.state.connected, "ready")
  assert.equal(h.plugin.state.session, "app-2")
  assert.equal(h.plugin.state.streamId, "stream-1")
  assert.ok(h.client.calls.toasts.some((t) => t.message.includes('"app-2"')))
  assert.ok(h.logs.some((line) => line.includes('folder "VikiEditor"') && line.includes("Not found: Gone")))
  h.plugin.stop()
})

test("events queue while a turn runs; on idle they go in as one prompt naming the ids and the MCP tools", async () => {
  const h = await connected()
  await h.event("session.status", { sessionID: "ses_1", status: { type: "busy" } })
  await h.stream.push("feedback", FEEDBACK)
  await h.stream.push("handoff", HANDOFF)
  await until(() => h.plugin.state.queue.size === 2, "two queued items")
  assert.equal(h.client.calls.prompts.length, 0, "nothing goes in mid-turn")
  assert.equal(h.client.calls.toasts.filter((t) => t.message.includes("Design") || t.message.includes("Next")).length, 2, "a toast per arrival")

  await h.event("session.idle", { sessionID: "ses_1" })
  await until(() => h.client.calls.prompts.length === 1, "the prompt")
  const [request] = h.client.calls.prompts
  assert.equal(request.path.id, "ses_1")
  assert.equal(request.body.parts.length, 1)
  const text = request.body.parts[0].text
  assert.equal(request.body.parts[0].type, "text")
  for (const expected of [
    'session ("vikieditor")',
    'Kim left feedback on "Design" › Goals',
    "Please say why.",
    'On: "the old sentence"',
    "feedback action=take commentId=aaaaaaaa",
    "feedback action=reply",
    "Handoff: Next: settings page",
    "handoff action=take id=bbbbbbbb",
    "handoff action=done",
    'session tool in this session yet, call it first with label "vikieditor"',
  ])
    assert.ok(text.includes(expected), `prompt should mention ${expected}\n${text}`)
  assert.equal(h.plugin.state.queue.size, 0)
  h.plugin.stop()
})

test("idle already: the prompt goes in at once; the next event waits for the turn we started to end", async () => {
  const h = await connected()
  await h.stream.push("feedback", FEEDBACK)
  await until(() => h.client.calls.prompts.length === 1, "the first prompt")
  assert.ok(h.client.calls.prompts[0].body.parts[0].text.includes("commentId=aaaaaaaa"))

  // The injected turn is running: a second event must not go in
  await h.stream.push("handoff", HANDOFF)
  await until(() => h.plugin.state.queue.size === 1, "the queued handoff")
  await wait(10)
  assert.equal(h.client.calls.prompts.length, 1)

  await h.event("session.idle", { sessionID: "ses_1" })
  await until(() => h.client.calls.prompts.length === 2, "the second prompt")
  assert.ok(h.client.calls.prompts[1].body.parts[0].text.includes("id=bbbbbbbb"))
  assert.ok(!h.client.calls.prompts[1].body.parts[0].text.includes("commentId=aaaaaaaa"), "delivered items are not repeated")
  h.plugin.stop()
})

test("dedupe: the same event twice is one item; the same thread asked again with new text is a new item", async () => {
  const h = await connected()
  await h.event("session.status", { sessionID: "ses_1", status: { type: "busy" } })
  await h.stream.push("feedback", FEEDBACK)
  await h.stream.push("feedback", FEEDBACK)
  await h.stream.push("feedback", { ...FEEDBACK, body: "Please say why.  " }) // whitespace only: still the same thread while queued
  await until(() => h.plugin.state.queue.size === 1, "one queued item")
  await wait(10)
  assert.equal(h.plugin.state.queue.size, 1)

  await h.event("session.idle", { sessionID: "ses_1" })
  await until(() => h.client.calls.prompts.length === 1, "the prompt")
  const text = h.client.calls.prompts[0].body.parts[0].text
  assert.equal(text.match(/commentId=aaaaaaaa/g).length, 1)

  // Delivered a moment ago with the same text: dropped
  await h.stream.push("feedback", { ...FEEDBACK, body: "Please say why.  " })
  await wait(10)
  assert.equal(h.plugin.state.queue.size, 0)
  // Asked again: queued
  await h.stream.push("feedback", { ...FEEDBACK, again: true, body: "Still unclear." })
  await until(() => h.plugin.state.queue.size === 1, "the follow-up")
  h.plugin.stop()
})

test("only the person's top-level session gets prompts; subagent sessions are ignored", async () => {
  const h = await connected()
  await h.event("session.created", { info: { id: "ses_child", parentID: "ses_1", title: "subagent" } })
  await h.event("session.status", { sessionID: "ses_1", status: { type: "busy" } })
  await h.stream.push("feedback", FEEDBACK)
  await until(() => h.plugin.state.queue.size === 1, "the queued item")
  await h.event("session.idle", { sessionID: "ses_child" })
  await wait(10)
  assert.equal(h.client.calls.prompts.length, 0, "a child going idle is not the person's session")
  await h.event("session.idle", { sessionID: "ses_1" })
  await until(() => h.client.calls.prompts.length === 1, "the prompt")
  assert.equal(h.client.calls.prompts[0].path.id, "ses_1")
  h.plugin.stop()
})

test("targetSession: an event meant for another session is watched, not taken", async () => {
  const h = await connected()
  await h.stream.push("feedback", { ...FEEDBACK, targetSession: "other-window" })
  await until(() => h.client.calls.toasts.some((t) => t.message.includes('"other-window"')), "the informational toast")
  await wait(10)
  assert.equal(h.client.calls.prompts.length, 0)
  assert.equal(h.plugin.state.queue.size, 0)
  assert.ok(h.logs.some((line) => line.includes('for session "other-window"')))

  // Ours (case-insensitively), or unaddressed: acted on
  await h.stream.push("handoff", { ...HANDOFF, targetSession: "VikiEditor" })
  await until(() => h.client.calls.prompts.length === 1, "the prompt for our handoff")
  await h.event("session.idle", { sessionID: "ses_1" })
  await h.stream.push("feedback", { ...FEEDBACK, targetSession: null })
  await until(() => h.client.calls.prompts.length === 2, "the prompt for the broadcast")
  h.plugin.stop()
})

test("permission relay: the request goes to VikiEditor with a five-letter id; the phone's answer is applied", async () => {
  const h = await connected()
  await h.event("permission.asked", {
    id: "per_1",
    sessionID: "ses_1",
    permission: "bash",
    patterns: ["rm -rf build"],
    metadata: { command: "rm -rf build" },
    always: ["*"],
  })
  await until(() => h.posted().length === 1, "the relayed request")
  const [request] = h.posted()
  assert.equal(request.stream, "stream-1")
  assert.match(request.request_id, /^[a-km-z]{5}$/)
  assert.equal(request.tool_name, "bash")
  assert.equal(request.description, "rm -rf build")
  assert.ok(request.input_preview.includes("rm -rf build"))
  const relayed = h.requests.find((r) => r.url.endsWith("/api/agent-events/permissions"))
  assert.equal(relayed.init.headers.Authorization, "Bearer vk_test")

  await h.stream.push("permission", { request_id: request.request_id, behavior: "allow" })
  await until(() => h.client.calls.permissions.length === 1, "the SDK reply")
  assert.deepEqual(h.client.calls.permissions[0], { path: { id: "ses_1", permissionID: "per_1" }, body: { response: "once" } })
  assert.equal(h.plugin.state.permissions.size, 0)

  // The v1 event shape (permission.updated), denied
  await h.event("permission.updated", { id: "per_2", sessionID: "ses_1", type: "edit", pattern: "src/a.ts", title: "Edit src/a.ts", metadata: {} })
  await until(() => h.posted().length === 2, "the second relayed request")
  const second = h.posted()[1]
  assert.equal(second.tool_name, "edit")
  assert.equal(second.description, "Edit src/a.ts")
  await h.stream.push("permission", { request_id: second.request_id, behavior: "deny" })
  await until(() => h.client.calls.permissions.length === 2, "the second SDK reply")
  assert.deepEqual(h.client.calls.permissions[1], { path: { id: "ses_1", permissionID: "per_2" }, body: { response: "reject" } })
  h.plugin.stop()
})

test("permission relay: the same permission is relayed once", async () => {
  const h = await connected()
  const permission = { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls"], metadata: {} }
  await h.event("permission.asked", permission)
  await h.event("permission.updated", { ...permission, type: "bash", pattern: "ls" })
  await until(() => h.posted().length === 1, "the relayed request")
  await wait(10)
  assert.equal(h.posted().length, 1)
  h.plugin.stop()
})

test("permission relay: unanswered for ten minutes, the phone's late answer does nothing", async () => {
  const h = await connected()
  await h.event("permission.asked", { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls"], metadata: {} })
  await until(() => h.posted().length === 1, "the relayed request")
  const [{ request_id }] = h.posted()
  h.timers.fire(PERMISSION_TTL_MS)
  assert.equal(h.plugin.state.permissions.size, 0)
  await h.stream.push("permission", { request_id, behavior: "allow" })
  await wait(10)
  assert.equal(h.client.calls.permissions.length, 0)
  h.plugin.stop()
})

test("permission relay: answered in the terminal first, the phone's answer is dropped", async () => {
  const h = await connected()
  await h.event("permission.asked", { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls"], metadata: {} })
  await until(() => h.posted().length === 1, "the relayed request")
  const [{ request_id }] = h.posted()
  await h.event("permission.replied", { sessionID: "ses_1", permissionID: "per_1", response: "once" })
  assert.equal(h.plugin.state.permissions.size, 0)
  await h.stream.push("permission", { request_id, behavior: "allow" })
  await wait(10)
  assert.equal(h.client.calls.permissions.length, 0)
  h.plugin.stop()
})

test("permission relay: nothing is relayed before the stream is ready", async () => {
  const h = harness()
  h.plugin.start()
  await until(() => h.requests.length > 0, "the stream request")
  await h.event("permission.asked", { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["ls"], metadata: {} })
  await wait(10)
  assert.equal(h.posted().length, 0)
  h.plugin.stop()
})

test("stream: a closed stream is left alone once stopped; comments and malformed data do not break it", async () => {
  const h = await connected()
  await h.stream.ping()
  await h.stream.push("feedback", FEEDBACK)
  await until(() => h.client.calls.prompts.length === 1, "the prompt")
  h.plugin.stop()
  await h.stream.close()
  await wait(10)
  assert.equal(h.requests.filter((r) => r.url.includes("/api/agent-events?")).length, 1, "no reconnect after stop")
})

test("readEvents: names, multi-line data, comments", async () => {
  const chunks = [
    encoder.encode("event: ready\ndata: {\"stream\":\"s\"}\n\n: ping\n\nevent: feedback\ndata: {\"a\":1,\n"),
    encoder.encode("data: \"b\":2}\n\nevent: bad\ndata: {oops\n\n"),
  ]
  const seen = []
  for await (const event of readEvents(chunks)) seen.push(event)
  assert.deepEqual(seen, [
    { name: "ready", data: { stream: "s" } },
    { name: "feedback", data: { a: 1, b: 2 } },
    { name: "bad", data: undefined, malformed: true },
  ])
})

test("request ids fit VikiEditor's /^[a-km-z]{5}$/ and avoid taken ones", () => {
  for (let i = 0; i < 200; i++) assert.match(newRequestId(), /^[a-km-z]{5}$/)
  let calls = 0
  const random = () => (calls++ < 5 ? 0 : 0.5) // the first id is "aaaaa"
  assert.notEqual(newRequestId(new Set(["aaaaa"]), random), "aaaaa")
})

test("buildPrompt: one item reads as one", () => {
  const text = buildPrompt([{ kind: "handoff", event: HANDOFF, key: "handoff:x", body: "" }], "s")
  assert.ok(text.startsWith('VikiEditor: one item is waiting for this session ("s"). Handle it'))
  assert.ok(text.includes("1. Handoff: Next: settings page"))
})
