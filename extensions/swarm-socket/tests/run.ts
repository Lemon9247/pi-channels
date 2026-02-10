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
let totalPassed = 0;
let totalFailed = 0;

for (const testFile of tests) {
    const rel = path.relative(testsDir, testFile);
    console.log(`━━━ ${rel} ━━━`);
    try {
        const output = execSync(`npx tsx --test "${testFile}"`, {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            cwd: path.resolve(testsDir, ".."),
            timeout: 30_000,
        });
        process.stdout.write(output);

        // Parse pass/fail from output
        const passMatch = output.match(/ℹ pass (\d+)/);
        const failMatch = output.match(/ℹ fail (\d+)/);
        if (passMatch) totalPassed += parseInt(passMatch[1]);
        if (failMatch) totalFailed += parseInt(failMatch[1]);
    } catch (err: any) {
        allPassed = false;
        if (err.stdout) process.stdout.write(err.stdout);
        if (err.stderr) process.stderr.write(err.stderr);

        const output = err.stdout || "";
        const passMatch = output.match(/ℹ pass (\d+)/);
        const failMatch = output.match(/ℹ fail (\d+)/);
        if (passMatch) totalPassed += parseInt(passMatch[1]);
        if (failMatch) totalFailed += parseInt(failMatch[1]);
    }
    console.log();
}

console.log(`\n${"═".repeat(40)}`);
console.log(`Total: ${totalPassed + totalFailed} tests, ${totalPassed} passed, ${totalFailed} failed`);
console.log(`${"═".repeat(40)}`);

process.exit(allPassed ? 0 : 1);
