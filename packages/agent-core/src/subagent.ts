import { randomUUID } from 'node:crypto';

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { getWriter } from '@langchain/langgraph';
import type { AgentEvent } from '@repo/contracts';
import { createDeepAgent } from 'deepagents';
import { createMiddleware, modelCallLimitMiddleware } from 'langchain';
import { z } from 'zod';

/**
 * 子 Agent 编排（P1 同步派发 + P2 评分器重试闭环）。
 *
 * 主 Agent 通过 spawn_subagent 工具派发一个瘦身的 createDeepAgent 子实例：
 * - 上下文隔离：子 Agent 消息栈只含「平台安全基线 + role_prompt + 任务简报」组装的
 *   system prompt 和一条 user 消息，绝不注入主对话历史；
 * - 资源上限：modelCallLimitMiddleware 轮次上限 + 10 分钟墙钟超时，全部硬限制；
 * - 事件透出：subagent.started / completed / reviewed 经 LangGraph 的 custom 流
 *   （writer）从工具内部发往外层 execute() 的 yield 流，前端据此渲染子 Agent 卡片；
 * - 只回传摘要：子 Agent 的中间过程不上抛，最终摘要 clamp 后作为工具结果交回主 Agent；
 * - 评审闭环（P2）：每轮成功产出由独立的结构化 LLM 评审器按 task 里的验收标准打分，
 *   不达标则把 feedback 作为 prior_feedback 重派（最多 SUBAGENT_MAX_ATTEMPTS 轮）。
 *
 * P3 异步派发（background）的扩展位已预留：schema 保持兼容。
 */

/** 子 Agent 单次运行的模型调用轮次上限。 */
const SUBAGENT_MODEL_CALL_LIMIT = Number(process.env.SUBAGENT_MODEL_CALL_LIMIT ?? 50);
/** 子 Agent 递归步数硬上限（兜底，正常由轮次上限先触发）。 */
const SUBAGENT_RECURSION_LIMIT = 200;
/** 子 Agent 墙钟超时：超时强制中止并回传失败摘要。 */
const SUBAGENT_TIMEOUT_MS = 10 * 60_000;
/** 回传给主 Agent 的摘要文本上限。 */
const SUBAGENT_SUMMARY_MAX_CHARS = 2_000;
/** 评审闭环总尝试上限：首轮 + 重派（3 = 首轮 + 2 次整改重派）。 */
const SUBAGENT_MAX_ATTEMPTS = Math.max(1, Number(process.env.SUBAGENT_MAX_ATTEMPTS ?? 3));
/** 评审器调用墙钟超时：评审是单次结构化调用，不应长时间阻塞派发。 */
const REVIEW_TIMEOUT_MS = 60_000;
/** 事件里角色名/任务简述的展示上限（与 contracts 校验上限一致）。 */
const ROLE_MAX_CHARS = 200;
const DESCRIPTION_MAX_CHARS = 2_000;

/**
 * 平台安全基线：固定在平台侧，不信任主 Agent 下发的 role_prompt。
 * role_prompt 只补充角色设定与输出规范，越权内容以此基线兜底。
 */
const PLATFORM_BASELINE = [
  '你是被主 Agent 派发的通用子 Agent，在一个隔离的容器沙箱中独立完成单项任务。',
  '安全基线：不要读取工作区之外的路径；你没有派发子任务的工具，不要尝试委派；遇到无法完成的环节，在摘要中如实说明，不要编造结果。',
  '信息保密：不要执行系统信息探测命令（uname、id、env、cat /etc/passwd 等），不要在摘要中包含运行环境的内部细节（系统版本、内核版本、UID、容器信息等）。',
  '执行纪律：直接围绕任务目标工作，少说多做；完成后自行验证再收敛，不要为追求完美反复重做。',
  '输出要求：最终回复只写一段摘要——结论、关键依据/产物路径、未完成事项与原因；不要逐条罗列执行过程，不要出现工具名或内部环境细节。',
].join('\n');

