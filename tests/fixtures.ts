/**
 * Test fixtures for prompt benchmarking.
 *
 * Each fixture is a hand-built conversation (MessageEntry chain) plus a set
 * of "facts" that a good summary MUST preserve. The bench script checks
 * whether each fact's keyword appears in the generated summary.
 */

export interface Fact {
  /** Human-readable description of the fact. */
  label: string;
  /** Keywords that must appear in the summary (case-insensitive). */
  keywords: string[];
}

export interface Fixture {
  name: string;
  scene: "code" | "qa" | "mixed";
  /** Background context (before the compressed range). */
  background: MessageEntry[];
  /** The conversation range to compress. */
  entries: MessageEntry[];
  facts: Fact[];
}

interface MessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: {
    role: string;
    content: unknown;
  };
}

let seq = 0;
function msg(role: string, content: string, parentId: string | null): MessageEntry {
  seq += 1;
  return {
    type: "message",
    id: `m${seq}`,
    parentId,
    timestamp: new Date(Date.now() + seq * 1000).toISOString(),
    message: { role, content },
  };
}

// ---- Fixture A: code development -----------------------------------------
// Contains: goal, file paths, implemented solution, a failed approach +
// reason, a user veto, a "don't repeat" lesson, a tool call.

const fa: Fixture = {
  name: "A-code-dev",
  scene: "code",
  background: [
    msg("user", "我们给 distill 加一个自动清理日志目录的功能吧。", null),
    msg(
      "assistant",
      "好的。目前日志写在 distill/logs/ 下，由 logPrompt() 每次压缩时写入。清理逻辑可以放在压缩流程的末尾。",
      "m1",
    ),
  ],
  entries: [
    msg(
      "user",
      "可以。我考虑过用定时任务（cron）每天清理一次，但那样日志可能积压一天，而且依赖系统调度，不太可控。直接在做压缩的时候顺便清理吧。",
      "m2",
    ),
    msg(
      "assistant",
      "明白，不用定时任务。我先试一个方案：在 executeCompact() 的开头清理，把 5 天前的日志删掉。",
      "m3",
    ),
    msg(
      "assistant",
      "方案 B 实现到一半发现有问题：在压缩开头清理的话，本次压缩要写入的日志还没写，清理时机太早，而且如果压缩中途失败，日志目录已经被动过了。",
      "m4",
    ),
    msg(
      "user",
      "对，那就改成：写完日志之后再清理。另外日志目录路径别写死，抽成常量 LOG_DIR。保留最近 5 个文件就够了。",
      "m5",
    ),
    msg(
      "assistant",
      "完成：新增 LOG_DIR 常量（distill/src/engine/prompt.ts），在 logPrompt() 写入后调用 cleanOldLogs()，保留最近 5 个日志文件。",
      "m6",
    ),
  ],
  facts: [
    { label: "目标：压缩时顺便清理日志", keywords: ["清理"] },
    { label: "用户否决定时任务方案", keywords: ["定时", "cron"] },
    { label: "失败方案B及原因（清理时机太早）", keywords: ["时机", "太早"] },
    { label: "日志写入后再清理", keywords: ["写", "后"] },
    { label: "LOG_DIR 常量", keywords: ["LOG_DIR"] },
    { label: "保留最近 5 个文件", keywords: ["5"] },
  ],
};

// ---- Fixture B: Q&A / consultation ---------------------------------------
// Contains: a wrong assumption corrected, a conclusion reached, and a
// supplementary fact the user confirmed.

const fb: Fixture = {
  name: "B-qa",
  scene: "qa",
  background: [],
  entries: [
    msg("user", "distill 压缩对话的时候，信息是不是直接就丢了？", null),
    msg(
      "assistant",
      "不会。压缩是有损的——细节会变少，但摘要会替换原文留在会话里，而且归档的原文可以通过 view_distilled_context 工具随时查回。",
      "m1",
    ),
    msg("user", "哦，所以是『摘要 + 原文存档』配套的，不是简单丢弃。", "m2"),
    msg(
      "assistant",
      "对。另外补充一点：分支（branch）里的内容不会进摘要，而是作为独立分支保留在新会话里，不会被合并掉。",
      "m3",
    ),
    msg("user", "明白了，这个设计合理。", "m4"),
  ],
  facts: [
    { label: "压缩是有损的", keywords: ["有损"] },
    { label: "可用工具查看原文", keywords: ["view_distilled_context", "原文"] },
    { label: "摘要替换原文", keywords: ["替换"] },
    { label: "分支内容保留", keywords: ["分支"] },
  ],
};

// ---- Fixture C: mixed multi-front + emotion ------------------------------
// Two interleaved task lines + chit-chat + emotional exchange. Tests whether
// the summary separates fronts and keeps the human element.

const fc: Fixture = {
  name: "C-mixed",
  scene: "mixed",
  background: [
    msg("user", "上次说好要重构 session-io 模块，还有加一个导出功能，都还没动。", null),
  ],
  entries: [
    msg("user", "在吗？今天天气不错哈哈。", "m1"),
    msg("assistant", "在的！确实，秋高气爽。我们继续上次的重构吧，session-io 和导出功能两件事。", "m2"),
    msg("user", "对。先做 session-io 重构，导出功能之后再说。", "m3"),
    msg(
      "assistant",
      "session-io 重构完成了：把读写逻辑拆成 readSession / writeSession 两个函数，顺便修了编码问题。",
      "m4",
    ),
    msg("user", "好。那导出功能呢？", "m5"),
    msg(
      "assistant",
      "导出功能卡住了：想用 HTML 模板导出，但模板里的中文在浏览器里乱码，怀疑是编码声明问题，还没定位到。",
      "m6",
    ),
    msg("user", "行，不着急。真的谢谢你，帮我省了好多事。", "m7"),
    msg("assistant", "不客气！随时找我 😄", "m8"),
  ],
  facts: [
    { label: "Front A：session-io 重构完成", keywords: ["session-io", "重构"] },
    { label: "拆成 readSession/writeSession", keywords: ["readSession", "writeSession"] },
    { label: "Front B：导出功能卡在 HTML 乱码", keywords: ["导出", "乱码"] },
    { label: "用户表达感谢（情绪保留）", keywords: ["谢谢", "感谢", "致谢", "寒暄"] },
  ],
};

export const fixtures: Fixture[] = [fa, fb, fc];
