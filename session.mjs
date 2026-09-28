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

/** The computer's name for Settings: up to the first dot ("steves-mac.local" → "steves-mac"), 64 characters. */
export function hostLabel(hostname) {
  return (typeof hostname === "string" ? hostname.split(".")[0] || hostname : "").trim().slice(0, 64)
}

/**
 * The event-stream URL: always the base name and the instance id, never the name the server assigned.
 * host (the computer), repo (the working folder's name) and version let Settings group the sessions
 * by computer and repository and say when the plugin needs an update (0.2.4+).
 */
export function streamUrl(baseUrl, { session, instance, scope, host, repo, version }) {
  const params = [
    ["client", "claude-code"],
    ["session", session],
    ["instance", instance],
    ["host", host],
    ["repo", repo ? String(repo).slice(0, 64) : repo],
    ["version", version],
    ["scope", scope],
  ].filter(([, value]) => value)
  return `${baseUrl}/api/agent-events?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`
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
