// 用法：node --env-file=.env scripts/llm-test.mjs
const baseUrl = process.env.OPENAI_BASE_URL;
const apiKey = process.env.OPENAI_API_KEY;
if (!baseUrl || !apiKey) {
  console.error('需要 OPENAI_BASE_URL 和 OPENAI_API_KEY 环境变量');
  process.exit(1);
}

const sizes = [
  { label: '短对话 (~500 tokens)', chars: 2_000 },
  { label: '中等对话 (~5k tokens)', chars: 20_000 },
  { label: '长对话 (~30k tokens)', chars: 120_000 },
  { label: '超长对话 (~69k tokens)', chars: 276_000 },
];

for (const { label, chars } of sizes) {
  const body = JSON.stringify({
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'x'.repeat(chars) },
    ],
    max_tokens: 50,
    stream: false,
  });

  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    const ttft = Date.now() - start;
    const data = await res.json();
    const usage = data.usage ?? {};
    console.log(`${label}: TTFT=${ttft}ms, total=${Date.now() - start}ms, input_tokens=${usage.prompt_tokens ?? '?'}, output_tokens=${usage.completion_tokens ?? '?'}`);
  } catch (err) {
    console.log(`${label}: FAILED - ${err.message}`);
  }
}
