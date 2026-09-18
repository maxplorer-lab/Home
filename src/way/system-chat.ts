// ─── System chat intake ──────────────────────────────────────
// Lets a SIBLING MODULE (Sompitra) post a system message into the household
// chat, so the chat is the app's one activity feed: WAY's geofence arrivals
// and Sompitra's money events land in the same scrollback, rendered alike.
//
// WHY THIS IS ITS OWN FILE, not part of way/worker.ts: Sompitra's
// src/lib/notify.ts calls postSystemChat, and way/worker.ts pulls in the whole
// WAY surface (routes, FleetDO). Importing the worker from the notify lib would
// make Sompitra depend on WAY's entire runtime, and form an import cycle the
// moment way/lib/notify.ts needs a shared wording helper from src/lib/notify.ts.
// This module depends on nothing but Env, so that cycle can never form.

import type { Env } from "./types";

/** Event types the DO accepts from callers outside WAY (see FleetDO's
 *  EXTERNAL_SYSTEM_EVENTS, which is the authority — this is the compile-time
 *  half of the same contract).
 *
 *  Money IN and money OUT are separate types on purpose: they carry different
 *  colours and icons in the chat, because a salary landing must not read like
 *  an expense in a scrolling feed. */
export type ExternalSystemEvent = "expense" | "income" | "kine";

/**
 * Post a system chat message on behalf of a sibling module.
 *
 * The message is always attributed to nobody (sender null) and flagged is_auto,
 * so it renders as a centred system row. The sender is deliberately not
 * settable: a system line must never be able to impersonate a person.
 *
 * NEVER throws. A notification is a side effect of the user action that caused
 * it — a chat outage must not fail the expense that was just saved. Returns
 * true when the DO accepted it, so callers can log rather than guess.
 */
export async function postSystemChat(
  env: Env,
  message: string,
  eventType: ExternalSystemEvent
): Promise<boolean> {
  const text = (message || "").trim();
  if (!text) return false;
  // No chat engine bound? Then there is no chat to post into -- exit quietly
  // rather than logging an error on every single expense. This keeps the
  // notify layer usable by a build that has no FleetDO binding at all.
  if (!env.FLEET_DO) return false;
  try {
    const id = env.FLEET_DO.idFromName("fleet");
    const res = await env.FLEET_DO.get(id).fetch("https://fleet-do/system-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, eventType }),
    });
    if (!res.ok) {
      console.error(`postSystemChat rejected (${res.status}) for ${eventType}`);
    }
    return res.ok;
  } catch (e) {
    console.error("postSystemChat failed:", e);
    return false;
  }
}
