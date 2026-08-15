/**
 * Session file I/O utilities.
 *
 * The distill flow no longer renames old session files (renaming breaks the
 * parentSession link that pi's threaded session selector relies on). Instead
 * we keep the original path and either:
 *   - rewrite the header's parentSession so the old session points to the new
 *     one (making the newest session the tree root), or
 *   - delete the file when auto-clean is enabled.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

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
 * Delete a session file permanently.
 */
export function deleteSession(sessionPath: string): boolean {
  if (!existsSync(sessionPath)) return false;
  unlinkSync(sessionPath);
  return true;
}
