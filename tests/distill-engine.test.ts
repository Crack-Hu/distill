/**
 * Regression tests for branch detection and preservation in the compact
 * engine (`executeCompact`) and the linear rebuild (`rebuildLinearRange`).
 *
 * Bug being locked down: a branch that forks off the compressed range through
 * a non-message node (label / custom state) used to slip past the message-only
 * fork check; the rebuild then dropped it silently because its fork point was
 * inside the range and therefore not part of segment A.
 *
 * Run:  bun test tests/distill-engine.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { executeCompact } from "../src/engine/compact";
import { rebuildLinearRange } from "../src/commands/distill";

// ---- helpers --------------------------------------------------------------

const DROP_CONFIG = {
  autoClean: false,
  summaryModel: "inherit",
  contextOn: false,
  drop: true,
} as const;

function ctxFor(sm: SessionManager) {
  return {
    sessionManager: sm,
    ui: { notify() {}, theme: { fg: (_: string, s: string) => s } },
    modelRegistry: {},
    cwd: "/tmp/distill-test",
    hasUI: false,
    signal: undefined,
  } as any;
}

const SUMMARY = "<distilled-summary>s</distilled-summary>";

function makeSession() {
  const sm = SessionManager.inMemory("engine-test");
  const msg = (role: string, text: string) =>
    sm.appendMessage({
      role,
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    } as any);
  return { sm, msg };
}

/** Texts of all message entries in a rebuilt session. */
function texts(sm: SessionManager): string[] {
  return (sm.getEntries() as any[])
    .filter((e) => e.type === "message")
    .map((e) => e.message?.content?.[0]?.text)
    .filter((t) => typeof t === "string");
}

const BRANCH_ERR = /Branch detected in range/;

// ---- detection: in-range forks must be rejected ---------------------------

test("rejects a direct fork on the range end", async () => {
  const { sm, msg } = makeSession();
  const u1 = msg("user", "A");
  const a1 = msg("assistant", "B");
  const u2 = msg("user", "C");
  const a2 = msg("assistant", "E");
  // G hangs directly off E, F continues the main path
  const g = msg("user", "G");
  sm.branch(a2);
  msg("assistant", "F");

  await assert.rejects(
    executeCompact(
      { startLabel: "B", startId: a1, endId: a2, endLabelDesc: "E" },
      DROP_CONFIG as any,
      ctxFor(sm),
    ),
    BRANCH_ERR,
  );
});

test("rejects a fork that hangs off the range end via a label", async () => {
  const { sm, msg } = makeSession();
  const u1 = msg("user", "A");
  const a1 = msg("assistant", "B");
  const u2 = msg("user", "C");
  const a2 = msg("assistant", "E");
  // E → label → G  (pi moves the leaf onto the label, so the next message
  // becomes the label's child)
  sm.appendLabelChange(a2, "tagE");
  msg("user", "G");
  sm.branch(a2);
  msg("assistant", "F");

  await assert.rejects(
    executeCompact(
      { startLabel: "B", startId: a1, endId: a2, endLabelDesc: "E" },
      DROP_CONFIG as any,
      ctxFor(sm),
    ),
    BRANCH_ERR,
  );
});

test("rejects a fork that hangs off the range end via a custom entry", async () => {
  const { sm, msg } = makeSession();
  const u1 = msg("user", "A");
  const a1 = msg("assistant", "B");
  const u2 = msg("user", "C");
  const a2 = msg("assistant", "E");
  // E → plan-mode-state → G
  sm.appendCustomEntry("plan-mode-state", {});
  msg("user", "G");
  sm.branch(a2);
  msg("assistant", "F");

  await assert.rejects(
    executeCompact(
      { startLabel: "B", startId: a1, endId: a2, endLabelDesc: "E" },
      DROP_CONFIG as any,
      ctxFor(sm),
    ),
    BRANCH_ERR,
  );
});

