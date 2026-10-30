# Distill — 手动上下文压缩扩展 for pi

Distill 是一个 pi 编码助手的上下文压缩扩展。你可以用 pi 原生的 `/tree` + `shift+L` 打标签，然后通过 `/distill` 命令把选定的对话范围压缩成 AI 摘要并重建会话，大幅减少上下文长度，同时保留关键信息。

零依赖，仅使用 pi 原生 API。

---

## 安装

从 GitHub 安装：

```bash
pi install git:github.com/Crack-Hu/distill@main
```

或使用 https 地址（不依赖 git 协议）：

```bash
pi install https://github.com/Crack-Hu/distill
```

> 扩展零依赖，安装后即可使用，无需 `npm install`。
> 本地开发可用 `pi -e ./distill/index.ts` 直接加载。

---

## 工作流程

```
1. /tree 浏览会话树 → shift+L 给关键节点打标签
2. /distill <label> [补充说明]          压缩标签 → 当前位置
   同名标签标两处 → /distill <label> → 选 "Between the two tags"
3. 生成摘要 → 确认或编辑 → 回车执行
```

### 打标签

```
/tree → 浏览到关键节点 → shift+L → 输入标签名 → 回车
```

标签是 pi 原生的（黄色节点）。同名标签可以在树中标记多处；**压缩两个位置之间的内容时，给两端标同一个标签名即可**（只有单标签一种调用格式）。

---

## 命令

| 命令 | 说明 |
|------|------|
| `/distill <label> [补充]` | 压缩从标签到当前位置的内容；同名标签标两处时可选压缩两处之间 |
| `/distill up [补充]` | 向上压缩到上一个蒸馏摘要，若没有则压缩整个分支（要求中间无分支，需确认） |
| `/distill del <label>` | 删除范围（不生成摘要）；单独 `/distill del` 操作标签 `del` |
| `/distill merge [<label>]` | 无标签时自动检测当前分支，压缩并合并到分岔点；有标签时收拢指定分支摘要或标签指向的分支 |
| `/distill context on\|off` | 摘要生成时是否携带完整上文背景 |
| `/distill auto-clean on\|off` | 压缩后是否自动删除旧会话（默认 off） |
| `/distill model` | 选择 distill 摘要模型（从 pi 已注册模型） |
| `/distill model_suggest` | 选择 `suggest_lab` 的模型（从 `suggest.baseUrl` 的 `/models` 列表；失败时可手动输入） |
| `/distill clean [all]` | 回收当前项目的 `[distilled]` 旧会话到 trash；加 `all` 回收所有项目 |
| `/distill fork <path> [message]` | 从蒸馏会话 fork 出新会话继续工作 |
| `/distill suggest_lab [提示]` | 让 LLM 根据任务逻辑建议一个标签位置 |

---

## AI 标签建议（/distill suggest_lab）

手动在 `/tree` 里逐个 `shift+L` 打标比较繁琐。`/distill suggest_lab` 会让 LLM 阅读当前分支，按**工作任务逻辑**建议一个标签位置：

```
/distill suggest_lab [可选提示，例如：重点标出调试阶段]
```

发送给 LLM 的不是完整对话，而是一份精简记录，以控制 token：

- 每条 **user 消息**保留原文（超过 `maxCharsPerMessage` 时截断）
- 每轮只保留 **AI 最后一条文本回复**，中间的 tool call / tool result 全部省略
- 之前的摘要只保留一个占位符，不发送摘要正文
- 只分析**当前分支**：从当前 leaf 沿 `parentId` 回溯到根节点，旁支不参与

LLM 只返回目标 turn 和 2-4 句说明；标签名由扩展自动生成 `suggest-1`、`suggest-2`…（扫描会话中已有的 `suggest-N` 后取下一个编号）。

模型可以用 `/distill model_suggest` 选择：它会请求 `suggest.baseUrl` 的 `/models` 列表并写回 `suggest.model`；如果端点不支持 `/models`，会提示手动输入。

前端会展示位置和理由，并给出三个选项：

- **Accept** — 只写入标签，之后可手动执行 `/distill <label>`
- **Accept and distill** — 写入标签并立即进入正常的压缩流程（摘要确认、旧会话处理）
- **Reject** — 不修改会话

已有标签不会交给 LLM 处理。如果目标 turn 已经有标签，会在你选择 Accept / Accept and distill 后弹窗提醒，确认后才覆盖。

标签通过 pi 原生 label API 写入，与 `/tree` 里 `shift+L` 的结果一致。

### 配置

该命令使用独立的 OpenAI 兼容端点，不经过 pi 的模型注册表。在项目配置 `<cwd>/.pi/distill/config.json` 中加入：

