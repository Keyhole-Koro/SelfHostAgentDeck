import { closeSync, existsSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { sessionKey, type Agent } from "./types.ts";

/**
 * `agent-deck inbox`: the running Claude Code and Codex sessions that wait on you, across every
 * repository, on one screen.
 *
 * Claude Code keeps a record per running process in ~/.claude/sessions/<pid>.json with a status
 * (busy / idle / waiting) and, while waiting, what for ("approve Bash: npm test", "input needed").
 * Background sessions also have ~/.claude/jobs/<id>/state.json, which says when one is blocked and
 * what it needs, even while no process runs. These files are Claude Code's own and undocumented,
 * so everything here is read defensively.
 *
 * Transcripts add the rest: the session's title, your last prompt, the recap Claude Code writes
 * while you are away, the last reply, unanswered questions, its task list, background commands
 * still running, pull requests it opened and how full its context is. They are read
 * incrementally: the first look reads the last few MB, later looks only what was appended.
 *
 * Codex holds ~/.codex/thread-writer-locks/<thread>.lock while a thread is loaded; the rollout
 * says whether a turn is running, the last reply, the context used and the account's rate limits.
 * Codex does not log approval prompts; a command that has been running a while without output is
 * reported as one that may be waiting for approval.
 */

export type InboxState = "needs-answer" | "your-turn" | "working" | "stale";

export interface InboxQuestion {
  question: string;
  options: string[];
}

export interface InboxTask {
  id: string;
  subject: string;
  /** pending, in_progress or completed. */
  status: string;
  activeForm?: string;
}

export interface InboxBackground {
  id: string;
  kind: "command" | "monitor";
  /** The command's description, or the command itself. */
  command: string;
  since: number;
}

export interface InboxPr {
  url: string;
  number: number;
  repo: string;
}

/** A page the session published (with the `artifact` tool or CLI, or as a claude.ai artifact). */
export interface InboxPage {
  url: string;
  title?: string;
  at: number;
}

export interface InboxContext {
  /** Tokens the last request sent (the context in use); unknown right after a compaction. */
  tokens?: number;
  /** The model's context window, when the agent records it (Codex). */
  window?: number;
  /** How often the conversation was compacted, and at how many tokens the last time. */
  compactions: number;
  lastCompactTokens?: number;
}

export interface InboxTerminal {
  herdrPane: string;
  herdrSocket: string;
}

export interface InboxItem {
  key: string;
  agent: Agent;
  id: string;
  /** Claude Code's session name, or the Codex thread name. */
  name: string;
  /** What the session works on (Claude Code's title for it). */
  title?: string;
  cwd: string | undefined;
  state: InboxState;
  /** What the session waits for: "approve Bash: npm test", "input needed", "interrupted". */
  reason?: string;
  /** Unanswered AskUserQuestion questions. */
  questions?: InboxQuestion[];
  /** The session's last reply. */
  lastMessage?: string;
  /** The model of its last reply (Claude Code) or turn (Codex). */
  model?: string;
  /** Claude Code in plan mode: the plan it asks you to approve. */
  plan?: string;
  /** The last reply ends with a question. */
  asks?: boolean;
  /** Your last prompt to it. */
  lastPrompt?: string;
  /** Claude Code's recap of the turn, written while you were away (only if you have not replied since). */
  awaySummary?: string;
  tasks?: InboxTask[];
  /** Background commands and monitors still running. */
  background?: InboxBackground[];
  prs?: InboxPr[];
  /** Pages it published, the latest last. */
  pages?: InboxPage[];
  context?: InboxContext;
  /** Codex: a command the turn is still waiting on. */
  inFlight?: { command: string; since: number };
  /** Resident memory of the process, in bytes (Linux). */
  memory?: number;
  /** When the session entered this state, as far as known (ms). */
  since: number;
  pid?: number;
  /** Claude Code: "interactive" or "bg". */
  kind?: string;
  /** Claude Code background session id (for `claude attach`). */
  jobId?: string;
  /** Where the session runs, when a terminal multiplexer says so. */
  terminal?: InboxTerminal;
  /** Outside herdr: the terminal app it runs in ("Ptyxis", "tmux", "VS Code"), when known. */
  runsIn?: string;
  /** How to get back to the session. */
  resume: string;
  /** Put off with "Later" or "Done" (see holds.ts) until the session moves on. */
  hold?: { kind: "later" | "done"; until?: number };
}

export interface RateWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number; // ms
}

export interface CodexLimits {
  primary?: RateWindow;
  secondary?: RateWindow;
  at: number;
}

export interface Inbox {
  generatedAt: number;
  /** "your-turn" sessions untouched for longer than this are "stale" (ms). */
  staleAfter: number;
  items: InboxItem[];
  codexLimits?: CodexLimits;
}

export interface InboxOptions {
  now?: number;
  staleAfter?: number;
  claudeHome?: string;
  codexHome?: string;
  /** Skip Claude transcripts (states and reasons only): for status lines, which must be quick. */
  light?: boolean;
}

const DAY = 864e5;
const MAX_MESSAGE = 4000;
const MAX_PROMPT = 1000;
/** Pull requests listed per session (the most recent). */
const MAX_PRS = 6;
/** Published pages listed per session (the most recent). */
const MAX_PAGES = 8;
/** How far back the first look at a transcript goes. */
const FIRST_READ = 2 * 1024 * 1024;
/** A Codex command running this long without output may be waiting for approval. */
const APPROVAL_AFTER = 30_000;

export function claudeHome(): string {
  return process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude");
}

