'use client';

import { useEffect, useState } from 'react';
import { createKnowledgeBase, deleteKnowledgeBase, fetchKnowledgeBases, uploadKnowledgeDocument, type KnowledgeBase } from '../components/resilient-chat/api';

export function KnowledgeManager() {
  const [bases, setBases] = useState<KnowledgeBase[]>([]); const [name, setName] = useState(''); const [error, setError] = useState<string | null>(null);
  const refresh = () => void fetchKnowledgeBases().then(setBases).catch(() => setError('知识库加载失败'));
  useEffect(refresh, []);
  const create = async () => { if (!name.trim()) return; try { await createKnowledgeBase({ name: name.trim() }); setName(''); refresh(); } catch { setError('创建失败'); } };
  return <main className="knowledge-page"><header><h1>知识库</h1><p>管理可供 Agent 检索的 Markdown 与 TXT 文档。</p></header><div className="knowledge-create"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="新知识库名称" /><button type="button" onClick={() => void create()}>新建</button></div>{error && <p role="alert">{error}</p>}<div className="knowledge-grid">{bases.map((base) => <article key={base.id}><h2>{base.name}</h2><p>状态：{base.status ?? 'ready'}</p><label>上传 Markdown / TXT<input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadKnowledgeDocument(base.id, file).then(refresh).catch(() => setError('上传失败')); }} /></label><button type="button" onClick={() => void deleteKnowledgeBase(base.id).then(refresh).catch(() => setError('删除失败'))}>删除</button></article>)}</div></main>;
}
