/**
 * Regression tests for the whole-tree rebuild plan (side-branch distill /
 * delete) and pass-through handling of labels.
 *
 * Run:  bun test tests/rebuild.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildRebuildPlan } from "../src/engine/compact";
import {
  appendEntry,
  collectOffPathSubtree,
  computeMergeSegments,
  findCleanBranchRange,
  rebuildMerged,
  rebuildPlanEntries,
} from "../src/commands/distill";

// ---- helpers --------------------------------------------------------------

let seq = 0;

function makeSession(): SessionManager {
  const sm = SessionManager.inMemory(`cwd-${seq++}`);
  return sm;
}

/** Append a message under the current leaf; returns its id. */
function msg(
  sm: SessionManager,
  role: "user" | "assistant",
  text: string,
): string {
  return sm.appendMessage({
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });
}

/** Rebuild a session from a plan using the real production code path. */
function rebuild(
  plan: ReturnType<typeof buildRebuildPlan>,
  summaryContent: string | undefined,
  tokensBefore = 0,
  targetLeafId?: string,
): SessionManager {
  const sm = makeSession();
  rebuildPlanEntries(
    sm as any,
    plan,
    summaryContent,
    tokensBefore,
    targetLeafId,
  );
  return sm;
}

/** Map of entry id → parentId for a rebuilt session. */
function parentsOf(sm: SessionManager): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const e of sm.getEntries() as Array<Record<string, unknown>>) {
    map.set(e.id as string, (e.parentId as string | null) ?? null);
  }
  return map;
}

/** Find the entry id whose message content equals `text`. */
function findByIdText(
  sm: SessionManager,
  text: string,
): string | undefined {
  for (const e of sm.getEntries() as Array<Record<string, unknown>>) {
    if (e.type !== "message") continue;
    const content = (e as { message?: { content?: unknown } }).message?.content;
    const t = Array.isArray(content)
      ? content
          .filter(
            (b) =>
              b &&
              typeof b === "object" &&
              (b as { type?: string }).type === "text" &&
              typeof (b as { text?: unknown }).text === "string",
          )
          .map((b) => (b as { text: string }).text)
          .join("\n")
      : String(content ?? "");
    if (t === text) return e.id as string;
  }
  return undefined;
}

/** Count entries of a type in the rebuilt session. */
function countType(sm: SessionManager, type: string): number {
  return (sm.getEntries() as Array<Record<string, unknown>>).filter(
    (e) => e.type === type,
  ).length;
}

// ---- fixtures -------------------------------------------------------------

/**
 * Tree used by most tests:
 *
 *   u1 (root)
 *   └─ a1
 *      ├─ l (label targeting a1)   ← the tag's children are the side branch
 *      │  └─ u2 → a2               ← side branch (the compressible range)
 *      └─ u3 → a3                  ← main path (leaf = a3)
 */
function buildTaggedTree(): {
  sm: SessionManager;
  ids: Record<string, string>;
} {
  const sm = makeSession();
  const u1 = msg(sm, "user", "u1");
  const a1 = msg(sm, "assistant", "a1");
  // Tagging moves the leaf onto the label entry — the next message becomes
  // its child, exactly like pi's tree selector.
  sm.appendLabelChange(a1, "test-tag");
  const u2 = msg(sm, "user", "u2");
  const a2 = msg(sm, "assistant", "a2");
  sm.branch(a1);
  const u3 = msg(sm, "user", "u3");
  const a3 = msg(sm, "assistant", "a3");
  return { sm, ids: { u1, a1, u2, a2, u3, a3 } };
}

// ---- tests ----------------------------------------------------------------

