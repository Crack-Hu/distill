/**
 * Unified compression engine — shared by scene A (label→current) and scene B (label→label).
 *
 * Flow: resolve labels → branch check → turn grouping → collect & summarise → rebuild session.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
  Component,
  KeybindingsManager,
  Theme,
  TUI,
} from "@earendil-works/pi-tui";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildPath,
  buildRootPath,
  collectOffPathSubtree,
  groupPathIntoTurns,
  PASSTHROUGH_TYPES,
  resolveLabel,
} from "./turn-group";
import type { AnyEntry, Turn } from "./turn-group";
import { buildSummaryPrompt, formatMessages } from "./prompt";
import { LOG_KEEP, logDirFor } from "./session-io";

// ---- prompt logging -------------------------------------------------------

/**
 * Write the generated prompt to `<cwd>/.pi/distill/logs/distill-<ts>.txt` and
 * prune old logs, keeping only the most recent LOG_KEEP files.
 */
function logPrompt(prompt: string, modelLabel: string, cwd: string): void {
  try {
    const dir = logDirFor(cwd);
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `distill-${ts}.txt`);
    const header = [
      "# Distill prompt log",
      `time: ${new Date().toISOString()}`,
      `model: ${modelLabel}`,
      "",
    ].join("\n");
    writeFileSync(file, `${header}\n${prompt}\n`);

    // Prune oldest logs beyond the retention limit (lexicographic order of
    // the timestamped names matches chronological order).
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("distill-") && f.endsWith(".txt"))
      .sort();
    for (const old of files.slice(0, Math.max(0, files.length - LOG_KEEP))) {
      try {
        rmSync(join(dir, old));
      } catch {
        // best-effort
      }
    }
  } catch {
    // Logging is best-effort; never fail the distill flow.
  }
}

// ---- types ----------------------------------------------------------------

export interface CompactRange {
  startLabel: string;
  /** Pre-resolved start entry ID (skips label lookup). */
  startId?: string;
  /** Pre-resolved end entry ID (skips label lookup). */
  endId?: string;
  /** Human-readable description of the end point (for error messages). */
  endLabelDesc?: string;
  supplement?: string;
}

export interface DistillConfig {
  autoClean: boolean;
  summaryModel: string;
  contextOn: boolean;
  /** Skip summary generation and simply drop the compressed range. */
  drop: boolean;
}

// ---- range helpers -------------------------------------------------------

/**
 * First entry index that belongs to the compressed range inside the turn
 * containing the range start.
 *
 * Normally the whole turn is included, so a question → answer pair is never
 * split (a label on an assistant reply pulls its leading user message into the
 * range). The exception: when the turn begins with a distilled summary and the
 * range starts at a later entry — an assistant reply that follows a summary
 * belongs to the summary's turn — the summary itself stays out of the range.
 * It marks where older history was compacted and must not be swallowed by the
 * new summary.
 */
function rangeStartIndexInTurn(turn: Turn, effectiveStartId: string): number {
  const first = turn.entries[0];
  const role = (first as { message?: { role?: string } } | undefined)?.message
    ?.role;
  if (
    first &&
    first.type === "message" &&
    role === "compactionSummary" &&
    (first.id as string) !== effectiveStartId
  ) {
    const cut = turn.entries.findIndex(
      (e) => (e.id as string) === effectiveStartId,
    );
    if (cut > 0) return cut;
  }
  return 0;
}

// ---- branch detection -----------------------------------------------------

/**
 * True when `id` has a message descendant that is off the given path.
 * Intermediate non-message entries (labels, custom state, …) are walked
 * through, so a fork is found no matter which node it hangs off.
 */
