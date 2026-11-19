import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { codexCommand } from "./inbox.ts";
import type { Agent } from "./types.ts";

/**
 * A session's conversation, read from its transcript a page at a time: the latest page first,
 * then earlier ones as you scroll back (`before`), then what was written since (`after`).
 * Transcripts only grow, so a line's byte offset names it for good: it is the message id and the
 * cursor. Tool output, thinking and harness text are left out; tool calls stay as one-line steps.
 */

export interface ChatMessage {
  /** The byte offset of its line, with ".n" when one line holds several messages. */
  id: string;
  at?: number;
  role: "user" | "assistant" | "tool" | "event";
  /** user: "command" (/compact), "shell" (! cmd), "answer" (to a question it asked).
   *  event: "compact", "summary" (the compacted conversation), "recap" (while you were away),
   *  "interrupted", "task" (a background task ended), "output" (of a ! command). */
  kind?: string;
  text?: string;
  /** Tools: its name, and what it ran or touched. */
  tool?: string;
  detail?: string;
  /** The file it read or wrote (absolute), to open it. */
  path?: string;
  error?: boolean;
  truncated?: boolean;
}

export interface ChatPage {
  messages: ChatMessage[];
  /** Ask with `before` set to this for the page before; absent at the start of the conversation. */
  before?: number;
  /** Ask with `after` set to this for what is written next. */
  end: number;
  /** Too much was written since `after`: read the latest page again. */
  reset?: boolean;
}

export interface ChatOptions {
  before?: number;
  after?: number;
  /** Messages of text (yours and its) per page; steps in between come along. */
  limit?: number;
  /** The session's folder, to show paths short. */
  cwd?: string;
}

const CHUNK = 256 * 1024;
/** At most this much transcript is read for one page (tool output can be most of it). */
const MAX_SCAN = 8 * 1024 * 1024;
const MAX_TEXT = 20_000;
/** Tool results bigger than this are not parsed: only their id and whether they failed. */
const BIG_LINE = 256 * 1024;

type Part = ChatMessage | { role: "result"; id: string; toolId: string; error: boolean; legacy?: boolean };
type Tool = ChatMessage & { toolId?: string; legacy?: boolean };

export function readChat(file: string, agent: Agent, opts: ChatOptions = {}): ChatPage {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const parse = agent === "codex" ? codexParts : claudeParts;
    if (opts.after !== undefined) {
      if (opts.after > size || size - opts.after > MAX_SCAN) return { messages: [], end: size, reset: true };
      const lines: Line[] = [];
      let end = opts.after;
      for (const line of forwards(fd, opts.after, size)) {
        lines.push(line);
        end = line.end;
      }
      return { messages: link(lines.flatMap((l) => parse(l.text, l.start, opts.cwd))), end };
    }
    const end = opts.before ?? lastLineEnd(fd, size);
    const limit = opts.limit ?? 30;
    const pages: Part[][] = [];
    let texts = 0;
    let before: number | undefined;
    for (const line of backwards(fd, end)) {
      const parts = parse(line.text, line.start, opts.cwd);
      pages.push(parts);
      texts += parts.filter((p) => p.role === "user" || p.role === "assistant").length;
      if (texts >= limit || end - line.start >= MAX_SCAN) {
        if (line.start > 0) before = line.start;
        break;
      }
    }
    return { messages: link(pages.reverse().flat()), ...(before !== undefined && { before }), end };
  } finally {
    closeSync(fd);
  }
}

/** Marks the steps that failed, and drops Codex's older tool records where its newer ones exist. */
function link(parts: Part[]): ChatMessage[] {
  const tools = new Map<string, Tool>();
  const newer = parts.some((p) => p.role === "tool" && !(p as Tool).legacy);
  const out: ChatMessage[] = [];
  for (const p of parts) {
    if (p.role === "result") {
      const t = tools.get(p.toolId);
      if (t && p.error) t.error = true;
      continue;
    }
    const t = p as Tool;
    if (t.role === "tool" && t.legacy && newer) continue;
    if (t.toolId) tools.set(t.toolId, t);
    out.push(t);
  }
  for (const m of out) {
    delete (m as Tool).toolId;
    delete (m as Tool).legacy;
  }
  return out;
}

// ------------------------------------------------------------ lines

interface Line {
  start: number;
  end: number;
  text: string;
}

/** Where the last complete line ends: a line still being written is left for the next look. */
function lastLineEnd(fd: number, size: number): number {
  let pos = size;
  while (pos > 0) {
    const n = Math.min(CHUNK, pos);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, pos - n);
    const i = buf.lastIndexOf(0x0a);
    if (i >= 0) return pos - n + i + 1;
    pos -= n;
  }
  return 0;
}

