import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { safeName, saveUpload } from "../src/uploads.ts";
import { tempDir } from "./tmp.ts";

describe("files sent to a session", () => {
  it("land in the repository, where git never sees them", () => {
    const repo = tempDir("adv-up-");
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

  it("never go through a link the repository carries to a folder outside it", () => {
    const outside = tempDir("adv-out-");
    const linked = tempDir("adv-up-");
    symlinkSync(outside, join(linked, ".agent-deck"));
    assert.throws(() => saveUpload(linked, "evil.desktop", Buffer.from("x")), /\.agent-deck is a link or a file, not a folder/);
    const inner = tempDir("adv-up-");
    mkdirSync(join(inner, ".agent-deck"));
    symlinkSync(outside, join(inner, ".agent-deck", "uploads"));
    assert.throws(() => saveUpload(inner, "evil.desktop", Buffer.from("x")), /uploads is a link or a file, not a folder/);
    const dangling = tempDir("adv-up-");
    symlinkSync(join(outside, "made"), join(dangling, ".agent-deck"));
    assert.throws(() => saveUpload(dangling, "evil.desktop", Buffer.from("x")), /not a folder/);
    assert.deepEqual(readdirSync(outside), [], "nothing was written outside");
  });

  it("leave a .gitignore that is a link alone, and never create what it points to", () => {
    const outside = tempDir("adv-out-");
    const repo = tempDir("adv-up-");
    mkdirSync(join(repo, ".agent-deck"));
    symlinkSync(join(outside, "planted"), join(repo, ".agent-deck", ".gitignore"));
    const up = saveUpload(repo, "notes.txt", Buffer.from("notes"));
    assert.equal(readFileSync(up.path, "utf8"), "notes");
    assert.ok(lstatSync(join(repo, ".agent-deck", ".gitignore")).isSymbolicLink());
    assert.deepEqual(readdirSync(outside), []);
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
