/**
 * Prompt benchmarking script for the distill extension.
 *
 * Sends different versions of the summary prompt template + the same test
 * conversations to an LLM, then compares the generated summaries:
 *   - fact coverage (does the summary preserve the facts that matter?)
 *   - verbosity stats (chars / lines)
 *   - stability across rounds (model output is stochastic)
 *
 * Usage (from distill/):
 *   bun tests/bench.ts                     # run all templates × all fixtures
 *   bun tests/bench.ts --rounds 3          # run 3 rounds for stability
 *   bun tests/bench.ts --dry               # render prompts only, no API calls
 *   bun tests/bench.ts --model hepai/deepseek-v4-flash
 *   bun tests/bench.ts --template v1       # only a specific template file
 *   bun tests/bench.ts --fixture A         # only a specific fixture (prefix match)
 *
 * Results are saved to tests/output/.
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { complete } from "@earendil-works/pi-ai/compat";
import { formatMessages } from "../src/engine/prompt";
import { fixtures, type Fixture } from "./fixtures";
import { realFixture } from "./fixtures-real";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "prompts");
const OUTPUT_DIR = join(__dirname, "output");
const MODELS_JSON = join(homedir(), ".pi", "agent", "models.json");

// ---- CLI args --------------------------------------------------------------

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const argValue = (flag: string) => {
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.split("=")[1];
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
};
const modelArg = argValue("--model") ?? "deepseek/deepseek-v4-flash";
const templateFilter = argValue("--template");
const fixtureFilter = argValue("--fixture");
const rounds = Math.max(1, parseInt(argValue("--rounds") ?? "1", 10));
const formatArg = argValue("--format") ?? "text";

// ---- template rendering (mirror of src/engine/prompt.ts buildSummaryPrompt,
//      but with a parameterizable template string) ---------------------------

interface RenderOpts {
  backgroundText: string;
  compressedText: string;
}

function renderTemplate(template: string, opts: RenderOpts): string {
  const values: Record<string, string> = {
    BACKGROUND: (opts.backgroundText ?? "").trim(),
    CONVERSATION: (opts.compressedText ?? "").trim(),
  };

  const lines = template.split("\n");
  const rendered: string[] = [];
  for (const line of lines) {
    const m = /^\s*\{\{(\w+)\}\}\s*$/.exec(line);
    if (m) {
      const value = values[m[1]] ?? "";
      if (value) {
        rendered.push(value);
      } else if (rendered.length > 0) {
        rendered.pop(); // drop the heading line
      }
    } else {
      rendered.push(line);
    }
  }
  return rendered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- model construction from ~/.pi/agent/models.json -----------------------

interface ModelJson {
  providers: Record<
    string,
    {
      baseUrl: string;
      api: string;
      apiKey: string;
      compat?: Record<string, unknown>;
      models: Array<Record<string, unknown> & { id: string }>;
    }
  >;
}

function resolveEnvKey(s: string): string {
  const m = /^\$(\w+)$/.exec(s.trim());
  if (!m) return s;
  return process.env[m[1]] ?? "";
}

function buildModel(spec: string) {
  const [providerName, ...modelParts] = spec.split("/");
  const modelId = modelParts.join("/");

  const cfg = JSON.parse(readFileSync(MODELS_JSON, "utf8")) as ModelJson;
  const provider = cfg.providers[providerName];
  if (!provider) throw new Error(`Provider "${providerName}" not found in ${MODELS_JSON}`);
  const mc = provider.models.find((m) => m.id === modelId);
  if (!mc) throw new Error(`Model "${modelId}" not found for provider "${providerName}"`);

  return {
    model: {
      id: mc.id,
      name: (mc.name as string) ?? mc.id,
      api: provider.api,
      provider: providerName,
      baseUrl: provider.baseUrl,
      reasoning: (mc.reasoning as boolean) ?? false,
      input: (mc.input as string[]) ?? ["text"],
      cost: (mc.cost as object) ?? {},
      contextWindow: (mc.contextWindow as number) ?? 128000,
      maxTokens: (mc.maxTokens as number) ?? 8192,
      compat: mc.compat ?? provider.compat,
    },
    apiKey: resolveEnvKey(provider.apiKey),
  };
}

// ---- message rendering: text (production format) vs json (structured) ------

interface TextBlock {
  type: "text";
  text: string;
}
interface ToolCallBlock {
  type: "toolCall";
  id?: string;
  name: string;
  arguments?: Record<string, unknown>;
}

type ContentBlock = TextBlock | ToolCallBlock;

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .filter((c): c is TextBlock => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

function extractToolCalls(content: unknown): ToolCallBlock[] {
  if (!Array.isArray(content)) return [];
  return (content as ContentBlock[]).filter(
    (c): c is ToolCallBlock => c.type === "toolCall" && typeof c.name === "string",
  );
}

/** JSON-array rendering: each entry becomes a structured object. */
function formatMessagesJson(entries: Array<Record<string, unknown>>): string {
  const arr: unknown[] = [];
  for (const e of entries) {
    if (e.type === "message") {
      const m = e.message as { role?: string; content?: unknown; toolName?: string };
      const role = m.role;
      if (role === "user") {
        arr.push({ role: "user", content: extractText(m.content) });
      } else if (role === "assistant") {
        const text = extractText(m.content);
        const tools = extractToolCalls(m.content);
        if (text) arr.push({ role: "assistant", content: text });
        for (const tc of tools) {
          arr.push({ role: "tool_call", name: tc.name, arguments: tc.arguments ?? {} });
        }
      } else if (role === "toolResult") {
        const text = extractText(m.content);
        const preview =
          text.length > 500
            ? text.slice(0, 500) + `... (truncated ${text.length - 500} chars)`
            : text;
        arr.push({ role: "tool_result", name: m.toolName ?? "tool", content: preview });
      }
    } else if (
      e.type === "custom_message" &&
      (e as { customType?: string }).customType === "distilled-summary"
    ) {
      const body = String((e as { content?: unknown }).content ?? "").trim();
      arr.push({ role: "distilled_summary", content: body });
    }
  }
  return JSON.stringify(arr);
}