function hasOffPathMessageDescendant(
  allEntries: Array<Record<string, unknown>>,
  byId: Map<string, Record<string, unknown>>,
  offPathExclude: Set<string>,
  id: string,
): boolean {
  return collectOffPathSubtree(byId, allEntries, offPathExclude, id, false).some(
    (e) => e.type === "message",
  );
}

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

  // A child that continues the main path (root → leaf) past endId is
  // segmentD, not a fork — only off-path message branches count. Walking the
  // whole off-path subtree (rather than direct message children only) keeps
  // this check in agreement with collectBranches().
  for (const id of pathIds) {
    if (hasOffPathMessageDescendant(allEntries, byId, fullPathIds, id)) {
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
 * Find all branches that fork off the main path (fullPath), at ANY point on
 * it — including after the compressed range. The rebuild re-attaches each one
 * at its own fork point, so off-path content is never dropped.
 */
export function collectBranches(
  allEntries: Array<Record<string, unknown>>,
  byId: Map<string, Record<string, unknown>>,
  fullPath: Array<Record<string, unknown>>,
): BranchData[] {
  const fullPathIds = new Set(fullPath.map((e) => e.id as string));
  const result: BranchData[] = [];

  // Collect each fork point's off-path subtree (all entry types — labels,
  // model changes etc. are preserved alongside messages).
  for (const entry of fullPath) {
    const id = entry.id as string;
    const branchEntries = collectOffPathSubtree(
      byId,
      allEntries,
      fullPathIds,
      id,
      false,
    );
    if (branchEntries.length > 0) {
      result.push({ branchPointId: id, entries: branchEntries });
    }
  }
  return result;
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
  const chrono = buildRootPath(byId, endId);

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

/** Thrown when the user cancels summary generation with Esc. */
export class SummaryCancelledError extends Error {
  constructor() {
    super("Summary generation cancelled.");
    this.name = "SummaryCancelledError";
  }
}

// Braille dots: eastAsianWidth() says 1 column, but some terminals/fonts
// render them 2 columns wide. Count them conservatively as 2 so the box
// border never overflows and wraps — a 1-column render just leaves one
// extra space before the right border.
const SPINNER_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/**
 * Visible width of a (possibly styled) string. Braille dot characters are
 * counted as 2 columns to stay safe across terminals (see SPINNER_FRAMES).
 */
function visibleWidth(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    w += cp >= 0x2800 && cp <= 0x28ff ? 2 : 1;
  }
  return w;
}

/**
 * Formal progress dialog shown while the summary is being generated: a top
 * rule with the title, a spinner line, the model in use (dimmed), and a
 * footer hint for the cancel key. No left/right borders — instead every row
 * is padded to the full box width and filled with the panel background, so
 * the layer below is fully covered regardless of row content. Escape
 * (tui.select.cancel, honoring user keybinding config) aborts the
 * generation; a settled generation closes the dialog with "done" (success
 * or failure — the caller re-awaits to see errors).
 */
class DistillProgressDialog implements Component {
  private static readonly BOX_W = 52;
  private settled = false;
  private frame = 0;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private readonly finish: (result: "done" | "cancel") => void;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    generation: Promise<unknown>,
    private readonly modelLabel: string,
    done: (result: "done" | "cancel") => void,
  ) {
    this.finish = (result) => {
      if (this.settled) return;
      this.settled = true;
      if (this.ticker) clearInterval(this.ticker);
      done(result);
    };
    // Close the dialog when the generation settles, success or failure.
    void generation.then(
      () => this.finish("done"),
      () => this.finish("done"),
    );
    this.ticker = setInterval(() => {
      this.frame++;
      this.tui.requestRender();
    }, 100);
  }

  handleInput(data: string): void {
    // Match the same cancel key pi's select dialogs use (Esc by default).
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.finish("cancel");
    }
  }

  render(width: number): string[] {
    const W = Math.min(width, DistillProgressDialog.BOX_W);
    const { theme } = this;
    const border = (s: string) => theme.fg("border", s);
    const dim = (s: string) => theme.fg("dim", s);
    const accent = (s: string) => theme.fg("accent", s);
    // Panel row: right-pad the (possibly styled) line to the full box width,
    // then fill the whole row with the panel background so the layer below
    // never shows through between rows (no side borders to do that job).
    const panel = (styled: string) =>
      theme.bg(
        "selectedBg",
        styled + " ".repeat(Math.max(0, W - visibleWidth(styled))),
      );

    const title = " Compacting context ";
    const top = border(
      `┌─${title}${`─`.repeat(Math.max(0, W - visibleWidth(title) - 4))}─┐`,
    );
    const bottom = border(`└${`─`.repeat(W - 2)}┘`);
    const spin = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
    const key = this.keybindings.getKeys("tui.select.cancel")?.[0] ?? "esc";
    const indent = "  ";

    return [
      panel(top),
      panel(""),
      panel(indent + accent(spin) + ` Generating summary…`),
      panel(""),
      panel(indent + dim(`Model: ${this.modelLabel}`)),
      panel(""),
      panel(indent + dim(`${key} to cancel`)),
      panel(bottom),
    ];
  }

  invalidate(): void {}

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker);
  }
}

/**
 * Run summary generation behind a cancellable overlay. Returns the summary,
 * or throws SummaryCancelledError when the user aborts with Esc. Without a
 * dialog-capable UI (rpc/json mode) the generation runs without cancellation.
 */
