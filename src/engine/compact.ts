/**
 * Unified compression engine — shared by scene A (label→current) and scene B (label→label).
 *
 * Flow: resolve labels → branch check → turn grouping → collect & summarise → rebuild session.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildPath,
  groupPathIntoTurns,
  resolveLabel,
} from "./turn-group";
import type { AnyEntry } from "./turn-group";
import { buildSummaryPrompt, formatMessages } from "./prompt";

// ---- prompt logging -------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_DIR = join(__dirname, "../../logs");

/** Write the generated prompt to a timestamped file for debugging. */
function logPrompt(prompt: string, modelLabel: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(LOG_DIR, `distill-${ts}.txt`);
    const header = [
      "# Distill prompt log",
      `time: ${new Date().toISOString()}`,
      `model: ${modelLabel}`,
      "",
    ].join("\n");
    writeFileSync(file, `${header}\n${prompt}\n`);
  } catch {
    // Logging is best-effort; never fail the distill flow.
  }
}

// ---- types ----------------------------------------------------------------

export interface CompactRange {
  startLabel: string;
  /** If set, end at this label; otherwise end at current leaf. */
  endLabel?: string;
  /** Pre-resolved start entry ID (skips label lookup). */
  startId?: string;
  /** Pre-resolved end entry ID (skips label lookup). */
  endId?: string;
  supplement?: string;
}

export interface DistillConfig {
  autoClean: boolean;
  summaryModel: string;
  contextOn: boolean;
  /** Skip summary generation and simply drop the compressed range. */
  drop: boolean;
}

// ---- branch detection -----------------------------------------------------

function hasBranchInRange(
  allEntries: Array<Record<string, unknown>>,
  byId: Map<string, Record<string, unknown>>,
  startId: string,
  endId: string,
  fullPathIds: Set<string>,
): boolean {
  let current: Record<string, unknown> | undefined = byId.get(endId);
  const pathIds = new Set<string>();
  while (current && !pathIds.has(current.id as string)) {
    pathIds.add(current.id as string);
    if ((current.id as string) === startId) break;
    current = byId.get((current.parentId as string) ?? "");
  }
  pathIds.add(startId);

  const messageEntries = allEntries.filter((e) => e.type === "message");
  for (const id of pathIds) {
    const children = messageEntries.filter(
      (e) => (e.parentId as string | null) === id,
    );
    // A child that continues the main path (root → leaf) past endId is
    // segmentD, not a fork — only off-path children are branches.
    if (
      children.some(
        (c) =>
          !pathIds.has(c.id as string) && !fullPathIds.has(c.id as string),
      )
    ) {
      return true;
    }
  }
  return false;
}

// ---- branch collection ---------------------------------------------------

export interface BranchData {
  /** ID of the entry on the main path where this branch forks. */
  branchPointId: string;
  /** All entries in this branch (message and non-message), chronological. */
  entries: Array<Record<string, unknown>>;
}

/**
 * Find all branches that fork off the main path (fullPath).
 * Only collects branches whose fork point is an ancestor of the compressed
 * range — branches after endId are not preserved (they are replaced by the
 * summary → segmentD chain).
 */
export function collectBranches(
  allEntries: Array<Record<string, unknown>>,
  byId: Map<string, Record<string, unknown>>,
  fullPath: Array<Record<string, unknown>>,
  endId: string,
): BranchData[] {
  const fullPathIds = new Set(fullPath.map((e) => e.id as string));
  const result: BranchData[] = [];

  // Only consider fork points up to and including endId.
  // Branches after endId would conflict with the summary chain.
  const endIdx = fullPath.findIndex((e) => (e.id as string) === endId);
  const eligibleIds = new Set(
    fullPath.slice(0, endIdx + 1).map((e) => e.id as string),
  );

  // Walk each entry's children to find off-path branches.
  // We use all entries (not just messages) to preserve labels, model changes etc.
  function walkDescendants(startId: string): Array<Record<string, unknown>> {
    const collected: Array<Record<string, unknown>> = [];
    const directChildren = allEntries.filter(
      (e) => (e.parentId as string | null) === startId && !fullPathIds.has(e.id as string),
    );
    for (const child of directChildren) {
      collected.push(child);
      collected.push(...walkDescendants(child.id as string));
    }
    return collected;
  }

  for (const id of eligibleIds) {
    const branchEntries = walkDescendants(id);
    if (branchEntries.length > 0) {
      result.push({ branchPointId: id, entries: branchEntries });
    }
  }

  return result;
}

/**
 * Walk from `endId` up to root (following parentId), returning chronological
 * order (root → endId).
 */
