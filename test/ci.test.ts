import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ciFailure, cleanLog } from "../src/ci.ts";

describe("why CI failed", () => {
  it("cleans a failing log: no timestamps, no colours, a header where the step changes", () => {
    const raw = ["test\tRun tests\t2026-11-19T00:00:00.1234567Z \x1b[31mFAIL\x1b[0m a.test.ts", "test\tRun tests\t2026-11-19T00:00:01.0000000Z Expected 1, got 2", "lint\tRun lint\t2026-11-19T00:00:02.0000000Z 3 problems"].join("\n");
    assert.deepEqual(cleanLog(raw), ["── test › Run tests", "FAIL a.test.ts", "Expected 1, got 2", "── lint › Run lint", "3 problems"]);
  });

  it("reads the failing checks and the end of each failing run's log, with gh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adv-ci-"));
    const gh = join(dir, "gh");
    const checks = [
      { name: "test", bucket: "fail", link: "https://github.com/o/r/actions/runs/42/job/1" },
      { name: "test (22)", bucket: "fail", link: "https://github.com/o/r/actions/runs/42/job/2" },
      { name: "lint", bucket: "pass", link: "https://github.com/o/r/actions/runs/43/job/3" },
    ];
    writeFileSync(gh, `#!/bin/sh
case "$1 $2" in
  "pr checks") printf '%s\\n' '${JSON.stringify(checks)}'; exit 1 ;;
  "run view") [ "$3" = 42 ] && [ "$5" = o/r ] && printf 'test\\tRun tests\\t2026-11-19T00:00:00.0Z Expected 1, got 2\\n' ;;
esac
`);
    chmodSync(gh, 0o755);
    process.env["AGENT_DECK_GH"] = gh;
    const r = await ciFailure("https://github.com/o/r/pull/7");
    assert.deepEqual(r.checks.map((c) => c.name), ["test", "test (22)"]);
    assert.equal(r.log, "── test › Run tests\nExpected 1, got 2", "one log per run, not per job");
  });
});
