/**
 * /distill command handler — parses arguments, runs the compact engine,
 * confirms with user, and rebuilds the session.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
  executeCompact,
  SummaryCancelledError,
  type PlanEntry,
} from "../engine/compact";
import { buildRebuildPlan } from "../engine/compact";
import type { DistillConfig } from "../engine/compact";
import {
  groupPathIntoTurns,
  PASSTHROUGH_TYPES,
  resolveAllLabels,
} from "../engine/turn-group";
import type { AnyEntry } from "../engine/turn-group";
import { deleteSession, setParentSession } from "../engine/session-io";

// ---- config I/O -----------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = join(__dirname, "../../config.json");

function loadConfig(): DistillConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch {
    // fall through to defaults
  }
  return { autoClean: false, summaryModel: "inherit", contextOn: false, drop: false };
}

function saveConfig(config: DistillConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

// ---- summary confirm ------------------------------------------------------

async function showSummaryAndConfirm(
  summary: string,
  ctx: ExtensionCommandContext,
): Promise<string> {
  if (!ctx.hasUI) return summary;

  const result = await ctx.ui.editor(
    "Review / Edit Summary",
    summary,
  );

  if (result === undefined) {
    throw new Error("Distill cancelled.");
  }

  return result;
}

// ---- session rebuild helpers ---------------------------------------------

/**
 * Copy a single session entry into the new session, preserving its type.
 * Returns the new entry ID (or undefined for skipped entry types).
 */
export function appendEntry(
  sm: { [k: string]: any },
  entry: Record<string, unknown>,
): string | undefined {
  switch (entry.type) {
    case "message":
      return sm.appendMessage((entry as { message: unknown }).message);
    case "model_change": {
      const e = entry as { provider: string; modelId: string };
      return sm.appendModelChange(e.provider, e.modelId);
    }
    case "thinking_level_change": {
      const e = entry as { thinkingLevel: string };
      return sm.appendThinkingLevelChange(e.thinkingLevel);
    }
    case "custom": {
      const e = entry as { customType: string; data: unknown };
      return sm.appendCustomEntry(e.customType, e.data);
    }
    case "custom_message": {
      const e = entry as {
        customType: string;
        content: unknown;
        display: boolean;
        details: unknown;
      };
      return sm.appendCustomMessageEntry(
        e.customType,
        e.content,
        e.display,
        e.details,
      );
    }
    case "session_info": {
      const e = entry as { name?: string };
      // Older session formats may omit the name; an empty name is fine and
      // simply means "no title".
      return sm.appendSessionInfo(e.name ?? "");
    }
    // label / compaction / branch_summary reference old entry IDs and are
    // skipped; they don't participate in LLM context.
    default:
      return undefined;
  }
}

/**
 * Rebuild a session from a whole-tree plan (side-branch distill / delete).
 *
 * With `summaryContent`, the plan's summary slot is materialized as a fresh
 * compactionSummary message and the range's descendants are re-attached
 * under it (distill). With `summaryContent === undefined` (delete mode) the
 * slot is skipped, but its parent is remembered so the range's descendants —
 * which the plan re-attaches under the slot — survive under the range's
 * parent instead of being dropped.
 */
export function rebuildPlanEntries(
  sm: { [k: string]: any },
  plan: PlanEntry[],
  summaryContent: string | undefined,
  tokensBefore: number,
  /**
   * Restore the leaf to this entry's new position after the rebuild. The
   * plan is replayed in DFS (file) order, so without this the leaf ends up
   * at the last copied entry — which is NOT necessarily the user's position
   * (branches that come later in file order would swallow it).
   */
  targetLeafId?: string,
): void {
  const idMap = new Map<string, string | null>();
  let summaryNewId: string | undefined;
  let summaryParentNewId: string | null | undefined;
  let targetNewId: string | null | undefined;

  for (const { entry, parentId, insertSummary } of plan) {
    if (insertSummary) {
      if (summaryContent === undefined) {
        // Delete mode: no summary is inserted. Remember where the slot sits
        // so entries re-attached under it (parentId === "__summary__") land
        // under the range's parent.
        summaryParentNewId = parentId ? idMap.get(parentId) ?? null : null;
        continue;
      }
      const parentNewId = parentId ? idMap.get(parentId) ?? null : null;
      if (parentId && !parentNewId) continue;
      if (parentNewId) sm.branch(parentNewId);
      summaryNewId = sm.appendMessage({
        role: "compactionSummary",
        summary: summaryContent,
        tokensBefore,
        timestamp: Date.now(),
      });
      idMap.set(entry.id as string, summaryNewId);
      continue;
    }

    const effParent =
      parentId === "__summary__"
        ? (summaryNewId ?? summaryParentNewId ?? null)
        : parentId
          ? (idMap.get(parentId) ?? null)
          : null;
    if (parentId && !effParent) continue;
    if (effParent) sm.branch(effParent);
    const newId = appendEntry(sm, entry);
    if (newId) {
      idMap.set(entry.id as string, newId);
      if ((entry.id as string) === targetLeafId) targetNewId = newId;
    } else if (effParent) {
      idMap.set(entry.id as string, effParent);
    }
  }

  // Jump the leaf back to the user's position. If the original leaf was
  // inside the removed/compressed range it has no mapping and the leaf stays
  // where the rebuild left it.
  if (targetNewId) sm.branch(targetNewId);
}

// ---- distill bookkeeping helpers -----------------------------------------

/** Format a human-readable timestamp like "08-13 14:30". */
function formatDistillTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Open the old session and append a session_info entry marking it as
 * distilled. The "[distilled <time>]" prefix distinguishes it from the
 * current (unprefixed) session in the /resume list. Best-effort: failures
 * are swallowed so they never abort the distill flow.
 */
function markDistilledTitle(
  sessionFile: string,
  oldTitle: string | undefined,
): void {
  try {
    const mgr = SessionManager.open(sessionFile);
    const base = (oldTitle ?? "").trim();
    const prefix = `[distilled ${formatDistillTime(new Date())}]`;
    const name = base ? `${prefix} ${base}` : prefix;
    mgr.appendSessionInfo(name);
  } catch {
    // Non-fatal: title marking is best-effort.
  }
}

/**
 * Flatten every distilled session (title prefixed "[distilled ") to be a
 * direct child of `newRoot`. This keeps all distill levels flat siblings
 * under the newest root regardless of any prior fork relationships, so a
 * fork followed by a distill never strands the old root.
 */
async function flattenDistilledSessions(
  newRoot: string,
  cwd: string,
  sessionDir: string | undefined,
): Promise<void> {
  try {
    const sessions = await SessionManager.list(cwd, sessionDir);
    for (const s of sessions) {
      if (s.name?.startsWith("[distilled ")) {
        setParentSession(s.path, newRoot);
      }
    }
  } catch {
    // Non-fatal: tree shaping is best-effort.
  }
}

/**
 * Fork a distilled session into a new active session and switch to it.
 * forkFrom points the new session's parentSession at the source (normal
 * branch direction), so the fork appears as a child of the distilled session
 * in the threaded view — the source session stays untouched.
 */
