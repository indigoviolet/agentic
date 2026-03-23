import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getSetting } from "@juanibiapina/pi-extension-settings";
import type { SettingDefinition } from "@juanibiapina/pi-extension-settings";

const EXTENSION_NAME = "external-editor";
const COMMAND_SETTING_ID = "command";
const USE_TMUX_SETTING_ID = "use_tmux";

const ExternalEditorParams = Type.Object({
  path: Type.String({ description: "Path to open in the external editor" }),
  line: Type.Optional(
    Type.Union([
      Type.Number({ description: "Optional 1-based line number to open" }),
      Type.String({ description: "Optional 1-based line number to open" }),
    ]),
  ),
  column: Type.Optional(
    Type.Union([
      Type.Number({ description: "Optional 1-based column number to open" }),
      Type.String({ description: "Optional 1-based column number to open" }),
    ]),
  ),
});

interface ExternalEditorDetails {
  configuredCommand: string;
  launchCommand: string;
  requestedPath: string;
  requestedLine?: string;
  requestedColumn?: string;
  resolvedPath: string;
}

interface ExternalEditorOpenResult extends ExternalEditorDetails {
  windowIndex?: number;
  attachMsg?: string;
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

function normalizeLocationNumber(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return /^\d+$/.test(normalized) ? normalized : undefined;
}

function buildLaunchCommand(
  command: string,
  resolvedPath: string,
  line?: string,
  column?: string,
): string {
  const quotedPath = quoteForShell(resolvedPath);
  const lineSpec = line ? `+${line}${column ? `:${column}` : ""}` : "";

  if (
    command.includes("{path}") ||
    command.includes("{line}") ||
    command.includes("{column}") ||
    command.includes("{lineSpec}")
  ) {
    return command
      .split("{path}")
      .join(quotedPath)
      .split("{line}")
      .join(line ?? "")
      .split("{column}")
      .join(column ?? "")
      .split("{lineSpec}")
      .join(lineSpec)
      .replace(/\s+/g, " ")
      .trim();
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

async function openConfiguredEditor(
  pi: ExtensionAPI,
  requestedPath: string,
  cwd: string,
  requestedLine?: string | number,
  requestedColumn?: string | number,
): Promise<ExternalEditorOpenResult> {
  const configuredCommand = getConfiguredCommand();
  if (!configuredCommand) {
    throw new Error(
      "No external editor command is configured. Configure external-editor.command via /extension-settings first.",
    );
  }

  if (!requestedPath.trim()) {
    throw new Error("Path must not be empty");
  }

  const resolvedPath = normalizePath(requestedPath, cwd);
  const line = normalizeLocationNumber(requestedLine);
  const column = normalizeLocationNumber(requestedColumn);
  const launchCommand = buildLaunchCommand(
    configuredCommand,
    resolvedPath,
    line,
    column,
  );
  const useTmux = getUseTmux();

  if (useTmux) {
    let result:
      | { windowIndex: number; attachMsg: string }
      | { error: string }
      | null = null;
    pi.events.emit("pi-tmux:run-and-attach", {
      cwd,
      command: launchCommand,
      name: "editor",
      callback: (r: typeof result) => {
        result = r;
      },
    });

    if (!result) {
      throw new Error(
        "pi-tmux extension is not loaded — install @romansix/pi-tmux to use tmux mode.",
      );
    }
    if ("error" in result) {
      throw new Error(result.error);
    }

    return {
      configuredCommand,
      launchCommand,
      requestedPath,
      requestedLine: line,
      requestedColumn: column,
      resolvedPath,
      windowIndex: result.windowIndex,
      attachMsg: result.attachMsg,
    };
  }

  await launchEditor(launchCommand, cwd);

  return {
    configuredCommand,
    launchCommand,
    requestedPath,
    requestedLine: line,
    requestedColumn: column,
    resolvedPath,
  };
}

export default function externalEditorExtension(pi: ExtensionAPI) {
  const globalState = globalThis as typeof globalThis & {
    __agenticExternalEditorOpenUnsubscribe?: (() => void) | undefined;
  };

  pi.events.emit("pi-extension-settings:register", {
    name: EXTENSION_NAME,
    settings: [
      {
        id: COMMAND_SETTING_ID,
        label: "Editor command",
        description:
          "Command used to open files. Use {path} to place the resolved path explicitly; optional placeholders: {line}, {column}, and {lineSpec} (e.g. +LINE[:COLUMN]). Otherwise the path is appended.",
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

  // Listen for cross-extension open requests (e.g. from pi-fzf secondary actions)
  globalState.__agenticExternalEditorOpenUnsubscribe?.();
  globalState.__agenticExternalEditorOpenUnsubscribe = pi.events.on(
    "external-editor:open",
    async (data: unknown) => {
      const {
        path: rawPath,
        cwd,
        line,
        column,
      } = data as {
        path: string;
        cwd: string;
        line?: string | number;
        column?: string | number;
      };
      if (!rawPath?.trim()) return;

      try {
        await openConfiguredEditor(pi, rawPath, cwd, line, column);
      } catch (error) {
        console.error(
          `external-editor: failed to open ${rawPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

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

      const result = await openConfiguredEditor(
        pi,
        params.path,
        ctx.cwd,
        params.line,
        params.column,
      );

      if (result.windowIndex !== undefined && result.attachMsg) {
        return {
          content: [
            {
              type: "text",
              text: `Opened ${result.resolvedPath} in tmux window :${result.windowIndex}. ${result.attachMsg}`,
            },
          ],
          details: {
            configuredCommand: result.configuredCommand,
            launchCommand: result.launchCommand,
            requestedPath: result.requestedPath,
            resolvedPath: result.resolvedPath,
          } satisfies ExternalEditorDetails,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Opened ${result.resolvedPath} in the configured external editor.`,
          },
        ],
        details: {
          configuredCommand: result.configuredCommand,
          launchCommand: result.launchCommand,
          requestedPath: result.requestedPath,
          resolvedPath: result.resolvedPath,
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
