/**
 * Identity and hierarchy helper tests
 */

import { test, assert, assertEqual, summarize } from "../helpers.js";
import { codeLevel, parentCode, isDescendantOf, buildChildrenMap } from "../../core/identity.js";

async function main() {
    console.log("\nHierarchy Helpers:");

    await test("codeLevel — root is 0, children are 1, grandchildren are 2", async () => {
        assertEqual(codeLevel("0"), 0, "root");
        assertEqual(codeLevel("0.1"), 1, "child");
        assertEqual(codeLevel("0.1.2"), 2, "grandchild");
        assertEqual(codeLevel("0.1.2.3"), 3, "great-grandchild");
    });

    await test("parentCode — strips last segment", async () => {
        assertEqual(parentCode("0"), "", "root→empty");
        assertEqual(parentCode("0.1"), "0", "child→root");
        assertEqual(parentCode("0.1.2"), "0.1", "grandchild→child");
        assertEqual(parentCode("0.1.2.3"), "0.1.2", "great-grandchild→grandchild");
    });

    await test("isDescendantOf — prefix matching", async () => {
        assert(isDescendantOf("0.1", "0"), "0.1 under 0");
        assert(isDescendantOf("0.1.2", "0"), "0.1.2 under 0");
        assert(isDescendantOf("0.1.2", "0.1"), "0.1.2 under 0.1");
        assert(!isDescendantOf("0.1", "0.1"), "not descendant of self");
        assert(!isDescendantOf("0.2", "0.1"), "0.2 not under 0.1");
        assert(!isDescendantOf("0.10", "0.1"), "0.10 not under 0.1 (prefix trap)");
    });

    await test("buildChildrenMap — flat list", async () => {
        const agents = [
            { name: "a1", code: "0.1" },
            { name: "a2", code: "0.2" },
        ];
        const { children } = buildChildrenMap(agents);
        assertEqual(children.get("0")?.length, 2, "root has 2 children");
        assertEqual(children.get("0")![0].name, "a1", "sorted by code");
    });

    await test("buildChildrenMap — nested tree", async () => {
        const agents = [
            { name: "coord", code: "0.1" },
            { name: "a2", code: "0.1.2" },
            { name: "a1", code: "0.1.1" },
            { name: "b1", code: "0.2" },
        ];
        const { children, sorted } = buildChildrenMap(agents);
        assertEqual(sorted[0].name, "coord", "coord first in sorted");
        assertEqual(children.get("0")?.length, 2, "root has 2 children (coord + b1)");
        assertEqual(children.get("0.1")?.length, 2, "coord has 2 children");
        assertEqual(children.get("0.1")![0].name, "a1", "a1 before a2 under coord");
    });

    await test("buildChildrenMap — empty list", async () => {
        const { children, sorted } = buildChildrenMap([]);
        assertEqual(sorted.length, 0, "no agents");
        assertEqual(children.size, 0, "no children");
    });
}

main().then(() => summarize());