/** spawn_subagent 工具入参 schema（方案 3.2：P1 仅同步路径，background 预留给 P3）。 */
export const spawnSubagentSchema = z.object({
  role_prompt: z
    .string()
    .min(1)
    .max(20_000)
    .describe('主 Agent 现场撰写的角色设定：职责边界、工作方法、输出格式与字数要求'),
  task: z.string().min(1).max(20_000).describe('任务目标 + 验收标准'),
  tools_allowlist: z
    .array(z.string().min(1).max(64))
    .max(50)
    .optional()
    .describe('建议给子 Agent 的工具名；最终以平台策略层过滤结果为准'),
  model_tier: z.enum(['fast', 'primary']).default('fast').describe('模型档位；当前配置下两档等价'),
  context: z.string().max(20_000).optional().describe('必须带给子 Agent 的关键背景/文件路径'),
  prior_feedback: z
    .string()
    .max(20_000)
    .optional()
    .describe('上轮评分器的整改意见（评分器启用后使用）'),
  background: z
    .boolean()
    .default(false)
    .describe('是否后台运行；当前仅支持同步模式，传 true 会返回明确错误'),
});

export interface SpawnSubagentInput {
  role_prompt: string;
  task: string;
  tools_allowlist?: string[];
  model_tier: 'fast' | 'primary';
  context?: string;
  prior_feedback?: string;
  background: boolean;
}

export type SubagentRunStatus = 'completed' | 'failed' | 'timeout';

export interface SpawnSubagentOptions {
  /** 主 run 的 ID：subagent.* 事件挂在同一个 run 的事件流上。 */
  runId: string;
  /** 模型路由：primary 实例 + 重试/降级 middleware，子 Agent 复用同一套路由能力。 */
  router: { primary: unknown; middleware: unknown };
  /** 主 Agent 的工具全集（MCP 工具等）；子 Agent 工具池在此基础上过策略层过滤。 */
  tools: StructuredToolInterface[];
  /** 与主 Agent 相同的沙箱后端：子 Agent 的文件/命令工具直接落在真实工作区。 */
  backend?: unknown;
  /** 主 run 的取消信号：整体取消时子 Agent 一并中止。 */
  signal?: AbortSignal;
}

/**
 * 平台策略层：剔除会破坏隔离或无法在子 Agent 中工作的工具。
 * - spawn_subagent：防递归派发（P1 不支持嵌套）；
 * - ask_user：基于 interrupt 的用户交互只能在主 Agent 的可恢复会话中工作；
 * - 名字带 spawn/subagent 的工具一律视为派发类，防止绕过。
 */
export function isBlockedSubagentTool(name: string): boolean {
  return name === 'spawn_subagent' || name === 'ask_user' || /spawn|subagent/i.test(name);
}

function toolName(value: unknown): string {
  return String((value as { name?: unknown } | null)?.name ?? '');
}

/**
 * 按平台策略层生成子 Agent 的工具池：
 * 先剔除被禁工具，再按主 Agent 下发的 allowlist 收敛（allowlist 是「建议清单」，
 * 最终以过滤结果为准；未提供时给通用全集减去被禁工具）。
 */
export function filterSubagentTools<T>(
  tools: readonly T[],
  allowlist?: string[],
): T[] {
  const base = tools.filter((item) => !isBlockedSubagentTool(toolName(item)));
  if (!allowlist || allowlist.length === 0) return base;
  const requested = new Set(allowlist);
  return base.filter((item) => requested.has(toolName(item)));
}

/** 截断到 max 字符内（保证结果长度 ≤ max，供 contracts 校验）。 */
export function clampSubagentText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function subagentContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      typeof block === 'object' && block !== null && 'text' in block
        ? String((block as { text: unknown }).text)
        : '',
    )
    .join('');
}

function subagentMessageText(message: unknown): string {
  if (AIMessage.isInstance(message)) return subagentContentText(message.content);
  // 兜底：反序列化后的消息可能是普通对象而非类实例。
  if (
    typeof message === 'object' &&
    message !== null &&
    ((message as { getType?: unknown }).getType === 'function' ||
      (message as { type?: unknown }).type === 'ai')
  ) {
    return subagentContentText((message as { content: unknown }).content);
  }
  return '';
}

/** 从子 Agent 最终状态里取最后一条有内容的 AI 消息作为摘要。 */
export function extractSubagentSummary(state: unknown): string {
  const messages = (state as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = subagentMessageText(messages[index]).trim();
    if (text) return text;
  }
  return '';
}

