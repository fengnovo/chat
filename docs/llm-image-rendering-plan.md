# 大模型图片展示标准化改造方案

> 状态：待实施。背景见下文「问题」；本次会话曾用前端正则临时修复，已回滚，不采纳。

## 一、问题

模型在 assistant 正文里回显搜索/抓取结果中的图片时，输出损坏的 Markdown：

- 反引号插进图片括号：`![](`url)`、`![](`url`)`
- 反引号把整段图片语法或裸图片直链包成行内代码：`` `![](url)` ``、`` `https://…/a.jpg` ``

react-markdown 把这些内容解析成行内代码（页面显示紫色代码片段），多张图只有语法干净的那张能渲染。损坏源头是模型生成期错误（工具结果本身已损坏的 markdown 被模型照抄），属于概率性问题，前端逐条猜修复不可持续。

## 二、业内做法调研

### 1. 图片不走文本通道，走结构化 parts（核心方案）

AI SDK v5+ 的 UIMessage parts 模型：消息是 typed parts 数组，不是一段 markdown 字符串。图片、文件、引用走独立 part，前端按类型渲染，格式由系统保证、不依赖模型输出质量。同类设计：Anthropic Messages 的 content blocks、OpenAI Responses API 的 content items。

本仓库已有同模式先例：`data-citations` 链路（引用由服务端写入 part，从不指望模型复述）。图片应走同一条路。

- 参考：https://v6.ai-sdk.dev/docs/ai-sdk-ui/chatbot （parts 渲染）、AI SDK custom data parts 文档

### 2. 渲染层换 Streamdown（Vercel 官方）

AI 生态流式 Markdown 渲染的事实标准，Vercel 官方 ai-chatbot 模板与 AI Elements 均采用。drop-in 替换 react-markdown：

- remend 引擎自动补全流式未闭合语法（未闭合的代码、加粗、链接等）
- 内置 Shiki 代码高亮、Mermaid 插件（全屏/导出）、CJK 排版优化、GFM
- 安全加固（rehype-harden / rehype-sanitize）：图片来源白名单、链接安全弹窗，可替换自研 `safeExternalUrl`
- 注意边界：解决的是流式截断/未闭合；模型生成期错位反引号不保证修复——所以图片展示以 parts 通道为准

- 参考：https://streamdown.ai/ 、https://streamdown.ai/docs/migration

### 3. 硬保证格式：Structured Output

需要 100% 保证输出结构时用 schema 约束解码（`streamObject` / OpenAI Structured Outputs），模型输出 `images: string[]` 之类的字段。会改变自由流式交互形态，仅建议用于关键结构化场景，本方案不采用。

### 4. Prompt 契约（辅助）

system prompt 明确图片输出规范（必须 `![alt](https://…)`，禁止反引号包裹）。业内普遍做法，成本低，但单独使用不保证遵守，只作为方案 1/2 的补充。

## 三、落地设计

### A. 图片结构化 parts（后端 → 前端全链路）

参照 `data-citations` 的既有链路（[chat-stream.ts](../apps/api/src/chat-stream.ts) L34-39）：

1. **事件层**：`packages/contracts` 的 `PersistedAgentEvent` 已有 `tool.completed`（结果在 `output` 字段）与 `retrieval.completed` 先例。新增图片提取产物的承载方式（并入现有事件或新增 `media.extracted` 事件，实施时定）。
2. **agent-core**：`packages/agent-core/src/deep-agent.ts` 的 MCP 工具 `on_tool_end` 链路（约 L795-822，现调用 `extractRetrievalEvent()`）处，对工具 `output` 做确定性提取：http(s) + 图片扩展名（jpg/jpeg/png/webp/gif/bmp）的 URL → 结构化列表。
3. **api**：`chat-stream.ts` 的 `chunksFrom()` 把图片事件映射为 `data-image` chunk（`transient: false`），写法对齐 data-citations。
4. **持久化**：message 记录参照 `citations` 增加 `images` 字段（仓储层 + 契约类型 + web `HistoryMessage` 类型同步）。
5. **web 渲染**：
   - `utils.ts` 的 `messagesFromHistory()` 把 `message.images` 转成 `data-image` part（对齐现有 citations 转换）
   - `message.tsx` 渲染 `data-image` parts 为图片画廊，点击复用现有 `onPreviewImage` / lightbox

图片显示从此不依赖模型输出格式；模型正文里即使有损坏语法，画廊仍完整展示。

### B. 渲染层迁移 Streamdown（web）

1. 安装：`pnpm --filter web add streamdown @streamdown/code @streamdown/mermaid @streamdown/cjk`
2. Tailwind v4 配置：`app/globals.css` 增加 `@source`（monorepo 注意相对路径指向根 `node_modules`）：
   ```css
   @source "../../../node_modules/streamdown/dist/*.js";
   @source "../../../node_modules/@streamdown/code/dist/*.js";
   @source "../../../node_modules/@streamdown/mermaid/dist/*.js";
   @source "../../../node_modules/@streamdown/cjk/dist/*.js";
   ```
3. `message.tsx` 的 `MarkdownContent` 改为 `<Streamdown plugins={{ code, mermaid, cjk }}>`：
   - 删除自研 `MermaidDiagram` 组件与 `mermaid` 直接依赖（插件内置全屏查看）
   - 删除 `rehype-highlight`（插件内置 Shiki）
   - `safeExternalUrl` 保留或改用 Streamdown 链接安全能力，实施时评估
   - `img` 渲染保留 `onPreviewImage` 点击大图
4. 清理依赖：确认无其他引用后移除 `react-markdown`、`remark-gfm`、`rehype-highlight`
5. 样式回归：现有 `.markdown-content` 自定义 CSS 与 Streamdown 内置 typography 可能冲突，需视觉回归（暗色主题、代码块、表格、列表）

## 四、实施顺序与验证

1. A（parts 链路）先行，独立可交付：contracts → agent-core → api → web
2. B（Streamdown）随后，纯 web 内部替换
3. 验证：
   - 单测：chunksFrom 映射（对齐现有 `apps/api/test/chat-stream.test.ts` 的 data-citations 断言风格）、图片提取函数、历史消息重建
   - 手工：真实 ANYSEARCH 场景回归（图片画廊完整展示）；流式过程中断/未闭合语法表现
   - `pnpm test` / `pnpm typecheck` 全绿

## 五、风险

- 工具结果里图片 URL 的提取规则（扩展名判断 vs Content-Type 探测）可能漏/错，先白名单扩展名，后续按需加 HEAD 探测
- Streamdown 版本迭代快（1.6+），API 以安装时的官方文档为准
- 历史消息兼容：旧消息无 `images` 字段，读取需判空