async function generateSummaryWithCancel(
  rangeMessages: AnyEntry[],
  backgroundMessages: AnyEntry[],
  supplement: string | undefined,
  contextOn: boolean,
  model: Parameters<typeof complete>[0],
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  env: Record<string, string> | undefined,
  ctx: ExtensionCommandContext,
): Promise<string> {
  const controller = new AbortController();
  const generation = generateSummary(
    rangeMessages,
    backgroundMessages,
    supplement,
    contextOn,
    ctx.cwd,
    model,
    apiKey,
    headers,
    env,
    controller.signal,
  );

  if (!ctx.hasUI) return generation;

  const modelLabel = `${(model as { provider?: string }).provider ?? "?"}/${
    (model as { id?: string }).id ?? "?"
  }`;
  const outcome = await ctx.ui.custom<"done" | "cancel">(
    (tui, theme, keybindings, done) =>
      new DistillProgressDialog(
        tui,
        theme,
        keybindings,
        generation,
        modelLabel,
        done,
      ),
    {
      overlay: true,
      // Overlays are NOT focused by default (pi only setFocus()es non-overlay
      // components) — without this the keys go to the editor and the dialog
      // can never see the Esc press.
      onHandle: (handle) => handle.focus(),
      overlayOptions: {
        width: DistillProgressDialog.BOX_W,
      },
    },
  );

  if (outcome === "cancel") {
    controller.abort();
    // Wait for the request to settle so nothing keeps running in the
    // background after the overlay is gone.
    await generation.catch(() => {});
    throw new SummaryCancelledError();
  }
  return generation;
}