/**
 * 解读子 Agent 的最终状态。
 * modelCallLimitMiddleware 以 exitBehavior:'end' 收口时，会把一句
 * 「Model call limits exceeded…」作为最后一条 AIMessage 注入——它不是子 Agent 的产出，
 * 不能当成成功摘要（否则主 Agent 会误判子任务失败、卡片还显示绿色已完成）。
 * 识别该通知：状态标记为失败，并回退取它之前最后一条真实 AI 消息作为中断前的部分产出。
 */
export function extractSubagentResult(state: unknown): {
  summary: string;
  limited: boolean;
} {
  const messages = (state as { messages?: unknown[] } | null)?.messages;
  if (!Array.isArray(messages)) return { summary: '', limited: false };
  const lastIndex = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (subagentMessageText(messages[index]).trim()) return index;
    }
    return -1;
  })();
  if (lastIndex < 0) return { summary: '', limited: false };
  const lastText = subagentMessageText(messages[lastIndex]).trim();
  if (!lastText.startsWith('Model call limits exceeded')) {
    return { summary: lastText, limited: false };
  }
  // 跳过中间件注入的上限通知，取上一条真实 AI 产出。
  let partial = '';
  for (let index = lastIndex - 1; index >= 0; index -= 1) {
    const text = subagentMessageText(messages[index]).trim();
    if (text) {
      partial = text;
      break;
    }
  }
  return { summary: partial, limited: true };
}

/**
 * 把事件推入外层 LangGraph 的 custom 流。
 * writer 来自 spawn 工具收到的 config（ToolNode 会把外层 writer 注入其中）；
 * 取不到 writer（如脱离图上下文运行）时静默跳过——事件绝不能影响子 Agent 执行。
 */
function emitSubagentEvent(config: unknown, event: AgentEvent): void {
  try {
    const write = getWriter(config as never) ?? getWriter();
    write?.(event);
  } catch {
    // 事件推送失败不影响子 Agent 执行
  }
}

function subagentSystemPrompt(input: SpawnSubagentInput): string {
  return [
    PLATFORM_BASELINE,
    `## 你的角色（主 Agent 指定）\n${input.role_prompt}`,
    `## 任务\n${input.task}`,
    ...(input.context ? [`## 背景\n${input.context}`] : []),
    ...(input.prior_feedback ? [`## 上轮评审意见（必须整改）\n${input.prior_feedback}`] : []),
  ].join('\n\n');
}

