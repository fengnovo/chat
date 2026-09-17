# 子 Agent 编排架构实施方案（详细设计）

> 状态：待实施。目标架构：主 Agent 规划 → 派发子 Agent（隔离执行）→ 汇总子结果 → 评分器评估 → 不达标带反馈重试 → 整合输出。
> 前置调研：当前 agent-core 是单个 deep-agent 循环（`createDeepAgent` + middleware），无子 Agent 能力，见 [deep-agent.ts](../packages/agent-core/src/deep-agent.ts)。

## 一、业内参考

| 模式 | 来源 | 要点 |
| --- | --- | --- |
| 原生 task 工具 + 内置子 Agent | LangChain `deepagents`（`createDeepAgent` 的 subagents 配置）；Claude Code Task 工具 | 子 Agent 独立消息栈、受限工具集，只回传最终摘要，防主上下文爆炸 |
| 编排者-执行者 | Anthropic《How we built our multi-agent research system》 | Lead agent 拆任务 → 并行 worker → 汇总；worker 上下文隔离是关键 |
| 评审循环 | LangGraph evaluator-optimizer 模板、LLM-as-judge | 评分器输出结构化 {score, passed, feedback}，反馈回编排者重试，设最大轮次 |
| 代码即编排 | Anthropic「code execution with agents」 | 复杂编排逻辑写成代码在沙箱里跑，省 token、可测试 |

## 二、现状与接入点

- 主 Agent 实例化：[deep-agent.ts L561-618](../packages/agent-core/src/deep-agent.ts#L561-L618)，`createDeepAgent` 注入 router.primary 模型、MCP 工具、system prompt、三个 middleware（human-in-the-loop / modelCallLimit / todoList）
- 主循环：`execute()` 异步生成器（[L641-680](../packages/agent-core/src/deep-agent.ts#L641-L680)），`runnable.stream` 驱动 LangGraph，yield AgentEvent
- 工具生命周期事件：[L781-845](../packages/agent-core/src/deep-agent.ts#L781-L845)（`tool.started/completed/error`）——子 Agent 事件照此模式新增
- 进度事件先例：`todo.updated`（[L849-862](../packages/agent-core/src/deep-agent.ts#L849-L862)）
- 隔离执行：[docker-sandbox.ts](../packages/agent-core/src/docker-sandbox.ts)，无网络、只读根文件系统、可写 `user-data`（workspace/outputs/previews/large-tool-results）
- 事件到 UI 链路：agent-core yield → apps/api 持久化为 `PersistedAgentEvent` → [chat-stream.ts](../apps/api/src/chat-stream.ts) `chunksFrom()` 映射 UI chunk → 前端 parts（`data-citations` 为现成模板）

## 三、详细设计

### 3.1 子 Agent 角色：运行时动态设定（通用子 Agent）

业内主流的编排者-执行者模式（Anthropic 多智能体研究系统的 lead agent 给 worker 动态写指令、deepagents 默认提供 general-purpose 子 Agent）都是**通用 worker + 运行时简报**：平台只提供一个能力统一的通用子 Agent，角色、工具偏好、模型档位、输出要求由主 Agent 在 spawn 时现场下发。平台写死的是"安全基线 + 资源上限"（隔离、超时、深度/并行限制），动态的是"角色与简报"。

设计原则：
- **角色动态**：`spawn_subagent` 入参带 `role_prompt`（主 Agent 现场撰写的角色设定与输出规范），子 Agent 的 system prompt = 平台安全基线 + role_prompt + 任务简报
- **工具运行时指定**：主 Agent 按任务传 `tools_allowlist`，但**必须经平台策略层过滤**（剔除 spawn 类工具、execute 类强制走沙箱），不信任模型自己挑的清单
- **模型档位动态**：`model_tier: 'fast' | 'primary'` 由主 Agent 按任务难度选
- **预置命名角色仅作可选优化**（Claude Code agents 注册表模式）：跑量大的固定角色可沉淀为 preset 省简报成本，非前提，P1 不做

若所用 `createDeepAgent` 版本原生支持动态子 Agent（general-purpose 形态），优先用框架能力；否则按 3.2 自定义 spawn 工具（注册方式对齐现有 MCP 工具并入点）。

### 3.2 spawn_subagent 工具（自定义实现的核心伪代码）

```ts
// packages/agent-core/src/subagent.ts（新增）
const spawnSubagentSchema = z.object({
  role_prompt: z.string().describe('主 Agent 现场撰写的角色设定：职责边界、工作方法、输出格式与字数要求'),
  task: z.string().describe('任务目标 + 验收标准'),
  tools_allowlist: z.array(z.string()).optional().describe('建议给子 Agent 的工具名；最终以平台策略层过滤结果为准'),
  model_tier: z.enum(['fast', 'primary']).default('fast'),
  context: z.string().optional().describe('必须带给子 Agent 的关键背景/文件路径'),
  prior_feedback: z.string().optional().describe('上轮评分器的整改意见（重试时）'),
  background: z.boolean().default(false),        // 模式 C：异步
});

async function* runSubagent(input: SpawnInput, run: RunContext) {
  const subAgent = createDeepAgent({
    model: router[input.model_tier],
    tools: policy.filter(input.tools_allowlist),  // 平台策略层：剔除 spawn 类、execute 强制沙箱；缺省给通用全集
    systemPrompt: PLATFORM_BASELINE               // 安全基线 + 摘要上限等硬约束，固定在平台侧
      + `\n\n## 你的角色（主 Agent 指定）\n${input.role_prompt}`
      + `\n\n## 任务\n${input.task}`
      + (input.context ? `\n\n## 背景\n${input.context}` : '')
      + (input.prior_feedback ? `\n\n## 上轮评审意见（必须整改）\n${input.prior_feedback}` : ''),
    middleware: [modelCallLimitMiddleware(30)],   // 子 Agent 轮次上限
  });

  yield { type: 'subagent.started', subagentId, role: input.role_prompt.slice(0, 50), attempt };
  const summary = await withTimeout(
    consume(subAgent.stream({ messages: [{ role: 'user', content: taskText }] })),
    10 * 60_000,                                   // 墙钟超时 → 强制终止 + 失败摘要
  );
  yield { type: 'subagent.completed', subagentId, status, summary: clamp(summary, 2000) };
  return summary;                                  // 只回传摘要给主 Agent
}
```

要点：
- **上下文隔离**：子 Agent 消息栈只有任务描述 + 背景 + 评审意见，绝不注入主对话历史
- **摘要上限**：回传文本 clamp（如 2000 字），大产物写 `user-data/outputs`，摘要里给引用路径（复用 large-tool-results 通道）
- **递归防护**：子 Agent 工具集不含 `spawn_subagent`；如需嵌套，显式 `depth` 参数且 ≤2
- **事件**：子 Agent 自己的工具事件不逐条上抛，只聚合计数（`toolCalls: n`），避免刷屏

### 3.3 评分器 evaluate_result（评审节点）

不做完整 Agent，一次结构化 LLM 调用即可：

```ts
// packages/agent-core/src/evaluator.ts（新增）
const verdictSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(100),
  checklist: z.array(z.object({ item: z.string(), ok: z.boolean(), note: z.string().optional() })),
  feedback: z.string().describe('不达标时的具体整改意见，将原样传给下一轮子 Agent'),
});