async function resumeDistilledSession(
  sessionPath: string,
  ctx: ExtensionCommandContext,
  message?: string,
): Promise<void> {
  try {
    const sessionDir = ctx.sessionManager.getSessionDir();
    const newSm = SessionManager.forkFrom(sessionPath, ctx.cwd, sessionDir);

    // The fork inherits the source session's "[distilled ...]" title. Clear
    // it with an EMPTY title so the new session shows its own first message
    // instead of inheriting the source title. (An empty title also keeps the
    // switch interceptor from misjudging the fork as distilled.)
    newSm.appendSessionInfo("");

    // Remember this fork so its first NEW user message becomes its title.
    pendingForkSession = newSm.getSessionFile();

    const newPath = newSm.getSessionFile();
    await ctx.switchSession(newPath, {
      withSession: async (freshCtx) => {
        if (message) {
          await freshCtx.sendUserMessage(message);
        }
        freshCtx.ui.notify("Forked from distilled session", "info");
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Fork failed: ${message}`, "error");
  }
}

/**
 * Check whether a session file is a distilled session, by opening it and
 * looking for a "[distilled " title prefix.
 */
function isDistilledSession(sessionFile: string): boolean {
  try {
    const mgr = SessionManager.open(sessionFile);
    const name = mgr.getSessionName() ?? "";
    return name.startsWith("[distilled ");
  } catch {
    return false;
  }
}

/** Delete the range as a new session, marking the old one as distilled. */
async function deleteAsNewSession(
  result: Awaited<ReturnType<typeof executeCompact>> & {
    /** Whole-tree rebuild plan (point delete of a turn anywhere in the tree). */
    plan?: PlanEntry[];
  },
  ctx: ExtensionCommandContext,
  config: DistillConfig,
  markOld: boolean,
): Promise<void> {
  const oldSessionFile = ctx.sessionManager.getSessionFile();
  const oldTitle = ctx.sessionManager.getSessionName();
  const oldLeafId = ctx.sessionManager.getLeafId();
  const sessionDir = ctx.sessionManager.getSessionDir();
  const cwd = ctx.cwd;

  // In-place rebuild keeps the old session's tree position: read its parent
  // so the fresh session lands where the old one was.
  let oldParentSession: string | undefined;
  try {
    oldParentSession = SessionManager.open(
      oldSessionFile,
    ).getHeader()?.parentSession;
  } catch {
    // Non-fatal: fall back to a root session.
  }

  await ctx.newSession({
    // Keep the old session's position unless the old session is kept and
    // re-parented under the new one (new-session mode).
    parentSession: markOld ? undefined : oldParentSession,
    setup: async (sm) => {
      const idMap = new Map<string, string>();
      let anchorNewId: string | undefined;

      // Whole-tree rebuild: copy every entry in DFS order except the deleted
      // turn; each entry is appended under its (remapped) parent. The deleted
      // turn's children already point at the deleted turn's parent.
      if (result.plan) {
        // Range-delete (drop) carries the plan's summary slot for topology;
        // no summary is inserted and the range's descendants are re-attached
        // under the slot's parent (rebuildPlanEntries with undefined content).
        // Deleting another branch must not move the user's position: restore
        // the leaf to its remapped entry.
        rebuildPlanEntries(sm, result.plan, undefined, 0, oldLeafId ?? undefined);
        return;
      }

      for (const entry of result.segmentA) {
        const newId = appendEntry(sm, entry);
        if (newId) {
          idMap.set(entry.id as string, newId);
          anchorNewId = newId;
        } else if (anchorNewId) {
          // Pass-through entry (label / compaction / branch_summary): not
          // copied, but branches forking off it attach under the anchor.
          idMap.set(entry.id as string, anchorNewId);
        }
      }

      for (const branch of result.branches) {
        const parentNewId = idMap.get(branch.branchPointId);
        if (!parentNewId) continue;
        sm.branch(parentNewId);
        for (const entry of branch.entries) {
          appendEntry(sm, entry);
        }
      }

      if (anchorNewId) sm.branch(anchorNewId);

      for (const entry of result.segmentD) {
        appendEntry(sm, entry);
      }
    },
    withSession: async (freshCtx) => {
      const newSessionFile = freshCtx.sessionManager.getSessionFile();
      if (oldSessionFile && newSessionFile) {
        if (markOld) {
          // New session: keep the old one, marked [distilled] (or auto-clean).
          if (config.autoClean) {
            deleteSession(oldSessionFile);
          } else {
            await flattenDistilledSessions(newSessionFile, cwd, sessionDir);
            setParentSession(oldSessionFile, newSessionFile);
            markDistilledTitle(oldSessionFile, oldTitle);
          }
        } else {
          // In place: rebuild into a fresh session and remove the old file so
          // no leftover copy appears in the tree — "no trace". Re-parent the
          // old session's children under the fresh one to keep the tree
          // connected.
          deleteSession(oldSessionFile);
          try {
            const sessions = await SessionManager.list(cwd, sessionDir);
            for (const s of sessions) {
              if (s.path === oldSessionFile) continue;
              if (s.parentSessionPath === oldSessionFile) {
                setParentSession(s.path, newSessionFile);
              }
            }
          } catch {
            // Non-fatal: orphaned children fall back to roots.
          }
        }
      }
      freshCtx.ui.notify(
        markOld ? "Deleted (new session)" : "Deleted in place",
        "info",
      );
    },
  });
}

// ---- label disambiguation ------------------------------------------------

/** Extract plain text from a message content (string or content blocks). */
function textFromMessage(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Build a short human-readable description of where a label sits, e.g.
 * `user: "说234"`. Prefers the tagged node itself when it is a message;
 * otherwise falls back to the next user message after it on the current
 * path. Used to disambiguate duplicate labels in pickers.
 */
function describeTagPosition(
  targetId: string,
  ctx: ExtensionCommandContext,
): string {
  try {
    const allEntries = ctx.sessionManager.getEntries() as unknown as Array<
      Record<string, unknown>
    >;
    const byId = new Map(allEntries.map((e) => [e.id as string, e]));

    // The tagged node itself — most informative when it is a message.
    // Shown in parentheses as the first line of its content, truncated.
    const node = byId.get(targetId);
    if (node && node.type === "message") {
      const role = (node as { message?: { role?: string } }).message?.role;
      const text = textFromMessage(
        (node as { message: { content: unknown } }).message?.content,
      )
        .split("\n")[0]
        .trim();
      if (text) return `(${role ?? "msg"}: ${truncate(text, 30)})`;
      return `(${role ?? "msg"})`;
    }

    // Non-message target: locate it on the root → leaf path and show the
    // next user message at/after it.
    const leafId = ctx.sessionManager.getLeafId();
    if (!leafId) return "";
    const path: Array<Record<string, unknown>> = [];
    let cur = byId.get(leafId);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id as string)) {
      seen.add(cur.id as string);
      path.unshift(cur);
      const pid = cur.parentId as string | null;
      if (!pid) break;
      cur = byId.get(pid);
    }

    const idx = path.findIndex((e) => e.id === targetId);
    if (idx === -1) return "(off current path)";
    for (let i = idx; i < path.length; i++) {
      const e = path[i];
      if (e.type === "message") {
        const role = (e as { message?: { role?: string } }).message?.role;
        if (role === "user") {
          const text = textFromMessage(
            (e as { message: { content: unknown } }).message.content,
          )
            .split("\n")[0]
            .trim();
          if (text) return `(after \"${truncate(text, 30)}\")`;
        }
      }
    }
    return "(end of path)";
  } catch {
    return "";
  }
}

/**
 * Pick one candidate when a label appears multiple times. Returns the chosen
 * targetId, or null if the user cancels.
 */
async function pickLabelCandidate(
  candidates: string[],
  labelName: string,
  role: string,
  ctx: ExtensionCommandContext,
): Promise<string | null> {
  if (candidates.length === 1) return candidates[0];
  // Dim grey hint with the tagged message's first line, matching the
  // two-candidate picker style: plain index + grey description.
  const options = candidates.map(
    (id, i) =>
      `#${i + 1} ${ctx.ui.theme.fg("dim", describeTagPosition(id, ctx))}`.trim(),
  );
  const chosen = await ctx.ui.select(
    `Label "${labelName}" appears ${candidates.length} times — pick the ${role} tag`,
    options,
  );
  if (chosen === undefined) return null;
  const idx = options.indexOf(chosen);
  return candidates[idx] ?? null;
}

/**
 * Resolve a label to concrete entry IDs, prompting the user when it appears
 * multiple times in the tree. Only the single-label form exists — a pair is
 * expressed by tagging both spots with the same name.
 *
 *   1 match   → tag → current position
 *   2 matches → ask: between the two / up to the first / up to the last
 *   >2 matches→ ask which tag to compress up to
 *
 * Returns null when the user cancels.
 */
async function resolveRange(
  args: { startLabel: string },
  ctx: ExtensionCommandContext,
): Promise<{ startId: string; endId: string; pair: boolean } | null> {
  const allEntries = ctx.sessionManager.getEntries() as unknown as Array<
    Record<string, unknown>
  >;
  const startCandidates = resolveAllLabels(
    ctx.sessionManager,
    allEntries,
    args.startLabel,
  );
  if (startCandidates.length === 0) {
    throw new Error(
      `Label "${args.startLabel}" not found. Create one via /tree → shift+L first.`,
    );
  }

  const leafId = ctx.sessionManager.getLeafId();
  if (!leafId) throw new Error("Cannot determine current leaf node.");

  // Single-label form.
  if (startCandidates.length === 1) {
    return { startId: startCandidates[0], endId: leafId, pair: false };
  }

  if (startCandidates.length === 2) {
    const [first, last] = startCandidates;
    // Grey hint with the first line of each tag's message, so "first" and
    // "last" are unambiguous.
    const hint = (id: string) =>
      ctx.ui.theme.fg("dim", describeTagPosition(id, ctx));
    const options = [
      "Between the two tags",
      `Up to the first tag ${hint(first)}`.trimEnd(),
      `Up to the last tag ${hint(last)}`.trimEnd(),
    ];
    const choice = await ctx.ui.select(
      `Label "${args.startLabel}" appears twice — compress what?`,
      options,
    );
    if (choice === undefined) return null;
    const idx = options.indexOf(choice);
    if (idx === 0) return { startId: first, endId: last, pair: true };
    if (idx === 1) return { startId: first, endId: leafId, pair: false };
    return { startId: last, endId: leafId, pair: false };
  }

  // More than two matches: pick which tag to compress up to.
  const startId = await pickLabelCandidate(
    startCandidates,
    args.startLabel,
    "start",
    ctx,
  );
  if (!startId) return null;
  return { startId, endId: leafId, pair: false };
}

/** Rough token estimate for a range of entries (chars / 4). */
function estimateTokens(entries: Array<Record<string, unknown>>): number {
  let chars = 0;
  for (const e of entries) {
    if (e.type !== "message") continue;
    const content = (e as { message?: { content?: unknown } }).message?.content;
    if (typeof content === "string") {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (
          b &&
          typeof b === "object" &&
          (b as { type?: string }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string"
        ) {
          chars += (b as { text: string }).text.length;
        }
      }
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Delete a single distilled summary (a standalone compactionSummary message)
 * by rebuilding the session without it. Follows turn semantics: the summary
 * is its own turn, so deleting it deletes exactly that turn — question →
 * answer pairs around it stay intact.
 *
 * If the deleted summary is a fork point, its off-path branches are
 * re-attached to the last kept entry so they survive the deletion. Branch
 * promotion is impossible for the first turn, so that case is rejected.
 */
async function deleteSingleEntry(
  targetId: string,
  ctx: ExtensionCommandContext,
  config: DistillConfig,
  markOld: boolean,
): Promise<void> {
  const sm = ctx.sessionManager;
  const allEntries = sm.getEntries() as unknown as Array<
    Record<string, unknown>
  >;
  const byId = new Map(allEntries.map((e) => [e.id as string, e]));

  // Path root → target (following parentId chain). No restriction to the
  // current path: a point delete removes exactly the tagged turn wherever it
  // sits in the tree — it never spans branches, so branch topology needs no
  // probing.
  const targetPath: Array<Record<string, unknown>> = [];
  let cur = byId.get(targetId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id as string)) {
    seen.add(cur.id as string);
    targetPath.unshift(cur);
    const pid = cur.parentId as string | null;
    if (!pid) break;
    cur = byId.get(pid);
  }
  const target = targetPath[targetPath.length - 1];
  if (!target || (target.id as string) !== targetId) {
    throw new Error("Target entry not found.");
  }

  // Turn logic: the deleted unit is the turn containing the tag. A distilled
  // summary is its own turn, so this removes exactly the summary; a
  // user/assistant message removes its whole question → answer turn.
  const turns = groupPathIntoTurns(targetPath as unknown as AnyEntry[]);
  const turnIdx = turns.findIndex((t) =>
    t.entries.some((e) => e.id === targetId),
  );
  if (turnIdx === -1) {
    throw new Error("Target entry not found.");
  }
  if (turnIdx === 0) {
    throw new Error(
      "Cannot delete the first turn alone — use range delete instead.",
    );
  }
  const targetTurn = turns[turnIdx];

  // Whole-tree rebuild plan: copy every entry in DFS order except the deleted
  // turn; the deleted turn's descendants are re-attached to the turn's parent.
  // All other branches keep their original topology. Labels / pi-native
  // compaction entries act as pass-through nodes: dropped, but their children
  // survive under the same parent.
  const childrenOf = new Map<string | null, Array<Record<string, unknown>>>();
  for (const e of allEntries) {
    const pid = (e.parentId as string | null) ?? null;
    const list = childrenOf.get(pid);
    if (list) list.push(e);
    else childrenOf.set(pid, [e]);
  }

  // The turn on the parent chain ends at the tagged node, but the reply chain
  // hanging off it (assistant/tool/label nodes) is part of the same turn and
  // must go too. A user (or compactionSummary) child starts a new turn and is
  // preserved — it gets re-attached to the deleted turn's parent.
  const skipIds = new Set(targetTurn.entries.map((e) => e.id as string));
  const pending: Array<Record<string, unknown>> = [...targetTurn.entries];
  while (pending.length > 0) {
    const e = pending.pop()!;
    for (const child of childrenOf.get(e.id as string) ?? []) {
      const role = (child as { message?: { role?: string } }).message?.role;
      const isTurnStart =
        child.type === "message" &&
        (role === "user" || role === "compactionSummary");
      if (!isTurnStart && !skipIds.has(child.id as string)) {
        skipIds.add(child.id as string);
        pending.push(child);
      }
    }
  }
  const plan: PlanEntry[] = buildRebuildPlan(allEntries, skipIds, false);
  if (plan.length === 0) {
    throw new Error("Nothing to rebuild.");
  }

  await deleteAsNewSession(
    {
      summary: "",
      segmentA: [],
      segmentBC: targetTurn.entries.filter((e) => e.type === "message"),
      segmentD: [],
      turnCount: 1,
      branches: [],
      plan,
    },
    ctx,
    config,
    markOld,
  );
}

/**
 * Handle `/distill del <label>`: delete the range without summarizing.
 * Presents three choices: new session (mark old distilled), delete in place
 * (rebuild without marking), or cancel. Both delete paths rebuild the session
 * without copying the removed range — mirroring distill, just without a summary.
 *
 * When the label points to a standalone non-message entry (e.g. a distilled
 * summary), an extra "delete this entry only" option is offered — a single
 * user/assistant message is never deletable alone because it would break the
 * dialogue flow.
 */
async function handleDelete(
  label: string,
  ctx: ExtensionCommandContext,
  config: DistillConfig,
): Promise<void> {
  try {
    // Resolve the label first — duplicate tags prompt the user to disambiguate.
    const range = await resolveRange({ startLabel: label }, ctx);
    if (!range) return; // user cancelled

    // Step 1 — deletion granularity (single-label ranges only). When the
    // range is "between two tags" there is no granularity choice: everything
    // between the tags is deleted. For a single tag, the tagged entry's own
    // turn can be deleted alone ("This turn only"), or everything from the
    // label up to the current position can be deleted. Both follow turn
    // semantics: a distilled summary is its own turn, so deleting it deletes
    // exactly the summary; a user/assistant message deletes its whole
    // question → answer turn.
    let single = false;
    if (!range.pair) {
      // Only reached when exactly one tag with this name exists (a single
      // occurrence resolves straight to "tag → current position").
      const how = await ctx.ui.select(
        `Label "${label}" occurs once — delete how?`,
        ["This turn only", "Label to current position", "Cancel"],
      );
      if (how === undefined || how === "Cancel") return;
      single = how === "This turn only";
    }

    // Step 2 — old session handling (both granularities share this).
    const markChoice = await ctx.ui.select("Delete method", [
      "New session (keep old as distilled)",
      "In place (no trace)",
      "Cancel",
    ]);
    if (markChoice === undefined || markChoice === "Cancel") return;
    const markOld = markChoice === "New session (keep old as distilled)";

    if (single) {
      await deleteSingleEntry(range.startId, ctx, config, markOld);
      return;
    }

    // Range deletion: rebuild via newSession; the only difference between
    // the two options is whether the old session is marked as distilled.
    const result = await executeCompact(
      {
        startLabel: label,
        startId: range.startId,
        endId: range.endId,
      },
      { ...config, drop: true },
      ctx,
    );
    await deleteAsNewSession(result, ctx, config, markOld);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Delete failed: ${message}`, "error");
  }
}

/**
 * Collect a node's non-main-path subtree, flattened in pre-order (the node
 * itself included when includeRoot is set). Pass-through entries (labels,
 * pi-native compaction) are included — the rebuild drops them while keeping
 * their children attached under the same parent.
 */
export function collectOffPathSubtree(
  byId: Map<string, Record<string, unknown>>,
  allEntries: Array<Record<string, unknown>>,
  mainPathIds: Set<string>,
  rootId: string,
  includeRoot: boolean,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  const walk = (id: string, first: boolean) => {
    const node = byId.get(id);
    if (!node) return;
    if (!first || includeRoot) result.push(node);
    for (const child of allEntries.filter(
      (e) =>
        (e.parentId as string | null) === id &&
        !mainPathIds.has(e.id as string),
    )) {
      walk(child.id as string, false);
    }
  };
  walk(rootId, true);
  return result;
}

/**
 * Compute the shared merge segments for a fork point `parentId` on the main
 * path, where the branch node `mergedId` is replaced by / merged into a
 * summary under the parent.
 *
 * Returns: root → parent (segmentA), the main-path continuation after the
 * parent (minus the branch itself), the parent's other side branches, and
 * off-path subtrees forking off segment-A / continuation entries (preserved
 * so a merge never drops side branches).
 */
export function computeMergeSegments(
  allEntries: Array<Record<string, unknown>>,
  byId: Map<string, Record<string, unknown>>,
  mainPath: Array<Record<string, unknown>>,
  parentId: string,
  mergedId: string,
): {
  segmentA: Array<Record<string, unknown>>;
  mainAfterParent: Array<Record<string, unknown>>;
  sideRoots: Array<Record<string, unknown>>;
  offPathSubtrees: Map<string, Array<Record<string, unknown>>>;
} {
  const mainPathIds = new Set(mainPath.map((e) => e.id as string));
  const pIdx = mainPath.findIndex((e) => (e.id as string) === parentId);
  if (pIdx === -1) {
    throw new Error("Parent node is not on the current path.");
  }

  // The merged branch's own chain (mergedId up to parentId, including any
  // pass-through entries in between) is not a "side branch".
  const branchChain = new Set<string>();
  let anc: string | undefined = mergedId;
  while (anc && anc !== parentId) {
    branchChain.add(anc);
    anc = (byId.get(anc)?.parentId as string | null) ?? undefined;
  }

  const segmentA = mainPath.slice(0, pIdx + 1); // root → parent (inclusive)
  // The main-path continuation after the parent, minus the branch itself
  // (it is merged below). Entries between the parent and the branch (e.g.
  // labels) are kept — slicing from pIdx+2 would duplicate the branch
  // whenever it is not the parent's direct child.
  const mainAfterParent = mainPath
    .slice(pIdx + 1)
    .filter((e) => (e.id as string) !== mergedId);
  const sideRoots = allEntries.filter(
    (e) =>
      (e.parentId as string | null) === parentId &&
      !branchChain.has(e.id as string) &&
      !mainPathIds.has(e.id as string),
  );

  // Off-path subtrees forking off segment-A entries (except the parent,
  // whose side branches are `sideRoots`) and off the main-path continuation
  // — preserved in the rebuild.
  const mainAll = [...segmentA, ...mainAfterParent];
  const mainAllIds = new Set(mainAll.map((e) => e.id as string));
  const offPathSubtrees = new Map<string, Array<Record<string, unknown>>>();
  for (const e of mainAll) {
    const kids = allEntries.filter(
      (c) =>
        (c.parentId as string | null) === e.id &&
        !mainAllIds.has(c.id as string),
    );
    if (kids.length === 0) continue;
    const sub: Array<Record<string, unknown>> = [];
    const walkSub = (id: string) => {
      for (const c of allEntries.filter(
        (x) => (x.parentId as string | null) === id,
      )) {
        sub.push(c);
        walkSub(c.id as string);
      }
    };
    for (const k of kids) {
      sub.push(k);
      walkSub(k.id as string);
    }
    offPathSubtrees.set(e.id as string, sub);
  }

  return { segmentA, mainAfterParent, sideRoots, offPathSubtrees };
}

/**
 * Rebuild a session with the merge topology: root → parent, then a merged
 * node (the summary) under the parent with optional pre-attached entries,
 * and the parent's other side branches plus the main-path continuation
 * re-attached under the merged node.
 *
 * Returns the new id of the merged node.
 */
export function rebuildMerged(
  sm: SessionManager,
  opts: {
    segmentA: Array<Record<string, unknown>>;
    mainAfterParent: Array<Record<string, unknown>>;
    sideSubtrees: Array<Array<Record<string, unknown>>>;
    offPathSubtrees: Map<string, Array<Record<string, unknown>>>;
    parentId: string;
    /** Entries appended directly under the merged node, in order. */
    underMerged: Array<Record<string, unknown>>;
    /** Append the merged node (the summary); returns its new id. */
    appendMerged: (
      sm: SessionManager,
      parentNewId: string | undefined,
    ) => string | undefined;
  },
): string | undefined {
  const { segmentA, mainAfterParent, offPathSubtrees, parentId } = opts;
  const idMap = new Map<string, string>();
  let lastNewId: string | undefined;

  const appendChain = (entries: Array<Record<string, unknown>>) => {
    for (const entry of entries) {
      const newId = appendEntry(sm, entry);
      if (newId) {
        idMap.set(entry.id as string, newId);
        lastNewId = newId;
      } else if (lastNewId) {
        // Pass-through (label / compaction / branch_summary): not copied,
        // but children attach under the current tail.
        idMap.set(entry.id as string, lastNewId);
      }
    }
  };

  // root → parent, preserving off-path subtrees of segment-A entries (the
  // parent's own side branches are re-attached under the merged node).
  appendChain(segmentA);
  for (const e of segmentA) {
    if ((e.id as string) === parentId) continue;
    const sub = offPathSubtrees.get(e.id as string);
    if (!sub) continue;
    const parentNewId = idMap.get(e.id as string);
    if (!parentNewId) continue;
    sm.branch(parentNewId);
    appendChain(sub);
  }

  const parentNewId = idMap.get(parentId);
  if (parentNewId) sm.branch(parentNewId);
  const mergedNewId = opts.appendMerged(sm, parentNewId);

  // Entries that sit directly under the merged node (its own continuation).
  appendChain(opts.underMerged);

  // The parent's other side branches, re-attached under the merged node.
  for (const sub of opts.sideSubtrees) {
    if (!mergedNewId) continue;
    sm.branch(mergedNewId);
    appendChain(sub);
  }

  // The main-path continuation, re-attached under the merged node; its
  // off-path subtrees are preserved too.
  if (mergedNewId) sm.branch(mergedNewId);
  for (const entry of mainAfterParent) {
    const newId = appendEntry(sm, entry);
    if (!newId) continue;
    const sub = offPathSubtrees.get(entry.id as string);
    if (sub) {
      sm.branch(newId);
      appendChain(sub);
      sm.branch(newId);
    }
  }
  return mergedNewId;
}

/**
 * Merge a distilled summary from a side branch into the main path, placing a
 * copy of it right after the fork turn it originated from. Only a
 * compactionSummary can be merged — copying an ordinary user/assistant
 * message would drag its question → answer pair into a foreign position and
 * corrupt the context.
 *
 * `preResolvedId` skips label resolution (used by handleMergeOrSummarize,
 * which has already disambiguated the label).
 */
async function handleMerge(
  srcLabel: string,
  ctx: ExtensionCommandContext,
  config: DistillConfig,
  preResolvedId?: string,
): Promise<void> {
  try {
    // Resolve the label — duplicate tags prompt the user to disambiguate.
    const range = preResolvedId
      ? { startId: preResolvedId, endId: "", pair: false }
      : await resolveRange({ startLabel: srcLabel }, ctx);
    if (!range) return; // user cancelled
    const srcId = range.startId;

    const sm = ctx.sessionManager;
    const allEntries = sm.getEntries() as unknown as Array<
      Record<string, unknown>
    >;
    const byId = new Map(allEntries.map((e) => [e.id as string, e]));

    // Source must be a distilled summary.
    const srcEntry = byId.get(srcId);
    const srcRole = (
      srcEntry as { message?: { role?: string } } | undefined
    )?.message?.role;
    if (!srcEntry || srcEntry.type !== "message" || srcRole !== "compactionSummary") {
      ctx.ui.notify(
        "Merge source must be a distilled summary (compactionSummary).",
        "warning",
      );
      return;
    }

    // The summary must be the first message of a branch: its parent is the
    // fork point, and that parent must have more than one child branch.
    // Walk through any pass-through entries (labels etc.) sitting between
    // the summary and the fork point.
    let parentId = srcEntry.parentId as string | null;
    while (
      parentId &&
      PASSTHROUGH_TYPES.has(byId.get(parentId)?.type as string)
    ) {
      parentId = byId.get(parentId)?.parentId as string | null;
    }
    if (!parentId) {
      ctx.ui.notify("Summary has no parent node.", "warning");
      return;
    }
    const parentChildren = allEntries.filter(
      (e) => (e.parentId as string | null) === parentId,
    );
    if (parentChildren.length <= 1) {
      ctx.ui.notify(
        "Parent node has only one branch — nothing to merge.",
        "warning",
      );
      return;
    }

    // Main path (root → leaf).
    const leafId = sm.getLeafId();
    if (!leafId) throw new Error("Cannot determine current leaf node.");
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
    const pIdx = mainPath.findIndex((e) => e.id === parentId);
    if (pIdx === -1) {
      ctx.ui.notify("Parent node is not on the current path.", "warning");
      return;
    }

    // Collect a node's non-main-path subtree, flattened in order.
    const srcOnMain = mainPathIds.has(srcId);
    // Merge segments (shared with the branch-summarize merge): root → parent,
    // the main-path continuation, the parent's other side branches, and the
    // off-path subtrees preserved along the way.
    const { segmentA, mainAfterParent, sideRoots, offPathSubtrees } =
      computeMergeSegments(allEntries, byId, mainPath, parentId, srcId);
    // The summary's own subtree (branch content after it, off the main path).
    const srcDescendants = srcOnMain
      ? []
      : collectOffPathSubtree(byId, allEntries, mainPathIds, srcId, false);
    // When the summary itself is on the main path (srcDescendants is empty
    // then), branches forking off it are preserved too.
    const srcSideRoots = srcOnMain
      ? allEntries.filter(
          (c) =>
            (c.parentId as string | null) === srcId &&
            !mainPathIds.has(c.id as string),
        )
      : [];

    // Old session handling — same two-step as delete.
    const markChoice = await ctx.ui.select("Delete method", [
      "New session (keep old as distilled)",
      "In place (no trace)",
      "Cancel",
    ]);
    if (markChoice === undefined || markChoice === "Cancel") return;
    const markOld = markChoice === "New session (keep old as distilled)";

    // Rebuild: root → parent, then the summary as the parent's single child,
    // with every other branch of the parent re-attached under the summary.
    const oldSessionFile = sm.getSessionFile();
    const oldTitle = sm.getSessionName();
    const sessionDir = sm.getSessionDir();
    const cwd = ctx.cwd;

    // In-place rebuild keeps the old session's tree position.
    let oldParentSession: string | undefined;
    try {
      oldParentSession = SessionManager.open(
        oldSessionFile,
      ).getHeader()?.parentSession;
    } catch {
      // Non-fatal: fall back to a root session.
    }

    await ctx.newSession({
      parentSession: markOld ? undefined : oldParentSession,
      setup: async (sm2) => {
        rebuildMerged(sm2, {
          segmentA,
          mainAfterParent,
          offPathSubtrees,
          parentId,
          underMerged: [
            ...srcDescendants,
            ...srcSideRoots.flatMap((root) =>
              collectOffPathSubtree(
                byId,
                allEntries,
                mainPathIds,
                root.id as string,
                true,
              ),
            ),
          ],
          sideSubtrees: sideRoots.map((root) =>
            collectOffPathSubtree(
              byId,
              allEntries,
              mainPathIds,
              root.id as string,
              true,
            ),
          ),
          appendMerged: (sm2) => appendEntry(sm2, srcEntry),
        });
      },
      withSession: async (freshCtx) => {
        const newSessionFile = freshCtx.sessionManager.getSessionFile();
        if (oldSessionFile && newSessionFile) {
          if (markOld) {
            if (config.autoClean) {
              deleteSession(oldSessionFile);
            } else {
              await flattenDistilledSessions(newSessionFile, cwd, sessionDir);
              setParentSession(oldSessionFile, newSessionFile);
              markDistilledTitle(oldSessionFile, oldTitle);
            }
          } else {
            // In place: remove the old session file — no leftover copy.
            // Re-parent its children under the fresh session.
            deleteSession(oldSessionFile);
            try {
              const sessions = await SessionManager.list(cwd, sessionDir);
              for (const s of sessions) {
                if (s.path === oldSessionFile) continue;
                if (s.parentSessionPath === oldSessionFile) {
                  setParentSession(s.path, newSessionFile);
                }
              }
            } catch {
              // Non-fatal: orphaned children fall back to roots.
            }
          }
        }
        freshCtx.ui.notify(
          "Merged branch summary into main path",
          "info",
        );
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Merge failed: ${message}`, "error");
  }
}

/**
 * Packaged "distill + merge": summarize a whole side branch and merge the
 * summary into the fork point — the same result as running /distill on the
 * branch and then /distill merge on the resulting summary, in one step.
 *
 * The label must sit on the FIRST message of a branch (a user message whose
 * parent is a fork point on the current path — a branch always starts with a
 * user message, which also guarantees the compressed range never swallows
 * the parent's turn). The branch must be a single message chain with no
 * forks; the range runs from the label to the branch end. The generated
 * summary replaces the branch as the parent's only direct child, with the
 * parent's other branches and the main-path continuation re-attached under
 * it (identical topology to handleMerge).
 */
async function handleDistillMerge(
  label: string,
  ctx: ExtensionCommandContext,
  config: DistillConfig,
  startId: string,
): Promise<void> {
  try {
    const sm = ctx.sessionManager;
    const allEntries = sm.getEntries() as unknown as Array<
      Record<string, unknown>
    >;
    const byId = new Map(allEntries.map((e) => [e.id as string, e]));

    // The target must be the first message of a branch: a user message.
    const startEntry = byId.get(startId);
    const startRole = (
      startEntry as { message?: { role?: string } } | undefined
    )?.message?.role;
    if (!startEntry || startEntry.type !== "message" || startRole !== "user") {
      ctx.ui.notify(
        "Merge-and-summarize target must be the first user message of a branch.",
        "warning",
      );
      return;
    }

    // The branch's parent is the fork point — walk through any pass-through
    // entries (labels etc.) sitting between them.
    let parentId = startEntry.parentId as string | null;
    while (
      parentId &&
      PASSTHROUGH_TYPES.has(byId.get(parentId)?.type as string)
    ) {
      parentId = byId.get(parentId)?.parentId as string | null;
    }
    if (!parentId) {
      ctx.ui.notify("Branch has no parent node.", "warning");
      return;
    }
    const parentChildren = allEntries.filter(
      (e) => (e.parentId as string | null) === parentId,
    );
    if (parentChildren.length <= 1) {
      ctx.ui.notify(
        "Parent node has only one branch — nothing to merge.",
        "warning",
      );
      return;
    }

    // Main path (root → leaf).
    const leafId = sm.getLeafId();
    if (!leafId) throw new Error("Cannot determine current leaf node.");
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
    if (mainPath.findIndex((e) => (e.id as string) === parentId) === -1) {
      ctx.ui.notify("Parent node is not on the current path.", "warning");
      return;
    }
    // The branch itself must be off the main path — otherwise there is no
    // separate branch to merge.
    if (mainPathIds.has(startId)) {
      ctx.ui.notify(
        "The tagged node is on the main path — nothing to merge.",
        "warning",
      );
      return;
    }

    // Walk the branch's single message chain from the label to its end. A
    // fork anywhere along it is rejected; the end is the last message with
    // no message children. Pass-through entries (labels) are transparent.
    const childrenOf = new Map<string | null, Array<Record<string, unknown>>>();
    for (const e of allEntries) {
      const pid = (e.parentId as string | null) ?? null;
      const list = childrenOf.get(pid);
      if (list) list.push(e);
      else childrenOf.set(pid, [e]);
    }
    const effectiveMessageChildren = (
      id: string,
    ): Array<Record<string, unknown>> => {
      const direct = childrenOf.get(id) ?? [];
      const result: Array<Record<string, unknown>> = [];
      for (const c of direct) {
        if (c.type === "message") result.push(c);
        else if (PASSTHROUGH_TYPES.has(c.type as string)) {
          result.push(...effectiveMessageChildren(c.id as string));
        }
      }
      return result;
    };
    let endId = startId;
    let node: Record<string, unknown> | undefined = startEntry;
    const walked = new Set<string>();
    while (node && !walked.has(node.id as string)) {
      walked.add(node.id as string);
      const kids = effectiveMessageChildren(node.id as string);
      if (kids.length > 1) {
        throw new Error(
          "Branch detected in range — not supported yet. Distill before/after the branch point separately.",
        );
      }
      if (kids.length === 0) {
        endId = node.id as string;
        break;
      }
      node = kids[0];
    }

    // Summarize the branch [label → branch end] (side-branch plan mode).
    const result = await executeCompact(
      {
        startLabel: label,
        startId,
        endId,
        endLabelDesc: "branch end",
      },
      config,
      ctx,
    );
    const finalSummary = await showSummaryAndConfirm(result.summary, ctx);

    // Merge segments (shared with handleMerge).
    const { segmentA, mainAfterParent, sideRoots, offPathSubtrees } =
      computeMergeSegments(allEntries, byId, mainPath, parentId, startId);
    // Non-message tail hanging off the branch end (labels, custom entries)
    // stays with the summary.
    const underMerged = collectOffPathSubtree(
      byId,
      allEntries,
      mainPathIds,
      endId,
      false,
    );

    // Old session handling — same two-step as delete/merge.
    const markChoice = await ctx.ui.select("Delete method", [
      "New session (keep old as distilled)",
      "In place (no trace)",
      "Cancel",
    ]);
    if (markChoice === undefined || markChoice === "Cancel") return;
    const markOld = markChoice === "New session (keep old as distilled)";

    const oldSessionFile = sm.getSessionFile();
    const oldTitle = sm.getSessionName();
    const sessionDir = sm.getSessionDir();
    const cwd = ctx.cwd;

    // In-place rebuild keeps the old session's tree position.
    let oldParentSession: string | undefined;
    try {
      oldParentSession = SessionManager.open(
        oldSessionFile,
      ).getHeader()?.parentSession;
    } catch {
      // Non-fatal: fall back to a root session.
    }

    await ctx.newSession({
      parentSession: markOld ? undefined : oldParentSession,
      setup: async (sm2) => {
        const summaryContent =
          `<distilled-summary turns="${result.turnCount}" messages="${result.segmentBC.length}">\n` +
          `${finalSummary}\n` +
          `</distilled-summary>`;
        rebuildMerged(sm2, {
          segmentA,
          mainAfterParent,
          offPathSubtrees,
          parentId,
          underMerged,
          sideSubtrees: sideRoots.map((root) =>
            collectOffPathSubtree(
              byId,
              allEntries,
              mainPathIds,
              root.id as string,
              true,
            ),
          ),
          appendMerged: (sm2) =>
            sm2.appendMessage({
              role: "compactionSummary",
              summary: summaryContent,
              tokensBefore: estimateTokens(result.segmentBC),
              timestamp: Date.now(),
            } as unknown as Parameters<SessionManager["appendMessage"]>[0]),
        });

        // Archive the original branch content for view_distilled_context.
        const archiveData = {
          conversations: result.segmentBC.map((m) => {
            if (m.type === "message") {
              const msg = (
                m as unknown as { message: { role: string; content: unknown } }
              ).message;
              return {
                role: msg.role,
                content:
                  typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content),
              };
            }
            const ce = m as unknown as { content: unknown };
            return {
              role: "distilled_summary",
              content:
                typeof ce.content === "string"
                  ? ce.content
                  : JSON.stringify(ce.content),
            };
          }),
          range: { startLabel: label },
          turnCount: result.turnCount,
          timestamp: Date.now(),
        };
        sm2.appendCustomEntry("distilled-archive", archiveData);
      },
      withSession: async (freshCtx) => {
        const newSessionFile = freshCtx.sessionManager.getSessionFile();
        if (oldSessionFile && newSessionFile) {
          if (markOld) {
            if (config.autoClean) {
              deleteSession(oldSessionFile);
            } else {
              await flattenDistilledSessions(newSessionFile, cwd, sessionDir);
              setParentSession(oldSessionFile, newSessionFile);
              markDistilledTitle(oldSessionFile, oldTitle);
            }
          } else {
            // In place: remove the old session file — no leftover copy.
            // Re-parent its children under the fresh session.
            deleteSession(oldSessionFile);
            try {
              const sessions = await SessionManager.list(cwd, sessionDir);
              for (const s of sessions) {
                if (s.path === oldSessionFile) continue;
                if (s.parentSessionPath === oldSessionFile) {
                  setParentSession(s.path, newSessionFile);
                }
              }
            } catch {
              // Non-fatal: orphaned children fall back to roots.
            }
          }
        }
        freshCtx.ui.notify("Branch summarized and merged", "info");
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Merge failed: ${message}`, "error");
  }
}

/**
 * /distill merge entry: a label pointing at an existing distilled summary
 * merges that summary (handleMerge); a label pointing at a branch's first
 * user message summarizes the branch and merges it in one step
 * (handleDistillMerge). Resolves the label once so duplicate tags prompt a
 * single disambiguation.
 */
async function handleMergeOrSummarize(
  label: string,
  ctx: ExtensionCommandContext,
  config: DistillConfig,
): Promise<void> {
  try {
    const range = await resolveRange({ startLabel: label }, ctx);
    if (!range) return; // user cancelled

    const allEntries = ctx.sessionManager.getEntries() as unknown as Array<
      Record<string, unknown>
    >;
    const entry = allEntries.find((e) => (e.id as string) === range.startId);
    const role = (
      entry as { message?: { role?: string } } | undefined
    )?.message?.role;

    if (entry?.type === "message" && role === "compactionSummary") {
      await handleMerge(label, ctx, config, range.startId);
    } else if (entry?.type === "message" && role === "user") {
      await handleDistillMerge(label, ctx, config, range.startId);
    } else {
      ctx.ui.notify(
        "Merge target must be a distilled summary or the first user message of a branch.",
        "warning",
      );
    }
  } catch (err) {
    if (err instanceof SummaryCancelledError) {
      ctx.ui.notify("Summary generation cancelled", "warning");
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Merge failed: ${message}`, "error");
  }
}

/** Path of a freshly forked session awaiting its first new user message. */
let pendingForkSession: string | undefined;

/** Extract plain text from a message content (string or content blocks). */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

// ---- command registration -------------------------------------------------

export function registerDistillCommand(pi: ExtensionAPI): void {
  const subcommandCompletions = [
    { value: "context on", label: "context on", description: "Enable full background context" },
    { value: "context off", label: "context off", description: "Disable background context" },
    { value: "auto-clean on", label: "auto-clean on", description: "Delete old session after distill" },
    { value: "auto-clean off", label: "auto-clean off", description: "Keep old sessions (marked [distilled])" },
    { value: "model", label: "model", description: "Select summary model" },
    { value: "clean", label: "clean", description: "Delete all distilled sessions" },
  ];

  pi.registerCommand("distill", {
    description:
      "Context distill: /distill <label> [supplement] (tag both ends of a range with the same name); /distill del [<label>] deletes a range; /distill merge [<label>] folds sibling branches under a branch summary",
    getArgumentCompletions: (argumentPrefix) => {
      const prefix = argumentPrefix.trim().toLowerCase();
      if (!prefix) return subcommandCompletions;
      return subcommandCompletions.filter((s) =>
        s.label.toLowerCase().startsWith(prefix),
      );
    },
    handler: async (args, ctx) => {
      const config = loadConfig();

      // ---- sub-commands ---------------------------------------------------

      const trimmed = args.trim();

      // /distill context on|off
      if (/^context\s+(on|off)$/i.test(trimmed)) {
        const on = trimmed.split(/\s+/)[1].toLowerCase() === "on";
        config.contextOn = on;
        saveConfig(config);
        ctx.ui.notify(`Context background: ${on ? "ON" : "OFF"}`, "info");
        return;
      }

      // /distill auto-clean on|off
      if (/^auto-clean\s+(on|off)$/i.test(trimmed)) {
        const on = trimmed.split(/\s+/)[1].toLowerCase() === "on";
        config.autoClean = on;
        saveConfig(config);
        ctx.ui.notify(`Auto-clean: ${on ? "ON" : "OFF"}`, "info");
        return;
      }

      // /distill model
      if (/^model$/i.test(trimmed)) {
        const available = ctx.modelRegistry.getAvailable();
        const labels = available.map((m) =>
          `${m.provider}/${m.id}${m.name ? ` (${m.name})` : ""}`,
        );

        const chosen = await ctx.ui.select("Select summary model", labels);
        if (chosen) {
          // Extract provider/modelId from the selected label
          const matched = available.find((m) =>
            chosen.startsWith(`${m.provider}/${m.id}`),
          );
          if (matched) {
            config.summaryModel = `${matched.provider}/${matched.id}`;
            saveConfig(config);
            ctx.ui.notify(`Summary model: ${config.summaryModel}`, "info");
          }
        }
        return;
      }

      // /distill clean
      if (/^clean$/i.test(trimmed)) {
        const sessionDir = ctx.sessionManager.getSessionDir();
        const sessions = await SessionManager.list(ctx.cwd, sessionDir);
        const distilled = sessions.filter((s) =>
          s.name?.startsWith("[distilled "),
        );
        let deleted = 0;
        for (const s of distilled) {
          if (deleteSession(s.path)) deleted++;
        }
        ctx.ui.notify(`Deleted ${deleted} distilled session(s)`, "info");
        return;
      }

      // /distill fork <path> [message]
      if (/^fork\s+/i.test(trimmed)) {
        const raw = trimmed.replace(/^fork\s+/i, "").trim();
        const tokens = tokenizeQuoted(raw);
        const path = tokens[0] ?? "";
        const message = tokens[1];
        if (!path) {
          ctx.ui.notify("Usage: /distill fork <path> [message]", "warning");
          return;
        }
        await resumeDistilledSession(path, ctx, message);
        return;
      }

      // /distill del [<label>] — delete the range without summarizing.
      // With no explicit label, "del" itself is the label (a tag named
      // "del" is deleted up to the current position).
      const delMatch = /^del(?:\s+(.+))?$/i.exec(trimmed);
      if (delMatch) {
        const label = delMatch[1]?.trim() ?? "del";
        await handleDelete(label, ctx, config);
        return;
      }

      // /distill merge [<label>] — merge a distilled summary into the main
      // path, or (when the label points at a branch's first user message)
      // summarize that branch and merge it in one step. With no explicit
      // label, "merge" itself is the label (a tag named "merge" is merged
      // directly).
      const mergeMatch = /^merge(?:\s+(.+))?$/i.exec(trimmed);
      if (mergeMatch) {
        const label = mergeMatch[1]?.trim() ?? "merge";
        await handleMergeOrSummarize(label, ctx, config);
        return;
      }

      // ---- main distill flow ----------------------------------------------

      const parts = parseArgs(trimmed);

      if (parts.labels.length === 0) {
        ctx.ui.notify(
          "Usage: /distill <label> [supplement]  (tag both ends of a range with the same name)\n" +
            "  /distill del <label>  deletes the range without summarizing\n" +
            "Sub-commands: context on|off  /  auto-clean on|off  /  model  /  clean",
          "warning",
        );
        return;
      }

      try {
        // Resolve labels to concrete entry IDs — duplicate tags prompt the
        // user to disambiguate before any work happens.
        const range = await resolveRange({ startLabel: parts.labels[0] }, ctx);
        if (!range) return; // user cancelled

        // Run compact engine
        const result = await executeCompact(
          {
            startLabel: parts.labels[0],
            startId: range.startId,
            endId: range.endId,
            // Describe the end point for error messages: a paired range
            // ("Between the two tags") ends at the second tag, not the leaf.
            endLabelDesc: range.pair ? "the second tag" : undefined,
            supplement: parts.supplement,
          },
          config,
          ctx,
        );

        // Show summary and confirm
        const finalSummary = await showSummaryAndConfirm(result.summary, ctx);

        // Capture old session metadata before creating the replacement
        const oldSessionFile = ctx.sessionManager.getSessionFile();
        const oldTitle = ctx.sessionManager.getSessionName();
        const oldLeafId = ctx.sessionManager.getLeafId();
        const sessionDir = ctx.sessionManager.getSessionDir();
        const cwd = ctx.cwd;

        // Create replacement session, reconstructing branches from the old tree
        await ctx.newSession({
          setup: async (sm) => {
            const idMap = new Map<string, string>();
            let anchorNewId: string | undefined;

            // Shared archive payload (kept out of the LLM context; used by
            // the view tool to look up original messages).
            const archiveData = {
              conversations: result.segmentBC.map((m) => {
                if (m.type === "message") {
                  const msg = (m as unknown as { message: { role: string; content: unknown } }).message;
                  return {
                    role: msg.role,
                    content:
                      typeof msg.content === "string"
                        ? msg.content
                        : JSON.stringify(msg.content),
                  };
                }
                const ce = m as unknown as { content: unknown };
                return {
                  role: "distilled_summary",
                  content:
                    typeof ce.content === "string"
                      ? ce.content
                      : JSON.stringify(ce.content),
                };
              }),
              range: {
                startLabel: parts.labels[0],
              },
              turnCount: result.turnCount,
              timestamp: Date.now(),
            };

            // Side-branch range: whole-tree rebuild plan. Every entry is
            // copied in DFS order under its remapped parent; the range is
            // replaced by a fresh compactionSummary and the range's
            // descendants are re-attached under it.
            if (result.plan) {
              const summaryContent =
                `<distilled-summary turns="${result.turnCount}" messages="${result.segmentBC.length}">\n` +
                `${finalSummary}\n` +
                `</distilled-summary>`;
              // Restore the user's position: the plan replay ends at the last
              // DFS entry, which is not necessarily the original leaf.
              rebuildPlanEntries(
                sm,
                result.plan,
                summaryContent,
                estimateTokens(result.segmentBC),
                oldLeafId ?? undefined,
              );
              sm.appendCustomEntry("distilled-archive", archiveData);
              return;
            }

            // Copy segment A (all entry types) linearly
            for (const entry of result.segmentA) {
              const newId = appendEntry(sm, entry);
              if (newId) {
                idMap.set(entry.id as string, newId);
                anchorNewId = newId;
              } else if (anchorNewId) {
                // Pass-through entry (label / compaction / branch_summary):
                // not copied, but branches forking off it attach under the
                // current anchor.
                idMap.set(entry.id as string, anchorNewId);
              }
            }

            // Reconstruct branches that fork off segment A
            for (const branch of result.branches) {
              const parentNewId = idMap.get(branch.branchPointId);
              if (!parentNewId) continue;
              sm.branch(parentNewId);
              for (const entry of branch.entries) {
                appendEntry(sm, entry);
              }
            }

            // Return to the anchor (last entry before compressed range)
            if (anchorNewId) sm.branch(anchorNewId);

            // Insert the distilled summary as a native compactionSummary
            // message (a top-level message, NOT a custom_message). This makes
            // it a node you can continue from: the tree selector keeps the
            // leaf ON this entry, whereas custom_message entries move the leaf
            // to the parent and stuff the content into the editor.
            // The <distilled-summary> tag tells the LLM this is NOT a user
            // message; turns/messages attrs convey the compression granularity.
            const summaryContent =
              `<distilled-summary turns="${result.turnCount}" messages="${result.segmentBC.length}">\n` +
              `${finalSummary}\n` +
              `</distilled-summary>`;
            sm.appendMessage({
              role: "compactionSummary",
              summary: summaryContent,
              tokensBefore: estimateTokens(result.segmentBC),
              timestamp: Date.now(),
            } as unknown as Parameters<SessionManager["appendMessage"]>[0]);

            // Copy segment D (all entry types)
            for (const entry of result.segmentD) {
              appendEntry(sm, entry);
            }

            // Insert archive (not in LLM context, for the view tool)
            sm.appendCustomEntry("distilled-archive", archiveData);
          },
          withSession: async (freshCtx) => {
            // Make every older session a flat sibling under the new root,
            // mark the old title, or delete it when auto-clean is enabled.
            const newSessionFile = freshCtx.sessionManager.getSessionFile();
            if (oldSessionFile && newSessionFile) {
              if (config.autoClean) {
                deleteSession(oldSessionFile);
              } else {
                await flattenDistilledSessions(newSessionFile, cwd, sessionDir);
                setParentSession(oldSessionFile, newSessionFile);
                markDistilledTitle(oldSessionFile, oldTitle);
              }
            }
            freshCtx.ui.notify("✅ Distilled", "info");
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Distill failed: ${message}`, "error");
      }
    },
  });
}

// ---- session guards -------------------------------------------------------

/** Whether the current session is a read-only distilled session. */
let currentDistilled = false;

/**
 * Guard distilled sessions: opening (browsing) one is allowed, but the user's
 * first message is intercepted and rerouted to a fork — so the distilled
 * history is never edited directly, and mere browsing creates no session.
 */
export function registerSessionGuards(pi: ExtensionAPI): void {
  // Track whether the current session is a read-only distilled session.
  pi.on("session_start", (event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    currentDistilled = file ? isDistilledSession(file) : false;
    // Clear any lingering fork hint from a previous session.
    ctx.ui.setWidget("distill", undefined);
  });

  // Intercept the first message in a distilled session: prefill a fork
  // command carrying that message, so one Enter forks + continues.
  pi.on("input", (event, ctx) => {
    if (!currentDistilled) return { action: "continue" as const };
    if (event.source !== "interactive") return { action: "continue" as const };
    const text = event.text.trim();
    if (!text || text.startsWith("/")) return { action: "continue" as const };

    const sessionFile = ctx.sessionManager.getSessionFile();
    ctx.ui.setWidget("distill", [
      ctx.ui.theme.fg(
        "dim",
        "Distilled session is read-only. To continue, run /distill fork (prefilled in input) — press Enter.",
      ),
    ]);
    ctx.ui.setEditorText(
      `/distill fork ${JSON.stringify(sessionFile)} ${JSON.stringify(text)}`,
    );
    return { action: "handled" as const };
  });

  // When a freshly forked session receives its first NEW user message,
  // set that message as the session title (so it doesn't inherit the
  // source session's stale first message). pi.setSessionName appends the
  // session_info entry to the LIVE session manager (and persists it), so
  // the title shows immediately instead of only after the next reload.
  pi.on("message_start", (event, ctx) => {
    if (!pendingForkSession) return;
    if (event.message.role !== "user") return;
    if (ctx.sessionManager.getSessionFile() !== pendingForkSession) return;

    const text = extractMessageText(event.message.content).trim();
    if (text) {
      try {
        pi.setSessionName(text.slice(0, 60));
      } catch {
        // Non-fatal: title assignment is best-effort.
      }
    }
    pendingForkSession = undefined;
  });
}

// ---- argument parser ------------------------------------------------------

interface ParsedArgs {
  labels: string[];
  supplement: string | undefined;
}

/**
 * Parse /distill arguments.
 * Handles quoted supplement text.
 * Examples:
 *   "diagnosis-done"                   → labels: ["diagnosis-done"]
 *   "diagnosis-done \"extra context\"" → labels: ["diagnosis-done"], supplement: "extra context"
 *   "B-start B-end"                    → labels: ["B-start", "B-end"]
 *   "B-start B-end \"DB discussion\""  → labels: ["B-start", "B-end"], supplement: "DB discussion"
 */
function parseArgs(raw: string): ParsedArgs {
  // Split respecting double-quoted sections
  const tokens: string[] = [];
  let i = 0;

  while (i < raw.length) {
    // Skip whitespace
    while (i < raw.length && raw[i] === " ") i++;
    if (i >= raw.length) break;

    if (raw[i] === '"') {
      // Quoted string
      i++; // skip opening quote
      let quoted = "";
      while (i < raw.length && raw[i] !== '"') {
        quoted += raw[i];
        i++;
      }
      i++; // skip closing quote
      tokens.push(quoted);
    } else {
      // Unquoted token
      let token = "";
      while (i < raw.length && raw[i] !== " ") {
        token += raw[i];
        i++;
      }
      tokens.push(token);
    }
  }

  if (tokens.length === 0) return { labels: [], supplement: undefined };

  // Only the single-label form exists — pairs are expressed by tagging both
  // spots with the same name, so every remaining token is supplement text.
  return {
    labels: [tokens[0]],
    supplement: tokens.slice(1).join(" ") || undefined,
  };
}

/** Split a string into tokens, honoring double/single quotes and backslash escapes. */
function tokenizeQuoted(raw: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && raw[i] === " ") i++;
    if (i >= raw.length) break;

    if (raw[i] === '"' || raw[i] === "'") {
      const quote = raw[i];
      i++;
      let s = "";
      while (i < raw.length && raw[i] !== quote) {
        if (raw[i] === "\\" && i + 1 < raw.length) {
          s += raw[i + 1];
          i += 2;
        } else {
          s += raw[i];
          i++;
        }
      }
      i++; // skip closing quote
      tokens.push(s);
    } else {
      let s = "";
      while (i < raw.length && raw[i] !== " ") {
        s += raw[i];
        i++;
      }
      tokens.push(s);
    }
  }
  return tokens;
}
