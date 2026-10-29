/**
 * /suggest-label — ask an LLM where to place the next distill label.
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
import {
  buildSuggestPrompt,
  buildSuggestTranscript,
  nextSuggestLabelName,
  parseSuggestion,
  requestSuggestion,
  type LabelSuggestion,
} from "../engine/suggest";
import {
  loadConfig,
  reportDistillError,
  resolveRange,
  runCompactAndRebuild,
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
    "Missing LLM config for /suggest-label.",
    `Add a "suggest" block to ${configPathFor(cwd)} (template: config.json.example):`,
    "",
    '"suggest": {',
    '  "baseUrl": "https://api.deepseek.com",',
    '  "model": "deepseek-flash",',
    '  "apiKeyEnv": "DEEPSEEK_API_KEY_PI"',
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

async function handleSuggestLabel(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const config = loadConfig(ctx.cwd);
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

  ctx.ui.setStatus("distill-suggest", "Asking LLM for a label suggestion…");
  let suggestion: LabelSuggestion;
  try {
    const raw = await requestSuggestion(prompt, suggestConfig, ctx.cwd);
    suggestion = parseSuggestion(raw, transcript.turns);
  } catch (error) {
    ctx.ui.notify(errorMessage(error), "error");
    return;
  } finally {
    ctx.ui.setStatus("distill-suggest", undefined);
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
    const range = await resolveRange({ startLabel: label }, ctx);
    if (!range) return;
    await runCompactAndRebuild({
      startLabel: label,
      startId: range.startId,
      endId: range.endId,
      endLabelDesc: range.pair ? "the second tag" : undefined,
      config,
      ctx,
      restoreLeafId: preLabelLeafId,
    });
  } catch (error) {
    reportDistillError(ctx, error);
  }
}

/**
 * Register the LLM-assisted label suggestion command.
 */
export function registerSuggestLabelCommand(pi: ExtensionAPI): void {
  const description =
    "Suggest one distill label position with an LLM (compact transcript), then Accept, Accept and distill, or Reject";

  const handler = async (args: string, ctx: ExtensionCommandContext) => {
    await handleSuggestLabel(pi, args, ctx);
  };

  pi.registerCommand("suggest-label", { description, handler });
}
