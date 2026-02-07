/**
 * Bridge interface — bidirectional translator between a local channel
 * and an external system.
 *
 * A bridge connects to a local channel as a ChannelClient, reads messages
 * from the channel and forwards them to the external system, and reads
 * messages from the external system and forwards them to the channel.
 *
 * The bridge is responsible for any message translation between the local
 * Message format and the external protocol.
 */
export interface Bridge {
    /** Start the bridge — connect to local channel and external system. */
    start(): Promise<void>;

    /** Stop the bridge — disconnect from both sides. */
    stop(): Promise<void>;

    /** Current bridge status. */
    get status(): "running" | "stopped" | "error";
}
