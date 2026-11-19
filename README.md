# AgentDiffViewer

When several Claude Code and Codex sessions work in the same checkout, `git status` mixes their
changes. `agent-diff` tells you which session made each change, down to the hunk. It shows this
in a local diff viewer or in the terminal, and it can stage exactly one session's work.

![agent-diff view: sessions on the left, the hunks each one made on the right](docs/screenshots/viewer.png)

It works from two sources that fill each other's gaps:

- **Transcripts.** Claude Code (`~/.claude/projects`) and Codex (`~/.codex/sessions`) already
  log every edit. This works with no setup, for past sessions too.
- **Hooks** (optional, `agent-diff install`). These record the files' contents before and after
  every tool call, so shell commands, code generators and scripts are attributed exactly.

## Install

Node 22.18 or later.

```bash
npm i -g agent-diff-viewer
agent-diff install        # optional: hooks + a skill for Claude Code and Codex
agent-diff install --statusline   # also: the sessions waiting on you, in Claude Code's status line
```

`install` adds:

- a PreToolUse/PostToolUse hook to `~/.claude/settings.json` and `~/.codex/hooks.json`;
- the `agent-diff-commit` skill to `~/.claude/skills` and `~/.agents/skills`;
- with `--statusline`, Claude Code's `statusLine`, unless you already have one.

It leaves your other hooks alone and keeps a `.bak-agent-diff` backup. In Codex, run `/hooks` once
and trust the hook. `agent-diff uninstall` removes all of it.

## Viewer

```bash
agent-diff view                 # prints a http://127.0.0.1:… URL to open
agent-diff view --since today   # start with a wider range
```

