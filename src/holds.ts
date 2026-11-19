import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Inbox, InboxItem } from "./inbox.ts";
import { env } from "./env.ts";

/**
 * "Later" and "Done": take a session off the waiting list until it moves on. A hold remembers
 * the state the session was in; as soon as the session does something new (its state or the time
 * it entered it changes), or the "later" time comes, the hold is dropped and it waits again.
 *
 * Holds live in $XDG_STATE_HOME/agent-deck/holds.json (~/.local/state/agent-deck by default).
 */

export type HoldKind = "later" | "done";

export interface Hold {
  kind: HoldKind;
  /** "later": until when (ms). */
  until?: number;
  /** The session's state and its start when it was held. */
  state: string;
  since: number;
  at: number;
}

export type Holds = Record<string, Hold>;

export function stateDir(): string {
  const set = env("STATE_DIR");
  if (set) return set;
  const base = process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state");
  const dir = join(base, "agent-deck");
  // Agent Deck was agent-diff: its state (holds, the page's token, devices) moves over, once.
  if (!existsSync(dir) && existsSync(join(base, "agent-diff"))) {
    try {
      renameSync(join(base, "agent-diff"), dir);
    } catch {
      return join(base, "agent-diff");
    }
  }
  return dir;
}

const holdsFile = () => join(stateDir(), "holds.json");

export function readHolds(): Holds {
  try {
    return JSON.parse(readFileSync(holdsFile(), "utf8")) as Holds;
  } catch {
    return {};
  }
}

function writeHolds(holds: Holds): void {
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${holdsFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(holds, null, 2) + "\n");
  renameSync(tmp, holdsFile());
}

export function hold(item: Pick<InboxItem, "key" | "state" | "since">, kind: HoldKind, until?: number, now = Date.now()): Hold {
  const holds = readHolds();
  const h: Hold = { kind, state: item.state, since: item.since, at: now };
  if (kind === "later" && until) h.until = until;
  holds[item.key] = h;
  writeHolds(holds);
  return h;
}

export function release(key: string): boolean {
  const holds = readHolds();
  if (!(key in holds)) return false;
  delete holds[key];
  writeHolds(holds);
  return true;
}

/** Marks the held items of an inbox, and forgets holds of sessions that moved on or whose time came. */
export function applyHolds(inbox: Inbox, now = inbox.generatedAt): void {
  const holds = readHolds();
  const byKey = new Map(inbox.items.map((i) => [i.key, i]));
  let changed = false;
  for (const [key, h] of Object.entries(holds)) {
    const item = byKey.get(key);
    // Your turn turning stale is only time passing, not the session moving on.
    const sameState = item && (item.state === h.state || (h.state === "your-turn" && item.state === "stale"));
    if (!item || !sameState || item.since !== h.since || (h.until !== undefined && now >= h.until)) {
      delete holds[key];
      changed = true;
      continue;
    }
    item.hold = h.until !== undefined ? { kind: h.kind, until: h.until } : { kind: h.kind };
  }
  if (changed) writeHolds(holds);
}

/**
 * When "later" ends: "2h" or "30m" from now, "tomorrow" (9:00 tomorrow), "9:00" (the next 9:00),
 * or a date and time.
 */
export function parseUntil(text: string, now = Date.now()): number {
  const t = text.trim().toLowerCase();
  const rel = /^(\d+(?:\.\d+)?)\s*(m|min|h|d)$/.exec(t);
  if (rel) return now + Number(rel[1]) * { m: 6e4, min: 6e4, h: 36e5, d: 864e5 }[rel[2] as "m"];
  const clock = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (t === "tomorrow" || clock) {
    const d = new Date(now);
    d.setHours(clock ? Number(clock[1]) : 9, clock ? Number(clock[2]) : 0, 0, 0);
    if (t === "tomorrow" || d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const abs = Date.parse(text);
  if (Number.isNaN(abs)) throw new Error(`Cannot read "${text}" as a time (try 2h, tomorrow, 9:00 or 2026-11-20 09:00)`);
  return abs;
}
