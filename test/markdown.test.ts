import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

/** The page's Markdown renderer (a plain script inlined into the page), run on its own. */
const ctx: { markdown?: (s: string) => string } = {};
runInNewContext(readFileSync(join(import.meta.dirname, "..", "src", "markdown.js"), "utf8") + "\nthis.markdown = markdown;", ctx);
const md = ctx.markdown!;

describe("markdown", () => {
  it("renders what agents write: headings, lists, tasks, quotes, tables, code, rules", () => {
    const html = md(
      [
        "## Plan",
        "",
        "Two steps:",
        "1. Read **all** of `src/a.ts`",
        "2. Fix it",
        "   - nested *note*",
        "",
        "- [x] done",
        "- [ ] todo",
        "",
        "> quoted",
        "",
        "| File | Lines |",
        "|------|------:|",
        "| a.ts | 12 |",
        "",
        "```ts",
        "const x = 1 < 2;",
        "```",
        "---",
        "line one",
        "line two",
      ].join("\n"),
    );
    assert.equal(
      html,
      [
        "<h2>Plan</h2>",
        "<p>Two steps:</p>",
        '<ol><li>Read <strong>all</strong> of <code><a href="#" class="file" data-file="src/a.ts">src/a.ts</a></code></li><li><p>Fix it</p><ul><li>nested <em>note</em></li></ul></li></ol>',
        '<ul><li><span class="task done">☑</span> done</li><li><span class="task">☐</span> todo</li></ul>',
        "<blockquote><p>quoted</p></blockquote>",
        '<div class="table"><table><thead><tr><th>File</th><th style="text-align:right">Lines</th></tr></thead><tbody><tr><td>a.ts</td><td style="text-align:right">12</td></tr></tbody></table></div>',
        '<pre class="code" data-lang="ts"><code>const x = 1 &lt; 2;</code></pre>',
        "<hr>",
        "<p>line one<br>line two</p>",
      ].join(""),
    );
  });

  it("escapes HTML, and links only the web and files", () => {
    assert.equal(md("<img src=x onerror=alert(1)>"), "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
    assert.equal(md("[click](javascript:alert(1))"), "<p>click</p>");
    assert.equal(md("[x](data:text/html,hi)"), "<p>x</p>");
    assert.equal(md('[docs](https://example.com/a?b=1&c="2")'), '<p><a href="https://example.com/a?b=1&amp;c=&quot;2&quot;" target="_blank" rel="noopener noreferrer">docs</a></p>');
    assert.equal(md("see https://example.com/x。次へ"), '<p>see <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>。次へ</p>');
    assert.equal(md('**"quoted"** & <b>'), "<p><strong>&quot;quoted&quot;</strong> &amp; &lt;b&gt;</p>");
  });

  it("turns paths into file links: in links, in code, and absolute ones in the text", () => {
    assert.equal(md("[メモ](</home/me/w/notes.md>)"), '<p><a href="#" class="file" data-file="/home/me/w/notes.md">メモ</a></p>');
    assert.equal(md("wrote /home/me/w/out.md, then"), '<p>wrote <a href="#" class="file" data-file="/home/me/w/out.md">/home/me/w/out.md</a>, then</p>');
    assert.equal(md("`src/server.ts:42`"), '<p><code><a href="#" class="file" data-file="src/server.ts">src/server.ts:42</a></code></p>');
    assert.equal(md("`README.md` and `item.cwd` and `/api/chat` and `node:fs`"), '<p><code><a href="#" class="file" data-file="README.md">README.md</a></code> and <code>item.cwd</code> and <code>/api/chat</code> and <code>node:fs</code></p>');
    assert.equal(md("**Fix `a.ts`** now"), '<p><strong>Fix <code><a href="#" class="file" data-file="a.ts">a.ts</a></code></strong> now</p>');
  });

  it("keeps code out of a link's address, where it would break the tag", () => {
    const code = (p: string) => `<code><a href="#" class="file" data-file="${p}">${p}</a></code>`;
    const web = (u: string) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`;
    assert.equal(md("<https://a.com/`a.ts`>"), `<p>&lt;${web("https://a.com/")}${code("a.ts")}&gt;</p>`);
    assert.equal(md("[y](https://a.com/`src/a.ts`)"), `<p>[y](${web("https://a.com/")}${code("src/a.ts")})</p>`);
    assert.equal(md("[y](./`a.ts`)"), `<p>[y](./${code("a.ts")})</p>`);
    assert.equal(md("see `x` and \u00000\u0000 here"), "<p>see <code>x</code> and 0 here</p>", "a code span is shown once, where it was");
  });

  it("leaves globs, snake_case and lone markers alone", () => {
    assert.equal(md("*.ts and *.js, snake_case_name, 2 * 3"), "<p>*.ts and *.js, snake_case_name, 2 * 3</p>");
    assert.equal(md("_just this_ word"), "<p><em>just this</em> word</p>");
  });
});
