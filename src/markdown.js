/**
 * Markdown to HTML, for agents' messages and Markdown files on the page (it is inlined into the
 * page's script). Everything is escaped first; only the Markdown agents write becomes tags:
 * headings, lists with task boxes, quotes, tables, fenced code, rules, emphasis, code and links.
 * Web links open in a new tab. What names a file (in a link, in `code`, or an absolute path in
 * the text) becomes a link with data-file, which the page opens itself. Other schemes
 * (javascript:, data:) stay text.
 */
function markdown(src) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const EXT = /\.(?:[cm]?[jt]sx?|jsonl?|md|mdx|markdown|txt|html?|css|scss|py|rb|go|rs|java|kts?|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ya?ml|toml|ini|conf|cfg|sql|graphql|proto|vue|svelte|astro|png|jpe?g|gif|svg|webp|pdf|csv|tsv|xml|lock|log|tf|lua|ex|exs|dart|nix|zig|tex|ipynb)$/i;

  /** The file a string names ("src/a.ts:12" → "src/a.ts"), or null. */
  function filePath(s) {
    let t = String(s).trim().replace(/^file:\/\//, "");
    if (!t || t.length > 300 || /[\s<>"'`|*?{}\\]/.test(t) || /^[a-z][a-z0-9+.-]*:/i.test(t)) return null;
    t = t.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, "");
    const segments = t.split("/").filter(Boolean).length;
    if (t.startsWith("/")) return segments >= 3 || EXT.test(t) ? t : null;
    if (t.startsWith("./") || t.startsWith("../") || t.startsWith("~/")) return t;
    if (t.includes("/")) return EXT.test(t) || t.endsWith("/") ? t : null;
    return EXT.test(t) ? t : null;
  }

  const fileLink = (path, label) => `<a href="#" class="file" data-file="${esc(path)}">${label}</a>`;
  const webLink = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;

  function link(text, dest, image) {
    dest = dest.replace(/^<|>$/g, "").trim();
    const label = text ? spans(text) : esc(dest);
    if (/^https?:\/\//i.test(dest)) return webLink(dest, image ? `${label || "image"} ↗` : label);
    const p = filePath(dest);
    return p ? fileLink(p, label || esc(p)) : label;
  }

  /**
   * Links, bare URLs and paths, and emphasis; `code` was taken out before (see inline). A link's
   * address never takes in where code was: the code goes back in as tags, so in text only.
   */
  function spans(s) {
    const re = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n\u0000]*>|[^\s()\u0000]*(?:\([^\s()\u0000]*\)[^\s()\u0000]*)*)(?:\s+"[^"\n]*")?\s*\)|<(https?:\/\/[^\s<>\u0000]+)>|(https?:\/\/[\w\-.~:/?#[\]@!$&*+,;=%()]*[\w\-~/#@$&*+=%])|(?<=^|[\s(（「『:：])(\/[\w.@+~%-]+(?:\/[\w.@+~%-]+)+)|\*\*(?=\S)([\s\S]*?\S)\*\*|~~(?=\S)([\s\S]*?\S)~~|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g;
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      out += esc(s.slice(last, m.index));
      if (m[3] !== undefined) out += link(m[2], m[3], m[1] === "!");
      else if (m[4] || m[5]) out += webLink(m[4] || m[5], esc(m[4] || m[5]));
      else if (m[6]) {
        const p = filePath(m[6]);
        out += p ? fileLink(p, esc(m[6])) : esc(m[6]);
      } else if (m[7] !== undefined) out += `<strong>${spans(m[7])}</strong>`;
      else if (m[8] !== undefined) out += `<del>${spans(m[8])}</del>`;
      else out += `<em>${spans(m[9] ?? m[10])}</em>`;
      last = re.lastIndex;
    }
    return out + esc(s.slice(last));
  }

  /**
   * Inline Markdown. Code spans are set aside first, so emphasis around them still pairs up; a
   * \u0000 in the text itself is dropped (as the page would drop it), so only the marks they
   * leave (\u0000n\u0000) are put back.
   */
  function inline(s) {
    const codes = [];
    const held = String(s).replace(/\u0000/g, "").replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, ticks, body) => {
      const code = body.replace(/^ (.*[^ ].*) $/, "$1");
      const p = filePath(code);
      codes.push(`<code>${p ? fileLink(p, esc(code)) : esc(code)}</code>`);
      return `\u0000${codes.length - 1}\u0000`;
    });
    return spans(held).replace(/\u0000(\d+)\u0000/g, (_, n) => codes[Number(n)]);
  }

  const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^\s{0,3}>/;
  const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
  const isTable = (lines, i) => lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("-") && DIVIDER.test(lines[i + 1]);
  const starts = (lines, i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i]) || QUOTE.test(lines[i]) || LIST.test(lines[i]) || isTable(lines, i);
  const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

  function list(lines, i) {
    const first = LIST.exec(lines[i]);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const start = ordered ? parseInt(first[2], 10) : 1;
    const items = [];
    let col = 0;
    while (i < lines.length) {
      const m = LIST.exec(lines[i]);
      if (m && m[1].length === indent && /\d/.test(m[2]) === ordered) {
        items.push([m[3]]);
        col = indent + m[2].length + 1;
        i++;
        continue;
      }
      if (!lines[i].trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const next = j < lines.length ? LIST.exec(lines[j]) : null;
        if (j < lines.length && (lines[j].search(/\S/) > indent || (next && next[1].length === indent && /\d/.test(next[2]) === ordered))) {
          items[items.length - 1].push("");
          i++;
          continue;
        }
        break;
      }
      const lead = lines[i].search(/\S/);
      if (lead > indent) {
        items[items.length - 1].push(lines[i].slice(Math.min(lead, col)));
        i++;
        continue;
      }
      break;
    }
    const lis = items.map((body) => {
      let head = body[0];
      let box = "";
      const task = /^\[([ xX])\]\s+/.exec(head);
      if (task) {
        box = task[1] === " " ? '<span class="task">☐</span> ' : '<span class="task done">☑</span> ';
        head = head.slice(task[0].length);
      }
      const rest = body.slice(1);
      while (rest.length && !rest[rest.length - 1].trim()) rest.pop();
      if (!rest.length) return `<li>${box}${inline(head)}</li>`;
      return `<li>${box}${blocks([head, ...rest])}</li>`;
    });
    const tag = ordered ? "ol" : "ul";
    return [`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>${lis.join("")}</${tag}>`, i];
  }

  function blocks(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      let m = FENCE.exec(line);
      if (m) {
        const close = new RegExp(`^\\s{0,3}${m[2][0] === "`" ? "`" : "~"}{${m[2].length},}\\s*$`);
        const body = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) body.push(lines[i++].replace(new RegExp(`^ {0,${m[1].length}}`), ""));
        i++;
        out.push(`<pre class="code"${m[3] ? ` data-lang="${esc(m[3])}"` : ""}><code>${esc(body.join("\n"))}</code></pre>`);
        continue;
      }
      if ((m = HEADING.exec(line))) {
        out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
        i++;
        continue;
      }
      if (RULE.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }
      if (QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}> ?/, ""));
        out.push(`<blockquote>${blocks(body)}</blockquote>`);
        continue;
      }
      if (isTable(lines, i)) {
        const head = cells(line);
        const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : ""));
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(cells(lines[i++]));
        const cell = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c)}</${tag}>`;
        out.push(`<div class="table"><table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => cell("td", r[k] ?? "", k)).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }
      if (LIST.test(line)) {
        const [html, next] = list(lines, i);
        out.push(html);
        i = next;
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && (!para.length || !starts(lines, i))) para.push(lines[i++].trim());
      out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
    }
    return out.join("");
  }

  return blocks(String(src ?? "").replace(/\r\n?/g, "\n").split("\n"));
}
