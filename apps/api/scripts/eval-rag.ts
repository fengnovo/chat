import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { loadConfig } from '../src/config.js';
import { createRagQaService, type RagQaInput } from '../src/rag-qa.js';

const datasetSchema = z.object({
  datasetId: z.string(),
  version: z.string(),
  kbId: z.string().uuid(),
  indexConfig: z.record(z.string(), z.unknown()),
  cases: z.array(
    z.object({
      id: z.string(),
      query: z.string(),
      type: z.enum(['exact-term', 'semantic', 'multi-hop', 'long-tail', 'unanswerable', 'boundary']),
      answerable: z.boolean(),
      relevantChunkIds: z.array(z.string()),
      evidence: z.array(
        z.object({
          documentId: z.string(),
          text: z.string(),
          graded: z.number().int().min(0).max(2).optional(),
        }),
      ),
      expectedDocuments: z.array(z.string()).optional(),
      difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
      notes: z.string().optional(),
    }),
  ),
});

type Dataset = z.infer<typeof datasetSchema>;
type EvalCase = Dataset['cases'][number];

interface RetrievalMetrics {
  precisionAtK: number;
  recallAtK: number;
  f1AtK: number;
  mrr: number;
  map: number;
  graphRecall: number;
  neighborHitRate: number;
}

interface JudgeScore {
  faithfulness: number;
  answerRelevance: number;
  contextRelevance: number;
  reasoning: string;
}

interface EvalResult extends EvalCase {
  answer: string;
  retrievedChunkIds: string[];
  metrics: RetrievalMetrics;
  judge?: JudgeScore | undefined;
  durationMs: number;
}

function computeMetrics(caseItem: EvalCase, retrievedIds: string[]): RetrievalMetrics {
  const relevant = caseItem.relevantChunkIds;
  const relevantSet = new Set(relevant);

  let hits = 0;
  let precisionSum = 0;
  retrievedIds.forEach((id, i) => {
    if (relevantSet.has(id)) {
      hits++;
      precisionSum += hits / (i + 1);
    }
  });

  const precisionAtK = retrievedIds.length ? hits / retrievedIds.length : 0;
  const recallAtK = relevant.length ? hits / relevant.length : 0;
  const f1AtK = precisionAtK + recallAtK === 0 ? 0 : (2 * precisionAtK * recallAtK) / (precisionAtK + recallAtK);
  const firstHitRank = retrievedIds.findIndex((id) => relevantSet.has(id));
  const mrr = firstHitRank === -1 ? 0 : 1 / (firstHitRank + 1);
  const map = relevant.length === 0 ? 0 : precisionSum / relevant.length;

  // 项目专属：图独有/非向量命中带来的新增召回
  // 注意：这里通过 chunkId 是否来自向量无法直接判断，需要在 future 里通过 citations.via 计算
  // 当前占位：通过 evidence 是否出现在答案文本来近似（ LLM-as-judge 更准确）
  const graphRecall = 0;

  // neighbor-hit：用 ordinal 判断分块边界；当前 retrievedIds 不直接含 ordinal，后续可扩展
  const neighborHitRate = 0;

  return {
    precisionAtK,
    recallAtK,
    f1AtK,
    mrr,
    map,
    graphRecall,
    neighborHitRate,
  };
}