export function codexHome(): string {
  return process.env["CODEX_HOME"] || join(homedir(), ".codex");
}

const STATE_ORDER: Record<InboxState, number> = { "needs-answer": 0, "your-turn": 1, working: 2, stale: 3 };

export function readInbox(opts: InboxOptions = {}): Inbox {
  const now = opts.now ?? Date.now();
  const staleAfter = opts.staleAfter ?? DAY;
  const claude = claudeItems(opts.claudeHome ?? claudeHome(), now, staleAfter, !!opts.light);
  const codex = codexItems(opts.codexHome ?? codexHome(), now);
  const items = [...claude, ...codex.items];
  for (const item of items) {
    if (item.state === "your-turn" && now - item.since > staleAfter) item.state = "stale";
    if (item.lastMessage && (item.state === "your-turn" || item.state === "stale") && endsWithQuestion(item.lastMessage)) item.asks = true;
  }
  items.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.since - a.since);
  const inbox: Inbox = { generatedAt: now, staleAfter, items };
  if (codex.limits) inbox.codexLimits = codex.limits;
  return inbox;
}

/**
 * Whether a reply ends by asking something: its last paragraph has a question mark, or a Japanese
 * question that ends in "か。" ("A はこのまま消してよいですか。B は…").
 */
export function endsWithQuestion(text: string): boolean {
  const last = text.trim().split(/\n\s*\n/).pop() ?? "";
  return /[?？]/.test(last) || /(です|ます|でしょう|ましょう|よい|いい|良い)か[。．]/.test(last);
}

function clip(text: string, max = MAX_MESSAGE): string {
  const t = text.trim();
  return t.length > max ? "…" + t.slice(-max) : t;
}

function head(text: string, max = MAX_PROMPT): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// ---------------------------------------------------------------- incremental reading

interface Cursor<S> {
  pos: number;
  ino: number;
  /** The first chunk started mid-file: its first line is partial. */
  skipFirst: boolean;
  state: S;
}

/**
 * Feeds the complete lines appended to `file` since the last call to `feed`, and returns the
 * state they built. The first call starts `firstRead` bytes before the end.
 */
function follow<S>(cache: Map<string, Cursor<S>>, file: string, init: () => S, feed: (state: S, line: string) => void, firstRead = FIRST_READ): S | undefined {
  let size: number;
  let ino: number;
  try {
    ({ size, ino } = statSync(file));
  } catch {
    cache.delete(file);
    return undefined;
  }
  let c = cache.get(file);
  if (!c || size < c.pos || ino !== c.ino) {
    const pos = Math.max(0, size - firstRead);
    c = { pos, ino, skipFirst: pos > 0, state: init() };
    cache.set(file, c);
  }
  if (size <= c.pos) return c.state;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(size - c.pos);
    const n = readSync(fd, buf, 0, buf.length, c.pos);
    const end = buf.subarray(0, n).lastIndexOf(10);
    if (end < 0) return c.state; // no complete line yet
    const lines = buf.toString("utf8", 0, end).split("\n");
    if (c.skipFirst) lines.shift();
    c.skipFirst = false;
    c.pos += end + 1;
    for (const line of lines) if (line) feed(c.state, line);
  } catch {
    // unreadable right now; try again next time
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return c.state;
}

// ---------------------------------------------------------------- Claude Code

interface ClaudeRecord {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  name?: string;
  kind?: string;
  status?: string;
  waitingFor?: string;
  statusUpdatedAt?: number;
  updatedAt?: number;
  startedAt?: number;
  procStart?: string;
  spare?: boolean;
}

interface JobState {
  state?: string;
  detail?: string;
  needs?: string;
  name?: string;
  sessionId?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  daemonShort?: string;
  children?: { href?: string; kind?: string }[] | null;
}

/** Whether `pid` is still the process that wrote the record (pids are reused). */
function alive(pid: number, procStart: string | undefined): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (procStart && process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 22 is the start time; fields after the ")" of the command name start at field 3.
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === procStart;
    } catch {
      return true;
    }
  }
  return true;
}

