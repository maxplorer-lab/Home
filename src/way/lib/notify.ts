// lib/notify.ts
// Push-notification helpers shared by the Worker routes and the FleetDO.
//
// Transport is ntfy: publish with a POST to <server>/<topic> (message in the
// body, title/tags in headers), and the receiving phone's ntfy app follows
// that user's own topic. The server root comes from NTFY_URL in
// wrangler.jsonc and is a SELF-HOSTED instance on Cloud Run -- not the public
// ntfy.sh, whose free daily message quota silently stops delivery once hit.
// See docs/OPERATIONS.md, "ntfy".
//
// Routing model -- the part that is easy to get backwards: each user owns ONE
// random topic, which is their private inbox, and their phone follows only
// that one. The RECIPIENT's checkbox grid (notification_subs) decides what the
// backend routes into it, so events are published per receiving user and never
// to a shared channel. The delivery policy (quiet hours, cooldown, daily cap)
// is applied in FleetDO.notifyEvent -- see docs/ARCHITECTURE.md, "Notification
// pipeline".
//
// Because a topic name is the only thing protecting its messages, topics are
// always randomly generated -- never guessable.

/** The notification kinds a user can subscribe to, in grid display order.
 * Adding one here also requires EVENT_TAGS below, a NOTIF_LABELS entry in
 * public/way/index.html, and a call to FleetDO.notifyEvent. */
export type NotifyEventType = "entry" | "exit" | "chat" | "stationary" | "moving" | "approach";

export const NOTIFY_EVENT_TYPES: NotifyEventType[] = ["entry", "exit", "chat", "stationary", "moving", "approach"];

/** ntfy.sh topic names allow [-_A-Za-z0-9]{1,64}. */
const TOPIC_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Random, unguessable topic -- 20 chars after a "way-" prefix. Generated
 * automatically when a user is created, and regenerable by an admin. */
export function generateNtfyTopic(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let suffix = "";
  for (const b of bytes) suffix += TOPIC_ALPHABET[b % TOPIC_ALPHABET.length];
  return `way-${suffix}`;
}

/** HTTP header values must be ASCII (emoji or accented characters in a
 * Title would make fetch() throw), so header text is sanitized here while
 * the BODY keeps the full UTF-8 message. */
export function headerSafe(text: string): string {
  const cleaned = text.replace(/[^\x20-\x7E]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "WAY";
}

/** ntfy renders these shortcodes as emoji. ASCII-only on purpose. */
export const EVENT_TAGS: Record<NotifyEventType, string> = {
  entry: "house",
  exit: "door",
  chat: "speech_balloon",
  stationary: "parking",
  moving: "car",
  approach: "hourglass",
};

/** Household timezone: Africa/Nairobi (UTC+3, no DST). */
export const TZ_OFFSET_MS = 3 * 60 * 60 * 1000;

// ------------------------------------------------------------
//  Server configuration
//
//  The ntfy server root is an admin-editable setting (Settings -> Users &
//  topics), not a hardcoded constant -- moving to a different push server
//  must not require a code change and a redeploy. Resolution order, applied
//  in FleetDO.getNotifyConfig()/notifyEvent():
//
//    app_settings.ntfy_url  ->  env.NTFY_URL (wrangler.jsonc)  ->  DEFAULT_NTFY_URL
// ------------------------------------------------------------
export const NTFY_URL_SETTING_KEY = "ntfy_url";
export const DEFAULT_NTFY_URL = "https://ntfy.sh";

/** Accepts an http(s) server root, strips trailing slashes, and returns the
 * normalized value -- or null if it isn't usable. Single-sourcing this keeps
 * the API and the DO from disagreeing about what a valid value looks like.
 *
 * A bare hostname ("ntfy.example.com") is deliberately REJECTED rather than
 * silently upgraded to https:// -- a wrong-but-accepted value would look
 * saved while every push failed. */
export function normalizeNtfyServer(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

/** Is `nowMs` inside this user's quiet window? Handles windows that wrap
 * past midnight (e.g. 22 -> 6). An empty window (start === end) is off. */
export function inQuietHours(quietStart: number, quietEnd: number, nowMs: number): boolean {
  const start = ((quietStart % 24) + 24) % 24;
  const end = ((quietEnd % 24) + 24) % 24;
  if (start === end) return false;
  const hour = new Date(nowMs + TZ_OFFSET_MS).getUTCHours();
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export interface NtfyMessage {
  topic: string;
  title: string;
  body: string;
  tag: string;
}

/** Fire-and-forget publish. Never throws: a ntfy outage must not be able to
 * affect tracking or the ping pipeline.
 *
 * `baseUrl` is the ntfy server root -- `https://ntfy.sh` or a self-hosted
 * instance (e.g. a Cloud Run URL). `token` is only needed when that server
 * has authentication enabled. */
export async function publishNtfy(msg: NtfyMessage, baseUrl: string, token?: string | null): Promise<boolean> {
  try {
    const root = baseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = {
      Title: headerSafe(msg.title),
      Tags: msg.tag,
      "Content-Type": "text/plain; charset=utf-8",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${root}/${encodeURIComponent(msg.topic)}`, {
      method: "POST",
      headers,
      body: msg.body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.log(`ntfy publish HTTP ${res.status} (${root}): ${text.slice(0, 200)}`);
    }
    return res.ok;
  } catch (e) {
    console.log(`ntfy publish error (${baseUrl}): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
