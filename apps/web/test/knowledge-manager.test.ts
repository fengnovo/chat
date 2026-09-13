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