/** Resident memory of a process in bytes (Linux only). */
function memoryOf(pid: number): number | undefined {
  try {
    const kb = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
    return kb ? Number(kb) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

/** The herdr pane a process runs in, from its environment (Linux only). */
export function terminalOf(pid: number): InboxTerminal | undefined {
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    const get = (k: string) => env.find((e) => e.startsWith(k + "="))?.slice(k.length + 1);
    const herdrPane = get("HERDR_PANE_ID");
    const herdrSocket = get("HERDR_SOCKET_PATH");
    return herdrPane && herdrSocket ? { herdrPane, herdrSocket } : undefined;
  } catch {
    return undefined;
  }
}

/** Terminal apps, by the name of their process (/proc/<pid>/comm keeps 15 characters). */
const TERMINAL_APPS: [RegExp, string][] = [
  [/^ptyxis/, "Ptyxis"],
  [/^gnome-terminal/, "GNOME Terminal"],
  [/^kgx$/, "Console"],
  [/^konsole$/, "Konsole"],
  [/^kitty$/, "kitty"],
  [/^wezterm/, "WezTerm"],
  [/^alacritty$/i, "Alacritty"],
  [/^ghostty$/, "Ghostty"],
  [/^foot(client)?$/, "foot"],
  [/^xterm$/, "xterm"],
  [/^tilix$/, "Tilix"],
  [/^terminator$/, "Terminator"],
  [/^tmux/, "tmux"],
  [/^zellij$/, "Zellij"],
  [/^screen$/i, "screen"],
  [/^code(-oss)?$/, "VS Code"],
  [/^cursor$/, "Cursor"],
  [/^sshd/, "an SSH login"],
];
const apps = new Map<number, string | undefined>();

/** The terminal app a process runs in, from the names of its parents (Linux only). */
export function terminalApp(pid: number): string | undefined {
  if (apps.has(pid)) return apps.get(pid);
  let app: string | undefined;
  for (let p = pid, n = 0; p > 1 && n < 16; n++) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${p}/stat`, "utf8");
    } catch {
      break;
    }
    const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
    app = p === pid ? undefined : TERMINAL_APPS.find(([re]) => re.test(comm))?.[1];
    if (app) break;
    p = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  }
  apps.set(pid, app);
  if (apps.size > 500) apps.delete(apps.keys().next().value!);
  return app;
}

/** The command line of a process, as one string (Linux only). */
export function commandOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
  } catch {
    return "";
  }
}

/** Where a running session's process is: its herdr pane, or else the terminal app it runs in. */
function placeProcess(item: InboxItem, pid: number): void {
  const memory = memoryOf(pid);
  if (memory) item.memory = memory;
  const terminal = terminalOf(pid);
  if (terminal) item.terminal = terminal;
  else {
    const app = terminalApp(pid);
    if (app) item.runsIn = app;
  }
}

const transcriptCache = new Map<string, string>();

function claudeTranscript(home: string, sessionId: string): string | undefined {
  const key = `${home}\0${sessionId}`;
  const cached = transcriptCache.get(key);
  if (cached && existsSync(cached)) return cached;
  const root = join(home, "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const file = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) {
      transcriptCache.set(key, file);
      return file;
    }
  }
  return undefined;
}

/** The latest title in the last 64 KB of a transcript (Claude Code repeats it every turn). */
function quickTitle(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = statSync(file).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    const at = text.lastIndexOf('"aiTitle":"');
    if (at < 0) return undefined;
    const m = /^"aiTitle":("(?:[^"\\]|\\.)*")/.exec(text.slice(at));
    return m ? (JSON.parse(m[1]!) as string) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

interface Block {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

interface ClaudeLine {
  type?: string;
  cwd?: string;
  subtype?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  aiTitle?: string;
  agentName?: string;
  lastPrompt?: string;
  content?: unknown;
  prNumber?: number | string;
  prUrl?: string;
  prRepository?: string;
  compactMetadata?: { preTokens?: number };
  toolUseResult?: Record<string, unknown>;
  message?: { content?: unknown; usage?: Record<string, number>; model?: string };
}

/** What a Claude transcript says so far. */
interface ClaudeAcc {
  lastMessage?: string;
  model?: string;
  /** Tool calls still without a result, by id. */
  pending: Map<string, Block>;
  title?: string;
  agentName?: string;
  lastPrompt?: string;
  awaySummary?: string;
  prs: Map<string, InboxPr>;
  tasks: Map<string, InboxTask>;
  /** TaskCreate calls waiting for the id their result assigns. */
  creates: Map<string, { subject: string; activeForm?: string }>;
  /** Background commands waiting for the id their result assigns. */
  starting: Map<string, Omit<InboxBackground, "id">>;
  background: Map<string, InboxBackground>;
  tokens?: number;
  compactions: number;
  lastCompactTokens?: number;
  /** Files the session wrote with its edit tools (absolute path → when). */
  edited: Map<string, number>;
  /** Publish calls waiting for the URL their result tells, and the pages published. */
  publishing: Map<string, { title?: string }>;
  pages: Map<string, InboxPage>;
  /** The last turn has ended (and nothing came after it). */
  turnOver?: boolean;
}

const claudeCursors = new Map<string, Cursor<ClaudeAcc>>();

const newClaudeAcc = (): ClaudeAcc => ({ pending: new Map(), prs: new Map(), tasks: new Map(), creates: new Map(), starting: new Map(), background: new Map(), compactions: 0, edited: new Map(), publishing: new Map(), pages: new Map() });

/**
 * The files a session wrote, for spotting files two sessions share (conflicts.ts). Kept off the
 * item's enumerable fields: it can be long, and the page does not need it.
 */
export function editedFiles(item: InboxItem): Map<string, number> {
  return (item as InboxItem & { [EDITED]?: Map<string, number> })[EDITED] ?? new Map();
}
const EDITED = Symbol("edited");
function setEdited(item: InboxItem, files: Map<string, number>): void {
  Object.defineProperty(item, EDITED, { value: files, enumerable: false });
}

/** The session's transcript (Claude Code) or rollout (Codex), for reading its conversation. */
export function transcriptOf(item: InboxItem): string | undefined {
  return (item as InboxItem & { [TRANSCRIPT]?: string })[TRANSCRIPT];
}
const TRANSCRIPT = Symbol("transcript");
function setTranscript(item: InboxItem, file: string): void {
  Object.defineProperty(item, TRANSCRIPT, { value: file, enumerable: false });
}

/** A call that publishes a page: the `artifact` MCP tool or CLI, or Claude's own Artifact tool. */
function publishTitle(name: string, input: Record<string, unknown>, command = ""): { title?: string } | undefined {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const tool = (/artifact/i.test(name) && /publish/i.test(name)) || (name === "Artifact" && (!s("action") || s("action") === "publish"));
  const cli = /\bartifact\s+publish\b/.test(command);
  if (!tool && !cli) return undefined;
  const title = s("title") || /--title[ =](?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command)?.slice(1).find(Boolean) || (s("file_path") ? basename(s("file_path")) : "");
  return title ? { title } : {};
}

/** The page's URL in a publish result: the CLI's JSON, or "Published: https://…". */
function publishedUrl(text: string): string | undefined {
  try {
    const j = JSON.parse(text) as { url?: unknown };
    if (typeof j.url === "string") return j.url;
  } catch {
    // not JSON
  }
  return /https?:\/\/[^\s"'<>)\]]+/.exec(text)?.[0];
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return (content as { text?: unknown }[]).map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  return "";
}

/** Lines worth parsing: most of a transcript is tool output, file snapshots and request records. */
const CLAUDE_TYPES = /"type":"(assistant|user|ai-title|agent-name|last-prompt|system|pr-link|queue-operation)"/;

/** Prompts you typed, as opposed to harness text (command wrappers, notifications, reminders). */
function promptText(content: unknown): string | undefined {
  const text = typeof content === "string" ? content : Array.isArray(content) ? (content as Block[]).filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n") : undefined;
  const t = text?.trim();
  if (!t || t.startsWith("<") || t.startsWith("[Request interrupted")) return undefined;
  return t;
}

/** Ends background tasks named in a <task-notification> (they completed, failed or were stopped). */
function finishTasks(acc: ClaudeAcc, text: string): void {
  for (const m of text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) acc.background.delete(m[1]!.trim());
}

function feedClaude(acc: ClaudeAcc, raw: string): void {
  // The "type" key can come after the message itself, tens of KB into the line.
  if (!CLAUDE_TYPES.test(raw)) return;
  let line: ClaudeLine;
  try {
    line = JSON.parse(raw) as ClaudeLine;
  } catch {
    return;
  }
  if (line.isSidechain) return;
  const at = line.timestamp ? Date.parse(line.timestamp) : Date.now();
  switch (line.type) {
    case "ai-title":
      if (line.aiTitle) acc.title = line.aiTitle;
      return;
    case "agent-name":
      if (line.agentName) acc.agentName = line.agentName;
      return;
    case "last-prompt":
      if (line.lastPrompt && head(line.lastPrompt) !== acc.lastPrompt) {
        acc.lastPrompt = head(line.lastPrompt);
        acc.awaySummary = undefined; // a new prompt: the recap was of the turn before it
      }
      return;
    case "pr-link":
      if (line.prUrl) acc.prs.set(line.prUrl, { url: line.prUrl, number: Number(line.prNumber) || 0, repo: line.prRepository ?? "" });
      return;
    case "queue-operation":
      if (typeof line.content === "string" && line.content.includes("<task-notification>")) finishTasks(acc, line.content);
      return;
    case "system":
      if (line.subtype === "turn_duration" || line.subtype === "stop_hook_summary") acc.turnOver = true;
      if (line.subtype === "away_summary" && typeof line.content === "string") acc.awaySummary = line.content.trim();
      if (line.subtype === "compact_boundary") {
        acc.compactions++;
        if (line.compactMetadata?.preTokens) acc.lastCompactTokens = line.compactMetadata.preTokens;
        acc.tokens = undefined; // the next request tells the size after compaction
      }
      return;
    case "user": {
      acc.turnOver = false;
      const content = line.message?.content;
      const text = typeof content === "string" ? content : "";
      if (text.includes("<task-notification>")) finishTasks(acc, text);
      if (Array.isArray(content)) {
        for (const b of content as Block[]) {
          if (b?.type === "text" && b.text?.includes("<task-notification>")) finishTasks(acc, b.text);
          if (b?.type !== "tool_result" || !b.tool_use_id) continue;
          acc.pending.delete(b.tool_use_id);
          const publish = acc.publishing.get(b.tool_use_id);
          if (publish) {
            acc.publishing.delete(b.tool_use_id);
            const url = publishedUrl(resultText(b.content));
            if (url) acc.pages.set(url, { url, ...publish, at });
          }
          const result = line.toolUseResult ?? {};
          const create = acc.creates.get(b.tool_use_id);
          if (create) {
            acc.creates.delete(b.tool_use_id);
            const id = (result["task"] as { id?: unknown } | undefined)?.id;
            if (id !== undefined) acc.tasks.set(String(id), { id: String(id), status: "pending", ...create });
          }
          const start = acc.starting.get(b.tool_use_id);
          if (start) {
            acc.starting.delete(b.tool_use_id);
            const id = result["backgroundTaskId"] ?? result["taskId"];
            if (typeof id === "string") acc.background.set(id, { id, ...start });
          }
        }
      }
      if (!line.isMeta && promptText(content)) acc.awaySummary = undefined;
      return;
    }
    case "assistant": {
      acc.turnOver = false;
      const content = line.message?.content;
      if (!Array.isArray(content)) return;
      for (const b of content as Block[]) {
        if (b?.type === "text" && b.text?.trim()) acc.lastMessage = b.text;
        if (b?.type !== "tool_use" || !b.id) continue;
        acc.pending.set(b.id, b);
        const input = b.input ?? {};
        const str = (v: unknown) => (typeof v === "string" ? v : "");
        const publish = publishTitle(b.name ?? "", input, b.name === "Bash" ? str(input["command"]) : "");
        if (publish) acc.publishing.set(b.id, publish);
        switch (b.name) {
          case "Edit":
          case "MultiEdit":
          case "Write":
          case "NotebookEdit": {
            const p = str(input["file_path"]) || str(input["notebook_path"]);
            if (p) acc.edited.set(isAbsolute(p) ? p : resolve(line.cwd ?? "/", p), at);
            break;
          }
          case "TaskCreate":
            acc.creates.set(b.id, { subject: str(input["subject"]) || "(task)", ...(str(input["activeForm"]) && { activeForm: str(input["activeForm"]) }) });
            break;
          case "TaskUpdate": {
            const id = String(input["taskId"] ?? "");
            const task = acc.tasks.get(id) ?? { id, subject: `#${id}`, status: "pending" };
            if (input["status"] === "deleted") acc.tasks.delete(id);
            else {
              if (str(input["status"])) task.status = str(input["status"]);
              if (str(input["subject"])) task.subject = str(input["subject"]);
              if (str(input["activeForm"])) task.activeForm = str(input["activeForm"]);
              acc.tasks.set(id, task);
            }
            break;
          }
          case "TodoWrite": {
            const todos = Array.isArray(input["todos"]) ? (input["todos"] as Record<string, unknown>[]) : [];
            acc.tasks = new Map(todos.map((t, i) => [String(i + 1), { id: String(i + 1), subject: str(t["content"]) || "(task)", status: str(t["status"]) || "pending", ...(str(t["activeForm"]) && { activeForm: str(t["activeForm"]) }) }]));
            break;
          }
          case "Bash":
            if (input["run_in_background"] === true) acc.starting.set(b.id, { kind: "command", command: str(input["description"]) || str(input["command"]), since: at });
            break;
          case "Monitor":
            acc.starting.set(b.id, { kind: "monitor", command: str(input["description"]) || str(input["command"]), since: at });
            break;
          case "TaskStop":
            acc.background.delete(str(input["task_id"]));
            break;
        }
      }
      const u = line.message?.usage;
      if (u) acc.tokens = (u["input_tokens"] ?? 0) + (u["cache_creation_input_tokens"] ?? 0) + (u["cache_read_input_tokens"] ?? 0);
      const model = line.message?.model;
      if (typeof model === "string" && model && !model.startsWith("<")) acc.model = model;
      return;
    }
  }
}