test("metadata-only custom entry inside the range does not reject", async () => {
  const { sm, msg } = makeSession();
  const u1 = msg("user", "A");
  const a1 = msg("assistant", "B");
  const u2 = msg("user", "C");
  // plan-mode-state hangs off C but has no conversation under it
  sm.appendCustomEntry("plan-mode-state", {});
  const a2 = msg("assistant", "D");
  msg("assistant", "F");

  const res = await executeCompact(
    { startLabel: "B", startId: a1, endId: a2, endLabelDesc: "D" },
    DROP_CONFIG as any,
    ctxFor(sm),
  );
  assert.equal(res.branches.length, 0, "no conversation branch expected");
});

// ---- preservation: off-range forks survive the rebuild --------------------

test("fork before the range survives a linear rebuild", async () => {
  const { sm, msg } = makeSession();
  const u1 = msg("user", "A");
  const a1 = msg("assistant", "B");
  // branch off A (before the range)
  const g = msg("user", "G");
  const g2 = msg("assistant", "G2");
  sm.branch(a1);
  const u2 = msg("user", "C");
  const a2 = msg("assistant", "D");
  msg("assistant", "F");

  const res = await executeCompact(
    { startLabel: "C", startId: u2, endId: a2, endLabelDesc: "D" },
    DROP_CONFIG as any,
    ctxFor(sm),
  );
  const out = SessionManager.inMemory("out");
  rebuildLinearRange(out as any, res, { summaryContent: SUMMARY });
  const t = texts(out);
  assert.ok(t.includes("G") && t.includes("G2"), "branch before the range kept");
});

test("fork after the range (segment D) survives a linear rebuild", async () => {
  const { sm, msg } = makeSession();
  const u1 = msg("user", "A");
  const a1 = msg("assistant", "B");
  const u2 = msg("user", "C");
  const a2 = msg("assistant", "D"); // range end
  const u3 = msg("user", "F"); // new user turn after the range
  const a3 = msg("assistant", "F2"); // leaf
  // branch off u3 (after the range)
  sm.branch(u3);
  const h = msg("user", "H");
  const h2 = msg("assistant", "H2");
  sm.branch(a3);

  const res = await executeCompact(
    { startLabel: "B", startId: a1, endId: a2, endLabelDesc: "D" },
    DROP_CONFIG as any,
    ctxFor(sm),
  );
  assert.equal(res.branches.length, 1, "segment-D fork collected");
  assert.equal(res.branches[0].branchPointId, u3, "fork point is the segment-D node");

  const out = SessionManager.inMemory("out");
  rebuildLinearRange(out as any, res, { summaryContent: SUMMARY });
  const t = texts(out);
  assert.ok(t.includes("H") && t.includes("H2"), "branch after the range kept");

  // The leaf must end on the tail of segment D, not on the re-attached branch.
  const leaf = out.getLeafId();
  const leafEntry = (out.getEntries() as any[]).find((e) => e.id === leaf);
  assert.equal(leafEntry?.message?.content?.[0]?.text, "F2", "leaf restored to segment D tail");
});

test("deletion rebuild (no summary) also keeps a segment-D fork", async () => {
  const { sm, msg } = makeSession();
  const u1 = msg("user", "A");
  const a1 = msg("assistant", "B");
  const u2 = msg("user", "C");
  const a2 = msg("assistant", "D"); // range end
  const u3 = msg("user", "F");
  const a3 = msg("assistant", "F2"); // leaf
  sm.branch(u3);
  const h = msg("user", "H");
  const h2 = msg("assistant", "H2");
  sm.branch(a3);

  const res = await executeCompact(
    { startLabel: "B", startId: a1, endId: a2, endLabelDesc: "D" },
    DROP_CONFIG as any,
    ctxFor(sm),
  );
  const out = SessionManager.inMemory("out");
  rebuildLinearRange(out as any, res); // delete mode: no summary
  const t = texts(out);
  assert.ok(t.includes("H") && t.includes("H2"), "branch kept in delete mode");
  assert.ok(!t.includes("B"), "range content dropped");
});
