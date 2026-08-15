/**
 * view_distilled_context — LLM-callable tool to retrieve archived conversation text.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function registerViewDistilledTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "view_distilled_context",
    label: "View distilled conversation",
    description:
      "Call when you need to review details of previously distilled conversations. Returns archived original content.",
    parameters: Type.Object({
      range: Type.Optional(
        Type.String({
          description: "Optional: label name to filter by specific distill range",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const entries = ctx.sessionManager.getEntries();

      // Find all distilled-archive entries
      let archives = entries.filter(
        (e: Record<string, unknown>) =>
          e.type === "custom" && (e as { customType?: string }).customType === "distilled-archive",
      );

      if (params.range) {
        archives = archives.filter((a: Record<string, unknown>) => {
          const data = (a as { data?: { range?: { startLabel?: string } } }).data;
          return data?.range?.startLabel === params.range;
        });
      }

      if (archives.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No distilled conversation archives found.",
            },
          ],
        };
      }

      const texts = archives.map((a: Record<string, unknown>) => {
        const data = (a as { data?: { conversations?: Array<{ role: string; content: string }>; range?: { startLabel?: string; endLabel?: string } } }).data;
        const header = `## Distilled range: ${data?.range?.startLabel ?? "?"} → ${data?.range?.endLabel ?? "current"}`;
        const body = (data?.conversations ?? [])
          .map((c: { role: string; content: string }) => `[${c.role}]: ${c.content}`)
          .join("\n\n");
        return `${header}\n\n${body}`;
      });

      return {
        content: [
          {
            type: "text",
            text: texts.join("\n\n---\n\n"),
          },
        ],
      };
    },
  });
}
