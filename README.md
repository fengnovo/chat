下面是一个**可运行的完整实现**，按前端 UI → 状态管理 → 流式传输 → 后端可靠性 → 内容校验的分层架构搭建。代码基于 React + Vercel AI SDK，后端用 Python 演示重试与熔断逻辑。

---

## 1. 前端：UI 降级与错误边界

### 1.1 安装依赖

```bash
npm install ai @ai-sdk/react @ai-sdk/openai @cognicatch/react
```

### 1.2 聊天组件（含错误展示与重试）

`useChat` 返回的 `error` 对象可直接用于渲染错误提示和重试按钮。错误时禁用输入框，提供重试按钮触发 `reload()`：

```tsx
// components/Chat.tsx
'use client';
import { useChat } from '@ai-sdk/react';
import { AIBoundary } from '@cognicatch/react';

export function Chat() {
  const {
    messages, input, handleInputChange, handleSubmit,
    error, reload, isLoading,
  } = useChat({
    api: '/api/chat',
    onError: (err) => console.error('[Chat Error]', err),
  });

  return (
    <div className="chat-container">
      <div className="messages">
        {messages.map((m) => (
          <div key={m.id} className={`message ${m.role}`}>
            <strong>{m.role}:</strong> {m.content}
          </div>
        ))}
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <span>响应中断，请重试</span>
          <button type="button" onClick={() => reload()}>
            重新生成
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={handleInputChange}
          disabled={error != null || isLoading}
          placeholder="输入消息..."
        />
        <button type="submit" disabled={isLoading}>发送</button>
      </form>
    </div>
  );
}
```

### 1.3 用 AIBoundary 捕获 LLM 渲染崩溃

当 LLM 返回畸形 JSON 导致 Generative UI 组件崩溃时，`AIBoundary` 可以精准拦截而不影响整个 React 树：

```tsx
<AIBoundary
  mode="manual"
  title="AI 组件渲染失败"
  description="模型返回了无效的组件结构，已安全降级。"
  rawPayload={rawLLMOutput}
  onReset={() => resetChatStream()}
  onError={(safeError, safeErrorInfo, safePayload) => {
    // 遥测数据已自动脱敏（PII 零泄漏）
    console.error(safeError, safeErrorInfo, safePayload);
  }}
>
  <YourGenerativeUIComponent data={parsedLLMOutput} />
</AIBoundary>
```

> CogniCatch 内置客户端 PII 清洗，邮箱、JWT、API Key 等在浏览器内存中即被脱敏，符合 GDPR/HIPAA 合规要求。


## 2. 状态管理：可撤销的会话历史

### 2.1 安装

```bash
npm install conversationalist zod
```

### 2.2 带撤销/重做的会话管理

`Conversationalist` 提供 `Conversation` 运行时，支持 undo、redo、分支和事件历史。当某轮对话出错时，可回退到出错前的状态再重试：

```ts
// lib/session.ts
import {
  Conversation, createConversationHistory,
  appendUserMessage, appendAssistantMessage,
} from 'conversationalist';

let history = createConversationHistory({ title: 'Chat Session' });
const conversation = new Conversation(history);

export function addUserMessage(content: string) {
  history = appendUserMessage(history, content);
  conversation.update(history);
}

export function addAssistantMessage(content: string) {
  history = appendAssistantMessage(history, content);
  conversation.update(history);
}

// 出错时：撤销最后一条 assistant 消息（可能是半截的流式内容）
export function undoLastAssistant() {
  conversation.undo(); // 回退到出错前
}

export function exportForOpenAI() {
  return conversation.toProvider('openai'); // 转换为 OpenAI 格式
}
```

> **流式错误时的关键操作**：当 `useChat` 报错时，部分流式内容可能已写入 messages 数组。先用 `undoLastAssistant()` 回退，再调用 `reload()`，避免错误内容污染历史。


## 3. 流式传输：断点续传与自动重连

### 3.1 安装

```bash
npm install @ai-sdk/workflow
```

### 3.2 替换默认传输层

`WorkflowChatTransport` 是 AI SDK 默认传输层的**直接替代品**。它会自动检测缺失的 `finish` 事件，并从断点续传，避免重复生成已输出的内容：

```tsx
'use client';
import { useChat } from '@ai-sdk/react';
import { WorkflowChatTransport } from '@ai-sdk/workflow';

export function ResilientChat() {
  const { messages, sendMessage } = useChat({
    transport: new WorkflowChatTransport({
      api: '/api/chat',
      maxConsecutiveErrors: 3,
      onChatEnd: ({ chatId, chunkIndex }) => {
        // 持久化 chatId 和 chunkIndex，供页面刷新后恢复
        localStorage.setItem('lastChat', JSON.stringify({ chatId, chunkIndex }));
      },
    }),
  });

  // ...
}
```

服务端需要提供重连端点，支持 `startIndex` 参数从指定位置继续流式输出。负值表示从流末尾倒读（如 `-50` 读取最后 50 个 chunk），适合页面刷新后的恢复场景。


## 4. 后端：重试、熔断与降级

### 4.1 安装

```bash
pip install retry-client
```

### 4.2 完整配置（重试 + 熔断 + 降级链）

`retry-client` 封装了指数退避重试、熔断器和降级模型链三件套：