/** Lines ending at or before `end` (which ends a line), newest first. */
function* backwards(fd: number, end: number): Generator<Line> {
  let pos = end;
  let carry = Buffer.alloc(0); // the end of a line that began before `pos`
  while (pos > 0) {
    const n = Math.min(CHUNK, pos);
    const chunk = Buffer.alloc(n);
    readSync(fd, chunk, 0, n, pos - n);
    pos -= n;
    const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
    let stop = data.length;
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i] !== 0x0a) continue;
      if (i + 1 < stop) yield { start: pos + i + 1, end: pos + stop + 1, text: data.toString("utf8", i + 1, stop) };
      stop = i;
    }
    carry = data.subarray(0, stop);
  }
  if (carry.length) yield { start: 0, end: carry.length + 1, text: carry.toString("utf8") };
}

/** Complete lines from `from` (where a line starts) to `size`, oldest first. */
function* forwards(fd: number, from: number, size: number): Generator<Line> {
  let pos = from;
  let carry = Buffer.alloc(0);
  while (pos < size) {
    const n = Math.min(CHUNK, size - pos);
    const chunk = Buffer.alloc(n);
    readSync(fd, chunk, 0, n, pos);
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const base = pos - carry.length;
    pos += n;
    let lineStart = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 0x0a) continue;
      if (i > lineStart) yield { start: base + lineStart, end: base + i + 1, text: data.toString("utf8", lineStart, i) };
      lineStart = i + 1;
    }
    carry = data.subarray(lineStart);
  }
}

// ------------------------------------------------------------ shared

function clip(text: string): { text: string; truncated?: boolean } {
  return text.length > MAX_TEXT ? { text: text.slice(0, MAX_TEXT), truncated: true } : { text };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const oneLine = (s: string, max = 300): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};
const shortPath = (p: string, cwd?: string): string => (cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p);
const absolute = (p: string, cwd?: string): string => (isAbsolute(p) ? p : resolve(cwd ?? "/", p));

/** "mcp__artifact__publish" → "artifact · publish". */
function toolName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

function firstString(input: Record<string, unknown>): string {
  for (const v of Object.values(input)) if (typeof v === "string" && v.trim()) return v;
  return "";
}

// ------------------------------------------------------------ Claude Code

interface ClaudeBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface ClaudeLineShape {
  type?: string;
  subtype?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  content?: unknown;
  message?: { content?: unknown };
}

const CLAUDE_KEPT = /"type":"(user|assistant|system)"/;

function claudeParts(raw: string, start: number, cwd?: string): Part[] {
  if (!CLAUDE_KEPT.test(raw)) return [];
  // Huge lines are tool output (file contents, images): keep only which call it answers.
  if (raw.length > BIG_LINE && raw.includes('"tool_result"')) {
    const toolId = /"tool_use_id":"([^"]+)"/.exec(raw)?.[1];
    return toolId ? [{ role: "result", id: String(start), toolId, error: /"is_error":true/.test(raw) }] : [];
  }
  let line: ClaudeLineShape;
  try {
    line = JSON.parse(raw) as ClaudeLineShape;
  } catch {
    return [];
  }
  if (line.isSidechain) return [];
  const at = line.timestamp ? Date.parse(line.timestamp) || undefined : undefined;
  let n = 0;
  const id = () => (n++ ? `${start}.${n - 1}` : String(start));
  const msg = (m: Omit<ChatMessage, "id" | "at">): ChatMessage => ({ id: id(), ...(at && { at }), ...m });

  if (line.type === "system") {
    if (line.subtype === "compact_boundary") return [msg({ role: "event", kind: "compact", text: "Conversation compacted" })];
    if (line.subtype === "away_summary" && typeof line.content === "string" && line.content.trim()) return [msg({ role: "event", kind: "recap", ...clip(line.content.trim()) })];
    return [];
  }
  const content = line.message?.content;
  if (line.type === "user") {
    if (line.isMeta) return [];
    if (line.isCompactSummary) return [msg({ role: "event", kind: "summary", ...clip(textOf(content)) })];
    if (typeof content === "string") return userText(content, msg);
    if (!Array.isArray(content)) return [];
    const parts: Part[] = [];
    for (const b of content as ClaudeBlock[]) {
      if (b?.type === "text" && b.text) parts.push(...userText(b.text, msg));
      else if (b?.type === "image") parts.push(msg({ role: "user", text: "[image]" }));
      else if (b?.type === "tool_result" && b.tool_use_id) {
        parts.push({ role: "result", id: id(), toolId: b.tool_use_id, error: b.is_error === true });
        const text = textOf(b.content);
        if (/^User has answered your questions?/.test(text)) parts.push(msg({ role: "user", kind: "answer", text: answers(text) }));
      }
    }
    return parts;
  }
  if (line.type === "assistant" && Array.isArray(content)) {
    const parts: Part[] = [];
    for (const b of content as ClaudeBlock[]) {
      if (b?.type === "text" && b.text?.trim()) parts.push(msg({ role: "assistant", ...clip(b.text) }));
      else if (b?.type === "tool_use" && b.name) parts.push({ ...msg({ role: "tool", ...claudeTool(b.name, b.input ?? {}, cwd) }), ...(b.id && { toolId: b.id }) } as Tool);
    }
    return parts;
  }
  return [];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return (content as ClaudeBlock[]).map((b) => (b?.type === "text" ? (b.text ?? "") : "")).join("\n");
  return "";
}

