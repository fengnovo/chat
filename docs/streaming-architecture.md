# 流式输出架构：任务队列模式下的逐 token 流式方案

本文说明本项目在引入「Postgres 任务队列 + 独立 Worker」之后，一条用户消息是如何变成浏览器里逐字增长的 AI 回复的。

## 一、整体架构

请求面（HTTP）与执行面（Worker）彻底分离：API 只负责「落库 + 唤醒 + 推流」，真正的模型调用在 Worker 沙箱里进行，两者通过 **Postgres 事件表 + Redis Pub/Sub** 解耦。

```mermaid
flowchart TB
    subgraph Browser["浏览器（apps/web，Next.js）"]
        UI["聊天 UI<br/>useChat(throttle 24ms)"]
        Transport["WorkflowChatTransport<br/>（@ai-sdk/workflow）"]
        TrackedFetch["createTrackedFetch<br/>统计 SSE 帧游标 → 断点续传"]
        UI --> Transport --> TrackedFetch
    end

    subgraph API["API 服务（apps/api，Fastify）"]
        ChatRoute["POST /api/chat<br/>建会话 + 建 run + outbox.wake()"]
        SseRoute["GET /api/chat/:runId/stream<br/>（断线重连用同一实现）"]
        StreamWorkflow["streamWorkflowRun<br/>订阅 Redis 频道 → 增量推 SSE"]
        ChunksFrom["chunksFrom<br/>AgentEvent → UIMessage chunk"]
    end

    subgraph Data["数据层"]
        PG[("PostgreSQL<br/>runs / agent_events / outbox")]
        Redis[("Redis Pub/Sub<br/>runEventsChannel(runId)")]
    end

    subgraph Worker["Worker（apps/worker）"]
        Outbox["队列轮询 / outbox.wake 唤醒<br/>tryMarkRunRunning 认领任务"]
        Processor["processor<br/>创建沙箱、组装 Agent、<br/>逐事件 persistEvent"]
        Sandbox["沙箱（docker / e2b）"]
        Agent["Deep Agent（packages/agent-core）<br/>LangGraph stream → AgentEvent"]
        Router["模型路由<br/>重试 / 熔断 / 降级"]
    end

    LLM["DeepSeek（OpenAI 兼容 SSE）"]

    TrackedFetch -- "POST /api/chat（Next rewrites 代理）" --> ChatRoute
    TrackedFetch -- "GET /api/chat/:runId/stream" --> SseRoute
    ChatRoute --> PG
    ChatRoute -- "wake()" --> Outbox
    SseRoute --> StreamWorkflow
    StreamWorkflow --> ChunksFrom
    StreamWorkflow -- "SUBSCRIBE" --> Redis
    Outbox --> Processor --> Agent
    Processor -- "沙箱内执行" --> Sandbox
    Agent --> Router --> LLM
    Processor -- "appendEvent + publish(seq)" --> PG
    Processor -- "PUBLISH seq" --> Redis
    PG -.-> StreamWorkflow
```

## 二、一次流式回复的完整时序

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户（浏览器）
    participant W as Web/Next.js
    participant A as API（Fastify）
    participant Q as Postgres 队列/事件表
    participant R as Redis Pub/Sub
    participant K as Worker
    participant S as 沙箱 + DeepSeek

    U->>W: 输入消息，点击发送
    W->>A: POST /api/chat（messages, chat_id）
    A->>Q: getOrCreateExternalSession + createRun（status=queued）
    A-->>W: 200 SSE 响应头（x-workflow-run-id）
    A->>R: SUBSCRIBE runEventsChannel(runId)
    A->>Q: listEvents 全量 → chunksFrom → 补发已有帧
    A->>Q: outbox.wake()（唤醒 Worker）
    K->>Q: 轮询认领任务（tryMarkRunRunning）
    K->>S: 创建沙箱，加载 Deep Agent，发起模型流式调用
    loop 模型每吐一个 token chunk
        S-->>K: messages 流 chunk（含 content 增量）
        K->>K: 判定正文/旁白（见第四节）
        K->>Q: appendEvent(assistant.delta, text=chunk)
        K->>R: PUBLISH seq
        R-->>A: 通知（新 seq）
        A->>Q: listEvents 增量 → chunksFrom
        A-->>W: data: {"type":"text-delta","delta":"…"}\n\n
        W->>U: useChat 增量渲染（节流 24ms）
    end
    S-->>K: usage_metadata（本轮结束）
    K->>Q: appendEvent(usage.updated) + run.completed
    K->>R: PUBLISH
    R-->>A: 通知
    A-->>W: finish 帧 → SSE end
    W->>U: 状态置 idle，展示复制按钮 + token 用量
