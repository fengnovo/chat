import { createHash } from 'node:crypto';
import { isBaseMessage, mapStoredMessageToChatMessage, RemoveMessage, ToolMessage, type StoredMessage } from '@langchain/core/messages';
import { Command, Overwrite, Send, interrupt, isCommand, isGraphInterrupt } from '@langchain/langgraph';
import { createMiddleware, type HITLRequest, type HITLResponse } from 'langchain';

export interface ToolReplayPolicy {
  replaySafe?: boolean;
  idempotencyKeyArgument?: string;
}

export interface ToolExecutionRecord {
  executionId: string;
  idempotencyKey: string;
  scopeId: string;
  toolCallId: string;
  toolName: string;
  inputHash: string;
  status: 'started' | 'succeeded' | 'uncertain';
  result: unknown | null;
  replayPolicy: 'safe' | 'unsafe';
  /** 进入外部处理器前已提交的重试次数。 */
  retryCount: number;
}

export interface ToolExecutionStore {
  begin(intent: {
    scopeId: string; toolCallId: string; toolName: string;
    inputHash: string; input: unknown; replayPolicy: 'safe' | 'unsafe';
  }): Promise<{ record: ToolExecutionRecord; fresh: boolean }>;
  complete(executionId: string, result: unknown): Promise<void>;
  retry(executionId: string): Promise<void>;
  uncertain(executionId: string): Promise<void>;
}

export interface ToolExecutionMiddlewareOptions {
  store: ToolExecutionStore;
  scopeId: string;
  policies?: Record<string, ToolReplayPolicy>;
  assertOwnership?: () => Promise<void>;
  /** 普通工具授权绝不代表可以安全重试结果未知的调用。 */
  autoApproveTools?: boolean;
}

/** 基础设施故障或结果未知的执行必须绕过工具错误处理器并向外抛出。 */
export class DurableExecutionError extends Error {
  readonly durableExecution = true;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DurableExecutionError';
  }
}

export function isDurableExecutionError(error: unknown): error is DurableExecutionError {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof DurableExecutionError || ('durableExecution' in error && error.durableExecution === true)) return true;
  // LangGraph 可能会为跨越图边界的错误附加 NodeError 包装对象。
  return 'cause' in error && error.cause !== error && isDurableExecutionError(error.cause);
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object') throw new DurableExecutionError('Tool input must contain only JSON values');
  if (ancestors.has(value)) throw new DurableExecutionError('Cyclic tool input is not supported');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new DurableExecutionError('Tool input must contain plain JSON objects');
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], ancestors)}`).join(',')}}`;
  } finally { ancestors.delete(value); }
}

export function stableToolInputHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

type Encoded = null | string | boolean | number | { type: string; value?: unknown };

/** 为每个对象加标签，避免用户产物与编解码标记冲突。 */
function encode(value: unknown, ancestors = new Set<object>()): Encoded {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : { type: 'number', value: String(value) === '0' ? '-0' : String(value) };
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'bigint') return { type: 'bigint', value: String(value) };
  if (typeof value !== 'object') throw new DurableExecutionError('Unsupported tool result value');
  if (ancestors.has(value)) throw new DurableExecutionError('Cyclic tool result is not supported');
  ancestors.add(value);
  const recur = (item: unknown) => encode(item, ancestors);
  try {
    if (isCommand(value)) return { type: 'command', value: recur({ update: value.update, resume: value.resume, goto: value.goto, graph: value.graph }) };
    if (isBaseMessage(value)) return { type: 'message', value: recur(value.toDict()) };
    if (Overwrite.isInstance(value)) return { type: 'overwrite', value: recur(value.value) };
    if (value instanceof Send) return { type: 'send', value: recur({ node: value.node, args: value.args, timeout: value.timeout }) };
    if (value instanceof Date) return { type: 'date', value: value.toISOString() };
    if (value instanceof Uint8Array) return { type: 'bytes', value: Buffer.from(value).toString('base64') };
    if (value instanceof Map) return { type: 'map', value: [...value].map(([key, item]) => [recur(key), recur(item)]) };
    if (value instanceof Set) return { type: 'set', value: [...value].map(recur) };
    if (Array.isArray(value)) return { type: 'array', value: value.map(recur) };
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new DurableExecutionError('Unsupported tool result class');
    return { type: 'object', value: Object.entries(value).map(([key, item]) => [key, recur(item)]) };
  } finally { ancestors.delete(value); }
}

