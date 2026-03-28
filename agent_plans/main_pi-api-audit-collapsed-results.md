# Goal

Align `agentic` with the latest pi extension APIs and rename/broaden `read-lines` into `collapsed-results`, covering collapsed TUI result lines for `read`, `grep`, and `find`.

## TODOs

- [x] Fix `extensions/answer.ts`
  - [x] Replace `getApiKey(...)` with `getApiKeyAndHeaders(...)`
  - [x] Forward `apiKey` and `headers` into `complete(...)`
  - [x] Preserve current Haiku fallback behavior
- [x] Fix `extensions/context.ts`
  - [x] Replace `command.path` usage with `command.sourceInfo.path`
  - [x] Keep current `<unknown>` fallback behavior in `/context`
- [x] Rename and broaden `read-lines`
  - [x] Rename `extensions/read-lines.ts` to `extensions/collapsed-results.ts`
  - [x] Preserve neutral built-in tool metadata for overridden tools
  - [x] Override `read`, `grep`, and `find`
  - [x] Use `app.tools.expand` keybinding id
  - [x] Drop backward-compat fallback for `read-lines` settings per user request
- [x] Update docs/context
  - [x] Update `README.md`
  - [x] Update `AGENTS.md`
- [x] Validate
  - [x] Search for legacy APIs after edits
  - [x] Run lightweight repo checks (`bun` import of changed extensions)

## Relevant files

- `extensions/answer.ts`
- `extensions/context.ts`
- `extensions/read-lines.ts`
- `README.md`
- `AGENTS.md`

## Notes

- Sibling `pi-*` repos were audited but no code changes are currently indicated from the API changes reviewed.
- Per user request, the renamed extension does not preserve a `read-lines` settings fallback.
- Current global `~/.pi/agent/settings-extensions.json` did not contain a `read-lines` entry, so no user settings file rewrite was needed.
