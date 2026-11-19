import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "./types.ts";

/**
 * Registers the recorder as a PreToolUse + PostToolUse hook, user-wide, in
 *   Claude Code: ~/.claude/settings.json   (hooks.PreToolUse / hooks.PostToolUse)
 *   Codex:       ~/.codex/hooks.json       (same shape)
 * Other hooks are left as they are; ours are recognised by the "agent-deck-hook" marker (or
 * "agent-diff-hook", from before the rename).
 */

const MARKER = "agent-deck-hook";
const MARKERS = [MARKER, "agent-diff-hook"];
const EVENTS = ["PreToolUse", "PostToolUse"] as const;
/** Tools that can write files. Read-only tools are not hooked, so they cost nothing. */
const MATCHERS: Record<Agent, string> = {
  claude: "^(Edit|Write|MultiEdit|NotebookEdit|Bash)$",
  codex: "^(Bash|apply_patch|Edit|Write)$",
};

export function settingsFile(agent: Agent): string {
  if (agent === "claude") return join(process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude"), "settings.json");
  return join(process.env["CODEX_HOME"] || join(homedir(), ".codex"), "hooks.json");
}

function onPath(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

/** How the agent should start the recorder: the installed bin, else node + this checkout. */
function hookCommand(agent: Agent): string {
  if (onPath(MARKER)) return `${MARKER} --agent ${agent}`;
  const here = fileURLToPath(import.meta.url);
  const entry = join(dirname(here), `hook-entry${here.endsWith(".ts") ? ".ts" : ".js"}`);
  return `"${process.execPath}" "${entry}" --agent ${agent} # ${MARKER}`;
}

interface HookGroup {
  matcher?: string;
  hooks: { type: string; command?: string; timeout?: number }[];
}

type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8").trim();
  return text ? (JSON.parse(text) as Settings) : {};
}

function isOurs(group: HookGroup): boolean {
  return group.hooks?.some((h) => MARKERS.some((m) => h.command?.includes(m))) ?? false;
}

function writeSettings(file: string, settings: Settings): void {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.bak-agent-deck`);
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

export function installHooks(agent: Agent): { file: string; changed: boolean } {
  const file = settingsFile(agent);
  const settings = readSettings(file);
  const command = hookCommand(agent);
  settings.hooks ??= {};
  let changed = false;
  for (const event of EVENTS) {
    const groups = (settings.hooks[event] ??= []);
    const ours = groups.find(isOurs);
    const want: HookGroup = { matcher: MATCHERS[agent], hooks: [{ type: "command", command, timeout: 30 }] };
    if (ours && JSON.stringify(ours) === JSON.stringify(want)) continue;
    if (ours) groups.splice(groups.indexOf(ours), 1, want);
    else groups.push(want);
    changed = true;
  }
  if (changed) writeSettings(file, settings);
  return { file, changed };
}

export function uninstallHooks(agent: Agent): { file: string; changed: boolean } {
  const file = settingsFile(agent);
  if (!existsSync(file)) return { file, changed: false };
  const settings = readSettings(file);
  let changed = false;
  for (const event of EVENTS) {
    const groups = settings.hooks?.[event];
    if (!groups) continue;
    const kept = groups.filter((g) => !isOurs(g));
    if (kept.length !== groups.length) {
      changed = true;
      if (kept.length) settings.hooks![event] = kept;
      else delete settings.hooks![event];
    }
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (changed) writeSettings(file, settings);
  return { file, changed };
}

export function agentInstalled(agent: Agent): boolean {
  return onPath(agent === "claude" ? "claude" : "codex") || existsSync(dirname(settingsFile(agent)));
}

// ---------------------------------------------------------------- status line

const STATUS_MARKER = "agent-deck-statusline";
const isOurStatus = (command: string | undefined) => !!command && [STATUS_MARKER, "agent-diff-statusline"].some((m) => command.includes(m));

/** How Claude Code should run the status line: the installed bin, else node + this checkout. */
function statusCommand(): string {
  if (onPath(STATUS_MARKER)) return STATUS_MARKER;
  const here = fileURLToPath(import.meta.url);
  const entry = join(dirname(here), `statusline-entry${here.endsWith(".ts") ? ".ts" : ".js"}`);
  return `"${process.execPath}" "${entry}" # ${STATUS_MARKER}`;
}

type StatusLine = { type?: string; command?: string; padding?: number };

/**
 * Sets Claude Code's status line to show the other sessions waiting on you. A status line someone
 * else set up is left alone: `skipped` then says what it runs.
 */
export function installStatusLine(): { file: string; changed: boolean; skipped?: string } {
  const file = settingsFile("claude");
  const settings = readSettings(file);
  const current = settings["statusLine"] as StatusLine | undefined;
  if (current && !isOurStatus(current.command)) return { file, changed: false, skipped: current.command ?? "another status line" };
  const want: StatusLine = { type: "command", command: statusCommand(), padding: 0 };
  if (JSON.stringify(current) === JSON.stringify(want)) return { file, changed: false };
  settings["statusLine"] = want;
  writeSettings(file, settings);
  return { file, changed: true };
}

export function uninstallStatusLine(): { file: string; changed: boolean } {
  const file = settingsFile("claude");
  if (!existsSync(file)) return { file, changed: false };
  const settings = readSettings(file);
  const current = settings["statusLine"] as StatusLine | undefined;
  if (!isOurStatus(current?.command)) return { file, changed: false };
  delete settings["statusLine"];
  writeSettings(file, settings);
  return { file, changed: true };
}

/** Marks a skill folder as ours, so only our own copies are replaced or removed. */
const SKILL_MARKER = ".installed-by-agent-deck";
const ours = (dir: string) => existsSync(join(dir, SKILL_MARKER)) || existsSync(join(dir, ".installed-by-agent-diff"));
/** Skills of ours that were renamed: removed when installing or uninstalling. */
const RENAMED = ["agent-diff-commit"];
const SKILLS = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

/** Claude Code reads ~/.claude/skills; Codex (and Gemini CLI) read ~/.agents/skills. */
export function skillDir(agent: Agent): string {
  return agent === "claude" ? join(process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude"), "skills") : join(homedir(), ".agents", "skills");
}

export function installSkills(agent: Agent): { dir: string; installed: string[]; skipped: string[] } {
  const dir = skillDir(agent);
  const result = { dir, installed: [] as string[], skipped: [] as string[] };
  for (const old of RENAMED) if (ours(join(dir, old))) rmSync(join(dir, old), { recursive: true, force: true });
  for (const skill of readdirSync(SKILLS)) {
    const dest = join(dir, skill);
    if (existsSync(dest) && !ours(dest)) {
      result.skipped.push(skill); // someone else's skill with the same name
      continue;
    }
    rmSync(dest, { recursive: true, force: true });
    cpSync(join(SKILLS, skill), dest, { recursive: true });
    writeFileSync(join(dest, SKILL_MARKER), "Installed by `agent-deck install`; removed by `agent-deck uninstall`.\n");
    result.installed.push(skill);
  }
  return result;
}

export function uninstallSkills(agent: Agent): string[] {
  const dir = skillDir(agent);
  const removed: string[] = [];
  for (const skill of [...readdirSync(SKILLS), ...RENAMED]) {
    if (!ours(join(dir, skill))) continue;
    rmSync(join(dir, skill), { recursive: true, force: true });
    removed.push(skill);
  }
  return removed;
}
