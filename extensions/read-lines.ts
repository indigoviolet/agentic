/**
 * read-lines — Override built-in read tool with a configurable collapsed-view line count.
 *
 * The built-in TUI always shows 10 lines when collapsed. This extension lets you
 * choose how many lines to show (default: 2) via /extension-settings.
 */

import type { ExtensionAPI, ReadToolDetails } from "@mariozechner/pi-coding-agent";
import {
  createReadTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getLanguageFromPath,
  highlightCode,
  keyHint,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { getSetting } from "@juanibiapina/pi-extension-settings";
import type { SettingDefinition } from "@juanibiapina/pi-extension-settings";

const EXTENSION_NAME = "read-lines";

function getCollapsedLines(): number {
  return parseInt(getSetting(EXTENSION_NAME, "collapsedLines", "2") ?? "2", 10);
}

function replaceTabs(s: string): string {
  return s.replace(/\t/g, "  ");
}

export default function (pi: ExtensionAPI) {
  // Register setting
  pi.events.emit("pi-extension-settings:register", {
    name: EXTENSION_NAME,
    settings: [
      {
        id: "collapsedLines",
        label: "Collapsed lines",
        description: "Number of lines shown in collapsed read results",
        defaultValue: "2",
        values: ["1", "2", "3", "5", "10"],
      },
    ] satisfies SettingDefinition[],
  });

  const baseTool = createReadTool(process.cwd());

  pi.registerTool({
    name: "read",
    label: "read",
    description: baseTool.description,
    parameters: baseTool.parameters,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Delegate to built-in implementation, stash path in details for renderResult
      const tool = createReadTool(ctx.cwd);
      const result = await tool.execute(toolCallId, params, signal, onUpdate);
      return {
        ...result,
        details: { ...result.details, path: params.path },
      };
    },

    renderCall(args, theme) {
      const rawPath: string | undefined = args.path ?? args.file_path;
      const path = rawPath ?? undefined;
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;

      let pathDisplay = path
        ? theme.fg("accent", path)
        : theme.fg("toolOutput", "...");

      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }

      return new Text(
        `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("muted", "reading…"), 0, 0);
      }

      // Extract text content
      const textBlock = result.content?.find(
        (b: any) => b.type === "text",
      ) as { type: "text"; text: string } | undefined;

      if (!textBlock?.text) return undefined;

      const output = textBlock.text;
      const filePath: string | undefined = (result.details as any)?.path;
      const lang = filePath ? getLanguageFromPath(filePath) : undefined;

      const lines = lang
        ? highlightCode(replaceTabs(output), lang)
        : output.split("\n");

      const collapsedLines = getCollapsedLines();
      const maxLines = expanded ? lines.length : collapsedLines;
      const displayLines = lines.slice(0, maxLines);
      const remaining = lines.length - maxLines;

      let text = displayLines
        .map((line: string) =>
          lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)),
        )
        .join("\n");

      if (remaining > 0) {
        text += `${theme.fg("muted", `\n… (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
      }

      // Truncation warning
      const details = result.details as ReadToolDetails | undefined;
      const truncation = details?.truncation;
      if (truncation?.truncated) {
        if (truncation.firstLineExceedsLimit) {
          text +=
            "\n" +
            theme.fg(
              "warning",
              `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`,
            );
        } else if (truncation.truncatedBy === "lines") {
          text +=
            "\n" +
            theme.fg(
              "warning",
              `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`,
            );
        } else {
          text +=
            "\n" +
            theme.fg(
              "warning",
              `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`,
            );
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
