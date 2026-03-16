/**
 * Timestamp extension — shows a timestamp separator after each agent interaction.
 *
 * Displays a compact "── HH:MM:SS ──" line in the conversation flow
 * after each agent response completes.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

export default function timestampExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer("timestamp", (_message, _options, theme) => {
		const details = _message.details as { time: number } | undefined;
		const time = details?.time ? new Date(details.time) : new Date();
		const hh = String(time.getHours()).padStart(2, "0");
		const mm = String(time.getMinutes()).padStart(2, "0");
		const ss = String(time.getSeconds()).padStart(2, "0");
		const stamp = `${hh}:${mm}:${ss}`;
		const line = theme.fg("dim", `── ${stamp} ──`);
		return new Text(line, 0, 0);
	});

	pi.on("agent_end", async (_event, _ctx) => {
		pi.sendMessage(
			{
				customType: "timestamp",
				content: "",
				display: true,
				details: { time: Date.now() },
			},
			{ triggerTurn: false },
		);
	});
}
