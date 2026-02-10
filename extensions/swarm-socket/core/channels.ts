/**
 * Channel Helpers
 *
 * Swarm-specific wrappers around the agent-channels library.
 * Creates channel groups for swarms and provides connection helpers.
 */

import * as path from "node:path";
import { ChannelGroup, ChannelClient, type GroupChannelDef } from "../../../../agent-channels/dist/index.js";

// ─── Constants ───────────────────────────────────────────────────────

/** Base directory for swarm channel groups. */
export const SWARM_BASE_DIR = "/tmp/pi-swarm";

/** Well-known channel names. */
export const GENERAL_CHANNEL = "general";
export const QUEEN_INBOX = "inbox-queen";

/** Environment variable names for channel configuration. */
export const ENV = {
    /** Path to the channel group directory. */
    GROUP: "PI_CHANNELS_GROUP",
    /** This agent's inbox channel name. */
    INBOX: "PI_CHANNELS_INBOX",
    /** Comma-separated channels this agent should subscribe to (read from). */
    SUBSCRIBE: "PI_CHANNELS_SUBSCRIBE",
    /** This agent's display name. */
    NAME: "PI_CHANNELS_NAME",
} as const;

// ─── Channel Name Helpers ────────────────────────────────────────────

/** Build an inbox channel name for an agent. */
export function inboxName(agentName: string): string {
    // Sanitize agent name for socket filename: replace spaces/special with dashes
    const safe = agentName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
    return `inbox-${safe}`;
}

/** Build the group directory path for a swarm. */
export function groupPath(swarmId: string): string {
    return path.join(SWARM_BASE_DIR, swarmId);
}

// ─── Channel Group Creation ──────────────────────────────────────────

/**
 * Create a channel group for a swarm.
 *
 * Creates:
 * - `general` — broadcast channel for all agents
 * - `inbox-queen` — queen's inbox for done/blocker/progress messages
 * - `inbox-<name>` — one per agent, for targeted instructions
 *
 * @param swarmId Unique swarm identifier (used for directory name)
 * @param agentNames Names of all agents in the swarm
 * @returns Started ChannelGroup
 */
export async function createSwarmChannelGroup(
    swarmId: string,
    agentNames: string[],
): Promise<ChannelGroup> {
    const dirPath = groupPath(swarmId);

    const channels: GroupChannelDef[] = [
        { name: GENERAL_CHANNEL },
        { name: QUEEN_INBOX },
    ];

    for (const name of agentNames) {
        channels.push({ name: inboxName(name) });
    }

    const group = new ChannelGroup({
        path: dirPath,
        channels,
    });

    await group.start();
    return group;
}

// ─── Client Connection Helpers ───────────────────────────────────────

/**
 * Connect a ChannelClient to a specific channel in a group.
 *
 * @param groupDir Path to the channel group directory
 * @param channelName Channel name (e.g. "general", "inbox-a1")
 * @returns Connected ChannelClient
 */
export async function connectToChannel(
    groupDir: string,
    channelName: string,
): Promise<ChannelClient> {
    const socketPath = path.join(groupDir, `${channelName}.sock`);
    const client = new ChannelClient(socketPath);
    await client.connect();
    return client;
}

/**
 * Connect to multiple channels in a group.
 *
 * @param groupDir Path to the channel group directory
 * @param channelNames Channel names to connect to
 * @returns Map of channel name → connected ChannelClient
 */
export async function connectToMultiple(
    groupDir: string,
    channelNames: string[],
): Promise<Map<string, ChannelClient>> {
    const clients = new Map<string, ChannelClient>();
    await Promise.all(
        channelNames.map(async (name) => {
            const client = await connectToChannel(groupDir, name);
            clients.set(name, client);
        }),
    );
    return clients;
}