function questionsOf(block: Block): InboxQuestion[] {
  const qs = Array.isArray(block.input?.["questions"]) ? (block.input["questions"] as Record<string, unknown>[]) : [];
  return qs
    .filter((q) => typeof q?.["question"] === "string")
    .map((q) => ({
      question: q["question"] as string,
      options: (Array.isArray(q["options"]) ? (q["options"] as Record<string, unknown>[]) : []).map((o) => String(o?.["label"] ?? "")).filter(Boolean),
    }));
}

/** Adds what the transcript says to an item. */
/**
 * Claude Code can go on saying "waiting" after its question was answered, while a background
 * command it started runs on; until a turn ends with none running. If its transcript shows the
 * turn over and nothing asked, it waits on no one. Permission prompts name what they want
 * ("approve Bash: …") and are left as they are.
 */
function notAsking(item: InboxItem, r: ClaudeRecord, acc: ClaudeAcc): void {
  if (item.state !== "needs-answer" || (r.waitingFor && r.waitingFor !== "input needed") || !acc.turnOver || acc.pending.size) return;
  delete item.reason;
  if (acc.background.size) ((item.state = "working"), (item.reason = "background command"));
  else item.state = "your-turn";
}

function fromTranscript(item: InboxItem, acc: ClaudeAcc): void {
  setEdited(item, acc.edited);
  if (acc.title) item.title = acc.title;
  if (acc.lastMessage) item.lastMessage = clip(acc.lastMessage);
  if (acc.model) item.model = acc.model;
  if (acc.lastPrompt) item.lastPrompt = acc.lastPrompt;
  if (acc.awaySummary && item.state !== "working") item.awaySummary = acc.awaySummary;
  if (acc.tasks.size) item.tasks = [...acc.tasks.values()];
  if (acc.background.size) item.background = [...acc.background.values()];
  if (acc.prs.size) item.prs = [...acc.prs.values()].slice(-MAX_PRS);
  if (acc.pages.size) item.pages = [...acc.pages.values()].slice(-MAX_PAGES);
  if (acc.tokens !== undefined || acc.compactions) {
    item.context = { compactions: acc.compactions };
    if (acc.tokens !== undefined) item.context.tokens = acc.tokens;
    if (acc.lastCompactTokens) item.context.lastCompactTokens = acc.lastCompactTokens;
  }
  if (item.state === "needs-answer") {
    const asks = [...acc.pending.values()].filter((b) => b.name === "AskUserQuestion").flatMap(questionsOf);
    if (asks.length) item.questions = asks;
    const plan = [...acc.pending.values()].find((b) => b.name === "ExitPlanMode")?.input?.["plan"];
    if (typeof plan === "string" && plan.trim()) item.plan = plan.length > 20_000 ? plan.slice(0, 20_000) + "\n\n…" : plan;
  }
}