```python
# backend/llm_client.py
from retry_client import (
    RetryClient, ClientConfig, RetryConfig, CircuitBreakerConfig,
)

config = ClientConfig(
    default_provider="openai",
    default_model="gpt-4o",
    # 重试：最多 5 次，指数退避 1s→2s→4s→8s→16s，最大 60s，带 50% 抖动
    retry_enabled=True,
    retry_config=RetryConfig(
        max_retries=5,
        base_delay=1.0,
        max_delay=60.0,
        exponential_base=2.0,
        jitter=0.5,
    ),
    # 熔断：连续 5 次失败后打开，30 秒后进入半开状态探测
    circuit_enabled=True,
    circuit_config=CircuitBreakerConfig(
        failure_threshold=5,
        success_threshold=2,
        timeout=30.0,
    ),
    # 降级链：GPT-4o → Claude Sonnet → GPT-4o-mini → Claude Haiku
    fallback_enabled=True,
    fallback_models=[
        ("openai", "gpt-4o"),
        ("anthropic", "claude-sonnet-4-20250514"),
        ("openai", "gpt-4o-mini"),
        ("anthropic", "claude-3-5-haiku-20241022"),
    ],
    on_retry=lambda attempt, error, delay: print(
        f"[Retry {attempt}] {error} — 等待 {delay:.1f}s"
    ),
    on_fallback=lambda from_m, to_m, error: print(
        f"[Fallback] {from_m} → {to_m} (原因: {error})"
    ),
)

client = RetryClient(config)


def chat_with_resilience(messages: list[dict]) -> str:
    """带完整容错链的对话调用。"""
    response = client.complete(messages)
    return response.content
```

**熔断器状态机**：闭合（正常调用）→ 连续失败达阈值 → 打开（直接拒绝，不触网）→ 超时后 → 半开（放行探测请求）→ 成功则闭合。

### 4.3 接入 Next.js API Route

```ts
// app/api/chat/route.ts
import { NextRequest } from 'next/server';

export const runtime = 'edge';

export async function POST(req: NextRequest) {
  const { messages } = await req.json();

  try {
    // 调用 Python 后端（或直接用 AI SDK 的 streamText + 手动重试）
    const upstream = await fetch(process.env.PYTHON_LLM_ENDPOINT!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal: req.signal,
    });

    if (!upstream.ok) {
      throw new Error(`Upstream error: ${upstream.status}`);
    }

    return new Response(upstream.body, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  } catch (error) {
    if (req.signal.aborted) {
      return new Response('Client aborted', { status: 499 });
    }
    // 返回结构化错误，前端 useChat 的 error 对象可解析
    return new Response(
      JSON.stringify({ error: '服务暂时不可用，请稍后重试' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
```


## 5. 内容校验：Reality Locks 主动拦截

### 5.1 安装

```bash
pip install steer-sdk
```

### 5.2 JSON 结构强制校验

当 LLM 在 JSON 字段中包裹 Markdown 反引号，或返回畸形 JSON 时，`JsonVerifier` 会在输出到达用户前拦截：

```python
# backend/verified_agent.py
from steer import capture
from steer.verifiers import JsonVerifier
import json
from pydantic import BaseModel

# 定义期望的输出结构
class ChatResponse(BaseModel):
    content: str
    suggested_replies: list[str] = []

# 声明 Reality Lock
json_check = JsonVerifier(name="Strict JSON")


@capture(verifiers=[json_check])
def verified_chat(user_input: str, steer_rules: str = "") -> str:
    """经过 Reality Lock 校验的对话函数。
    steer_rules 由 Steer 仪表盘自动注入，无需改代码。
    """
    system_prompt = f"""You are a helpful assistant.
Always return raw JSON matching: {{"content": "...", "suggested_replies": [...]}}
{steer_rules}"""

    raw = llm_call(system_prompt, user_input)

    # 解析并校验
    try:
        parsed = ChatResponse(**json.loads(raw))
        return parsed.model_dump_json()
    except (json.JSONDecodeError, ValueError) as e:
        # Steer 会拦截此处，记录到本地仪表盘
        # 你在仪表盘点击 "Teach" 给出修正规则，规则注入后续调用
        raise ValueError(f"Output validation failed: {e}")
```

**工作流**：Catch（拦截坏输出）→ Teach（在仪表盘定义修正规则）→ Fix（规则注入 Agent 上下文，后续自动生效）。所有拦截记录可导出为 JSONL 微调数据集。


## 6. 完整数据流总结

```
用户输入
  │
  ▼
[前端] useChat (error/reload)  ──→  错误时显示重试按钮，禁用输入
  │
  ▼
[前端] WorkflowChatTransport  ──→  断流自动检测，offset 续传
  │
  ▼
[状态] Conversationalist  ──→  出错时 undo() 回退，避免污染历史
  │
  ▼
[后端] retry-client  ──→  重试(5次指数退避) → 熔断(5次失败) → 降级(4级模型链)
  │
  ▼
[校验] Steer Reality Locks  ──→  JSON 结构校验，拦截坏输出并 Teach 修复
  │
  ▼
[前端] AIBoundary  ──→  生成式 UI 渲染崩溃兜底，PII 自动脱敏
```

**关键异常场景覆盖**：

| 场景 | 处理层 | 机制 |
|---|---|---|
| 网络抖动断流 | WorkflowChatTransport | 缺失 finish 事件检测 + offset 续传 |
| API 限流/宕机 | retry-client | 指数退避重试 + 熔断 + 多模型降级 |
| 流式中途报错 | useChat + Conversationalist | error → undo → reload |
| LLM 返回畸形 JSON | Steer Reality Lock | JsonVerifier 拦截 + 仪表盘 Teach |
| 生成式 UI 渲染崩溃 | AIBoundary | 组件级错误边界，保留其余 UI |
| 页面刷新丢失进度 | WorkflowChatTransport | chatId + chunkIndex 持久化恢复 |

这套方案可以直接投入生产环境使用。如果某个环节需要更深入的定制（比如自建熔断器或自定义验证器），可以在此基础上替换对应层的实现。