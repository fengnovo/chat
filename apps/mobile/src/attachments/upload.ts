import type { ApiClient } from '../api/client';
import type { ChatAttachment } from '../api/types';

export interface SelectedFile {
  uri: string;
  name: string;
  size: number;
  mimeType?: string;
}
export interface UploadProgress {
  phase: 'preparing' | 'uploading' | 'verifying';
  progress: number;
}
export interface UploadDependencies {
  read: (file: SelectedFile) => Promise<Uint8Array<ArrayBuffer>>;
  hash: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
  put: typeof fetch;
}
const imageTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
const textExtensions = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'log',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'sh',
  'sql',
  'ini',
  'conf',
  'toml',
]);
export function validateFile(file: SelectedFile): string {
  const type = file.mimeType?.toLowerCase() || 'application/octet-stream';
  const text =
    type.startsWith('text/') ||
    textExtensions.has(file.name.split('.').pop()?.toLowerCase() ?? '');
  const limit = imageTypes.has(type)
    ? 10 * 1024 * 1024
    : text
      ? 200_000
      : 50 * 1024 * 1024;
  if (file.size > limit)
    throw new Error(
      imageTypes.has(type)
        ? '图片不能超过 10MB'
        : text
          ? '文本文件不能超过 200KB'
          : '文件不能超过 50MB',
    );
  return type;
}
interface Init {
  mode: 'instant' | 'single' | 'multipart';
  attachment: ChatAttachment;
  uploadUrl?: string;
  headers?: Record<string, string>;
  partSize?: number;
  parts?: { number: number; uploadUrl: string }[];
}

/** 使用 Web 端的 init → 预签名 PUT → complete 协议，并计算原始字节哈希。 */
export async function uploadAttachment(
  api: ApiClient,
  file: SelectedFile,
  deps: UploadDependencies,
  signal: AbortSignal,
  onProgress: (value: UploadProgress) => void,
): Promise<ChatAttachment> {
  const contentType = validateFile(file);
  let id: string | undefined;
  try {
    onProgress({ phase: 'preparing', progress: 0 });
    const bytes = await deps.read(file);
    if (signal.aborted) throw new Error('上传已取消');
    validateFile({ ...file, size: bytes.length });
    const sha256 = await deps.hash(bytes);
    if (signal.aborted) throw new Error('上传已取消');
    const init = await api.request<Init>('/api/agent/chat-attachments', {
      method: 'POST',
      signal,
      body: {
        filename: file.name,
        contentType,
        sizeBytes: bytes.length,
        contentSha256: sha256,
        storedSha256: sha256,
        storedSizeBytes: bytes.length,
      },
    });
    id = init.attachment.id;
    if (signal.aborted) throw new Error('上传已取消');
    onProgress({ phase: 'uploading', progress: 0 });
    const completedParts: { number: number; etag: string }[] = [];
    if (init.mode === 'single') {
      if (!init.uploadUrl) throw new Error('上传地址缺失');
      const response = await deps.put(init.uploadUrl, {
        method: 'PUT',
        headers: init.headers,
        body: bytes,
        signal,
      });
      if (!response.ok) throw new Error(`上传失败（${response.status}）`);
    } else if (init.mode === 'multipart') {
      if (
        !init.partSize ||
        !init.parts?.length ||
        init.parts.length !== Math.ceil(bytes.length / init.partSize)
      )
        throw new Error('分片计划不完整');
      for (const part of [...init.parts].sort((a, b) => a.number - b.number)) {
        let etag: string | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (signal.aborted) throw new Error('上传已取消');
          try {
            const response = await deps.put(part.uploadUrl, {
              method: 'PUT',
              body: bytes.slice(
                (part.number - 1) * init.partSize,
                part.number * init.partSize,
              ),
              signal,
            });
            if (!response.ok)
              throw new Error(`分片上传失败（${response.status}）`);
            etag = response.headers.get('etag');
            if (!etag) throw new Error('上传响应缺少 ETag');
            break;
          } catch (error) {
            if (signal.aborted || attempt === 2) throw error;
          }
        }
        completedParts.push({ number: part.number, etag: etag! });
        onProgress({
          phase: 'uploading',
          progress: completedParts.length / init.parts.length,
        });
      }
    }
    onProgress({ phase: 'verifying', progress: 1 });
    const result = await api.request<{ attachment: ChatAttachment }>(
      `/api/agent/chat-attachments/${id}/complete`,
      {
        method: 'POST',
        signal,
        ...(init.mode === 'multipart'
          ? { body: { parts: completedParts } }
          : {}),
      },
    );
    return result.attachment;
  } catch (error) {
    if (id)
      await api
        .request(`/api/agent/chat-attachments/${id}`, { method: 'DELETE' })
        .catch(() => {});
    throw error;
  }
}
