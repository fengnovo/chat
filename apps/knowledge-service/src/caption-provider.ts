/**
 * VLM caption provider: 把图片 bytes 转成 data URL，调 OpenAI 兼容 Chat Completions，
 * 取回一段简短描述。供应商兼容百炼（dashscope compatible-mode）、OpenAI gpt-4o-mini、智谱 glm-4v 等。
 *
 * 设计要点：
 * 1. 不绑定任何 SDK，纯 fetch + AbortController，与 createLlmGraphExtractor 同源。
 * 2. 失败时抛 Error；worker 用指数退避重试或归类为 skipped，不让单张图拖垮整库。
 * 3. 输出经 trim + 截断，避免模型塞 markdown / JSON / 长 prefix 让向量检索拿到噪声。
 */
export interface CaptionProviderOptions {
  /** OpenAI 兼容 baseUrl，例如 https://dashscope.aliyuncs.com/compatible-mode/v1 */
  baseUrl: string;
  apiKey: string;
  /** 推荐 qwen-vl-plus / qwen3-vl-plus / qwen3.8-omni-flash / gpt-4o-mini / glm-4v-plus 等视觉模型。 */
  model: string;
  /** 单张图最长处理时间，默认 60s。 */
  timeoutMs?: number;
  /** 字幕最多字符数；超出则裁剪到该长度。 */
  maxChars?: number;
  /**
   * 关闭思考模式：置 true 时向请求体注入 `enable_thinking: false`。
   * 混合思考模型（qwen3-omni / qwen3-vl 等）默认开启思考，思考 token 计入 max_tokens
   * 预算，容易把 caption 正文挤空（表现为 content 为空 → 被判 empty_response）。
   * 这类模型建议置 true；qwen-vl-plus 等非思考模型无需设置，保持默认 false，
   * 以免向不认识该字段的模型发送未知参数。
   */
  disableThinking?: boolean;
  fetch?: typeof globalThis.fetch;
}

export const DEFAULT_CAPTION_SYSTEM_PROMPT = [
  'You caption a single image used as supporting material in a knowledge base.',
  'Write ONE concise paragraph (≤ 80 Chinese characters or ≤ 30 English words).',
  'Focus on: subject, visual attributes (color, shape, texture), and the action / state the image conveys.',
  'Avoid: greetings, preamble, JSON, bullet lists, "the image shows…", markdown fences, and any non-visual speculation.',
].join(' ');

function toDataUrl(bytes: Uint8Array, mime: string): string {
  // Chunked base64 防止极大 Buffer 在某些 runtime 下栈溢出。
  const base64 = Buffer.from(bytes).toString('base64');
  return `data:${mime};base64,${base64}`;
}

function trimCaption(raw: string, maxChars: number): string {
  const cleaned = raw
    .replace(/^```(?:json|text)?\s*|```\s*$/g, '')
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).trim();
}

export type ImageCaptioner = (input: { bytes: Uint8Array; mime: string; hint?: string }) => Promise<string | null>;

export function createOpenAICompatibleCaptioner(options: CaptionProviderOptions): ImageCaptioner {
  if (!options.baseUrl?.trim()) throw new Error('Caption baseUrl is required');
  if (!options.apiKey?.trim()) throw new Error('Caption apiKey is required');
  if (!options.model?.trim()) throw new Error('Caption model is required');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxChars = options.maxChars ?? 240;
  const disableThinking = options.disableThinking === true;
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return async function caption(input: { bytes: Uint8Array; mime: string; hint?: string }): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const userText = input.hint ? `Context: ${input.hint}` : 'Describe the image.';
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          temperature: 0.2,
          max_tokens: 256,
          // 混合思考模型（qwen3-omni 等）思考 token 计入 max_tokens，会把 caption 正文挤空，
          // 按需注入 enable_thinking:false。
          ...(disableThinking ? { enable_thinking: false } : {}),
          messages: [
            { role: 'system', content: DEFAULT_CAPTION_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: userText },
                { type: 'image_url', image_url: { url: toDataUrl(input.bytes, input.mime) } },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`caption LLM HTTP ${response.status}: ${detail.slice(0, 300)}`);
      }
      const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) return null;
      const text = typeof content === 'string' ? content : content.map((part) => part.text ?? '').join('');
      const cleaned = trimCaption(text, maxChars);
      return cleaned || null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 默认 captioner：用于 main.ts 在缺省配置时直接返回 null（标记为 skipped，不重试）。 */
export function createNullCaptioner(): ImageCaptioner {
  return async (): Promise<string | null> => null;
}