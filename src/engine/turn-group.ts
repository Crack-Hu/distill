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
  return entries.filter(
    (e): e is MessageEntry =>
      e.type === "message" &&
      typeof (e as MessageEntry).message?.role === "string",
  );
}

/**
 * Group a chronological entry path into turns.
 *
 * A user message starts a new turn. Everything else — assistant/toolResult
 * messages, labels, model changes, custom entries — is attached to the current
 * turn. Non-message entries before the first user message form a "prelude"
 * turn (empty messages array).
 */
export function groupPathIntoTurns(path: AnyEntry[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const e of path) {
    if (e.type === "message") {
      const msg = e as MessageEntry;
      if (msg.message.role === "user") {
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
 * Scan all entries for a label entry whose `label` field matches `name`.
 * Returns the `targetId` of the label (the entry it points to), or undefined.
 */
export function resolveLabel(
  allEntries: AnyEntry[],
  labelName: string,
): string | undefined {
  const labelEntry = allEntries.find(
    (e): e is LabelEntry =>
      e.type === "label" && (e as LabelEntry).label === labelName,
  );
  return labelEntry ? (labelEntry as LabelEntry).targetId : undefined;
}

// ---- path building --------------------------------------------------------

/**
 * Walk parentId chain from `endId` up to (and including) `startId`.
 * Returns entries in chronological order (root → leaf).
 */
export function buildPath(
  byId: Map<string, AnyEntry>,
  startId: string,
  endId: string,
): AnyEntry[] {
  const path: AnyEntry[] = [];
  let current = byId.get(endId);
  const visited = new Set<string>();

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current); // prepend for chronological order
    if (current.id === startId) break;
    current = byId.get(current.parentId ?? "");
  }

  return path;
}