test("side-branch distill: label pass-through + summary slot", () => {
  const { sm, ids } = buildTaggedTree();
  const all = sm.getEntries() as Array<Record<string, unknown>>;
  const plan = buildRebuildPlan(all, new Set([ids.u2, ids.a2]), true);
  const out = rebuild(plan, "SUMMARY");

  const p = parentsOf(out);
  const u1n = findByIdText(out, "u1")!;
  const a1n = findByIdText(out, "a1")!;
  const u3n = findByIdText(out, "u3")!;
  const a3n = findByIdText(out, "a3")!;
  const summary = (out.getEntries() as Array<Record<string, unknown>>).find(
    (e) =>
      e.type === "message" &&
      (e as { message?: { role?: string } }).message?.role === "compactionSummary",
  )!;

  // The tag's own entry is dropped (cannot be copied) …
  assert.equal(countType(out, "label"), 0, "label must not be copied");
  // … but the conversation that followed it (u2/a2) is replaced by the summary.
  assert.equal(findByIdText(out, "u2"), undefined, "u2 compressed away");
  assert.equal(findByIdText(out, "a2"), undefined, "a2 compressed away");
  // Summary sits under a1.
  assert.equal(p.get(summary.id), a1n, "summary must be child of a1");
  // Main path survives under a1.
  assert.equal(p.get(u3n), a1n, "u3 must stay under a1");
  assert.equal(p.get(a3n), u3n, "a3 must stay under u3");
  // No __summary__ residue anywhere.
  for (const e of out.getEntries() as Array<Record<string, unknown>>) {
    assert.notEqual(e.id, "__summary__", "no __summary__ entry id");
    assert.notEqual(e.parentId, "__summary__", "no __summary__ parentId");
  }
});

test("side-branch delete: range descendants survive (delete-mode anchor)", () => {
  //   u1 → a1 → { u2 → a2 → u3, u4 → a4 }   (u3 = continuation under the range)
  const sm = makeSession();
  const u1 = msg(sm, "user", "u1");
  const a1 = msg(sm, "assistant", "a1");
  const u2 = msg(sm, "user", "u2");
  const a2 = msg(sm, "assistant", "a2");
  const u3 = msg(sm, "user", "u3");
  const a3 = msg(sm, "assistant", "a3");
  sm.branch(a1);
  const u4 = msg(sm, "user", "u4");
  const a4 = msg(sm, "assistant", "a4");

  const all = sm.getEntries() as Array<Record<string, unknown>>;
  // Delete the [u2, a2] pair; u3 → a3 is the continuation that must survive.
  const plan = buildRebuildPlan(all, new Set([u2, a2]), false);
  const out = rebuild(plan, undefined);

  const p = parentsOf(out);
  const a1n = findByIdText(out, "a1")!;
  const u3n = findByIdText(out, "u3")!;
  const a3n = findByIdText(out, "a3")!;
  const u4n = findByIdText(out, "u4")!;
  const a4n = findByIdText(out, "a4")!;

  assert.equal(findByIdText(out, "u2"), undefined, "u2 deleted");
  assert.equal(findByIdText(out, "a2"), undefined, "a2 deleted");
  // The continuation after the deleted range is re-attached under a1 —
  // previously it was silently dropped.
  assert.ok(u3n, "continuation u3 must survive");
  assert.equal(p.get(u3n), a1n, "u3 must re-attach under a1");
  assert.equal(p.get(a3n), u3n, "a3 must stay under u3");
  assert.equal(p.get(u4n), a1n, "u4 must stay under a1");
  assert.equal(p.get(a4n), u4n, "a4 must stay under u4");
});

test("side-branch distill: range descendants re-attach under the summary", () => {
  const sm = makeSession();
  const u1 = msg(sm, "user", "u1");
  const a1 = msg(sm, "assistant", "a1");
  const u2 = msg(sm, "user", "u2");
  const a2 = msg(sm, "assistant", "a2");
  const u3 = msg(sm, "user", "u3");
  const a3 = msg(sm, "assistant", "a3");
  sm.branch(a1);
  const u4 = msg(sm, "user", "u4");
  const a4 = msg(sm, "assistant", "a4");

  const all = sm.getEntries() as Array<Record<string, unknown>>;
  const plan = buildRebuildPlan(all, new Set([u2, a2]), true);
  const out = rebuild(plan, "SUMMARY");

  const p = parentsOf(out);
  const a1n = findByIdText(out, "a1")!;
  const u3n = findByIdText(out, "u3")!;
  const summary = (out.getEntries() as Array<Record<string, unknown>>).find(
    (e) =>
      e.type === "message" &&
      (e as { message?: { role?: string } }).message?.role === "compactionSummary",
  )!;

  assert.equal(p.get(summary.id), a1n, "summary under a1");
  assert.equal(p.get(u3n), summary.id, "continuation u3 under the summary");
});

