import { type Message, isValidMessage } from "./message.js";

/** Default maximum message size: 16 MB */
const DEFAULT_MAX_MESSAGE_SIZE = 16 * 1024 * 1024;

/**
 * Encode a Message into a length-prefixed frame.
 *
 * Wire format: [4 bytes: uint32 BE payload length][N bytes: UTF-8 JSON]
 */
export function encode(msg: Message): Buffer {
    const json = Buffer.from(JSON.stringify(msg), "utf-8");
    const frame = Buffer.alloc(4 + json.length);
    frame.writeUInt32BE(json.length, 0);
    json.copy(frame, 4);
    return frame;
}

/**
 * Stateful frame decoder that handles partial reads and multi-message chunks.
 *
 * Feed chunks from a socket `data` event into `push()`. It returns an array
 * of decoded Messages (possibly empty if we're waiting for more data).
 *
 * Throws on:
 * - Messages exceeding maxMessageSize
 * - Invalid JSON
 * - JSON that doesn't pass Message validation
 */
export class FrameDecoder {
    private buffer: Buffer = Buffer.alloc(0);
    private readonly maxMessageSize: number;

    constructor(maxMessageSize: number = DEFAULT_MAX_MESSAGE_SIZE) {
        this.maxMessageSize = maxMessageSize;
    }

    /**
     * Push a chunk of data and return any complete messages decoded from it.
     */
    push(chunk: Buffer): Message[] {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const messages: Message[] = [];

        while (this.buffer.length >= 4) {
            const len = this.buffer.readUInt32BE(0);

            if (len > this.maxMessageSize) {
                // Reset buffer to prevent stuck state
                this.buffer = Buffer.alloc(0);
                throw new Error(
                    `Message size ${len} exceeds maximum ${this.maxMessageSize}`
                );
            }

            if (this.buffer.length < 4 + len) {
                // Incomplete message — wait for more data
                break;
            }

            const json = this.buffer.subarray(4, 4 + len).toString("utf-8");
            this.buffer = this.buffer.subarray(4 + len);

            let parsed: unknown;
            try {
                parsed = JSON.parse(json);
            } catch {
                this.buffer = Buffer.alloc(0);
                throw new Error(`Invalid JSON in message frame: ${json.slice(0, 100)}`);
            }

            if (!isValidMessage(parsed)) {
                this.buffer = Buffer.alloc(0);
                throw new Error(
                    `Invalid message format: ${JSON.stringify(parsed).slice(0, 200)}`
                );
            }

            messages.push(parsed);
        }

        return messages;
    }

    /** Reset internal buffer state. */
    reset(): void {
        this.buffer = Buffer.alloc(0);
    }
}
