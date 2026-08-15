/**
 * Prompt builder for the distill summary generation.
 * Loads the template from distill-summary-prompt.md at startup.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AnyEntry, MessageEntry } from "./turn-group";

// ---- template loading -----------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATE_PATH = join(__dirname, "../../distill-summary-prompt.md");

const DEFAULT_TEMPLATE = [
  "你是一个上下文压缩助手。请阅读以下对话片段，生成一段精简的摘要。",
  "",
  "要求：保留关键信息，剔除重复和噪音。直接输出摘要，不加前缀。",
  "",
  "[对话片段]",
  "{{CONVERSATION}}",
].join("\n");

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

// ---- text extraction helpers ----------------------------------------------

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

type ContentBlock = TextBlock | ToolCallBlock;

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return (content as ContentBlock[])
    .filter((c): c is TextBlock => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

function extractToolCalls(content: unknown): Array<{ name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(content)) return [];

  return (content as ContentBlock[])
    .filter((c): c is ToolCallBlock => c.type === "toolCall" && typeof c.name === "string")
    .map((c) => ({ name: c.name, arguments: c.arguments ?? {} }));
}

/** Extract the body from a `<distilled-summary>…</distilled-summary>` string. */
function extractDistilledBody(content: unknown): string {
  const text = typeof content === "string" ? content : "";
  const match = text.match(
    /<distilled-summary[^>]*>([\s\S]*?)<\/distilled-summary>/,
  );
  return match ? match[1].trim() : text.trim();
}

/**
 * Convert content entries into a JSON array of role-tagged messages, so the
 * summarizer parses the conversation structure unambiguously (no hallucinated
 * attribution).
 *
 * Roles: user, assistant (optionally with tool_calls), tool_result, and
 * distilled_summary (a previously distilled excerpt at this point).
 */
export function formatMessages(entries: AnyEntry[]): string {
  const messages: Array<Record<string, unknown>> = [];

  for (const e of entries) {
    if (e.type === "message") {
      const m = e as MessageEntry;
      const role = m.message.role;
      if (role === "user") {
        messages.push({ role: "user", content: extractText(m.message.content) });
      } else if (role === "assistant") {
        const text = extractText(m.message.content);
        const toolCalls = extractToolCalls(m.message.content);
        const msg: Record<string, unknown> = { role: "assistant", content: text };
        if (toolCalls.length > 0) {
          msg.tool_calls = toolCalls;
        }
        messages.push(msg);
      } else if (role === "toolResult") {
        const text = extractText(m.message.content);
        const preview =
          text.length > 500
            ? text.slice(0, 500) + `\n... (truncated ${text.length - 500} chars)`
            : text;
        const toolName = (m.message as Record<string, unknown>).toolName ?? "tool";
        messages.push({ role: "tool_result", name: toolName, content: preview });
      }
    } else if (
      e.type === "custom_message" &&
      (e as { customType?: string }).customType === "distilled-summary"
    ) {
      const body = extractDistilledBody((e as { content?: unknown }).content);
      messages.push({ role: "distilled_summary", content: body });
    }
  }

  return JSON.stringify(messages, null, 2);
}

// ---- prompt assembly ------------------------------------------------------

interface PromptOpts {
  backgroundText: string;
  compressedText: string;
  supplement?: string;
  contextOn: boolean;
}

/**
 * Build the final prompt by loading the template and substituting plain
 * `{{KEY}}` placeholders (BACKGROUND / CONVERSATION).
 *
 * The template author writes section headings directly in the template, with
 * the placeholder on the line below. If a value is empty, that placeholder
 * line AND the heading line above it are dropped, so empty sections vanish.
 *
 * The user supplement is optional and is appended at the very end by code.
 */
export function buildSummaryPrompt(opts: PromptOpts): string {
  const template = loadTemplate();

  const values: Record<string, string> = {
    BACKGROUND: (opts.backgroundText ?? "").trim(),
    CONVERSATION: (opts.compressedText ?? "").trim(),
  };

  // Render line by line: a line matching {{KEY}} is replaced by its value;
  // if the value is empty, drop the heading line above it too.
  const lines = template.split("\n");
  const rendered: string[] = [];
  for (const line of lines) {
    const m = /^\s*\{\{(\w+)\}\}\s*$/.exec(line);
    if (m) {
      const value = values[m[1]] ?? "";
      if (value) {
        rendered.push(value);
      } else if (rendered.length > 0) {
        rendered.pop(); // drop the heading line
      }
    } else {
      rendered.push(line);
    }
  }

  let out = rendered.join("\n");

  // User supplement is optional; appended last.
  const supplement = (opts.supplement ?? "").trim();
  if (supplement) {
    out += `\n\n在压缩时需要考虑用户额外补充的如下内容：\n${supplement}`;
  }

  return out.replace(/\n{3,}/g, "\n\n").trim();
}
