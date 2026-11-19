/**
 * The choices an agent's dialog offers, read off its screen: Claude Code's permission prompts and
 * AskUserQuestion, Codex's approvals, plan approval. Mostly they are numbered lists at the bottom of
 * the screen ("❯ 1. Yes", "  2. Yes, and don't ask again …"). Claude Code leaves the numbers out
 * when its auto mode hands a call to you ("❯ Yes", "  No"); then the pointer, and the options level
 * with it, make the list. Only the last list near the bottom counts: a list in the agent's message
 * above is not a dialog.
 *
 * Picking one is done by moving the pointer to it and pressing Enter (see answer.ts), which works
 * whether the list is numbered or not.
 */

import { createHash } from "node:crypto";

export interface PromptChoice {
  /** Its place in the list, from "1": the number shown, when the list is numbered. */
  key: string;
  label: string;
  /** Where the dialog's pointer is. */
  selected?: boolean;
}

export interface ScreenPrompt {
  /** The line above the choices: "Do you want to proceed?". */
  question?: string;
  choices: PromptChoice[];
  /**
   * Which dialog it is: a digest of its options and the lines above them (the command it would
   * run), wherever the pointer is. Two prompts in a row with the same choices differ here.
   */
  sig: string;
}

/** How many lines above the options the digest takes in. */
const SIG_ABOVE = 8;

function sigOf(texts: string[]): string {
  const plain = texts.map((t) => t.replace(/^[❯›>▶●➜→]\s*/, "")).filter(Boolean);
  return createHash("sha256").update(plain.join("\n")).digest("hex").slice(0, 16);
}

/** How far up from the bottom (in non-empty lines) a dialog's choices may start. */
const NEAR_BOTTOM = 18;
const OPTION = /^([❯›>▶●➜→]\s*)?(\d)[.)]\s+(.+?)$/;
/** The pointer at the option a dialog would pick: Claude Code's ❯, Codex's ›. */
const POINTER = /^[❯›▶➜→]\s+(\S.*)$/;
const RULE = /^[─━═╭╮╰╯┌┐└┘\s-]+$/;

interface Line {
  text: string;
  indent: number;
}

export function parsePrompt(screen: string): ScreenPrompt | undefined {
  // Each line without the sides of the box dialogs are drawn in, keeping its indentation. A rule
  // across the screen separates, like a blank line.
  const lines: Line[] = screen.split("\n").map((raw) => {
    const inner = raw.replace(/^\s*[│┃║|]/, "").replace(/[│┃║|]\s*$/, "");
    const text = inner.trim();
    return RULE.test(text) ? { text: "", indent: 0 } : { text, indent: inner.length - inner.trimStart().length };
  });
  const filled = lines.flatMap((l, f) => (l.text ? [f] : []));
  const pointer = filled.slice(-NEAR_BOTTOM).reverse().find((f) => POINTER.test(lines[f]!.text));
  if (pointer !== undefined && !OPTION.test(lines[pointer]!.text)) {
    const p = unnumbered(lines, pointer);
    if (p) return p;
  }
  return numbered(lines.filter((l) => l.text));
}

function numbered(rows: Line[]): ScreenPrompt | undefined {
  let last = -1;
  for (let f = rows.length - 1; f >= Math.max(0, rows.length - NEAR_BOTTOM); f--) {
    if (OPTION.test(rows[f]!.text)) {
      last = f;
      break;
    }
  }
  if (last < 0) return undefined;
  const choices: PromptChoice[] = [];
  let first = last;
  for (let f = last; f >= 0; f--) {
    const m = OPTION.exec(rows[f]!.text);
    if (m) {
      choices.unshift({ key: m[2]!, label: m[3]!.trim(), ...(m[1] && { selected: true }) });
      first = f;
      if (m[2] === "1") break;
    } else if (rows[f]!.indent < 4) break; // deeper lines are an option's description
  }
  // A dialog's list counts from 1 without gaps.
  if (choices[0]?.key !== "1" || choices.some((c, n) => Number(c.key) !== n + 1)) return undefined;
  const above = rows[first - 1]?.text;
  const sig = sigOf(rows.slice(Math.max(0, first - SIG_ABOVE), last + 1).map((r) => r.text));
  return { ...(above && { question: above.replace(/^[☐☒✔✓□■◆◇•·]\s*/, "") }), choices, sig };
}

/**
 * Options without numbers: the one under the pointer and those whose text starts in the same
 * column, up to a blank line; lines further in are an option's description. It is a dialog only if
 * it asks something right above them ("Do you want to proceed?") or says how to leave it ("Esc to
 * cancel").
 */
function unnumbered(lines: Line[], at: number): ScreenPrompt | undefined {
  // Where an option's text starts: after the pointer, on the line that has it.
  const colOf = (f: number) => {
    const l = lines[f]!;
    const m = POINTER.exec(l.text);
    return l.indent + (m ? l.text.length - m[1]!.length : 0);
  };
  const col = colOf(at);
  const level = (f: number) => !!lines[f]!.text && colOf(f) === col;
  let first = at;
  let last = at;
  for (let f = at - 1; f >= 0 && lines[f]!.text && colOf(f) >= col; f--) if (level(f)) first = f;
  for (let f = at + 1; f < lines.length && lines[f]!.text && colOf(f) >= col; f++) if (level(f)) last = f;
  const choices: PromptChoice[] = [];
  for (let f = first; f <= last; f++) {
    if (!level(f)) continue;
    const m = POINTER.exec(lines[f]!.text);
    choices.push({ key: String(choices.length + 1), label: m ? m[1]!.trim() : lines[f]!.text, ...(m && { selected: true }) });
  }
  if (choices.length < 2 || choices.length > 9 || choices.filter((c) => c.selected).length !== 1) return undefined;
  // The question sits right above the options. Past a blank line or a rule it is the agent's last
  // message, and the "options" are lines of a reply being written in its input box.
  const above = lines[first - 1];
  const question = above?.text && colOf(first - 1) < col ? above.text : undefined;
  const leave = lines.slice(last + 1).some((l) => /\besc to (cancel|close|exit|go back|dismiss)\b/i.test(l.text));
  if (!question?.endsWith("?") && !leave) return undefined;
  const sig = sigOf(lines.slice(Math.max(0, first - SIG_ABOVE), last + 1).map((l) => l.text));
  return { ...(question && { question }), choices, sig };
}

/**
 * The buttons a notification of this dialog gets, where browsers show them (two at most): its
 * first and last choices, when it is a permission prompt (Yes … No). A question with options of
 * its own is answered on the page.
 */
export function noticeButtons(p: ScreenPrompt): { actions: { action: string; title: string }[]; choose: { sig: string; labels: Record<string, string> } } | undefined {
  const c = p.choices;
  const last = c.length - 1;
  if (c.length < 2 || c.length > 3 || !/^yes\b/i.test(c[0]!.label) || !/^no\b/i.test(c[last]!.label)) return undefined;
  const short = (l: string) => l.replace(/\s*\((?:esc|y|n|a)\)$/i, "").slice(0, 28);
  return {
    actions: [
      { action: "0", title: short(c[0]!.label) },
      { action: String(last), title: short(c[last]!.label) },
    ],
    choose: { sig: p.sig, labels: { "0": c[0]!.label, [String(last)]: c[last]!.label } },
  };
}
