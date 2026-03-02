# agentic

Pi coding agent extensions repo — published as a pi package via `pi install git:github.com/indigoviolet/agentic`.

## Structure

- `extensions/` — each `.ts` file is a pi extension auto-discovered via `package.json` `pi.extensions`
- `package.json` — pi package manifest with `pi-package` keyword
- `README.md` — user-facing docs with install instructions and extension descriptions

## Writing extensions

- Extensions are TypeScript modules exporting a default function that receives `ExtensionAPI`
- Available imports: `@mariozechner/pi-coding-agent` (types, helpers), `@mariozechner/pi-tui` (UI components), `@mariozechner/pi-ai` (AI utilities), `@sinclair/typebox` (schemas)
- Pi docs: `/Users/venky/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- TUI docs: `/Users/venky/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/docs/tui.md`
- Examples: `/Users/venky/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/examples/extensions/`

## Key patterns

- `pi.registerCommand()` for `/commands`, `pi.registerShortcut()` for keybindings
- `pi.registerTool()` for LLM-callable tools
- `ctx.ui.setWidget()` for persistent content above/below editor
- `ctx.ui.custom()` for interactive TUI (SelectList, BorderedLoader, etc.)
- `ctx.ui.setStatus()` for footer indicators
- `pi.appendEntry()` for state persistence across turns/restarts
- Session restore via `pi.on("session_start")` reading `ctx.sessionManager.getEntries()`

## Rules

- Every rendered line must respect `width` — use `truncateToWidth()` as a safety net
- `─` (box-drawing) may measure as 2 columns; use `width / 2` repeats or measure with `visibleWidth()`
- Use `StringEnum` from `@mariozechner/pi-ai` for string enums (not `Type.Union`/`Type.Literal`)
- Mouse events not available — pi doesn't enable mouse reporting
- Update `README.md` when adding/changing extensions

## Current extensions

- `answer.ts` — interactive Q&A extraction from assistant messages
- `context.ts` — TUI overview of loaded context, token usage, costs
- `subdir-context.ts` — auto-loads subdirectory AGENTS.md files
- `pin.ts` — pin an assistant response as a widget (full/minimal toggle)
