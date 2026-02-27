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

### tmux

Manages a tmux session per project (one per git root). Provides a `tmux` tool for the agent with actions: `run`, `attach`, `peek`, `list`, `kill`. Commands run in separate tmux windows; when they finish, the agent is automatically notified with exit code and recent output via chokidar file watching.

Each command's script is echoed before execution (`cat "$0"`) so you can see exactly what's running — including heredocs and complex constructs that `set -x` would miss.

Also registers:
- `/tmux` — open an iTerm2 tab attached to the session
- `/tmux:cat` — capture window output and bring it into the conversation

---

`answer` and `context` are based on [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) by Armin Ronacher, licensed under Apache 2.0.

`tmux` is inspired by [normful/picadillo's run-in-tmux skill](https://github.com/normful/picadillo/blob/main/skills/run-in-tmux/SKILL.md).