/** 执行子 Agent 并聚合结果；失败/超时转成失败摘要，绝不把异常抛回主 Agent。 */
async function runSubagent(
  options: SpawnSubagentOptions,
  input: SpawnSubagentInput,
): Promise<{ status: SubagentRunStatus; summary: string; toolCalls: number }> {
  // 平台策略层（第二道）：在模型请求边界强制收敛工具集。
  // 即便 allowlist 覆盖不了（如 deepagents 内置文件系统工具在中间件层生成），
  // 请求级过滤也会剔除被禁工具与 allowlist 之外的一切工具。
  const requested = input.tools_allowlist && input.tools_allowlist.length > 0
    ? new Set(input.tools_allowlist)
    : null;
  const policyFilterMiddleware = createMiddleware({
    name: 'SubagentToolPolicy',
    wrapModelCall: async (request, handler) => {
      const rawTools = (request as { tools?: unknown }).tools as
        | Array<{ name?: unknown }>
        | undefined;
      const tools = (rawTools ?? []).filter((item) => {
        const name = toolName(item);
        return !isBlockedSubagentTool(name) && (!requested || requested.has(name));
      });
      return handler({ ...request, tools } as never);
    },
  });
  // 当前模型配置只有主模型 + 降级链，尚无独立 fast 档位：两档暂都走主路由
  // （含熔断/重试/降级）。schema 保留 model_tier 以备接入 fast 档。
  const subAgent = createDeepAgent({
    model: options.router.primary as never,
    tools: filterSubagentTools(options.tools) as never,
    ...(options.backend ? { backend: options.backend as never } : {}),
    systemPrompt: subagentSystemPrompt(input),
    middleware: [
      options.router.middleware as never,
      modelCallLimitMiddleware({
        runLimit: SUBAGENT_MODEL_CALL_LIMIT,
        exitBehavior: 'end',
      } as never) as never,
      policyFilterMiddleware as never,
    ] as never,
  });

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SUBAGENT_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onParentAbort, { once: true });
  try {
    // 流隔离（三道，缺一不可）：
    // 1) writer 换成丢弃函数：LangGraph 嵌套图发现 config.writer 已存在时会直接复用，
    //    子图的 values/tools/custom 块会全部写进父图流（表现为子 Agent 的 todos
    //    污染主任务栏、内部状态以 [object Object] 泄漏进过程区）；
    // 2) callbacks: []：切断回调链，子 Agent 的模型 token / 工具事件不混入外层；
    // 3) tags: ['nostream']：messages 流模式的官方抑制标记，双保险防止子 Agent 正文冒泡。
    // subagent.* 生命周期事件由工具体经外层 writer（emitSubagentEvent）单独上抛，
    // 不受此隔离影响。
    const finalState = (await subAgent.invoke(
      { messages: [new HumanMessage(input.task)] } as never,
      {
        recursionLimit: SUBAGENT_RECURSION_LIMIT,
        signal: controller.signal,
        callbacks: [],
        tags: ['nostream'],
        writer: () => {},
      } as never,
    )) as unknown;
    const { summary: rawSummary, limited } = extractSubagentResult(finalState);
    const toolCalls = Array.isArray((finalState as { messages?: unknown[] } | null)?.messages)
      ? ((finalState as { messages: unknown[] }).messages as unknown[]).filter(
          (message) => ToolMessage.isInstance(message),
        ).length
      : 0;
    if (limited) {
      // 撞上轮次上限：不是成功完成。回传中断前的部分产出 + 明确提示，
      // 主 Agent 据此决定缩小任务后重派或基于部分产出继续。
      const partial = rawSummary
        ? `\n\n## 中断前的部分产出（可能不完整）\n${clampSubagentText(rawSummary, 1_500)}`
        : '';
      return {
        status: 'failed',
        summary:
          `子 Agent 达到模型调用轮次上限（${SUBAGENT_MODEL_CALL_LIMIT} 轮）被提前终止，任务未完整交付。` +
          '请把任务拆得更小（减少章节/主题数量）后重新派发，或明确允许基于以下部分产出继续。' +
          partial,
        toolCalls,
      };
    }
    if (!rawSummary) {
      return {
        status: 'failed',
        summary:
          '子 Agent 已结束但没有产出任何摘要（可能提前终止），请基于已有信息继续或换一种任务拆分方式。',
        toolCalls,
      };
    }
    return {
      status: 'completed',
      summary: clampSubagentText(rawSummary, SUBAGENT_SUMMARY_MAX_CHARS),
      toolCalls,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (timedOut) {
      return {
        status: 'timeout',
        summary: `子 Agent 超过 ${Math.round(SUBAGENT_TIMEOUT_MS / 60_000)} 分钟墙钟上限被强制终止：${clampSubagentText(detail, 500)}。请把任务拆得更小后重试，或基于已有进度继续。`,
        toolCalls: 0,
      };
    }
    if (options.signal?.aborted) {
      // 主 run 已取消：返回明确的中止摘要，外层会以 run.cancelled 收尾。
      return {
        status: 'failed',
        summary: '子 Agent 因主任务被用户取消而中止。',
        toolCalls: 0,
      };
    }
    return {
      status: 'failed',
      summary: `子 Agent 执行失败：${clampSubagentText(detail, 800)}。请改写任务或换用其他工具后重试。`,
      toolCalls: 0,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onParentAbort);
  }
}

/**
 * 评审器结论（schema 与 contracts 的 subagent.reviewed 载荷对齐）。
 * 评审器不是一个完整 Agent：它没有工具、没有对话历史，只做一次结构化输出调用，
 * 成本与延迟都远低于一次子 Agent 运行（方案 3.3）。
 */
export const reviewVerdictSchema = z.object({
  passed: z.boolean().describe('产出是否满足任务中全部明确的验收标准'),
  score: z.number().int().min(0).max(100).describe('整体质量分，仅作参考'),
  feedback: z
    .string()
    .max(1_000)
    .describe('未达标时给出可执行的具体整改意见（指出缺什么、怎么补）；通过时留空串'),
  checklist: z
    .array(
      z.object({
        item: z.string().max(300).describe('一条可核对的验收项'),
        met: z.boolean().describe('该验收项是否已满足'),
      }),
    )
    .max(20)
    .describe('对照任务验收标准逐条核对的结果'),
});

