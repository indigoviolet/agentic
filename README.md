# agentic

Pi coding agent extensions.

## Install

```bash
pi install git:github.com/indigoviolet/agentic
```

Or try without installing:

```bash
pi -e git:github.com/indigoviolet/agentic
```

## Extensions

### answer

Interactive section response — extracts addressable subsections (numbered items, bullets, recommendations, discussion points, questions) from the last assistant message and presents them one at a time for response. Sections with clear options show a selector; others get a free-text editor. Registers `/answer` command and `Ctrl+.` shortcut.

### subdir-context

Automatically loads `AGENTS.md` files from subdirectories when the agent reads files or runs bash commands that reference those directories. Scans the project at session start, then sends followUp read messages through the normal pipeline so other extensions (like `context`) can see them. Inspired by [default-anton/pi-subdir-context](https://github.com/default-anton/pi-subdir-context).

### context

Shows a TUI overview of loaded context: extensions, skills, AGENTS.md files, context window usage bar, and session token/cost totals. Registers `/context` command. Also tracks which skills and subdirectory AGENTS.md files have been loaded via read calls.

### pin

Pin an assistant response as a widget above the editor. `/pin` opens a selector to pick from recent responses. `Ctrl+Shift+Y` toggles between full (rendered markdown with tables, code blocks, etc.) and minimal (first line) view. `/unpin` removes it. State persists across turns and session restore.

### timestamp

Shows a compact timestamp separator (`── HH:MM:SS ──`) in the conversation flow after each agent response completes. Useful for tracking when interactions happened during long sessions.

### powerbar-current-dir

Emits a `current-dir` segment for [pi-powerbar](https://github.com/juanibiapina/pi-powerbar) showing the current working directory as a home-relative path like `~/dev/agentic`. Updates on session start and session switch.

If you use it with `pi-powerbar`, load `pi-powerbar` before this package so it can receive the segment registration and update events.

### read-lines

Overrides the built-in `read` tool to show fewer lines in the collapsed TUI view. The default pi renderer shows 10 lines; this extension defaults to 2. Configurable via `/extension-settings` (requires [`pi-extension-settings`](https://github.com/juanibiapina/pi-extension-settings)). Execution delegates entirely to the built-in read implementation.

### external-editor

Adds an `external_editor` tool that opens a provided path in your local editor. Configure the command via `/extension-settings` under `external-editor → Editor command` (requires [`pi-extension-settings`](https://github.com/juanibiapina/pi-extension-settings)).

Examples:

- `code`
- `cursor --reuse-window`
- `open -a "Visual Studio Code" {path}`

If the configured command contains `{path}`, the resolved absolute path is substituted there; otherwise the path is appended as the final argument.

### pi-horde (separate package)

Moved to [indigoviolet/pi-horde](https://github.com/indigoviolet/pi-horde). Multi-agent networking via NATS — presence, messaging, spawning. Install with:

```bash
pi install git:github.com/indigoviolet/pi-horde
```

### tmux (separate package)

Moved to [indigoviolet/pi-tmux](https://github.com/indigoviolet/pi-tmux). Install with:

```bash
pi install npm:@romansix/pi-tmux
```

---

`answer` and `context` are based on [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) by Armin Ronacher, licensed under Apache 2.0. `context` has been extended to track dynamically-loaded subdirectory AGENTS.md files (via `subdir-context` or manual reads).
