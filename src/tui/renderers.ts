/**
 * Custom TUI renderers for distilled-summary messages and distilled-archive entries.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

/**
 * Parse a `<distilled-summary turns="N" messages="M">…</distilled-summary>`
 * content string into its header metadata and body. Falls back to treating
 * the whole content as the body if the tag is absent.
 */
function parseSummary(content: string): {
  meta: { turns?: string; messages?: string };
  body: string;
} {
  const match = content.match(
    /<distilled-summary\s*([^>]*)>([\s\S]*?)<\/distilled-summary>/,
  );
  if (!match) {
    return { meta: {}, body: content.trim() };
  }

  const attrs: Record<string, string> = {};
  const attrRegex = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(match[1])) !== null) {
    attrs[m[1]] = m[2];
  }

  return {
    meta: { turns: attrs.turns, messages: attrs.messages },
    body: match[2].trim(),
  };
}

export function registerRenderers(pi: ExtensionAPI): void {
  // ---- distilled-summary: collapsed preview, expandable -------------------

  pi.registerMessageRenderer("distilled-summary", (message, { expanded, outputPad }, theme) => {
    const content = typeof message.content === "string"
      ? message.content
      : String(message.content);
    const { meta, body } = parseSummary(content);

    const headerParts = ["Distilled Summary"];
    if (meta.turns && meta.messages) {
      headerParts.push(`(${meta.turns} turns, ${meta.messages} messages)`);
    }
    const header = headerParts.join(" · ");

    if (!expanded) {
      // Collapsed: header + blank line + first few lines of the body.
      const lines = body.split("\n");
      const preview = lines.slice(0, 3).join("\n") + (lines.length > 3 ? "\n…" : "");
      const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(new Text(theme.fg("accent", theme.bold(header)), 0, 0));
      box.addChild(new Text("", 0, 0));
      box.addChild(new Text(preview, 0, 0));
      return box;
    }

    // Expanded: full body under the header, separated by a blank line.
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg("accent", theme.bold(header)), 0, 0));
    box.addChild(new Text("", 0, 0));
    for (const line of body.split("\n")) {
      box.addChild(new Text(line, 0, 0));
    }
    return box;
  });

  // NOTE: distilled-archive intentionally has NO entry renderer. It is a
  // data-only custom entry (original conversation text) consumed by the
  // view_distilled_context tool. Without a renderer, pi omits it from the
  // chat flow entirely, so it doesn't clutter the UI. The data is still
  // preserved and retrievable.
}