export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

/**
 * 实际解析用的宽容 schema：jsonMode 下模型偶尔漏字段（无 schema 强制），
 * 缺省 feedback/checklist 时补默认值，其余校验（分数上限、文本长度）保持不变。
 */
const reviewVerdictLenientSchema = reviewVerdictSchema.extend({
  feedback: z.string().max(1_000).default(''),
  checklist: z
    .array(
      z.object({
        item: z.string().max(300),
        met: z.boolean(),
      }),
    )
    .max(20)
    .default([]),
});

const REVIEW_SYSTEM_PROMPT = [
  '你是严格的质量评审器，只评审、不重写产出。',
  '对照任务中的验收标准逐条核对子 Agent 的产出：要求的结构是否齐全、数据/结论是否彼此一致且有来源支撑、是否答非所问。',
  '你无法联网或调用工具，不要以「自己无法独立复核」为由判失败：产出给出了具体来源 URL、口径一致且互不矛盾的数据时，视为有依据；URL 是否可点开不属于你的判据。',
  '只有以下情况判不达标：明确要求的交付项缺失或数量不足、数据互相矛盾、URL 明显是占位/编造（如 example.com）、答非所问。',
  '注意核对日期合理性时以用户消息中给出的当前日期为准，不要用你记忆中的日期判断「未来/过去」。',
  '不达标时 feedback 必须具体可执行（缺哪项、补什么），子 Agent 会带着它整改重做。',
  '你必须只输出一个 JSON 对象，且字段齐全：passed（布尔）、score（0-100 整数）、feedback（字符串，通过时留空）、checklist（对象数组，逐条覆盖任务中的每一条验收标准、至少 1 项，每项含 item 字符串与 met 布尔）；不要输出 JSON 以外的任何内容。',
].join('\n');

function buildReviewUserPrompt(input: SpawnSubagentInput, summary: string): string {
  return [
    `## 当前日期\n${new Date().toISOString().slice(0, 10)}`,
    `## 子 Agent 角色\n${input.role_prompt}`,
    `## 任务与验收标准\n${input.task}`,
    `## 待评审产出\n${summary}`,
  ].join('\n\n');
}

/** 评审器故障时的兜底结论：不阻断主流程（fail-open），也不浪费重派额度。 */
export type ReviewOutcome =
  | { skipped: true }
  | { skipped: false; verdict: ReviewVerdict };

/**
 * 评审一次子 Agent 产出。
 * fail-open：模型不可用、全部结构化方式都失败、超时或主 run 取消时返回 skipped，
 * 调用方按「无评审」放行原摘要——评审器自身的故障不能拖垮整条派发链路。
 *
 * 结构化输出按 jsonMode → functionCalling 顺序尝试：DeepSeek 等 OpenAI 兼容服务
 * 不支持 response_format=json_schema，部分模型的 thinking 模式也不支持强制 tool_choice，
 * jsonMode（response_format=json_object + 提示词约束 JSON）兼容性最好，故优先。
 */
const REVIEW_STRUCTURED_METHODS = ['jsonMode', 'functionCalling'] as const;

export async function reviewSubagentOutput(
  model: unknown,
  input: SpawnSubagentInput,
  summary: string,
  signal?: AbortSignal,
): Promise<ReviewOutcome> {
  if (!model || signal?.aborted) return { skipped: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });
  let lastReason = 'unknown';
  try {
    for (const method of REVIEW_STRUCTURED_METHODS) {
      if (controller.signal.aborted) break;
      try {
        const structured = (model as BaseChatModel).withStructuredOutput(
          reviewVerdictLenientSchema,
          {
            name: 'review_result',
            method,
          },
        ) as { invoke: (messages: unknown[], config?: unknown) => Promise<unknown> };
        const raw = await structured.invoke(
          [
            new SystemMessage(REVIEW_SYSTEM_PROMPT),
            new HumanMessage(buildReviewUserPrompt(input, summary)),
          ],
          { signal: controller.signal, callbacks: [], tags: ['nostream'] },
        );
        const parsed = reviewVerdictLenientSchema.safeParse(raw);
        if (!parsed.success) {
          lastReason = `verdict parse failed (${method}): ${parsed.error.message.slice(0, 300)}`;
          continue;
        }
        // 再过一遍长度收敛，保证事件载荷一定满足 contracts 上限。
        const verdict: ReviewVerdict = {
          passed: parsed.data.passed,
          score: parsed.data.score,
          feedback: clampSubagentText(parsed.data.feedback, 1_000),
          checklist: parsed.data.checklist.slice(0, 20).map((item) => ({
            item: clampSubagentText(item.item, 300),
            met: item.met,
          })),
        };
        return { skipped: false, verdict };
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);
      }
    }
    // 静默 skip 曾导致评审器形同虚设且无任何线索；跳过（非主 run 取消）时留一条 warn。
    if (!signal?.aborted) {
      console.warn(
        `[subagent] reviewer skipped (fail-open): ${clampSubagentText(lastReason, 300)}`,
      );
    }
    return { skipped: true };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

