export type Chattiness = "quiet" | "normal" | "verbose";
export type NameTheme = "creatures" | "nature" | "space" | "minimal" | "classic" | "occult" | "custom";

export interface ChannelsConfig {
    /** Join mesh on session start. Default: true. */
    autoRegister: boolean;
    /** Folders/globs where auto-join is enabled when autoRegister is false. */
    autoRegisterPaths: string[];
    /** Name generation theme. Default: "creatures". */
    nameTheme: NameTheme;
    /** Custom name word lists (for "custom" theme). */
    nameWords: { adj: string[]; noun: string[] } | null;
    /** Communication level. Default: "normal". */
    chattiness: Chattiness;
    /** Terminal for spawning: auto/tmux/kitty/etc. Default: "auto". */
    terminal: string;
    /** Channels to auto-join on connect. Default: ["general"]. */
    autoJoinChannels: string[];
}

export const DEFAULT_CONFIG: ChannelsConfig = {
    autoRegister: true,
    autoRegisterPaths: [],
    nameTheme: "occult",
    nameWords: null,
    chattiness: "normal",
    terminal: "auto",
    autoJoinChannels: ["general"],
};

export interface Reservation {
    paths: string[];
    reason: string;
    agent: string;
    timestamp: string;
}

export type AgentStatus = "active" | "idle" | "away";

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

export interface MsgParams {
    message?: string;
    to?: string;
    channel?: string;
}

export interface AgentParams {
    action: string;
    name?: string;
    prompt?: string;
    cwd?: string;
    channels?: string[];
}

export interface ChannelParams {
    action: string;
    name?: string;
}

export interface ReserveParams {
    action?: string;
    paths?: string[];
    reason?: string;
}
