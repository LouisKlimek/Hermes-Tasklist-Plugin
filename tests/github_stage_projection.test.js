"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "dashboard", "dist", "index.js"), "utf8");
const helpers = source.match(/function isGithubPipelineStage\([\s\S]*?\n  function cell\(/);
assert(helpers, "GitHub-stage classification and graph-projection helpers must be present");
eval(`${helpers[0].replace(/\n  function cell\($/, "")}\n;globalThis.__graphHelpers = { isGithubPipelineStage, projectGithubStageEdges, projectGithubStageGraph };`);

const { isGithubPipelineStage, projectGithubStageEdges, projectGithubStageGraph } = globalThis.__graphHelpers;

assert.strictEqual(isGithubPipelineStage({ title: "Review PR #42: graph filter", assignee: "someone-else" }), true);
assert.strictEqual(isGithubPipelineStage({ title: "ordinary title", body: "Type: Pull Request Review\nCurrent Head SHA: abc" }), true);
assert.strictEqual(isGithubPipelineStage({ title: "GitHub Auto Merge PR #42" }), true);
assert.strictEqual(isGithubPipelineStage({ title: "ordinary title", body: "Type: GitHub Auto Merge" }), true);
assert.strictEqual(isGithubPipelineStage({ title: "GitHub reporting", assignee: "github-manager" }), false, "assignee alone must not hide unrelated cards");

const chain = projectGithubStageEdges(
  ["engineering", "followup"],
  { engineering: [], review: ["engineering"], merge: ["review"], followup: ["merge"] },
  { review: 1, merge: 1 }
);
assert.deepStrictEqual(chain.par, { engineering: [], followup: ["engineering"] }, "two hidden stages are bypassed transitively");
assert.deepStrictEqual(chain.chi, { engineering: ["followup"], followup: [] });

const sourceChain = { engineering: [], review: ["engineering"], merge: ["review"], followup: ["merge"] };
const hiddenChain = { review: 1, merge: 1 };
const collapsed = projectGithubStageGraph(["engineering", "followup"], sourceChain, hiddenChain, {});
assert.deepStrictEqual(collapsed.ids, ["engineering", "followup"], "collapsed parent keeps GitHub stages out of the graph");
assert.deepStrictEqual(collapsed.par.followup, ["engineering"], "collapsed parent keeps the projected edge");
assert.deepStrictEqual(Object.keys(collapsed.expansionInfo), ["engineering"], "only the parent with a hidden branch gets an affordance");

const expanded = projectGithubStageGraph(["engineering", "followup"], sourceChain, hiddenChain, { engineering: true });
assert.deepStrictEqual(expanded.ids.sort(), ["engineering", "followup", "merge", "review"], "expanding reveals only this parent’s hidden path");
assert.deepStrictEqual(expanded.par, { engineering: [], followup: ["merge"], review: ["engineering"], merge: ["review"] }, "expanded branch restores original local edges");
assert.deepStrictEqual(expanded.chi, { engineering: ["review"], followup: [], review: ["merge"], merge: ["followup"] });

const concurrentSource = { left: [], leftReview: ["left"], leftMerge: ["leftReview"], leftChild: ["leftMerge"], right: [], rightReview: ["right"], rightMerge: ["rightReview"], rightChild: ["rightMerge"] };
const concurrentHidden = { leftReview: 1, leftMerge: 1, rightReview: 1, rightMerge: 1 };
const concurrent = projectGithubStageGraph(["left", "leftChild", "right", "rightChild"], concurrentSource, concurrentHidden, { left: true, right: true });
assert.deepStrictEqual(concurrent.ids.sort(), ["left", "leftChild", "leftMerge", "leftReview", "right", "rightChild", "rightMerge", "rightReview"], "separate parent expansions remain concurrent");
const leftCollapsed = projectGithubStageGraph(["left", "leftChild", "right", "rightChild"], concurrentSource, concurrentHidden, { right: true });
assert.deepStrictEqual(leftCollapsed.ids.sort(), ["left", "leftChild", "right", "rightChild", "rightMerge", "rightReview"], "collapsing one parent restores only that parent’s projection");

const multipleParents = projectGithubStageEdges(
  ["left", "right", "child"],
  { left: [], right: [], review: ["left", "right"], merge: ["review"], child: ["left", "merge"] },
  { review: 1, merge: 1 }
);
assert.deepStrictEqual(multipleParents.par.child.sort(), ["left", "right"], "all nearest visible ancestors are projected and duplicate edges are removed");
assert.deepStrictEqual(multipleParents.chi.left, ["child"]);
assert.deepStrictEqual(multipleParents.chi.right, ["child"]);

const cycleGuard = projectGithubStageEdges(["visible"], { visible: ["hidden"], hidden: ["visible"] }, { hidden: 1 });
assert.deepStrictEqual(cycleGuard.par, { visible: [] }, "projection never creates a self-cycle");

assert(source.includes("dependencyParents: dependencyParents"), "graph model keeps underlying dependencies for truthful waiting state");
assert(source.includes("hidden GitHub stage"), "visible children explain when a hidden GitHub stage is still blocking them");
assert(source.includes("LS_HIDE_GITHUB_STAGES"), "GitHub-stage switch uses a dedicated localStorage key");
assert(source.includes('role: "button"'), "each expandable parent exposes an accessible control");
assert(source.includes("onGithubExpansionKey"), "the expansion control supports keyboard activation");

console.log("GitHub-stage graph projection and local expansion assertions passed");