function decode(value: Encoded): unknown {
  if (value === null || typeof value !== 'object') return value;
  switch (value.type) {
    case 'undefined': return undefined;
    case 'number': return Number(value.value);
    case 'bigint': return BigInt(value.value as string);
    case 'date': return new Date(value.value as string);
    case 'bytes': return new Uint8Array(Buffer.from(value.value as string, 'base64'));
    case 'array': return (value.value as Encoded[]).map(decode);
    case 'object': return Object.fromEntries((value.value as [string, Encoded][]).map(([key, item]) => [key, decode(item)]));
    case 'map': return new Map((value.value as [Encoded, Encoded][]).map(([key, item]) => [decode(key), decode(item)]));
    case 'set': return new Set((value.value as Encoded[]).map(decode));
    case 'message': {
      const message = decode(value.value as Encoded) as StoredMessage;
      return message.type === 'remove' ? new RemoveMessage(message.data as { id: string }) : mapStoredMessageToChatMessage(message);
    }
    case 'overwrite': return new Overwrite(decode(value.value as Encoded));
    case 'command': return new Command(decode(value.value as Encoded) as ConstructorParameters<typeof Command>[0]);
    case 'send': {
      const fields = decode(value.value as Encoded) as { node: string; args: unknown; timeout: Send['timeout'] };
      return new Send(fields.node, fields.args, fields.timeout === undefined ? undefined : { timeout: fields.timeout });
    }
    default: throw new DurableExecutionError('Unrecognized durable tool result encoding');
  }
}

export function serializeToolResult(result: ToolMessage | Command): unknown {
  return { version: 1, value: encode(result) };
}

export function deserializeToolResult(result: unknown): ToolMessage | Command {
  try {
    if (!result || typeof result !== 'object' || !('version' in result) || result.version !== 1 || !('value' in result)) throw new Error('Unsupported result version');
    const decoded = decode(result.value as Encoded);
    if (!(decoded instanceof ToolMessage) && !isCommand(decoded)) throw new Error('Expected ToolMessage or Command');
    return decoded;
  } catch (cause) { throw new DurableExecutionError('Cannot restore durable tool result', { cause }); }
}

const SAFE_BUILTINS = new Set(['ls', 'read_file', 'glob', 'grep', 'write_todos', 'spawn_subagent']);

/** 可信的平台默认策略，由持久化运行时描述符共同使用。 */
export function trustedBuiltinReplayPolicies(): Record<string, 'safe'> {
  return Object.fromEntries([...SAFE_BUILTINS].sort().map((name) => [name, 'safe' as const]));
}

