/**
 * Tests for the shared progress overlay used by summary generation and
 * /distill suggest_lab. Locks down the visual shape (title/message/model/cancel
 * hint) so both callers stay in the same style.
 *
 * Run:  bun test tests/progress.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ProgressDialog } from "../src/ui/progress";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
} as any;

const tui = {
  requestRender() {},
} as any;

function keybindings(matches = false) {
  return {
    matches: (_data: string, key: string) =>
      matches && key === "tui.select.cancel",
    getKeys: (_key: string) => ["esc"],
  } as any;
}

function makeDialog(
  generation: Promise<unknown> = new Promise(() => {}),
  done: (result: "done" | "cancel") => void = () => {},
  matches = false,
) {
  return new ProgressDialog(
    tui,
    theme,
    keybindings(matches),
    generation,
    {
      title: "Suggesting a label",
      message: "Analyzing the conversation…",
      modelLabel: "deepseek-flash",
    },
    done,
  );
}

test("renders the shared progress-dialog style", () => {
  const dialog = makeDialog();
  try {
    const text = dialog.render(80).join("\n");
    assert.ok(text.includes("Suggesting a label"), "title in the top rule");
    assert.ok(text.includes("Analyzing the conversation…"), "spinner line");
    assert.ok(text.includes("Model: deepseek-flash"), "model line");
    assert.ok(text.includes("esc to cancel"), "cancel hint");
    assert.ok(text.includes("┌─"), "top border");
    assert.ok(text.includes("└"), "bottom border");
  } finally {
    dialog.dispose();
  }
});

test("Esc closes the dialog with cancel", () => {
  let result: "done" | "cancel" | undefined;
  const dialog = makeDialog(new Promise(() => {}), (r) => {
    result = r;
  }, true);
  try {
    dialog.handleInput("\x1b");
    assert.equal(result, "cancel");
  } finally {
    dialog.dispose();
  }
});

test("a settled generation closes the dialog with done", async () => {
  let resolve!: () => void;
  const generation = new Promise<void>((r) => {
    resolve = r;
  });
  let result: "done" | "cancel" | undefined;
  const dialog = makeDialog(generation, (r) => {
    result = r;
  });
  try {
    resolve();
    await generation;
    await Promise.resolve();
    assert.equal(result, "done");
  } finally {
    dialog.dispose();
  }
});