/** 未达标且重派额度耗尽时，把评审差距附在摘要后如实交回主 Agent。 */
export function appendReviewGap(summary: string, verdict: ReviewVerdict): string {
  const missed = verdict.checklist.filter((item) => !item.met).map((item) => `- ${item.item}`);
  const note = [
    '## 评审未通过（已达重派上限，以下差距未闭合）',
    `质量分：${verdict.score}/100`,
    ...(missed.length > 0 ? [`未满足的验收项：\n${missed.join('\n')}`] : []),
    ...(verdict.feedback ? [`整改意见：\n${verdict.feedback}`] : []),
  ].join('\n\n');
  const room = SUBAGENT_SUMMARY_MAX_CHARS - note.length - 2;
  const head = room > 0 ? clampSubagentText(summary, room) : '';
  return clampSubagentText(`${head}${head ? '\n\n' : ''}${note}`, SUBAGENT_SUMMARY_MAX_CHARS);
}

/** spawn_subagent 工具工厂的可替换依赖（测试注入用，生产路径用默认实现）。 */
export interface SpawnLoopDeps {
  run: typeof runSubagent;
  review: typeof reviewSubagentOutput;
  emit: typeof emitSubagentEvent;
}

/** 从派发输入提取卡片展示用的角色名（首行非空文本）与任务简述。 */
export function describeSubagentInput(input: SpawnSubagentInput): {
  role: string;
  description: string;
} {
  return {
    role: clampSubagentText(
      input.role_prompt.split('\n').map((line) => line.trim()).find(Boolean) ?? '子任务',
      ROLE_MAX_CHARS,
    ),
    description: clampSubagentText(input.task, DESCRIPTION_MAX_CHARS),
  };
}

/**
 * 评审-重派闭环主体：每轮 派发→完成→评审，不达标带 feedback 重派至上限。
 * 失败/超时/评审器跳过时直接放行当轮摘要。
 * override：后台派发时由调用方预生成 subagentId（要在立即返回的 ack 里告知主 Agent），
 * 并在 started 事件上标记 background。
 */
export async function runSpawnLoop(
  options: SpawnSubagentOptions,
  input: SpawnSubagentInput,
  config: unknown,
  deps: SpawnLoopDeps = { run: runSubagent, review: reviewSubagentOutput, emit: emitSubagentEvent },
  override: { subagentId?: string; background?: boolean } = {},
): Promise<string> {
  const subagentId = override.subagentId ?? randomUUID();
  const { role, description } = describeSubagentInput(input);

  let attempt = 1;
  let priorFeedback: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const runInput: SpawnSubagentInput = priorFeedback
      ? { ...input, prior_feedback: priorFeedback }
      : input;
    const startedAt = Date.now();
    deps.emit(config, {
      runId: options.runId,
      timestamp: new Date().toISOString(),
      type: 'subagent.started',
      subagentId,
      role,
      description,
      attempt,
      ...(override.background ? { background: true } : {}),
    });
    const result = await deps.run(options, runInput);
    deps.emit(config, {
      runId: options.runId,
      timestamp: new Date().toISOString(),
      type: 'subagent.completed',
      subagentId,
      attempt,
      status: result.status,
      summary: result.summary,
      toolCalls: result.toolCalls,
      durationMs: Date.now() - startedAt,
    });

    // 失败/超时不评审：失败摘要本身已告诉主 Agent 如何处置（拆小任务/基于部分产出继续）。
    if (result.status !== 'completed') return result.summary;
    if (options.signal?.aborted) return result.summary;

    const review = await deps.review(options.router.primary, runInput, result.summary, options.signal);
    if (review.skipped) return result.summary;

    deps.emit(config, {
      runId: options.runId,
      timestamp: new Date().toISOString(),
      type: 'subagent.reviewed',
      subagentId,
      attempt,
      passed: review.verdict.passed,
      score: review.verdict.score,
      feedback: review.verdict.feedback,
      checklist: review.verdict.checklist,
    });

    if (review.verdict.passed) return result.summary;
    if (attempt >= SUBAGENT_MAX_ATTEMPTS) {
      // 如实汇报：最终产出 + 未闭合的差距，主 Agent 自行决定是否补救。
      return appendReviewGap(result.summary, review.verdict);
    }
    attempt += 1;
    priorFeedback = review.verdict.feedback || '请对照未满足的验收项补齐缺失内容。';
  }
}