export function createToolExecutionMiddleware(options: ToolExecutionMiddlewareOptions) {
  const storage = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (cause) {
      if (isGraphInterrupt(cause) || isDurableExecutionError(cause)) throw cause;
      throw new DurableExecutionError('Durable tool storage or ownership check failed', { cause });
    }
  };
  const ownership = async () => { if (options.assertOwnership) await storage(options.assertOwnership); };
  return createMiddleware({
    name: 'DurableToolExecution',
    wrapToolCall: async (request, handler) => {
      // Interrupt 工具有独立的可恢复协议，节点重放时也必须执行。
      if (request.toolCall.name === 'ask_user') return handler(request);
      const { id: toolCallId, name: toolName, args: input } = request.toolCall;
      if (!toolCallId || !toolCallId.trim()) throw new DurableExecutionError('Durable tools require a stable tool_call_id');
      if (!options.scopeId) throw new DurableExecutionError('Durable tools require an execution scope');
      const policy = options.policies?.[toolName];
      // 第三方 MCP 提示描述的是意图，并不能可信地保证重复执行结果未知的调用是安全的。
      // 只有平台策略可以确定安全性。
      const replayPolicy = (policy?.replaySafe ?? SAFE_BUILTINS.has(toolName)) ? 'safe' : 'unsafe';
      const inputHash = stableToolInputHash(input);
      await ownership();
      const { record, fresh } = await storage(() => options.store.begin({ scopeId: options.scopeId, toolCallId, toolName, inputHash, input, replayPolicy }));
      if (record.scopeId !== options.scopeId || record.toolCallId !== toolCallId || record.toolName !== toolName || record.inputHash !== inputHash) throw new DurableExecutionError('Durable tool identity conflicts with the stored input');
      if (!record.executionId || !record.idempotencyKey) throw new DurableExecutionError('Durable tool record is missing its stable execution identity');
      if (!Number.isSafeInteger(record.retryCount) || record.retryCount < 0) throw new DurableExecutionError('Durable tool record has an invalid retry count');
      if (record.status === 'succeeded') return deserializeToolResult(record.result);
      if (record.status !== 'started' && record.status !== 'uncertain') throw new DurableExecutionError('Invalid durable tool execution status');
      // 策略变更不能追溯性地认定先前的不确定副作用安全；
      // 已存储的安全标记也不能覆盖当前不再信任它的策略。
      if (!fresh && !(record.replayPolicy === 'safe' && replayPolicy === 'safe')) {
        const approval: HITLRequest & { durableApprovalId: string } = {
          durableApprovalId: `tool-${record.executionId}-${record.retryCount}`,
          actionRequests: [{ name: toolName, args: input, description: 'Previous external execution outcome is unknown. It may already have succeeded. Approve to repeat this action, or reject to leave it unrepeated.' }],
          reviewConfigs: [{ actionName: toolName, allowedDecisions: ['approve', 'reject'] }],
        };
        let response = interrupt<HITLRequest, HITLResponse & { durableApprovalId?: string }>(approval);
        // interrupt() 会按位置恢复响应。失败任务也可能保留旧的未限定续跑写入。
        // 跳过所有过期响应，直到响应明确对应本次重试；随后要求新的明确决定。
        // 安全重试没有审批历史，因此应使用响应身份进行匹配。
        // 首次审批仍可接受不带标记的旧版 HITL 载荷。
        while ((record.retryCount > 0 || response?.durableApprovalId !== undefined) && response?.durableApprovalId !== approval.durableApprovalId) {
          response = interrupt<HITLRequest, HITLResponse & { durableApprovalId?: string }>(approval);
        }
        const decision = response?.decisions?.[0]?.type;
        if (decision === 'reject') {
          await ownership();
          const rejected = new ToolMessage({ tool_call_id: toolCallId, name: toolName, content: 'Previous external execution outcome remains unknown. The action was not repeated because replay was rejected.' });
          await storage(() => options.store.complete(record.executionId, serializeToolResult(rejected)));
          return rejected;
        }
        if (decision !== 'approve') throw new DurableExecutionError('Unsafe tool replay requires explicit approval or rejection');
      }
      await ownership();
      if (!fresh) await storage(() => options.store.retry(record.executionId));
      const keyArgument = policy?.idempotencyKeyArgument;
      if (keyArgument !== undefined && !keyArgument.trim()) throw new DurableExecutionError('Idempotency argument must be a nonempty field name');
      const handlerRequest = keyArgument ? { ...request, toolCall: { ...request.toolCall, args: { ...input, [keyArgument]: record.idempotencyKey } } } : request;
      if (keyArgument && request.tool && 'schema' in request.tool) {
        const schema = request.tool.schema;
        if (schema && typeof schema === 'object' && 'safeParseAsync' in schema && typeof schema.safeParseAsync === 'function') {
          const parse = schema.safeParseAsync.bind(schema) as (value: unknown) => Promise<{ success: boolean; data?: unknown }>;
          const parsed = await storage(() => parse(handlerRequest.toolCall.args));
          if (!parsed.success || !parsed.data || typeof parsed.data !== 'object' || (parsed.data as Record<string, unknown>)[keyArgument] !== record.idempotencyKey) throw new DurableExecutionError('Tool schema does not preserve the configured idempotency argument');
        } else if (schema && typeof schema === 'object' && 'properties' in schema) {
          const fields = schema as { properties?: Record<string, unknown>; additionalProperties?: unknown };
          if (!Object.hasOwn(fields.properties ?? {}, keyArgument) && fields.additionalProperties !== true) throw new DurableExecutionError('Tool schema does not declare the configured idempotency argument');
        } else {
          throw new DurableExecutionError('Cannot validate the configured tool idempotency argument');
        }
      }
      await ownership();
      let result: ToolMessage | Command;
      try { result = await handler(handlerRequest); }
      catch (cause) {
        if (isGraphInterrupt(cause)) throw cause;
        // MCP 适配器会为传输故障和明确的 isError 响应都抛出 ToolException。
        // 只有后者代表已知工具结果：应持久化该结果，让模型可以回复，
        // 并避免检查点重放时再次调用工具。
        if (!request.runtime.signal?.aborted && !isDurableExecutionError(cause) &&
          cause instanceof Error && cause.name === 'ToolException' &&
          /^MCP tool '[^']+' on server '[^']+' returned an error: /.test(cause.message)) {
          result = new ToolMessage({ tool_call_id: toolCallId, name: toolName, content: cause.message, status: 'error' });
        } else {
          await storage(() => options.store.uncertain(record.executionId));
          if (isDurableExecutionError(cause)) throw cause;
          throw new DurableExecutionError(`Tool ${toolName} execution outcome is uncertain`, { cause });
        }
      }
      // 如果成功状态持久化失败，记录会停留在 started/uncertain；重放时必须协调处理。
      await ownership();
      await storage(() => options.store.complete(record.executionId, serializeToolResult(result)));
      return result;
    },
  });
}