test("pass-through: label child outside the range survives", () => {
  //   u1 → a1 → { l → u2 → a2 → u3 → a3,  u4 → a4 }
  // Range = [a2, u3]; u2 (child of the label) must survive, a3 must land
  // under the summary.
  const sm = makeSession();
  const u1 = msg(sm, "user", "u1");
  const a1 = msg(sm, "assistant", "a1");
  sm.appendLabelChange(a1, "tag");
  const u2 = msg(sm, "user", "u2");
  const a2 = msg(sm, "assistant", "a2");
  const u3 = msg(sm, "user", "u3");
  const a3 = msg(sm, "assistant", "a3");
  sm.branch(a1);
  const u4 = msg(sm, "user", "u4");
  const a4 = msg(sm, "assistant", "a4");

  const all = sm.getEntries() as Array<Record<string, unknown>>;
  const plan = buildRebuildPlan(all, new Set([a2, u3]), true);
  const out = rebuild(plan, "SUMMARY");

  const p = parentsOf(out);
  const a1n = findByIdText(out, "a1")!;
  const u2n = findByIdText(out, "u2")!;
  const a3n = findByIdText(out, "a3")!;
  const summary = (out.getEntries() as Array<Record<string, unknown>>).find(
    (e) =>
      e.type === "message" &&
      (e as { message?: { role?: string } }).message?.role === "compactionSummary",
  )!;

  assert.equal(countType(out, "label"), 0, "label dropped");
  // u2 is the label's child — previously dropped together with the label.
  assert.ok(u2n, "u2 (child of the label) must survive");
  assert.equal(p.get(u2n), a1n, "u2 re-attached under a1");
  // The range's descendant a3 hangs under the summary.
  assert.equal(p.get(a3n), summary.id, "a3 under the summary");
  assert.equal(p.get(summary.id), u2n, "summary under u2");
});

test("single-turn delete plan: turn-start child re-attaches to turn parent", () => {
  //   u1 → a1 → { u2 → a2 → u3 → a3,  u4 → a4 }
  // Delete turn [u2, a2]; u3 (a new user turn) must re-attach under a1.
  const sm = makeSession();
  const u1 = msg(sm, "user", "u1");
  const a1 = msg(sm, "assistant", "a1");
  const u2 = msg(sm, "user", "u2");
  const a2 = msg(sm, "assistant", "a2");
  const u3 = msg(sm, "user", "u3");
  const a3 = msg(sm, "assistant", "a3");
  sm.branch(a1);
  const u4 = msg(sm, "user", "u4");
  const a4 = msg(sm, "assistant", "a4");

  // Simulate deleteSingleEntry: skipIds = deleted turn + its reply chain
  // (u2, a2); u3 is a turn start and is preserved.
  const all = sm.getEntries() as Array<Record<string, unknown>>;
  const skipIds = new Set([u2, a2]);
  const plan = buildRebuildPlan(all, skipIds, false);
  const out = rebuild(plan, undefined);

  const p = parentsOf(out);
  const a1n = findByIdText(out, "a1")!;
  const u3n = findByIdText(out, "u3")!;
  const a3n = findByIdText(out, "a3")!;

  assert.equal(findByIdText(out, "u2"), undefined, "u2 deleted");
  assert.equal(findByIdText(out, "a2"), undefined, "a2 deleted");
  assert.equal(p.get(u3n), a1n, "u3 re-attached under a1");
  assert.equal(p.get(a3n), u3n, "a3 stays under u3");
});

