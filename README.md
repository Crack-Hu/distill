# Distill — 手动上下文压缩扩展 for pi

Distill 是一个 pi 编码助手的上下文压缩扩展。你可以用 pi 原生的 `/tree` + `shift+L` 打标签，然后通过 `/distill` 命令把选定的对话范围压缩成 AI 摘要并重建会话，大幅减少上下文长度，同时保留关键信息。

---

## 工作流程

```
1. /tree 浏览会话树 → shift+L 给关键节点打标签
2. /distill <label> [补充说明]          压缩标签 → 当前位置
   /distill <label1> <label2> [补充]    压缩两个标签之间的中间段
3. 生成摘要 → 确认或编辑 → 回车执行
```

### 打标签

```
/tree → 浏览到关键节点 → shift+L → 输入标签名 → 回车
```

标签是 pi 原生的（黄色节点）。同名标签可以在树中标记多处，用于压缩中间段。

---

## 命令

| 命令 | 说明 |
|------|------|
| `/distill <label> [补充]` | 压缩从标签到当前位置的内容 |
| `/distill <label1> <label2> [补充]` | 压缩两个标签之间的内容 |
| `/distill del <label>` | 删除范围（不生成摘要）；单独 `/distill del` 操作标签 `del` |
| `/distill merge <label>` | 收拢分支摘要（父节点下多分支时）；单独 `/distill merge` 操作标签 `merge` |
| `/distill context on\|off` | 摘要生成时是否携带完整上文背景 |
| `/distill auto-clean on\|off` | 压缩后是否自动删除旧会话（默认 off） |
| `/distill model` | 选择摘要生成模型（从 pi 已注册模型） |
| `/distill clean` | 删除所有 `[distilled]` 旧会话 |
| `/distill fork <path> [message]` | 从蒸馏会话 fork 出新会话继续工作 |

---

## 标签歧义处理

同一标签在树中出现多次时，命令会先让你消歧：

- **恰好 2 个**：弹窗三选一
  - `Between the two tags` — 压缩两个标签之间
  - `Up to the first tag` — 压缩到第一个
  - `Up to the last tag` — 压缩到最后一个
- **多于 2 个**：弹窗列出每个标签（带位置描述，如 `#1 user: "说234"`），选择压缩到哪一个
- **`/distill tag tag`（同名双标签）**：恰好 2 个候选时直接压缩两个标签之间，免弹窗

标签解析使用 pi 的标准 `getLabel`（`labelsById`），遵循后写覆盖语义——空标签清除、重复标记去重，与 `/tree` 显示完全一致。

---

## 删除（/distill del）

两步式弹窗，所有路径都按 **turn（对话轮次）** 语义删除：

```
Step 1  Label "xxx" points to a single entry — delete how?
        - This turn only     删除标签所在的这一轮对话
        - Label to current position    删除标签到当前位置
        - Cancel

Step 2  Delete method
        - New session (keep old as distilled)   旧会话标记 [distilled]
        - In place (no trace)                   不标记旧会话
        - Cancel
```

- **turn 语义**：user/assistant 消息按轮次完整删除（问答不分割）；`distilled-summary` 独立成 turn，删它只删摘要本身
- 两个删除选项都通过 `newSession` 重建（不复制被删段），区别仅在是否标记旧会话

---

## 分支摘要合并（/distill merge）

处理**分支开头的第一个消息是蒸馏摘要**的情形：

```
父节点 P（分叉点）
├── [摘要] → A1 → …     ← 分支开头是摘要（src）
├── B1 → …               ← 其他分支
└── C1 → …               ← 主分支（当前所在）

合并后：摘要成为 P 的唯一直接子节点，其他所有分支重挂到摘要下面
父节点 P
└── [摘要]
    ├── A1 → …（摘要自身的延续）
    ├── B1 → …
    └── C1 → …（主分支，leaf 保持）
```

