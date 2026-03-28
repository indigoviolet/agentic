/**
 * collapsed-results — Override built-in read, grep, and find tool rendering with a configurable
 * collapsed-view line count.
 *
 * The built-in TUI shows more lines by default when these tools are collapsed. This extension lets you
 * choose how many lines to show (default: 2) via /extension-settings, while still delegating execution
 * to the built-in tool implementations.
 */

import type {
  ExtensionAPI,
  FindToolDetails,
  GrepToolDetails,
  ReadToolDetails,
} from "@mariozechner/pi-coding-agent";
import {
  createFindTool,
  createGrepTool,
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

const EXTENSION_NAME = "collapsed-results";
const DEFAULT_COLLAPSED_LINES = 2;

const baseReadTool = createReadTool(process.cwd());
const baseGrepTool = createGrepTool(process.cwd());
const baseFindTool = createFindTool(process.cwd());

type ResultWithContent = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  details?: unknown;
  isError?: boolean;
};

type TruncationLike = {
  truncated?: boolean;
  firstLineExceedsLimit?: boolean;
  truncatedBy?: "lines" | "bytes" | string;
  outputLines?: number;
  totalLines?: number;
  maxLines?: number;
  maxBytes?: number;
};

function parseCollapsedLines(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_COLLAPSED_LINES;
  return parsed;
}

function getCollapsedLines(): number {
  return parseCollapsedLines(getSetting(EXTENSION_NAME, "collapsedLines", String(DEFAULT_COLLAPSED_LINES)));
}

function replaceTabs(s: string): string {
  return s.replace(/\t/g, "  ");
}

function getTextContent(result: ResultWithContent): string | undefined {
  const textBlock = result.content.find((block) => block.type === "text");
  return textBlock?.text;
}

function getImageContent(result: ResultWithContent): { data: string; mimeType: string } | undefined {
  const imageBlock = result.content.find((block) => block.type === "image");
  if (!imageBlock?.data || !imageBlock.mimeType) return undefined;
  return { data: imageBlock.data, mimeType: imageBlock.mimeType };
}

function formatTruncationWarning(truncation: TruncationLike | undefined): string | undefined {
  if (!truncation?.truncated) return undefined;

  if (truncation.firstLineExceedsLimit) {
    return `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`;
  }

  if (truncation.truncatedBy === "lines") {
    return `[Truncated: showing ${truncation.outputLines ?? 0} of ${truncation.totalLines ?? 0} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`;
  }

  return `[Truncated: ${truncation.outputLines ?? 0} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`;
}

function formatCollapsedFooter(remaining: number): string | undefined {
  if (remaining <= 0) return undefined;
  return `… (${remaining} more lines, ${keyHint("app.tools.expand", "to expand")})`;
}

function renderText(
  lines: string[],
  expanded: boolean,
  collapsedLines: number,
  lineMapper: (line: string) => string,
  footerMapper: (remaining: number) => string | undefined,
  warnings: string[],
): string {
  const maxLines = expanded ? lines.length : Math.max(1, collapsedLines);
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;

  let rendered = displayLines.map(lineMapper).join("\n");

  const footer = footerMapper(remaining);
  if (footer) {
    rendered += (rendered ? "\n" : "") + footer;
  }

  if (warnings.length > 0) {
    rendered += (rendered ? "\n" : "") + warnings.join("\n");
  }

  return rendered;
}