async function judgeTriad(
  model: { baseUrl: string; apiKey: string; model: string },
  question: string,
  contexts: string[],
  answer: string,
): Promise<JudgeScore> {
  const prompt = `你是 RAG 系统评估专家。请从以下三个维度对「回答」打分(1-5 分，5 分最好)，并给出简要理由。

1. contextRelevance：提供的参考资料与问题相关吗？
2. faithfulness：回答是否完全基于参考资料，有无编造？
3. answerRelevance：回答是否直接、准确解决了用户问题？

请只输出 JSON，格式：
{"faithfulness": 4, "answerRelevance": 4, "contextRelevance": 4, "reasoning": "..."}`;

  const response = await fetch(`${model.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${model.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: model.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: `问题：${question}\n\n参考资料：\n${contexts.join('\n---\n')}\n\n回答：${answer}\n\n请评估：`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`judge failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content?.trim() ?? '{}';
  const parsed = JSON.parse(content) as Partial<JudgeScore>;
  return {
    faithfulness: Number(parsed.faithfulness ?? 0),
    answerRelevance: Number(parsed.answerRelevance ?? 0),
    contextRelevance: Number(parsed.contextRelevance ?? 0),
    reasoning: String(parsed.reasoning ?? ''),
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function usage() {
  console.log('Usage: pnpm eval:rag --dataset <path> [--output ./out] [--judge] [--kb-id <uuid>] [--tenant-id <uuid>] [--user-id <uuid>]');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }
  const datasetPath = args.find((_, i) => args[i - 1] === '--dataset');
  const outputDir = args.find((_, i) => args[i - 1] === '--output') ?? './eval-output';
  const enableJudge = args.includes('--judge');
  const tenantId = args.find((_, i) => args[i - 1] === '--tenant-id') ?? process.env.DEV_TENANT_ID;
  const userId = args.find((_, i) => args[i - 1] === '--user-id') ?? process.env.DEV_USER_ID;
  const kbId = args.find((_, i) => args[i - 1] === '--kb-id');

  if (!datasetPath) {
    console.error('Missing --dataset');
    usage();
    process.exit(1);
  }

  const config = loadConfig();
  const service = createRagQaService({ config });
  if (!service.isAvailable()) {
    console.error('RAG QA service is not configured. Set KNOWLEDGE_MCP_URL, KNOWLEDGE_MCP_SECRET, OPENAI_BASE_URL, OPENAI_API_KEY.');
    process.exit(1);
  }

  const rawDataset = JSON.parse(await (await import('node:fs/promises')).readFile(datasetPath, 'utf-8'));
  const dataset = datasetSchema.parse(rawDataset);

  const effectiveKbId = kbId ?? dataset.kbId;
  const effectiveTenantId = tenantId ?? config.DEV_TENANT_ID;
  const effectiveUserId = userId ?? config.DEV_USER_ID;

  console.log(`开始评测: ${dataset.datasetId} v${dataset.version}`);
  console.log(`KB: ${effectiveKbId}, 用例数: ${dataset.cases.length}, judge: ${enableJudge}`);

  const results: EvalResult[] = [];
  for (const caseItem of dataset.cases) {
    const start = Date.now();
    const input: RagQaInput = {
      question: caseItem.query,
      kbId: effectiveKbId,
      tenantId: effectiveTenantId,
      userId: effectiveUserId,
      topK: 20,
      minScore: -1,
    };

    const { answer, citations } = await service.answer(input);
    const durationMs = Date.now() - start;
    const retrievedChunkIds = citations.map((c) => c.chunkId);

    const judge = enableJudge
      ? await judgeTriad(
          config.KNOWLEDGE_QA_MODEL!,
          caseItem.query,
          citations.map((c) => c.passage),
          answer,
        )
      : undefined;

    results.push({
      ...caseItem,
      answer,
      retrievedChunkIds,
      metrics: computeMetrics(caseItem, retrievedChunkIds),
      judge,
      durationMs,
    });

    console.log(`  [${caseItem.id}] recall@k=${results.at(-1)!.metrics.recallAtK.toFixed(2)} answer=${answer.slice(0, 40).replaceAll('\n', ' ')}...`);
  }

  // 汇总
  const allRecalls = results.map((r) => r.metrics.recallAtK);
  const allPrecisions = results.map((r) => r.metrics.precisionAtK);
  const allF1 = results.map((r) => r.metrics.f1AtK);
  const allMrr = results.map((r) => r.metrics.mrr);
  const allMap = results.map((r) => r.metrics.map);
  const allDuration = results.map((r) => r.durationMs);

  const byType = new Map<string, EvalResult[]>();
  for (const r of results) {
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }

  const summary = {
    datasetId: dataset.datasetId,
    version: dataset.version,
    kbId: effectiveKbId,
    totalCases: results.length,
    overall: {
      recallAtK: average(allRecalls),
      precisionAtK: average(allPrecisions),
      f1AtK: average(allF1),
      mrr: average(allMrr),
      map: average(allMap),
      durationP50: percentile(allDuration, 0.5),
      durationP95: percentile(allDuration, 0.95),
    },
    byType: Object.fromEntries(
      [...byType.entries()].map(([type, list]) => [
        type,
        {
          count: list.length,
          recallAtK: average(list.map((r) => r.metrics.recallAtK)),
          precisionAtK: average(list.map((r) => r.metrics.precisionAtK)),
          f1AtK: average(list.map((r) => r.metrics.f1AtK)),
          mrr: average(list.map((r) => r.metrics.mrr)),
          map: average(list.map((r) => r.metrics.map)),
          faithfulness: enableJudge ? average(list.map((r) => r.judge!.faithfulness)) : undefined,
          answerRelevance: enableJudge ? average(list.map((r) => r.judge!.answerRelevance)) : undefined,
          contextRelevance: enableJudge ? average(list.map((r) => r.judge!.contextRelevance)) : undefined,
        },
      ]),
    ),
    failures: results
      .filter((r) => r.metrics.recallAtK === 0 && r.answerable)
      .map((r) => ({ id: r.id, query: r.query, type: r.type })),
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'eval-results.json'), JSON.stringify({ summary, results }, null, 2));
  await writeFile(path.join(outputDir, 'eval-report.md'), buildMarkdownReport(summary, results, enableJudge));

  console.log('\n评测完成');
  console.log(`总体 Recall@k: ${(summary.overall.recallAtK as number).toFixed(3)}`);
  console.log(`总体 MRR:      ${(summary.overall.mrr as number).toFixed(3)}`);
  console.log(`P95 耗时:      ${(summary.overall.durationP95 as number).toFixed(0)}ms`);
  console.log(`失败用例:      ${summary.failures.length}`);
  console.log(`报告已保存:    ${outputDir}`);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[index] ?? 0;
}

function buildMarkdownReport(
  summary: Record<string, unknown>,
  results: EvalResult[],
  enableJudge: boolean,
): string {
  type Overall = {
    recallAtK: number;
    precisionAtK: number;
    f1AtK: number;
    mrr: number;
    map: number;
    durationP50: number;
    durationP95: number;
  };
  const overall = summary.overall as Overall;
  const byType = summary.byType as Record<string, Record<string, number | undefined>>;

  let md = `# RAG 评测报告\n\n`;
  md += `**数据集**: ${summary.datasetId} v${summary.version}\n\n`;
  md += `**KB**: ${summary.kbId}\n\n`;
  md += `## 总体指标\n\n`;
  md += `| 指标 | 值 |\n|---|---|\n`;
  md += `| Recall@k | ${overall.recallAtK.toFixed(3)} |\n`;
  md += `| Precision@k | ${overall.precisionAtK.toFixed(3)} |\n`;
  md += `| F1@k | ${overall.f1AtK.toFixed(3)} |\n`;
  md += `| MRR | ${overall.mrr.toFixed(3)} |\n`;
  md += `| MAP | ${overall.map.toFixed(3)} |\n`;
  md += `| P50 耗时 | ${overall.durationP50.toFixed(0)}ms |\n`;
  md += `| P95 耗时 | ${overall.durationP95.toFixed(0)}ms |\n`;
  if (enableJudge) {
    md += `\n## LLM-as-Judge 总体\n\n`;
    md += `| 维度 | 均分(1-5) |\n|---|---|\n`;
    md += `| Faithfulness | ${average(results.map((r) => r.judge!.faithfulness)).toFixed(2)} |\n`;
    md += `| Answer Relevance | ${average(results.map((r) => r.judge!.answerRelevance)).toFixed(2)} |\n`;
    md += `| Context Relevance | ${average(results.map((r) => r.judge!.contextRelevance)).toFixed(2)} |\n`;
  }

  md += `\n## 按类型分组\n\n`;
  md += `| 类型 | 数量 | Recall | Precision | F1 | MRR | MAP${enableJudge ? ' | Faithfulness | AnswerRel | ContextRel' : ''} |\n`;
  md += `|---|---|---|---|---|---|---${enableJudge ? '|---|---|---|' : ''}|\n`;
  for (const [type, metrics] of Object.entries(byType)) {
    md += `| ${type} | ${metrics.count} | ${(metrics.recallAtK ?? 0).toFixed(2)} | ${(metrics.precisionAtK ?? 0).toFixed(2)} | ${(metrics.f1AtK ?? 0).toFixed(2)} | ${(metrics.mrr ?? 0).toFixed(2)} | ${(metrics.map ?? 0).toFixed(2)}`;
    if (enableJudge) {
      md += ` | ${(metrics.faithfulness ?? 0).toFixed(2)} | ${(metrics.answerRelevance ?? 0).toFixed(2)} | ${(metrics.contextRelevance ?? 0).toFixed(2)}`;
    }
    md += ` |\n`;
  }

  md += `\n## 失败用例 (Recall@k = 0)\n\n`;
  const failures = results.filter((r) => r.metrics.recallAtK === 0 && r.answerable);
  if (failures.length === 0) {
    md += '无\n';
  } else {
    md += `| ID | 类型 | 问题 |\n|---|---|---|\n`;
    for (const f of failures) {
      md += `| ${f.id} | ${f.type} | ${f.query} |\n`;
    }
  }

  md += `\n## 全部结果\n\n`;
  md += `| ID | 类型 | Recall | Precision | F1 | MRR${enableJudge ? ' | Faith | AnsRel | CtxRel' : ''} | 回答摘要 |\n`;
  md += `|---|---|---|---|---|---${enableJudge ? '|---|---|---' : ''}|---|\n`;
  for (const r of results) {
    const shortAnswer = r.answer.slice(0, 60).replaceAll('\n', ' ');
    md += `| ${r.id} | ${r.type} | ${r.metrics.recallAtK.toFixed(2)} | ${r.metrics.precisionAtK.toFixed(2)} | ${r.metrics.f1AtK.toFixed(2)} | ${r.metrics.mrr.toFixed(2)}`;
    if (enableJudge) {
      md += ` | ${r.judge!.faithfulness} | ${r.judge!.answerRelevance} | ${r.judge!.contextRelevance}`;
    }
    md += ` | ${shortAnswer}... |\n`;
  }

  return md;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
