/**
 * /distill suggest_lab — ask an LLM where to place the next distill label.
 *
 * The transcript is intentionally compact: user messages plus the final
 * assistant text of each turn, with tool output omitted and summaries
 * replaced by placeholders. The model returns one position plus a short
 * description; the user can accept, accept and distill, or reject.
 */

import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import type { SuggestLlmConfig } from "../engine/compact";
import {
  extensionConfigPath,
  extensionDir,
  globalConfigPath,
  projectConfigPath,
} from "../engine/session-io";
import { ProgressDialog } from "../ui/progress";
import {
  buildExpansionPrompt,
  buildSuggestPrompt,
  buildSuggestTranscript,
  isExpansionInDirection,
  nextSuggestLabelName,
  parseSuggestion,
  requestSuggestion,
  type ExpansionDirection,
  type LabelSuggestion,
  type SuggestionMessage,
} from "../engine/suggest";
import type {
  DistillConfig,
  RunCompactParams,
} from "./distill";

const CONFIG_TEMPLATE_PATH = join(extensionDir(), "config.json.example");

const CHOICES = {
  ACCEPT: "Accept",
  ACCEPT_DISTILL: "Accept and distill",
  MOVE_EARLIER: "Move start label earlier",
  MOVE_LATER: "Move start label later",
  REJECT: "Reject",
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missingConfigMessage(cwd: string): string {
  return [
    "Missing LLM config for /distill suggest_lab.",
    `Add a "suggest" block to ${globalConfigPath()}`,
    `(legacy fallback: ${extensionConfigPath()};`,
    ` per-project override: ${projectConfigPath(cwd)}).`,
    `Template: ${CONFIG_TEMPLATE_PATH}`,
    "",
    '"suggest": {',
    '  "baseUrl": "https://api.deepseek.com",',
    '  "model": "deepseek-flash",',
    '  "apiKeyEnv": "DEEPSEEK_API_KEY_PI",',
    '  "thinking": "disabled"',
    "}",
  ].join("\n");
}

function isConfigured(config: SuggestLlmConfig | undefined): config is SuggestLlmConfig {
  return Boolean(config?.baseUrl?.trim() && config?.model?.trim());
}

/** Apply the label through pi's native label API (same path as /tree shift+L). */
function applyLabel(
  pi: ExtensionAPI,
  entryId: string,
  label: string,
  ctx: ExtensionCommandContext,
): boolean {
  try {
    pi.setLabel(entryId, label);
    return true;
  } catch (error) {
    ctx.ui.notify(`Could not add label: ${errorMessage(error)}`, "error");
    return false;
  }
}

/**
 * Run the suggestion request behind the same cancellable overlay used by
 * summary generation. Returns undefined when the user presses Esc.
 */
async function requestSuggestionWithCancel(
  promptOrMessages: string | SuggestionMessage[],
  config: SuggestLlmConfig,
  ctx: ExtensionCommandContext,
  progressMessage = "Analyzing the conversation…",
): Promise<string | undefined> {
  const controller = new AbortController();
  const generation = requestSuggestion(
    promptOrMessages,
    config,
    ctx.cwd,
    controller.signal,
  );

  if (!ctx.hasUI) return generation;

  const outcome = await ctx.ui.custom<"done" | "cancel">(
    (tui, theme, keybindings, done) =>
      new ProgressDialog(
        tui,
        theme,
        keybindings,
        generation,
        {
          title: "Suggesting a label",
          message: progressMessage,
          modelLabel: config.model,
        },
        done,
      ),
    {
      overlay: true,
      // Overlays are NOT focused by default (pi only setFocus()es non-overlay
      // components) — without this the Esc key goes to the editor.
      onHandle: (handle) => handle.focus(),
      overlayOptions: {
        width: ProgressDialog.BOX_W,
      },
    },
  );

  if (outcome === "cancel") {
    controller.abort();
    // Wait for the request to settle so nothing keeps running after the
    // overlay is gone.
    await generation.catch(() => {});
    return undefined;
  }
  return generation;
}

function suggestionTitle(
  suggestion: Extract<LabelSuggestion, { kind: "label" }>,
  label: string,
): string {
  return [
    `Suggested label: ${label}`,
    `Position: turn ${suggestion.turn} — ${suggestion.targetPreview || "(no preview)"}`,
    "",
    suggestion.description,
    "",
    "Choose an action:",
  ].join("\n");
}

export interface SuggestLabelDeps {
  config: DistillConfig;
  runCompactAndRebuild: (params: RunCompactParams) => Promise<void>;
  resolveRange: (
    args: { startLabel: string },
    ctx: ExtensionCommandContext,
  ) => Promise<{ startId: string; endId: string; pair: boolean } | null>;
  reportDistillError: (
    ctx: ExtensionCommandContext,
    err: unknown,
    operation?: string,
  ) => void;
}

export async function handleSuggestLabel(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  deps: SuggestLabelDeps,
): Promise<void> {
  const config = deps.config;
  const suggestConfig = config.suggest;
  if (!isConfigured(suggestConfig)) {
    ctx.ui.notify(missingConfigMessage(ctx.cwd), "error");
    return;
  }

  const transcript = buildSuggestTranscript(ctx.sessionManager, {
    maxCharsPerMessage: suggestConfig.maxCharsPerMessage,
  });
  if (transcript.turns.length === 0) {
    ctx.ui.notify("No user turns found on the current branch.", "warning");
    return;
  }

  const hint = args.trim() || undefined;
  const initialPrompt = buildSuggestPrompt(transcript, hint);
  let messages: SuggestionMessage[] = [
    { role: "user", content: initialPrompt },
  ];

  let current: {
    suggestion: Extract<LabelSuggestion, { kind: "label" }>;
    raw: string;
  };
  try {
    const raw = await requestSuggestionWithCancel(messages, suggestConfig, ctx);
    if (raw === undefined) {
      ctx.ui.notify("Label suggestion cancelled.", "warning");
      return;
    }
    const parsed = parseSuggestion(raw, transcript.turns);
    if (parsed.kind === "none") {
      ctx.ui.notify(`No label suggested: ${parsed.reason}`, "info");
      return;
    }
    current = { suggestion: parsed, raw };
  } catch (error) {
    ctx.ui.notify(errorMessage(error), "error");
    return;
  }

  const label = nextSuggestLabelName(transcript.existingLabels);

  if (!ctx.hasUI) {
    ctx.ui.notify(
      `Suggested label ${label} at turn ${current.suggestion.turn}: ${current.suggestion.description}`,
      "info",
    );
    return;
  }

  let choice: string | undefined;
  for (;;) {
    const canMoveEarlier = transcript.turns.some(
      (turn) => turn.kind === "user" && turn.index < current.suggestion.turn,
    );
    const canMoveLater = transcript.turns.some(
      (turn) => turn.kind === "user" && turn.index > current.suggestion.turn,
    );

    const options: string[] = [CHOICES.ACCEPT, CHOICES.ACCEPT_DISTILL];
    if (canMoveEarlier) options.push(CHOICES.MOVE_EARLIER);
    if (canMoveLater) options.push(CHOICES.MOVE_LATER);
    options.push(CHOICES.REJECT);

    choice = await ctx.ui.select(
      suggestionTitle(current.suggestion, label),
      options,
    );

    const direction: ExpansionDirection | undefined =
      choice === CHOICES.MOVE_EARLIER
        ? "earlier"
        : choice === CHOICES.MOVE_LATER
          ? "later"
          : undefined;
    if (!direction) break;

    if (
      (direction === "earlier" && !canMoveEarlier) ||
      (direction === "later" && !canMoveLater)
    ) {
      ctx.ui.notify(`There is no ${direction} turn to include.`, "warning");
      continue;
    }

    const expandMessages: SuggestionMessage[] = [
      ...messages,
      { role: "assistant", content: current.raw },
      {
        role: "user",
        content: buildExpansionPrompt(current.suggestion.turn, direction),
      },
    ];

    let nextRaw: string | undefined;
    try {
      nextRaw = await requestSuggestionWithCancel(
        expandMessages,
        suggestConfig,
        ctx,
        direction === "earlier"
          ? "Looking further back…"
          : "Looking further ahead…",
      );
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
      continue;
    }
    if (nextRaw === undefined) {
      ctx.ui.notify("Label suggestion cancelled.", "warning");
      return;
    }

    let parsed: LabelSuggestion;
    try {
      parsed = parseSuggestion(nextRaw, transcript.turns);
    } catch (error) {
      ctx.ui.notify(errorMessage(error), "error");
      continue;
    }
    if (parsed.kind === "none") {
      ctx.ui.notify(`No ${direction} label suggested: ${parsed.reason}`, "info");
      continue;
    }

    if (
      !isExpansionInDirection(
        current.suggestion.turn,
        parsed.turn,
        direction,
      )
    ) {
      ctx.ui.notify(
        `The model did not choose ${
          direction === "earlier" ? "an earlier" : "a later"
        } turn; keeping the current suggestion.`,
        "warning",
      );
      continue;
    }

    const target = transcript.turns[parsed.turn - 1];
    if (target.kind !== "user") {
      ctx.ui.notify(
        "The model chose a summary placeholder; keeping the current suggestion.",
        "warning",
      );
      continue;
    }

    // Commit the successful expansion so the next request can reuse the
    // entire conversation as a prefix-cacheable message history.
    messages = expandMessages;
    current = { suggestion: parsed, raw: nextRaw };
  }

  if (choice !== CHOICES.ACCEPT && choice !== CHOICES.ACCEPT_DISTILL) {
    ctx.ui.notify("Label suggestion rejected.", "info");
    return;
  }

  const suggestion = current.suggestion;

  // The model never sees existing labels; warn only after the user has
  // chosen to apply this suggestion.
  const existingLabel = ctx.sessionManager.getLabel(suggestion.entryId);
  if (existingLabel) {
    const replace = await ctx.ui.confirm(
      `Turn ${suggestion.turn} already has a label`,
      `Existing label: "${existingLabel}"\nApplying "${label}" will replace it. Continue?`,
    );
    if (!replace) {
      ctx.ui.notify(`Kept existing label "${existingLabel}".`, "info");
      return;
    }
  }

  // Capture the position before pi.setLabel appends its label entry (which
  // becomes the new leaf). The whole-tree rebuild needs the conversation
  // position, not the synthetic label entry.
  const preLabelLeafId = ctx.sessionManager.getLeafId() ?? undefined;

  if (!applyLabel(pi, suggestion.entryId, label, ctx)) return;

  if (choice === CHOICES.ACCEPT) {
    ctx.ui.notify(
      `Label "${label}" added at turn ${suggestion.turn}. ` +
        `Run /distill ${label} to compress from here.`,
      "info",
    );
    return;
  }

  // Accept and distill: reuse the normal label→current flow, including its
  // summary review and session-method prompt.
  try {
    const range = await deps.resolveRange({ startLabel: label }, ctx);
    if (!range) return;
    await deps.runCompactAndRebuild({
      startLabel: label,
      startId: range.startId,
      endId: range.endId,
      endLabelDesc: range.pair ? "the second tag" : undefined,
      config,
      ctx,
      restoreLeafId: preLabelLeafId,
    });
  } catch (error) {
    deps.reportDistillError(ctx, error);
  }
}
