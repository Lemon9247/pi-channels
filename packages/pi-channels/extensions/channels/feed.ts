import * as fs from "node:fs";
import * as path from "node:path";
import { type FeedEvent, type FeedEventType } from "./types.js";

/**
 * Get the feed file path for a project.
 */
export function feedPath(projectDir: string): string {
    return path.join(projectDir, ".pi", "channels", "feed.jsonl");
}

/**
 * Append an event to the feed.
 */
export function appendEvent(
    projectDir: string,
    type: FeedEventType,
    agent: string,
    detail?: string,
    data?: Record<string, unknown>,
): void {
    const event: FeedEvent = {
        type,
        agent,
        timestamp: new Date().toISOString(),
        detail,
        data,
    };

    const fp = feedPath(projectDir);
    const dir = path.dirname(fp);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(fp, JSON.stringify(event) + "\n");
}

/**
 * Read recent events from the feed (tail).
 */
export function readEvents(projectDir: string, limit = 50): FeedEvent[] {
    const fp = feedPath(projectDir);
    try {
        const content = fs.readFileSync(fp, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);
        const events: FeedEvent[] = [];
        for (const line of lines.slice(-limit)) {
            try {
                events.push(JSON.parse(line) as FeedEvent);
            } catch {
                // Skip corrupt lines
            }
        }
        return events;
    } catch {
        return [];
    }
}

/**
 * Prune the feed to the given retention limit.
 */
export function pruneEvents(projectDir: string, retention: number): void {
    const fp = feedPath(projectDir);
    try {
        const content = fs.readFileSync(fp, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);
        if (lines.length > retention) {
            const pruned = lines.slice(-retention);
            fs.writeFileSync(fp, pruned.join("\n") + "\n");
        }
    } catch {
        // File doesn't exist, nothing to prune
    }
}
