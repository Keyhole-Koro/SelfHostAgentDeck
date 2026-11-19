import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InboxItem } from "./inbox.ts";
import { env } from "./env.ts";

/**
 * herdr (https://herdr.dev), a terminal workspace manager for coding agents, knows which pane each
 * agent runs in and whether it is idle, working, or blocked on an approval or a question. With it
 * the page can show that state (Codex's approval prompts included) and, when you click, focus the
 * pane, send the agent a prompt or a key, or show its screen.
 *
 * Everything goes through the herdr CLI. Each herdr session has its own socket, chosen with
 * HERDR_SOCKET_PATH; sessions run inside herdr carry theirs in their environment.
 */

export interface HerdrAgent {
  pane: string;
  socket: string;
  /** idle, working, blocked, done or unknown. */
  status: string;
  agent?: string;
  /** The agent's session id or transcript path, as herdr's integration reports it. */
  session?: string;
  name?: string;
  /** The agent's working directory and its terminal's title (Codex puts the thread's name there). */
  cwd?: string;
  title?: string;
  /** The herdr workspace its pane is in. */
  workspace?: string;
}

interface AgentInfo {
  pane_id?: string;
  agent_status?: string;
  agent?: string | null;
  name?: string | null;
  agent_session?: { agent?: string; value?: string } | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  terminal_title_stripped?: string | null;
  workspace_id?: string | null;
}

const bin = () => env("HERDR") || "herdr";

/**
 * Runs a herdr command against one herdr session; resolves to its `result`. herdr answers in JSON,
 * its errors in JSON on stderr; `agent read` prints the screen as it is (older herdr wrapped it in
 * JSON too), which `text` takes as `{ text }`.
 */
export function herdr(socket: string, args: string[], timeout = 8000, text = false): Promise<Record<string, unknown>> {
  type Reply = { result?: Record<string, unknown>; error?: { code?: string; message?: string } };
  const reply = (s: string): Reply | undefined => {
    try {
      const o = JSON.parse(s) as unknown;
      return o && typeof o === "object" && ("result" in o || "error" in o) ? (o as Reply) : undefined;
    } catch {
      return undefined;
    }
  };
  return new Promise((resolve, reject) => {
    execFile(bin(), args, { env: { ...process.env, HERDR_SOCKET_PATH: socket }, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = reply(stdout) ?? reply(stderr);
      if (out?.error) return reject(Object.assign(new Error(out.error.message || out.error.code || "herdr error"), { code: out.error.code }));
      if (err) return reject(err);
      if (out) return resolve(out.result ?? {});
      if (text) return resolve({ text: stdout });
      reject(new Error("herdr printed no JSON"));
    });
  });
}

/** Sockets of the herdr sessions on this computer. */
export function herdrSockets(): string[] {
  const dir = join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr");
  const out: string[] = [];
  if (existsSync(join(dir, "herdr.sock"))) out.push(join(dir, "herdr.sock"));
  try {
    for (const name of readdirSync(join(dir, "sessions"))) {
      const sock = join(dir, "sessions", name, "herdr.sock");
      if (existsSync(sock)) out.push(sock);
    }
  } catch {
    // no named sessions
  }
  return out;
}

let cache: { at: number; agents: HerdrAgent[] } | undefined;
let refreshing: Promise<void> | undefined;
const TTL = 4000;

/** Asks every herdr session for its agents now. */
export async function refreshHerdr(sockets: string[]): Promise<HerdrAgent[]> {
  const lists = await Promise.all(
    [...new Set(sockets)].map((socket) =>
      herdr(socket, ["agent", "list"], 4000)
        .then((r) => ((r["agents"] as AgentInfo[] | undefined) ?? []).filter((a) => a.pane_id).map((a) => toAgent(a, socket)))
        .catch(() => [] as HerdrAgent[]),
    ),
  );
  cache = { at: Date.now(), agents: lists.flat() };
  return cache.agents;
}

