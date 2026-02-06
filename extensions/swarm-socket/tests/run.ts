/**
 * Test runner — finds and executes all *.test.ts files.
 * Run with: npx tsx tests/run.ts
 */

import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

function findTests(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findTests(full));
        } else if (entry.name.endsWith(".test.ts")) {
            results.push(full);
        }
    }
    return results;
}

const testsDir = path.dirname(new URL(import.meta.url).pathname);
const tests = findTests(testsDir).sort();

console.log(`Found ${tests.length} test files:\n`);

let allPassed = true;
let totalTests = 0;
let totalFailed = 0;

for (const testFile of tests) {
    const rel = path.relative(testsDir, testFile);
    console.log(`━━━ ${rel} ━━━`);
    try {
        const output = execSync(`npx tsx "${testFile}"`, {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            cwd: path.resolve(testsDir, ".."),
        });
        process.stdout.write(output);

        // Parse the summary line for totals
        const match = output.match(/(\d+) tests: (\d+) passed, (\d+) failed/);
        if (match) {
            totalTests += parseInt(match[1]);
            totalFailed += parseInt(match[3]);
        }
    } catch (err: any) {
        allPassed = false;
        if (err.stdout) process.stdout.write(err.stdout);
        if (err.stderr) process.stderr.write(err.stderr);
        // Try to parse even on failure
        const output = err.stdout || "";
        const match = output.match(/(\d+) tests: (\d+) passed, (\d+) failed/);
        if (match) {
            totalTests += parseInt(match[1]);
            totalFailed += parseInt(match[3]);
        }
    }
    console.log();
}

console.log(`\n${"═".repeat(40)}`);
console.log(`Total: ${totalTests} tests, ${totalTests - totalFailed} passed, ${totalFailed} failed`);
console.log(`${"═".repeat(40)}`);

process.exit(allPassed ? 0 : 1);
