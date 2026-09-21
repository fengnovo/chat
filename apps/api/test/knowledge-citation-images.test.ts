import assert from 'node:assert/strict';
import test from 'node:test';

import {
  answerWithCitations,
  buildCitationContext,
  inlineCitationImageUrls,
  knowledgeAssetContentUrl,
  type KnowledgeCitation,
} from '../src/knowledge-assistant.js';

const kbId = '00000000-0000-4000-8000-000000000004';
const productImage = {
  assetId: '00000000-0000-4000-8000-000000000006',
  name: '000.jpg',
  mime: 'image/jpeg',
  alt: '成品图',
  relPath: '菜谱/000.jpg',
};
const otherImage = {
  assetId: '00000000-0000-4000-8000-000000000007',
  name: '1.jpeg',
  mime: 'image/jpeg',
  alt: '',
  relPath: '菜谱/1.jpeg',
};

function citation(patch: Partial<KnowledgeCitation> = {}): KnowledgeCitation {
  return {
    chunkId: '00000000-0000-4000-8000-000000000008',
    documentId: '00000000-0000-4000-8000-000000000009',
    documentName: '简易红烧肉.md',
    ordinal: 3,
    score: 0.82,
    via: 'both',
    passage: '',
    ...patch,
  };
}

test('knowledgeAssetContentUrl 生成与 web 端一致的代理地址', () => {
  assert.equal(
    knowledgeAssetContentUrl(kbId, productImage.assetId),
    `/api/knowledge-bases/${kbId}/assets/${productImage.assetId}/content`,
  );
});

test('inlineCitationImageUrls 把切片里的相对路径换成可访问地址', () => {
  const passage = '成品如下图：\n\n![成品图](./000.jpg)\n\n口感软糯。';
  const rewritten = inlineCitationImageUrls(passage, [productImage], kbId);

  assert.equal(
    rewritten,
    `成品如下图：\n\n![成品图](${knowledgeAssetContentUrl(kbId, productImage.assetId)})\n\n口感软糯。`,
  );
  assert.equal(rewritten.includes('./000.jpg'), false);
});

test('inlineCitationImageUrls 兼容 <地址> 包裹、title 与重复目录写法', () => {
  const rewritten = inlineCitationImageUrls(
    '![成品图](<菜谱/000.jpg> "标题")',
    [productImage],
    kbId,
  );
  assert.equal(rewritten, `![成品图](${knowledgeAssetContentUrl(kbId, productImage.assetId)})`);
});

test('inlineCitationImageUrls 保持未知图片的原有写法，不改动正文', () => {
  const passage = '![别处的图](./unknown.png) 与纯文本 ./001.jpg';
  assert.equal(inlineCitationImageUrls(passage, [productImage], kbId), passage);
  assert.equal(inlineCitationImageUrls(passage, [], kbId), passage);
  assert.equal(inlineCitationImageUrls('', [productImage], kbId), '');
});

test('buildCitationContext 正文已内联的图片不再重复出现在配图清单里', () => {
  const context = buildCitationContext(
    [
      citation({
        heading: '做法',
        passage: '![成品图](./000.jpg)',
        images: [productImage, otherImage],
      }),
    ],
    kbId,
  );

  assert.match(context, /^\[1\] 来源：简易红烧肉\.md \/ 做法\n/);
  // 000.jpg 已内联进正文 → 不重复；1.jpeg 正文没提到 → 走配图清单。
  assert.equal(context.split(knowledgeAssetContentUrl(kbId, productImage.assetId)).length - 1, 1);
  assert.match(context, /配图：/);
  assert.match(context, new RegExp(`!\\[1\\.jpeg\\]\\(${knowledgeAssetContentUrl(kbId, otherImage.assetId).replace(/[/.]/g, '\\$&')}\\)`));
  assert.equal(context.includes('./000.jpg'), false);
});

test('buildCitationContext 为 caption 合成切片补上配图清单', () => {
  const context = buildCitationContext(
    [
      citation({
        documentName: '招牌菜.md',
        passage: '图片描述：一盘色泽红亮的红烧肉。',
        images: [productImage],
      }),
    ],
    kbId,
  );

  assert.match(context, /图片描述：一盘色泽红亮的红烧肉。/);
  assert.match(context, /配图：!\[成品图\]\(\/api\/knowledge-bases\//);
});

test('answerWithCitations 把图片代理地址与展示规则一起送进模型', async () => {
  const sent: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: '成品如图。' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const answer = await answerWithCitations(
      { baseUrl: 'http://model.local/v1', apiKey: 'test-key', model: 'test-model' },
      {
        question: '简易红烧肉长什么样？',
        kbId,
        citations: [citation({ passage: '![成品图](./000.jpg)', images: [productImage] })],
      },
    );
    assert.equal(answer, '成品如图。');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sent.length, 1);
  const [system, user] = sent[0]!.messages;
  assert.match(system!.content, /让用户能直接看到图片/);
  assert.match(system!.content, /不要声称自己无法发送或展示图片/);
  assert.ok(user!.content.includes(knowledgeAssetContentUrl(kbId, productImage.assetId)));
  assert.equal(user!.content.includes('./000.jpg'), false);
});

test('answerWithCitations 未提供 kbId 时回退为旧的纯文本上下文', async () => {
  const sent: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await answerWithCitations(
      { baseUrl: 'http://model.local/v1', apiKey: 'test-key', model: 'test-model' },
      { question: '问题', citations: [citation({ passage: '![成品图](./000.jpg)', images: [productImage] })] },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const user = sent[0]!.messages[1]!;
  assert.match(user.content, /\.\/000\.jpg/);
  assert.equal(user.content.includes('/api/knowledge-bases/'), false);
});
