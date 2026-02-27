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

### context

Shows a TUI overview of loaded context: extensions, skills, AGENTS.md files, context window usage bar, and session token/cost totals. Registers `/context` command. Also tracks which skills have been loaded via read calls.

### tmux (separate package)

Moved to [indigoviolet/pi-tmux](https://github.com/indigoviolet/pi-tmux). Install with:

```bash
pi install npm:@indigoviolet/pi-tmux
```

---

`answer` and `context` are based on [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) by Armin Ronacher, licensed under Apache 2.0.
