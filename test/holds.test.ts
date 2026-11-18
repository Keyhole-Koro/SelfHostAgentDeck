import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { applyHolds, hold, parseUntil, readHolds, release } from "../src/holds.ts";
import type { Inbox, InboxItem } from "../src/inbox.ts";

const NOW = Date.parse("2026-11-19T10:00:00");

function item(key: string, state: InboxItem["state"], since = NOW - 1000, extra: Partial<InboxItem> = {}): InboxItem {
  return { key, agent: "claude", id: key.split(":")[1]!, name: key.split(":")[1]!, cwd: "/w", state, since, resume: "", ...extra };
}
const inbox = (...items: InboxItem[]): Inbox => ({ generatedAt: NOW, staleAfter: 864e5, items });

beforeEach(() => {
  process.env["AGENT_DIFF_STATE_DIR"] = mkdtempSync(join(tmpdir(), "adv-state-"));
});

describe("holds", () => {
  it("keeps a session off the list until it moves on", () => {
    const a = item("claude:a", "your-turn");
    hold(a, "done", undefined, NOW);
    const same = inbox(item("claude:a", "your-turn"));
    applyHolds(same);
    assert.deepEqual(same.items[0]?.hold, { kind: "done" });

    const moved = inbox(item("claude:a", "your-turn", NOW)); // a new turn ended
    applyHolds(moved);
    assert.equal(moved.items[0]?.hold, undefined);
    assert.deepEqual(readHolds(), {}, "the hold is forgotten");
  });

  it("is not lifted by your turn merely turning stale", () => {
    hold(item("claude:a", "your-turn"), "done", undefined, NOW);
    const later = inbox(item("claude:a", "stale"));
    applyHolds(later, NOW + 2 * 864e5);
    assert.deepEqual(later.items[0]?.hold, { kind: "done" });
  });

  it("ends a 'later' when its time comes", () => {
    hold(item("claude:a", "needs-answer"), "later", NOW + 36e5, NOW);
    const before = inbox(item("claude:a", "needs-answer"));
    applyHolds(before, NOW + 1000);
    assert.deepEqual(before.items[0]?.hold, { kind: "later", until: NOW + 36e5 });
    const after = inbox(item("claude:a", "needs-answer"));
    applyHolds(after, NOW + 36e5);
    assert.equal(after.items[0]?.hold, undefined);
  });

  it("forgets holds of sessions that are gone, and releases on request", () => {
    hold(item("claude:gone", "your-turn"), "done");
    hold(item("claude:b", "your-turn"), "done");
    applyHolds(inbox(item("claude:b", "your-turn")));
    assert.deepEqual(Object.keys(readHolds()), ["claude:b"]);
    assert.equal(release("claude:b"), true);
    assert.equal(release("claude:b"), false);
  });

  it("reads times: relative, tomorrow, a clock time, a date", () => {
    assert.equal(parseUntil("2h", NOW), NOW + 2 * 36e5);
    assert.equal(parseUntil("30m", NOW), NOW + 30 * 6e4);
    assert.equal(parseUntil("tomorrow", NOW), Date.parse("2026-11-20T09:00:00"));
    assert.equal(parseUntil("13:30", NOW), Date.parse("2026-11-19T13:30:00"));
    assert.equal(parseUntil("9:00", NOW), Date.parse("2026-11-20T09:00:00"), "a time already past today means tomorrow");
    assert.equal(parseUntil("2026-12-01 08:00", NOW), Date.parse("2026-12-01 08:00"));
    assert.throws(() => parseUntil("someday", NOW), /Cannot read/);
  });
});
