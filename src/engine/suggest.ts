/**
 * LLM-assisted label suggestion.
 *
 * Builds a compact transcript (every user message + the final assistant text
 * of each turn; tool calls/results and previously summarized sections are
 * omitted or replaced by a placeholder), asks an OpenAI-compatible endpoint
 * for one label position, and validates the response before the command
 * applies it.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SuggestLlmConfig } from "./compact";
import { extractText, renderTemplate } from "./prompt";
import { LOG_KEEP, logDirFor } from "./session-io";
import {
  buildRootPath,
  groupPathIntoTurns,
  type AnyEntry,
  type MessageEntry,
} from "./turn-group";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATE_PATH = join(__dirname, "../../distill-suggest-prompt.md");

const DEFAULT_TEMPLATE = [
  "你是一个会话整理助手。下面是一段编程会话的精简记录：每条 user 消息都保留了；每条 assistant 消息只保留该轮的最后一条文本回复；工具调用和工具输出已省略；此前已被总结过的较早对话用占位符表示。",
  "",
  "请根据这段会话的工作任务逻辑，建议一个标签（label）应该放置的位置。标签用于标记一个完整任务阶段的起点，目的是之后把这个阶段压缩成摘要，以减少上下文长度，方便用户继续工作。",
  "",
  "选择原则：",
  "1. 优先选择最近一个合适的阶段起点，使标签之后的对话构成一个相对独立、完整的工作段落。",
  "2. 位置用 turn 编号表示；优先选择能代表阶段起点的 user 消息轮次。",
  "3. 不要拆散同一次工作：例如问题诊断与它的修复应属于同一个阶段；也不要把下一个任务的开头并入上一个阶段。",
  "4. 如果最近的阶段太短（例如只有一轮），可以适当向前寻找更完整的阶段起点。",
  "5. 如果整段会话太短，或者没有值得单独标记的阶段，返回 turn: null 并说明原因。",
  "6. description 用 2-4 句话，说明从该位置到当前会话末尾的主要内容，以及为什么在这里切分。",
  "",
  "用户的额外需求：",
  "{{HINT}}",
  "",
  "会话记录（turn 编号从 1 开始）：",
  "{{CONVERSATION}}",
  "",
  "只输出 JSON，不要 markdown 代码块，不要额外解释：",
  '{"turn":12,"description":"2-4 句话说明这部分内容和选择理由"}',
  "或",
  '{"turn":null,"reason":"为什么没有合适位置"}',
].join("\n");

/** One compact turn shown to the suggestion model. */
export interface SuggestTurn {
  /** 1-based turn number shown to the model. */
  index: number;
  kind: "user" | "summary";
  /** Entry the label would target (the user message or the summary). */
  entryId: string;
  userText: string;
  /** Final assistant text of this turn (empty when the turn has none). */
  assistantText: string;
}

export interface SuggestTranscript {
  turns: SuggestTurn[];
  /** Every active label name in the session, used to pick the next suggest-N. */
  existingLabels: string[];
}

export interface BuildTranscriptOptions {
  /** Per-message character cap (default 800). */
  maxCharsPerMessage?: number;
}

export interface SuggestSessionManager {
  getEntries(): readonly unknown[];
  getLeafId(): string | null;
  getLabel(id: string): string | undefined;
}

