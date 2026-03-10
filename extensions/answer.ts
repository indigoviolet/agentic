/**
 * Section response hook - extracts addressable subsections from assistant responses
 *
 * Custom interactive TUI for responding to sections one at a time.
 *
 * Pattern:
 * 1. /answer command gets the last assistant message
 * 2. Shows a spinner while extracting sections as structured JSON
 * 3. Presents an interactive TUI to navigate and respond to each section
 * 4. When a section presents clear options, shows a selector
 * 5. Submits the compiled responses when done
 */

import { complete, type Model, type Api, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	matchesKey,
	SelectList,
	type SelectListTheme,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

// ── Data model ───────────────────────────────────────────────────────────────

interface ExtractedSection {
	title: string;
	content: string;
	options?: string[];
}

interface ExtractionResult {
	sections: ExtractedSection[];
}

// ── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a text analyzer. Given text from a conversation, identify the distinct addressable subsections that a reader would want to respond to independently.

Output a JSON object with this structure:
{
  "sections": [
    {
      "title": "Brief identifier for this section",
      "content": "The full text of the section, preserving formatting",
      "options": ["option 1", "option 2"]
    }
  ]
}

Rules:
- Identify every logical subsection: numbered items, bullet groups, recommendation blocks, discussion points, questions, action items
- Each section should be something a reader would respond to independently
- "title" should be a concise identifier (e.g. "#1 — Test readability", "Database choice", "Next steps")
- "content" must include the FULL text of that section — do not summarize or truncate
- "options" is ONLY for sections that present a clear set of discrete choices or recommended actions. Include the options as short labels. Omit the field entirely when there are no clear choices.
- Keep sections in the order they appeared
- If the text has no distinct sections, return {"sections": []}
- Do NOT split a single cohesive paragraph into multiple sections
- DO split numbered/bulleted items into separate sections even if they are grouped under one heading

Example — a message with recommendations:
{
  "sections": [
    {
      "title": "#5, #6, #7 — No change needed",
      "content": "#5 & #6 — [] default vs Field(default_factory=list)\\nThis is a non-issue for Pydantic...\\n\\n#7 — OpenAPI schema regen\\nKnown deferral...",
      "options": ["Reply-only (explain why no change needed)", "Make code changes anyway", "Defer to later"]
    },
    {
      "title": "#1 & #2 — Test readability",
      "content": "Valid nits. The nested self._cfg(self._zip(self._file(...))) is hard to read...",
      "options": ["Code changes — simplify test helpers", "Reply-only (explain current approach)", "Defer"]
    }
  ]
}

Example — a message with questions:
{
  "sections": [
    {
      "title": "Database choice",
      "content": "What is your preferred database? We support MySQL and PostgreSQL.",
      "options": ["MySQL", "PostgreSQL"]
    },
    {
      "title": "Language preference",
      "content": "Should we use TypeScript or JavaScript for the frontend?",
      "options": ["TypeScript", "JavaScript"]
    }
  ]
}

Example — a message with discussion points (no options):
{
  "sections": [
    {
      "title": "Architecture concern",
      "content": "The current approach uses a monolithic handler. We could split it into..."
    },
    {
      "title": "Testing strategy",
      "content": "We need to decide how to test the new pipeline..."
    }
  ]
}`;

const HAIKU_MODEL_ID = "claude-haiku-4-5";

// ── Model selection ──────────────────────────────────────────────────────────

/**
 * Prefer Haiku for extraction, fallback to current model.
 */
async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: {
		find: (provider: string, modelId: string) => Model<Api> | undefined;
		getApiKey: (model: Model<Api>) => Promise<string | undefined>;
	},
): Promise<Model<Api>> {
	const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
	if (!haikuModel) {
		return currentModel;
	}

	const apiKey = await modelRegistry.getApiKey(haikuModel);
	if (!apiKey) {
		return currentModel;
	}

	return haikuModel;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		let jsonStr = text;

		// Remove markdown code block if present
		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) {
			jsonStr = jsonMatch[1].trim();
		}

		const parsed = JSON.parse(jsonStr);
		if (parsed && Array.isArray(parsed.sections)) {
			return parsed as ExtractionResult;
		}
		return null;
	} catch {
		return null;
	}
}

// ── Response types ───────────────────────────────────────────────────────────

type SectionResponse =
	| { kind: "option"; selected: string }
	| { kind: "text"; text: string }
	| { kind: "empty" };

function responseToString(r: SectionResponse): string {
	switch (r.kind) {
		case "option":
			return r.selected;
		case "text":
			return r.text;
		case "empty":
			return "(no response)";
	}
}

function isResponseFilled(r: SectionResponse): boolean {
	return r.kind !== "empty";
}

// ── TUI Component ────────────────────────────────────────────────────────────

/**
 * Interactive component for responding to extracted sections one at a time.
 * Sections with options show a SelectList; others show a free-text Editor.
 */
class SectionResponseComponent implements Component {
	private sections: ExtractedSection[];
	private responses: SectionResponse[];
	private currentIndex: number = 0;
	private tui: TUI;
	private onDone: (result: string | null) => void;
	private showingConfirmation: boolean = false;

	// Input modes — only one is active at a time
	private editor: Editor;
	private selectList?: SelectList;
	/** When true, user pressed a key to switch from selector to free-text for a section with options */
	private overrideToEditor: boolean = false;

	// Cache
	private cachedWidth?: number;
	private cachedLines?: string[];

	// Colors
	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

	private selectListTheme: SelectListTheme = {
		selectedPrefix: (s: string) => this.cyan(s),
		selectedText: (s: string) => this.cyan(s),
		description: (s: string) => this.gray(s),
		scrollInfo: (s: string) => this.dim(s),
		noMatch: (s: string) => this.yellow(s),
	};

	constructor(
		sections: ExtractedSection[],
		tui: TUI,
		onDone: (result: string | null) => void,
	) {
		this.sections = sections;
		this.responses = sections.map(() => ({ kind: "empty" as const }));
		this.tui = tui;
		this.onDone = onDone;

		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: this.selectListTheme,
		};

		this.editor = new Editor(tui, editorTheme);
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};

		this.syncInputForCurrentSection();
	}

	// ── Section / input helpers ────────────────────────────────────────────

	private currentSection(): ExtractedSection {
		return this.sections[this.currentIndex];
	}

	private hasOptions(): boolean {
		const s = this.currentSection();
		return Array.isArray(s.options) && s.options.length > 0;
	}

	/** Should we show the selector (vs the editor) right now? */
	private isSelectMode(): boolean {
		return this.hasOptions() && !this.overrideToEditor;
	}

	/** Build / tear down the selector or editor to match the current section */
	private syncInputForCurrentSection(): void {
		const r = this.responses[this.currentIndex];

		if (this.isSelectMode()) {
			const opts = this.currentSection().options!;
			this.selectList = new SelectList(
				opts.map((o) => ({ value: o, label: o })),
				Math.min(opts.length, 8),
				this.selectListTheme,
			);
			// If user already chose an option for this section, pre-select it
			if (r.kind === "option") {
				const idx = opts.indexOf(r.selected);
				if (idx >= 0) this.selectList.setSelectedIndex(idx);
			}
			// Wire up selection to auto-advance
			this.selectList.onSelect = (item) => {
				this.responses[this.currentIndex] = { kind: "option", selected: item.value };
				this.advance();
			};
		} else {
			this.selectList = undefined;
			// Restore previously typed text
			this.editor.setText(r.kind === "text" ? r.text : "");
		}
	}

	private saveCurrentResponse(): void {
		if (this.isSelectMode()) {
			// selection is saved on select; nothing to persist mid-browse
		} else {
			const text = this.editor.getText().trim();
			this.responses[this.currentIndex] = text ? { kind: "text", text } : { kind: "empty" };
		}
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.sections.length) return;
		this.saveCurrentResponse();
		this.currentIndex = index;
		this.overrideToEditor = false;
		this.syncInputForCurrentSection();
		this.invalidate();
	}

	/** Move to next section, or show confirmation on last */
	private advance(): void {
		if (this.currentIndex < this.sections.length - 1) {
			this.navigateTo(this.currentIndex + 1);
		} else {
			this.saveCurrentResponse();
			this.showingConfirmation = true;
			this.invalidate();
		}
		this.tui.requestRender();
	}

	private submit(): void {
		this.saveCurrentResponse();

		const parts: string[] = [];
		for (let i = 0; i < this.sections.length; i++) {
			const s = this.sections[i];
			const r = this.responses[i];
			parts.push(`**${s.title}**`);
			parts.push(responseToString(r));
			parts.push("");
		}

		this.onDone(parts.join("\n").trim());
	}

	private cancel(): void {
		this.onDone(null);
	}

	// ── Component interface ────────────────────────────────────────────────

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		// Confirmation dialog
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		// Global: cancel
		if (matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}

		// Global: Tab / Shift+Tab navigation
		if (matchesKey(data, Key.tab)) {
			this.saveCurrentResponse();
			if (this.currentIndex < this.sections.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.saveCurrentResponse();
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
			}
			return;
		}

		// ── Select mode ────────────────────────────────────────────────
		if (this.isSelectMode() && this.selectList) {
			// Escape in select mode → switch to free-text editor for this section
			if (matchesKey(data, Key.escape)) {
				this.overrideToEditor = true;
				this.syncInputForCurrentSection();
				this.invalidate();
				this.tui.requestRender();
				return;
			}

			// Delegate to SelectList (up/down/enter)
			this.selectList.handleInput(data);
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// ── Editor mode ────────────────────────────────────────────────

		// Escape in editor mode → cancel (or if overridden from select, go back to select)
		if (matchesKey(data, Key.escape)) {
			if (this.overrideToEditor && this.hasOptions()) {
				this.overrideToEditor = false;
				this.syncInputForCurrentSection();
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			this.cancel();
			return;
		}

		// Plain Enter (not Shift+Enter) → advance
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			this.saveCurrentResponse();
			this.advance();
			return;
		}

		// Up/Down when editor is empty → navigate sections
		if (matchesKey(data, Key.up) && this.editor.getText() === "" && this.currentIndex > 0) {
			this.navigateTo(this.currentIndex - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) && this.editor.getText() === "" && this.currentIndex < this.sections.length - 1) {
			this.navigateTo(this.currentIndex + 1);
			this.tui.requestRender();
			return;
		}

		// Pass to editor
		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 120);
		const contentWidth = boxWidth - 4;

		const hLine = (n: number) => "─".repeat(n);

		const boxLine = (content: string, leftPad: number = 2): string => {
			const padded = " ".repeat(leftPad) + content;
			const right = Math.max(0, boxWidth - visibleWidth(padded) - 2);
			return this.dim("│") + padded + " ".repeat(right) + this.dim("│");
		};

		const emptyBoxLine = (): string =>
			this.dim("│") + " ".repeat(boxWidth - 2) + this.dim("│");

		const pad = (line: string): string => {
			const w = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - w));
		};

		// ── Title bar ──────────────────────────────────────────────────
		lines.push(pad(this.dim("╭" + hLine(boxWidth - 2) + "╮")));
		const title = `${this.bold(this.cyan("Sections"))} ${this.dim(`(${this.currentIndex + 1}/${this.sections.length})`)}`;
		lines.push(pad(boxLine(title)));
		lines.push(pad(this.dim("├" + hLine(boxWidth - 2) + "┤")));

		// ── Progress dots ──────────────────────────────────────────────
		const dots: string[] = [];
		for (let i = 0; i < this.sections.length; i++) {
			const filled = isResponseFilled(this.responses[i]);
			const current = i === this.currentIndex;
			if (current) dots.push(this.cyan("●"));
			else if (filled) dots.push(this.green("●"));
			else dots.push(this.dim("○"));
		}
		lines.push(pad(boxLine(dots.join(" "))));
		lines.push(pad(emptyBoxLine()));

		// ── Section title ──────────────────────────────────────────────
		const sec = this.currentSection();
		const sectionTitle = this.bold(this.cyan(sec.title));
		for (const l of wrapTextWithAnsi(sectionTitle, contentWidth)) {
			lines.push(pad(boxLine(l)));
		}
		lines.push(pad(emptyBoxLine()));

		// ── Section content (rendered as markdown) ─────────────────────
		const mdTheme = getMarkdownTheme();
		const md = new Markdown(sec.content, 0, 0, mdTheme);
		const mdLines = md.render(contentWidth - 2);
		for (const l of mdLines) {
			lines.push(pad(boxLine(l)));
		}
		lines.push(pad(emptyBoxLine()));

		// ── Input area ─────────────────────────────────────────────────
		lines.push(pad(this.dim("├" + hLine(boxWidth - 2) + "┤")));

		if (this.isSelectMode() && this.selectList) {
			// Render selector
			const selectLines = this.selectList.render(contentWidth);
			for (const l of selectLines) {
				lines.push(pad(boxLine(l)));
			}
		} else {
			// Render editor
			const label = this.bold("Response: ");
			const editorWidth = contentWidth - 4 - visibleWidth("Response: ");
			const editorLines = this.editor.render(editorWidth);
			for (let i = 1; i < editorLines.length - 1; i++) {
				if (i === 1) {
					lines.push(pad(boxLine(label + editorLines[i])));
				} else {
					lines.push(pad(boxLine(" ".repeat(visibleWidth("Response: ")) + editorLines[i])));
				}
			}
		}

		lines.push(pad(emptyBoxLine()));

		// ── Footer ─────────────────────────────────────────────────────
		if (this.showingConfirmation) {
			lines.push(pad(this.dim("├" + hLine(boxWidth - 2) + "┤")));
			const msg = `${this.yellow("Submit all responses?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`;
			lines.push(pad(boxLine(truncateToWidth(msg, contentWidth))));
		} else {
			lines.push(pad(this.dim("├" + hLine(boxWidth - 2) + "┤")));
			let controls: string;
			if (this.isSelectMode()) {
				controls = `${this.dim("↑↓")} choose · ${this.dim("Enter")} select · ${this.dim("Tab")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Esc")} type custom · ${this.dim("Ctrl+C")} cancel`;
			} else if (this.overrideToEditor && this.hasOptions()) {
				controls = `${this.dim("Enter")} next · ${this.dim("Tab")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Shift+Enter")} newline · ${this.dim("Esc")} back to options · ${this.dim("Ctrl+C")} cancel`;
			} else {
				controls = `${this.dim("Enter")} next · ${this.dim("Tab")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Shift+Enter")} newline · ${this.dim("Esc")} cancel`;
			}
			lines.push(pad(boxLine(truncateToWidth(controls, contentWidth))));
		}
		lines.push(pad(this.dim("╰" + hLine(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

// ── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const answerHandler = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("answer requires interactive mode", "error");
			return;
		}

		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		// Find the last assistant message on the current branch
		const branch = ctx.sessionManager.getBranch();
		let lastAssistantText: string | undefined;

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message") {
				const msg = entry.message;
				if ("role" in msg && msg.role === "assistant") {
					if (msg.stopReason !== "stop") {
						ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
						return;
					}
					const textParts = msg.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text);
					if (textParts.length > 0) {
						lastAssistantText = textParts.join("\n");
						break;
					}
				}
			}
		}

		if (!lastAssistantText) {
			ctx.ui.notify("No assistant messages found", "error");
			return;
		}

		// Select the best model for extraction (prefer Haiku)
		const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);

		// Run extraction with loader UI
		const extractionResult = await ctx.ui.custom<ExtractionResult | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Extracting sections using ${extractionModel.id}...`);
			loader.onAbort = () => done(null);

			const doExtract = async () => {
				const apiKey = await ctx.modelRegistry.getApiKey(extractionModel);
				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: lastAssistantText! }],
					timestamp: Date.now(),
				};

				const response = await complete(
					extractionModel,
					{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
					{ apiKey, signal: loader.signal },
				);

				if (response.stopReason === "aborted") {
					return null;
				}

				const responseText = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				return parseExtractionResult(responseText);
			};

			doExtract()
				.then(done)
				.catch(() => done(null));

			return loader;
		});

		if (extractionResult === null) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		if (extractionResult.sections.length === 0) {
			ctx.ui.notify("No sections found in the last message", "info");
			return;
		}

		// Show the section response component
		const result = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
			return new SectionResponseComponent(extractionResult.sections, tui, done);
		});

		if (result === null) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		// Send the responses as a message and trigger a turn
		pi.sendMessage(
			{
				customType: "answers",
				content: "Here are my responses to each section:\n\n" + result,
				display: true,
			},
			{ triggerTurn: true },
		);
	};

	pi.registerCommand("answer", {
		description: "Extract sections from last assistant message for interactive response",
		handler: (_args, ctx) => answerHandler(ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and respond to sections",
		handler: answerHandler,
	});
}
