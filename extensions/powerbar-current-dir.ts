import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const SEGMENT_ID = "current-dir";

function formatCurrentDir(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";

	const rel = relative(home, cwd);
	if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
		return `~/${rel.split(sep).join("/")}`;
	}

	return cwd;
}

function emitCurrentDir(pi: ExtensionAPI, ctx: ExtensionContext): void {
	pi.events.emit("powerbar:update", {
		id: SEGMENT_ID,
		text: formatCurrentDir(ctx.cwd),
		color: "muted",
	});
}

export default function powerbarCurrentDirExtension(pi: ExtensionAPI): void {
	pi.events.emit("powerbar:register-segment", {
		id: SEGMENT_ID,
		label: "Current Directory",
	});

	pi.on("session_start", async (_event, ctx) => {
		emitCurrentDir(pi, ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		emitCurrentDir(pi, ctx);
	});
}
