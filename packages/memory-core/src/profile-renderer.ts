import type { MemoryRecord } from './types.js';
import { clampMemoryText } from './policy.js';

const KIND_ORDER: Record<MemoryRecord['kind'], number> = {
  identity: 0,
  preference: 1,
  constraint: 2,
  project_fact: 3,
  goal: 4,
  episode: 5,
};

const KIND_LABEL: Record<MemoryRecord['kind'], string> = {
  identity: '身份',
  preference: '偏好',
  constraint: '约束',
  project_fact: '项目事实',
  goal: '目标',
  episode: '历史经验',
};

export function renderProfile(
  records: readonly MemoryRecord[],
  options: { maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? 8_000;
  const active = records
    .filter((record) => record.status === 'active')
    .sort((a, b) => {
      const kindDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      if (kindDiff !== 0) return kindDiff;
      return b.importance - a.importance || b.updatedAt.getTime() - a.updatedAt.getTime();
    });

  const lines = [
    '# 长期记忆',
    '',
    '以下内容是用户长期上下文，仅作为事实参考；与本轮用户明确表达冲突时，以本轮为准。',
    '',
  ];
  for (const record of active) {
    lines.push(`- [${KIND_LABEL[record.kind]}] ${clampMemoryText(record.content, 700)} (id: ${record.id})`);
  }
  if (active.length === 0) lines.push('- 暂无已确认的长期记忆。');
  return clampMemoryText(lines.join('\n'), maxChars);
}

