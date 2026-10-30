/**
 * Session file I/O utilities.
 *
 * The distill flow no longer renames old session files (renaming breaks the
 * parentSession link that pi's threaded session selector relies on). Instead
 * we keep the original path and either:
 *   - rewrite the header's parentSession so the old session points to the new
 *     one (making the newest session the tree root), or
 *   - move the file to the project-local trash dir (cwd/.pi/distill/trash)
 *     when the session is replaced in place / auto-cleaned.
 *
 * Logs and trash live under `<cwd>/.pi/distill/`. Config has three layers:
 * the legacy `<extension>/config.json`, the stable user-level
 * `<agentDir>/distill/config.json`, and the optional project override
 * `<cwd>/.pi/distill/config.json`.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** How many prompt logs to keep (oldest are pruned on each write). */
export const LOG_KEEP = 10;

/** Project-local runtime directory: `<cwd>/.pi/distill`. */
export function distillDirFor(cwd: string): string {
  return join(cwd, ".pi", "distill");
}

/** Extension installation directory (the folder containing index.ts). */
export function extensionDir(): string {
  return join(__dirname, "..", "..");
}

/** Log directory for generated summary prompts. */
export function logDirFor(cwd: string): string {
  return join(distillDirFor(cwd), "logs");
}

/** Trash directory for replaced/auto-cleaned session files. */
export function trashDirFor(cwd: string): string {
  return join(distillDirFor(cwd), "trash");
}

/** Project-level config override: `<cwd>/.pi/distill/config.json`. */
export function projectConfigPath(cwd: string): string {
  return join(distillDirFor(cwd), "config.json");
}

/** Extension-level shared config: `<extension>/config.json`. */
export function extensionConfigPath(): string {
  return join(extensionDir(), "config.json");
}

/**
 * Stable user-level config: `<agentDir>/distill/config.json`.
 *
 * `getAgentDir()` honors `PI_CODING_AGENT_DIR` (default `~/.pi/agent`), so
 * this location survives extension updates/reinstalls — unlike a config file
 * stored inside the package checkout.
 */
export function globalConfigPath(): string {
  return join(getAgentDir(), "distill", "config.json");
}

/**
 * The config file settings commands write to: the project override when it
 * exists, otherwise the stable user-level global config.
 */
export function configPathFor(cwd: string): string {
  return existsSync(projectConfigPath(cwd))
    ? projectConfigPath(cwd)
    : globalConfigPath();
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Rewrite a session header so `parentSession` points to `parentPath`.
 *
 * pi's threaded session selector builds its tree from the `parentSession`
 * field (child → parent, rendered parent-on-top). To make the *newest* session
 * the root, we point the OLD session at the NEW one. This is an intentional
 * inversion of the field's original "ancestor" semantics for UX reasons.
 */
export function setParentSession(sessionFile: string, parentPath: string): void {
  if (!existsSync(sessionFile)) return;

  const lines = readFileSync(sessionFile, "utf8").split("\n");
  const headerIdx = lines.findIndex((line) => {
    if (!line.trim()) return false;
    try {
      return JSON.parse(line).type === "session";
    } catch {
      return false;
    }
  });

  if (headerIdx === -1) return;

  const header = JSON.parse(lines[headerIdx]);
  header.parentSession = parentPath;
  lines[headerIdx] = JSON.stringify(header);

  writeFileSync(sessionFile, lines.join("\n"));
}

/**
 * Move a session file into `trashDir` instead of deleting it, so an
 * accidental replacement/auto-clean can still be recovered. The file leaves
 * the session directory, which removes it from pi's session tree.
 *
 * Returns the trash path on success, or undefined when the source is missing.
 * Falls back to copy + unlink if the rename crosses a filesystem boundary.
 */
export function trashSession(
  sessionPath: string,
  trashDir: string,
): string | undefined {
  if (!existsSync(sessionPath)) return undefined;
  ensureDir(trashDir);

  const base = sessionPath.split("/").pop() ?? "session.jsonl";
  const stamp = Date.now();
  let target = join(trashDir, `${stamp}-${base}`);
  let n = 1;
  while (existsSync(target)) {
    target = join(trashDir, `${stamp}-${n}-${base}`);
    n++;
  }

  try {
    renameSync(sessionPath, target);
  } catch {
    // Cross-device (EXDEV) or other rename failure: copy then remove.
    try {
      copyFileSync(sessionPath, target);
      unlinkSync(sessionPath);
    } catch {
      return undefined;
    }
  }
  return target;
}
