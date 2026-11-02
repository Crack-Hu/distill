# AGENTS.md

Distill 是 pi 的上下文压缩扩展：用户用 `/tree` 给节点打 label，`/distill <label>` 把 label 到当前 leaf 的范围压成摘要并重建会话；`/distill suggest_lab` 用独立 LLM 按任务逻辑建议 label。核心是**用户显式选择压缩范围**，不做自动压缩。

## 导航

- 用户行为、命令、配置、运行时路径、限制：`README.md`
- 代码地图、测试说明、本地命令：`docs/CODE_MAP.md`
- Prompt 正文：`distill-summary-prompt*.md`、`distill-suggest-prompt.md`
- 引擎不变量：`tests/distill-engine.test.ts`、`tests/rebuild.test.ts`
- 配置行为：`tests/config.test.ts`
- 实现：`src/`

改行为前先读 README 对应章节；找代码先读 CODE_MAP。本文件只保留目的、导航和约束，不维护代码地图、测试清单或行为细节。冲突时以 README/测试为准。

## 约束

- 零依赖；只用 Node 内建模块和 pi 原生 API。
- 代码、标识符、代码注释用英文；README、prompt、用户文案用中文。
- 单测离线且确定：`SessionManager.inMemory()`、临时目录；配置测试显式覆盖 extension/global/project 路径，不读真实 `~/.pi/agent` 或项目配置。
- 不把运行时产物写进仓库；路径以 README「运行时文件与配置」为准。根目录遗留的 `config.json` / `logs/` 不要改。
- 旧会话可恢复：不直接 `unlink`，用 `trashSession`；旁支不能静默丢弃。
- Prompt 外置；代码只做占位符替换和拼接。
- LLM 输出不可信：JSON、turn 编号、标签位置必须校验。
- 用户可见行为变化同步 README 和测试。
- 不把代码地图、测试清单、命令细节写回本文件；放 `docs/CODE_MAP.md`。

## Git

- **不要频繁 commit。** 只在任务目标变化时提交：开始新功能、讨论/排查新问题、进入新的开发阶段。同一任务内的连续修改留在工作区，不要每改一步就提交；提交时把上一阶段未提交的改动一起提交。
- 不要自动 push，也不要改写已推送历史，除非用户明确要求。