async function evaluateResult(input: {
  task: string;            // 原始任务描述 + 验收标准
  result: string;          // 子 Agent 摘要（+ 产物文件片段，按需裁剪）
}): Promise<z.infer<typeof verdictSchema>> {
  // structured output（zod → JSON schema），模型用 router.fast
  // 评分器不可见主对话历史 —— 防止"评判者迎合"
}
```

重试闭环（图中"不达标 → 重新执行"）：

```ts
const MAX_ATTEMPTS = 3;
let feedback: string | undefined;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const result = await runSubagent({ ...task, prior_feedback: feedback });
  const verdict = await evaluateResult({ task, result });
  yield { type: 'subagent.reviewed', subagentId, attempt, verdict };
  if (verdict.passed) break;
  feedback = verdict.feedback;
}
if (仍不达标) return '如实汇报差距与已尝试的整改，请求用户裁决'; // 写入主提示词
```

`attempt` 计数与上限也可放主 Agent 提示词 + 工具校验双保险（工具侧硬拒绝超过上限的调用）。

### 3.4 模式 C：异步派发

`background: true` 时：
1. 立刻返回 `{ taskId, status: 'running' }` 给主 Agent，主循环不阻塞
2. 子 Agent 在后台继续跑；完成/失败后生成一条 ToolMessage（`taskId` + 摘要 + 评分结论）注入主循环待处理队列，参照 human-in-the-loop 恢复路径（[L873-920](../packages/agent-core/src/deep-agent.ts#L873-L920)）
3. 事件走现有持久化通道，断线重连后进度仍可见（SSE cursor 机制已有）

### 3.5 模式 B：动态代码编排

复用 docker-sandbox：主 Agent 生成编排脚本（循环/分支/聚合逻辑），沙箱内执行，脚本通过既有宿主接口回调子任务。适用规则明确、分支多的批量任务；不新增执行面，网络按任务白名单放开。

### 3.6 事件契约与前端

```ts
// packages/contracts：PersistedAgentEvent 新增
| { type: 'subagent.started';  subagentId: string; role: string; description: string; attempt: number }
| { type: 'subagent.completed'; subagentId: string; status: 'completed' | 'failed' | 'timeout'; summary: string; toolCalls: number; durationMs: number }
| { type: 'subagent.reviewed'; subagentId: string; attempt: number; verdict: Verdict }
```

- **agent-core**：spawn 工具回调内 yield 上述事件（模式对齐 L781-845 工具生命周期）
- **api**：`chat-stream.ts` `chunksFrom()` 映射为 `data-subagent` chunk（`transient: false`），照抄 [L34-39](../apps/api/src/chat-stream.ts#L34-L39) data-citations 写法
- **web**：执行面板新增子 Agent 卡片（名称 / 状态 / attempt / 耗时 / toolCalls，展开看摘要与评分 checklist）；入场 fade-in：`@keyframes` opacity 0→1 + translateY(6px→0)，200ms ease-out，遵循 `prefers-reduced-motion` 降级（参照 [responsive.css L380](../apps/web/app/styles/responsive.css#L380) 的 `animation: none !important` 先例）
- 子 Agent token 用量并入 run tokens 统计并单独标注（前端已有 `message-tokens` 位置）

## 四、文件改动清单

| 文件 | 改动 |
| --- | --- |
| `packages/contracts/src/index.ts` | `PersistedAgentEvent` 增加 `subagent.*` 事件类型 |
| `packages/agent-core/src/subagent.ts` | 新增：子 Agent 实例化、spawn/超时/事件包装 |
| `packages/agent-core/src/evaluator.ts` | 新增：评分器（zod schema + structured output） |
| `packages/agent-core/src/deep-agent.ts` | 注册 spawn/evaluate 工具；重试循环提示词；子 Agent 事件转发 |
| `apps/api/src/chat-stream.ts` | `chunksFrom()` 增加 `data-subagent` 映射 |
| `apps/web/…/types.ts` | `ResilientMessage` parts 增加 `data-subagent` |
| `apps/web/…/agent-status.tsx` | 子 Agent 卡片渲染 + fade-in |
| `apps/web/…/utils.ts` | 历史消息重建时恢复子 Agent 状态（如持久化含之） |
| 样式（agent-panels.css 等） | 卡片样式 + `@keyframes` fade-in + reduced-motion 降级 |

## 五、分阶段实施与验收

| 阶段 | 内容 | 验收用例（发给聊天） | 观察点 |
| --- | --- | --- | --- |
| P1 | 模式 A 同步 task + 事件链路 + 前端卡片 | 「分别调研 X 和 Y 两个主题，各派一个子 Agent，最后汇总」 | 执行面板出现 2 张子 Agent 卡片；主 Agent 收到的只有摘要；正文输出整合结果；子 Agent 工具调用不刷屏 |
| P2 | 评分器 + 反馈重试 + 上限 | 「写一个函数，验收标准：必须含 JSDoc 与单测」（并预埋一个会漏单测的场景） | 出现 `subagent.reviewed` 事件；第二轮子 Agent 卡片标注 attempt=2 且摘要体现整改；超限时如实汇报差距 |
| P3 | 异步派发 + 动态代码编排 | 「并行启动 3 个调研任务，先别等结果」 | 立即返回 3 个 taskId；后台完成后回灌；刷新/断线重连后进度仍在 |

## 六、风险与约束

- **Token 放大**：并行 ≤3、递归 depth ≤2、子 Agent 轮次 `modelCallLimitMiddleware`（默认 50，可用环境变量 `SUBAGENT_MODEL_CALL_LIMIT` 覆盖），全部硬限制；撞上限按失败处理并回传中断前部分产出，不伪装成成功
- **超时**：单子 Agent 墙钟 10 分钟，超时产失败摘要回传，主 Agent 决定重试或放弃
- **沙箱并发**：实施前确认 docker 并发实例的资源配额（P3 前置）
- **评分器偏差**：rubric 只来自任务描述本身；评分器不接触主对话与用户偏好
- **动态简报质量**：角色/简报写得好坏取决于主 Agent——主系统提示词需内置简报指南（职责边界、验收标准怎么定、输出格式），并附 1-2 个简报示例（Anthropic lead agent 的做法）
- **历史兼容**：`subagent.*` 事件对旧会话缺省为空，前端判空渲染
- **成本观测**：子 Agent token 单独标注，避免与主 Agent 用量混淆
