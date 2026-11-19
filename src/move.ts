import { closeSync, constants, openSync, readFileSync, readlinkSync, writeSync } from "node:fs";
import { FileError } from "./files.ts";
import type { InboxItem } from "./inbox.ts";
import { closePane, openPane, startIn, type StartRequest, type Started } from "./start.ts";

/**
 * The page can type into a session only through herdr, so a session running in another terminal
 * (Ptyxis, say) cannot be answered from it. Moving fixes that: the session is closed there and
 * opened again, with the same conversation, in a new herdr tab in its folder. Claude Code keeps its
 * session id when resumed, so the page goes on showing the same session.
 *
 * Only a session that waits for you is moved: closing one at work would lose the turn. And the tab
 * in herdr is opened first, so a herdr that is not there, or turns it down, closes nothing.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether the process has ended (a zombie counts: it only waits to be reaped). */
function ended(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ESRCH";
    }
  }
}

/** The command line of a process, as one string. */
function commandOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
  } catch {
    return "";
  }
}

/** The terminal a process reads from ("/dev/pts/7"), if any. */
function ttyOf(pid: number): string | undefined {
  try {
    const tty = readlinkSync(`/proc/${pid}/fd/0`);
    return /^\/dev\/pts\/\d+$/.test(tty) ? tty : undefined;
  } catch {
    return undefined;
  }
}

/** Shows the cursor again and resets colours and the keyboard mode: Codex leaves them when closed. */
const RESET = "\x1b[0m\x1b[?25h\x1b[<u";

/** Writes to the terminal the session ran in, so whoever sits there sees what happened to it. */
function tell(tty: string | undefined, text: string): void {
  if (!tty) return;
  let fd: number | undefined;
  try {
    // Never this process's controlling terminal, and never wait on a terminal nobody reads.
    fd = openSync(tty, constants.O_WRONLY | constants.O_NOCTTY | constants.O_NONBLOCK);
    writeSync(fd, text);
  } catch {
    // the terminal is gone
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function moveToHerdr(item: InboxItem, wait = 8000): Promise<Started> {
  const pid = item.pid;
  if (item.agent !== "claude" && item.agent !== "codex") throw new FileError("Only Claude Code and Codex sessions can move to herdr.", 409);
  if (!pid || !item.cwd) throw new FileError("Agent Deck cannot tell which process runs it.", 409);
  if (item.terminal) throw new FileError("It already runs in herdr.", 409);
  if (item.state !== "your-turn") throw new FileError("It can move once it waits for you: now it is working, or asks something.", 409);
  if (!commandOf(pid).includes(item.agent)) throw new FileError("Its process is gone, or is something else now.", 409);
  const req: StartRequest = { dir: item.cwd, agent: item.agent, prompt: "", resume: item.id, label: item.title || item.name };
  const at = await openPane(req).catch((e: Error) => {
    throw new FileError(`herdr could not open a tab for it, so it stays where it is: ${e.message}`, 409);
  });
  const tty = ttyOf(pid);
  process.kill(pid, "SIGTERM");
  for (const until = Date.now() + wait; !ended(pid) && Date.now() < until; ) await sleep(100);
  if (!ended(pid)) {
    await closePane(at);
    throw new FileError(`It did not close. Close it in ${item.runsIn ?? "its terminal"}, then try again.`, 409);
  }
  tell(tty, RESET);
  let started: Started;
  try {
    started = await startIn(at, req);
  } catch (e) {
    tell(tty, `\r\n[Agent Deck] Closed to move it to herdr, but herdr could not open it. Open it again: ${item.resume}\r\n`);
    throw new Error(`It closed, but herdr could not open it again (${(e as Error).message}). Open it yourself: ${item.resume}`);
  }
  tell(tty, `\r\n[Agent Deck] This session moved to herdr (pane ${started.pane}) and goes on there.\r\n`);
  return started;
}
