/**
 * /distill suggest_lab — ask an LLM where to place the next distill label.
 *
 * The transcript is intentionally compact: user messages plus the final
 * assistant text of each turn, with tool output omitted and summaries
 * replaced by placeholders. The model returns one position plus a short
 * description; the user can accept, accept and distill, or reject.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import type { SuggestLlmConfig } from "../engine/compact";
import { configPathFor } from "../engine/session-io";
import { ProgressDialog } from "../ui/progress";
import {
  buildSuggestPrompt,
  buildSuggestTranscript,
  nextSuggestLabelName,
  parseSuggestion,
  requestSuggestion,
  type LabelSuggestion,
} from "../engine/suggest";
import type {
  DistillConfig,
  RunCompactParams,
} from "./distill";

const CHOICES = {
  ACCEPT: "Accept",
  ACCEPT_DISTILL: "Accept and distill",
  REJECT: "Reject",
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missingConfigMessage(cwd: string): string {
  return [
    "Missing LLM config for /distill suggest_lab.",
    `Add a "suggest" block to ${configPathFor(cwd)} (template: config.json.example):`,
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
  prompt: string,
  config: SuggestLlmConfig,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const controller = new AbortController();
  const generation = requestSuggestion(prompt, config, ctx.cwd, controller.signal);

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
          message: "Analyzing the conversation…",
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
    "Add this label?",
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
  const prompt = buildSuggestPrompt(transcript, hint);
  const label = nextSuggestLabelName(transcript.existingLabels);

  let suggestion: LabelSuggestion;
  try {
    const raw = await requestSuggestionWithCancel(prompt, suggestConfig, ctx);
    if (raw === undefined) {
      ctx.ui.notify("Label suggestion cancelled.", "warning");
      return;
    }
    suggestion = parseSuggestion(raw, transcript.turns);
  } catch (error) {
    ctx.ui.notify(errorMessage(error), "error");
    return;
  }

  if (suggestion.kind === "none") {
    ctx.ui.notify(`No label suggested: ${suggestion.reason}`, "info");
    return;
  }

  if (!ctx.hasUI) {
    ctx.ui.notify(
      `Suggested label ${label} at turn ${suggestion.turn}: ${suggestion.description}`,
      "info",
    );
    return;
  }

  const choice = await ctx.ui.select(suggestionTitle(suggestion, label), [
    CHOICES.ACCEPT,
    CHOICES.ACCEPT_DISTILL,
    CHOICES.REJECT,
  ]);

  if (choice !== CHOICES.ACCEPT && choice !== CHOICES.ACCEPT_DISTILL) {
    ctx.ui.notify("Label suggestion rejected.", "info");
    return;
  }

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
