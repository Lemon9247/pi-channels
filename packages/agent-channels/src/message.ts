/**
 * Message format for channel communication.
 *
 * - `msg` — human-readable content.
 * - `data` — optional structured payload. Consumer-defined, passed through
 *   untouched by the library. Use this for metadata like sender identity,
 *   message type, addressing, or any structured information.
 */
export interface Message {
    msg: string;
    data?: Record<string, unknown>;
}

/**
 * Validate that a value is a well-formed Message.
 *
 * Checks:
 * - Is an object (not null, not array)
 * - `msg` is a non-empty string
 * - `data`, if present, is a plain object
 */
export function isValidMessage(value: unknown): value is Message {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const obj = value as Record<string, unknown>;

    if (typeof obj.msg !== "string" || obj.msg.length === 0) {
        return false;
    }

    if (obj.data !== undefined) {
        if (obj.data === null || typeof obj.data !== "object" || Array.isArray(obj.data)) {
            return false;
        }
    }

    return true;
}