function toAgent(a: AgentInfo, socket: string): HerdrAgent {
  const agent: HerdrAgent = { pane: a.pane_id!, socket, status: a.agent_status ?? "unknown" };
  const kind = a.agent ?? a.agent_session?.agent;
  if (kind) agent.agent = kind;
  if (a.agent_session?.value) agent.session = a.agent_session.value;
  if (a.name) agent.name = a.name;
  const cwd = a.foreground_cwd ?? a.cwd;
  if (cwd) agent.cwd = cwd;
  if (a.terminal_title_stripped) agent.title = a.terminal_title_stripped;
  if (a.workspace_id) agent.workspace = a.workspace_id;
  return agent;
}

/** Sockets of herdr sessions the sessions' processes named; kept for the calls that name none. */
let extra: string[] = [];

/** The agents herdr knows, as last seen; refreshed in the background when older than a few seconds. */
export function herdrAgents(extraSockets?: string[]): HerdrAgent[] {
  if (extraSockets) extra = extraSockets;
  if ((!cache || Date.now() - cache.at > TTL) && !refreshing) {
    refreshing = refreshHerdr([...herdrSockets(), ...extra])
      .then(() => undefined)
      .finally(() => (refreshing = undefined));
  }
  return cache?.agents ?? [];
}

/**
 * The pane each listed session runs in: from its process's environment, herdr's own session ids,
 * or, for Codex when herdr has no id for it, the one Codex pane in the session's folder whose
 * terminal title carries the thread's name.
 */
export function matchPanes(items: InboxItem[], agents: HerdrAgent[]): Map<string, HerdrAgent> {
  const out = new Map<string, HerdrAgent>();
  for (const i of items) {
    const t = i.terminal;
    const ours = (x: HerdrAgent) => !!x.session && (x.session === i.id || x.session.endsWith(`${i.id}.jsonl`));
    let a = t ? agents.find((x) => x.pane === t.herdrPane && x.socket === t.herdrSocket) : undefined;
    // The environment is inherited, so it can name a pane the session is not in: a background
    // session started from a pane keeps that pane's, and a pane's Claude Code can park its own
    // session to show another. When herdr knows which session its pane shows, that settles it.
    const taken = !!a && !!a.session && !ours(a);
    if (taken) a = undefined;
    a ??= agents.find(ours);
    if (!a && i.agent === "codex") {
      const here = agents.filter((x) => x.agent === "codex" && !x.session && !!i.cwd && x.cwd === i.cwd);
      const named = here.filter((x) => !!x.title && (x.title.startsWith(i.name) || (!!i.title && x.title.startsWith(i.title))));
      a = named.length === 1 ? named[0] : undefined;
    }
    if (!a && t && !taken) a = { pane: t.herdrPane, socket: t.herdrSocket, status: "unknown" };
    if (a) out.set(i.key, a);
  }
  return out;
}

/** Keys the page may send: enough to answer a prompt, nothing that edits text on its own. */
export const KEYS = new Set(["enter", "esc", "up", "down", "left", "right", "tab", "space", "y", "n", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

export const focus = (a: HerdrAgent) => herdr(a.socket, ["agent", "focus", a.pane]);
export const prompt = (a: HerdrAgent, text: string) => herdr(a.socket, ["agent", "prompt", a.pane, text], 15_000);
export function sendKeys(a: HerdrAgent, keys: string[]): Promise<Record<string, unknown>> {
  const bad = keys.filter((k) => !KEYS.has(k));
  if (!keys.length || bad.length) return Promise.reject(new Error(`Keys not allowed: ${bad.join(", ") || "(none)"}`));
  return herdr(a.socket, ["agent", "send-keys", a.pane, ...keys]);
}
export async function screen(a: HerdrAgent): Promise<string> {
  const r = await herdr(a.socket, ["agent", "read", a.pane, "--source", "visible"], 8000, true);
  return String((r["read"] as { text?: string } | undefined)?.text ?? r["text"] ?? "");
}
