import { execFile } from "node:child_process";
import type { Inbox, InboxItem } from "./inbox.ts";

/**
 * Notifications when a session starts waiting on you: it asks something, or finishes a turn.
 * Only changes are reported; the first look at the inbox reports nothing.
 */

export interface Alert {
  key: string;
  title: string;
  body: string;
}

const waiting = (i: InboxItem) => (i.state === "needs-answer" || i.state === "your-turn") && !i.hold;

function lastLine(text: string | undefined): string {
  return (text ?? "").trim().split("\n").filter((l) => l.trim()).pop()?.trim() ?? "";
}

export function label(i: Pick<InboxItem, "title" | "name">, max = 40): string {
  const s = i.title || i.name;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function alertFor(i: InboxItem): Alert {
  if (i.state === "needs-answer") {
    return { key: i.key, title: `${label(i)} needs an answer`, body: i.questions?.[0]?.question ?? i.reason ?? "input needed" };
  }
  return { key: i.key, title: `${label(i)}: your turn`, body: lastLine(i.lastMessage) || "Finished its turn." };
}

/** Sessions that started waiting on you between two looks at the inbox. */
export function newlyWaiting(prev: Inbox | undefined, next: Inbox): Alert[] {
  if (!prev) return [];
  const before = new Map(prev.items.map((i) => [i.key, i]));
  return next.items
    .filter((i) => {
      if (!waiting(i)) return false;
      const b = before.get(i.key);
      return !b || !waiting(b) || b.state !== i.state || b.since !== i.since;
    })
    .map(alertFor);
}

/**
 * Shows a desktop notification: notify-send on Linux, osascript on macOS. $AGENT_DIFF_NOTIFY, if
 * set, is run instead with the title and the body as its two arguments.
 */
export function desktopNotify(alert: Alert): void {
  const quiet = () => {};
  const custom = process.env["AGENT_DIFF_NOTIFY"];
  if (custom) execFile(custom, [alert.title, alert.body], quiet);
  else if (process.platform === "linux") execFile("notify-send", ["-a", "agent-diff", alert.title, alert.body], quiet);
  else if (process.platform === "darwin") execFile("osascript", ["-e", `display notification ${JSON.stringify(alert.body)} with title ${JSON.stringify(alert.title)}`], quiet);
}
