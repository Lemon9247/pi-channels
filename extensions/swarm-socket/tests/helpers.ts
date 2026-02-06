/**
 * Shared test infrastructure.
 * Each test file imports from here, runs tests, then calls summarize().
 */

import * as os from "node:os";
import * as path from "node:path";

let passed = 0;
let failed = 0;
const failures: string[] = [];

export function assert(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

export async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${name}: ${msg}`);
        console.log(`  ✗ ${name}: ${msg}`);
    }
}

export function tmpSocketPath(): string {
    return path.join(os.tmpdir(), `pi-swarm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function summarize(): void {
    console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
        console.log("\nFailures:");
        for (const f of failures) console.log(`  - ${f}`);
    }
    process.exit(failed > 0 ? 1 : 0);
}
