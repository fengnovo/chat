import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import * as knowledgeManager from '../app/knowledge/knowledge-manager';

test('accepts only Markdown and text document filenames', () => {
  const accepts = (knowledgeManager as typeof knowledgeManager & {
    isAcceptedKnowledgeFile?: (name: string) => boolean;
  }).isAcceptedKnowledgeFile;
  assert.equal(typeof accepts, 'function');

  assert.equal(accepts?.('guide.md'), true);
  assert.equal(accepts?.('guide.MARKDOWN'), true);
  assert.equal(accepts?.('notes.txt'), true);
  assert.equal(accepts?.('archive.md.zip'), false);
  assert.equal(accepts?.('report.pdf'), false);
});

test('prevents a second upload from starting for the same knowledge base', () => {
  const reserve = (knowledgeManager as typeof knowledgeManager & {
    reserveKnowledgeUpload?: (active: Set<string>, kbId: string) => boolean;
  }).reserveKnowledgeUpload;
  assert.equal(typeof reserve, 'function');

  const active = new Set<string>();
  assert.equal(reserve?.(active, 'kb-1'), true);
  assert.equal(reserve?.(active, 'kb-1'), false);
  assert.equal(reserve?.(active, 'kb-2'), true);
});

test('knowledge base cards expose upload controls and document status', () => {
  const Card = (knowledgeManager as typeof knowledgeManager & {
    KnowledgeBaseCard?: (props: Record<string, unknown>) => React.ReactNode;
  }).KnowledgeBaseCard;
  assert.equal(typeof Card, 'function');

  const html = renderToStaticMarkup(createElement(Card as React.ElementType, {
    base: { id: 'kb-1', name: '产品知识' },
    canWrite: true,
    documents: [{ id: 'document-1', name: 'guide.md', status: 'ready' }],
    uploadState: { kind: 'uploading', message: '正在上传 guide.md…' },
    onFileSelected: () => undefined,
    onDelete: () => undefined,
    onRefresh: () => undefined,
  }));

  assert.match(html, /上传 Markdown \/ TXT/);
  assert.match(html, /type="file"/);
  assert.match(html, /accept="\.md,\.markdown,\.txt,text\/markdown,text\/plain"/);
  assert.match(html, /guide\.md/);
  assert.match(html, /可检索/);
  assert.match(html, /正在上传 guide\.md/);
  assert.match(html, /disabled/);
});

test('keeps upload success when refreshing the document list fails', async () => {
  const finishUpload = (knowledgeManager as typeof knowledgeManager & {
    finishKnowledgeUpload?: (
      fileName: string,
      upload: () => Promise<void>,
      refreshDocuments: () => Promise<void>,
    ) => Promise<{ kind: string; message: string }>;
  }).finishKnowledgeUpload;
  assert.equal(typeof finishUpload, 'function');

  const state = await finishUpload?.(
    'guide.md',
    async () => undefined,
    async () => { throw new Error('list unavailable'); },
  );

  assert.equal(state?.kind, 'error');
  assert.match(state?.message ?? '', /guide\.md 已上传/);
  assert.match(state?.message ?? '', /文档列表刷新失败/);
  assert.doesNotMatch(state?.message ?? '', /guide\.md 上传失败/);
});

test('loads each knowledge base document list independently', async () => {
  const loadDocumentLists = (knowledgeManager as typeof knowledgeManager & {
    loadKnowledgeDocumentLists?: (
      bases: Array<{ id: string }>,
      fetchDocuments: (kbId: string) => Promise<Array<{ id: string; name: string }>>,
    ) => Promise<{
      documents: Record<string, Array<{ id: string; name: string }>>;
      errors: Record<string, string>;
    }>;
  }).loadKnowledgeDocumentLists;
  assert.equal(typeof loadDocumentLists, 'function');

  const result = await loadDocumentLists?.(
    [{ id: 'kb-ok' }, { id: 'kb-failed' }],
    async (kbId) => {
      if (kbId === 'kb-failed') throw new Error('list unavailable');
      return [{ id: 'document-1', name: 'guide.md' }];
    },
  );

  assert.deepEqual(result?.documents, {
    'kb-ok': [{ id: 'document-1', name: 'guide.md' }],
  });
  assert.deepEqual(Object.keys(result?.errors ?? {}), ['kb-failed']);
});

test('knowledge base cards keep upload and refresh controls when document loading fails', () => {
  const Card = (knowledgeManager as typeof knowledgeManager & {
    KnowledgeBaseCard?: (props: Record<string, unknown>) => React.ReactNode;
  }).KnowledgeBaseCard;
  assert.equal(typeof Card, 'function');

  const html = renderToStaticMarkup(createElement(Card as React.ElementType, {
    base: { id: 'kb-failed', name: '故障知识库' },
    canWrite: true,
    documentLoadError: '文档加载失败，请点击“刷新文档”重试。',
    onFileSelected: () => undefined,
    onDelete: () => undefined,
    onRefresh: () => undefined,
  }));

  assert.match(html, /文档加载失败/);
  assert.match(html, /刷新文档/);
  assert.match(html, /type="file"/);
  assert.doesNotMatch(html, /正在加载文档/);
});