async function generateSummary(
  rangeMessages: AnyEntry[],
  backgroundMessages: AnyEntry[],
  supplement: string | undefined,
  contextOn: boolean,
  cwd: string,
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

  // Log the exact prompt sent to the LLM for debugging (project-local dir).
  const modelLabel = `${(model as { provider?: string }).provider ?? "?"}/${(model as { id?: string }).id ?? "?"}`;
  logPrompt(prompt, modelLabel, cwd);

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
  /** Branches that fork off the main path (any point on it). */
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
 * Build a whole-tree rebuild plan: every entry in DFS order, plus the parent
 * each entry must be re-attached under. The compressed range is replaced by a
 * summary slot (insertSummary) — or removed entirely (delete mode) — and the
 * range's descendants are re-attached under the range's parent.
 *
 * Pass-through entries (labels, pi-native compaction / branch_summary) cannot
 * be copied because they reference old entry IDs; they are dropped and their
 * children are re-attached under the same parent, so a tag sitting between
 * messages never orphans the conversation that follows it.
 */
export function buildRebuildPlan(
  allEntries: Array<Record<string, unknown>>,
  rangeIds: Set<string>,
  insertSummary: boolean,
): PlanEntry[] {
  const childrenOf = new Map<string | null, Array<Record<string, unknown>>>();
  for (const e of allEntries) {
    const pid = (e.parentId as string | null) ?? null;
    const list = childrenOf.get(pid);
    if (list) list.push(e);
    else childrenOf.set(pid, [e]);
  }

  const plan: PlanEntry[] = [];
  const SUMMARY_ANCHOR = "__summary__";
  let inserted = false;
  const walk = (entry: Record<string, unknown>, effParent: string | null) => {
    if (rangeIds.has(entry.id as string)) {
      if (insertSummary && !inserted) {
        inserted = true;
        plan.push({
          entry: {
            type: "message",
            id: SUMMARY_ANCHOR,
            parentId: null,
            message: {},
          } as unknown as AnyEntry,
          parentId: effParent,
          insertSummary: true,
        });
      }
      for (const c of childrenOf.get(entry.id as string) ?? []) {
        if (PASSTHROUGH_TYPES.has(c.type as string)) {
          // A label targeting a compressed node is dropped with it, but its
          // children (continuation messages) survive under the summary.
          for (const g of childrenOf.get(c.id as string) ?? []) {
            walk(g, insertSummary ? SUMMARY_ANCHOR : effParent);
          }
          continue;
        }
        walk(c, insertSummary ? SUMMARY_ANCHOR : effParent);
      }
      return;
    }
    if (PASSTHROUGH_TYPES.has(entry.type as string)) {
      for (const c of childrenOf.get(entry.id as string) ?? []) {
        walk(c, effParent);
      }
      return;
    }
    plan.push({ entry: entry as AnyEntry, parentId: effParent });
    for (const c of childrenOf.get(entry.id as string) ?? []) {
      walk(c, entry.id as string);
    }
  };
  for (const root of childrenOf.get(null) ?? []) {
    if (root.type === "session") continue;
    walk(root, null);
  }
  return plan;
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
  const allEntries = sm.getEntries() as unknown as Array<
    Record<string, unknown>
  >;

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

  // Resolve end: pre-resolved ID, or current leaf
  let endId: string;
  let endLabelDesc: string;
  if (range.endId) {
    endId = range.endId;
    endLabelDesc = range.endLabelDesc ?? "current position";
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
  const fullPath = buildRootPath(byId, leafId);
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
    const branchPath = buildRootPath(byId, endId);
    effectiveStartId = snapToMessageOn(branchPath, startId, "forward");
    effectiveEndId = snapToMessageOn(branchPath, endId, "backward");

    const turns = groupPathIntoTurns(
      branchPath as unknown as AnyEntry[],
    );
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

    // Same summary-boundary rule as the main path: a range starting inside a
    // distilled-summary turn keeps the summary out of the range.
    const branchStartTurn = turns[fullStartTurn];
    const branchStartIdx = rangeStartIndexInTurn(
      branchStartTurn,
      effectiveStartId,
    );
    const rangeEntries: AnyEntry[] = [
      ...branchStartTurn.entries.slice(branchStartIdx),
      ...turns
        .slice(fullStartTurn + 1, fullEndTurn + 1)
        .flatMap((t) => t.entries),
    ];
    const bcIds = new Set(
      rangeEntries.map((e) => e.id as string),
    );
    segmentBC = rangeEntries.filter((e) => e.type === "message");
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

    // Branch check — any off-path message descendant of a range node (other
    // than the continuation chain) is a real fork; reject (same as main path).
    const continuationExclude = new Set([...bcIds, ...continuationIds]);
    for (const id of bcIds) {
      if (
        hasOffPathMessageDescendant(
          allEntries,
          byId,
          continuationExclude,
          id,
        )
      ) {
        throw new Error(
          "Branch detected in range — not supported yet. Distill before/after the branch point separately.",
        );
      }
    }

    // Whole-tree rebuild plan: every entry in DFS order, the range replaced
    // by a fresh summary at the range start, the range's descendants
    // re-attached under it. Labels / pi-native compaction entries inside the
    // range act as pass-through nodes: dropped with the range, but their
    // children (continuation messages) survive under the summary.
    plan = buildRebuildPlan(allEntries, bcIds, true);
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
    const turns = groupPathIntoTurns(fullPath as unknown as AnyEntry[]);

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

    // Keep a distilled-summary turn boundary out of the range (see
    // rangeStartIndexInTurn): the summary goes to segmentA, the range starts
    // at the requested entry.
    const startTurn = turns[fullStartTurn];
    const startIdx = rangeStartIndexInTurn(startTurn, effectiveStartId);
    if (startIdx > 0) {
      segmentA.push(...startTurn.entries.slice(0, startIdx));
    }

    // Include messages AND previously distilled summaries, so a second
    // distill never drops the first one's content. (Distilled summaries are
    // stored as compactionSummary messages, so plain message entries cover
    // both.)
    for (const e of startTurn.entries.slice(startIdx)) {
      if (e.type === "message") {
        segmentBC.push(e);
      }
    }
    for (let i = fullStartTurn + 1; i <= fullEndTurn; i++) {
      for (const e of turns[i].entries) {
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
    branches = collectBranches(allEntries, byId, fullPath);

    // Guard: a message-bearing branch whose fork point sits inside the
    // compressed range cannot be re-attached (its anchor is replaced by the
    // summary), so it must be rejected — never silently dropped. Detection
    // above is expected to catch this first; this guard keeps any future gap
    // from losing conversation data.
    //
    // Metadata-only forks (custom entries, labels) are deliberately ignored:
    // they carry no LLM context and are dropped together with the rest of the
    // in-range metadata, exactly like in-range custom entries on the path.
    const rangeEntryIds = new Set(
      [
        ...startTurn.entries.slice(startIdx),
        ...turns
          .slice(fullStartTurn + 1, fullEndTurn + 1)
          .flatMap((t) => t.entries),
      ].map((e) => e.id as string),
    );
    for (const b of branches) {
      const carriesMessages = b.entries.some((e) => e.type === "message");
      if (carriesMessages && rangeEntryIds.has(b.branchPointId)) {
        throw new Error(
          "Branch detected in range — not supported yet. Distill before/after the branch point separately.",
        );
      }
    }
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
  const authError = (auth as { error?: string }).error;
  if (!auth.ok) throw new Error(`Model auth failed: ${authError ?? "unknown error"}`);
  // Header-only auth (e.g. compatibility headers without an API key) is fine:
  // complete() accepts an undefined apiKey when the headers carry the auth.

  // Generate summary
  // Generate summary (cancellable with Esc via an overlay)
  const summary = await generateSummaryWithCancel(
    segmentBC,
    backgroundMessages,
    range.supplement,
    config.contextOn,
    model,
    auth.apiKey,
    auth.headers,
    auth.env,
    ctx,
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
