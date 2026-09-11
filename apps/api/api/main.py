"""Local, runnable reference backend for the resilient chat demo.

The application deliberately uses deterministic model adapters instead of a
paid provider so every reliability path in the README can be exercised without
API keys. Replace ``simulate_model_call`` with a real provider in production.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, AsyncIterator, Literal
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, ValidationError


app = FastAPI(
    title="Resilient Chat API",
    description="Resumable streaming, retries, circuit breaking and output locks.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["x-workflow-run-id", "x-workflow-stream-tail-index"],
)


class ChatRequest(BaseModel):
    messages: list[dict[str, Any]] = Field(default_factory=list)
    chat_id: str | None = None
    trigger: str | None = None


class InsightCard(BaseModel):
    kind: Literal["reliability-summary", "unsupported-widget"] = (
        "reliability-summary"
    )
    eyebrow: str
    title: str
    body: str
    metric: str
    metric_label: str


class ChatResponse(BaseModel):
    content: str
    suggested_replies: list[str] = Field(default_factory=list)
    card: InsightCard | None = None


@dataclass(frozen=True)
class ModelTarget:
    provider: str
    model: str

    @property
    def label(self) -> str:
        return f"{self.provider}/{self.model}"


MODEL_CHAIN = (
    ModelTarget("openai", "gpt-4o"),
    ModelTarget("anthropic", "claude-sonnet-4"),
    ModelTarget("openai", "gpt-4o-mini"),
    ModelTarget("anthropic", "claude-3-5-haiku"),
)


@dataclass
class CircuitBreaker:
    failure_threshold: int = 5
    success_threshold: int = 2
    timeout_seconds: float = 30.0
    failures: int = 0
    half_open_successes: int = 0
    opened_at: float | None = None

    @property
    def state(self) -> Literal["closed", "open", "half-open"]:
        if self.opened_at is None:
            return "closed"
        if time.monotonic() - self.opened_at >= self.timeout_seconds:
            return "half-open"
        return "open"

    def allows_request(self) -> bool:
        return self.state != "open"

    def record_failure(self) -> None:
        self.failures += 1
        self.half_open_successes = 0
        if self.failures >= self.failure_threshold:
            self.opened_at = time.monotonic()

    def record_success(self) -> None:
        if self.state == "half-open":
            self.half_open_successes += 1
            if self.half_open_successes < self.success_threshold:
                return
        self.failures = 0
        self.half_open_successes = 0
        self.opened_at = None


BREAKERS = {target.label: CircuitBreaker() for target in MODEL_CHAIN}
FAILED_ONCE_PROMPTS: set[str] = set()


class PipelineEvent(BaseModel):
    id: str
    stage: Literal[
        "request", "retry", "circuit", "fallback", "verify", "transport", "done"
    ]
    status: Literal["running", "success", "warning", "error"]
    title: str
    detail: str
    timestamp: str


@dataclass
class RunRecord:
    run_id: str
    chat_id: str
    chunks: list[dict[str, Any]]
    created_at: float = field(default_factory=time.time)
    initial_cutoff: int = 0


RUNS: dict[str, RunRecord] = {}


def now_label() -> str:
    return datetime.now(UTC).astimezone().strftime("%H:%M:%S")


def event(
    stage: Literal[
        "request", "retry", "circuit", "fallback", "verify", "transport", "done"
    ],
    status: Literal["running", "success", "warning", "error"],
    title: str,
    detail: str,
) -> PipelineEvent:
    return PipelineEvent(
        id=f"evt-{uuid4().hex[:10]}",
        stage=stage,
        status=status,
        title=title,
        detail=detail,
        timestamp=now_label(),
    )


def extract_text(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    parts = message.get("parts", [])
    if not isinstance(parts, list):
        return ""
    return "".join(
        str(part.get("text", ""))
        for part in parts
        if isinstance(part, dict) and part.get("type") == "text"
    )


def last_user_text(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            return extract_text(message).strip()
    return ""


def build_answer(user_input: str, model: ModelTarget) -> ChatResponse:
    normalized = user_input.lower()

    if any(word in normalized for word in ("你好", "hello", "嗨")):
        body = (
            "你好，我是这套可靠性链路的本地演示助手。即使传输被主动截断，"
            "当前回复也会通过 offset 自动续传，不会重复已经显示的内容。"
        )
    elif any(word in normalized for word in ("降级", "fallback", "熔断")):
        body = (
            f"降级演练已完成。主模型的失败已被重试与熔断器隔离，"
            f"本轮由 {model.label} 接管并返回了完整结果。右侧轨迹记录了每个决策。"
        )
    elif any(word in normalized for word in ("json", "畸形", "校验", "reality")):
        body = (
            "Reality Lock 已先拦截不符合 schema 的输出，再应用 Teach 修复规则。"
            "只有通过 Pydantic 结构校验的 content、suggested_replies 和 card 才会进入 UI。"
        )
    elif any(word in normalized for word in ("隐私", "pii", "邮箱", "token")):
        body = (
            "敏感数据只用于这次本地演示。生成式卡片被组件级 AIBoundary 隔离；"
            "错误遥测交给 CogniCatch 在客户端清洗，聊天主体不会因卡片失败而消失。"
        )
    else:
        body = (
            f"我收到了你的消息：“{user_input or '空消息'}”。这是一个无需 API Key 的"
            "本地可靠性演示回复：请求已通过重试、熔断、模型降级与结构校验管线，"
            "并以可断点续传的 SSE 流返回。"
        )

    card_kind: Literal["reliability-summary", "unsupported-widget"] = (
        "unsupported-widget"
        if any(word in normalized for word in ("渲染崩溃", "boundary", "组件崩溃"))
        else "reliability-summary"
    )

    return ChatResponse(
        content=body,
        suggested_replies=["演示模型降级", "演示畸形 JSON 修复", "演示组件崩溃"],
        card=InsightCard(
            kind=card_kind,
            eyebrow="RESILIENCE REPORT",
            title="本轮链路保持完整",
            body="流式响应经过可恢复传输与输出锁后才进入界面。",
            metric="6/6",
            metric_label="保护层已通过",
        ),
    )


async def simulate_model_call(user_input: str, target: ModelTarget) -> str:
    """Provider seam used by the demo; swap this for an SDK call in production."""
    await asyncio.sleep(0.045)

    lowered = user_input.lower()
    force_primary_failure = any(
        word in lowered for word in ("降级", "fallback", "熔断")
    )
    force_all_failure = any(word in lowered for word in ("全部失败", "永久故障"))

    if force_all_failure or (force_primary_failure and target == MODEL_CHAIN[0]):
        raise RuntimeError(f"{target.label} simulated 503")

    response = build_answer(user_input, target)
    raw = response.model_dump_json()

    if any(word in lowered for word in ("json", "畸形", "校验", "reality")):
        # Deliberately violate the transport contract. The Teach rule below
        # removes the markdown fence and trailing comma before re-validating.
        raw = f"```json\n{raw[:-1]},\n}}\n```"
    return raw


async def complete_with_resilience(
    user_input: str,
) -> tuple[str, ModelTarget, list[PipelineEvent]]:
    events: list[PipelineEvent] = [
        event("request", "running", "请求已进入可靠性管线", "已创建可追踪的 workflow run")
    ]
    last_error: Exception | None = None

    for target_index, target in enumerate(MODEL_CHAIN):
        breaker = BREAKERS[target.label]
        if not breaker.allows_request():
            events.append(
                event(
                    "circuit",
                    "warning",
                    f"{target.model} 熔断器已打开",
                    "跳过网络调用，直接进入下一降级模型",
                )
            )
            continue

        for attempt in range(1, 6):
            try:
                raw = await simulate_model_call(user_input, target)
                breaker.record_success()
                events.append(
                    event(
                        "retry",
                        "success",
                        f"{target.model} 调用成功",
                        f"第 {attempt} 次尝试完成",
                    )
                )
                return raw, target, events
            except Exception as exc:
                last_error = exc
                breaker.record_failure()
                if attempt < 5:
                    delay = min(0.04 * (2 ** (attempt - 1)), 0.24)
                    events.append(
                        event(
                            "retry",
                            "warning",
                            f"第 {attempt} 次调用失败",
                            f"指数退避 {int(delay * 1000)}ms 后重试",
                        )
                    )
                    await asyncio.sleep(delay)

        events.append(
            event(
                "circuit",
                "warning",
                f"{target.model} 已触发熔断",
                "连续 5 次失败，30 秒后进入半开探测",
            )
        )
        if target_index < len(MODEL_CHAIN) - 1:
            next_target = MODEL_CHAIN[target_index + 1]
            events.append(
                event(
                    "fallback",
                    "running",
                    "模型降级切换",
                    f"{target.model} → {next_target.model}",
                )
            )

    raise RuntimeError(f"All fallback models failed: {last_error}")


def teach_repair(raw: str) -> str:
    repaired = raw.strip()
    repaired = re.sub(r"^```(?:json)?\s*", "", repaired, flags=re.IGNORECASE)
    repaired = re.sub(r"\s*```$", "", repaired)
    repaired = re.sub(r",\s*([}\]])", r"\1", repaired)
    return repaired


def verify_output(raw: str) -> tuple[ChatResponse, list[PipelineEvent]]:
    events: list[PipelineEvent] = []
    try:
        parsed = ChatResponse.model_validate_json(raw)
        events.append(
            event("verify", "success", "Reality Lock 已通过", "输出严格匹配 ChatResponse schema")
        )
        return parsed, events
    except (ValidationError, ValueError):
        events.append(
            event("verify", "warning", "Catch：已拦截畸形 JSON", "Markdown 包裹或 JSON 尾逗号不合规")
        )

    repaired = teach_repair(raw)
    try:
        parsed = ChatResponse.model_validate_json(repaired)
    except (ValidationError, ValueError) as exc:
        events.append(
            event("verify", "error", "Fix 失败", "修复后仍未通过 schema，输出已阻断")
        )
        raise RuntimeError(f"Output validation failed: {exc}") from exc

    events.append(
        event("verify", "success", "Teach → Fix 已生效", "已移除代码围栏与尾逗号并再次通过校验")
    )
    return parsed, events


def chunk_text(text: str) -> list[str]:
    return [text[index : index + 3] for index in range(0, len(text), 3)]


def build_chunks(
    run_id: str,
    response: ChatResponse,
    model: ModelTarget,
    pipeline_events: list[PipelineEvent],
) -> tuple[list[dict[str, Any]], int]:
    message_id = f"message-{run_id}"
    text_id = f"text-{run_id}"
    chunks: list[dict[str, Any]] = [
        {
            "type": "start",
            "messageId": message_id,
            "messageMetadata": {"model": model.label, "runId": run_id},
        }
    ]

    chunks.extend(
        {
            "type": "data-pipeline",
            "data": pipeline_event.model_dump(),
            "transient": True,
        }
        for pipeline_event in pipeline_events
    )
    chunks.append({"type": "text-start", "id": text_id})

    text_chunks = chunk_text(response.content)
    midpoint = max(1, len(text_chunks) // 2)
    for delta in text_chunks[:midpoint]:
        chunks.append({"type": "text-delta", "id": text_id, "delta": delta})

    # The initial response closes before this event. WorkflowChatTransport sees
    # the missing finish chunk and reconnects with startIndex=initial_cutoff.
    initial_cutoff = len(chunks)
    chunks.append(
        {
            "type": "data-pipeline",
            "data": event(
                "transport",
                "success",
                "流式连接已从断点恢复",
                f"offset {initial_cutoff}，未重复生成已有内容",
            ).model_dump(),
            "transient": True,
        }
    )
    for delta in text_chunks[midpoint:]:
        chunks.append({"type": "text-delta", "id": text_id, "delta": delta})

    chunks.extend(
        [
            {"type": "text-end", "id": text_id},
            {"type": "data-card", "data": response.card.model_dump() if response.card else None},
            {"type": "data-suggestions", "data": response.suggested_replies},
            {
                "type": "data-pipeline",
                "data": event(
                    "done",
                    "success",
                    "本轮响应安全完成",
                    f"{len(chunks) + 2} 个 chunk 已确认",
                ).model_dump(),
                "transient": True,
            },
            {"type": "finish", "finishReason": "stop"},
        ]
    )
    return chunks, initial_cutoff


def sse_frame(chunk: dict[str, Any]) -> bytes:
    payload = json.dumps(chunk, ensure_ascii=False, separators=(",", ":"))
    return f"data: {payload}\n\n".encode()


async def stream_chunk_range(
    chunks: list[dict[str, Any]], start: int, end: int | None = None
) -> AsyncIterator[bytes]:
    for chunk in chunks[start:end]:
        yield sse_frame(chunk)
        await asyncio.sleep(0.028)


def stream_headers(run_id: str) -> dict[str, str]:
    return {
        "x-workflow-run-id": run_id,
        "x-vercel-ai-ui-message-stream": "v1",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
    }


@app.post("/api/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    user_input = last_user_text(request.messages)
    if not user_input:
        raise HTTPException(status_code=400, detail="消息不能为空")

    fail_once = any(word in user_input.lower() for word in ("错误恢复", "fail once"))
    if fail_once and user_input not in FAILED_ONCE_PROMPTS:
        FAILED_ONCE_PROMPTS.add(user_input)
        raise HTTPException(status_code=503, detail="模拟上游瞬时故障：点击重新生成即可恢复")

    try:
        raw, model, resilience_events = await complete_with_resilience(user_input)
        verified, verifier_events = verify_output(raw)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="所有模型暂时不可用，请稍后重试") from exc

    run_id = uuid4().hex
    chunks, initial_cutoff = build_chunks(
        run_id, verified, model, resilience_events + verifier_events
    )
    RUNS[run_id] = RunRecord(
        run_id=run_id,
        chat_id=request.chat_id or "anonymous",
        chunks=chunks,
        initial_cutoff=initial_cutoff,
    )

    if len(RUNS) > 100:
        oldest = min(RUNS.values(), key=lambda item: item.created_at)
        RUNS.pop(oldest.run_id, None)

    return StreamingResponse(
        stream_chunk_range(chunks, 0, initial_cutoff),
        media_type="text/event-stream",
        headers=stream_headers(run_id),
    )


@app.get("/api/chat/{run_id}/stream")
async def resume_chat(
    run_id: str,
    start_index: int = Query(default=0, alias="startIndex"),
    x_page_resume: str | None = Header(default=None),
) -> StreamingResponse:
    record = RUNS.get(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="可续传的运行记录不存在或已过期")

    total = len(record.chunks)
    resolved_start = max(0, total + start_index) if start_index < 0 else min(start_index, total)

    # useChat creates a new assistant message on a page-level resume. Replaying
    # from the beginning gives it a complete text-start/text-end pair.
    if x_page_resume == "1":
        resolved_start = 0

    headers = stream_headers(run_id)
    headers["x-workflow-stream-tail-index"] = str(max(total - 1, 0))
    return StreamingResponse(
        stream_chunk_range(record.chunks, resolved_start),
        media_type="text/event-stream",
        headers=headers,
    )


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "active_runs": len(RUNS),
        "model_chain": [
            {
                "model": target.label,
                "circuit": BREAKERS[target.label].state,
                "failures": BREAKERS[target.label].failures,
            }
            for target in MODEL_CHAIN
        ],
    }
