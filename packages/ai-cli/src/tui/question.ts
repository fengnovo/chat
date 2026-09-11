import type { UserQuestionAnswer, UserQuestionRequest } from './types.js';

export function toggleQuestionSelection(selected: number[], index: number): number[] {
  return selected.includes(index)
    ? selected.filter((item) => item !== index)
    : [...selected, index].sort((a, b) => a - b);
}

export function buildUserQuestionAnswer(
  request: UserQuestionRequest,
  selectedIndices: number[],
  customInput: string,
): UserQuestionAnswer | null {
  const indices = [...new Set(selectedIndices)]
    .filter((index) => index >= 0 && index < request.options.length)
    .sort((a, b) => a - b);
  const selections = indices.map((index) => ({
    index,
    label: request.options[index]!.label,
  }));
  const customText = request.allowCustom ? customInput.trim() : '';

  if (selections.length === 0 && !customText) return null;

  return {
    selections: request.multiple ? selections : selections.slice(0, 1),
    ...(customText ? { customText } : {}),
  };
}
