import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getSetting } from "@juanibiapina/pi-extension-settings";
import type { SettingDefinition } from "@juanibiapina/pi-extension-settings";
import {
  getGitRoot,
  sessionName,
  ensureSession,
  runInWindow,
  openTerminalTab,
} from "@romansix/pi-tmux/tmux-utils";

const EXTENSION_NAME = "external-editor";
const COMMAND_SETTING_ID = "command";
const USE_TMUX_SETTING_ID = "use_tmux";

const ExternalEditorParams = Type.Object({
  path: Type.String({ description: "Path to open in the external editor" }),
});

interface ExternalEditorDetails {
  configuredCommand: string;
  launchCommand: string;
  requestedPath: string;
  resolvedPath: string;
}

function getConfiguredCommand(): string {
  return (getSetting(EXTENSION_NAME, COMMAND_SETTING_ID, "") ?? "").trim();
}

function getUseTmux(): boolean {
  const val = getSetting(EXTENSION_NAME, USE_TMUX_SETTING_ID, "false") ?? "false";
  return val === "true";
}

function normalizePath(rawPath: string, cwd: string): string {
  let normalized = rawPath.trim();

  if (normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }

  if (normalized === "~") {
    normalized = homedir();
  } else if (normalized.startsWith("~/")) {
    normalized = resolve(homedir(), normalized.slice(2));
  }

  return resolve(cwd, normalized);
}

function quoteForShell(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildLaunchCommand(command: string, resolvedPath: string): string {
  const quotedPath = quoteForShell(resolvedPath);

  if (command.includes("{path}")) {
    return command.split("{path}").join(quotedPath);
  }

  return `${command} ${quotedPath}`;
}

function launchEditor(command: string, cwd: string): Promise<void> {
  return new Promise((resolveLaunch, rejectLaunch) => {
    try {
      const child = spawn(command, {
        cwd,
        detached: true,
        shell: true,
        stdio: "ignore",
      });

      child.once("error", rejectLaunch);
      child.once("spawn", () => {
        child.unref();
        resolveLaunch();
      });
    } catch (error) {
      rejectLaunch(error);
    }
  });
}

export default function externalEditorExtension(pi: ExtensionAPI) {
  pi.events.emit("pi-extension-settings:register", {
    name: EXTENSION_NAME,
    settings: [
      {
        id: COMMAND_SETTING_ID,
        label: "Editor command",
        description:
          "Command used to open files. Use {path} to place the resolved path explicitly; otherwise the path is appended.",
        defaultValue: "",
      },
      {
        id: USE_TMUX_SETTING_ID,
        label: "Use tmux",
        description:
          'Run the editor in the project tmux session and attach to it. Set to "true" to enable.',
        defaultValue: "false",
      },
    ] satisfies SettingDefinition[],
  });

  pi.registerTool({
    name: "external_editor",
    label: "External Editor",
    description:
      "Open a file path in a configured external editor on the local machine. The editor command is configured via extension-settings.",
    promptSnippet: "Open a path in the user's configured external editor.",
    promptGuidelines: [
      "Use `external_editor` only when the user explicitly asks to open a path in an external editor.",
      "Pass the path the user wants to open; the extension resolves relative paths against the current working directory.",
    ],
    parameters: ExternalEditorParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        throw new Error("external_editor was cancelled before launch");
      }

      const configuredCommand = getConfiguredCommand();
      if (!configuredCommand) {
        throw new Error(
          "No external editor command is configured. Configure external-editor.command via /extension-settings first.",
        );
      }

      if (!params.path.trim()) {
        throw new Error("Path must not be empty");
      }

      const resolvedPath = normalizePath(params.path, ctx.cwd);
      const launchCommand = buildLaunchCommand(configuredCommand, resolvedPath);
      const useTmux = getUseTmux();

      if (useTmux) {
        const gitRoot = getGitRoot(ctx.cwd);
        if (!gitRoot) {
          throw new Error("Not in a git repository — tmux mode requires a git repo.");
        }

        const session = sessionName(gitRoot);
        ensureSession(session, gitRoot);
        const winIdx = runInWindow(session, gitRoot, launchCommand, "editor");
        const attachMsg = openTerminalTab(session, winIdx);

        return {
          content: [
            {
              type: "text",
              text: `Opened ${resolvedPath} in tmux window :${winIdx}. ${attachMsg}`,
            },
          ],
          details: {
            configuredCommand,
            launchCommand,
            requestedPath: params.path,
            resolvedPath,
          } satisfies ExternalEditorDetails,
        };
      }

      await launchEditor(launchCommand, ctx.cwd);

      return {
        content: [
          {
            type: "text",
            text: `Opened ${resolvedPath} in the configured external editor.`,
          },
        ],
        details: {
          configuredCommand,
          launchCommand,
          requestedPath: params.path,
          resolvedPath,
        } satisfies ExternalEditorDetails,
      };
    },

    renderCall(args, theme) {
      const path = typeof args.path === "string" ? args.path : "";
      const text =
        `${theme.fg("toolTitle", theme.bold("external_editor"))} ` +
        theme.fg("accent", path || "(missing path)");
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("muted", "launching external editor…"), 0, 0);
      }

      const details = result.details as ExternalEditorDetails | undefined;
      if (!details) {
        const text = result.content.find((block: any) => block.type === "text") as
          | { type: "text"; text: string }
          | undefined;
        return new Text(text?.text ?? "", 0, 0);
      }

      let text =
        theme.fg("success", "✓ Opened ") + theme.fg("accent", details.resolvedPath);

      if (expanded) {
        text += `\n${theme.fg("muted", `Configured command: ${details.configuredCommand}`)}`;
        text += `\n${theme.fg("dim", `Launch command: ${details.launchCommand}`)}`;
      }

      return new Text(text, 0, 0);
    },
  });
}