The left side groups the sessions by project: a repository together with its worktrees. Projects
with a session waiting on you come first. Within a project the sessions are sorted by what they
need from you (see [Waiting on you](#waiting-on-you)), then come the sessions that ended but left
changes in this repository; idle ones are folded away. `agent-diff inbox --view` is the same page
started anywhere: it then shows the changes of running sessions only.

Picking a session shows it in tabs:

| Tab | Shows |
|---|---|
| Conversation | What you and the session said, newest at the bottom; scroll up for earlier pages. Its tool calls fold into one line per run (open it for each step; the last run shows its latest step), and recaps, compactions and interruptions show where they happened. What it asks, and the reply box, stay at the bottom |
| Changes | The hunks it made in its working tree, each with how sure the attribution is |
| Files | Its repository, read-only: folders, Markdown rendered, code with line numbers, images. Paths in the conversation open here |
| Details | Its tasks, background commands, pull requests, the pages it published, its context, and how to resume it. On a wide screen this is a column beside the conversation instead of a tab |

On a phone the page shows the list, then one session full screen with Back; on a tablet, the list
and the session side by side.

Files stay inside the session's repository (its own folder outside one), never `.git`, and never
files that commonly hold secrets (`.env`, keys, credentials, `tfstate`); a session that runs in
your home folder shows none.

The buttons above the changes choose the range:

| Range | Shows |
|---|---|
| Uncommitted (default) | The working tree and the index vs HEAD |
| 1 hour / Today / 7 days, or `3h`, `2026-10-19 09:00` | Everything since the commit that was HEAD then, including later commits. Only sessions active since that time are considered |
| A branch or commit, e.g. `main` | Everything since that commit |

In the uncommitted range, **Stage this session's changes** shows what would be added, then
stages it. That means whole files the session alone changed, plus only its own hunks of files
shared with other sessions.

The server listens on 127.0.0.1 only. Every request needs the random token in the printed URL,
so other web pages can't read your diffs. Nothing leaves your machine.

## Waiting on you

```bash
agent-diff inbox                   # in the terminal, from any directory
agent-diff inbox --view            # as a web page that refreshes every 5 seconds
agent-diff inbox --watch --notify  # a desktop notification when a session starts waiting
```

With many sessions open, the hard part is knowing which ones are blocked on you. The inbox lists
every running Claude Code and Codex session, in every repository, sorted by what it needs:

| Section | Means |
|---|---|
| Needs an answer | A permission (`approve Bash: npm test`), an AskUserQuestion (with its options), a background session blocked on you (with what it needs), or a Codex command that may wait for approval |
| Your turn | The session finished its turn: its recap and last reply are shown, marked "?" when the reply ends with a question |
| Working | Running a turn, or waiting for a background command it started |
| Idle for over 1 day | Your turn, but untouched for a day (`--stale 4h` to change it). Folded away |

For each session it also shows, when the transcript says so:

- **its title** (what it works on) and **your last prompt**, so you know which session it is;
- **"While you were away"**: the recap Claude Code writes after a turn, until you prompt again;
- **its task list** (`3/7`), **background commands** still running (and for how long), and
  **pull requests** it opened, with their CI and review state (looked up with `gh`). Agents keep
  a task list on their own only for bigger jobs; to see progress more often, add to your
  `CLAUDE.md`: *"For work with more than two steps, keep a task list (TaskCreate / TaskUpdate)
  and update it as you go."*
- **its context**: tokens in use, against the model's window (Codex) or the point where it last
  compacted (Claude Code), so you see which session will compact soon;
- **shared files**: files another running session also has uncommitted changes in;
- **pages it published** with the `artifact` tool or CLI of
  [SelfHostArtifacts](https://github.com/Keyhole-Koro/SelfHostArtifacts) (or as a claude.ai
  artifact), as links;
- for Codex, how much of the 5-hour and weekly limits is used.

Done with one for now? **Later** takes it off the list for an hour, until tomorrow, or
`--until 9:00`; **Done** until it does something new. Both come back by themselves as soon as the
session moves on.

```bash
agent-diff later 4f2a9c1e --until tomorrow
agent-diff done 4f2a9c1e
agent-diff unhold 4f2a9c1e
```

### Answering from the page (herdr)

When a session runs in a [herdr](https://herdr.dev) pane, the page can act on it, on your click:
**Go to its pane**, **send it a prompt**, and, when it asks something, **show its screen** and
send the key that answers (`1`, `2`, `↑`, `Enter`, `Esc`, `y`, `n` …). herdr also sees Codex's
approval prompts, which Codex itself does not log. Nothing is sent without a click; `--no-herdr`
turns this off.

In the changes view, **Comment** on any hunk; the comments go to the session as one review
request (through herdr), or to the clipboard to paste.

### In Claude Code's status line

```bash
agent-diff install --statusline
```

shows the other sessions waiting on you under the prompt of the one you are in:
`⏳ 1 needs an answer (Shop checkout: approve Bash: terraform apply) · 2 your turn`. A status
line you already have is left alone; add `agent-diff statusline` to it yourself.

### Before editing a file another session changed

With the hooks installed, when Claude Code is about to edit a file that another running session
has uncommitted changes in, the hook tells it so (once per new change of the other session), so
it keeps their edits and stages only its own.

### Cleaning up

```bash
agent-diff cleanup
```

lists sessions left idle (with the memory each holds) and worktrees nobody uses any more
(merged or with their remote branch deleted, clean, no session in them), with the commands to
close or remove them. It runs none of them. The page has the same under **Clean up**.

### On your phone

```bash
agent-diff inbox --publish            # once
agent-diff inbox --watch --publish    # again on every change, at most every 30 seconds
```

publishes a snapshot of the inbox with [SelfHostArtifacts](https://github.com/Keyhole-Koro/SelfHostArtifacts)'
`artifact` CLI to your own deployment: a private page (only you and the viewers you allow) that
reloads itself every minute. It includes the end of each session's last reply.

### From your phone, signed in with a passkey

The page can also be served at a host name of yours, through a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/),
to devices you added: see what waits, read back the conversation, answer it, send prompts, look
at the files, all from the phone. Like Claude Code's Remote Control, but on your own domain.

```bash
# Once: a tunnel from a host name in your Cloudflare DNS to this computer
cloudflared tunnel login
cloudflared tunnel create agent-diff
cloudflared tunnel route dns agent-diff agents.example.com
cat > ~/.cloudflared/agent-diff.yml <<YML
tunnel: agent-diff
credentials-file: $HOME/.cloudflared/<tunnel id>.json
ingress:
  - hostname: agents.example.com
    service: http://127.0.0.1:47301
  - service: http_status:404
YML
cloudflared tunnel --config ~/.cloudflared/agent-diff.yml run

# The page, also for signed-in devices at that host name
agent-diff inbox --view --remote https://agents.example.com

# Add a phone: scan the QR code, then make a passkey on it
agent-diff remote pair
```

How it is kept to you:

- **Passkeys only.** A device signs in with a passkey made for that host name; there is no
  password. A device is added through a **pairing link** that works once, for 10 minutes, and is
  made on this computer only (`agent-diff remote pair`, or **Remote → Add a phone** on the local
  page): a signed-in device cannot add others.
- The session is a signed, `HttpOnly`, `Secure`, `SameSite=Strict` cookie that names its
  passkey; removing the device (`agent-diff remote revoke`, or **Remote**) ends its sessions.
- The tunnel's listener is on 127.0.0.1 and answers only requests for the host name; requests that
  change something must come from the page itself (same origin and its header). Pages carry a
  strict Content-Security-Policy and cannot be framed.
- Everything a device does (prompts, keys, Later/Done, staging, sign-ins) is logged:
  `agent-diff remote log`, or **Remote** on the page.

The keys, the passkeys' public keys and the log are in `$XDG_STATE_HOME/agent-diff/remote/`,
readable by you only. The local page keeps its token across restarts, so its URL can be
bookmarked when it runs as a service.

To keep both running, make them user services. Give node an explicit heap size: the first look at
who changed what reads a month of transcripts, briefly about a GB of heap, and under a memory cap
node picks a heap too small for that and crashes. The worker that holds them lets go after ten
idle minutes.

```ini
# ~/.config/systemd/user/agent-diff.service   (ExecStart: the path `which agent-diff` prints)
[Service]
Environment=NODE_OPTIONS=--max-old-space-size=2048
ExecStart=%h/.npm-global/bin/agent-diff inbox --view --port 47300 --remote https://agents.example.com
Restart=on-failure
MemoryMax=3G

[Install]
WantedBy=default.target

# ~/.config/systemd/user/agent-diff-tunnel.service
[Service]
Type=notify
ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel --config %h/.cloudflared/agent-diff.yml run
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now agent-diff.service agent-diff-tunnel.service
```

### Where it looks

- **Claude Code** writes a record per running process to `~/.claude/sessions/<pid>.json`,
  including whether it waits and for what, and one per background session to
  `~/.claude/jobs/<id>/state.json`. These files are Claude Code's own and undocumented, so a new
  Claude Code version may change them. Transcripts are read incrementally: the first look reads
  the last 2 MB, later looks only what was appended.
- **Codex** holds `~/.codex/thread-writer-locks/<thread>.lock` while a thread is open; its rollout
  says whether the turn finished, the context and the rate limits. Codex does not log approval
  prompts: a command that has run for 30 seconds without output is shown as possibly waiting for
  one, and herdr, when used, tells for sure.
- Holds are kept in `$XDG_STATE_HOME/agent-diff/holds.json` (`~/.local/state/agent-diff`).

## Terminal

```text
$ agent-diff
Claude 4f2a9c1e  10/19 19:48–10/19 21:23  Add due dates and an overdue helper
    M src/schema.gen.ts
    M src/todos.ts (2 of 3 hunks; rest by others)
    A src/due.ts

Codex  019a3c5e  10/19 20:48–10/19 20:48  Page 2 of /todos repeats the last item of page 1. Fix it.
    M src/todos.ts (1 of 3 hunks; rest by others)

Not found in any transcript  (edited by hand, by a tool, or by a session older than --days)
    M README.md

$ agent-diff add 4f2a9c1e      # stage that session's files and hunks, nothing else
$ git commit
```

| Command | |
|---|---|
| `agent-diff` | Changes grouped by session (`--by-file`: one line per file) |
| `agent-diff show <session>` | The hunks a session made, as a diff |
| `agent-diff add <session>` | Stage the session's changes (`--dry-run` to preview) |
| `agent-diff view` | The viewer (`--port` to fix the port) |
| `agent-diff inbox` | Running sessions that wait on you, in every repository (`--view`, `--all`, `--stale <time>`, `--watch`, `--notify`, `--publish`) |
| `agent-diff later` / `done` / `unhold` `<session>` | Take a session off the list for a while, or until it moves on |
| `agent-diff cleanup` | Idle sessions and unused worktrees, with the commands to close or remove them |
| `agent-diff statusline` | One line for Claude Code's status line (`install --statusline` sets it up) |
| `agent-diff remote pair` / `devices` / `revoke <id>` / `log` | Add a phone (one-time link and QR code), list or remove devices, see what they did |
| `agent-diff install` / `uninstall` | Hooks and skill for Claude Code and Codex (`--agent claude\|codex` for one) |

| Option | |
|---|---|
| `--since <time>` | `2h`, `1d`, `today` or a date: changes since then, commits included |
| `--base <ref>` | Changes since a branch or commit |
| `--self` | With `show` / `add`: the session running the command (reads `CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID`) |
| `--json` | Machine-readable output |
| `-C <dir>` | Run in another repository |
| `--days <n>` | How far back transcripts are read (default 30) |

`<session>` is an id prefix, optionally starting with `claude:` or `codex:`.

## Agents committing their own work

With several sessions in one checkout, an agent's `git add -A` sweeps up everyone's half-done
changes. The `agent-diff-commit` skill tells the agent to stage with `agent-diff add --self`
instead, and to check `git diff --cached` before committing.

## How it decides

For each changed file, agent-diff only considers sessions active after the file's last commit
(or after `--since`). A hunk goes to the session whose writes contain most of its lines:

| Evidence | Confidence |
|---|---|
| The hook recorded the session changing those lines (any tool, shell included) | recorded |
| Edit / Write / MultiEdit calls (Claude), FileChange diffs and apply_patch (Codex) | sure |
| A recorded delete or create of that very file (moves included) | sure |
| Text of a shell command or Codex `exec` script that mentions the file (sed, heredocs, scripts) | likely |
| The same substitution (old → new fragment) that the session made in another file, as a codemod does | likely |
| The only session that touched the file, for a hunk with nothing to match (whitespace) | maybe |

Anything else is unattributed: edits by hand, by formatters, or by sessions older than `--days`
that the hooks did not see. The hooks keep their records in `.git/agent-diff/` of each
repository. One record is the before and after content of a tool call, stored as git blobs.

## Development

```bash
npm ci
npm test               # node:test, against temporary repositories and fake transcripts
                       # (the page's test runs in Chromium: npx playwright install chromium;
                       # it is skipped without it. AGENT_DIFF_UI_SHOTS=<dir> saves screenshots)
npm run typecheck
npm run screenshots    # rebuilds docs/screenshots from a demo repository (Playwright)
```

Releases: bump `version` in package.json and push it to the `publish` branch. GitHub Actions
publishes to npm with trusted publishing.

## License

MIT