/** `"Which layout?"="Two panes"` → "Which layout? → Two panes". */
function answers(text: string): string {
  const pairs = [...text.matchAll(/"([^"]*)"="([^"]*)"/g)].map((m) => `${m[1]} → ${m[2]}`);
  return pairs.length ? pairs.join("\n") : text;
}

/** What you typed, as opposed to what the harness wrapped in tags (reminders, command records). */
function userText(raw: string, msg: (m: Omit<ChatMessage, "id" | "at">) => ChatMessage): ChatMessage[] {
  const t = raw.trim();
  if (!t) return [];
  if (t.startsWith("[Request interrupted")) return [msg({ role: "event", kind: "interrupted", text: "Interrupted" })];
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(t)?.[1]?.trim() ?? "";
  if (t.startsWith("<command-name>") || t.startsWith("<command-message>")) {
    const name = tag("command-name");
    return name ? [msg({ role: "user", kind: "command", text: `${name.startsWith("/") ? "" : "/"}${name} ${tag("command-args")}`.trim() })] : [];
  }
  if (t.startsWith("<bash-input>")) return [msg({ role: "user", kind: "shell", text: `! ${tag("bash-input")}` })];
  if (t.startsWith("<bash-stdout>") || t.startsWith("<bash-stderr>")) {
    const out = [tag("bash-stdout"), tag("bash-stderr")].filter(Boolean).join("\n");
    return out ? [msg({ role: "event", kind: "output", ...clip(out) })] : [];
  }
  if (t.startsWith("<task-notification>")) return [msg({ role: "event", kind: "task", text: tag("summary") || "A background task ended" })];
  if (t.startsWith("<")) return []; // reminders, caveats, local command output
  return [msg({ role: "user", ...clip(t) })];
}

function claudeTool(name: string, input: Record<string, unknown>, cwd?: string): Pick<ChatMessage, "tool" | "detail" | "path"> {
  const s = (k: string) => str(input[k]);
  switch (name) {
    case "Bash":
      return { tool: "Bash", detail: oneLine(s("command")) || oneLine(s("description")) };
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const p = s("file_path") || s("notebook_path");
      return p ? { tool: name, detail: shortPath(absolute(p, cwd), cwd), path: absolute(p, cwd) } : { tool: name };
    }
    case "Grep":
      return { tool: "Grep", detail: oneLine(s("pattern") + (s("path") ? `  in ${shortPath(s("path"), cwd)}` : "")) };
    case "Glob":
      return { tool: "Glob", detail: s("pattern") };
    case "WebFetch":
      return { tool: "Fetch", detail: s("url") };
    case "WebSearch":
      return { tool: "Search", detail: oneLine(s("query")) };
    case "Task":
    case "Agent":
      return { tool: "Agent", detail: oneLine(s("description") || s("prompt"), 120) };
    case "AskUserQuestion": {
      const q = Array.isArray(input["questions"]) ? (input["questions"] as Record<string, unknown>[])[0] : undefined;
      return { tool: "Asked", detail: oneLine(str(q?.["question"])) };
    }
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return { tool: "Tasks", detail: oneLine(s("subject") || s("activeForm") || (s("status") ? `${s("taskId")} → ${s("status")}` : "updated"), 120) };
    case "Skill":
      return { tool: "Skill", detail: s("skill") || s("command") };
    default:
      return { tool: toolName(name), detail: oneLine(firstString(input), 160) };
  }
}

// ------------------------------------------------------------ Codex

