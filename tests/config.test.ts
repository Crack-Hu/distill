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

interface LoadOptions {
  extensionConfigPath?: string;
  globalConfigPath?: string;
}

/** Load a temp project without falling back to the repo's or user's config. */
function load(cwd: string, options: LoadOptions = {}) {
  return loadConfig(cwd, {
    extensionConfigPath:
      options.extensionConfigPath ?? join(cwd, "no-extension-config.json"),
    globalConfigPath:
      options.globalConfigPath ?? join(cwd, "no-global-config.json"),
  });
}

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

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("defaults use distill_model=inherit", () => {
  const cwd = tempDir("distill-config-empty-");
  try {
    const config = load(cwd);
    assert.equal(config.distill_model, "inherit");
    assert.equal(config.summaryModel, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("legacy summaryModel migrates to distill_model", () => {
  withConfig({ summaryModel: "legacy/model", contextOn: true }, (cwd) => {
    const config = load(cwd);
    assert.equal(config.distill_model, "legacy/model");
    assert.equal(config.summaryModel, undefined);
    assert.equal(config.contextOn, true);
  });
});

test("distill_model wins when both fields are present", () => {
  withConfig(
    { distill_model: "new/model", summaryModel: "legacy/model" },
    (cwd) => {
      const config = load(cwd);
      assert.equal(config.distill_model, "new/model");
      assert.equal(config.summaryModel, undefined);
    },
  );
});

test("falls back to the extension config when project/global are missing", () => {
  const cwd = tempDir("distill-config-project-");
  const ext = tempDir("distill-config-ext-");
  try {
    const extConfig = join(ext, "config.json");
    writeFileSync(
      extConfig,
      JSON.stringify({
        autoClean: true,
        distill_model: "global/model",
        contextOn: true,
        suggest: {
          baseUrl: "https://api.example.com",
          model: "global-model",
          apiKeyEnv: "GLOBAL_KEY",
        },
      }),
    );

    const config = load(cwd, { extensionConfigPath: extConfig });
    assert.equal(config.autoClean, true);
    assert.equal(config.distill_model, "global/model");
    assert.equal(config.contextOn, true);
    assert.equal(config.suggest?.baseUrl, "https://api.example.com");
    assert.equal(config.suggest?.model, "global-model");
    assert.equal(config.suggest?.apiKeyEnv, "GLOBAL_KEY");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
  }
});

test("falls back to the stable user-level global config", () => {
  const cwd = tempDir("distill-config-project-");
  const globalDir = tempDir("distill-config-global-");
  try {
    const globalConfig = join(globalDir, "config.json");
    writeFileSync(
      globalConfig,
      JSON.stringify({
        distill_model: "user/model",
        suggest: {
          baseUrl: "https://api.example.com",
          model: "user-model",
          apiKeyEnv: "USER_KEY",
        },
      }),
    );

    const config = load(cwd, { globalConfigPath: globalConfig });
    assert.equal(config.distill_model, "user/model");
    assert.equal(config.suggest?.baseUrl, "https://api.example.com");
    assert.equal(config.suggest?.model, "user-model");
    assert.equal(config.suggest?.apiKeyEnv, "USER_KEY");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("precedence is project > global > extension and suggest is deep-merged", () => {
  const cwd = tempDir("distill-config-project-");
  const ext = tempDir("distill-config-ext-");
  const globalDir = tempDir("distill-config-global-");
  try {
    const extConfig = join(ext, "config.json");
    writeFileSync(
      extConfig,
      JSON.stringify({
        autoClean: true,
        distill_model: "ext/model",
        suggest: {
          baseUrl: "https://ext.example.com",
          model: "ext-model",
          maxTokens: 111,
        },
      }),
    );

    const globalConfig = join(globalDir, "config.json");
    writeFileSync(
      globalConfig,
      JSON.stringify({
        autoClean: false,
        distill_model: "global/model",
        contextOn: true,
        suggest: {
          model: "global-model",
          apiKeyEnv: "GLOBAL_KEY",
        },
      }),
    );

    const projectDir = join(cwd, ".pi", "distill");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "config.json"),
      JSON.stringify({
        distill_model: "project/model",
        suggest: { model: "project-model" },
      }),
    );

    const config = load(cwd, {
      extensionConfigPath: extConfig,
      globalConfigPath: globalConfig,
    });
    assert.equal(config.distill_model, "project/model");
    assert.equal(config.autoClean, false);
    assert.equal(config.contextOn, true);
    // Lowest layer supplies baseUrl/maxTokens; higher layers override model
    // and add apiKeyEnv.
    assert.equal(config.suggest?.baseUrl, "https://ext.example.com");
    assert.equal(config.suggest?.maxTokens, 111);
    assert.equal(config.suggest?.apiKeyEnv, "GLOBAL_KEY");
    assert.equal(config.suggest?.model, "project-model");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  }
});

test("malformed project config falls back to global/extension config", () => {
  const cwd = tempDir("distill-config-project-");
  const ext = tempDir("distill-config-ext-");
  const globalDir = tempDir("distill-config-global-");
  try {
    const extConfig = join(ext, "config.json");
    writeFileSync(extConfig, JSON.stringify({ contextOn: false }));

    const globalConfig = join(globalDir, "config.json");
    writeFileSync(
      globalConfig,
      JSON.stringify({ distill_model: "global/model", contextOn: true }),
    );

    const projectDir = join(cwd, ".pi", "distill");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "config.json"), "{ not json");

    const config = load(cwd, {
      extensionConfigPath: extConfig,
      globalConfigPath: globalConfig,
    });
    assert.equal(config.distill_model, "global/model");
    assert.equal(config.contextOn, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  }
});
