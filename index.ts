/**
 * Distill — manual context compression extension for pi.
 *
 * Distill selected conversation ranges into AI summaries and rebuild
 * the session, greatly reducing context length.
 *
 * Labels: pi native /tree → shift+L (yellow label nodes)
 * Distill:  /distill <label> [supplement]  or  /distill <label1> <label2> [supplement]
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerDistillCommand, registerSessionGuards } from "./src/commands/distill";
import { registerViewDistilledTool } from "./src/tools/view-distilled";
import { registerRenderers } from "./src/tui/renderers";

export default function (pi: ExtensionAPI) {
  // Register TUI renderers for distilled-summary and distilled-archive
  registerRenderers(pi);

  // Register the /distill command
  registerDistillCommand(pi);

  // Guard distilled sessions (read-only, fork on first message)
  registerSessionGuards(pi);

  // Register the LLM-callable tool for viewing archived context
  registerViewDistilledTool(pi);
}
