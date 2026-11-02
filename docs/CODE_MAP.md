# Code map

用于定位实现。用户可见行为、命令、配置和运行时路径以 `README.md` 为准。

## 入口与主流程

`index.ts` 注册 `/distill`、`suggest_lab` 流程、会话守卫和 `view_distilled_context`。

```
命令解析 → 解析 label/范围 → executeCompact 计算 segment/plan
→ 生成摘要（或 drop）→ 重建会话 → 归档原文 / 处理旧会话
```

## 模块

| 文件 | 职责 |
|------|------|
| `index.ts` | 扩展入口，注册命令、守卫、工具 |
| `src/commands/distill.ts` | `/distill` 子命令分发、范围消歧、摘要确认、会话重建、旧会话处理、会话守卫 |
| `src/commands/suggest-label.ts` | `suggest_lab` 交互、进度面板、Accept / Move earlier/later / Reject |
| `src/engine/compact.ts` | 压缩引擎：范围、segment、分支检测、rebuild plan、摘要生成 |
| `src/engine/turn-group.ts` | turn 分组、label 解析、路径与子树遍历 |
| `src/engine/prompt.ts` | 摘要 prompt 渲染、`formatMessages` |
| `src/engine/suggest.ts` | 精简 transcript、suggest prompt、LLM 请求、JSON 校验、模型列表 |
| `src/engine/session-io.ts` | 配置路径与分层、session header、trash |
| `src/ui/progress.ts` | 摘要/建议共用的进度 overlay |
| `src/tools/view-distilled.ts` | `view_distilled_context` 工具，读取 `distilled-archive` |

### `src/commands/distill.ts` 内的关键入口

- `registerDistillCommand`：子命令分发与命令描述
- `resolveRange`：label → 具体 entry ID，处理重名/同名两端
- `handleUp` / `handleDelete` / `handleMerge*`：各子命令流程
- `runCompactAndRebuild`：摘要确认 + 新建会话
- `rebuildLinearRange` / `rebuildPlanEntries` / `finalizeOldSession`：重建、分支保留、旧会话收尾
- `registerSessionGuards`：`[distilled]` 会话只读与 fork 提示

## 测试

| 文件 | 覆盖 |
|------|------|
| `tests/distill-engine.test.ts` | 范围、分支检测、drop/软删除 |
| `tests/rebuild.test.ts` | 线性/plan 重建、旁支保留、up/merge |
| `tests/config.test.ts` | 配置分层、legacy `summaryModel`、路径覆盖 |
| `tests/suggest.test.ts` | transcript、prompt、LLM 请求体、JSON 解析与校验 |
| `tests/progress.test.ts` | 进度 overlay 渲染与取消 |
| `tests/bench.ts` | 摘要 prompt 质量基准（手动，调用真实 LLM） |

## 本地命令

```bash
bun test tests/config.test.ts tests/suggest.test.ts tests/progress.test.ts \
  tests/distill-engine.test.ts tests/rebuild.test.ts

pi --no-extensions -e ./index.ts   # 本地加载，避免已安装旧版

bun build index.ts --target=node --outfile=/tmp/distill-bundle.js \
  --external @earendil-works/pi-coding-agent \
  --external @earendil-works/pi-ai \
  --external @earendil-works/pi-ai/compat \
  --external @earendil-works/pi-tui \
  --external typebox
```

`tests/bench.ts` 不是单测。`tests/fixtures-real.ts`、`tests/output/` 不提交。
