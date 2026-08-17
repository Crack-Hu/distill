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

import { collectBranches, executeCompact } from "../engine/compact";
import type { DistillConfig } from "../engine/compact";
import { groupPathIntoTurns, resolveAllLabels } from "../engine/turn-group";
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
function appendEntry(
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
      const e = entry as { name: string };
      return sm.appendSessionInfo(e.name);
    }
    // label / compaction / branch_summary reference old entry IDs and are
    // skipped; they don't participate in LLM context.
    default:
      return undefined;
  }
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
        freshCtx.ui.notify("Forked from distilled session", "success");
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
  result: Awaited<ReturnType<typeof executeCompact>>,
  ctx: ExtensionCommandContext,
  config: DistillConfig,
  markOld: boolean,
): Promise<void> {
  const oldSessionFile = ctx.sessionManager.getSessionFile();
  const oldTitle = ctx.sessionManager.getSessionName();
  const sessionDir = ctx.sessionManager.getSessionDir();
  const cwd = ctx.cwd;

  await ctx.newSession({
    setup: (sm) => {
      const idMap = new Map<string, string>();
      let anchorNewId: string | undefined;

      for (const entry of result.segmentA) {
        const newId = appendEntry(sm, entry);
        if (newId) {
          idMap.set(entry.id as string, newId);
          anchorNewId = newId;
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
      if (oldSessionFile && newSessionFile && markOld) {
        if (config.autoClean) {
          deleteSession(oldSessionFile);
        } else {
          await flattenDistilledSessions(newSessionFile, cwd, sessionDir);
          setParentSession(oldSessionFile, newSessionFile);
          markDistilledTitle(oldSessionFile, oldTitle);
        }
      }
      freshCtx.ui.notify(
        markOld ? "Deleted (new session)" : "Deleted in place",
        "success",
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
    const allEntries = ctx.sessionManager.getEntries() as Array<
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
  const options = candidates.map(
    (id, i) => `#${i + 1} ${describeTagPosition(id, ctx)}`.trim(),
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
 * Resolve a label pair to concrete entry IDs, prompting the user when a
 * label appears multiple times in the tree.
 *
 * Single label (`/distill tag`):
 *   1 match   → tag → current position
 *   2 matches → ask: between the two / up to the first / up to the last
 *   >2 matches→ ask which tag to compress up to
 *
 * Two labels (`/distill tag1 tag2`): each ambiguous label prompts a picker.
 * Returns null when the user cancels.
 */
async function resolveRange(
  args: { startLabel: string; endLabel?: string },
  ctx: ExtensionCommandContext,
): Promise<{ startId: string; endId: string } | null> {
  const allEntries = ctx.sessionManager.getEntries() as Array<
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

  // Two-label form.
  if (args.endLabel) {
    // Same-name pair (`/distill tag tag`): the intent is "between the two
    // tags". With exactly two occurrences, compress between them directly.
    if (args.endLabel === args.startLabel) {
      if (startCandidates.length === 2) {
        return { startId: startCandidates[0], endId: startCandidates[1] };
      }
      const startId = await pickLabelCandidate(
        startCandidates,
        args.startLabel,
        "start",
        ctx,
      );
      if (!startId) return null;
      const rest = startCandidates.filter((id) => id !== startId);
      if (rest.length === 0) return null;
      if (rest.length === 1) return { startId, endId: rest[0] };
      const endId = await pickLabelCandidate(
        rest,
        args.startLabel,
        "end",
        ctx,
      );
      if (!endId) return null;
      return { startId, endId };
    }

    const endCandidates = resolveAllLabels(
      ctx.sessionManager,
      allEntries,
      args.endLabel,
    );
    if (endCandidates.length === 0) {
      throw new Error(
        `Label "${args.endLabel}" not found. Create one via /tree → shift+L first.`,
      );
    }
    const startId = await pickLabelCandidate(
      startCandidates,
      args.startLabel,
      "start",
      ctx,
    );
    if (!startId) return null;
    const endId = await pickLabelCandidate(
      endCandidates,
      args.endLabel,
      "end",
      ctx,
    );
    if (!endId) return null;
    return { startId, endId };
  }

  // Single-label form.
  if (startCandidates.length === 1) {
    return { startId: startCandidates[0], endId: leafId };
  }

  if (startCandidates.length === 2) {
    const [first, last] = startCandidates;
    const choice = await ctx.ui.select(
      `Label "${args.startLabel}" appears twice — compress what?`,
      ["Between the two tags", "Up to the first tag", "Up to the last tag"],
    );
    if (choice === undefined) return null;
    if (choice === "Between the two tags") return { startId: first, endId: last };
    if (choice === "Up to the first tag") return { startId: first, endId: leafId };
    return { startId: last, endId: leafId };
  }

  // More than two matches: pick which tag to compress up to.
  const startId = await pickLabelCandidate(
    startCandidates,
    args.startLabel,
    "start",
    ctx,
  );
  if (!startId) return null;
  return { startId, endId: leafId };
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
  const allEntries = sm.getEntries() as Array<Record<string, unknown>>;
  const byId = new Map(allEntries.map((e) => [e.id as string, e]));
  const leafId = sm.getLeafId();
  if (!leafId) throw new Error("Cannot determine current leaf node.");

  // Full root → leaf path
  const fullPath: Array<Record<string, unknown>> = [];
  let cur = byId.get(leafId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id as string)) {
    seen.add(cur.id as string);
    fullPath.unshift(cur);
    const pid = cur.parentId as string | null;
    if (!pid) break;
    cur = byId.get(pid);
  }

  // Turn logic: the deleted range is the turn containing the summary. Since a
  // distilled summary is its own turn, this removes exactly the summary while
  // keeping the surrounding question → answer turns intact.
  const turns = groupPathIntoTurns(fullPath);
  const turnIdx = turns.findIndex((t) =>
    t.entries.some((e) => e.id === targetId),
  );
  if (turnIdx === -1) {
    throw new Error("Target entry is not on the current path.");
  }
  if (turnIdx === 0) {
    throw new Error(
      "Cannot delete the first turn alone — use range delete instead.",
    );
  }
  const targetTurn = turns[turnIdx];

  // Branches forking off the kept part are preserved. If the deleted summary
  // is a fork point, its branches are re-attached to the last kept entry.
  const lastKept = turns[turnIdx - 1].entries[
    turns[turnIdx - 1].entries.length - 1
  ];
  const parentId = lastKept?.id as string | undefined;
  const turnEndId = targetTurn.entries[
    targetTurn.entries.length - 1
  ].id as string;
  const branches = collectBranches(allEntries, byId, fullPath, turnEndId).map(
    (b) =>
      b.branchPointId === targetId && parentId
        ? { ...b, branchPointId: parentId }
        : b,
  );

  const result: Awaited<ReturnType<typeof executeCompact>> = {
    summary: "",
    segmentA: turns.slice(0, turnIdx).flatMap((t) => t.entries),
    segmentBC: targetTurn.entries.filter((e) => e.type === "message"),
    segmentD: turns.slice(turnIdx + 1).flatMap((t) => t.entries),
    turnCount: 1,
    branches,
  };
  await deleteAsNewSession(result, ctx, config, markOld);
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

    // Step 1 — deletion granularity. The tagged entry's own turn can be
    // deleted alone ("This turn only"), or everything from the label up to
    // the current position can be deleted. Both follow turn semantics: a
    // distilled summary is its own turn, so deleting it deletes exactly the
    // summary; a user/assistant message deletes its whole question → answer
    // turn.
    const how = await ctx.ui.select(
      `Label "${label}" points to a single entry — delete how?`,
      ["This turn only", "Label to current position", "Cancel"],
    );
    if (how === undefined || how === "Cancel") return;
    const single = how === "This turn only";

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
 * Merge a distilled summary from a side branch into the main path, placing a
 * copy of it right after the fork turn it originated from. Only a
 * compactionSummary can be merged — copying an ordinary user/assistant
 * message would drag its question → answer pair into a foreign position and
 * corrupt the context.
 */
async function handleMerge(
  srcLabel: string,
  ctx: ExtensionCommandContext,
  config: DistillConfig,
): Promise<void> {
  try {
    // Resolve the label — duplicate tags prompt the user to disambiguate.
    const range = await resolveRange({ startLabel: srcLabel }, ctx);
    if (!range) return; // user cancelled
    const srcId = range.startId;

    const sm = ctx.sessionManager;
    const allEntries = sm.getEntries() as Array<Record<string, unknown>>;
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
    const parentId = srcEntry.parentId as string | null;
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
    const collectSubtree = (
      rootId: string,
      includeRoot: boolean,
    ): Array<Record<string, unknown>> => {
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
    };

    // Rebuild segments.
    const segmentA = mainPath.slice(0, pIdx + 1); // root → parent (inclusive)
    const srcOnMain = mainPathIds.has(srcId);
    // The main-path continuation after the parent (skipping src itself when
    // the summary sits on the main path).
    const mainAfterParent = srcOnMain
      ? mainPath.slice(pIdx + 2)
      : mainPath.slice(pIdx + 1);
    // The summary's own subtree (branch content after it, off the main path).
    const srcDescendants = srcOnMain ? [] : collectSubtree(srcId, false);
    // The parent's other side branches — re-attached under the summary.
    const sideRoots = parentChildren.filter(
      (e) => e.id !== srcId && !mainPathIds.has(e.id as string),
    );

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

    await ctx.newSession({
      setup: (sm2) => {
        for (const entry of segmentA) {
          appendEntry(sm2, entry);
        }
        const srcNewId = appendEntry(sm2, srcEntry);

        // The summary's own continuation (branch content after it).
        for (const entry of srcDescendants) {
          appendEntry(sm2, entry);
        }

        // The parent's other side branches, re-attached under the summary.
        for (const root of sideRoots) {
          sm2.branch(srcNewId);
          for (const entry of collectSubtree(root.id as string, true)) {
            appendEntry(sm2, entry);
          }
        }

        // The main-path continuation, re-attached under the summary.
        sm2.branch(srcNewId);
        for (const entry of mainAfterParent) {
          appendEntry(sm2, entry);
        }
      },
      withSession: async (freshCtx) => {
        const newSessionFile = freshCtx.sessionManager.getSessionFile();
        if (oldSessionFile && newSessionFile && markOld) {
          if (config.autoClean) {
            deleteSession(oldSessionFile);
          } else {
            await flattenDistilledSessions(newSessionFile, cwd, sessionDir);
            setParentSession(oldSessionFile, newSessionFile);
            markDistilledTitle(oldSessionFile, oldTitle);
          }
        }
        freshCtx.ui.notify(
          "Merged branch summary into main path",
          "success",
        );
      },
    });
  } catch (err) {
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
      "Context distill: /distill <label> [supplement] or /distill <label1> <label2> [supplement]; /distill del [<label>] deletes a range; /distill merge [<label>] folds sibling branches under a branch summary",
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
        ctx.ui.notify(`Context background: ${on ? "ON" : "OFF"}`, "success");
        return;
      }

      // /distill auto-clean on|off
      if (/^auto-clean\s+(on|off)$/i.test(trimmed)) {
        const on = trimmed.split(/\s+/)[1].toLowerCase() === "on";
        config.autoClean = on;
        saveConfig(config);
        ctx.ui.notify(`Auto-clean: ${on ? "ON" : "OFF"}`, "success");
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
            ctx.ui.notify(`Summary model: ${config.summaryModel}`, "success");
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
        ctx.ui.notify(`Deleted ${deleted} distilled session(s)`, "success");
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

      // /distill merge [<label>] — merge a side branch's distilled summary
      // into the main path. With no explicit label, "merge" itself is the
      // label (a tag named "merge" on a branch summary is merged directly).
      const mergeMatch = /^merge(?:\s+(.+))?$/i.exec(trimmed);
      if (mergeMatch) {
        const label = mergeMatch[1]?.trim() ?? "merge";
        await handleMerge(label, ctx, config);
        return;
      }

      // ---- main distill flow ----------------------------------------------

      const parts = parseArgs(trimmed);

      if (parts.labels.length === 0) {
        ctx.ui.notify(
          "Usage: /distill <label> [supplement]  or  /distill <label1> <label2> [supplement]\n" +
            "  /distill del <label>  deletes the range without summarizing\n" +
            "Sub-commands: context on|off  /  auto-clean on|off  /  model  /  clean",
          "warning",
        );
        return;
      }

      try {
        // Resolve labels to concrete entry IDs — duplicate tags prompt the
        // user to disambiguate before any work happens.
        const range = await resolveRange(
          {
            startLabel: parts.labels[0],
            endLabel: parts.labels.length > 1 ? parts.labels[1] : undefined,
          },
          ctx,
        );
        if (!range) return; // user cancelled

        // Run compact engine
        const result = await executeCompact(
          {
            startLabel: parts.labels[0],
            endLabel: parts.labels.length > 1 ? parts.labels[1] : undefined,
            startId: range.startId,
            endId: range.endId,
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
        const sessionDir = ctx.sessionManager.getSessionDir();
        const cwd = ctx.cwd;

        // Create replacement session, reconstructing branches from the old tree
        await ctx.newSession({
          setup: (sm) => {
            const idMap = new Map<string, string>();
            let anchorNewId: string | undefined;

            // Copy segment A (all entry types) linearly
            for (const entry of result.segmentA) {
              const newId = appendEntry(sm, entry);
              if (newId) {
                idMap.set(entry.id as string, newId);
                anchorNewId = newId;
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
            });

            // Copy segment D (all entry types)
            for (const entry of result.segmentD) {
              appendEntry(sm, entry);
            }

            // Insert archive (not in LLM context, for the view tool)
            sm.appendCustomEntry("distilled-archive", {
              conversations: result.segmentBC.map((m) => {
                if (m.type === "message") {
                  const msg = (m as { message: { role: string; content: unknown } }).message;
                  return {
                    role: msg.role,
                    content:
                      typeof msg.content === "string"
                        ? msg.content
                        : JSON.stringify(msg.content),
                  };
                }
                const ce = m as { content: unknown };
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
                endLabel:
                  parts.labels.length > 1 ? parts.labels[1] : undefined,
              },
              turnCount: result.turnCount,
              timestamp: Date.now(),
            });
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
            freshCtx.ui.notify("✅ Distilled", "success");
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
  // source session's stale first message).
  pi.on("message_start", (event, ctx) => {
    if (!pendingForkSession) return;
    if (event.message.role !== "user") return;
    if (ctx.sessionManager.getSessionFile() !== pendingForkSession) return;

    const text = extractMessageText(event.message.content).trim();
    if (text) {
      const title = text.slice(0, 60);
      try {
        SessionManager.open(pendingForkSession).appendSessionInfo(title);
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

  // First one or two tokens are labels, rest is supplement
  const labels: string[] = [tokens[0]];

  // Check if token[1] looks like a label (word-like identifier)
  if (tokens.length >= 2 && /^[\w\-_\u4e00-\u9fff]+$/.test(tokens[1])) {
    labels.push(tokens[1]);
    const rest = tokens.slice(2).join(" ");
    return { labels, supplement: rest || undefined };
  }

  const rest = tokens.slice(1).join(" ");
  return { labels, supplement: rest || undefined };
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