```

## 三、任务队列：为什么要队列，以及它如何不阻塞流式

- **入队即返回**：`POST /api/chat` 只写 `runs` 表（`createRun`）并 `outbox.wake()`，立刻转入 SSE 推流，不等待模型。
- **Worker 认领**：Worker 常驻轮询队列；`tryMarkRunRunning` 原子认领，防止并发 Worker 重复执行。`outbox.wake()` 只是「踢一脚」减少轮询延迟。
- **事件即状态**：Worker 执行产生的每个事件（delta、工具调用、todo、usage…）先 `appendEvent` 落库拿到自增 `seq`，再 `PUBLISH` 到 `runEventsChannel(runId)`。事件表是唯一事实源，SSE 只是它的「直播通道」。
- **推流与执行解耦**：API 的 `streamWorkflowRun` 不认识 Worker，它只做两件事——把事件表里已有的内容补发给你，再订阅 Redis 增量续播。因此浏览器刷新、断线、换页都不丢数据。

### SSE 帧的生成规则（chat-stream.ts）

`chunksFrom(runId, events)` 把持久化事件翻译成 [Vercel AI UIMessage Stream](https://ai-sdk.dev) 协议帧：

| 持久化事件 | 产生的 SSE 帧 |
| --- | --- |
| （流开始） | `start`（含 messageId、runId 元数据） |
| 非 delta 的 AgentEvent | `data-agent`（transient，供过程区/轨迹面板） |
| 第一个 `assistant.delta` | `text-start` |
| 每个 `assistant.delta` | `text-delta`（delta 原文） |
| `run.completed/failed/cancelled` | `text-end` + `finish` |

`createCoalescedRunner` 保证并发通知被合并串行处理——最后一次通知若被丢弃，`finish` 永远不会发出，前端会永远停在「正在执行」，这是用合并队列而不是丢弃策略的原因。响应头带 `X-Accel-Buffering: no` 禁用代理缓冲，每 15s 发 SSE 注释心跳防断连。

## 四、正文与旁白分流（流式的关键难点）

Agent 用 LangGraph 的 `stream(streamMode: ['values','messages','tools'])`。`messages` 模式下模型每个 token chunk 都会到达，但**带工具调用的轮次里 content 是过程旁白**（DeepSeek 习惯把「我先看下文件…」写进 content），不能进正文。分流规则：

```mermaid
flowchart TD
    A["收到 messages chunk"] --> B{"本轮已出现 tool_calls？"}
    B -- "否（还没决定调工具）" --> C["立即 yield assistant.delta<br/>（逐 token 流式，打字机效果）"]
    C --> D{"chunk 带 usage_metadata？"}
    D -- "是（本轮结束）" --> H["usage.updated → 重置轮次状态"]
    B -- "是（这是工具轮）" --> E["缓冲 turnText，不发"]
    E --> D
    D -- "是" --> F["yield assistant.narration<br/>（只补发缓冲部分，扣除已流出前缀）"]
    F --> H
```

- **最终答复**：不带工具调用的那一轮，每个 chunk 立即作为 `assistant.delta` 发出 → 前端逐字渲染。
- **过程旁白**：一旦本轮出现 `tool_calls`（或 `tool_call_chunks`），该轮文字降级为 `assistant.narration`，进「执行日志」过程区而非消息正文。
- **极少数「先输出文字、后决定调工具」的轮次**：文字前缀已经流出到正文，只补发检测到工具调用之后缓冲的剩余部分（`turnText.slice(turnEmittedLen)`），避免重复。系统提示词同时约束模型「调工具的轮次不要输出解释」。

## 五、前端渲染链路

```mermaid
flowchart LR
    SSE["SSE 字节流"] --> TF["createTrackedFetch<br/>（透传 + 统计完整帧数 → 游标）"]
    TF --> T["WorkflowChatTransport<br/>解析 UIMessage Stream"]
    T --> C["useChat(throttle: 24ms)<br/>messages 状态增量更新"]
    C --> R["React 渲染<br/>text-delta 追加到最后一条 assistant"]
    TF --> P["updatePersistedCursor<br/>localStorage 持久化游标"]
    P -.断线重连.-> T
```

- `useChat` 的 `throttle: 24` 把高频 delta 合并到 ~40fps 渲染，既流式又不卡。
- `WorkflowChatTransport` 负责 `prepareSendMessagesRequest`（带上 chat_id）、`onChatSendMessage`（持久化 runId 到 localStorage，供刷新后恢复）。
- **断线续传**：重连时 `GET /api/chat/:runId/stream`，用 `startIndex`（负数表示从尾部回退）或 `x-page-resume: 1`（全量重放）对齐游标；服务端按游标切片补发，不重不漏。

## 六、关键文件索引

| 层 | 文件 | 职责 |
| --- | --- | --- |
| Web | `apps/web/app/components/resilient-chat/chat-runtime.tsx` | useChat + transport 组装、事件 → 过程区/轨迹映射 |
| Web | `apps/web/app/components/resilient-chat/events.ts` | createTrackedFetch：透传流 + 统计帧游标 |
| API | `apps/api/src/routes.ts` | `POST /api/chat`（建 run + wake）、SSE 路由挂载 |
| API | `apps/api/src/chat-stream.ts` | streamWorkflowRun：SSE 推流、chunksFrom、合并 flush、心跳 |
| Worker | `apps/worker/src/worker.ts` / `processor.ts` | 队列轮询认领、沙箱生命周期、逐事件 persistEvent |
| Agent | `packages/agent-core/src/deep-agent.ts` | LangGraph 流 → AgentEvent；正文/旁白分流；usage 提取 |
| Agent | `packages/agent-core/src/model-router.ts` | 模型重试 / 熔断 / 降级（model.retry / model.fallback） |
| 共享 | `packages/contracts` | AgentEvent schema、runEventsChannel 频道名 |
| DB | `packages/db/src/repository.ts` | appendEvent（落库 + seq）、listEvents（游标切片） |

## 七、性能与可靠性要点

1. **逐 token 落库**：每个 delta 一次 `appendEvent` + `PUBLISH`（长回复约数百次）。事件表带 `run_id + seq` 索引，SSE 端每次只 `listEvents(cursor)` 增量切片。
2. **节流渲染**：前端 24ms 节流，避免每个 token 触发一次 React 提交。
3. **不丢结尾**：合并 flush 保证 `finish` 必达；Agent 收尾兜底把无 usage 轮次缓冲的旁白补发，避免丢内容。
4. **可恢复**：runId + 游标持久化在 localStorage，刷新/断网后自动 resume，从事件表重放，效果与 live 一致。
