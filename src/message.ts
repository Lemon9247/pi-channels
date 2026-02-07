/**
 * Message format for channel communication.
 *
 * - `to` — addressing hint: who or what this message is for. The library
 *   does NOT route based on this field — it fans out everything to all
 *   connected clients. Consumers use `to` to filter on the receiving end.
 * - `msg` — human-readable content.
 * - `data` — optional structured payload. Consumer-defined, passed through
 *   untouched by the library.
 */
export interface Message {
    to: string;
    msg: string;
    data?: Record<string, unknown>;
}

/**
 * Validate that a value is a well-formed Message.
 *
 * Checks:
 * - Is an object (not null, not array)
 * - `to` is a non-empty string
 * - `msg` is a non-empty string
 * - `data`, if present, is a plain object
 */
export function isValidMessage(value: unknown): value is Message {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const obj = value as Record<string, unknown>;

    if (typeof obj.to !== "string" || obj.to.length === 0) {
        return false;
    }

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