```json
{
  "suggest": {
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-flash",
    "apiKeyEnv": "DEEPSEEK_API_KEY_PI",
    "temperature": 0.2,
    "maxTokens": 2048,
    "thinking": "disabled",
    "reasoningEffort": "low",
    "timeoutMs": 60000,
    "maxCharsPerMessage": 800
  }
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `baseUrl` | （必填） | OpenAI 兼容端点；代码会拼接 `/chat/completions` |
| `model` | （必填） | 模型名；可用 `/distill model_suggest` 从端点 `/models` 选择 |
| `apiKeyEnv` | — | 存放 API key 的环境变量名（推荐） |
| `apiKey` | — | 直接写 key（不推荐提交） |
| `temperature` | `0.2` | 采样温度 |
| `maxTokens` | `2048` | 最大输出 token（含 reasoning tokens）；关闭 thinking 后 `1024` 通常足够 |
| `thinking` | — | 透传为 `thinking: { type: ... }`；常用 `"enabled"` / `"disabled"`（也接受 `true` / `false`），不填则用服务端默认值 |
| `reasoningEffort` | — | 透传为 `reasoning_effort`；取值由模型/供应商决定（如 `low`/`high`/`max`），扩展不做等级映射 |
| `timeoutMs` | `60000` | 请求超时 |
| `maxCharsPerMessage` | `800` | 单条消息截断长度 |

`thinking` 和 `reasoningEffort` 都是可选字段，也都原样转发；扩展不负责把 `low` 映射成某个模型的具体思考等级。示例同时列出它们只是为了展示，按需保留即可（DeepSeek 在 `thinking: "disabled"` 时会忽略 `reasoning_effort`）。对于打标这种简单提取任务，推荐 `"thinking": "disabled"`：DeepSeek 等推理模型默认会在隐藏 reasoning 上消耗大量输出 token，可能把 `maxTokens` 用尽并返回空 content。若模型不支持关闭 thinking，可删掉该字段，改用 `reasoningEffort`。

仓库根目录的 `config.json.example` 是完整模板。建议把它复制到 `<cwd>/.pi/distill/config.json`，并把 `apiKeyEnv` 指向你环境中的变量（例如 `DEEPSEEK_API_KEY_PI`）。

> 与 `distill_model` 的区别：`distill_model` 走 pi 已注册模型；`suggest` 是独立的 OpenAI 兼容配置，便于给打标任务使用更便宜/更快的模型。

---

## 标签歧义处理

同一标签在树中出现多次时，命令会先让你消歧：

- **恰好 2 个**：弹窗三选一
  - `Between the two tags` — 压缩两个标签之间
  - `Up to the first tag` — 压缩到第一个
  - `Up to the last tag` — 压缩到最后一个
- **多于 2 个**：弹窗列出每个标签（带位置描述，如 `#1 user: "说234"`），选择压缩到哪一个

标签解析使用 pi 的标准 `getLabel`（`labelsById`），遵循后写覆盖语义——空标签清除、重复标记去重，与 `/tree` 显示完全一致。

---

## 自动压缩（/distill up）

无需打标签，直接运行：

```
/distill up [补充说明]
```

该命令会沿着当前 leaf 的父链向上查找，有两种模式：

**模式 A — 压缩到上一个摘要**：如果路径上存在之前的 `compactionSummary`，且摘要到当前位置之间是干净链（无分支），则压缩这段内容。

**模式 B — 压缩整个分支**：如果路径上没有蒸馏摘要，但当前路径是一个分支（存在 fork 点，即某节点有多个有效消息子节点），且分支内是干净链，则压缩整个分支从 fork 处到 leaf 的内容。

两种模式都遵守 pass-through 规则（标签/pi 原生压缩条目视为透明，不会误判为分支）。确认弹窗中会显示第一条消息的预览（截断到 40 个字符），帮助你确认范围。

- 若查找途中发现分支，拒绝并提示改用标签方式
- 若未找到任何蒸馏摘要且无分支，拒绝并提示改用标签方式

---

## 删除（/distill del）

两步式弹窗，所有路径都按 **turn（对话轮次）** 语义删除：

```
Step 1  Label "xxx" points to a single entry — delete how?
        - This turn only     删除标签所在的这一轮对话
        - Label to current position    删除标签到当前位置
        - Cancel

Step 2  Session method
        - New session (keep old as distilled)   旧会话标记 [distilled]
        - In place (no record)                  不保留旧会话记录
        - Cancel
```

- **turn 语义**：user/assistant 消息按轮次完整删除（问答不分割）；`distilled-summary` 独立成 turn，删它只删摘要本身
- 两个删除选项都通过 `newSession` 重建（不复制被删段），区别仅在是否标记旧会话

---

## 分支摘要合并（/distill merge）

### 自动模式（无参数）

`/distill merge` 不加参数时，自动检测当前分支：

1. 从 leaf 向上查找第一个分岔点（>1 有效子节点的祖先）
2. 若分支内无内部分叉（干净链），确认后**压缩 + 合并**一步完成
3. 若当前路径无分岔点但有前一个蒸馏摘要，退化为纯压缩（同 `/distill up`）
4. 确认弹窗中显示第一条消息预览