function buildFullPath(
  byId: Map<string, Record<string, unknown>>,
  endId: string,
): Array<Record<string, unknown>> {
  const reversed: Array<Record<string, unknown>> = [];
  let cur = byId.get(endId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id as string)) {
    seen.add(cur.id as string);
    reversed.push(cur);
    const pid = cur.parentId as string | null;
    if (!pid) break;
    cur = byId.get(pid);
  }
  return reversed.reverse();
}

/**
 * Extract background context — content entries before startId on the path
 * from root → endId (messages + previously distilled summaries).
 */
function getBackgroundMessages(
  byId: Map<string, Record<string, unknown>>,
  startId: string,
  endId: string,
  contextOn: boolean,
): AnyEntry[] {
  const chrono = buildFullPath(byId, endId);

  // Find position of startId
  const startIdx = chrono.findIndex((e) => (e.id as string) === startId);
  if (startIdx <= 0) return [];

  const before = chrono.slice(0, startIdx);
  // All message entries count as background — including previously distilled
  // summaries (stored as compactionSummary messages).
  const content = before.filter((e) => e.type === "message") as AnyEntry[];

  if (contextOn) return content;

  // Only last 2 entries
  return content.slice(-2);
}

// ---- summary generation ---------------------------------------------------

async function generateSummary(
  rangeMessages: AnyEntry[],
  backgroundMessages: AnyEntry[],
  supplement: string | undefined,
  contextOn: boolean,
  model: Parameters<typeof complete>[0],
  apiKey: string,
  headers: Record<string, string> | undefined,
  env: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<string> {
  const compressedText = formatMessages(rangeMessages);
  const backgroundText = backgroundMessages.length > 0
    ? formatMessages(backgroundMessages)
    : "";

  const prompt = buildSummaryPrompt({
    backgroundText,
    compressedText,
    supplement,
    contextOn,
  });

  // Log the exact prompt sent to the LLM for debugging.
  const modelLabel = `${(model as { provider?: string }).provider ?? "?"}/${(model as { id?: string }).id ?? "?"}`;
  logPrompt(prompt, modelLabel);

  const response = await complete(
    model,
    {
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey,
      headers,
      env,
      maxTokens: 4096,
      signal,
      cacheRetention: "none",
      sessionId: uuidv7(),
    },
  );

  return response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ---- main engine ----------------------------------------------------------

interface CompactResult {
  summary: string;
  /** All entries before the compressed range (messages + non-messages). */
  segmentA: AnyEntry[];
  /** Content entries in the compressed range (messages + distilled summaries). */
  segmentBC: AnyEntry[];
  /** All entries after the compressed range (messages + non-messages). */
  segmentD: AnyEntry[];
  turnCount: number;
  /** Branches that fork off the main path before endId. */
  branches: BranchData[];
  /**
   * Whole-tree rebuild plan (side-branch ranges). When set, segmentA/D and
   * branches are empty — the plan carries the full DFS order plus the parent
   * each entry is re-attached under. `insertSummary` marks the slot where a
   * fresh compactionSummary is inserted instead of copying the entry.
   */
  plan?: PlanEntry[];
}

export interface PlanEntry {
  /** Entry to copy, or the placeholder when insertSummary is set. */
  entry: AnyEntry;
  /** Effective parent after remapping; "__summary__" = under the new summary. */
  parentId: string | null;
  /** Insert a fresh compactionSummary here instead of copying the entry. */
  insertSummary?: boolean;
}

/**
 * Execute the full compact flow.
 *
 * Throws if labels can't be resolved, branch detected, or user cancels.
 */
export async function executeCompact(
  range: CompactRange,
  config: DistillConfig,
  ctx: ExtensionCommandContext,
): Promise<CompactResult> {
  // ... (same resolution logic until we have segmentBC)

  const sm = ctx.sessionManager;
  const allEntries = sm.getEntries() as Array<Record<string, unknown>>;

  // Build lookup map
  const byId = new Map<string, Record<string, unknown>>();
  for (const e of allEntries) {
    byId.set(e.id as string, e);
  }

  // Resolve start label (pre-resolved ID wins over label lookup)
  const startId = range.startId ?? resolveLabel(sm, allEntries, range.startLabel);
  if (!startId) {
    throw new Error(`Label "${range.startLabel}" not found. Create one via /tree → shift+L first.`);
  }

  // Resolve end: pre-resolved ID, endLabel, or current leaf
  let endId: string;
  let endLabelDesc: string;
  if (range.endId) {
    endId = range.endId;
    endLabelDesc = range.endLabel ?? "current position";
  } else if (range.endLabel) {
    const resolved = resolveLabel(sm, allEntries, range.endLabel);
    if (!resolved) {
      throw new Error(`Label "${range.endLabel}" not found.`);
    }
    endId = resolved;
    endLabelDesc = range.endLabel;
  } else {
    endId = sm.getLeafId();
    if (!endId) throw new Error("Cannot determine current leaf node.");
    endLabelDesc = "current position";
  }

  // Ensure start and end are on the same branch
  const pathCheck = buildPath(byId, startId, endId);
  if (pathCheck.length === 0) {
    throw new Error(
      `Labels "${range.startLabel}" and "${endLabelDesc}" are not on the same path.`,
    );
  }

  // Build the FULL path from root → current leaf.
  const leafId = sm.getLeafId();
  const fullPath = buildFullPath(byId, leafId);
  const fullPathIds = new Set(fullPath.map((e) => e.id as string));

  // Snap an id to the nearest message entry on a given path.
  function snapToMessageOn(
    path: Array<Record<string, unknown>>,
    target: string,
    direction: "forward" | "backward",
  ): string {
    const idx = path.findIndex((e) => (e.id as string) === target);
    if (idx === -1) return target;
    if ((path[idx].type as string) === "message") return target;

    if (direction === "forward") {
      for (let i = idx + 1; i < path.length; i++) {
        if ((path[i].type as string) === "message")
          return path[i].id as string;
      }
    } else {
      for (let i = idx - 1; i >= 0; i--) {
        if ((path[i].type as string) === "message")
          return path[i].id as string;
      }
    }
    return target;
  }

  let segmentA: AnyEntry[] = [];
  let segmentBC: AnyEntry[] = [];
  let segmentD: AnyEntry[] = [];
  let branches: BranchData[] = [];
  let turnCount = 0;
  let plan: PlanEntry[] | undefined;
  let effectiveStartId = startId;
  let effectiveEndId = endId;

  // The range may live on a side branch (neither endpoint on the current
  // main path). Such a range never crosses branches, so the whole tree is
  // rebuilt with the range replaced by the summary.
  const offMainPath = !fullPathIds.has(startId) || !fullPathIds.has(endId);

  if (offMainPath) {
    // ---- side-branch range ----
    const branchPath = buildFullPath(byId, endId);
    effectiveStartId = snapToMessageOn(branchPath, startId, "forward");
    effectiveEndId = snapToMessageOn(branchPath, endId, "backward");

    const turns = groupPathIntoTurns(branchPath);
    const fullStartTurn = turns.findIndex((t) =>
      t.messages.some((m) => m.id === effectiveStartId),
    );
    const fullEndTurn = turns.findIndex((t) =>
      t.messages.some((m) => m.id === effectiveEndId),
    );
    if (fullStartTurn === -1 || fullEndTurn === -1) {
      throw new Error(
        `Labels "${range.startLabel}" and "${endLabelDesc}" are not on the same path.`,
      );
    }

    const segmentBCTurns = turns.slice(fullStartTurn, fullEndTurn + 1);
    const bcIds = new Set(
      segmentBCTurns.flatMap((t) => t.entries.map((e) => e.id as string)),
    );
    segmentBC = segmentBCTurns
      .flatMap((t) => t.entries)
      .filter((e) => e.type === "message");
    turnCount = fullEndTurn - fullStartTurn + 1;

    // Continuation: the unique-child message chain below endId is the
    // branch's segmentD — it survives, re-attached under the summary.
    const continuationIds = new Set<string>();
    let node = byId.get(endId);
    while (node) {
      const kids = allEntries.filter(
        (e) =>
          (e.parentId as string | null) === node.id && e.type === "message",
      );
      if (kids.length !== 1) break;
      continuationIds.add(kids[0].id as string);
      node = kids[0];
    }

    // Branch check — children of range nodes that are neither on the range
    // chain nor the continuation are real forks; reject (same as main path).
    const messageEntries = allEntries.filter((e) => e.type === "message");
    for (const id of bcIds) {
      const kids = messageEntries.filter(
        (e) => (e.parentId as string | null) === id,
      );
      if (
        kids.some(
          (c) =>
            !bcIds.has(c.id as string) && !continuationIds.has(c.id as string),
        )
      ) {
        throw new Error(
          "Branch detected in range — not supported yet. Distill before/after the branch point separately.",
        );
      }
    }

    // Whole-tree rebuild plan: every entry in DFS order, the range replaced
    // by a fresh summary at the range start, the range's descendants
    // re-attached under it.
    const childrenOf = new Map<string | null, AnyEntry[]>();
    for (const e of allEntries) {
      const pid = (e.parentId as string | null) ?? null;
      const list = childrenOf.get(pid);
      if (list) list.push(e);
      else childrenOf.set(pid, [e]);
    }
    plan = [];
    const SUMMARY_ANCHOR = "__summary__";
    let inserted = false;
    const walk = (entry: AnyEntry, effParent: string | null) => {
      if (bcIds.has(entry.id as string)) {
        if (!inserted) {
          inserted = true;
          plan!.push({
            entry: {
              type: "message",
              id: SUMMARY_ANCHOR,
              parentId: null,
              message: {},
            },
            parentId: effParent,
            insertSummary: true,
          });
        }
        for (const c of childrenOf.get(entry.id as string) ?? []) {
          // Labels targeting compressed nodes are dropped with them.
          if (c.type === "label") continue;
          walk(c, SUMMARY_ANCHOR);
        }
        return;
      }
      plan!.push({ entry, parentId: effParent });
      for (const c of childrenOf.get(entry.id as string) ?? []) {
        walk(c, entry.id as string);
      }
    };
    for (const root of childrenOf.get(null) ?? []) {
      if (root.type === "session") continue;
      walk(root, null);
    }
  } else {
    // ---- main-path range ----
    // Branch check — reject if branches inside compressed range. Children
    // that continue the main path (root → leaf) past endId are segmentD.
    if (hasBranchInRange(allEntries, byId, startId, endId, fullPathIds)) {
      throw new Error(
        "Branch detected in range — not supported yet. Distill before/after the branch point separately.",
      );
    }

    effectiveStartId = snapToMessageOn(fullPath, startId, "forward");
    effectiveEndId = snapToMessageOn(fullPath, endId, "backward");

    // Group the FULL path (all entry types) into turns.
    const turns = groupPathIntoTurns(fullPath);

    // Find the turn containing effectiveStartId
    const fullStartTurn = turns.findIndex((t) =>
      t.messages.some((m) => m.id === effectiveStartId),
    );
    if (fullStartTurn === -1) {
      throw new Error(
        `Label "${range.startLabel}" target is not in the message path.`,
      );
    }

    // Find the turn containing effectiveEndId
    const fullEndTurn = turns.findIndex((t) =>
      t.messages.some((m) => m.id === effectiveEndId),
    );
    if (fullEndTurn === -1) {
      throw new Error(`End label target is not in the message path.`);
    }

    // Segments — preserve ALL entry types. Turn boundaries are respected so
    // a "question → answer" pair is never split: a label placed on an
    // assistant reply pulls its whole turn (including the leading user
    // message) into the compressed range.
    for (let i = 0; i < fullStartTurn; i++) {
      segmentA.push(...turns[i].entries);
    }

    const segmentBCTurns = turns.slice(fullStartTurn, fullEndTurn + 1);
    // Include messages AND previously distilled summaries, so a second
    // distill never drops the first one's content. (Distilled summaries are
    // stored as compactionSummary messages, so plain message entries cover
    // both.)
    for (const t of segmentBCTurns) {
      for (const e of t.entries) {
        if (e.type === "message") {
          segmentBC.push(e);
        }
      }
    }

    for (let i = fullEndTurn + 1; i < turns.length; i++) {
      segmentD.push(...turns[i].entries);
    }

    // Number of conversation turns inside the compressed range.
    turnCount = fullEndTurn - fullStartTurn + 1;

    // Collect branches that fork off the main path (preserved in new session)
    branches = collectBranches(allEntries, byId, fullPath, endId);
  }

  // Get background messages
  const backgroundMessages = getBackgroundMessages(
    byId,
    effectiveStartId,
    effectiveEndId,
    config.contextOn,
  );

  // Drop mode: skip summary generation and just report the segments.
  if (config.drop) {
    return {
      summary: "",
      segmentA,
      segmentBC,
      segmentD,
      turnCount,
      branches,
      plan,
    };
  }

  // Determine model for summary
  let model;
  if (config.summaryModel === "inherit") {
    model = ctx.model;
    if (!model) throw new Error("Current conversation model not found.");
  } else {
    // Parse "provider/modelId" format
    const [provider, ...modelParts] = config.summaryModel.split("/");
    const modelId = modelParts.join("/");
    model = ctx.modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(
        `Summary model "${config.summaryModel}" not found. Use /distill model to select.`,
      );
    }
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);
  if (!auth.apiKey) throw new Error(`Model "${model.id}" missing API key.`);

  // Generate summary
  ctx.ui.notify("Generating summary...", "info");

  const summary = await generateSummary(
    segmentBC,
    backgroundMessages,
    range.supplement,
    config.contextOn,
    model,
    auth.apiKey,
    auth.headers,
    auth.env,
    ctx.signal ?? new AbortController().signal,
  );

  if (!summary.trim()) {
    throw new Error("Summary generation returned empty result.");
  }

  return {
    summary,
    segmentA,
    segmentBC,
    segmentD,
    turnCount,
    branches,
    plan,
  };
}