function readJobs(home: string): Map<string, JobState & { short: string }> {
  const jobs = new Map<string, JobState & { short: string }>();
  const dir = join(home, "jobs");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return jobs;
  }
  for (const short of names) {
    try {
      const job = JSON.parse(readFileSync(join(dir, short, "state.json"), "utf8")) as JobState;
      if (job.sessionId) jobs.set(job.sessionId, { ...job, short: job.daemonShort ?? short });
    } catch {
      // not a job folder, or being rewritten
    }
  }
  return jobs;
}

function jobPrs(job: JobState): InboxPr[] {
  return (job.children ?? [])
    .filter((c) => c?.kind === "pr" && typeof c.href === "string")
    .map((c) => {
      const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(c.href!);
      return { url: c.href!, number: m ? Number(m[2]) : 0, repo: m?.[1] ?? "" };
    });
}

function claudeItems(home: string, now: number, staleAfter: number, light: boolean): InboxItem[] {
  const items: InboxItem[] = [];
  const jobs = readJobs(home);
  const seen = new Set<string>();
  const dir = join(home, "sessions");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    // no running sessions
  }
  for (const f of files) {
    let r: ClaudeRecord;
    try {
      r = JSON.parse(readFileSync(join(dir, f), "utf8")) as ClaudeRecord;
    } catch {
      continue; // being rewritten
    }
    const pid = r.pid ?? Number(f.split(".")[0]);
    if (!r.sessionId || r.spare || seen.has(r.sessionId) || !alive(pid, r.procStart)) continue;
    seen.add(r.sessionId);
    const state: InboxState = r.status === "waiting" ? "needs-answer" : r.status === "idle" ? "your-turn" : "working";
    const transcript = claudeTranscript(home, r.sessionId);
    const item: InboxItem = {
      key: sessionKey("claude", r.sessionId),
      agent: "claude",
      id: r.sessionId,
      name: r.name || r.sessionId.slice(0, 8),
      cwd: r.cwd,
      state,
      since: r.statusUpdatedAt ?? r.updatedAt ?? r.startedAt ?? (transcript ? statSync(transcript).mtimeMs : 0),
      pid,
      resume: `claude --resume ${r.sessionId}`,
    };
    if (r.kind) item.kind = r.kind;
    if (state === "needs-answer") item.reason = r.waitingFor || "input needed";
    // "shell": the turn is over but a background command will wake the session when it ends.
    if (state === "working" && r.status && r.status !== "busy") item.reason = r.status === "shell" ? "background command" : r.status;
    const job = jobs.get(r.sessionId);
    if (job) {
      item.jobId = job.short;
      item.resume = `claude attach ${job.short}`;
      if (job.state === "blocked" && job.needs) item.reason = item.reason ? `${item.reason} · ${job.needs}` : job.needs;
    }
    if (transcript) setTranscript(item, transcript);
    placeProcess(item, pid);
    if (!light && transcript) {
      const acc = follow(claudeCursors, transcript, newClaudeAcc, feedClaude);
      if (acc) {
        notAsking(item, r, acc);
        fromTranscript(item, acc);
      }
    } else if (transcript) {
      const title = quickTitle(transcript);
      if (title) item.title = title;
    }
    if (job) {
      const prs = new Map((item.prs ?? []).map((p) => [p.url, p]));
      for (const p of jobPrs(job)) prs.set(p.url, p);
      if (prs.size) item.prs = [...prs.values()].slice(-MAX_PRS);
    }
    items.push(item);
  }

  // Background sessions with no process: parked until you answer, or finished.
  for (const [sessionId, job] of jobs) {
    if (seen.has(sessionId)) continue;
    const updated = Date.parse(job.updatedAt ?? job.createdAt ?? "") || 0;
    let state: InboxState = job.state === "blocked" ? "needs-answer" : job.state === "running" ? "working" : "your-turn";
    if (state === "needs-answer" && now - updated > staleAfter) state = "stale"; // long forgotten
    const item: InboxItem = {
      key: sessionKey("claude", sessionId),
      agent: "claude",
      id: sessionId,
      name: job.name || job.short,
      cwd: job.cwd,
      state,
      since: updated,
      kind: "bg",
      jobId: job.short,
      resume: `claude attach ${job.short}`,
    };
    const reason = job.state === "blocked" ? job.needs || job.detail || "blocked" : job.state === "failed" ? `failed: ${job.detail ?? ""}`.trim() : undefined;
    if (reason) item.reason = reason;
    const transcript = light ? undefined : claudeTranscript(home, sessionId);
    if (transcript) {
      setTranscript(item, transcript);
      const acc = follow(claudeCursors, transcript, newClaudeAcc, feedClaude);
      if (acc) fromTranscript(item, acc);
    }
    const prs = jobPrs(job);
    if (prs.length) item.prs = [...new Map([...(item.prs ?? []), ...prs].map((p) => [p.url, p])).values()].slice(-MAX_PRS);
    items.push(item);
  }
  return items;
}

