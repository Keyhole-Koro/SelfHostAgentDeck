import { closeSync, constants, openSync, readFileSync, readlinkSync, writeSync } from "node:fs";
import { FileError } from "./files.ts";
import { commandOf, type InboxItem } from "./inbox.ts";
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

/** Whether the process is what its terminal runs in front: not a job in the background, or a child of another program there. */
function inFront(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // After the ")" of the command name: state ppid pgrp session tty_nr tpgid …
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return f[2] === f[5];
  } catch {
    return false;
  }
}

/** Sessions being moved now: a second tap, or another device, must not open a second copy. */
const moving = new Set<string>();

/**
 * @param still Asked again right before the old process is closed, since opening the tab takes a
 * while: whether the session still waits for you, in the same process.
 */
export async function moveToHerdr(item: InboxItem, still: () => boolean = () => true, wait = 8000): Promise<Started> {
  if (moving.has(item.key)) throw new FileError("It is being moved already.", 409);
  moving.add(item.key);
  try {
    return await move(item, still, wait);
  } finally {
    moving.delete(item.key);
  }
}

async function move(item: InboxItem, still: () => boolean, wait: number): Promise<Started> {
  const pid = item.pid;
  if (item.agent !== "claude" && item.agent !== "codex") throw new FileError("Only Claude Code and Codex sessions can move to herdr.", 409);
  if (!pid || !item.cwd) throw new FileError("Agent Deck cannot tell which process runs it.", 409);
  if (item.terminal) throw new FileError("It already runs in herdr.", 409);
  if (item.kind === "bg") throw new FileError("It runs as a Claude Code background session, in no terminal: it cannot be moved from here.", 409);
  if (item.state !== "your-turn") throw new FileError("It can move once it waits for you: now it is working, or asks something.", 409);
  const command = commandOf(pid);
  if (!command.includes(item.agent)) throw new FileError("Its process is gone, or is something else now.", 409);
  if (/\bapp-server\b/.test(command)) throw new FileError("It runs in Codex's background server, which other sessions share: it cannot be moved from here.", 409);
  const tty = ttyOf(pid);
  if (!tty || !inFront(pid)) throw new FileError("It does not run on its own in a terminal (another program runs it), so it cannot be moved from here.", 409);
  const req: StartRequest = { dir: item.cwd, agent: item.agent, prompt: "", resume: item.id, label: item.title || item.name };
  const at = await openPane(req).catch((e: Error) => {
    throw new FileError(`herdr could not open a tab for it, so it stays where it is: ${e.message}`, 409);
  });
  const leave = async (why: string): Promise<never> => {
    await closePane(at).catch(() => {});
    throw new FileError(why, 409);
  };
  if (!still() || commandOf(pid) !== command) await leave("It started working again (or closed) meanwhile, so it stays where it is.");
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    await leave(`It could not be closed (${(e as NodeJS.ErrnoException).code}), so it stays where it is.`);
  }
  for (const until = Date.now() + wait; !ended(pid) && Date.now() < until; ) await sleep(100);
  if (!ended(pid)) await leave(`It did not close. Close it in ${item.runsIn ?? "its terminal"}, then try again.`);
  tell(tty, RESET);
  let started: Started;
  try {
    started = await startIn(at, req);
  } catch (e) {
    // A tab left half-started could go on to open it too, beside the copy you open yourself.
    await closePane(at).catch(() => {});
    tell(tty, `\r\n[Agent Deck] Closed to move it to herdr, but herdr could not open it. Open it again: ${item.resume}\r\n`);
    throw new Error(`It closed, but herdr could not open it again (${(e as Error).message}). Open it yourself: ${item.resume}`);
  }
  tell(tty, `\r\n[Agent Deck] This session moved to herdr (pane ${started.pane}) and goes on there.\r\n`);
  return started;
}
