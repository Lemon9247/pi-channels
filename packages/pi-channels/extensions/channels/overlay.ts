export interface ChatMessage {
    timestamp: Date;
    from: string;
    text: string;
    channel: string;
    isDM: boolean;
}

export interface OverlayState {
    visible: boolean;
    messages: ChatMessage[];
    focusedChannel: string;
    inputBuffer: string;
    scrollOffset: number;
    unread: Map<string, number>;
    dmUnread: Map<string, number>;
    inputHistory: string[];
    historyIndex: number;
    maxMessages: number;
}

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

export function addMessage(state: OverlayState, msg: ChatMessage, agentName: string): void {
    state.messages.push(msg);
    if (state.messages.length > state.maxMessages) {
        state.messages.shift();
    }

    if (msg.from === agentName) return;

    if (msg.isDM) {
        if (!state.visible || (state.focusedChannel !== "all" && state.focusedChannel !== "dm")) {
            const current = state.dmUnread.get(msg.from) ?? 0;
            state.dmUnread.set(msg.from, current + 1);
        }
        return;
    }

    if (!state.visible || (state.focusedChannel !== "all" && state.focusedChannel !== msg.channel)) {
        const current = state.unread.get(msg.channel) ?? 0;
        state.unread.set(msg.channel, current + 1);
    }
}

export function addToHistory(state: OverlayState, input: string): void {
    if (!input.trim()) return;
    state.inputHistory.push(input.trim());
    if (state.inputHistory.length > 50) {
        state.inputHistory.shift();
    }
    state.historyIndex = -1;
}

export function navigateHistory(state: OverlayState, direction: -1 | 1): string | null {
    if (state.inputHistory.length === 0) return null;

    if (direction === -1) {
        if (state.historyIndex < state.inputHistory.length - 1) {
            state.historyIndex++;
        }
        return state.inputHistory[state.inputHistory.length - 1 - state.historyIndex] ?? "";
    }

    if (state.historyIndex <= 0) {
        state.historyIndex = -1;
        return "";
    }

    state.historyIndex--;
    return state.inputHistory[state.inputHistory.length - 1 - state.historyIndex] ?? "";
}

export function getVisibleMessages(state: OverlayState): ChatMessage[] {
    if (state.focusedChannel === "all") {
        return state.messages;
    }
    if (state.focusedChannel === "dm") {
        return state.messages.filter((message) => message.isDM);
    }
    return state.messages.filter((message) => message.channel === state.focusedChannel);
}

export function getTotalUnread(state: OverlayState): number {
    let total = 0;
    for (const count of state.unread.values()) {
        total += count;
    }
    for (const count of state.dmUnread.values()) {
        total += count;
    }
    return total;
}

export function clearFocusedUnread(state: OverlayState): void {
    if (state.focusedChannel === "all") {
        state.unread.clear();
        state.dmUnread.clear();
        return;
    }
    if (state.focusedChannel === "dm") {
        state.dmUnread.clear();
        return;
    }
    state.unread.delete(state.focusedChannel);
}

export function cycleChannel(state: OverlayState, channels: string[]): void {
    const options = ["all", ...channels, "dm"];
    const current = options.indexOf(state.focusedChannel);
    const next = (current + 1) % options.length;
    state.focusedChannel = options[next]!;
    clearFocusedUnread(state);
}

export function parseInput(input: string): { type: "dm"; target: string; message: string } | { type: "channel"; message: string } {
    const dmMatch = input.match(/^@(\S+)\s+(.+)$/);
    if (dmMatch) {
        return { type: "dm", target: dmMatch[1]!, message: dmMatch[2]! };
    }
    return { type: "channel", message: input };
}