/** The sessions running right now, as "claude:<id>" / "codex:<id>" → a name to show. Cheap: no transcripts. */
export function runningSessions(claude = claudeHome(), codex = codexHome()): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const f of readdirSync(join(claude, "sessions"))) {
      if (!/^\d+\.json$/.test(f)) continue;
      try {
        const r = JSON.parse(readFileSync(join(claude, "sessions", f), "utf8")) as ClaudeRecord;
        if (r.sessionId && alive(r.pid ?? Number(f.split(".")[0]), r.procStart)) out.set(sessionKey("claude", r.sessionId), r.name || r.sessionId.slice(0, 8));
      } catch {
        // being rewritten
      }
    }
  } catch {
    // none
  }
  try {
    const held = lockedInodes();
    const dir = join(codex, "thread-writer-locks");
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".lock")) continue;
      if (held && !held.has(statSync(join(dir, f)).ino)) continue;
      const id = f.slice(0, -".lock".length);
      out.set(sessionKey("codex", id), id.slice(0, 8));
    }
  } catch {
    // none
  }
  return out;
}

// ---------------------------------------------------------------- Codex

/** Inodes of the files locked now, and the process holding each lock. */
function lockedInodes(): Map<number, number> | undefined {
  let text: string;
  try {
    text = readFileSync("/proc/locks", "utf8");
  } catch {
    return undefined;
  }
  const out = new Map<number, number>();
  for (const line of text.split("\n")) {
    // "1: FLOCK  ADVISORY  WRITE 13101 103:03:9978369 0 EOF"; processes waiting for it follow, with "->"
    const fields = line.trim().split(/\s+/);
    const at = fields.findIndex((f) => /^[0-9a-f]+:[0-9a-f]+:\d+$/.test(f));
    if (at < 1) continue;
    const ino = Number(fields[at]!.split(":")[2]);
    if (!out.has(ino)) out.set(ino, line.includes("->") ? 0 : Number(fields[at - 1]));
  }
  return out;
}

