import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { herdr, herdrAgents, herdrSockets } from "./herdr.ts";

/**
 * Starting a session from the page (a phone, say), in herdr: a new tab in the workspace of that
 * folder (a new workspace if it has none), or a new git worktree on a branch; then Claude Code or
 * Codex in it, with the model and effort chosen, and the first prompt. Claude Code gets its
 * session id from here, so the page knows which session it is before it shows up.
 */

export type StartAgent = "claude" | "codex";

export interface StartRequest {
  /** The folder to work in (a repository of a listed session). */
  dir: string;
  agent: StartAgent;
  model?: string;
  effort?: string;
  /** Start in a new git worktree on this branch. */
  branch?: string;
  prompt: string;
  /** Files sent for it (paths), named in the prompt. */
  files?: string[];
  /** Open this session again (its id) instead of a new one: the same conversation. */
  resume?: string;
  /** The tab's name; the prompt's first line by default. */
  label?: string;
}

export interface Started {
  pane: string;
  socket: string;
  /** Where it runs: the folder, or the new worktree. */
  dir: string;
  /** Claude Code's session ("claude:<id>"), known from the start; a resumed one keeps its own. */
  key?: string;
}

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODEL = /^[\w.:/@-]{1,80}$/;
const BRANCH = /^(?![-/.])(?!.*\.\.)[\w./-]{1,100}$/;
const SESSION = /^[0-9A-Za-z][\w-]{7,63}$/;

/** The agent's own command-line flags for the model, effort and (Claude Code) session id. */
export function agentArgs(r: Pick<StartRequest, "agent" | "model" | "effort" | "resume">, sessionId?: string): string[] {
  // Claude Code keeps the session id it resumes (unless told --fork-session); Codex has a subcommand.
  if (r.resume) return r.agent === "claude" ? ["--resume", r.resume] : ["resume", r.resume];
  const args: string[] = [];
  if (r.agent === "claude") {
    if (sessionId) args.push("--session-id", sessionId);
    if (r.model) args.push("--model", r.model);
    if (r.effort) args.push("--effort", r.effort);
  } else {
    if (r.model) args.push("-m", r.model);
    if (r.effort) args.push("-c", `model_reasoning_effort="${r.effort}"`);
  }
  return args;
}

export function checkStart(r: StartRequest): void {
  if (r.agent !== "claude" && r.agent !== "codex") throw new Error("Pick Claude Code or Codex.");
  if (r.model && !MODEL.test(r.model)) throw new Error("That does not look like a model name.");
  if (r.effort && !EFFORTS.includes(r.effort)) throw new Error(`Effort is one of ${EFFORTS.join(", ")}.`);
  if (r.branch && !BRANCH.test(r.branch)) throw new Error("That is not a branch name git takes.");
  if (r.prompt.length > 20_000) throw new Error("The prompt is too long (up to 20,000 characters).");
  if (r.resume !== undefined && !SESSION.test(r.resume)) throw new Error("That is not a session id.");
}

/** The herdr session to start in: where this folder's agents run, else the first one found. */
export function socketFor(dir: string): string | undefined {
  const agents = herdrAgents();
  const here = agents.find((a) => a.cwd === dir) ?? agents.find((a) => !!a.cwd && a.cwd.startsWith(dir + "/"));
  return here?.socket ?? herdrSockets()[0] ?? agents[0]?.socket;
}

interface Created {
  root_pane?: { pane_id?: string; cwd?: string };
  worktree?: { path?: string };
  workspaces?: { workspace_id?: string; worktree?: { checkout_path?: string; repo_root?: string } | null }[];
}

const paneOf = (r: Created): string => {
  const pane = r.root_pane?.pane_id;
  if (!pane) throw new Error("herdr did not say which pane it opened.");
  return pane;
};

/** Where a session is to run: a herdr session, a pane in it, and the folder. */
export interface Place {
  socket: string;
  pane: string;
  dir: string;
}

/** A new pane for a session: a tab in its folder's workspace, a new workspace, or a new worktree. */
export async function openPane(r: StartRequest): Promise<Place> {
  checkStart(r);
  const socket = socketFor(r.dir);
  if (!socket) throw new Error("herdr is not running here: start herdr first.");
  const label = (r.label?.trim() || r.prompt.trim().split("\n")[0]!).slice(0, 32) || basename(r.dir);
  let pane: string;
  let dir = r.dir;
  if (r.branch) {
    const w = (await herdr(socket, ["worktree", "create", "--cwd", r.dir, "--branch", r.branch, "--label", label, "--no-focus"], 60_000)) as Created;
    pane = paneOf(w);
    dir = w.worktree?.path ?? w.root_pane?.cwd ?? r.dir;
  } else {
    const list = (await herdr(socket, ["workspace", "list"])) as Created;
    const ws =
      list.workspaces?.find((w) => w.worktree && (w.worktree.checkout_path === r.dir || w.worktree.repo_root === r.dir))?.workspace_id ??
      (herdrAgents().find((a) => a.socket === socket && a.cwd === r.dir) ?? herdrAgents().find((a) => a.socket === socket && !!a.cwd && a.cwd.startsWith(r.dir + "/")))?.workspace;
    const made = ws
      ? ((await herdr(socket, ["tab", "create", "--workspace", ws, "--cwd", r.dir, "--label", label, "--no-focus"])) as Created)
      : ((await herdr(socket, ["workspace", "create", "--cwd", r.dir, "--label", basename(r.dir), "--no-focus"])) as Created);
    pane = paneOf(made);
  }
  return { socket, pane, dir };
}

/** The agent in a pane opened for it, and its first prompt. */
export async function startIn(at: Place, r: StartRequest): Promise<Started> {
  const sessionId = r.agent === "claude" && !r.resume ? randomUUID() : undefined;
  const name = `${basename(at.dir)}-${randomUUID().slice(0, 4)}`;
  await herdr(at.socket, ["agent", "start", name, "--kind", r.agent, "--pane", at.pane, "--timeout", "60000", "--", ...agentArgs(r, sessionId)], 75_000);
  const files = r.files ?? [];
  const text = files.length ? `${r.prompt}\n\nFiles I sent you:\n${files.map((f) => `- ${f}`).join("\n")}`.trim() : r.prompt.trim();
  if (text) await herdr(at.socket, ["agent", "prompt", at.pane, text], 15_000);
  const key = r.resume ? `${r.agent}:${r.resume}` : sessionId && `claude:${sessionId}`;
  return { ...at, ...(key && { key }) };
}

export async function startSession(r: StartRequest): Promise<Started> {
  return startIn(await openPane(r), r);
}

/** Closes a pane that was opened for nothing. */
export const closePane = (at: Place) => herdr(at.socket, ["pane", "close", at.pane]).catch(() => undefined);