test("merge rebuild: branch summarized into the fork point", () => {
  //   u1 → a1 → { b1 → b2 (the branch being merged), u2 → u3 (main path) }
  // After the merge: a1 → [summary] → { u2 → u3 }, with b1/b2 compressed.
  const sm = makeSession();
  const u1 = msg(sm, "user", "u1");
  const a1 = msg(sm, "assistant", "a1");
  const b1 = msg(sm, "user", "b1");
  const b2 = msg(sm, "assistant", "b2");
  sm.branch(a1);
  const u2 = msg(sm, "user", "u2");
  const u3 = msg(sm, "assistant", "u3");

  const allEntries = sm.getEntries() as unknown as Array<
    Record<string, unknown>
  >;
  const byId = new Map(allEntries.map((e) => [e.id as string, e]));
  const leafId = sm.getLeafId()!;
  const mainPath: Array<Record<string, unknown>> = [];
  let cur = byId.get(leafId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id as string)) {
    seen.add(cur.id as string);
    mainPath.unshift(cur);
    const pid = cur.parentId as string | null;
    if (!pid) break;
    cur = byId.get(pid);
  }
  const mainPathIds = new Set(mainPath.map((e) => e.id as string));

  const { segmentA, mainAfterParent, sideRoots, offPathSubtrees } =
    computeMergeSegments(allEntries, byId, mainPath, a1, b1);
  assert.deepEqual(
    segmentA.map((e) => e.id),
    [u1, a1],
    "segmentA = root → parent",
  );
  assert.deepEqual(
    mainAfterParent.map((e) => e.id),
    [u2, u3],
    "main continuation after parent",
  );
  assert.deepEqual(sideRoots.map((e) => e.id), [], "no other side branches");

  const out = makeSession();
  const mergedId = rebuildMerged(out as any, {
    segmentA,
    mainAfterParent,
    offPathSubtrees,
    parentId: a1,
    underMerged: [],
    sideSubtrees: sideRoots.map((r) =>
      collectOffPathSubtree(byId, allEntries, mainPathIds, r.id as string, true),
    ),
    appendMerged: (sm) =>
      sm.appendMessage({
        role: "compactionSummary",
        summary: "S",
        tokensBefore: 0,
        timestamp: Date.now(),
      } as any),
  });

  const p = parentsOf(out);
  const u1n = findByIdText(out, "u1")!;
  const a1n = findByIdText(out, "a1")!;
  const u2n = findByIdText(out, "u2")!;
  const u3n = findByIdText(out, "u3")!;
  assert.equal(findByIdText(out, "b1"), undefined, "branch compressed");
  assert.equal(findByIdText(out, "b2"), undefined, "branch compressed");
  assert.ok(mergedId, "summary appended");
  assert.equal(p.get(a1n), u1n, "a1 under u1");
  assert.equal(p.get(mergedId!), a1n, "summary under the fork point");
  assert.equal(p.get(u2n), mergedId!, "main path under the summary");
  assert.equal(p.get(u3n), u2n, "u3 under u2");
});

test("plan rebuild restores the leaf to the original position (delete)", () => {
  // u1 → a1 → { c1 → c2 (current leaf), b1 → b2 (deleted side branch),
  //              d1 → d2 (later fork) }
  // The deleted branch sits BEFORE the later fork in file order, so a plain
  // DFS replay would end on d2 instead of the user's c2.
  const sm = makeSession();
  const u1 = msg(sm, "user", "u1");
  const a1 = msg(sm, "assistant", "a1");
  const c1 = msg(sm, "user", "c1");
  const c2 = msg(sm, "assistant", "c2");
  sm.branch(a1);
  const b1 = msg(sm, "user", "b1");
  const b2 = msg(sm, "assistant", "b2");
  sm.branch(a1);
  const d1 = msg(sm, "user", "d1");
  const d2 = msg(sm, "assistant", "d2");
  sm.branch(c2); // user's position: leaf = c2

  const all = sm.getEntries() as Array<Record<string, unknown>>;
  const plan = buildRebuildPlan(all, new Set([b1, b2]), false);

  // Sanity: without a target leaf the rebuild ends on the last DFS entry.
  const plain = rebuild(plan, undefined);
  const d2n = findByIdText(plain, "d2")!;
  assert.equal(plain.getLeafId(), d2n, "sanity: plain replay ends on d2");

  // With the target leaf the position is restored to c2.
  const out = rebuild(plan, undefined, 0, c2);
  const c2n = findByIdText(out, "c2")!;
  assert.equal(out.getLeafId(), c2n, "leaf restored to original position");
});

