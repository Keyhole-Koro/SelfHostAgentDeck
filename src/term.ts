/** Terminal output helpers shared by the commands. */

const color = process.stdout.isTTY && !process.env["NO_COLOR"];
const paint = (code: string) => (s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
export const bold = paint("1");
export const dim = paint("2");
export const green = paint("32");
export const red = paint("31");
export const yellow = paint("33");
export const cyan = paint("36");

export function when(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ago(ms: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ms) / 6e4));
  return m < 60 ? `${m}m` : m < 60 * 48 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

/** Terminal columns a character takes: two for CJK and other wide characters. */
export const columns = (ch: string) => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u.test(ch) ? 2 : 1);

/** Text cut to `width` columns, from the left (keeping the end) or the right (keeping the start). */
export function fit(text: string, width: number, keep: "start" | "end" = "start"): string {
  const chars = [...text];
  const total = chars.reduce((n, c) => n + columns(c), 0);
  if (total <= width) return text;
  let used = 0;
  if (keep === "end") {
    let i = chars.length;
    while (i > 0 && used + columns(chars[i - 1]!) <= width - 1) used += columns(chars[--i]!);
    return "…" + chars.slice(i).join("");
  }
  let i = 0;
  while (i < chars.length && used + columns(chars[i]!) <= width - 1) used += columns(chars[i++]!);
  return chars.slice(0, i).join("") + "…";
}

/** `text` padded with spaces to `width` columns (after cutting it to fit). */
export function pad(text: string, width: number): string {
  const t = fit(text, width);
  return t + " ".repeat(Math.max(0, width - [...t].reduce((n, c) => n + columns(c), 0)));
}

/** The last non-empty line of `text`, cut from the left to fit `width` columns. */
export function oneLine(text: string, width: number): string {
  return fit(text.trim().split("\n").filter((l) => l.trim()).pop()?.trim() ?? "", width, "end");
}
