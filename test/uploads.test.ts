import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { safeName, saveUpload } from "../src/uploads.ts";

describe("files sent to a session", () => {
  it("land in the repository, where git never sees them", () => {
    const repo = mkdtempSync(join(tmpdir(), "adv-up-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const at = new Date(2026, 10, 19, 9, 5, 7);
    const a = saveUpload(repo, "screen shot.png", Buffer.from("png"), at);
    assert.equal(a.rel, ".agent-deck/uploads/20261119-090507-screen shot.png");
    assert.equal(readFileSync(a.path, "utf8"), "png");
    assert.equal(a.size, 3);
    const b = saveUpload(repo, "screen shot.png", Buffer.from("again"), at);
    assert.equal(b.rel, ".agent-deck/uploads/20261119-090507-2-screen shot.png", "never overwritten");
    assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf8" }), "");
  });

  it("keep only a safe name", () => {
    assert.equal(safeName("../../etc/passwd"), "passwd");
    assert.equal(safeName("C:\\\\Users\\\\me\\\\log.txt"), "log.txt");
    assert.equal(safeName("写真 (1).jpg"), "写真 (1).jpg");
    assert.equal(safeName("a$b|c?.md"), "a_b_c_.md");
    assert.equal(safeName(".hidden"), "hidden");
    assert.equal(safeName(""), "file");
  });
});