interface CodexItem {
  type?: string;
  text?: string;
  content?: unknown;
  command?: unknown;
  changes?: Record<string, unknown>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  kind?: string;
  query?: string;
  exit_code?: number;
  exitCode?: number;
  status?: string;
}

function codexText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return (content as { text?: unknown }[]).map((c) => str(c?.text)).join("");
  return "";
}

/** ['/bin/bash', '-lc', 'npm test'] → "npm test". */
function shellLine(command: unknown): string {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  const argv = command.map(String);
  const i = argv.findIndex((a) => a === "-lc" || a === "-c");
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : argv.join(" ");
}

const CODEX_KEPT = /"type":"(event_msg|response_item|compacted)"/;

function codexParts(raw: string, start: number, cwd?: string): Part[] {
  if (!CODEX_KEPT.test(raw.slice(0, 400))) return [];
  let e: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
  try {
    e = JSON.parse(raw);
  } catch {
    return [];
  }
  const p = e.payload ?? {};
  const at = e.timestamp ? Date.parse(e.timestamp) || undefined : undefined;
  let n = 0;
  const id = () => (n++ ? `${start}.${n - 1}` : String(start));
  const msg = (m: Omit<ChatMessage, "id" | "at">): ChatMessage => ({ id: id(), ...(at && { at }), ...m });
  if (e.type === "compacted") return [msg({ role: "event", kind: "compact", text: "Conversation compacted" })];

  if (e.type === "event_msg") {
    switch (p["type"]) {
      case "item_completed": {
        const item = (p["item"] ?? {}) as CodexItem;
        switch (item.type) {
          case "UserMessage": {
            const t = codexText(item.content).trim();
            return t ? [msg({ role: "user", ...clip(t) })] : [];
          }
          case "AgentMessage": {
            const t = (item.text ?? codexText(item.content)).trim();
            return t ? [msg({ role: "assistant", ...clip(t) })] : [];
          }
          case "CommandExecution": {
            const code = item.exit_code ?? item.exitCode;
            return [msg({ role: "tool", tool: "Shell", detail: oneLine(shellLine(item.command)), ...(typeof code === "number" && code !== 0 && { error: true }) })];
          }
          case "FileChange":
            return Object.keys(item.changes ?? {}).map((path) => msg({ role: "tool", tool: "Edit", detail: shortPath(absolute(path, cwd), cwd), path: absolute(path, cwd) }));
          case "McpToolCall": {
            const args = typeof item.arguments === "object" && item.arguments ? firstString(item.arguments as Record<string, unknown>) : str(item.arguments);
            return [msg({ role: "tool", tool: `${item.server ?? "mcp"} · ${item.tool ?? "tool"}`, detail: oneLine(args, 160) })];
          }
          case "Extension":
            return item.kind === "web.search" ? [msg({ role: "tool", tool: "Search", detail: oneLine(str(item.query)) })] : [];
          default:
            return [];
        }
      }
      // Older rollouts: the messages as events, the tools as response items (below).
      case "user_message": {
        const t = str(p["message"]).trim();
        return t && !t.startsWith("<") ? [msg({ role: "user", ...clip(t) })] : [];
      }
      case "agent_message": {
        const t = str(p["message"]).trim();
        return t ? [msg({ role: "assistant", ...clip(t) })] : [];
      }
      case "turn_aborted":
        return [msg({ role: "event", kind: "interrupted", text: "Interrupted" })];
      case "context_compacted":
        return [msg({ role: "event", kind: "compact", text: "Conversation compacted" })];
      default:
        return [];
    }
  }

  if (e.type === "response_item") {
    const type = p["type"];
    const callId = str(p["call_id"]);
    if (type === "function_call" || type === "custom_tool_call") {
      const name = str(p["name"]) || "tool";
      const detail = name === "apply_patch" ? patchFiles(str(p["input"] ?? p["arguments"])).join(", ") : codexCommand(name, p["input"] ?? p["arguments"]);
      return [{ ...msg({ role: "tool", tool: name === "exec" || name === "shell" || name === "exec_command" ? "Shell" : name, detail: oneLine(detail) }), legacy: true, ...(callId && { toolId: callId }) } as Tool];
    }
    if (type === "local_shell_call") {
      const action = (p["action"] ?? {}) as { command?: unknown };
      return [{ ...msg({ role: "tool", tool: "Shell", detail: oneLine(shellLine(action.command)) }), legacy: true } as Tool];
    }
  }
  return [];
}

/** The files an apply_patch touches. */
function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim());
}