### 标签模式（带参数）

`/distill merge <label>` 处理**分支开头的第一个消息是蒸馏摘要**的情形：

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

- **压缩范围内含分支点**：允许压缩，但该分支无法重新挂载（它的挂载点会被摘要取代），因此它仍留在旧会话中。此时**只提供"新建会话"**选项（旧会话保留分支），不提供就地压缩
- **纯元数据分叉**（label / custom 条目，下面没有对话）：不算分支，随范围一起压缩掉
- **分支点之前的旁支**：重建时自动保留（重新挂载到新会话）
- **endId 之后的延续**（segmentD）：不算分支，正常保留（其上的旁支也一并保留）

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

`config.json` 位于当前工作目录的 `<cwd>/.pi/distill/config.json`（每个项目独立，首次运行自动创建；旧版本扩展目录下的 `config.json` 会自动迁移）：

```json
{
  "autoClean": false,
  "distill_model": "inherit",
  "contextOn": false
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `autoClean` | `false` | 压缩后自动把旧会话移入 trash（否则标记 `[distilled]` 保留） |
| `distill_model` | `"inherit"` | 摘要生成模型；`"inherit"` = 复用当前会话模型。更推荐显式填写 `provider/model`（可预测、可控） |
| `contextOn` | `false` | 摘要生成时是否携带完整上文背景（否则只取最后 2 条） |

`distill_model` 支持两种值：

- `"inherit"`：复用当前会话的 agent 模型，配置最省事。
- `"provider/model"`（如 `"deepseek/deepseek-flash"`）：走 pi 已注册模型，**推荐**。agent 的模型通常按交互编码场景调过思考等级/上下文参数，直接继承不一定适合摘要生成；显式指定一个专用模型更可控、更可预测。

旧配置里的 `summaryModel` 会自动迁移为 `distill_model`；如果两者同时存在，以 `distill_model` 为准。

> 注：`contextOn` 也可以在 `/tree` 中通过 `/distill context on|off` 切换，`autoClean` 同理。

---

## 运行时文件（<cwd>/.pi/distill/）

所有运行时产物都写在当前工作目录的 `.pi/distill/` 下，不会污染扩展源码目录：

| 路径 | 内容 |
|------|------|
| `config.json` | 项目配置（见上） |
| `logs/` | 每次摘要生成的完整 prompt（明文，自动只保留最近 10 个） |
| `trash/` | 被替换/回收的旧会话文件（扩展不提供清空命令；确认无误后可手动删除该目录下文件） |

### 安全删除策略

- 选择 "In place (no record)" 或开启 `auto-clean` 时，旧会话**不会直接删除**，而是移入 `<cwd>/.pi/distill/trash/`——它们从会话树中消失，但仍可恢复
- `/distill clean` 只回收**当前项目**的 `[distilled]` 会话到该项目 trash；`/distill clean all` 回收**所有项目**的蒸馏会话（各自进入所属项目的 trash）
- 扩展**不提供清空 trash 的命令**：确认不再需要恢复时，直接删除对应 `.pi/distill/trash/` 目录下的文件即可

---

## 摘要 prompt

摘要模板外部化为 `distill-summary-prompt.md`（中文，保证摘要输出中文）。当使用 `/distill <label> [补充]` 传入补充说明时，会额外加载 `distill-summary-prompt-append.md` 模板，将其中的 `{{SUPPLEMENT}}` 占位符替换为用户补充的内容，并拼接在最终 prompt 末尾。两个模板都可直接编辑，代码只负责替换占位符与拼接。`<cwd>/.pi/distill/logs/` 会记录每次生成的 prompt（只保留最近 10 个），便于调试。

`formatMessages` 将对话结构化为 JSON 数组（role: `user` / `assistant` / `tool_result` / `distilled_summary`）交给摘要模型，避免模型臆造对话归属。

---

## 已知限制 / 取舍

- **压缩范围含分支点**：压缩后分支无法随新会话带走（它仍留在旧 `[distilled]` 会话里），因此这类范围仅允许"新建会话"；需要在分支点前后分别压缩时请手动打标签
- **标签名与子命令同名**：`del`、`up`、`merge`、`clean`、`model`、`model_suggest`、`fork`、`context`、`auto-clean`、`suggest_lab` 会被 `/distill` 解析成子命令，因此这些标签无法通过 `/distill <label>` 触发压缩（语法歧义的取舍；`/distill suggest_lab` 会自动给这类名字加后缀）
- **append-only 模型**：旧会话文件不物理删除，而是保留标记或移入 `<cwd>/.pi/distill/trash/`（`/distill clean [all]` 只负责回收，清空需手动删除 trash 文件）
- **单删第一轮**：树根所在的第一轮不允许单独删除（无前置内容可衔接）
