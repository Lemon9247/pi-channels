/**
 * Channels Overlay — full TUI component for /channels command
 *
 * Displays agents, channels, messages, and activity feed.
 * Supports sending messages, joining channels, and managing config.
 */

import type { Mesh } from "agent-channels";
import type { ChannelsConfig, RegistryEntry } from "./types.js";
import * as registry from "./registry.js";
import * as presence from "./presence.js";
import * as feed from "./feed.js";
import * as overlay from "./overlay.js";

// We use the pi-tui types at runtime via the pi extension API.
// These interfaces match the required shape.
interface TUI {
    requestRender(): void;
}

interface Theme {
    fg(color: string, text: string): string;
    bold(text: string): string;
}

type DoneFn = (result?: string) => void;

export interface ChannelsOverlayContext {
    mesh: Mesh | null;
    config: ChannelsConfig;
    agentName: string;
    projectDir: string;
    overlayState: overlay.OverlayState;
    connectToMesh: () => Promise<string>;
}

type Tab = "agents" | "chat" | "feed";

export class ChannelsOverlay {
    readonly width = 80;
    focused = false;

    private tab: Tab = "agents";
    private inputMode: "none" | "message" | "channel" = "none";
    private inputBuffer = "";
    private selectedIndex = 0;
    private messageChannel = "general";
    private dmTarget: string | null = null;
    private notification: string | null = null;
    private notificationTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private tui: TUI,
        private theme: Theme,
        private ctx: ChannelsOverlayContext,
        private done: DoneFn,
    ) {
        // Clear unread on open
        overlay.clearFocusedUnread(this.ctx.overlayState);
        // Clear DM unread
        this.ctx.overlayState.dmUnread.clear();
    }

    handleInput(data: string): void {
        // Input mode handling
        if (this.inputMode !== "none") {
            this.handleInputMode(data);
            return;
        }

        // Escape — close overlay (handle both \x1b and char code 27)
        if (data === "\x1b" || data === "\x1b\x1b" || data.charCodeAt(0) === 27) {
            try {
                this.done();
            } catch (e) {
                // Fallback: if done fails, just return
            }
            return;
        }

        // Tab switching: 1, 2, 3
        if (data === "1") { this.tab = "agents"; this.selectedIndex = 0; this.tui.requestRender(); return; }
        if (data === "2") { this.tab = "chat"; this.selectedIndex = 0; this.tui.requestRender(); return; }
        if (data === "3") { this.tab = "feed"; this.selectedIndex = 0; this.tui.requestRender(); return; }

        // Tab key cycles tabs
        if (data === "\t") {
            const tabs: Tab[] = ["agents", "chat", "feed"];
            const idx = tabs.indexOf(this.tab);
            this.tab = tabs[(idx + 1) % tabs.length];
            this.selectedIndex = 0;
            this.tui.requestRender();
            return;
        }

        // m — start message input
        if (data === "m" || data === "@") {
            if (!this.ctx.mesh) {
                this.setNotification("Not connected to mesh");
                return;
            }
            this.inputMode = "message";
            this.inputBuffer = data === "@" ? "@" : "";
            this.tui.requestRender();
            return;
        }

        // j — join channel
        if (data === "j") {
            if (!this.ctx.mesh) {
                this.setNotification("Not connected to mesh");
                return;
            }
            this.inputMode = "channel";
            this.inputBuffer = "";
            this.tui.requestRender();
            return;
        }

        // c — connect to mesh
        if (data === "c" && !this.ctx.mesh) {
            this.ctx.connectToMesh().then((result) => {
                this.setNotification(result);
                this.tui.requestRender();
            });
            return;
        }

        // ? — show help
        if (data === "?") {
            this.setNotification("↑↓ scroll | m msg | @nick DM | j join | c connect | Tab cycle | Esc close");
            return;
        }

        // Navigation and scroll
        if (data === "\x1b[A") { // up
            if (this.tab === "chat") {
                // Scroll up in chat
                this.ctx.overlayState.scrollOffset++;
                this.tui.requestRender();
            } else {
                this.selectedIndex = Math.max(0, this.selectedIndex - 1);
                this.tui.requestRender();
            }
            return;
        }
        if (data === "\x1b[B") { // down
            if (this.tab === "chat") {
                // Scroll down in chat
                this.ctx.overlayState.scrollOffset = Math.max(0, this.ctx.overlayState.scrollOffset - 1);
                this.tui.requestRender();
            } else {
                this.selectedIndex++;
                this.tui.requestRender();
            }
            return;
        }
    }

    private handleInputMode(data: string): void {
        // Escape — cancel input
        if (data === "\x1b") {
            this.inputMode = "none";
            this.inputBuffer = "";
            this.dmTarget = null;
            this.tui.requestRender();
            return;
        }

        // Enter — submit
        if (data === "\r" || data === "\n") {
            if (this.inputMode === "message") {
                this.submitMessage();
            } else if (this.inputMode === "channel") {
                this.submitJoinChannel();
            }
            return;
        }

        // Up arrow — previous in history
        if (data === "\x1b[A") {
            const prev = overlay.navigateHistory(this.ctx.overlayState, -1);
            if (prev !== null) {
                this.inputBuffer = prev;
                this.tui.requestRender();
            }
            return;
        }

        // Down arrow — next in history
        if (data === "\x1b[B") {
            const next = overlay.navigateHistory(this.ctx.overlayState, 1);
            if (next !== null) {
                this.inputBuffer = next;
                this.tui.requestRender();
            }
            return;
        }

        // Backspace
        if (data === "\x7f" || data === "\b") {
            this.inputBuffer = this.inputBuffer.slice(0, -1);
            this.tui.requestRender();
            return;
        }

        // Regular character
        if (data.length === 1 && data >= " ") {
            this.inputBuffer += data;
            this.tui.requestRender();
        }
    }

    private submitMessage(): void {
        const mesh = this.ctx.mesh;
        if (!mesh || !this.inputBuffer.trim()) {
            this.inputMode = "none";
            this.inputBuffer = "";
            this.tui.requestRender();
            return;
        }

        let text = this.inputBuffer.trim();

        // Save to history before sending
        overlay.addToHistory(this.ctx.overlayState, text);

        // Check for @agent DM syntax
        if (text.startsWith("@")) {
            const spaceIdx = text.indexOf(" ");
            if (spaceIdx > 1) {
                const target = text.substring(1, spaceIdx);
                const msg = text.substring(spaceIdx + 1).trim();
                if (msg) {
                    mesh.sendToAs("Willow", target, msg).catch(() => {
                        this.setNotification(`Failed to DM ${target}`);
                    });
                    feed.appendEvent(this.ctx.projectDir, "message", "Willow", `DM to ${target}: ${msg}`);
                    this.setNotification(`Sent DM to ${target}`);
                }
            }
        } else {
            // Channel message - send as human (Willow), not as agent
            mesh.sendAs("Willow", text, { channel: this.messageChannel });
            feed.appendEvent(this.ctx.projectDir, "message", "Willow", `#${this.messageChannel}: ${text}`);
            this.setNotification(`Sent to #${this.messageChannel}`);
        }

        this.inputMode = "none";
        this.inputBuffer = "";
        this.dmTarget = null;
        this.tui.requestRender();
    }

    private submitJoinChannel(): void {
        const mesh = this.ctx.mesh;
        const channel = this.inputBuffer.trim().replace(/^#/, "");
        if (!mesh || !channel) {
            this.inputMode = "none";
            this.inputBuffer = "";
            this.tui.requestRender();
            return;
        }

        mesh.join(channel).then(() => {
            feed.appendEvent(this.ctx.projectDir, "join", this.ctx.agentName, `Joined #${channel}`);
            registry.updateAgent(this.ctx.agentName, { channels: mesh.channels });
            this.setNotification(`Joined #${channel}`);
            this.tui.requestRender();
        });

        this.inputMode = "none";
        this.inputBuffer = "";
        this.tui.requestRender();
    }

    private setNotification(msg: string): void {
        this.notification = msg;
        if (this.notificationTimer) clearTimeout(this.notificationTimer);
        this.notificationTimer = setTimeout(() => {
            this.notification = null;
            this.tui.requestRender();
        }, 3000);
        this.tui.requestRender();
    }

    render(_width: number): string[] {
        const w = this.width;
        const innerW = w - 2;
        const sectionW = innerW - 2;

        const border = (s: string) => this.theme.fg("dim", s);
        const pad = (s: string, len: number) => {
            // Rough visible width (ignoring ANSI codes)
            const vis = s.replace(/\x1b\[[0-9;]*m/g, "").length;
            return s + " ".repeat(Math.max(0, len - vis));
        };
        const row = (content: string) => border("│") + pad(" " + content, innerW) + border("│");
        const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");

        const lines: string[] = [];

        // Title bar
        const title = this.theme.fg("accent", " Channels ");
        const agentInfo = this.ctx.agentName
            ? this.theme.fg("dim", ` ${this.ctx.agentName} `)
            : this.theme.fg("dim", " not connected ");
        const titleLen = 10 + (this.ctx.agentName?.length || 14) + 2;
        const borderLen = Math.max(0, innerW - titleLen);
        const leftB = Math.floor(borderLen / 2);
        const rightB = borderLen - leftB;
        lines.push(border("╭" + "─".repeat(leftB)) + title + "─" + agentInfo + border("─".repeat(rightB) + "╮"));

        // Tab bar
        const tabs: Tab[] = ["agents", "chat", "feed"];
        const tabLabels = tabs.map((t, i) => {
            const label = `${i + 1}:${t}`;
            return t === this.tab
                ? this.theme.fg("accent", `[${label}]`)
                : this.theme.fg("dim", ` ${label} `);
        }).join("  ");
        lines.push(row(tabLabels));
        lines.push(border("├" + "─".repeat(innerW) + "┤"));

        // Content area
        const termRows = process.stdout?.rows ?? 24;
        const contentHeight = Math.max(6, termRows - 8);

        let contentLines: string[];
        switch (this.tab) {
            case "agents":
                contentLines = this.renderAgentsTab(sectionW, contentHeight);
                break;
            case "chat":
                contentLines = this.renderChatTab(sectionW, contentHeight);
                break;
            case "feed":
                contentLines = this.renderFeedTab(sectionW, contentHeight);
                break;
        }

        // Pad/truncate content
        while (contentLines.length < contentHeight) contentLines.push("");
        if (contentLines.length > contentHeight) contentLines = contentLines.slice(-contentHeight);

        for (const line of contentLines) {
            lines.push(row(line));
        }

        // Input area or notification
        lines.push(border("├" + "─".repeat(innerW) + "┤"));
        if (this.inputMode === "message") {
            const prompt = this.dmTarget ? `@${this.dmTarget}: ` : `#${this.messageChannel}: `;
            lines.push(row(this.theme.fg("accent", prompt) + this.inputBuffer + "█"));
        } else if (this.inputMode === "channel") {
            lines.push(row(this.theme.fg("accent", "Join #") + this.inputBuffer + "█"));
        } else if (this.notification) {
            lines.push(row(this.theme.fg("accent", this.notification)));
        } else {
            const legend = this.ctx.mesh
                ? "m send  j join  1-3 tabs  Tab cycle  Esc close"
                : "c connect  1-3 tabs  Tab cycle  Esc close";
            lines.push(row(this.theme.fg("dim", legend)));
        }
        lines.push(border("╰" + "─".repeat(innerW) + "╯"));

        return lines;
    }

    private renderAgentsTab(w: number, maxLines: number): string[] {
        const lines: string[] = [];
        const agents = registry.listAgents();

        if (!this.ctx.mesh) {
            lines.push(this.theme.fg("dim", "Not connected to mesh."));
            lines.push("");
            lines.push("Press " + this.theme.fg("accent", "c") + " to connect.");
            return lines;
        }

        if (agents.length === 0) {
            lines.push(this.theme.fg("dim", "No agents registered."));
            return lines;
        }

        // Clamp selected index
        this.selectedIndex = Math.min(this.selectedIndex, agents.length - 1);

        for (let i = 0; i < agents.length && i < maxLines; i++) {
            const a = agents[i];
            const emoji = presence.statusEmoji(a.status);
            const isMe = a.name === this.ctx.agentName;
            const marker = i === this.selectedIndex ? this.theme.fg("accent", "▸") : " ";
            const name = isMe
                ? this.theme.fg("accent", a.name) + this.theme.fg("dim", " (you)")
                : a.name;
            const branch = a.branch ? this.theme.fg("dim", ` on ${a.branch}`) : "";
            const model = a.model ? this.theme.fg("dim", ` · ${a.model}`) : "";
            const channels = this.theme.fg("dim", ` [${a.channels.join(", ")}]`);

            lines.push(`${marker} ${emoji} ${name}${branch}${model}${channels}`);
        }

        // Show channels section
        if (this.ctx.mesh) {
            lines.push("");
            lines.push(this.theme.fg("dim", "Channels:"));
            for (const ch of this.ctx.mesh.channels) {
                const members = this.ctx.mesh.channelMembers(ch);
                lines.push(this.theme.fg("dim", `  #${ch}`) + ` (${members.length})`);
            }
        }

        return lines;
    }

    private renderChatTab(w: number, maxLines: number): string[] {
        const lines: string[] = [];
        const messages = this.ctx.overlayState.messages;

        if (messages.length === 0) {
            lines.push(this.theme.fg("dim", "No messages yet."));
            lines.push("");
            lines.push("Press " + this.theme.fg("accent", "m") + " to send a message.");
            lines.push("Use " + this.theme.fg("accent", "@name message") + " for DMs.");
            return lines;
        }

        // Show recent messages, fitting in maxLines
        const visible = messages.slice(-maxLines);
        for (const msg of visible) {
            const time = new Date(msg.timestamp).toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            });
            const timeStr = this.theme.fg("dim", `[${time}]`);
            const from = msg.from === this.ctx.agentName
                ? this.theme.fg("accent", msg.from)
                : msg.from;
            const channelTag = msg.isDM
                ? this.theme.fg("dim", "(DM)")
                : this.theme.fg("dim", `#${msg.channel}`);
            
            const prefix = `${timeStr} ${channelTag} ${from}: `;
            const text = msg.text.length > w - 30
                ? msg.text.substring(0, w - 33) + "..."
                : msg.text;
            lines.push(`${prefix}${text}`);
        }

        return lines;
    }

    private renderFeedTab(w: number, maxLines: number): string[] {
        const lines: string[] = [];
        const events = feed.readEvents(this.ctx.projectDir, maxLines);

        if (events.length === 0) {
            lines.push(this.theme.fg("dim", "No activity yet."));
            return lines;
        }

        for (const e of events) {
            const time = new Date(e.timestamp).toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            });
            const timeStr = this.theme.fg("dim", `[${time}]`);
            const agent = e.agent === this.ctx.agentName
                ? this.theme.fg("accent", e.agent)
                : e.agent;
            const detail = e.detail ? this.theme.fg("dim", ` — ${e.detail}`) : "";
            const typeColor = e.type === "join" || e.type === "leave" ? "dim" : "text";
            const typeStr = this.theme.fg?.(typeColor, e.type) ?? e.type;

            lines.push(`${timeStr} ${agent} ${typeStr}${detail}`);
        }

        return lines;
    }

    invalidate(): void {}

    dispose(): void {
        if (this.notificationTimer) {
            clearTimeout(this.notificationTimer);
            this.notificationTimer = null;
        }
    }
}
