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
import { promptSessionMethod, rebuildLinearRange } from "../src/commands/distill";

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

// ---- detection: in-range forks must be rejected ---------------------------

test("a message fork on the range end is allowed and flagged", async () => {
  // Ranges containing a fork are compressible; the branch cannot be
  // re-attached, so it stays in the old session (rangeHasBranches = true).
  const { sm, msg } = makeSession();
  const u1 = msg("user", "A");
  const a1 = msg("assistant", "B");
  const u2 = msg("user", "C");
  const a2 = msg("assistant", "E");
  // G hangs directly off E, F continues the main path
  const g = msg("user", "G");
  sm.branch(a2);
  msg("assistant", "F");

  const res = await executeCompact(
    { startLabel: "B", startId: a1, endId: a2, endLabelDesc: "E" },
    DROP_CONFIG as any,
    ctxFor(sm),
  );
  assert.equal(res.rangeHasBranches, true, "branch inside the range is reported");
  assert.ok(
    res.branches.every((b) => b.branchPointId !== a2),
    "the in-range fork is not carried over",
  );
});

test("a fork behind a label on the range end is detected and flagged", async () => {
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

  const res = await executeCompact(
    { startLabel: "B", startId: a1, endId: a2, endLabelDesc: "E" },
    DROP_CONFIG as any,
    ctxFor(sm),
  );
  assert.equal(res.rangeHasBranches, true, "fork behind a label is still found");
});

