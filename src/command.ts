import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";

/**
 * A shell command typed on the page, run in a session's folder by your login shell as it would
 * run in a terminal there: not through the agent, so nothing of it goes into the conversation.
 * Its output (both streams, as a terminal shows them) comes back while it runs, a line of JSON at
 * a time: `{"o": text}`, and last `{"done": true, code, signal, ms, cut, timedOut}`. Nothing is
 * read from you (a command that asks gets an end of input), it stops after `timeout`, and it stops
 * when the page stops waiting for it: the Stop button, or the page closing.
 */

export const COMMAND_TIMEOUT = 10 * 60_000;
/** Output past this is not sent (the command still runs to its end). */
export const COMMAND_MAX_OUTPUT = 2 * 1024 * 1024;
export const COMMAND_MAX_LENGTH = 4000;
const AT_ONCE = 8;
/** Bytes now and then, so a quiet command does not look like a dead connection to a proxy. */
const KEEP_ALIVE = 15_000;

/** Colors and cursor moves: a terminal's, not a page's. */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]/g;
export const plainText = (s: string) => s.replace(ANSI, "");

let running = 0;

export class CommandError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Whether a command can run, checked before anything is sent back. */
export function checkCommand(command: string, cwd: string | undefined): string {
  if (!command.trim()) throw new CommandError("Type a command.", 400);
  if (command.length > COMMAND_MAX_LENGTH) throw new CommandError("That command is too long.", 400);
  if (!cwd || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new CommandError("Its folder is no longer there.", 409);
  if (running >= AT_ONCE) throw new CommandError(`${AT_ONCE} commands are running already; stop one first.`, 429);
  return cwd;
}

export function runCommand(command: string, cwd: string, res: ServerResponse, timeout = COMMAND_TIMEOUT): void {
  const started = Date.now();
  // Both streams into one pipe, so they come in the order a terminal shows them.
  const child = spawn("/bin/sh", ["-c", 'exec 2>&1; exec "${SHELL:-/bin/bash}" -lc "$1"', "sh", command], {
    cwd,
    detached: true, // a process group of its own, to stop what it started too
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TERM: "dumb", NO_COLOR: "1", FORCE_COLOR: "0", PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
  });
  running++;
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", "x-content-type-options": "nosniff" });
  const line = (o: object) => void (!res.writableEnded && res.write(JSON.stringify(o) + "\n"));
  line({ started: true, cwd });

  let sent = 0;
  let cut = false;
  let timedOut = false;
  let over = false;
  const take = (decoder: StringDecoder) => (chunk: Buffer) => {
    if (cut) return;
    let text = plainText(decoder.write(chunk));
    if (sent + text.length > COMMAND_MAX_OUTPUT) {
      text = text.slice(0, COMMAND_MAX_OUTPUT - sent);
      cut = true;
    }
    sent += text.length;
    if (text) line({ o: text });
  };
  child.stdout!.on("data", take(new StringDecoder("utf8")));
  child.stderr!.on("data", take(new StringDecoder("utf8")));

  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, s);
    } catch {
      // gone already
    }
  };
  const stop = () => {
    if (over) return;
    signal("SIGTERM");
    setTimeout(() => signal("SIGKILL"), 3000).unref();
  };
  const timer = setTimeout(() => ((timedOut = true), stop()), timeout);
  const alive = setInterval(() => line({}), KEEP_ALIVE);
  // The page stopped waiting: the Stop button, or it closed.
  res.on("close", stop);

  const finish = (code: number | null, sig: NodeJS.Signals | null, error?: string) => {
    if (over) return;
    over = true;
    running--;
    clearTimeout(timer);
    clearInterval(alive);
    line({ done: true, code, signal: sig, ms: Date.now() - started, cut, timedOut, ...(error && { error }) });
    res.end();
  };
  child.on("error", (e) => finish(null, null, e.message));
  child.on("close", (code, sig) => finish(code, sig));
}
