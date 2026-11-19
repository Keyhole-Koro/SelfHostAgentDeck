/**
 * The choices an agent's dialog offers, read off its screen: Claude Code's permission prompts and
 * AskUserQuestion, Codex's approvals, plan approval. They are numbered lists at the bottom of the
 * screen ("❯ 1. Yes", "  2. Yes, and don't ask again …"); each number is the key that picks it.
 * Only the last list near the bottom counts: a list in the agent's message above is not a dialog.
 */

export interface PromptChoice {
  /** The key that picks it: "1" to "9". */
  key: string;
  label: string;
  /** Where the dialog's cursor is. */
  selected?: boolean;
}

export interface ScreenPrompt {
  /** The line above the choices: "Do you want to proceed?". */
  question?: string;
  choices: PromptChoice[];
}

/** How far up from the bottom (in non-empty lines) a dialog's choices may start. */
const NEAR_BOTTOM = 18;
const OPTION = /^([❯›>▶●➜→]\s*)?(\d)[.)]\s+(.+?)$/;
const RULE = /^[─━═╭╮╰╯┌┐└┘\s-]+$/;

export function parsePrompt(screen: string): ScreenPrompt | undefined {
  // Each line without the sides of the box dialogs are drawn in, keeping its indentation.
  const rows = screen
    .split("\n")
    .map((raw) => {
      const inner = raw.replace(/^\s*[│┃║|]/, "").replace(/[│┃║|]\s*$/, "");
      return { text: inner.trim(), indent: inner.length - inner.trimStart().length };
    })
    .filter((r) => r.text && !RULE.test(r.text));
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
  return { ...(above && { question: above.replace(/^[☐☒✔✓□■◆◇•·]\s*/, "") }), choices };
}