test("plan rebuild restores the leaf after a side-branch distill", () => {
  const sm = makeSession();
  const u1 = msg(sm, "user", "u1");
  const a1 = msg(sm, "assistant", "a1");
  const c1 = msg(sm, "user", "c1");
  const c2 = msg(sm, "assistant", "c2");
  sm.branch(a1);
  const b1 = msg(sm, "user", "b1");
  const b2 = msg(sm, "assistant", "b2");
  sm.branch(a1);
  const d1 = msg(sm, "user", "d1");
  const d2 = msg(sm, "assistant", "d2");
  sm.branch(c2);

  const all = sm.getEntries() as Array<Record<string, unknown>>;
  const plan = buildRebuildPlan(all, new Set([b1, b2]), true);
  const out = rebuild(plan, "SUMMARY", 0, c2);

  const c2n = findByIdText(out, "c2")!;
  assert.equal(out.getLeafId(), c2n, "leaf restored after distill");
});

test("appendEntry round-trips every copyable entry type", () => {
  const src = makeSession();
  const u1 = msg(src, "user", "u1");
  src.appendModelChange("prov", "model");
  src.appendThinkingLevelChange("high");
  src.appendSessionInfo("my title");
  src.appendCustomEntry("custom-x", { a: 1 });
  src.appendCustomMessageEntry("custom-msg-x", "hello", true, { b: 2 });
  const a1 = msg(src, "assistant", "a1");

  const dst = makeSession();
  const idMap = new Map<string, string>();
  for (const e of src.getEntries() as Array<Record<string, unknown>>) {
    const newId = appendEntry(dst as any, e);
    if (newId) idMap.set(e.id as string, newId);
  }
  const out = dst.getEntries() as Array<Record<string, unknown>>;

  assert.equal(out.length, 7, "all copyable entries copied");
  assert.equal(
    (out.find((e) => e.type === "session_info") as { name?: string } | undefined)?.name,
    "my title",
  );
  // Custom entries keep their payloads.
  const custom = out.find(
    (e) => e.type === "custom" && (e as { customType?: string }).customType === "custom-x",
  ) as { data?: unknown } | undefined;
  assert.deepEqual(custom?.data, { a: 1 });
  // Labels are skipped by appendEntry.
  const withLabel = makeSession();
  const wlMsg = msg(withLabel, "user", "wl");
  withLabel.appendLabelChange(wlMsg, "x");
  const appended = appendEntry(
    withLabel as any,
    (withLabel.getEntries() as Array<Record<string, unknown>>).find(
      (e) => e.type === "label",
    )!,
  );
  assert.equal(appended, undefined, "label entries are pass-through");
});

// ---- /distill up (findCleanBranchRange) -------------------------------------

/** Append a distilled summary message; returns its id. */
function compaction(sm: SessionManager): string {
  return sm.appendMessage({
    role: "compactionSummary",
    summary:
      '<distilled-summary turns="1" messages="1">old\n</distilled-summary>',
    tokensBefore: 0,
    timestamp: Date.now(),
  } as any);
}

type CleanRange = {
  summaryId: string | null;
  startId: string;
  endId: string;
  messageCount: number;
  firstMessage: string;
};

