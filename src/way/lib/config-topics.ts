// The list of facts a dashboard caches — and the vocabulary of the signal that
// says one of them changed.
//
// Why this file exists. The LIVE half of W.A.Y has always converged by itself:
// positions, tracks, approaches and the device-control toggles travel over the
// WebSocket, and the connect snapshot carries the whole world again for a page
// that opens later (see FleetDO's buildSnapshot). The CONFIG half did not. A
// fence, a device's emoji, a share grant, the push server and a person's
// profile are written through the Worker into D1, and every OTHER page already
// open kept drawing the copy it loaded when it opened: a fence added on the PC
// was invisible on the phone until somebody reloaded, which looked exactly like
// the save having failed.
//
// So a change to one of those facts now travels as a SIGNAL, not as data:
// the Worker tells the fleet DO (`/config-changed?topic=…`), the DO tells every
// socket, and each client re-reads the slice it caches from the API that owns
// it. Deliberately a signal: the DO does not own these rows, and relaying them
// would invent a second source of truth for data that lives in way-db.
//
// A signal is best-effort by contract (a failed broadcast must never fail the
// write that triggered it), which is why every client ALSO re-reads on
// reconnect and when the page becomes visible again. A lost signal costs a
// delay, never a lie.
//
// These names are the whole vocabulary. Adding a fact means adding a topic
// here, calling `signalConfigChange` where it is written, and mapping it in
// the dashboard's re-read table — `scripts/lib/client-state.mjs` is where those
// three halves are declared together and checked against each other.
export const CONFIG_TOPICS = [
  'fences',
  'devices',
  'shares',
  'invites',
  'notifications',
  'settings',
  'profile',
] as const

import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export type ConfigTopic = (typeof CONFIG_TOPICS)[number]

/** The one binding the signal needs. Typed structurally because BOTH workers
 *  own this fact and both must signal it: the W.A.Y worker's Env and the Home
 *  worker's Env declare FLEET_DO the same way, and /settings writes the
 *  household's push server from the Home side. */
export interface FleetSignalEnv {
  FLEET_DO: DurableObjectNamespace;
}

/**
 * Tell every open dashboard that one of the facts it caches has changed.
 *
 * Best effort by CONTRACT, exactly like `reloadWayNotifications`: a failed
 * signal must never fail the write that triggered it, and every client also
 * re-reads when it reconnects and when the page becomes visible again — so a
 * lost signal costs a delay, never a lie. Awaited rather than fired and
 * forgotten because the caller's write is already a D1 round trip, and a
 * detached promise in a Worker can be cancelled when the response returns.
 */
export async function signalConfigChange(env: FleetSignalEnv, topic: ConfigTopic): Promise<void> {
  try {
    const id = env.FLEET_DO.idFromName("fleet");
    const stub = env.FLEET_DO.get(id);
    await stub.fetch(`https://fleet-do/config-changed?topic=${encodeURIComponent(topic)}`, { method: "POST" });
  } catch {
    // Best effort: see above.
  }
}

/** Is this string a topic this build knows? The DO relays only names from this
 *  list, so a caller (or a forged request) cannot make it push arbitrary text
 *  to every socket. */
export function isConfigTopic(value: unknown): value is ConfigTopic {
  return typeof value === 'string' && (CONFIG_TOPICS as readonly string[]).includes(value)
}
