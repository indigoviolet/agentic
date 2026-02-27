/**
 * tmux extension - manages a tmux session per project (git root).
 *
 * Tool: tmux (run/attach/peek/list/kill)
 * Commands: /tmux (attach in iTerm2), /tmux:transfer (capture window output into conversation)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const TmuxParams = Type.Object({
  action: StringEnum(["run", "attach", "peek", "kill", "list"] as const),
  commands: Type.Optional(
    Type.Array(Type.String(), {
      description: "Commands to run (for 'run' action). Each gets its own tmux window.",
    })
  ),
  window: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description: "Window index or 'all' (for 'peek' action). Defaults to 'all'.",
    })
  ),
});

type TmuxInput = Static<typeof TmuxParams>;

function exec(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
}

function execSafe(cmd: string): string | null {
  try {
    return exec(cmd);
  } catch {
    return null;
  }
}

function getGitRoot(cwd: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      cwd,
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function sessionName(gitRoot: string): string {
  const slug = gitRoot.split("/").pop()!.slice(0, 16).toLowerCase();
  const hash = createHash("md5").update(gitRoot).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

function sessionExists(name: string): boolean {
  return execSafe(`tmux has-session -t ${name} 2>/dev/null && echo yes`) === "yes";
}

function getWindows(name: string): { index: number; title: string; active: boolean }[] {
  const raw = execSafe(
    `tmux list-windows -t ${name} -F "#{window_index}|||#{window_name}|||#{window_active}"`
  );
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [index, title, active] = line.split("|||");
    return { index: parseInt(index), title, active: active === "1" };
  });
}

function capturePanes(name: string, window: number | "all"): string {
  const windows = getWindows(name);
  const targets =
    window === "all" ? windows : windows.filter((w) => w.index === window);

  if (targets.length === 0) return "No matching windows.";

  return targets
    .map((w) => {
      const output = execSafe(`tmux capture-pane -t ${name}:${w.index} -p -S -50`);
      return `── window ${w.index}: ${w.title} ──\n${output ?? "(empty)"}`;
    })
    .join("\n\n");
}

function attachToSession(cwd: string): string {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) return "Not in a git repository.";

  const session = sessionName(gitRoot);
  if (!sessionExists(session)) return `No tmux session for this project.`;

  try {
    exec(`osascript -e '
      tell application "iTerm2"
        tell current window
          set newTab to (create tab with default profile)
          tell current session of newTab
            write text "tmux attach -t ${session}"
          end tell
        end tell
      end tell'`);
    return `Opened iTerm2 tab attached to ${session}.`;
  } catch (e: any) {
    return `Failed: ${e.message}`;
  }
}

function addWindow(session: string, gitRoot: string, cmd: string): number {
  const raw = exec(
    `tmux new-window -t ${session} -c "${gitRoot}" -P -F "#{window_index}"`
  );
  const idx = parseInt(raw);
  exec(`tmux send-keys -t ${session}:${idx} "${escapeForTmux(cmd)}" C-m`);
  return idx;
}

function escapeForTmux(s: string): string {
  return s.replace(/"/g, '\\"');
}

export default function (pi: ExtensionAPI) {
  // /tmux — attach in iTerm2
  pi.registerCommand("tmux", {
    description: "Open iTerm2 tab attached to this project's tmux session",
    handler: async (_args, ctx) => {
      const msg = attachToSession(ctx.cwd);
      ctx.ui.notify(msg, msg.startsWith("Failed") || msg.startsWith("No") || msg.startsWith("Not") ? "error" : "info");
    },
  });

  // /tmux:transfer — capture window output into conversation
  pi.registerCommand("tmux:transfer", {
    description: "Capture tmux window output and bring it into the conversation",
    handler: async (_args, ctx) => {
      const gitRoot = getGitRoot(ctx.cwd);
      if (!gitRoot) { ctx.ui.notify("Not in a git repository.", "error"); return; }

      const session = sessionName(gitRoot);
      if (!sessionExists(session)) { ctx.ui.notify("No tmux session for this project.", "error"); return; }

      const windows = getWindows(session);
      if (windows.length === 0) { ctx.ui.notify("No windows in session.", "error"); return; }

      const options = [
        "all windows",
        ...windows.map((w) => `:${w.index}  ${w.title}${w.active ? "  (active)" : ""}`),
      ];

      const choice = await ctx.ui.select("Capture output from:", options);
      if (choice === undefined || choice === null) return;

      let target: number | "all";
      if (choice === 0 || choice === "all windows") {
        target = "all";
      } else {
        const idx = typeof choice === "number" ? choice - 1 : options.indexOf(String(choice)) - 1;
        const win = windows[idx];
        if (!win) { ctx.ui.notify("Invalid window selection.", "error"); return; }
        target = win.index;
      }
      const output = capturePanes(session, target);

      pi.sendUserMessage(`Here is the tmux output:\n\n\`\`\`\n${output}\n\`\`\``, {
        deliverAs: "followUp",
      });
    },
  });

  // tmux tool — for the agent
  pi.registerTool({
    name: "tmux",
    label: "tmux",
    description: `Manage a tmux session for the current project (one session per git root).

WHEN TO USE: Prefer this over bash for long-running or background commands: dev servers, file watchers, build processes, test suites, anything that runs continuously or takes more than a few seconds. Use bash for quick one-shot commands that complete immediately (ls, cat, grep, git status, etc.).

Actions:
- run: Run commands in new tmux windows. Each command gets its own window. If the session already exists, new windows are added to it.
- attach: Open an iTerm2 tab attached to the session (for the user to interact with).
- peek: Capture recent output from tmux windows. Use window param to target a specific window, or omit for all. Use this to check on running processes.
- list: List all windows in the session.
- kill: Kill the entire session.

The user can also type /tmux to attach in iTerm2, or /tmux:transfer to select a window and bring its output into the conversation.`,
    parameters: TmuxParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const gitRoot = getGitRoot(ctx.cwd);
      if (!gitRoot) {
        return {
          content: [{ type: "text", text: "Error: not in a git repository." }],
          isError: true,
        };
      }

      const session = sessionName(gitRoot);

      switch (params.action) {
        case "run": {
          if (!params.commands || params.commands.length === 0) {
            return {
              content: [{ type: "text", text: "Error: 'commands' required for run action." }],
              isError: true,
            };
          }

          const exists = sessionExists(session);
          const indices: number[] = [];

          if (!exists) {
            exec(`tmux new-session -d -s ${session} -c "${gitRoot}"`);
            exec(`tmux send-keys -t ${session}:0 "${escapeForTmux(params.commands[0])}" C-m`);
            indices.push(0);

            for (let i = 1; i < params.commands.length; i++) {
              const idx = addWindow(session, gitRoot, params.commands[i]);
              indices.push(idx);
            }
          } else {
            for (const cmd of params.commands) {
              const idx = addWindow(session, gitRoot, cmd);
              indices.push(idx);
            }
          }

          const lines = params.commands.map(
            (cmd, i) => `  :${indices[i]}  ${cmd}`
          );
          return {
            content: [
              {
                type: "text",
                text: `${exists ? "Added to" : "Created"} session ${session}\n${lines.join("\n")}`,
              },
            ],
            details: { session, existed: exists, windowIndices: indices },
          };
        }

        case "attach": {
          if (!sessionExists(session)) {
            return {
              content: [{ type: "text", text: `No session '${session}' to attach to.` }],
              isError: true,
            };
          }

          try {
            exec(`osascript -e '
              tell application "iTerm2"
                tell current window
                  set newTab to (create tab with default profile)
                  tell current session of newTab
                    write text "tmux attach -t ${session}"
                  end tell
                end tell
              end tell'`);
          } catch (e: any) {
            return {
              content: [{ type: "text", text: `Failed to open iTerm2 tab: ${e.message}` }],
              isError: true,
            };
          }

          return {
            content: [
              { type: "text", text: `Opened iTerm2 tab attached to session ${session}.` },
            ],
          };
        }

        case "peek": {
          if (!sessionExists(session)) {
            return {
              content: [{ type: "text", text: `No session '${session}'.` }],
              isError: true,
            };
          }

          const win =
            params.window === undefined || params.window === "all"
              ? "all" as const
              : typeof params.window === "number"
                ? params.window
                : parseInt(params.window);

          const output = capturePanes(
            session,
            typeof win === "string" ? win : isNaN(win as number) ? "all" : win
          );
          return {
            content: [{ type: "text", text: output }],
            details: { session },
          };
        }

        case "list": {
          if (!sessionExists(session)) {
            return {
              content: [{ type: "text", text: `No session '${session}'.` }],
              isError: true,
            };
          }

          const windows = getWindows(session);
          const lines = windows.map(
            (w) => `  :${w.index}  ${w.title}${w.active ? "  (active)" : ""}`
          );
          return {
            content: [
              {
                type: "text",
                text: `Session ${session} — ${windows.length} window(s)\n${lines.join("\n")}`,
              },
            ],
            details: { session, windows },
          };
        }

        case "kill": {
          if (!sessionExists(session)) {
            return {
              content: [{ type: "text", text: `No session '${session}' to kill.` }],
            };
          }

          exec(`tmux kill-session -t ${session}`);
          return {
            content: [{ type: "text", text: `Killed session ${session}.` }],
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${params.action}` }],
            isError: true,
          };
      }
    },

    renderCall(args, theme) {
      const action = args.action ?? "tmux";
      let text = theme.fg("toolTitle", theme.bold("tmux "));
      text += theme.fg("accent", action);

      if (action === "run" && Array.isArray(args.commands)) {
        for (const cmd of args.commands) {
          text += "\n  " + theme.fg("muted", cmd);
        }
      } else if (action === "peek" && args.window !== undefined) {
        text += theme.fg("muted", ` :${args.window}`);
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const content = result.content?.[0];
      const raw = content?.type === "text" ? content.text : "";

      if (result.isError) {
        return new Text(theme.fg("error", raw), 0, 0);
      }

      // First line is the summary, rest is detail
      const lines = raw.split("\n");
      const summary = lines[0] ?? "";
      const detail = lines.slice(1).join("\n");

      let text = theme.fg("success", "✓ ") + summary;
      if (expanded && detail) {
        text += "\n" + theme.fg("dim", detail);
      }

      return new Text(text, 0, 0);
    },
  });
}
