// node --test integrations/claude-code-channel/test — no dependencies.
import { test } from "node:test"
import assert from "node:assert/strict"
import { baseSession, forAnotherSession, hostLabel, instanceId, streamUrl } from "../session.mjs"

test("the base name: VIKIEDITOR_SESSION, then the config, then the folder", () => {
  assert.equal(baseSession({ VIKIEDITOR_SESSION: "haist" }, { session: "cfg" }, "folder"), "haist")
  assert.equal(baseSession({}, { session: "cfg" }, "folder"), "cfg")
  assert.equal(baseSession({}, {}, "folder"), "folder")
  assert.equal(baseSession({}, { session: 3 }, ""), "claude-code")
  assert.equal(baseSession({ VIKIEDITOR_SESSION: "x".repeat(120) }, {}, "f").length, 100)
})

test("the instance id is stable per process and comes from VIKIEDITOR_INSTANCE when set", () => {
  assert.equal(instanceId({ VIKIEDITOR_INSTANCE: "abc" }), "abc")
  assert.equal(instanceId({ VIKIEDITOR_INSTANCE: "y".repeat(80) }).length, 64)
  const a = instanceId({})
  const b = instanceId({})
  assert.match(a, /^[0-9a-f-]{36}$/)
  assert.notEqual(a, b)
})

test("every connect asks for the base name with the instance id, never the assigned name", () => {
  const assigned = "haist-2"
  const url = streamUrl("https://api.example", { session: "haist", instance: "p1", scope: "" })
  const params = new URL(url).searchParams
  assert.equal(new URL(url).pathname, "/api/agent-events")
  assert.equal(params.get("client"), "claude-code")
  assert.equal(params.get("session"), "haist")
  assert.equal(params.get("instance"), "p1")
  assert.equal(params.has("scope"), false)
  assert.ok(!url.includes(assigned))

  const scoped = new URL(
    streamUrl("https://api.example", { session: "a b", instance: "p1", scope: '{"tags":["x"]}' }),
  ).searchParams
  assert.equal(scoped.get("session"), "a b")
  assert.equal(scoped.get("scope"), '{"tags":["x"]}')
})

test("the computer, repository and version go along for Settings (0.2.4+)", () => {
  const params = new URL(
    streamUrl("https://api.example", {
      session: "haist",
      instance: "p1",
      scope: "",
      host: hostLabel("Steves-MacBook.local"),
      repo: "r".repeat(80),
      version: "0.2.4",
    }),
  ).searchParams
  assert.equal(params.get("host"), "Steves-MacBook")
  assert.equal(params.get("repo"), "r".repeat(64))
  assert.equal(params.get("version"), "0.2.4")
  assert.equal(params.get("client"), "claude-code")
  assert.equal(hostLabel("x".repeat(90)).length, 64)
  assert.equal(hostLabel(undefined), "")
})

test("an event is for this window when targetSession is the assigned or the base name", () => {
  const names = ["haist-2", "haist"]
  assert.equal(forAnotherSession(null, names), false)
  assert.equal(forAnotherSession(undefined, names), false)
  assert.equal(forAnotherSession("haist-2", names), false)
  assert.equal(forAnotherSession("HAIST", names), false)
  assert.equal(forAnotherSession("haist-3", names), true)
  assert.equal(forAnotherSession("carhos", names), true)
})
