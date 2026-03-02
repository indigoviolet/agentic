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

Interactive Q&A extraction — extracts questions from the last assistant message and presents a custom TUI to answer them one by one. Registers `/answer` command and `Ctrl+.` shortcut.

### subdir-context

Automatically loads `AGENTS.md` files from subdirectories when the agent reads files or runs bash commands that reference those directories. Scans the project at session start, then sends followUp read messages through the normal pipeline so other extensions (like `context`) can see them. Inspired by [default-anton/pi-subdir-context](https://github.com/default-anton/pi-subdir-context).

### context

Shows a TUI overview of loaded context: extensions, skills, AGENTS.md files, context window usage bar, and session token/cost totals. Registers `/context` command. Also tracks which skills and subdirectory AGENTS.md files have been loaded via read calls.

### pin

Pin an assistant response as a widget above the editor. `/pin` opens a selector to pick from recent responses. `Ctrl+Shift+Y` toggles between full (rendered markdown with tables, code blocks, etc.) and minimal (first line) view. `/unpin` removes it. State persists across turns and session restore.

### tmux (separate package)

Moved to [indigoviolet/pi-tmux](https://github.com/indigoviolet/pi-tmux). Install with:

```bash
pi install npm:@romansix/pi-tmux
```

---

`answer` and `context` are based on [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) by Armin Ronacher, licensed under Apache 2.0. `context` has been extended to track dynamically-loaded subdirectory AGENTS.md files (via `subdir-context` or manual reads).
