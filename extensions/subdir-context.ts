/**
 * subdir-context
 *
 * Automatically loads AGENTS.md files from subdirectories when the agent
 * reads files or runs bash commands that reference those directories.
 *
 * On session start, scans the project for all AGENTS.md files. Then:
 * - On `read` tool results: walks up from the file's directory, sends
 *   followUp reads for any unloaded AGENTS.md files in the hierarchy.
 * - On `bash` tool results: checks the command string for known directory
 *   paths, sends followUp reads for matches.
 *
 * Reads flow through the normal pipeline so other extensions (e.g., context.ts)
 * see them as regular read tool calls.
 */

import fs from "node:fs";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export default function subdirContext(pi: ExtensionAPI) {
	// Set of absolute AGENTS.md paths already loaded (or queued for loading)
	const loadedAgents = new Set<string>();

	// Map: relative directory path → absolute AGENTS.md path
	// e.g. "src/components" → "/abs/path/src/components/AGENTS.md"
	let agentsDirMap = new Map<string, string>();

	let currentCwd = "";
	let cwdAgentsPath = "";

	function resolvePath(targetPath: string, baseDir: string): string {
		const absolute = path.isAbsolute(targetPath)
			? path.normalize(targetPath)
			: path.resolve(baseDir, targetPath);
		try {
			return fs.realpathSync.native?.(absolute) ?? fs.realpathSync(absolute);
		} catch {
			return absolute;
		}
	}

	function isInsideRoot(rootDir: string, targetPath: string): boolean {
		if (!rootDir) return false;
		const relative = path.relative(rootDir, targetPath);
		return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
	}

	async function scanForAgentsFiles(cwd: string): Promise<Map<string, string>> {
		const result = new Map<string, string>();

		// Try fd first, fall back to find
		let output: string;
		try {
			const fdResult = await pi.exec("fd", ["-H", "--no-ignore", "-t", "f", "-g", "AGENTS.md"], {
				cwd,
				timeout: 10000,
			});
			if (fdResult.code === 0) {
				output = fdResult.stdout;
			} else {
				throw new Error("fd failed");
			}
		} catch {
			try {
				const findResult = await pi.exec(
					"find",
					[".", "-name", "AGENTS.md", "-type", "f", "-not", "-path", "./.git/*"],
					{ cwd, timeout: 10000 },
				);
				output = findResult.stdout;
			} catch {
				return result;
			}
		}

		for (const line of output.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			// Normalize to absolute path
			const absPath = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
			const normalized = path.normalize(absPath);

			// Skip root AGENTS.md (pi already loads it)
			if (normalized === cwdAgentsPath) continue;

			// Only include files inside project root
			if (!isInsideRoot(cwd, normalized)) continue;

			const dir = path.dirname(normalized);
			const relDir = path.relative(cwd, dir);
			if (relDir) {
				result.set(relDir, normalized);
			}
		}

		return result;
	}

	async function resetSession(cwd: string, ctx: ExtensionContext) {
		currentCwd = resolvePath(cwd, process.cwd());
		cwdAgentsPath = path.join(currentCwd, "AGENTS.md");
		loadedAgents.clear();
		loadedAgents.add(cwdAgentsPath);
		agentsDirMap = await scanForAgentsFiles(currentCwd);

		// Reconstruct loadedAgents from session history (survives /reload)
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (
					block.type === "toolCall" &&
					block.name === "read" &&
					typeof block.arguments?.path === "string" &&
					path.basename(block.arguments.path) === "AGENTS.md"
				) {
					const absPath = path.normalize(resolvePath(block.arguments.path, currentCwd));
					loadedAgents.add(absPath);
				}
			}
		}
	}

	/**
	 * Collect unloaded AGENTS.md files in the hierarchy from rootDir up to
	 * (but not including) the file's directory. Returns paths ordered
	 * root-first → deepest-last.
	 */
	function collectAncestorAgents(filePath: string): string[] {
		const agents: string[] = [];
		let dir = path.dirname(filePath);

		while (isInsideRoot(currentCwd, dir) && dir !== currentCwd) {
			const candidate = path.join(dir, "AGENTS.md");
			if (candidate !== cwdAgentsPath && agentsDirMap.has(path.relative(currentCwd, dir))) {
				agents.push(candidate);
			}

			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}

		return agents.reverse();
	}

	function sendReadsForUnloaded(agentsPaths: string[]) {
		const toRead: string[] = [];

		for (const absPath of agentsPaths) {
			if (loadedAgents.has(absPath)) continue;
			loadedAgents.add(absPath); // Mark immediately to prevent duplicates
			toRead.push(absPath);
		}

		for (const absPath of toRead) {
			const relPath = path.relative(currentCwd, absPath);
			pi.sendUserMessage(
				`Read ${relPath} — this is subdirectory context (AGENTS.md). Absorb it silently and continue with the current task. Do not summarize or comment on it.`,
				{ deliverAs: "followUp" },
			);
		}
	}

	function allLoaded(): boolean {
		// +1 because loadedAgents includes the root AGENTS.md which isn't in agentsDirMap
		return loadedAgents.size > agentsDirMap.size;
	}

	// --- Event handlers ---

	const handleSessionChange = async (_event: unknown, ctx: ExtensionContext) => {
		await resetSession(ctx.cwd, ctx);
	};

	pi.on("session_start", handleSessionChange);
	pi.on("session_switch", handleSessionChange);

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return undefined;
		if (!currentCwd) await resetSession(ctx.cwd, ctx);
		if (allLoaded()) return undefined;

		if (event.toolName === "read") {
			const pathInput = (event.input as { path?: string }).path;
			if (!pathInput) return undefined;

			const absolutePath = resolvePath(pathInput, currentCwd);

			// If this is an AGENTS.md being read, just track it
			if (path.basename(absolutePath) === "AGENTS.md") {
				loadedAgents.add(path.normalize(absolutePath));
				return undefined;
			}

			// For other files, find and request unloaded AGENTS.md in hierarchy
			if (isInsideRoot(currentCwd, absolutePath)) {
				const ancestors = collectAncestorAgents(absolutePath);
				sendReadsForUnloaded(ancestors);
			}
		}

		if (event.toolName === "bash") {
			const command = (event.input as { command?: string }).command;
			if (!command) return undefined;

			const matched: string[] = [];

			for (const [relDir, absAgentsPath] of agentsDirMap) {
				if (loadedAgents.has(absAgentsPath)) continue;
				if (command.includes(relDir)) {
					matched.push(absAgentsPath);
				}
			}

			if (matched.length === 0) return undefined;

			// For each matched dir, also collect ancestors
			const allToLoad = new Set<string>();
			for (const absAgentsPath of matched) {
				allToLoad.add(absAgentsPath);
				// Walk up from this AGENTS.md's directory
				const ancestors = collectAncestorAgents(absAgentsPath);
				for (const a of ancestors) allToLoad.add(a);
			}

			// Order root-first
			const ordered = [...allToLoad].sort(
				(a, b) => a.split(path.sep).length - b.split(path.sep).length,
			);

			sendReadsForUnloaded(ordered);
		}

		return undefined;
	});
}