test("up: finds the clean range up to the previous summary", () => {
  const sm = makeSession();
  const s = compaction(sm);
  const u1 = msg(sm, "user", "u1");
  const a1 = msg(sm, "assistant", "a1");
  const u2 = msg(sm, "user", "u2");
  const a2 = msg(sm, "assistant", "a2");

  const found = findCleanBranchRange({ sessionManager: sm } as any) as
    | CleanRange
    | { error: string };
  assert.equal("error" in found, false, "should not error");
  const clean = found as CleanRange;
  assert.equal(clean.summaryId, s, "summary id");
  assert.equal(clean.startId, u1, "start = first message after summary");
  assert.equal(clean.endId, a2, "end = current leaf");
  assert.equal(clean.messageCount, 4, "count all messages after summary");
  assert.ok(clean.firstMessage.includes("u1"), "first message preview");
});

test("up: label pass-through between summary and messages", () => {
  const sm = makeSession();
  const s = compaction(sm);
  sm.appendLabelChange(s, "tag"); // leaf moves onto the label entry
  const u1 = msg(sm, "user", "u1");
  const a1 = msg(sm, "assistant", "a1");

  const found = findCleanBranchRange({ sessionManager: sm } as any) as
    | CleanRange
    | { error: string };
  assert.equal("error" in found, false, "label must be transparent");
  const clean = found as CleanRange;
  assert.equal(clean.startId, u1, "start = first message after the label");
  assert.equal(clean.messageCount, 2);
});

test("up: accepts clean chain when summary has multiple children", () => {
  // The summary has 2 children (u1, u2) but the current path (s→u2→a2) is
  // clean — the other child (u1) is a sibling branch, not a fork in the
  // range. The range starts at the summary and goes to the leaf.
  const sm = makeSession();
  const s = compaction(sm);
  msg(sm, "user", "u1");
  msg(sm, "assistant", "a1");
  sm.branch(s);
  const u2 = msg(sm, "user", "u2");
  const a2 = msg(sm, "assistant", "a2");

  const found = findCleanBranchRange({ sessionManager: sm } as any) as
    | CleanRange
    | { error: string };
  assert.equal("error" in found, false, "should accept clean chain from summary");
  const clean = found as CleanRange;
  assert.equal(clean.summaryId, s, "summary id");
  assert.equal(clean.startId, u2, "start = first message after summary");
  assert.equal(clean.endId, a2, "end = leaf");
  assert.equal(clean.messageCount, 2, "u2 + a2");
});

test("up: rejects a fork in the middle of the chain", () => {
  const sm = makeSession();
  const s = compaction(sm);
  const u1 = msg(sm, "user", "u1");
  const a1 = msg(sm, "assistant", "a1");
  sm.branch(u1);
  msg(sm, "user", "b1");
  msg(sm, "assistant", "b2");
  sm.branch(a1); // jump back to the main branch
  const u2 = msg(sm, "user", "u2");
  const a2 = msg(sm, "assistant", "a2");

  // leaf = a2; u1 has two effective message children (a1, b1)
  const found = findCleanBranchRange({ sessionManager: sm } as any) as
    | CleanRange
    | { error: string };
  assert.ok("error" in found, "should reject a fork in the chain");
});

test("up: no previous summary on the branch", () => {
  const sm = makeSession();
  msg(sm, "user", "u1");
  msg(sm, "assistant", "a1");

  const found = findCleanBranchRange({ sessionManager: sm } as any) as
    | CleanRange
    | { error: string };
  assert.ok("error" in found, "should not find a summary");
});

test("up: leaf is the summary itself", () => {
  const sm = makeSession();
  compaction(sm); // leaf = summary

  const found = findCleanBranchRange({ sessionManager: sm } as any) as
    | CleanRange
    | { error: string };
  assert.ok("error" in found, "should reject when leaf is the summary");
});

