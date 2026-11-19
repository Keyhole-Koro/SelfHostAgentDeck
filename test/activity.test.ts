import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changes, snapshot } from "../src/activity.ts";
import type { Inbox, InboxItem } from "../src/inbox.ts";
import type { PrStatus } from "../src/prs.ts";

const item = (key: string, state: InboxItem["state"], more: Partial<InboxItem> = {}): InboxItem => ({ key, agent: "claude", id: key.split(":")[1]!, name: key, cwd: "/w/app", state, since: 1, resume: "", ...more });
const inbox = (...items: InboxItem[]): Inbox => ({ generatedAt: 0, staleAfter: 864e5, items });
const pr = (ci: PrStatus["ci"], state = "OPEN"): PrStatus => ({ url: "https://g/pr/7", number: 7, title: "Fix", state, draft: false, checks: { passed: 0, failed: 0, pending: 0 }, ci, at: 0 });
const kinds = (evs: { kind: string; key: string }[]) => evs.map((e) => `${e.key} ${e.kind}`);

describe("activity: what changed between two looks", () => {
  it("sets a baseline on the first look", () => {
    assert.deepEqual(changes(undefined, inbox(item("claude:a", "needs-answer")), {}), []);
  });

  it("tells when a session starts, asks, finishes its turn, ends", () => {
    const first = inbox(item("claude:a", "working"), item("claude:b", "working"), item("claude:c", "your-turn"));
    const next = inbox(
      item("claude:a", "needs-answer", { since: 2, questions: [{ question: "Which one?", options: [] }] }),
      item("claude:b", "your-turn", { since: 2, lastMessage: "Done.\nShall I push?" }),
      item("claude:d", "working", { lastPrompt: "Add tests" }),
    );
    const evs = changes(snapshot(first, {}), next, {}, 100);
    assert.deepEqual(kinds(evs), ["claude:a needs-answer", "claude:b your-turn", "claude:d started", "claude:c ended"]);
    assert.equal(evs[0]!.text, "Which one?");
    assert.equal(evs[1]!.text, "Shall I push?");
    assert.equal(evs[0]!.at, 100);
    assert.equal(evs[0]!.project, "app");
  });

  it("tells a new question while still waiting, but not the same one twice", () => {
    const a = inbox(item("claude:a", "needs-answer", { since: 1 }));
    assert.deepEqual(kinds(changes(snapshot(a, {}), a, {})), []);
    assert.deepEqual(kinds(changes(snapshot(a, {}), inbox(item("claude:a", "needs-answer", { since: 5 })), {})), ["claude:a needs-answer"]);
  });

  it("tells pull requests, their CI turning red or green, and pages, once seen change", () => {
    const prs = [{ url: "https://g/pr/7", number: 7, repo: "o/r" }];
    const page = { url: "https://pages/a/1", title: "Report", at: 1 };
    const before = inbox(item("claude:a", "working"));
    const opened = inbox(item("claude:a", "working", { prs, pages: [page] }));
    assert.deepEqual(kinds(changes(snapshot(before, {}), opened, {})), ["claude:a pr", "claude:a page"]);
    // The first status looked up is not news; a change after it is.
    assert.deepEqual(kinds(changes(snapshot(opened, {}), opened, { "https://g/pr/7": pr("failing") })), []);
    assert.deepEqual(kinds(changes(snapshot(opened, { "https://g/pr/7": pr("pending") }), opened, { "https://g/pr/7": pr("failing") })), ["claude:a ci-failed"]);
    assert.deepEqual(kinds(changes(snapshot(opened, { "https://g/pr/7": pr("failing") }), opened, { "https://g/pr/7": pr("passing") })), ["claude:a ci-passed"]);
  });

  it("marks what happened to a session put off", () => {
    const evs = changes(snapshot(inbox(item("claude:a", "working")), {}), inbox(item("claude:a", "your-turn", { hold: { kind: "done" } })), {});
    assert.equal(evs[0]!.held, true);
  });
});