// ---- fact checking ----------------------------------------------------------

function checkFacts(summary: string, fixture: Fixture) {
  const lower = summary.toLowerCase();
  return fixture.facts.map((f) => ({
    fact: f,
    hit: f.keywords.some((k) => lower.includes(k.toLowerCase())),
  }));
}

// ---- main -------------------------------------------------------------------

async function main() {
  const { model, apiKey } = buildModel(modelArg);
  console.log(`model: ${modelArg}  rounds: ${rounds}  format: ${formatArg}${DRY ? "  [DRY RUN — no API calls]" : ""}\n`);

  const templates = readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => !templateFilter || f.startsWith(templateFilter))
    .sort();
  if (templates.length === 0) throw new Error(`No templates in ${PROMPTS_DIR}`);

  const allFixtures: Fixture[] = [...fixtures, realFixture];
  const selectedFixtures = allFixtures.filter(
    (f) => !fixtureFilter || f.name.startsWith(fixtureFilter),
  );

  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Aggregated fact hits across rounds: key `${tpl}__${fixture}` → hits per fact
  const agg = new Map<string, number[]>();

  for (let round = 1; round <= rounds; round++) {
    if (rounds > 1) console.log(`\n===== ROUND ${round}/${rounds} =====`);

    for (const tplFile of templates) {
      const template = readFileSync(join(PROMPTS_DIR, tplFile), "utf8");
      const tplName = tplFile.replace(/\.md$/, "");

      for (const fixture of selectedFixtures) {
        const compressedText =
          formatArg === "json"
            ? formatMessagesJson(fixture.entries)
            : formatMessages(fixture.entries);
        const backgroundText = fixture.background.length > 0
          ? (formatArg === "json"
              ? formatMessagesJson(fixture.background)
              : formatMessages(fixture.background))
          : "";
        const prompt = renderTemplate(template, { backgroundText, compressedText });

        let summary = "";
        if (!DRY) {
          const resp = await complete(
            model,
            {
              messages: [
                {
                  role: "user" as const,
                  content: [{ type: "text" as const, text: prompt }],
                  timestamp: Date.now(),
                },
              ],
            },
            {
              apiKey,
              maxTokens: 4096,
              signal: new AbortController().signal,
              cacheRetention: "none",
              sessionId: crypto.randomUUID(),
            },
          );
          summary = resp.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n")
            .trim();
          if (!summary && (resp as { errorMessage?: string }).errorMessage) {
            console.log(`  [api error] ${(resp as { errorMessage?: string }).errorMessage}`);
          }
        }

        const results = checkFacts(summary, fixture);
        const covered = results.filter((r) => r.hit).length;
        const key = `${tplName}__${fixture.name}`;

        // Aggregate
        const prev = agg.get(key);
        if (prev) {
          results.forEach((r, i) => {
            if (r.hit) prev[i] += 1;
          });
        } else {
          agg.set(key, results.map((r) => (r.hit ? 1 : 0)));
        }

        // Save artifacts (every round, suffixed by round number)
        {
          const safe = key;
          writeFileSync(join(OUTPUT_DIR, `${safe}.prompt.txt`), prompt);
          writeFileSync(join(OUTPUT_DIR, `${safe}.summary.r${round}.txt`), summary || "(no summary)");
          if (round === 1) {
            writeFileSync(join(OUTPUT_DIR, `${safe}.summary.txt`), summary || "(no summary)");
            writeFileSync(
              join(OUTPUT_DIR, `${safe}.facts.json`),
              JSON.stringify(
                results.map((r) => ({ label: r.fact.label, hit: r.hit, keywords: r.fact.keywords })),
                null,
                2,
              ),
            );
          }
        }

        console.log(`=== ${key} [round ${round}] ===`);
        if (DRY) {
          console.log(`  prompt chars: ${prompt.length}`);
        } else {
          console.log(`  chars: ${summary.length}  lines: ${summary.split("\n").length}  coverage: ${covered}/${results.length}`);
          if (round === rounds) {
            for (const r of results) console.log(`  ${r.hit ? "✓" : "✗"} ${r.fact.label}`);
            console.log("  --- summary (first 400 chars) ---");
            console.log(summary.slice(0, 400));
            console.log("  --- end ---");
          }
        }
      }
    }
  }

  if (!DRY && rounds > 1) {
    console.log("\n===== STABILITY REPORT (hit rounds / total rounds) =====");
    for (const [key, hits] of agg) {
      const fixture = selectedFixtures.find((f) => key.endsWith(`__${f.name}`));
      if (!fixture) continue;
      console.log(`\n${key}`);
      fixture.facts.forEach((f, i) => {
        const mark = hits[i] === rounds ? "✓✓" : hits[i] > 0 ? "◐" : "✗✗";
        console.log(`  ${mark} ${f.label}  (${hits[i]}/${rounds})`);
      });
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
