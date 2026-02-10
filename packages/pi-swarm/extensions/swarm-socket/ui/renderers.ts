/**
 * Message Renderers
 *
 * Custom message type renderers for swarm notifications.
 * Makes notifications look distinct from regular assistant messages.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

export function registerMessageRenderers(pi: ExtensionAPI): void {
    pi.registerMessageRenderer("swarm-nudge", (message, _options, theme) => {
        const text = theme.fg("accent", "🔔 ") + message.content;
        return new Text(text, 0, 0);
    });

    pi.registerMessageRenderer("swarm-blocker", (message, _options, theme) => {
        const text = theme.fg("warning", "⚠️  ") + message.content;
        return new Text(text, 0, 0);
    });

    pi.registerMessageRenderer("swarm-instruct", (message, _options, theme) => {
        const text = theme.fg("accent", "📋 ") + message.content;
        return new Text(text, 0, 0);
    });

    pi.registerMessageRenderer("swarm-hive", (message, _options, theme) => {
        return new Text(theme.fg("accent", "🐝 ") + message.content, 0, 0);
    });

    pi.registerMessageRenderer("swarm-complete", (message, _options, theme) => {
        const text = theme.fg("success", "🐝 ") +
            theme.fg("success", theme.bold("All swarm agents have completed.")) +
            "\n" + theme.fg("dim", "Read the hive-mind file and agent reports to synthesize findings.");
        return new Text(text, 0, 0);
    });
}
