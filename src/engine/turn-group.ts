/**
 * Turn boundary grouping and label resolution.
 *
 * A "turn" is defined as: a user message + all subsequent assistant/toolResult
 * messages until the next user message.  This grouping ensures we never cut
 * through a tool_use/tool_result pair.
 */

// ---- types ----------------------------------------------------------------

interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  message: {
    role: string;
    content: unknown;
    [key: string]: unknown;
  };
}

interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string;
}

type AnyEntry = SessionEntryBase & Record<string, unknown>;

export type { AnyEntry };

/**
 * Entry types that cannot be copied into a rebuilt session: labels reference
 * the OLD target entry IDs, and pi-native compaction / branch_summary entries
 * carry pi's own compaction state. In tree rebuilds they act as pass-through
 * nodes — the entry itself is dropped, but its children are re-attached under
 * the entry's parent (a tag in pi moves the leaf onto the label entry, so the
 * next message is a CHILD of the label — dropping the label must not drop it).
 */
export const PASSTHROUGH_TYPES = new Set(["label", "compaction", "branch_summary"]);

// ---- turn grouping --------------------------------------------------------

/**
 * A turn groups a user message with all entries that follow it, up to (but not
 * including) the next user message. Includes non-message entries (labels,
 * model changes, custom entries) that sit between messages.
 */
export interface Turn {
  /** All entries in this turn, in chronological order. */
  entries: AnyEntry[];
  /** Only the message-type entries in this turn (for summary generation). */
  messages: MessageEntry[];
}

/**
 * Filter message entries from a mixed entry list, preserving only
 * user / assistant / toolResult messages (in chronological order).
 */
export function filterMessageEntries(
  entries: AnyEntry[],
): MessageEntry[] {
  return entries
    .filter(
      (e) =>
        e.type === "message" &&
        typeof (e as unknown as MessageEntry).message?.role === "string",
    )
    .map((e) => e as unknown as MessageEntry);
}

/**
 * Group a chronological entry path into turns.
 *
 * A user message starts a new turn. Everything else — assistant/toolResult
 * messages, labels, model changes, custom entries — is attached to the current
 * turn. Non-message entries before the first user message form a "prelude"
 * turn (empty messages array).
 *
 * A distilled summary (compactionSummary) also starts a new turn: it is a
 * standalone node, not part of a question → answer pair, matching pi's
 * isTurnStartMessage behavior.
 */
export function groupPathIntoTurns(path: AnyEntry[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const e of path) {
    if (e.type === "message") {
      const msg = e as unknown as MessageEntry;
      const role = msg.message.role;
      if (role === "user" || role === "compactionSummary") {
        if (current) turns.push(current);
        current = { entries: [e], messages: [msg] };
      } else {
        if (!current) current = { entries: [], messages: [] };
        current.entries.push(e);
        current.messages.push(msg);
      }
    } else {
      if (!current) current = { entries: [], messages: [] };
      current.entries.push(e);
    }
  }

  if (current) turns.push(current);
  return turns;
}

/**
 * Split a chronological list of message entries into turns.
 * Each turn starts with a user message.
 */
export function groupIntoTurns(messages: MessageEntry[]): MessageEntry[][] {
  const turns: MessageEntry[][] = [];
  let current: MessageEntry[] = [];

  for (const m of messages) {
    if (m.message.role === "user") {
      if (current.length > 0) turns.push(current);
      current = [m];
    } else {
      current.push(m);
    }
  }

  if (current.length > 0) turns.push(current);
  return turns;
}

// ---- label resolution -----------------------------------------------------

/**
 * Resolve `name` to the first currently-active label target, in entry order.
 * Uses pi's standard `getLabel` (backed by labelsById), which already applies
 * override semantics — a later empty label entry clears the tag — so cleared
 * labels are excluded automatically.
 */
export function resolveLabel(
  sm: { getLabel(id: string): string | undefined },
  allEntries: Array<Record<string, unknown>>,
  labelName: string,
): string | undefined {
  for (const e of allEntries) {
    if (sm.getLabel(e.id as string) === labelName) return e.id as string;
  }
  return undefined;
}

/**
 * Resolve `name` to EVERY currently-active label target, in entry order.
 * Uses pi's standard `getLabel`, so re-tagged and cleared labels are handled
 * exactly as the tree selector shows them.
 */
export function resolveAllLabels(
  sm: { getLabel(id: string): string | undefined },
  allEntries: Array<Record<string, unknown>>,
  labelName: string,
): string[] {
  const result: string[] = [];
  for (const e of allEntries) {
    if (sm.getLabel(e.id as string) === labelName) {
      result.push(e.id as string);
    }
  }
  return result;
}

// ---- path building --------------------------------------------------------

/**
 * Walk the parentId chain from `leafId` up to the root, returning entries in
 * chronological order (root → leaf).
 */
export function buildRootPath(
  byId: Map<string, Record<string, unknown>>,
  leafId: string,
): Array<Record<string, unknown>> {
  const path: Array<Record<string, unknown>> = [];
  let cur = byId.get(leafId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id as string)) {
    seen.add(cur.id as string);
    path.unshift(cur);
    const pid = cur.parentId as string | null;
    cur = pid ? byId.get(pid) : undefined;
  }
  return path;
}

/**
 * Children of `id` that are messages, walking through pass-through entries
 * (labels, pi-native compaction / branch_summary) transparently.
 */
export function effectiveMessageChildren(
  childrenOf: Map<string | null, Array<Record<string, unknown>>>,
  id: string,
): Array<Record<string, unknown>> {
  const direct = childrenOf.get(id) ?? [];
  const result: Array<Record<string, unknown>> = [];
  for (const c of direct) {
    if (c.type === "message") result.push(c);
    else if (PASSTHROUGH_TYPES.has(c.type as string)) {
      result.push(...effectiveMessageChildren(childrenOf, c.id as string));
    }
  }
  return result;
}

/**
 * Flatten a node's off-path subtree in pre-order (the node itself included
 * when `includeRoot` is set). Entries whose id is in `excludeIds` are treated
 * as on-path and skipped with their descendants. Pass-through entries are
 * included — rebuilds drop them while keeping their children attached under
 * the same parent.
 */
export function collectOffPathSubtree(
  byId: Map<string, Record<string, unknown>>,
  allEntries: Array<Record<string, unknown>>,
  excludeIds: Set<string>,
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
        !excludeIds.has(e.id as string),
    )) {
      walk(child.id as string, false);
    }
  };
  walk(rootId, true);
  return result;
}

/**
 * Walk parentId chain from `endId` up to (and including) `startId`.
 * Returns entries in chronological order (root → leaf).
 */
export function buildPath(
  byId: Map<string, Record<string, unknown>>,
  startId: string,
  endId: string,
): Array<Record<string, unknown>> {
  const path: Array<Record<string, unknown>> = [];
  let current = byId.get(endId);
  const visited = new Set<string>();

  while (current && !visited.has(current.id as string)) {
    visited.add(current.id as string);
    path.unshift(current);
    if ((current.id as string) === startId) break;
    current = byId.get((current.parentId as string | null) ?? "");
  }

  return path;
}