test("a fork behind a custom entry on the range end is detected and flagged", async () => {
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

  const res = await executeCompact(
    { startLabel: "B", startId: a1, endId: a2, endLabelDesc: "E" },
    DROP_CONFIG as any,
    ctxFor(sm),
  );
  assert.equal(res.rangeHasBranches, true, "fork behind a custom entry is found");
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

// ---- summary turn-boundary handling (the /distill up case) ----------------

test("up-style range keeps the summary it starts after", async () => {
  const { sm, msg } = makeSession();
  const summary = (label: string) =>
    sm.appendMessage({
      role: "compactionSummary",
      summary: `<distilled-summary turns="2" messages="3">${label}</distilled-summary>`,
      tokensBefore: 10,
      timestamp: Date.now(),
    } as any);

  const u1 = msg("user", "A");
  const a1 = msg("assistant", "B");
  const u2 = msg("user", "C");
  const s1 = summary("S1");
  const s2 = summary("S2");
  // assistant replies that follow S2 belong to S2's turn
  const d = msg("assistant", "D");
  const e = msg("assistant", "E"); // leaf

  const res = await executeCompact(
    { startLabel: "[up] previous summary", startId: d, endId: e },
    DROP_CONFIG as any,
    ctxFor(sm),
  );

  assert.ok(
    res.segmentA.some((x) => x.id === s2),
    "S2 stays in segment A",
  );
  assert.ok(
    !res.segmentBC.some((x) => x.id === s2),
    "S2 must not be swallowed into the range",
  );
  assert.deepEqual(
    res.segmentBC.map((x) => (x as any).id),
    [d, e],
    "range is exactly D..E",
  );

  const out = SessionManager.inMemory("out");
  rebuildLinearRange(out as any, res, {
    summaryContent: "<distilled-summary>NEW</distilled-summary>",
  });
  const summaries = (out.getEntries() as any[])
    .filter((x) => x.type === "message" && x.message?.role === "compactionSummary")
    .map((x) => x.message.summary);
  assert.equal(summaries.length, 3, "S1 + S2 + NEW all present");
  assert.match(summaries[0], /S1/);
  assert.match(summaries[1], /S2/);
  assert.match(summaries[2], /NEW/);
});

test("side-branch range keeps a summary turn boundary too", async () => {
  const { sm, msg } = makeSession();
  const summary = () =>
    sm.appendMessage({
      role: "compactionSummary",
      summary: '<distilled-summary turns="2" messages="2">S</distilled-summary>',
      tokensBefore: 10,
      timestamp: Date.now(),
    } as any);

  const u1 = msg("user", "A");
  const a1 = msg("assistant", "B");
  // target branch: S → d → e
  const s = summary();
  const d = msg("assistant", "D");
  const e = msg("assistant", "E");
  // leaf elsewhere, so the target range is a side branch
  sm.branch(a1);
  msg("user", "O");
  const o2 = msg("assistant", "O2");

  const res = await executeCompact(
    { startLabel: "[up] branch start", startId: d, endId: e },
    DROP_CONFIG as any,
    ctxFor(sm),
  );

  assert.ok(res.plan, "side-branch rebuild plan expected");
  const summarySlot = res.plan!.find((p) => p.insertSummary);
  assert.ok(summarySlot, "summary slot present");
  // S must be copied as its own entry, not replaced by the slot
  assert.ok(
    res.plan!.some((p) => (p.entry as any).id === s && !p.insertSummary),
    "S preserved in the plan",
  );
  assert.ok(
    !res.plan!.some((p) => p.insertSummary && (p.entry as any).id === s),
    "slot does not overwrite S",
  );
});

// ---- metadata-only forks inside the range must not block the operation ----

test("metadata-only fork inside the range does not reject", async () => {
  // Regression: a plan-mode-state custom entry plus a label hanging off a
  // node inside the range used to trip the in-range branch guard, failing
  // the whole distill/delete with "Branch detected in range".
  const { sm, msg } = makeSession();
  const u1 = msg("user", "A");
  const a1 = msg("assistant", "B");
  // off-path metadata siblings under B: a custom entry, then a label under it
  sm.appendCustomEntry("plan-mode-state", {});
  sm.appendLabelChange(a1, "tagB");
  // main path continues from B
  sm.branch(a1);
  const u2 = msg("user", "C");
  const a2 = msg("assistant", "D");

  const res = await executeCompact(
    { startLabel: "B", startId: a1, endId: a2, endLabelDesc: "D" },
    DROP_CONFIG as any,
    ctxFor(sm),
  );

  // The range compresses; the metadata-only fork carries no messages, so it
  // is not conversation data: in-place stays available and nothing is
  // carried over (it is dropped with the rest of the in-range metadata).
  assert.ok(res.segmentBC.length >= 2, "range compresses");
  assert.equal(res.rangeHasBranches, false, "metadata fork is not data loss");
  assert.ok(
    res.branches.every((b) => b.branchPointId !== a1),
    "in-range metadata fork is not carried over",
  );

  const out = SessionManager.inMemory("out");
  rebuildLinearRange(out as any, res, { summaryContent: SUMMARY });
  assert.ok(
    (out.getEntries() as any[]).some((e) => e.type === "message"),
    "rebuild succeeds",
  );
});

// ---- session-method prompt and two-tag fork ranges -------------------------

test("forceNew hides the in-place option", async () => {
  const calls: Array<{ title: string; options: string[] }> = [];
  const makeCtx = (pick: number) =>
    ({
      ui: {
        select: async (title: string, options: string[]) => {
          calls.push({ title, options });
          return options[pick];
        },
        theme: { fg: (_: string, s: string) => s },
      },
    }) as any;

  const forced = await promptSessionMethod(makeCtx(0), { forceNew: true });
  assert.equal(forced, true, "new session chosen");
  assert.deepEqual(
    calls[0].options,
    ["New session (keep old as distilled)", "Cancel"],
    "no in-place option offered",
  );
  assert.match(calls[0].title, /in-place unavailable/);

  calls.length = 0;
  const normal = await promptSessionMethod(makeCtx(1), {});
  assert.equal(normal, false, "in-place chosen when offered");
  assert.equal(calls[0].options.length, 3, "in-place still offered normally");
});

test("two-tag range with a fork at the end tag is allowed (new session only)", async () => {
  // Mirrors the reported session: range A..B where B forks into another line.
  const { sm, msg } = makeSession();
  const a = msg("user", "A");
  const b = msg("assistant", "B");
  // another line forks off B; the main path continues with C
  const fork = msg("user", "F-branch");
  const forkReply = msg("assistant", "F-reply");
  sm.branch(b);
  const c = msg("user", "C");
  const cReply = msg("assistant", "C-reply");

  const res = await executeCompact(
    { startLabel: "tag", startId: a, endId: b, endLabelDesc: "the second tag" },
    DROP_CONFIG as any,
    ctxFor(sm),
  );
  assert.equal(res.rangeHasBranches, true, "fork at the end tag is flagged");
  assert.ok(
    res.branches.every((x) => x.branchPointId !== b),
    "in-range fork is not carried over",
  );

  const out = SessionManager.inMemory("out");
  rebuildLinearRange(out as any, res, { summaryContent: SUMMARY });
  const t = texts(out);
  assert.ok(t.includes("C") && t.includes("C-reply"), "continuation kept");
  assert.ok(
    !t.includes("F-branch") && !t.includes("F-reply"),
    "left-behind line stays in the old session",
  );
  void fork;
  void forkReply;
});