export default function (pi: ExtensionAPI) {
  pi.events.emit("pi-extension-settings:register", {
    name: EXTENSION_NAME,
    settings: [
      {
        id: "collapsedLines",
        label: "Collapsed lines",
        description: "Number of lines shown in collapsed read, grep, and find results",
        defaultValue: String(DEFAULT_COLLAPSED_LINES),
        values: ["1", "2", "3", "5", "10"],
      },
    ] satisfies SettingDefinition[],
  });

  pi.registerTool({
    ...baseReadTool,
    promptSnippet: "Read file contents. Supports text files and images.",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createReadTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
    },

    renderResult(result, options, theme, context) {
      if (options.isPartial) {
        return new Text(theme.fg("muted", "reading…"), 0, 0);
      }

      if (result.isError) {
        const output = getTextContent(result as ResultWithContent) ?? "Read failed";
        return new Text(theme.fg("error", output), 0, 0);
      }

      const output = getTextContent(result as ResultWithContent);
      if (output !== undefined) {
        const filePath = typeof context.args?.path === "string" ? context.args.path : undefined;
        const lang = filePath ? getLanguageFromPath(filePath) : undefined;
        const lines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
        const warnings: string[] = [];
        const details = result.details as ReadToolDetails | undefined;
        const truncationWarning = formatTruncationWarning(details?.truncation);
        if (truncationWarning) warnings.push(theme.fg("warning", truncationWarning));

        const text = renderText(
          lines,
          options.expanded,
          getCollapsedLines(),
          (line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))),
          (remaining) => {
            const footer = formatCollapsedFooter(remaining);
            return footer ? theme.fg("muted", footer) : undefined;
          },
          warnings,
        );

        return new Text(text, 0, 0);
      }

      const image = getImageContent(result as ResultWithContent);
      if (image) {
        return new Text(theme.fg("success", `Image loaded (${image.mimeType})`), 0, 0);
      }

      return new Text(theme.fg("muted", "No content"), 0, 0);
    },
  });

  pi.registerTool({
    ...baseGrepTool,
    promptSnippet: "Search file contents by pattern. Respects .gitignore.",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createGrepTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
    },

    renderResult(result, options, theme) {
      if (options.isPartial) {
        return new Text(theme.fg("muted", "searching…"), 0, 0);
      }

      const output = getTextContent(result as ResultWithContent) ?? (result.isError ? "Search failed" : "");
      const details = result.details as GrepToolDetails | undefined;
      const warnings: string[] = [];
      const truncationWarning = formatTruncationWarning(details?.truncation);
      if (truncationWarning) warnings.push(theme.fg("warning", truncationWarning));
      if (typeof details?.matchLimitReached === "number") {
        warnings.push(theme.fg("warning", `[Limited to ${details.matchLimitReached} matches]`));
      }
      if (details?.linesTruncated) {
        warnings.push(theme.fg("warning", "[Some matching lines were truncated]"));
      }

      const text = renderText(
        output.split("\n"),
        options.expanded,
        getCollapsedLines(),
        (line) => result.isError ? theme.fg("error", replaceTabs(line)) : theme.fg("toolOutput", replaceTabs(line)),
        (remaining) => {
          const footer = formatCollapsedFooter(remaining);
          return footer ? theme.fg("muted", footer) : undefined;
        },
        warnings,
      );

      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    ...baseFindTool,
    promptSnippet: "Search for files by glob pattern. Respects .gitignore.",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createFindTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
    },

    renderResult(result, options, theme) {
      if (options.isPartial) {
        return new Text(theme.fg("muted", "searching…"), 0, 0);
      }

      const output = getTextContent(result as ResultWithContent) ?? (result.isError ? "Find failed" : "");
      const details = result.details as FindToolDetails | undefined;
      const warnings: string[] = [];
      const truncationWarning = formatTruncationWarning(details?.truncation);
      if (truncationWarning) warnings.push(theme.fg("warning", truncationWarning));
      if (typeof details?.resultLimitReached === "number") {
        warnings.push(theme.fg("warning", `[Limited to ${details.resultLimitReached} results]`));
      }

      const text = renderText(
        output.split("\n"),
        options.expanded,
        getCollapsedLines(),
        (line) => result.isError ? theme.fg("error", replaceTabs(line)) : theme.fg("toolOutput", replaceTabs(line)),
        (remaining) => {
          const footer = formatCollapsedFooter(remaining);
          return footer ? theme.fg("muted", footer) : undefined;
        },
        warnings,
      );

      return new Text(text, 0, 0);
    },
  });
}