/** Whether a process has a file open (Linux). */
function hasOpen(pid: number, file: string): boolean {
  try {
    const dir = `/proc/${pid}/fd`;
    file = realpathSync(file);
    return readdirSync(dir).some((fd) => {
      try {
        return readlinkSync(join(dir, fd)) === file;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

const rolloutCache = new Map<string, string>();

function findRollouts(sessions: string, ids: string[]): void {
  const missing = new Set(ids.filter((id) => !rolloutCache.get(id)?.startsWith(sessions) || !existsSync(rolloutCache.get(id)!)));
  if (!missing.size || !existsSync(sessions)) return;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).reverse()) {
      if (!missing.size) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const id = /([0-9a-f-]{36})\.jsonl$/.exec(entry.name)?.[1];
        if (id && missing.delete(id)) rolloutCache.set(id, full);
      }
    }
  };
  walk(sessions);
}

function threadNames(home: string): Map<string, string> {
  const names = new Map<string, string>();
  let text = "";
  try {
    text = readFileSync(join(home, "session_index.jsonl"), "utf8");
  } catch {
    return names;
  }
  for (const line of text.split("\n")) {
    try {
      const e = JSON.parse(line) as { id?: string; thread_name?: string };
      if (e.id && e.thread_name) names.set(e.id, e.thread_name);
    } catch {
      // skip
    }
  }
  return names;
}

/** The working directory from the rollout's first line (session_meta). */
function rolloutCwd(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(256 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const first = buf.toString("utf8", 0, n).split("\n")[0] ?? "";
    return /"cwd":"((?:[^"\\]|\\.)*)"/.exec(first)?.[1]?.replace(/\\(.)/g, "$1");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The shell command in a Codex tool call: exec's JavaScript (`cmd:"…"`) or a function's JSON arguments. */
export function codexCommand(name: string, input: unknown): string {
  if (typeof input === "string") {
    const js = /cmd:\s*"((?:[^"\\]|\\.)*)"/.exec(input)?.[1];
    if (js !== undefined) {
      try {
        return JSON.parse(`"${js}"`) as string;
      } catch {
        return js;
      }
    }
    try {
      const args = JSON.parse(input) as Record<string, unknown>;
      const cmd = args["cmd"] ?? args["command"];
      if (Array.isArray(cmd)) return cmd.map(String).join(" ");
      if (typeof cmd === "string") return cmd;
    } catch {
      // not JSON
    }
  }
  return name;
}

interface CodexAcc {
  state: InboxState;
  since: number;
  reason?: string;
  lastMessage?: string;
  lastPrompt?: string;
  cwd?: string;
  /** Tool calls without output yet, by call id. */
  calls: Map<string, { command: string; since: number }>;
  tokens?: number;
  window?: number;
  limits?: CodexLimits;
  model?: string;
  edited: Map<string, number>;
  publishing: Map<string, { title?: string }>;
  pages: Map<string, InboxPage>;
}

const codexCursors = new Map<string, Cursor<CodexAcc>>();

function rate(w: unknown): RateWindow | undefined {
  const r = w as { used_percent?: number; window_minutes?: number; resets_at?: number } | null | undefined;
  if (!r || typeof r.used_percent !== "number") return undefined;
  return { usedPercent: r.used_percent, windowMinutes: r.window_minutes ?? 0, resetsAt: (r.resets_at ?? 0) * 1000 };
}

