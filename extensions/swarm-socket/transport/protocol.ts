/**
 * Swarm Socket Protocol
 *
 * Message types and serialization for the swarm coordination socket.
 * JSON-lines protocol over Unix socket with routing based on agent roles.
 */

// === Roles ===

export type Role = "queen" | "coordinator" | "agent";

// === Client → Server (first message on connect) ===

export interface RegisterMessage {
    type: "register";
    name: string;
    role: Role;
    swarm?: string; // Required for coordinator and agent roles
}

// === Base targeting fields (available on all bidirectional messages) ===

export interface BaseMessage {
    type: string;
    to?: string;       // Target specific agent by name
    swarm?: string;    // Target all agents in a swarm
}

// === Nudge payload for structured context ===

export interface NudgePayload {
    file?: string;        // File path that was updated
    snippet?: string;     // Short excerpt of what was added
    section?: string;     // Hive-mind section that was updated
    tags?: string[];      // Topics — enables interest-based filtering
}

// === Bidirectional (relayed by server per routing rules) ===

export interface NudgeMessage extends BaseMessage {
    type: "nudge";
    reason: string;
    payload?: NudgePayload;
}

export interface BlockerMessage extends BaseMessage {
    type: "blocker";
    description: string;
}

export interface DoneMessage extends BaseMessage {
    type: "done";
    summary: string;
}

export interface InstructMessage extends BaseMessage {
    type: "instruct";
    instruction: string;
}

// === Relay: first-class sub-agent event relay ===

export interface RelayEvent {
    event: "register" | "done" | "blocked" | "nudge" | "disconnected";
    name: string;
    role: string;
    swarm: string;
    code: string;
    summary?: string;
    description?: string;
    reason?: string;
}

export interface RelayMessage extends BaseMessage {
    type: "relay";
    relay: RelayEvent;
}

// === Progress: fire-and-forget status updates ===

export interface ProgressMessage extends BaseMessage {
    type: "progress";
    phase?: string;       // "reading files", "running tests", "writing report"
    percent?: number;     // 0-100 (optional)
    detail?: string;      // Short status line
}

// === Server → Client ===

export interface ErrorMessage {
    type: "error";
    message: string;
}

export interface RegisteredMessage {
    type: "registered";
}

// === Sender Identity (embedded in relayed messages) ===

/** Identity of the message sender, carried in every relayed message */
export interface MessageSender {
    name: string;
    role: Role;
    swarm?: string;
}

// === Relayed wrapper ===

export interface RelayedMessage {
    from: MessageSender;
    message: NudgeMessage | BlockerMessage | DoneMessage | InstructMessage | RelayMessage | ProgressMessage;
}

// === Union types ===

export type ClientMessage = RegisterMessage | NudgeMessage | BlockerMessage | DoneMessage | InstructMessage | RelayMessage | ProgressMessage;
export type ServerMessage = ErrorMessage | RegisteredMessage | RelayedMessage;

// === Serialization ===

export function serialize(msg: ClientMessage | ServerMessage): string {
    return JSON.stringify(msg) + "\n";
}

/**
 * Parse a buffer of JSON lines, returning parsed messages and any remaining incomplete data.
 * Handles partial reads and multiple messages per chunk.
 */
export function parseLines(buffer: string): { messages: unknown[]; remainder: string } {
    const messages: unknown[] = [];
    let remainder = "";

    const lines = buffer.split("\n");
    // Last element is either empty (complete line) or a partial line
    remainder = lines.pop() || "";

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            messages.push(JSON.parse(trimmed));
        } catch {
            // Skip malformed lines
        }
    }

    return { messages, remainder };
}

// === Validation ===

export function validateRegister(msg: unknown): msg is RegisterMessage {
    if (!msg || typeof msg !== "object") return false;
    const m = msg as Record<string, unknown>;
    if (m.type !== "register") return false;
    if (typeof m.name !== "string" || !m.name) return false;
    if (m.role !== "queen" && m.role !== "coordinator" && m.role !== "agent") return false;
    if (m.role !== "queen" && (typeof m.swarm !== "string" || !m.swarm)) return false;
    return true;
}

export function validateClientMessage(msg: unknown): msg is ClientMessage {
    if (!msg || typeof msg !== "object") return false;
    const m = msg as Record<string, unknown>;
    switch (m.type) {
        case "register":
            return validateRegister(msg);
        case "nudge":
            return typeof m.reason === "string";
        case "blocker":
            return typeof m.description === "string";
        case "done":
            return typeof m.summary === "string";
        case "instruct":
            return typeof m.instruction === "string";
        case "relay":
            return m.relay != null && typeof m.relay === "object";
        case "progress":
            // All fields optional — just needs the type
            return true;
        default:
            return false;
    }
}

/** Extract targeting fields from any message type */
export function getMessageTarget(msg: BaseMessage): { to?: string; swarm?: string } {
    return { to: msg.to, swarm: msg.swarm };
}

export function isRelayedMessage(msg: unknown): msg is RelayedMessage {
    if (!msg || typeof msg !== "object") return false;
    const m = msg as Record<string, unknown>;
    // from is now a MessageSender object (or a string for backward compat)
    if (m.message == null) return false;
    if (typeof m.from === "object" && m.from !== null) {
        const from = m.from as Record<string, unknown>;
        return typeof from.name === "string" && typeof from.role === "string";
    }
    // Backward compatibility: old format with from as string
    return typeof m.from === "string" && typeof m.fromRole === "string";
}

/**
 * Normalize a RelayedMessage to the canonical {from: MessageSender} format.
 * Handles backward compatibility: old format {from: string, fromRole, fromSwarm}
 * is converted to {from: {name, role, swarm}, message}.
 *
 * Call this at the boundary (after isRelayedMessage) to ensure downstream code
 * always sees from as a MessageSender object.
 */
export function normalizeRelayedMessage(msg: RelayedMessage): RelayedMessage {
    const raw = msg as any;
    if (typeof raw.from === "string") {
        return {
            from: {
                name: raw.from,
                role: raw.fromRole ?? "agent",
                swarm: raw.fromSwarm,
            },
            message: raw.message,
        };
    }
    return msg;
}