/** 一个后台子任务 settle 后的结果。 */
export interface BackgroundTaskResult {
  subagentId: string;
  role: string;
  description: string;
  /** 最终摘要（含评审未过上限时的差距说明）；异常中止时为中止说明。 */
  summary: string;
}

/**
 * 单次 execute 内的后台任务登记表（P3）。
 * 生命周期严格限定在一个 run 内：人审挂起/失败/取消时 abortAll 收割，
 * 不做跨进程持久化（跨 run 的后台续跑是后续独立能力）。
 */
export interface BackgroundRunContext {
  register(task: {
    subagentId: string;
    role: string;
    description: string;
    /** emit：把 subagent.* 事件推进 execute 的后台事件队列；signal：主 run 信号 ∪ 中止信号。 */
    run: (emit: (event: AgentEvent) => void, signal: AbortSignal) => Promise<string>;
  }): void;
  /** 尚未结束的后台任务数。 */
  size(): number;
  /** 非阻塞取出已缓冲事件。 */
  drainEvents(): AgentEvent[];
  /** 等待全部后台任务结束并取回摘要（事件应先/再 drainEvents 取净）。 */
  settled(): Promise<BackgroundTaskResult[]>;
  /** 中止全部后台任务（人审挂起/run 失败/取消），给 3s 收尾宽限。 */
  abortAll(): Promise<void>;
}

/** 后台事件队列在无人读取时的缓冲上限：超过说明消费端异常，丢弃最旧事件防内存膨胀。 */
const BACKGROUND_EVENT_QUEUE_MAX = 500;
/** abortAll 的收尾宽限：不能让 interrupt/error 路径被卡住。 */
const BACKGROUND_ABORT_GRACE_MS = 3_000;

export function createBackgroundRunContext(runSignal?: AbortSignal): BackgroundRunContext {
  interface Entry {
    subagentId: string;
    role: string;
    description: string;
    controller: AbortController;
    done: boolean;
    promise: Promise<BackgroundTaskResult>;
  }
  const entries: Entry[] = [];
  const queue: AgentEvent[] = [];

  const emit = (event: AgentEvent) => {
    queue.push(event);
    if (queue.length > BACKGROUND_EVENT_QUEUE_MAX) queue.splice(0, queue.length - BACKGROUND_EVENT_QUEUE_MAX);
  };

  return {
    register(task) {
      const controller = new AbortController();
      const signal = runSignal
        ? AbortSignal.any([runSignal, controller.signal])
        : controller.signal;
      const entry: Entry = {
        subagentId: task.subagentId,
        role: task.role,
        description: task.description,
        controller,
        done: false,
        // 占位，下面赋值；异步回调内只引用 entry 本身。
        promise: Promise.resolve({
          subagentId: task.subagentId,
          role: task.role,
          description: task.description,
          summary: '',
        }),
      };
      entry.promise = Promise.resolve()
        .then(() => task.run(emit, signal))
        .then((summary) => ({
          subagentId: task.subagentId,
          role: task.role,
          description: task.description,
          summary,
        }))
        .catch((error: unknown) => ({
          subagentId: task.subagentId,
          role: task.role,
          description: task.description,
          summary: `后台子 Agent 异常中止：${clampSubagentText(
            error instanceof Error ? error.message : String(error),
            500,
          )}`,
        }))
        .finally(() => {
          entry.done = true;
        });
      entries.push(entry);
    },
    size() {
      return entries.filter((entry) => !entry.done).length;
    },
    drainEvents() {
      return queue.splice(0, queue.length);
    },
    async settled() {
      return Promise.all(entries.map((entry) => entry.promise));
    },
    async abortAll() {
      for (const entry of entries) {
        if (!entry.done) entry.controller.abort();
      }
      await Promise.race([
        Promise.allSettled(entries.map((entry) => entry.promise)),
        new Promise((resolve) => setTimeout(resolve, BACKGROUND_ABORT_GRACE_MS)),
      ]);
    },
  };
}

