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

// === Bidirectional (relayed by server per routing rules) ===

export interface NudgeMessage {
    type: "nudge";
    reason: string;
}

export interface BlockerMessage {
    type: "blocker";
    description: string;
}

export interface DoneMessage {
    type: "done";
    summary: string;
}

export interface InstructMessage {
    type: "instruct";
    instruction: string;
    to?: string; // Specific agent name
    swarm?: string; // All agents in a swarm
}

// === Server → Client ===

export interface ErrorMessage {
    type: "error";
    message: string;
}

export interface RegisteredMessage {
    type: "registered";
}

// === Relayed wrapper ===

export interface RelayedMessage {
    from: string;
    fromRole: Role;
    fromSwarm?: string;
    message: NudgeMessage | BlockerMessage | DoneMessage | InstructMessage;
}

// === Union types ===

export type ClientMessage = RegisterMessage | NudgeMessage | BlockerMessage | DoneMessage | InstructMessage;
export type ServerMessage = ErrorMessage | RegisteredMessage | RelayedMessage;

// === Serialization ===

export function serialize(msg: ClientMessage | ServerMessage | RelayedMessage): string {
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
        default:
            return false;
    }
}

export function isRelayedMessage(msg: unknown): msg is RelayedMessage {
    if (!msg || typeof msg !== "object") return false;
    const m = msg as Record<string, unknown>;
    return typeof m.from === "string" && typeof m.fromRole === "string" && m.message != null;
}
