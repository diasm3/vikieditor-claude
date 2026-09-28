// Session naming for the VikiEditor channel, shared with test/session.test.mjs. No dependencies.
import { randomUUID } from "node:crypto"

/**
 * The name this window asks the server for: VIKIEDITOR_SESSION, the config's "session", else the
 * folder Claude Code runs in. The server answers with the name it gave (the same, or "name-2" …
 * when another window already has it); that one is shown, never sent back.
 */
export function baseSession(env, config, folder) {
  return (
    env.VIKIEDITOR_SESSION ||
    (typeof config?.session === "string" && config.session) ||
    folder ||
    "claude-code"
  ).slice(0, 100)
}

/** A stable id for this plugin process: the server keeps a session's name for the same instance across reconnects. */
export function instanceId(env) {
  return (env.VIKIEDITOR_INSTANCE || randomUUID()).slice(0, 64)
}

/** The event-stream URL: always the base name and the instance id, never the name the server assigned. */
export function streamUrl(baseUrl, { session, instance, scope }) {
  const query = `client=claude-code&session=${encodeURIComponent(session)}&instance=${encodeURIComponent(instance)}`
  return `${baseUrl}/api/agent-events?${query}${scope ? `&scope=${encodeURIComponent(scope)}` : ""}`
}

/**
 * An event the server routed to another session: targetSession is neither the name the server
 * assigned nor the base name (case does not matter). Null targetSession: sent to everyone.
 */
export function forAnotherSession(targetSession, names) {
  if (typeof targetSession !== "string") return false
  const target = targetSession.toLowerCase()
  return !names.some((name) => typeof name === "string" && name.toLowerCase() === target)
}
