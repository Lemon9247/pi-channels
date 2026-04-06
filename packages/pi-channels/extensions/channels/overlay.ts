import { type Mesh, type MessageMeta } from "agent-channels";
import { type Message } from "agent-channels";

/**
 * Chat message for display.
 */
export interface ChatMessage {
    timestamp: Date;
    from: string;
    text: string;
    channel: string;
    isDM: boolean;
}

/**
 * Overlay state.
 */
export interface OverlayState {
    /** Whether the overlay is currently shown. */
    visible: boolean;
    /** Messages in the current view. */
    messages: ChatMessage[];
    /** Currently focused channel ("all" for everything). */
    focusedChannel: string;
    /** Input buffer. */
    inputBuffer: string;
    /** Scroll position (0 = bottom). */
    scrollOffset: number;
    /** Unread count per channel. */
    unread: Map<string, number>;
    /** Unread count per DM sender. */
    dmUnread: Map<string, number>;
    /** Input history for up-arrow recall. */
    inputHistory: string[];
    /** History index for navigation (-1 = current input). */
    historyIndex: number;
    /** Maximum messages to keep. */
    maxMessages: number;
}

/**
 * Create initial overlay state.
 */
export function createOverlayState(): OverlayState {
    return {
        visible: false,
        messages: [],
        focusedChannel: "all",
        inputBuffer: "",
        scrollOffset: 0,
        unread: new Map(),
        dmUnread: new Map(),
        inputHistory: [],
        historyIndex: -1,
        maxMessages: 500,
    };
}

/**
 * Add a message to the overlay state.
 */
export function addMessage(state: OverlayState, msg: ChatMessage, agentName: string): void {
    state.messages.push(msg);
    if (state.messages.length > state.maxMessages) {
        state.messages.shift();
    }

    // Don't track unread for own messages
    if (msg.from === agentName) return;

    // Track DM unread per sender
    if (msg.isDM) {
        if (!state.visible || (state.focusedChannel !== "all" && state.focusedChannel !== "dm")) {
            const current = state.dmUnread.get(msg.from) ?? 0;
            state.dmUnread.set(msg.from, current + 1);
        }
        return;
    }

    // Track channel unread
    if (!state.visible || (state.focusedChannel !== "all" && state.focusedChannel !== msg.channel)) {
        const current = state.unread.get(msg.channel) ?? 0;
        state.unread.set(msg.channel, current + 1);
    }
}

/**
 * Add input to history.
 */
export function addToHistory(state: OverlayState, input: string): void {
    if (!input.trim()) return;
    state.inputHistory.push(input.trim());
    if (state.inputHistory.length > 50) {
        state.inputHistory.shift();
    }
    state.historyIndex = -1;
}

/**
 * Navigate history (up = -1, down = +1).
 * Returns the input at new history position, or null if at end.
 */
export function navigateHistory(state: OverlayState, direction: -1 | 1): string | null {
    if (state.inputHistory.length === 0) return null;

    const newIndex = state.historyIndex + direction;
    if (newIndex < 0) {
        state.historyIndex = -1;
        return "";
    }
    if (newIndex >= state.inputHistory.length) {
        return null;
    }
    state.historyIndex = newIndex;
    return state.inputHistory[state.inputHistory.length - 1 - state.historyIndex] ?? "";
}

/**
 * Get filtered messages for the current focus.
 */
export function getVisibleMessages(state: OverlayState): ChatMessage[] {
    if (state.focusedChannel === "all") {
        return state.messages;
    }
    return state.messages.filter((m) => m.channel === state.focusedChannel);
}

/**
 * Get total unread count.
 */
export function getTotalUnread(state: OverlayState): number {
    let total = 0;
    for (const count of state.unread.values()) {
        total += count;
    }
    return total;
}

/**
 * Clear unread for the currently focused channel.
 */
export function clearFocusedUnread(state: OverlayState): void {
    if (state.focusedChannel === "all") {
        state.unread.clear();
    } else {
        state.unread.delete(state.focusedChannel);
    }
}