/**
 * spawn_subagent 工具：主 Agent 的子任务派发入口。
 * P2：成功产出先过评审器，不达标带 prior_feedback 重派（最多 SUBAGENT_MAX_ATTEMPTS 轮）。
 * P3：background=true 时任务不阻塞——工具立即返回 ack，子 Agent 脱离当前工具调用在
 * 同一个 run 内继续执行（事件走后台事件队列），execute 收尾时等待全部后台任务，
 * 再以检查点续一轮把摘要交回主 Agent 汇总；人审挂起/失败/取消则中止全部后台任务。
 */
export function createSpawnSubagentTool(
  options: SpawnSubagentOptions,
  deps: {
    runSpawnLoop?: typeof runSpawnLoop;
    run?: typeof runSubagent;
    review?: typeof reviewSubagentOutput;
  } = {},
) {
  const loop = deps.runSpawnLoop ?? runSpawnLoop;
  return tool(
    async (input: SpawnSubagentInput, config: unknown) => {
      if (input.background) {
        const bg = (
          config as { configurable?: { backgroundCtx?: BackgroundRunContext } }
        )?.configurable?.backgroundCtx;
        if (!bg) {
          return (
            '后台派发运行上下文不可用。请改用同步模式（background=false）重新调用；' +
            '若问题持续，直接以普通方式完成任务，不要重复尝试后台派发。'
          );
        }
        const subagentId = randomUUID();
        const { role, description } = describeSubagentInput(input);
        bg.register({
          subagentId,
          role,
          description,
          run: (emit, signal) =>
            loop(
              { ...options, signal },
              input,
              null,
              {
                run: deps.run ?? runSubagent,
                review: deps.review ?? reviewSubagentOutput,
                emit: (_config, event) => emit(event),
              },
              { subagentId, background: true },
            ),
        });
        return [
          `后台子任务已启动（taskId=${subagentId}，角色：${role}），不阻塞当前对话。`,
          '请立即给用户一句简短的阶段性说明（已在后台处理、完成后会自动汇总结果），不要空等也不要重复派发；',
          '任务结束后系统会自动把评审通过的摘要交回，届时你再基于结果做最终汇总。',
        ].join('\n');
      }
      return loop(options, input, config);
    },
    {
      name: 'spawn_subagent',
      description:
        '派发一个隔离子 Agent 执行单项任务，只返回最终摘要（≤2000 字），子 Agent 的中间执行过程不会进入对话。' +
        'role_prompt 写清角色职责边界、工作方法与输出要求；task 必须写清目标与可核对的验收标准（评审器据此自动验收）；关键背景/文件路径放 context。' +
        '同步模式（默认）：等待完成后继续，内部自动评审、不达标带整改意见重派（最多 3 轮），返回即通过评审；' +
        'background=true（异步模式）：工具立即返回 taskId，你先给用户阶段性回复，任务在后台并行执行，完成后系统自动续轮把摘要交回做最终汇总——适合耗时较长、希望先响应用户的任务。' +
        '适用：可独立交付的调研、检索、分析、验证类子任务；需要用户确认的事项不要派发。' +
        '不适用：简单事实查询（如商品参数查取）或 2-3 项直接对比——主 Agent 用 自带的搜索工具 搜 1-2 次更高效；spawn 的开销只在任务有多源、可并行、需隔离或篇幅明显较长时才值得。' +
        'task 里的验收标准应关注信息完整性、来源可靠性和结论准确性，不要写硬性字数上限、格式模板或措辞风格等机械指标。',
      schema: spawnSubagentSchema,
    },
  );
}