// ---- transcript building --------------------------------------------------

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n... (truncated ${trimmed.length - max} chars)`;
}

/** Collect every active label name in the session (deduplicated). */
export function collectExistingLabels(sm: SuggestSessionManager): string[] {
  const names = new Set<string>();
  for (const entry of sm.getEntries() as Array<{ id: string }>) {
    const label = sm.getLabel(entry.id);
    if (label) names.add(label);
  }
  return [...names].sort();
}

/**
 * Pick the next `suggest-N` label name. The highest numeric suffix is used so
 * a deleted/manual label cannot cause a collision; non-numeric `suggest-*`
 * names are ignored.
 */
export function nextSuggestLabelName(existingLabels: string[]): string {
  let max = 0;
  for (const label of existingLabels) {
    const match = /^suggest-(\d+)$/i.exec(label);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `suggest-${max + 1}`;
}

/**
 * Build the compact transcript used by the suggestion prompt.
 *
 * Tool results and intermediate assistant messages are intentionally omitted:
 * only the user message that starts a turn and the final assistant text of
 * that turn are kept. A previously summarized section becomes a placeholder.
 */
export function buildSuggestTranscript(
  sm: SuggestSessionManager,
  options: BuildTranscriptOptions = {},
): SuggestTranscript {
  const maxChars = Math.max(120, options.maxCharsPerMessage ?? 800);
  const allEntries = sm.getEntries() as unknown as AnyEntry[];
  const byId = new Map<string, AnyEntry>();
  for (const entry of allEntries) {
    byId.set(entry.id, entry);
  }

  const leafId = sm.getLeafId();
  if (!leafId) {
    return { turns: [], existingLabels: collectExistingLabels(sm) };
  }

  const path = buildRootPath(
    byId as unknown as Map<string, Record<string, unknown>>,
    leafId,
  ) as unknown as AnyEntry[];
  const groupedTurns = groupPathIntoTurns(path);

  const turns: SuggestTurn[] = [];
  for (const turn of groupedTurns) {
    const first = turn.messages[0];
    if (!first) continue;

    const role = first.message.role;
    if (role !== "user" && role !== "compactionSummary") continue;

    // Final assistant text in this turn. Walk backwards so the last
    // substantive reply wins (earlier assistant messages are usually tool
    // planning / intermediate narration).
    let assistantText = "";
    for (let i = turn.messages.length - 1; i >= 1; i--) {
      const message = turn.messages[i] as MessageEntry;
      if (message.message.role !== "assistant") continue;
      const text = extractText(message.message.content);
      if (text.trim()) {
        assistantText = truncate(text, maxChars);
        break;
      }
    }

    const kind = role === "user" ? "user" : "summary";
    const userText =
      kind === "user" ? truncate(extractText(first.message.content), maxChars) : "";

    turns.push({
      index: turns.length + 1,
      kind,
      entryId: first.id,
      userText,
      assistantText,
    });
  }

  return { turns, existingLabels: collectExistingLabels(sm) };
}

/** Render turns as the plain-text transcript used in the prompt. */
export function formatSuggestTranscript(turns: SuggestTurn[]): string {
  const blocks: string[] = [];

  for (const turn of turns) {
    const lines = [`[Turn ${turn.index}]`];
    if (turn.kind === "summary") {
      lines.push("summary: [previously summarized section — content omitted]");
    } else {
      lines.push(`user: ${turn.userText || "(empty message)"}`);
    }
    if (turn.assistantText) {
      lines.push(`assistant final: ${turn.assistantText}`);
    }
    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n");
}

// ---- prompt ---------------------------------------------------------------

function loadTemplate(): string {
  try {
    if (existsSync(TEMPLATE_PATH)) {
      return readFileSync(TEMPLATE_PATH, "utf8");
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_TEMPLATE;
}

export function buildSuggestPrompt(
  transcript: SuggestTranscript,
  hint?: string,
): string {
  const template = loadTemplate();

  return renderTemplate(template, {
    CONVERSATION: formatSuggestTranscript(transcript.turns),
    HINT: hint?.trim() ?? "",
  }).trim();
}

// ---- request --------------------------------------------------------------

interface ChatCompletionMessage {
  content?: unknown;
}

interface ChatCompletionChoice {
  message?: ChatCompletionMessage;
  finish_reason?: string;
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  error?: { message?: string };
}

/** Write the exact prompt to `<cwd>/.pi/distill/logs/suggest-<ts>.txt`. */
function logPrompt(prompt: string, modelLabel: string, cwd: string): void {
  try {
    const dir = logDirFor(cwd);
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `suggest-${ts}.txt`);
    const header = [
      "# Suggest-label prompt log",
      `time: ${new Date().toISOString()}`,
      `model: ${modelLabel}`,
      "",
    ].join("\n");
    writeFileSync(file, `${header}\n${prompt}\n`);

    const files = readdirSync(dir)
      .filter((f) => f.startsWith("suggest-") && f.endsWith(".txt"))
      .sort();
    for (const old of files.slice(0, Math.max(0, files.length - LOG_KEEP))) {
      try {
        rmSync(join(dir, old));
      } catch {
        // best-effort
      }
    }
  } catch {
    // Logging is best-effort; never fail the command.
  }
}

function resolveApiKey(config: SuggestLlmConfig): string {
  const envName = config.apiKeyEnv?.trim();
  if (envName) {
    const value = process.env[envName];
    if (!value) {
      throw new Error(
        `Environment variable ${envName} is not set (required by suggest.apiKeyEnv).`,
      );
    }
    return value;
  }
  if (config.apiKey?.trim()) return config.apiKey.trim();
  throw new Error(
    "No API key configured. Set suggest.apiKeyEnv (recommended) or suggest.apiKey.",
  );
}

function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

/**
 * Call the configured OpenAI-compatible endpoint and return the raw content
 * of the first choice. The prompt is logged before the request so failures
 * can be inspected afterwards.
 */
export async function requestSuggestion(
  prompt: string,
  config: SuggestLlmConfig,
  cwd: string,
): Promise<string> {
  const apiKey = resolveApiKey(config);
  const url = chatCompletionsUrl(config.baseUrl);
  const modelLabel = `${config.model} @ ${config.baseUrl}`;
  logPrompt(prompt, modelLabel, cwd);

  const timeoutMs = Math.max(5_000, config.timeoutMs ?? 60_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: prompt }],
          temperature: config.temperature ?? 0.2,
          max_tokens: config.maxTokens ?? 2_048,
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") {
        throw new Error(
          `Label suggestion timed out after ${Math.round(timeoutMs / 1000)}s.`,
        );
      }
      throw new Error(
        `Label suggestion request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const bodyText = await response.text();
    if (!response.ok) {
      const snippet = bodyText.replace(/\s+/g, " ").trim().slice(0, 400);
      throw new Error(
        `Label suggestion LLM HTTP ${response.status}: ${snippet || "(empty response)"}`,
      );
    }

    let data: ChatCompletionResponse;
    try {
      data = JSON.parse(bodyText) as ChatCompletionResponse;
    } catch {
      throw new Error(
        `Label suggestion LLM returned non-JSON: ${bodyText.slice(0, 300)}`,
      );
    }

    if (data.error?.message) {
      throw new Error(`Label suggestion LLM error: ${data.error.message}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      const reason = data.choices?.[0]?.finish_reason ?? "unknown";
      throw new Error(
        `Label suggestion LLM returned empty content (finish_reason: ${reason}). ` +
          "Try increasing suggest.maxTokens.",
      );
    }
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}

// ---- response parsing -----------------------------------------------------

export type LabelSuggestion =
  | {
      kind: "label";
      turn: number;
      entryId: string;
      description: string;
      targetPreview: string;
    }
  | { kind: "none"; reason: string };

function extractJsonObject(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(
      `Label suggestion did not contain a JSON object: ${text.slice(0, 300)}`,
    );
  }
  return candidate.slice(start, end + 1);
}

function targetPreview(turn: SuggestTurn): string {
  if (turn.kind === "summary") return "[summarized section]";
  const firstLine = turn.userText.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}

/**
 * Parse and validate the model's JSON response. Invalid JSON, an out-of-range
 * turn, or a missing description throws a descriptive error. Existing labels
 * are deliberately not part of this validation: the command warns the user
 * after they choose an action.
 */
export function parseSuggestion(
  raw: string,
  turns: SuggestTurn[],
): LabelSuggestion {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Label suggestion JSON is invalid: ${error.message}. Raw: ${raw.slice(0, 300)}`,
      );
    }
    throw error;
  }

  const rawTurn = parsed.turn;
  if (rawTurn === null || rawTurn === undefined || rawTurn === "") {
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : typeof parsed.description === "string" && parsed.description.trim()
          ? parsed.description.trim()
          : "The model found no suitable label position.";
    return { kind: "none", reason };
  }

  const turnNumber = Number(rawTurn);
  if (!Number.isInteger(turnNumber) || turnNumber < 1 || turnNumber > turns.length) {
    throw new Error(
      `Label suggestion turn ${JSON.stringify(rawTurn)} is out of range (1-${turns.length}).`,
    );
  }

  const target = turns[turnNumber - 1];

  const description =
    typeof parsed.description === "string" ? parsed.description.trim() : "";
  if (!description) {
    throw new Error("Label suggestion is missing a non-empty 'description'.");
  }

  return {
    kind: "label",
    turn: turnNumber,
    entryId: target.entryId,
    description: description.slice(0, 1_200),
    targetPreview: targetPreview(target),
  };
}
