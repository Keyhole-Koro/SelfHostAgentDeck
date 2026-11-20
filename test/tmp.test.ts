import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { tempDir } from "./tmp.ts";

const HELPER = pathToFileURL(join(import.meta.dirname, "tmp.ts")).href;

describe("the tests' temporary folders", () => {
  it("are removed when the test file's process ends, whether its tests passed, failed or crashed", () => {
    for (const [end, status] of [["", 0], ["process.exitCode = 1;", 1], ["process.exit(3);", 3], ["throw new Error('crashed');", 1]] as const) {
      const tmp = tempDir("adv-tmp-");
      const script = `
        import { existsSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        const { tempDir } = await import(${JSON.stringify(HELPER)});
        const made = [tempDir("adv-a-"), tempDir("adv-b-")];
        writeFileSync(join(made[0], "file"), "x");
        console.log(JSON.stringify(made.filter((d) => existsSync(d))));
        ${end}`;
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TMPDIR: tmp }, encoding: "utf8" });
      assert.equal(r.status, status, r.stderr);
      const made = JSON.parse(r.stdout) as string[];
      assert.equal(made.length, 2, "both were there while it ran");
      assert.ok(made.every((d) => d.startsWith(tmp + "/")), "made in the temporary folder");
      assert.deepEqual(readdirSync(tmp), [], `nothing left after ${end || "a normal end"}`);
    }
  });
});
