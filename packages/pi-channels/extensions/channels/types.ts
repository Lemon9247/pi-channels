// ─── Config ─────────────────────────────────────────────────────────

export type Chattiness = "quiet" | "normal" | "verbose";
export type Discovery = "project" | "global";
export type NameTheme = "creatures" | "nature" | "space" | "minimal" | "classic" | "custom";

export interface ChannelsConfig {
    /** Join mesh on session start. Default: false. */
    autoRegister: boolean;
    /** Folders/globs where auto-join is enabled. */
    autoRegisterPaths: string[];
    /** Who can see whom. Default: "project". */
    discovery: Discovery;
    /** Name generation theme. Default: "creatures". */
    nameTheme: NameTheme;
    /** Custom name word lists (for "custom" theme). */
    nameWords: { adj: string[]; noun: string[] } | null;
    /** Communication level. Default: "normal". */
    chattiness: Chattiness;
    /** Seconds before stuck detection. Default: 900 (15min). */
    stuckThreshold: number;
    /** Notify peers of stuck agents. Default: true. */
    stuckNotify: boolean;
    /** Max events in activity feed. Default: 50. */
    feedRetention: number;
    /** Show status bar indicator. Default: true. */
    showWidget: boolean;
    /** Terminal for spawning: auto/tmux/kitty/etc. Default: "auto". */
    terminal: string;
}

export const DEFAULT_CONFIG: ChannelsConfig = {
    autoRegister: true,  // Agents join meshes by default
    autoRegisterPaths: [],
    discovery: "project",
    nameTheme: "creatures",
    nameWords: null,
    chattiness: "normal",
    stuckThreshold: 900,
    stuckNotify: true,
    feedRetention: 50,
    showWidget: true,
    terminal: "auto",
};

// ─── Registry ───────────────────────────────────────────────────────

export interface RegistryEntry {
    name: string;
    pid: number;
    cwd: string;
    model?: string;
    branch?: string;
    reservations: Reservation[];
    joinedAt: string;
    lastActivity: string;
    status: AgentStatus;
    spawnedBy?: string;
    channels: string[];
}

export type AgentStatus = "active" | "idle" | "away" | "stuck";

// ─── Reservations ───────────────────────────────────────────────────

export interface Reservation {
    paths: string[];
    reason: string;
    agent: string;
    timestamp: string;
}

// ─── Activity Feed ──────────────────────────────────────────────────

export type FeedEventType =
    | "join"
    | "leave"
    | "edit"
    | "commit"
    | "test"
    | "message"
    | "reserve"
    | "release"
    | "spawn"
    | "stuck";

export interface FeedEvent {
    type: FeedEventType;
    agent: string;
    timestamp: string;
    detail?: string;
    data?: Record<string, unknown>;
}

// ─── Tool Actions ───────────────────────────────────────────────────

export interface ToolAction {
    action: string;
    // join/leave
    channel?: string;
    // send
    to?: string;
    message?: string;
    // reserve/release
    paths?: string[];
    reason?: string;
    // spawn
    prompt?: string;
    cwd?: string;
    channels?: string[];
    // whois
    name?: string;
    // feed
    limit?: number;
    // config
    key?: string;
    value?: unknown;
}