用途：多个分支从同一分叉点 fork 出去，其中一个以摘要开头时，把各分支"收拢"到摘要下，形成 `P → 摘要 → 各分支` 的清晰结构。

**判断很简单**：只看摘要的父节点下是否有多个分支（>1 个直接子节点）。

- 来源必须是 `compactionSummary`（普通消息不能合并）
- 父节点只有一个分支时不合并（提示）
- 只复制/重挂结构，不生成新摘要；旧会话处理与 del 一致（两步式）

---

## 压缩引擎设计

### turn 分组（与 pi 一致）

- 每条 **user 消息** 开始一个新 turn（问答完整，不切断 user/assistant 对）
- `compactionSummary`（蒸馏摘要）也**独立成 turn**（与 pi 的 `isTurnStartMessage` 一致）——它是独立节点，不属于任何问答对

### 分支处理

- **压缩范围内含分支点**：拒绝并提示"Distill before/after the branch point separately"
- **分支点之前的旁支**：重建时自动保留（重新挂载到新会话）
- **endId 之后的延续**（segmentD）：不算分支，正常保留

### 摘要节点

摘要以 pi 原生 **`compactionSummary` message** 写入，因此：

- 可以在摘要**之后继续对话**（tree 中选中摘要，leaf 停在摘要节点，而不是内容被塞进输入框）
- 进入 LLM 上下文时自动带 `The conversation history before this point was compacted...` 前缀
- TUI 渲染为 pi 原生的 `[compaction]` 折叠面板（`Ctrl+O` 展开）

### 原文存档

被压缩的原文存入 `distilled-archive` 条目（不进 LLM 上下文），LLM 可通过 `view_distilled_context` 工具回溯。

---

## 会话守卫（蒸馏会话只读）

- 打开（浏览）`[distilled]` 旧会话是只读的，**浏览不会创建新会话**
- 在蒸馏会话中发送消息会被拦截：显示灰色提示 + 在输入框预填 `/distill fork <path> <消息>`，按回车即 fork 并继续
- fork 出的新会话用首条新消息作为标题（不继承旧标题）

### 树形管理

- **distill**：新旧会话**平级**（旧会话扁平化为新 root 的兄弟），便于多次压缩不产生深层嵌套
- **fork**：正常树形（新会话是蒸馏会话的子节点，旧方向）
- 旧会话标题加 `[distilled <时间>]` 前缀

---

## 配置

`config.json`（与扩展同目录）：

```json
{
  "autoClean": false,
  "summaryModel": "inherit",
  "contextOn": false
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `autoClean` | `false` | 压缩后自动删除旧会话（否则标记 `[distilled]` 保留） |
| `summaryModel` | `"inherit"` | 摘要生成模型；`"inherit"` = 使用当前对话模型 |
| `contextOn` | `false` | 摘要生成时是否携带完整上文背景（否则只取最后 2 条） |

> 注：`contextOn` 也可以在 `/tree` 中通过 `/distill context on|off` 切换，`autoClean` 同理。

---

## 摘要 prompt

摘要模板外部化为 `distill-summary-prompt.md`（中文，保证摘要输出中文）。`logs/` 目录会记录每次生成的 prompt，便于调试。

`formatMessages` 将对话结构化为 JSON 数组（role: `user` / `assistant` / `tool_result` / `distilled_summary`）交给摘要模型，避免模型臆造对话归属。

---

## 已知限制 / 取舍

- **压缩范围含分支点**：第一版不支持，需在分支点前后分别压缩
- **标签名 "del"**：`/distill del` 单独使用会把 `del` 当作标签名处理，因此名为 `del` 的标签无法通过删除命令触发压缩（语法歧义的取舍）
- **append-only 模型**：旧会话文件无法物理删除（保留标记或 `autoClean` 删除）
- **单删第一轮**：树根所在的第一轮不允许单独删除（无前置内容可衔接）
