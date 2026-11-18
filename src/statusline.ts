import { applyHolds } from "./holds.ts";
import { readInbox, type Inbox } from "./inbox.ts";
import { label } from "./notify.ts";

/**
 * One line for Claude Code's status line: the other sessions that wait on you, so you notice them
 * while working in this one. Empty when nothing waits.
 *
 *   ⏳ 1 needs an answer (shop-checkout: approve Bash: terraform apply) · 2 your turn
 */
export function statusLine(inbox: Inbox, self?: string): string {
  const others = inbox.items.filter((i) => !i.hold && i.key !== self && i.id !== self);
  const answer = others.filter((i) => i.state === "needs-answer");
  const turn = others.filter((i) => i.state === "your-turn");
  const parts: string[] = [];
  if (answer.length) {
    const first = answer[0]!;
    const what = first.reason ? `${label(first, 24)}: ${first.reason.length > 40 ? first.reason.slice(0, 39) + "…" : first.reason}` : label(first, 24);
    parts.push(`${answer.length} need${answer.length === 1 ? "s" : ""} an answer (${what}${answer.length > 1 ? ", …" : ""})`);
  }
  if (turn.length) parts.push(`${turn.length} your turn`);
  return parts.length ? `⏳ ${parts.join(" · ")}` : "";
}

/** The status line for the session described by Claude Code's status-line JSON on stdin. */
export function statusLineFor(stdin: string): string {
  let self: string | undefined;
  try {
    self = (JSON.parse(stdin) as { session_id?: string }).session_id;
  } catch {
    // no JSON: show everything
  }
  const inbox = readInbox({ light: true });
  applyHolds(inbox);
  return statusLine(inbox, self);
}