function feedCodex(acc: CodexAcc, raw: string): void {
  if (!/"type":"(event_msg|turn_context|response_item|session_meta)"/.test(raw.slice(0, 200))) return;
  let e: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
  try {
    e = JSON.parse(raw);
  } catch {
    return;
  }
  const p = e.payload ?? {};
  const at = e.timestamp ? Date.parse(e.timestamp) : NaN;
  if ((e.type === "turn_context" || e.type === "session_meta") && typeof p["cwd"] === "string") acc.cwd = p["cwd"];
  if (e.type === "turn_context" && typeof p["model"] === "string") acc.model = p["model"];
  if (e.type === "response_item") {
    const callId = typeof p["call_id"] === "string" ? p["call_id"] : undefined;
    if (!callId) return;
    if (p["type"] === "custom_tool_call" || p["type"] === "function_call") {
      const input = p["input"] ?? p["arguments"];
      acc.calls.set(callId, { command: codexCommand(String(p["name"] ?? "tool"), input), since: Number.isNaN(at) ? Date.now() : at });
      const publish = publishTitle(String(p["name"] ?? ""), {}, typeof input === "string" ? input : "");
      if (publish) acc.publishing.set(callId, publish);
    } else if (p["type"] === "custom_tool_call_output" || p["type"] === "function_call_output") {
      acc.calls.delete(callId);
      const publish = acc.publishing.get(callId);
      if (publish) {
        acc.publishing.delete(callId);
        const out = p["output"];
        const url = publishedUrl(typeof out === "string" ? out : resultText(out));
        if (url) acc.pages.set(url, { url, ...publish, at: Number.isNaN(at) ? Date.now() : at });
      }
    }
    return;
  }
  if (e.type !== "event_msg") return;
  const item = p["item"] as { type?: string; text?: string; content?: { text?: string }[]; changes?: Record<string, unknown> } | undefined;
  switch (p["type"]) {
    case "item_completed": {
      if (item?.type === "FileChange" && item.changes) for (const path of Object.keys(item.changes)) acc.edited.set(path, Number.isNaN(at) ? Date.now() : at);
      const text = item?.text ?? item?.content?.map((c) => c.text ?? "").join("");
      if (item?.type === "AgentMessage" && text?.trim()) acc.lastMessage = text;
      if (item?.type === "UserMessage" && text?.trim()) acc.lastPrompt = head(text);
      return;
    }
    case "token_count": {
      const info = p["info"] as { last_token_usage?: { total_tokens?: number; input_tokens?: number }; model_context_window?: number } | null | undefined;
      const last = info?.last_token_usage;
      if (last) acc.tokens = last.total_tokens ?? last.input_tokens ?? acc.tokens;
      if (info?.model_context_window) acc.window = info.model_context_window;
      const limits = p["rate_limits"] as { primary?: unknown; secondary?: unknown } | null | undefined;
      if (limits && !Number.isNaN(at)) {
        acc.limits = { at };
        const primary = rate(limits.primary);
        const secondary = rate(limits.secondary);
        if (primary) acc.limits.primary = primary;
        if (secondary) acc.limits.secondary = secondary;
      }
      return;
    }
    case "task_started":
      acc.state = "working";
      acc.reason = undefined;
      break;
    case "task_complete":
      acc.state = "your-turn";
      acc.reason = undefined;
      acc.calls.clear();
      if (typeof p["last_agent_message"] === "string" && p["last_agent_message"].trim()) acc.lastMessage = p["last_agent_message"];
      break;
    case "turn_aborted":
      acc.state = "your-turn";
      acc.reason = "interrupted";
      acc.calls.clear();
      break;
    default:
      return;
  }
  if (!Number.isNaN(at)) acc.since = at;
}

function codexItems(home: string, now: number): { items: InboxItem[]; limits?: CodexLimits } {
  const lockDir = join(home, "thread-writer-locks");
  let locks: string[];
  try {
    locks = readdirSync(lockDir).filter((f) => f.endsWith(".lock"));
  } catch {
    return { items: [] };
  }
  const held = lockedInodes();
  const pids = new Map<string, number>();
  const ids = locks
    .filter((f) => {
      try {
        if (!held) return true;
        const pid = held.get(statSync(join(lockDir, f)).ino);
        if (pid) pids.set(f.slice(0, -".lock".length), pid);
        return pid !== undefined;
      } catch {
        return false;
      }
    })
    .map((f) => f.slice(0, -".lock".length));
  // Codex's background server (`codex app-server`) holds the threads of the windows that use it, and
  // of the terminals too in newer versions: a process holding several, or that server, is no one
  // session's own, and must never be taken for one (to close, say).
  const holders = [...pids.values()];
  // /proc/locks names a file by its inode alone, which another file system can repeat: the process
  // must have the lock file itself open.
  for (const [id, pid] of pids) if (holders.indexOf(pid) !== holders.lastIndexOf(pid) || /\bapp-server\b/.test(commandOf(pid)) || !hasOpen(pid, join(lockDir, `${id}.lock`))) pids.delete(id);
  findRollouts(join(home, "sessions"), ids);
  const names = threadNames(home);
  const items: InboxItem[] = [];
  let limits: CodexLimits | undefined;
  for (const id of ids) {
    const file = rolloutCache.get(id);
    if (!file) continue;
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const acc = follow(codexCursors, file, (): CodexAcc => ({ state: "your-turn", since: mtime, calls: new Map(), edited: new Map(), publishing: new Map(), pages: new Map() }), feedCodex);
    if (!acc) continue;
    const entry: InboxItem = {
      key: sessionKey("codex", id),
      agent: "codex",
      id,
      name: names.get(id) ?? id.slice(0, 8),
      cwd: acc.cwd ?? rolloutCwd(file),
      state: acc.state,
      since: acc.since,
      resume: `codex resume ${id}`,
    };
    const pid = pids.get(id);
    if (pid) {
      entry.pid = pid;
      placeProcess(entry, pid);
    }
    if (names.has(id)) entry.title = names.get(id)!;
    setEdited(entry, acc.edited);
    setTranscript(entry, file);
    if (acc.pages.size) entry.pages = [...acc.pages.values()].slice(-MAX_PAGES);
    if (acc.reason) entry.reason = acc.reason;
    if (acc.lastMessage) entry.lastMessage = clip(acc.lastMessage);
    if (acc.model) entry.model = acc.model;
    if (acc.lastPrompt) entry.lastPrompt = acc.lastPrompt;
    if (acc.tokens !== undefined) {
      entry.context = { tokens: acc.tokens, compactions: 0 };
      if (acc.window) entry.context.window = acc.window;
    }
    const call = [...acc.calls.values()].sort((a, b) => a.since - b.since)[0];
    if (acc.state === "working" && call) {
      entry.inFlight = call;
      if (now - call.since > APPROVAL_AFTER) entry.reason = `may need approval: ${call.command}`;
    }
    if (acc.limits && (!limits || acc.limits.at > limits.at)) limits = acc.limits;
    items.push(entry);
  }
  return limits ? { items, limits } : { items };
}
