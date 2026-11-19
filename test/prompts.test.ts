import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePrompt } from "../src/prompts.ts";

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

  it("finds no dialog in a numbered list far above, or one that does not start at 1", () => {
    const message = ["Next steps:", "1. Add the schema", "2. Write the helper", ...Array.from({ length: 20 }, (_, n) => `line ${n}`), "> "].join("\n");
    assert.equal(parsePrompt(message), undefined);
    assert.equal(parsePrompt(["Pick:", "  2. B", "  3. C"].join("\n")), undefined);
    assert.equal(parsePrompt(""), undefined);
  });
});
