/**
 * Unit tests for the compact transcript builder, prompt renderer, label
 * numbering, and suggestion parser used by /distill suggest_lab.
 *
 * Run:  bun test tests/suggest.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  buildSuggestPrompt,
  buildSuggestTranscript,
  buildSuggestionRequestBody,
  formatSuggestTranscript,
  modelsUrl,
  nextSuggestLabelName,
  parseModelIds,
  parseSuggestion,
} from "../src/engine/suggest";

function makeSession(): SessionManager {
  return SessionManager.inMemory("suggest-test");
}

function msg(sm: SessionManager, role: "user" | "assistant", text: string): string {
  return sm.appendMessage({
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as any);
}

function summary(sm: SessionManager, text = "old summary"): string {
  return sm.appendMessage({
    role: "compactionSummary",
    summary: `<distilled-summary>${text}</distilled-summary>`,
    tokensBefore: 0,
    timestamp: Date.now(),
  } as any);
}

function toolResult(sm: SessionManager, text: string): string {
  return sm.appendMessage({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    isError: false,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as any);
}

function toolCall(sm: SessionManager, name = "read"): string {
  return sm.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "Let me read the file." },
      { type: "toolCall", id: "call-1", name, arguments: {} },
    ],
    timestamp: Date.now(),
  } as any);
}

// ---- transcript building --------------------------------------------------

test("keeps user messages and only the final assistant text per turn", () => {
  const sm = makeSession();
  const u1 = msg(sm, "user", "u1");
  msg(sm, "assistant", "intermediate narration");
  toolResult(sm, "TOOL OUTPUT MUST NOT APPEAR");
  msg(sm, "assistant", "final answer one");
  const u2 = msg(sm, "user", "u2");
  toolCall(sm);
  msg(sm, "assistant", "final answer two");

  const transcript = buildSuggestTranscript(sm);
  assert.equal(transcript.turns.length, 2);

  assert.equal(transcript.turns[0].entryId, u1);
  assert.equal(transcript.turns[0].userText, "u1");
  assert.equal(transcript.turns[0].assistantText, "final answer one");

  assert.equal(transcript.turns[1].entryId, u2);
  assert.equal(transcript.turns[1].userText, "u2");
  assert.equal(transcript.turns[1].assistantText, "final answer two");

  const text = formatSuggestTranscript(transcript.turns);
  assert.ok(!text.includes("intermediate narration"), "intermediate text omitted");
  assert.ok(!text.includes("TOOL OUTPUT"), "tool output omitted");
  assert.ok(!text.includes("Let me read the file."), "tool-call narration omitted");
});

test("a previously summarized section becomes a placeholder", () => {
  const sm = makeSession();
  msg(sm, "user", "before summary");
  msg(sm, "assistant", "before summary answer");
  const s = summary(sm, "SECRET ARCHIVED DETAILS");
  msg(sm, "user", "after summary");
  msg(sm, "assistant", "after summary answer");

  const transcript = buildSuggestTranscript(sm);
  assert.equal(transcript.turns.length, 3);
  assert.equal(transcript.turns[1].kind, "summary");
  assert.equal(transcript.turns[1].entryId, s);

  const text = formatSuggestTranscript(transcript.turns);
  assert.ok(text.includes("previously summarized section — content omitted"));
  assert.ok(!text.includes("SECRET ARCHIVED DETAILS"), "summary body omitted");
});

test("turn indexes are 1-based and skip prelude-only entries", () => {
  const sm = makeSession();
  msg(sm, "user", "first");
  msg(sm, "assistant", "first answer");
  msg(sm, "user", "second");
  msg(sm, "assistant", "second answer");

  const transcript = buildSuggestTranscript(sm);
  assert.deepEqual(
    transcript.turns.map((t) => t.index),
    [1, 2],
  );
});

test("per-message truncation caps the transcript size", () => {
  const sm = makeSession();
  msg(sm, "user", "x".repeat(500));
  msg(sm, "assistant", "y".repeat(500));

  const transcript = buildSuggestTranscript(sm, { maxCharsPerMessage: 120 });
  assert.ok(transcript.turns[0].userText.includes("truncated 380 chars"));
  assert.ok(transcript.turns[0].assistantText.includes("truncated 380 chars"));
});

test("collects active labels for numbering without exposing them to the model", () => {
  const sm = makeSession();
  const u1 = msg(sm, "user", "u1");
  msg(sm, "assistant", "a1");
  const u2 = msg(sm, "user", "u2");

  sm.appendLabelChange(u1, "old-label");
  sm.appendLabelChange(u2, "removed-label");
  sm.appendLabelChange(u2, undefined);

  const transcript = buildSuggestTranscript(sm);
  assert.deepEqual(transcript.existingLabels, ["old-label"]);

  const text = formatSuggestTranscript(transcript.turns);
  assert.ok(!text.includes("old-label"), "existing labels stay out of the prompt");
  assert.ok(!text.includes("existing label"), "no existing-label marker");
});

// ---- naming ---------------------------------------------------------------

test("nextSuggestLabelName starts at suggest-1", () => {
  assert.equal(nextSuggestLabelName([]), "suggest-1");
});

test("nextSuggestLabelName uses the highest numeric suffix", () => {
  assert.equal(nextSuggestLabelName(["suggest-1"]), "suggest-2");
  assert.equal(nextSuggestLabelName(["suggest-2", "suggest-7"]), "suggest-8");
  assert.equal(nextSuggestLabelName(["Suggest-3"]), "suggest-4");
});

test("nextSuggestLabelName ignores non-numeric suggest names", () => {
  assert.equal(nextSuggestLabelName(["suggest-foo", "other"]), "suggest-1");
  assert.equal(nextSuggestLabelName(["suggest-x", "suggest-2"]), "suggest-3");
});

// ---- prompt ---------------------------------------------------------------

test("prompt describes only the labeling task, not distill mechanics", () => {
  const sm = makeSession();
  msg(sm, "user", "implement the parser");
  msg(sm, "assistant", "done");
  sm.appendLabelChange(sm.getLeafId()!, "existing");

  const transcript = buildSuggestTranscript(sm);
  const prompt = buildSuggestPrompt(transcript, "focus on debugging");

  assert.ok(prompt.includes("[Turn 1]"));
  assert.ok(prompt.includes("user: implement the parser"));
  assert.ok(prompt.includes("assistant final: done"));
  assert.ok(prompt.includes("用户的额外需求"));
  assert.ok(prompt.includes("focus on debugging"));
  assert.ok(prompt.includes('{"turn":12'));
  assert.ok(prompt.includes("压缩成摘要"));
  assert.ok(prompt.includes("减少上下文长度"));
  assert.ok(!prompt.includes("assistant 回复的中途"), "no impossible mid-reply target");
  assert.ok(!prompt.includes("/distill"), "no plugin command in prompt");
  assert.ok(!prompt.includes("distill"), "no plugin name in prompt");
  assert.ok(!prompt.includes("existing"), "existing labels are not sent");
});

test("empty user hint drops the 用户的额外需求 section", () => {
  const sm = makeSession();
  msg(sm, "user", "u1");
  msg(sm, "assistant", "a1");

  const prompt = buildSuggestPrompt(buildSuggestTranscript(sm));
  assert.ok(!prompt.includes("用户的额外需求"));
});

// ---- response parsing -----------------------------------------------------

function turnsFor(sm: SessionManager) {
  return buildSuggestTranscript(sm).turns;
}

test("parses a valid suggestion and maps the turn to an entry id", () => {
  const sm = makeSession();
  const u1 = msg(sm, "user", "u1");
  msg(sm, "assistant", "a1");
  const u2 = msg(sm, "user", "u2");
  msg(sm, "assistant", "a2");

  const turns = turnsFor(sm);
  const parsed = parseSuggestion(
    JSON.stringify({
      turn: 2,
      description: "从这一轮开始修复解析器，直到会话结束。\n涉及错误处理和测试。",
    }),
    turns,
  );

  assert.equal(parsed.kind, "label");
  if (parsed.kind !== "label") return;
  assert.equal(parsed.turn, 2);
  assert.equal(parsed.entryId, u2);
  assert.ok(parsed.description.includes("修复解析器"));
  assert.ok(!("label" in parsed), "the model does not name the label");
  assert.notEqual(parsed.entryId, u1);
});

test("accepts JSON wrapped in a markdown code fence", () => {
  const sm = makeSession();
  msg(sm, "user", "u1");
  msg(sm, "assistant", "a1");

  const parsed = parseSuggestion(
    'Here it is:\n```json\n{"turn":1,"description":"one. two. three."}\n```',
    turnsFor(sm),
  );
  assert.equal(parsed.kind, "label");
  if (parsed.kind === "label") assert.equal(parsed.turn, 1);
});

test("returns none when the model declines", () => {
  const sm = makeSession();
  msg(sm, "user", "u1");
  msg(sm, "assistant", "a1");

  const parsed = parseSuggestion(
    '{"turn":null,"reason":"too short to split"}',
    turnsFor(sm),
  );
  assert.deepEqual(parsed, { kind: "none", reason: "too short to split" });
});

test("rejects an out-of-range turn", () => {
  const sm = makeSession();
  msg(sm, "user", "u1");
  msg(sm, "assistant", "a1");

  assert.throws(
    () => parseSuggestion('{"turn":9,"description":"a. b. c."}', turnsFor(sm)),
    /out of range/,
  );
});

test("rejects a missing description and invalid JSON", () => {
  const sm = makeSession();
  msg(sm, "user", "u1");
  msg(sm, "assistant", "a1");

  assert.throws(
    () => parseSuggestion('{"turn":1}', turnsFor(sm)),
    /description/,
  );

  assert.throws(
    () => parseSuggestion("not json at all", turnsFor(sm)),
    /did not contain a JSON object|JSON is invalid/,
  );
});

test("does not reject a target that already has a label", () => {
  const sm = makeSession();
  const u1 = msg(sm, "user", "u1");
  msg(sm, "assistant", "a1");
  sm.appendLabelChange(u1, "already-labeled");

  const parsed = parseSuggestion(
    '{"turn":1,"description":"a. b. c."}',
    turnsFor(sm),
  );
  assert.equal(parsed.kind, "label");
  if (parsed.kind === "label") assert.equal(parsed.entryId, u1);
});

test("request body forwards thinking fields verbatim and omits unset ones", () => {
  const base = { baseUrl: "https://api.deepseek.com", model: "deepseek-flash" };

  const plain = buildSuggestionRequestBody("prompt", base);
  assert.equal("thinking" in plain, false);
  assert.equal("reasoning_effort" in plain, false);
  assert.equal(plain.max_tokens, 2048);
  assert.equal(plain.temperature, 0.2);

  const disabled = buildSuggestionRequestBody("prompt", {
    ...base,
    thinking: "disabled",
  });
  assert.deepEqual(disabled.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in disabled, false);

  const boolDisabled = buildSuggestionRequestBody("prompt", {
    ...base,
    thinking: false,
  });
  assert.deepEqual(boolDisabled.thinking, { type: "disabled" });

  const boolEnabled = buildSuggestionRequestBody("prompt", {
    ...base,
    thinking: true,
  });
  assert.deepEqual(boolEnabled.thinking, { type: "enabled" });

  const low = buildSuggestionRequestBody("prompt", {
    ...base,
    reasoningEffort: "low",
  });
  assert.equal(low.reasoning_effort, "low");
  assert.equal("thinking" in low, false);

  const both = buildSuggestionRequestBody("prompt", {
    ...base,
    thinking: "disabled",
    reasoningEffort: "max",
  });
  assert.deepEqual(both.thinking, { type: "disabled" });
  assert.equal(both.reasoning_effort, "max");
});

test("request body treats blank thinking fields as unset", () => {
  const body = buildSuggestionRequestBody("prompt", {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    thinking: "  " as any,
    reasoningEffort: "  ",
  });
  assert.equal("thinking" in body, false);
  assert.equal("reasoning_effort" in body, false);
});

test("modelsUrl handles base URLs and full completions URLs", () => {
  assert.equal(
    modelsUrl("https://api.deepseek.com"),
    "https://api.deepseek.com/models",
  );
  assert.equal(
    modelsUrl("https://api.deepseek.com/"),
    "https://api.deepseek.com/models",
  );
  assert.equal(
    modelsUrl("https://api.deepseek.com/v1"),
    "https://api.deepseek.com/v1/models",
  );
  assert.equal(
    modelsUrl("https://api.deepseek.com/chat/completions"),
    "https://api.deepseek.com/models",
  );
  assert.equal(
    modelsUrl("https://api.deepseek.com/v1/chat/completions/"),
    "https://api.deepseek.com/v1/models",
  );
});

test("parseModelIds dedupes, sorts, and ignores invalid entries", () => {
  assert.deepEqual(
    parseModelIds({
      data: [
        { id: "deepseek-v4-pro" },
        { id: "deepseek-flash" },
        { id: "deepseek-flash" },
        { id: 42 },
        {},
        null,
      ],
    }),
    ["deepseek-flash", "deepseek-v4-pro"],
  );
  assert.deepEqual(parseModelIds({}), []);
  assert.deepEqual(parseModelIds(null), []);
});
