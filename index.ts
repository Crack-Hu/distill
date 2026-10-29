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
import { registerSuggestLabelCommand } from "./src/commands/suggest-label";
import { registerViewDistilledTool } from "./src/tools/view-distilled";

export default function (pi: ExtensionAPI) {
  // Register the /distill command
  registerDistillCommand(pi);

  // Register the LLM-assisted label suggestion command
  registerSuggestLabelCommand(pi);

  // Guard distilled sessions (read-only, fork on first message)
  registerSessionGuards(pi);

  // Register the LLM-callable tool for viewing archived context
  registerViewDistilledTool(pi);
}
