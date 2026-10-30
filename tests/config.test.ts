/**
 * Config loading and legacy-field migration tests.
 *
 * Run:  bun test tests/config.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/commands/distill";

function withConfig(config: unknown, fn: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "distill-config-"));
  try {
    const dir = join(cwd, ".pi", "distill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("defaults use distill_model=inherit", () => {
  const cwd = mkdtempSync(join(tmpdir(), "distill-config-empty-"));
  try {
    const config = loadConfig(cwd);
    assert.equal(config.distill_model, "inherit");
    assert.equal(config.summaryModel, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("legacy summaryModel migrates to distill_model", () => {
  withConfig({ summaryModel: "legacy/model", contextOn: true }, (cwd) => {
    const config = loadConfig(cwd);
    assert.equal(config.distill_model, "legacy/model");
    assert.equal(config.summaryModel, undefined);
    assert.equal(config.contextOn, true);
  });
});

test("distill_model wins when both fields are present", () => {
  withConfig(
    { distill_model: "new/model", summaryModel: "legacy/model" },
    (cwd) => {
      const config = loadConfig(cwd);
      assert.equal(config.distill_model, "new/model");
      assert.equal(config.summaryModel, undefined);
    },
  );
});
