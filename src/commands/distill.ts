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

import { executeCompact } from "../engine/compact";
import type { DistillConfig } from "../engine/compact";
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
      if (oldSessionFile && newSessionFile) {
        if (config.autoClean) {
          deleteSession(oldSessionFile);
        } else {
          await flattenDistilledSessions(newSessionFile, cwd, sessionDir);
          setParentSession(oldSessionFile, newSessionFile);
          markDistilledTitle(oldSessionFile, oldTitle);
        }
      }
      freshCtx.ui.notify("Deleted (new session)", "success");
    },
  });
}

/**
 * Handle `/distill del <label>`: delete the range without summarizing.
 * Presents three choices: new session (mark old distilled), delete in place,
 * or cancel.
 */
async function handleDelete(
  label: string,
  ctx: ExtensionCommandContext,
  config: DistillConfig,
): Promise<void> {
  try {
    const result = await executeCompact(
      { startLabel: label },
      { ...config, drop: true },
      ctx,
    );

    const choice = await ctx.ui.select("Delete this range", [
      "New session (keep old as distilled)",
      "Delete in place (no trace)",
      "Cancel",
    ]);
    if (choice === "Cancel" || choice === undefined) return;

    if (choice === "New session (keep old as distilled)") {
      await deleteAsNewSession(result, ctx, config);
      return;
    }

    // Delete in place: rewind the leaf to just before the deleted range.
    if (!result.anchorId) {
      ctx.ui.notify(
        "Cannot delete from the very start in place. Use the first option.",
        "warning",
      );
      return;
    }
    await ctx.navigateTree(result.anchorId);
    ctx.ui.notify("Deleted in place", "success");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Delete failed: ${message}`, "error");
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
      "Context distill: /distill <label> [supplement] or /distill <label1> <label2> [supplement]; /distill del <label> deletes a range",
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
        // Run compact engine
        const result = await executeCompact(
          {
            startLabel: parts.labels[0],
            endLabel: parts.labels.length > 1 ? parts.labels[1] : undefined,
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

            // Insert distilled summary (wrapped in a self-identifying header).
            // The <distilled-summary> tag tells the LLM this is NOT a user
            // message, and the turns/messages attrs convey the compression
            // granularity. Its position in the flow is the "this point" anchor.
            const summaryContent =
              `<distilled-summary turns="${result.turnCount}" messages="${result.segmentBC.length}">\n` +
              `${finalSummary}\n` +
              `</distilled-summary>`;
            sm.appendCustomMessageEntry(
              "distilled-summary",
              summaryContent,
              true,
              {
                range: {
                  startLabel: parts.labels[0],
                  endLabel:
                    parts.labels.length > 1 ? parts.labels[1] : undefined,
                },
                turnCount: result.turnCount,
              },
            );

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
