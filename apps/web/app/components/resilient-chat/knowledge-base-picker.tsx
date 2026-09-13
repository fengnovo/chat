'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type KnowledgeBase = { id: string; name: string; status?: string };
type StorageLike = Pick<Storage, 'getItem' | 'setItem'> | Map<string, string>;

function storageGet(storage: StorageLike, key: string) { return storage instanceof Map ? storage.get(key) ?? null : storage.getItem(key); }
function storageSet(storage: StorageLike, key: string, value: string) { if (storage instanceof Map) storage.set(key, value); else storage.setItem(key, value); }
function toggleKnowledgeBase(ids: string[], id: string) { return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]; }
function knowledgeBaseIdsForChat(chatId: string, storage?: StorageLike): string[] {
  if (!storage && typeof window === 'undefined') return [];
  const source = storage ?? window.localStorage;
  try { const parsed = JSON.parse(storageGet(source, `knowledge-bases:${chatId}`) ?? '[]'); return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []; } catch { return []; }
}

function KnowledgeBasePicker({ chatId, bases, value, onChange }: { chatId: string; bases: KnowledgeBase[]; value?: string[]; onChange?: (ids: string[]) => void }) {
  const [selected, setSelected] = useState(() => value ?? knowledgeBaseIdsForChat(chatId));
  useEffect(() => { const next = value ?? knowledgeBaseIdsForChat(chatId); setSelected(next); }, [chatId, value]);
  const toggle = (id: string) => { const next = toggleKnowledgeBase(selected, id); setSelected(next); storageSet(window.localStorage, `knowledge-bases:${chatId}`, JSON.stringify(next)); onChange?.(next); };
  return <div className="knowledge-picker" aria-label="知识库">{bases.map((base) => <label key={base.id}><input type="checkbox" checked={selected.includes(base.id)} onChange={() => toggle(base.id)} />{base.name}</label>)}<Link className="knowledge-manage-link" href="/knowledge">管理知识库</Link></div>;
}

export { KnowledgeBasePicker, knowledgeBaseIdsForChat, toggleKnowledgeBase };
