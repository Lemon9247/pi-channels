/**
 * Channels Overlay — interactive TUI for /channels and Ctrl+H.
 */

import type { Mesh } from "agent-channels";
import type { ChannelsConfig } from "./types.js";
import * as registry from "./registry.js";
import * as overlay from "./overlay.js";

interface TUI {
    requestRender(): void;
}

interface Theme {
    fg(color: string, text: string): string;
    bold(text: string): string;
}

type DoneFn = (result?: string) => void;
type Tab = "agents" | "chat";

export interface ChannelsOverlayContext {
    mesh: Mesh | null;
    config: ChannelsConfig;
    agentName: string;
    projectDir: string;
    overlayState: overlay.OverlayState;
    connectToMesh: () => Promise<string>;
}

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
        overlay.clearFocusedUnread(this.ctx.overlayState);
        this.ctx.overlayState.dmUnread.clear();
    }

    handleInput(data: string): void {
        if (this.inputMode !== "none") {
            this.handleInputMode(data);
            return;
        }

        if (data === "\x1b" || data === "\x1b\x1b" || data.charCodeAt(0) === 27) {
            this.done();
            return;
        }

        if (data === "1") {
            this.tab = "agents";
            this.selectedIndex = 0;
            this.tui.requestRender();
            return;
        }
        if (data === "2") {
            this.tab = "chat";
            this.selectedIndex = 0;
            this.tui.requestRender();
            return;
        }

        if (data === "\t") {
            this.tab = this.tab === "agents" ? "chat" : "agents";
            this.selectedIndex = 0;
            this.tui.requestRender();
            return;
        }

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

        if (data === "c" && !this.ctx.mesh) {
            this.ctx.connectToMesh().then((result) => {
                this.setNotification(result);
                this.tui.requestRender();
            });
            return;
        }

        if (data === "?") {
            this.setNotification("↑↓ move  m msg  @nick DM  j join  c connect  Tab cycle  Esc close");
            return;
        }

        if (data === "#") {
            if (!this.ctx.mesh) return;
            overlay.cycleChannel(this.ctx.overlayState, this.ctx.mesh.channels);
            this.tui.requestRender();
            return;
        }

        if (data === "\x1b[A") {
            if (this.tab === "chat") {
                this.ctx.overlayState.scrollOffset++;
            } else {
                this.selectedIndex = Math.max(0, this.selectedIndex - 1);
            }
            this.tui.requestRender();
            return;
        }

        if (data === "\x1b[B") {
            if (this.tab === "chat") {
                this.ctx.overlayState.scrollOffset = Math.max(0, this.ctx.overlayState.scrollOffset - 1);
            } else {
                this.selectedIndex++;
            }
            this.tui.requestRender();
        }
    }

    private handleInputMode(data: string): void {
        if (data === "\x1b") {
            this.inputMode = "none";
            this.inputBuffer = "";
            this.dmTarget = null;
            this.tui.requestRender();
            return;
        }

        if (data === "\r" || data === "\n") {
            if (this.inputMode === "message") {
                this.submitMessage();
            } else {
                this.submitJoinChannel();
            }
            return;
        }

        if (data === "\x1b[A") {
            const prev = overlay.navigateHistory(this.ctx.overlayState, -1);
            if (prev !== null) {
                this.inputBuffer = prev;
                this.tui.requestRender();
            }
            return;
        }

        if (data === "\x1b[B") {
            const next = overlay.navigateHistory(this.ctx.overlayState, 1);
            if (next !== null) {
                this.inputBuffer = next;
                this.tui.requestRender();
            }
            return;
        }

        if (data === "\x7f" || data === "\b") {
            this.inputBuffer = this.inputBuffer.slice(0, -1);
            this.tui.requestRender();
            return;
        }

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

        const text = this.inputBuffer.trim();
        overlay.addToHistory(this.ctx.overlayState, text);

        if (text.startsWith("@")) {
            const spaceIdx = text.indexOf(" ");
            if (spaceIdx > 1) {
                const target = text.substring(1, spaceIdx);
                const message = text.substring(spaceIdx + 1).trim();
                if (message) {
                    mesh.sendToAs("User", target, message).catch(() => {
                        this.setNotification(`Failed to DM ${target}`);
                    });
                    this.setNotification(`Sent DM to ${target}`);
                }
            }
        } else {
            mesh.sendAs("User", text, { channel: this.messageChannel });
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
        if (this.notificationTimer) {
            clearTimeout(this.notificationTimer);
        }
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

        const border = (value: string) => this.theme.fg("dim", value);
        const pad = (value: string, len: number) => {
            const visible = value.replace(/\x1b\[[0-9;]*m/g, "").length;
            return value + " ".repeat(Math.max(0, len - visible));
        };
        const row = (content: string) => border("│") + pad(" " + content, innerW) + border("│");

        const lines: string[] = [];
        const title = this.theme.fg("accent", " ☽ Mesh ");
        const agentInfo = this.ctx.agentName
            ? this.theme.fg("dim", ` ${this.ctx.agentName} `)
            : this.theme.fg("dim", " not connected ");
        const titleLen = 10 + (this.ctx.agentName?.length || 14) + 2;
        const borderLen = Math.max(0, innerW - titleLen);
        const left = Math.floor(borderLen / 2);
        const right = borderLen - left;
        lines.push(border("╭" + "─".repeat(left)) + title + "─" + agentInfo + border("─".repeat(right) + "╮"));

        const tabs: Tab[] = ["agents", "chat"];
        const tabLabels = tabs.map((tab, idx) => {
            const label = `${idx + 1}:${tab}`;
            return tab === this.tab
                ? this.theme.fg("accent", `[${label}]`)
                : this.theme.fg("dim", ` ${label} `);
        }).join("  ");
        lines.push(row(tabLabels));
        lines.push(border("├" + "─".repeat(innerW) + "┤"));

        const termRows = process.stdout?.rows ?? 24;
        const contentHeight = Math.max(6, termRows - 8);
        let contentLines = this.tab === "agents"
            ? this.renderAgentsTab(sectionW, contentHeight)
            : this.renderChatTab(sectionW, contentHeight);

        while (contentLines.length < contentHeight) contentLines.push("");
        if (contentLines.length > contentHeight) {
            contentLines = contentLines.slice(-contentHeight);
        }

        for (const line of contentLines) {
            lines.push(row(line));
        }

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
                ? "m send  j join  # cycle chat  1-2 tabs  Tab cycle  Esc close"
                : "c connect  1-2 tabs  Tab cycle  Esc close";
            lines.push(row(this.theme.fg("dim", legend)));
        }
        lines.push(border("╰" + "─".repeat(innerW) + "╯"));

        return lines;
    }

    private renderAgentsTab(_w: number, maxLines: number): string[] {
        const lines: string[] = [];
        const agents = registry.listAgentsForProject(this.ctx.projectDir);

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

        this.selectedIndex = Math.min(this.selectedIndex, agents.length - 1);

        for (let i = 0; i < agents.length && i < maxLines; i++) {
            const agent = agents[i]!;
            const emoji = registry.statusEmoji(agent.status);
            const isMe = agent.name === this.ctx.agentName;
            const marker = i === this.selectedIndex ? this.theme.fg("accent", "▸") : " ";
            const name = isMe
                ? this.theme.fg("accent", agent.name) + this.theme.fg("dim", " (you)")
                : agent.name;
            const branch = agent.branch ? this.theme.fg("dim", ` on ${agent.branch}`) : "";
            const model = agent.model ? this.theme.fg("dim", ` · ${agent.model}`) : "";
            const channels = this.theme.fg("dim", ` [${agent.channels.join(", ")}]`);
            lines.push(`${marker} ${emoji} ${name}${branch}${model}${channels}`);
        }

        lines.push("");
        lines.push(this.theme.fg("dim", "Channels:"));
        for (const channel of this.ctx.mesh.channels) {
            const members = this.ctx.mesh.channelMembers(channel);
            lines.push(this.theme.fg("dim", `  #${channel}`) + ` (${members.length})`);
        }

        return lines;
    }

    private renderChatTab(w: number, maxLines: number): string[] {
        const lines: string[] = [];
        const messages = overlay.getVisibleMessages(this.ctx.overlayState);
        const display = messages.slice(
            -(maxLines + this.ctx.overlayState.scrollOffset),
            messages.length - this.ctx.overlayState.scrollOffset || undefined,
        );

        if (display.length === 0) {
            lines.push(this.theme.fg("dim", "No messages yet."));
            lines.push("");
            lines.push("Press " + this.theme.fg("accent", "m") + " to send a message.");
            lines.push("Use " + this.theme.fg("accent", "@name message") + " for DMs.");
            return lines;
        }

        for (const msg of display) {
            const time = new Date(msg.timestamp).toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
            });
            const timeStr = this.theme.fg("dim", `[${time}]`);
            const from = msg.from === this.ctx.agentName ? this.theme.fg("accent", msg.from) : msg.from;
            const channelTag = msg.isDM
                ? this.theme.fg("dim", "(DM)")
                : this.theme.fg("dim", `#${msg.channel}`);
            const prefix = `${timeStr} ${channelTag} ${from}: `;
            const text = msg.text.length > w - 30 ? msg.text.substring(0, w - 33) + "..." : msg.text;
            lines.push(`${prefix}${text}`);
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
