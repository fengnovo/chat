import { apiFetch } from './api';

export type ChatAttachmentKind = 'image' | 'text' | 'file';

/** 与后端 attachmentHistoryView 对齐的附件元数据。 */
export type ChatAttachmentView = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  kind: ChatAttachmentKind;
  /** 鉴权重定向地址：浏览器取内容时由后端换发新鲜预签名 URL。 */
  url: string;
};

type InitUploadResponse = {
  attachment: ChatAttachmentView;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
};

async function readJsonOrThrow(response: Response, fallback: string): Promise<never> {
  const payload = (await response.json().catch(() => null)) as
    | { error?: string; message?: string }
    | null;
  const knownErrors: Record<string, string> = {
    image_attachment_too_large: '图片不能超过 10MB',
    text_attachment_too_large: '文本文件不能超过 200KB',
    file_attachment_too_large: '文件不能超过 50MB',
  };
  const code = payload?.error ?? '';
  throw new Error(
    knownErrors[code] ?? payload?.message ?? fallback,
  );
}

function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  return crypto.subtle.digest('SHA-256', buffer).then((digest) =>
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
  );
}

/**
 * 选完即传的三段式上传：init（建 pending 记录 + 预签名 PUT）
 * → 直传对象存储 → complete（校验大小/摘要后置 ready）。
 * 发送消息时只把返回的 id 随 /api/chat 带给后端。
 */
export async function uploadChatAttachment(file: File): Promise<ChatAttachmentView> {
  const buffer = await file.arrayBuffer();
  const sha256 = await sha256Hex(buffer);
  const contentType = file.type || 'application/octet-stream';

  const initResponse = await apiFetch('/api/agent/chat-attachments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      contentType,
      sizeBytes: file.size,
      sha256,
    }),
  });
  if (!initResponse.ok) {
    await readJsonOrThrow(initResponse, '附件初始化失败');
  }
  const presign = (await initResponse.json()) as InitUploadResponse;
  const attachmentId = presign.attachment.id;

  const uploadHeaders = new Headers(presign.headers);
  let putResponse: Response;
  try {
    putResponse = await fetch(presign.uploadUrl, {
      method: 'PUT',
      body: file,
      headers: uploadHeaders,
    });
  } catch {
    await deleteChatAttachment(attachmentId).catch(() => undefined);
    throw new Error('无法连接文件存储服务，请稍后重试或联系管理员');
  }
  if (!putResponse.ok) {
    await deleteChatAttachment(attachmentId).catch(() => undefined);
    throw new Error(`文件上传失败（HTTP ${putResponse.status}）`);
  }

  const completeResponse = await apiFetch(
    `/api/agent/chat-attachments/${encodeURIComponent(attachmentId)}/complete`,
    { method: 'POST' },
  );
  if (!completeResponse.ok) {
    await readJsonOrThrow(completeResponse, '附件校验失败');
  }
  const complete = (await completeResponse.json()) as { attachment: ChatAttachmentView };
  return complete.attachment;
}

/** 删除尚未发送（未关联 run）的附件；已发送的附件后端会拒绝。 */
export async function deleteChatAttachment(attachmentId: string): Promise<void> {
  const response = await apiFetch(
    `/api/agent/chat-attachments/${encodeURIComponent(attachmentId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`附件删除失败（HTTP ${response.status}）`);
  }
}
