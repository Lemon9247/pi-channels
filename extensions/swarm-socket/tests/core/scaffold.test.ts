/**
 * Tests for core/scaffold.ts — task directory scaffolding.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, assert, assertEqual, summarize } from "../helpers.js";
import {
    writeIfMissing,
    detectTopology,
    scaffoldTaskDir,
    scaffoldCoordinatorSubDir,
    hiveMindTemplate,
    coordinationTemplate,
} from "../../core/scaffold.js";
import type { AgentInfo } from "../../core/state.js";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "pi-scaffold-test-"));
}

function cleanup(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

function agent(name: string, role: "coordinator" | "agent", swarm: string, task: string = "test task"): AgentInfo {
    return { name, role, swarm, task, status: "starting", code: "0.1" };
}

async function main() {
    // ─── writeIfMissing ──────────────────────────────────────────────────

    console.log("\nwriteIfMissing:");

    await test("creates file when it doesn't exist", async () => {
        const dir = tmpDir();
        try {
            const filePath = path.join(dir, "test.md");
            const written = writeIfMissing(filePath, "hello");
            assert(written === true, "should return true when writing");
            assertEqual(fs.readFileSync(filePath, "utf-8"), "hello", "content should match");
        } finally {
            cleanup(dir);
        }
    });

    await test("does NOT overwrite existing file", async () => {
        const dir = tmpDir();
        try {
            const filePath = path.join(dir, "test.md");
            fs.writeFileSync(filePath, "original");
            const written = writeIfMissing(filePath, "new content");
            assert(written === false, "should return false when file exists");
            assertEqual(fs.readFileSync(filePath, "utf-8"), "original", "content should be unchanged");
        } finally {
            cleanup(dir);
        }
    });

    await test("creates parent directories", async () => {
        const dir = tmpDir();
        try {
            const filePath = path.join(dir, "sub", "deep", "test.md");
            const written = writeIfMissing(filePath, "nested");
            assert(written === true, "should return true");
            assertEqual(fs.readFileSync(filePath, "utf-8"), "nested", "content should match");
        } finally {
            cleanup(dir);
        }
    });

    // ─── detectTopology ──────────────────────────────────────────────────

    console.log("\ndetectTopology:");

    await test("flat when all agents", async () => {
        const agents = [agent("a1", "agent", "s1"), agent("a2", "agent", "s1")];
        assertEqual(detectTopology(agents), "flat", "should detect flat topology");
    });

    await test("hierarchical when has coordinator", async () => {
        const agents = [
            agent("c1", "coordinator", "s1"),
            agent("a1", "agent", "s1"),
        ];
        assertEqual(detectTopology(agents), "hierarchical", "should detect hierarchical topology");
    });

    // ─── scaffoldTaskDir — flat ──────────────────────────────────────────

    console.log("\nscaffoldTaskDir (flat):");

    await test("creates hive-mind.md and agent files map for flat swarm", async () => {
        const dir = tmpDir();
        try {
            const taskDir = path.join(dir, "task");
            const agents = [
                agent("agent-a", "agent", "research"),
                agent("agent-b", "agent", "research"),
            ];

            const result = scaffoldTaskDir(taskDir, "Test overview", agents);

            assert(result.isHierarchical === false, "should be flat");
            assertEqual(result.taskDirPath, taskDir, "taskDirPath should match");

            // hive-mind.md should exist
            const hmPath = path.join(taskDir, "hive-mind.md");
            assert(fs.existsSync(hmPath), "hive-mind.md should exist");
            assertEqual(result.hiveMindPath, hmPath, "hiveMindPath should match");

            // Content should contain overview
            const content = fs.readFileSync(hmPath, "utf-8");
            assert(content.includes("Test overview"), "should contain overview");
            assert(content.includes("agent-a"), "should contain agent name");
            assert(content.includes("agent-b"), "should contain agent name");

            // Agent files
            assert(result.agentFiles.has("agent-a"), "should have agent-a files");
            assert(result.agentFiles.has("agent-b"), "should have agent-b files");

            const aFiles = result.agentFiles.get("agent-a")!;
            assertEqual(aFiles.hiveMindPath, hmPath, "agent should point to shared hive-mind");
            assert(aFiles.reportPath.includes("agent-a-report.md"), "report path should be agent-specific");
            assert(!aFiles.crossSwarmPath, "flat agent should not have cross-swarm path");
            assert(!aFiles.synthesisPath, "flat agent should not have synthesis path");

            // No coordination.md for flat
            assert(!fs.existsSync(path.join(taskDir, "coordination.md")), "no coordination.md for flat");
            assert(!fs.existsSync(path.join(taskDir, "cross-swarm.md")), "no cross-swarm.md for flat");
        } finally {
            cleanup(dir);
        }
    });

    // ─── scaffoldTaskDir — hierarchical ─────────────────────────────────

    console.log("\nscaffoldTaskDir (hierarchical):");

    await test("creates coordination.md, cross-swarm.md, and swarm subdirs", async () => {
        const dir = tmpDir();
        try {
            const taskDir = path.join(dir, "task");
            const agents = [
                agent("coord-1", "coordinator", "research"),
                agent("agent-a", "agent", "research"),
                agent("coord-2", "coordinator", "implementation"),
                agent("agent-b", "agent", "implementation"),
            ];

            const result = scaffoldTaskDir(taskDir, "Hierarchical test", agents);

            assert(result.isHierarchical === true, "should be hierarchical");
            assertEqual(result.taskDirPath, taskDir, "taskDirPath should match");

            // coordination.md
            const coordPath = path.join(taskDir, "coordination.md");
            assert(fs.existsSync(coordPath), "coordination.md should exist");
            assertEqual(result.coordinationPath, coordPath, "coordinationPath should match");
            const coordContent = fs.readFileSync(coordPath, "utf-8");
            assert(coordContent.includes("Hierarchical test"), "coordination.md should contain overview");
            assert(coordContent.includes("research"), "should contain swarm name");
            assert(coordContent.includes("implementation"), "should contain swarm name");
            assert(coordContent.includes("coord-1"), "should list coordinator");
            assert(coordContent.includes("agent-a"), "should list agent");

            // cross-swarm.md
            const csPath = path.join(taskDir, "cross-swarm.md");
            assert(fs.existsSync(csPath), "cross-swarm.md should exist");
            assertEqual(result.crossSwarmPath, csPath, "crossSwarmPath should match");

            // Per-swarm subdirectories
            const researchDir = path.join(taskDir, "swarm-research");
            const implDir = path.join(taskDir, "swarm-implementation");
            assert(fs.existsSync(researchDir), "swarm-research/ should exist");
            assert(fs.existsSync(implDir), "swarm-implementation/ should exist");

            // Per-swarm hive-mind.md
            assert(fs.existsSync(path.join(researchDir, "hive-mind.md")), "research hive-mind should exist");
            assert(fs.existsSync(path.join(implDir, "hive-mind.md")), "impl hive-mind should exist");

            // Synthesis.md in each swarm dir
            assert(fs.existsSync(path.join(researchDir, "synthesis.md")), "research synthesis should exist");
            assert(fs.existsSync(path.join(implDir, "synthesis.md")), "impl synthesis should exist");

            // Coordinator agent files include cross-swarm and synthesis paths
            const c1Files = result.agentFiles.get("coord-1")!;
            assertEqual(c1Files.crossSwarmPath, csPath, "coordinator should have cross-swarm path");
            assert(c1Files.synthesisPath!.includes("synthesis.md"), "coordinator should have synthesis path");
            assertEqual(c1Files.hiveMindPath, path.join(researchDir, "hive-mind.md"), "coordinator hive-mind in swarm dir");

            // Regular agent files do NOT include cross-swarm or synthesis
            const aFiles = result.agentFiles.get("agent-a")!;
            assert(!aFiles.crossSwarmPath, "regular agent should not have cross-swarm path");
            assert(!aFiles.synthesisPath, "regular agent should not have synthesis path");
            assertEqual(aFiles.hiveMindPath, path.join(researchDir, "hive-mind.md"), "agent hive-mind in own swarm dir");
        } finally {
            cleanup(dir);
        }
    });

    await test("coordination.md contains swarm table and agent table", async () => {
        const dir = tmpDir();
        try {
            const taskDir = path.join(dir, "task");
            const agents = [
                agent("coord-1", "coordinator", "alpha"),
                agent("worker-1", "agent", "alpha"),
                agent("worker-2", "agent", "alpha"),
            ];

            scaffoldTaskDir(taskDir, "Table test", agents);

            const content = fs.readFileSync(path.join(taskDir, "coordination.md"), "utf-8");

            // Swarm table
            assert(content.includes("| Swarm | Coordinator | Agents | Directory |"), "should have swarm table header");
            assert(content.includes("coord-1"), "swarm table should list coordinator");
            assert(content.includes("`swarm-alpha/`"), "swarm table should list directory");

            // Agent table
            assert(content.includes("| Name | Role | Swarm | Task |"), "should have agent table header");

            // Completion checklist
            assert(content.includes("- [ ] coord-1"), "should have coordinator in checklist");
            assert(content.includes("- [ ] worker-1"), "should have agent in checklist");
            assert(content.includes("- [ ] worker-2"), "should have agent in checklist");
        } finally {
            cleanup(dir);
        }
    });

    // ─── scaffoldCoordinatorSubDir ───────────────────────────────────────

    console.log("\nscaffoldCoordinatorSubDir:");

    await test("creates swarm-<name>/ under parent task dir with flat structure", async () => {
        const dir = tmpDir();
        try {
            const parentTaskDir = path.join(dir, "parent-task");
            fs.mkdirSync(parentTaskDir, { recursive: true });

            // Pre-create cross-swarm.md (queen would have created it)
            fs.writeFileSync(path.join(parentTaskDir, "cross-swarm.md"), "existing");

            const agents = [
                agent("sub-a", "agent", "research"),
                agent("sub-b", "agent", "research"),
            ];

            const result = scaffoldCoordinatorSubDir(parentTaskDir, "research", "Sub-task", agents);

            const expectedSubDir = path.join(parentTaskDir, "swarm-research");
            assertEqual(result.taskDirPath, expectedSubDir, "taskDirPath should be subdirectory");
            assert(result.isHierarchical === false, "coordinator sub-swarm is flat");

            // hive-mind.md in subdirectory
            const hmPath = path.join(expectedSubDir, "hive-mind.md");
            assert(fs.existsSync(hmPath), "hive-mind.md should exist in subdirectory");
            assertEqual(result.hiveMindPath, hmPath, "hiveMindPath should match");

            // synthesis.md in subdirectory
            assert(fs.existsSync(path.join(expectedSubDir, "synthesis.md")), "synthesis.md should exist");

            // Agent files
            const aFiles = result.agentFiles.get("sub-a")!;
            assertEqual(aFiles.hiveMindPath, hmPath, "agent hive-mind should point to subdirectory");
            assert(aFiles.reportPath.includes("sub-a-report.md"), "report path should be in subdirectory");
            assert(aFiles.reportPath.startsWith(expectedSubDir), "report should be under swarm dir");

            // cross-swarm.md not overwritten
            assertEqual(
                fs.readFileSync(path.join(parentTaskDir, "cross-swarm.md"), "utf-8"),
                "existing",
                "cross-swarm.md should not be overwritten",
            );
        } finally {
            cleanup(dir);
        }
    });

    // ─── Template content ────────────────────────────────────────────────

    console.log("\nTemplates:");

    await test("hiveMindTemplate contains expected sections", async () => {
        const agents = [agent("a1", "agent", "s1", "do stuff")];
        const content = hiveMindTemplate("My Overview", agents);
        assert(content.includes("# Hive Mind: My Overview"), "should have title");
        assert(content.includes("## Task Overview"), "should have task overview section");
        assert(content.includes("My Overview"), "should contain overview text");
        assert(content.includes("## Findings"), "should have findings section");
        assert(content.includes("## Blockers"), "should have blockers section");
        assert(content.includes("## Status"), "should have status section");
        assert(content.includes("- [ ] a1"), "should have agent in checklist");
    });

    await test("coordinationTemplate contains swarm and agent tables", async () => {
        const agents = [
            agent("c1", "coordinator", "alpha", "coordinate alpha"),
            agent("w1", "agent", "alpha", "work on alpha"),
        ];
        const content = coordinationTemplate("Coordination Test", agents);
        assert(content.includes("# Coordination: Coordination Test"), "should have title");
        assert(content.includes("| Swarm | Coordinator | Agents | Directory |"), "should have swarm table");
        assert(content.includes("| Name | Role | Swarm | Task |"), "should have agent table");
        assert(content.includes("## Completion Checklist"), "should have completion checklist");
        assert(content.includes("c1"), "should list coordinator");
        assert(content.includes("w1"), "should list agent");
    });

    // ─── Edge cases ──────────────────────────────────────────────────────

    console.log("\nEdge cases:");

    await test("scaffoldTaskDir with no overview", async () => {
        const dir = tmpDir();
        try {
            const taskDir = path.join(dir, "task");
            const agents = [agent("a1", "agent", "s1")];
            const result = scaffoldTaskDir(taskDir, undefined, agents);
            const content = fs.readFileSync(result.hiveMindPath!, "utf-8");
            assert(content.includes("(No overview provided)"), "should have placeholder text");
        } finally {
            cleanup(dir);
        }
    });

    await test("scaffoldTaskDir does not overwrite existing files", async () => {
        const dir = tmpDir();
        try {
            const taskDir = path.join(dir, "task");
            fs.mkdirSync(taskDir, { recursive: true });
            const hmPath = path.join(taskDir, "hive-mind.md");
            fs.writeFileSync(hmPath, "existing content");

            const agents = [agent("a1", "agent", "s1")];
            scaffoldTaskDir(taskDir, "New overview", agents);

            assertEqual(
                fs.readFileSync(hmPath, "utf-8"),
                "existing content",
                "should not overwrite existing hive-mind",
            );
        } finally {
            cleanup(dir);
        }
    });

    await test("scaffoldTaskDir handles agents in multiple swarms (flat topology)", async () => {
        const dir = tmpDir();
        try {
            const taskDir = path.join(dir, "task");
            const agents = [
                agent("a1", "agent", "s1"),
                agent("a2", "agent", "s2"),
            ];
            const result = scaffoldTaskDir(taskDir, "Multi-swarm flat", agents);
            assert(result.isHierarchical === false, "should be flat without coordinators");
            assert(fs.existsSync(path.join(taskDir, "hive-mind.md")), "shared hive-mind should exist");
        } finally {
            cleanup(dir);
        }
    });

    summarize();
}

main();