/**
 * Cycle through available channels.
 */
export function cycleChannel(state: OverlayState, channels: string[]): void {
    const options = ["all", ...channels, "dm"];
    const current = options.indexOf(state.focusedChannel);
    const next = (current + 1) % options.length;
    state.focusedChannel = options[next]!;
    clearFocusedUnread(state);
}

/**
 * Render the overlay as a string (for display in terminal).
 */
export function renderOverlay(
    state: OverlayState,
    options: {
        width: number;
        height: number;
        agentName: string;
        members: string[];
        channels: string[];
        projectName: string;
    },
): string {
    const { width, height, agentName, members, channels, projectName } = options;
    const lines: string[] = [];
    const innerWidth = width - 4; // border padding

    // Top border
    lines.push(`╭──── Channels ─ ${projectName} ${"─".repeat(Math.max(0, innerWidth - 18 - projectName.length))}╮`);

    // Member bar
    const memberStr = members
        .map((m) => {
            const prefix = m === agentName ? "🟢 " : "🟢 ";
            const suffix = m === agentName ? " (you)" : "";
            return `${prefix}${m}${suffix}`;
        })
        .join("  ");
    lines.push(`│  ${memberStr.padEnd(innerWidth)}│`);

    // Channel tabs
    const channelTabs = ["all", ...channels, "dm"]
        .map((c) => {
            const unread = state.unread.get(c) ?? 0;
            const badge = unread > 0 ? ` (${unread})` : "";
            const marker = c === state.focusedChannel ? `[${c}${badge}]` : ` ${c}${badge} `;
            return marker;
        })
        .join("  ");
    lines.push(`│  ${channelTabs.padEnd(innerWidth)}│`);
    lines.push(`│${"─".repeat(innerWidth + 2)}│`);

    // Messages area
    const msgHeight = height - 7; // borders + member + channels + input + help
    const visible = getVisibleMessages(state);
    const displayMsgs = visible.slice(-(msgHeight + state.scrollOffset), visible.length - state.scrollOffset || undefined);

    for (let i = 0; i < msgHeight; i++) {
        const msg = displayMsgs[i];
        if (msg) {
            const time = msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const channelTag = state.focusedChannel === "all" && msg.channel !== "dm"
                ? `#${msg.channel} `
                : "";
            const prefix = msg.isDM ? `${msg.from} → you` : msg.from;
            const line = `[${time}] ${channelTag}${prefix}: ${msg.text}`;
            lines.push(`│  ${line.slice(0, innerWidth).padEnd(innerWidth)}│`);
        } else {
            lines.push(`│  ${"".padEnd(innerWidth)}│`);
        }
    }

    // Input area
    lines.push(`│${"─".repeat(innerWidth + 2)}│`);
    const inputLine = `> ${state.inputBuffer}_`;
    lines.push(`│  ${inputLine.slice(0, innerWidth).padEnd(innerWidth)}│`);

    // Help bar
    const helpText = "↑↓ scroll  # channels  Tab DMs  @ DM  Enter send  Esc close";
    lines.push(`│  ${helpText.padEnd(innerWidth)}│`);

    // Bottom border
    lines.push(`╰${"─".repeat(innerWidth + 2)}╯`);

    return lines.join("\n");
}

/**
 * Render the status bar (one line).
 */
export function renderStatusBar(
    agentName: string,
    peerCount: number,
    unread: number,
): string {
    const unreadStr = unread > 0 ? ` ●${unread} unread` : "";
    return `🐾 ${agentName} (${peerCount} peers)${unreadStr}    Ctrl+H ▸`;
}

/**
 * Parse overlay input for routing.
 * @returns { type: "dm", target, message } or { type: "channel", message }
 */
export function parseInput(input: string): { type: "dm"; target: string; message: string } | { type: "channel"; message: string } {
    const dmMatch = input.match(/^@(\S+)\s+(.+)$/);
    if (dmMatch) {
        return { type: "dm", target: dmMatch[1]!, message: dmMatch[2]! };
    }
    return { type: "channel", message: input };
}
