import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { noticeButtons, parsePrompt as parse } from "../src/prompts.ts";

/** The parsed dialog, without its digest (tested on its own below). */
const parsePrompt = (screen: string) => {
  const p = parse(screen);
  if (p) assert.match(p.sig, /^[0-9a-f]{16}$/);
  return p && (({ sig: _, ...rest }) => rest)(p);
};

describe("choices on an agent's screen", () => {
  it("reads Claude Code's permission prompt, inside its box", () => {
    const screen = [
      "● I'll run the tests.",
      "",
      "╭──────────────────────────────────────────────╮",
      "│ Bash command                                   │",
      "│                                                │",
      "│   npm test                                     │",
      "│   Run the tests                                │",
      "│                                                │",
      "│ Do you want to proceed?                        │",
      "│ ❯ 1. Yes                                       │",
      "│   2. Yes, and don't ask again for npm test commands in /w/app │",
      "│   3. No, and tell Claude what to do differently (esc) │",
      "╰──────────────────────────────────────────────╯",
    ].join("\n");
    assert.deepEqual(parsePrompt(screen), {
      question: "Do you want to proceed?",
      choices: [
        { key: "1", label: "Yes", selected: true },
        { key: "2", label: "Yes, and don't ask again for npm test commands in /w/app" },
        { key: "3", label: "No, and tell Claude what to do differently (esc)" },
      ],
    });
  });

  it("reads a question's options, skipping their descriptions", () => {
    const screen = [
      "☐ Layout",
      "",
      "Which layout do you want?",
      "",
      "❯ 1. Two panes (Recommended)",
      "     The list on the left, the session on the right.",
      "  2. Three columns",
      "     Details beside the conversation.",
      "  3. Type something.",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    const p = parsePrompt(screen)!;
    assert.equal(p.question, "Which layout do you want?");
    assert.deepEqual(p.choices.map((c) => `${c.key} ${c.label}`), ["1 Two panes (Recommended)", "2 Three columns", "3 Type something."]);
  });

  it("reads Codex's approval", () => {
    const screen = ["Would you like to run the following command?", "", "  $ rm -rf dist", "", "› 1. Yes, proceed (y)", "  2. Yes, and don't ask again for this command (a)", "  3. No, and tell Codex what to do differently (esc)"].join("\n");
    assert.deepEqual(parsePrompt(screen)!.choices.map((c) => c.key), ["1", "2", "3"]);
    assert.equal(parsePrompt(screen)!.question, "$ rm -rf dist");
  });

  it("reads a permission prompt without numbers, as auto mode hands it over", () => {
    const screen = [
      "● I'll clean the build.",
      "",
      "──────────────────────────────────────────────",
      " Bash command",
      "",
      "   rm -rf build",
      "   Remove the build folder",
      "",
      " Do you want to proceed?",
      " ❯ Yes",
      "   No",
      "",
      " Esc to cancel · Tab to amend · ctrl+e to explain",
    ].join("\n");
    assert.deepEqual(parsePrompt(screen), {
      question: "Do you want to proceed?",
      choices: [
        { key: "1", label: "Yes", selected: true },
        { key: "2", label: "No" },
      ],
    });
  });

  it("finds the pointer on any option, and skips descriptions under them", () => {
    const screen = [" Do you want to proceed?", "   Yes", "     Run it this once", " ❯ No", "     Tell Claude what to do instead", "", " Esc to cancel"].join("\n");
    assert.deepEqual(parsePrompt(screen)!.choices, [{ key: "1", label: "Yes" }, { key: "2", label: "No", selected: true }]);
  });

  it("does not take the reply box, or one line under a pointer, for a dialog", () => {
    const idle = ["● Done.", "──────────────────", "❯ fix the tests", "──────────────────", "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
    assert.equal(parsePrompt(idle), undefined);
    const listed = ["Two ways:", "❯ keep it", "  drop it", "", "Your call."].join("\n");
    assert.equal(parsePrompt(listed), undefined, "neither asks nor says how to leave");
  });

  it("does not take a reply of two lines, being written under the agent's question, for a dialog", () => {
    const codex = ["• Should I also update the README?", "", "› sure, and also", "  bump the version", "", "  ⏎ send   ⌃J newline"].join("\n");
    assert.equal(parsePrompt(codex), undefined);
    const claude = ["⏺ Done. Want me to commit this?", "──────────", "❯ yes but first rename the helper", "  and then run the linter", "──────────", "  Press Esc again to clear"].join("\n");
    assert.equal(parsePrompt(claude), undefined);
  });

  it("tells two dialogs with the same choices apart, wherever the pointer is", () => {
    const ask = (command: string, pointer: 0 | 1) => [" Bash command", "", `   ${command}`, "", " Do you want to proceed?", pointer ? "   Yes" : " ❯ Yes", pointer ? " ❯ No" : "   No", "", " Esc to cancel"].join("\n");
    assert.equal(parse(ask("rm -rf build", 0))!.sig, parse(ask("rm -rf build", 1))!.sig);
    assert.notEqual(parse(ask("rm -rf build", 0))!.sig, parse(ask("rm -rf src", 0))!.sig);
    const numbered = (command: string) => [command, "Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n");
    assert.notEqual(parse(numbered("npm test"))!.sig, parse(numbered("npm publish"))!.sig);
  });

  it("puts Yes and No on a permission prompt's notification, and nothing on a question's", () => {
    const codex = parse(["Would you like to run the following command?", "", "  $ rm -rf dist", "", "› 1. Yes, proceed (y)", "  2. Yes, and don't ask again for this command (a)", "  3. No, and tell Codex what to do differently (esc)"].join("\n"))!;
    const b = noticeButtons(codex)!;
    assert.deepEqual(b.actions, [
      { action: "0", title: "Yes, proceed" },
      { action: "2", title: "No, and tell Codex what to d" },
    ]);
    assert.deepEqual(b.choose, { sig: codex.sig, labels: { "0": "Yes, proceed (y)", "2": "No, and tell Codex what to do differently (esc)" } });
    assert.equal(noticeButtons(parse(["Which layout?", "❯ 1. Two panes", "  2. Three columns"].join("\n"))!), undefined);
  });

  it("finds no dialog in a numbered list far above, or one that does not start at 1", () => {
    const message = ["Next steps:", "1. Add the schema", "2. Write the helper", ...Array.from({ length: 20 }, (_, n) => `line ${n}`), "> "].join("\n");
    assert.equal(parsePrompt(message), undefined);
    assert.equal(parsePrompt(["Pick:", "  2. B", "  3. C"].join("\n")), undefined);
    assert.equal(parsePrompt(""), undefined);
  });
});