test("up: compresses the whole branch when no previous summary", () => {
  // Tree: u1 → a1 → { b1 → b2 (other branch), u2 → a2 (leaf) }
  // The current branch (leaf = a2) must be created LAST so leaf is on it.
  const sm = makeSession();
  const u1 = msg(sm, "user", "u1");
  const a1 = msg(sm, "assistant", "a1");
  // Create the other branch first.
  const b1 = msg(sm, "user", "b1");
  msg(sm, "assistant", "b2");
  sm.branch(a1);
  // Now create the current branch (leaf = a2).
  const u2 = msg(sm, "user", "u2");
  const a2 = msg(sm, "assistant", "a2");

  // a1 has 2 effective children (b1, u2) → fork point.
  // The branch starts at the first message after a1 on the path: u2.
  const found = findCleanBranchRange({ sessionManager: sm } as any) as
    | CleanRange
    | { error: string };
  assert.equal("error" in found, false, "should find the whole branch");
  const clean = found as CleanRange;
  assert.equal(clean.summaryId, null, "no previous summary");
  assert.equal(clean.startId, u2, "start = first message after fork point");
  assert.equal(clean.endId, a2, "end = leaf");
  assert.equal(clean.messageCount, 2, "u2 + a2");
});

test("up: whole branch rejects when the branch has a fork", () => {
  // Tree: u1 → a1 → { b1 → b2 (other branch), u2 → a2 → { c1 → c2 (fork), d1 → d2 (leaf) } }
  // The outermost fork is a1 (2 children: b1, u2). The branch from a1's child
  // u2 to leaf d2 has a fork at a2 (2 children: c1, d1) → should reject.
  const sm = makeSession();
  const u1 = msg(sm, "user", "u1");
  const a1 = msg(sm, "assistant", "a1");
  // Create the other branch off a1 first.
  const b1 = msg(sm, "user", "b1");
  msg(sm, "assistant", "b2");
  sm.branch(a1);
  // Now create the current branch: u2 → a2 → { c1 → c2, d1 → d2 (leaf) }
  const u2 = msg(sm, "user", "u2");
  const a2 = msg(sm, "assistant", "a2");
  // Fork at a2: create a side branch c1 → c2.
  msg(sm, "user", "c1");
  msg(sm, "assistant", "c2");
  sm.branch(a2);
  // Create the continuation of the current branch: d1 → d2 (leaf).
  const d1 = msg(sm, "user", "d1");
  const d2 = msg(sm, "assistant", "d2");

  // a1 is the outermost fork (2 children: b1, u2). The branch from u2 to d2
  // has a fork at a2 (2 children: c1, d1) → should reject.
  const found = findCleanBranchRange({ sessionManager: sm } as any) as
    | CleanRange
    | { error: string };
  assert.ok("error" in found, "should reject a fork in the branch");
});

test("up: whole branch with label pass-through", () => {
  // Tree: u1 → a1 → label → u2 → a2 (leaf), and b1 → b2 (other branch)
  // The label is transparent, so the branch is the clean chain label→u2→a2.
  const sm = makeSession();
  const u1 = msg(sm, "user", "u1");
  const a1 = msg(sm, "assistant", "a1");
  // Create the other branch first.
  const b1 = msg(sm, "user", "b1");
  msg(sm, "assistant", "b2");
  sm.branch(a1);
  // Create the current branch with a label.
  sm.appendLabelChange(a1, "tag");
  const u2 = msg(sm, "user", "u2");
  const a2 = msg(sm, "assistant", "a2");

  // a1 has 2 effective children (b1, u2 through label) → fork point.
  // The label is transparent, so the branch is clean.
  const found = findCleanBranchRange({ sessionManager: sm } as any) as
    | CleanRange
    | { error: string };
  assert.equal("error" in found, false, "label must be transparent");
  const clean = found as CleanRange;
  assert.equal(clean.summaryId, null, "no previous summary");
  assert.equal(clean.startId, u2, "start = first message after the label");
  assert.equal(clean.messageCount, 2, "u2 + a2");
});
