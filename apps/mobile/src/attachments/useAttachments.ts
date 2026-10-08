import { useCallback, useEffect, useRef, useState } from 'react';
import { getDocumentAsync } from 'expo-document-picker';
import { File } from 'expo-file-system';
import { api } from '../api/client';
import type { ChatAttachment } from '../api/types';
import { nativeUpload } from './native-upload';
import {
  uploadAttachment,
  validateFile,
  type SelectedFile,
  type UploadProgress,
} from './upload';

export interface DraftAttachment {
  id: string;
  file: SelectedFile;
  status: 'uploading' | 'ready' | 'failed';
  progress: UploadProgress;
  attachment?: ChatAttachment;
  error?: string;
}
export function useAttachments() {
  const [files, setFiles] = useState<DraftAttachment[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const controllers = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  const transfer = useCallback(async (draft: DraftAttachment) => {
    const controller = new AbortController();
    controllers.current.set(draft.id, controller);
    setFiles((current) =>
      current.map((item) =>
        item.id === draft.id
          ? { ...item, status: 'uploading', error: undefined }
          : item,
      ),
    );
    try {
      const attachment = await uploadAttachment(
        api,
        draft.file,
        nativeUpload,
        controller.signal,
        (progress) => {
          if (mounted.current)
            setFiles((current) =>
              current.map((item) =>
                item.id === draft.id ? { ...item, progress } : item,
              ),
            );
        },
      );
      if (!mounted.current || controller.signal.aborted) {
        void api
          .request(`/api/agent/chat-attachments/${attachment.id}`, {
            method: 'DELETE',
          })
          .catch(() => {});
        return;
      }
      if (mounted.current && !controller.signal.aborted)
        setFiles((current) =>
          current.map((item) =>
            item.id === draft.id
              ? { ...item, attachment, status: 'ready' }
              : item,
          ),
        );
    } catch (error) {
      if (mounted.current && !controller.signal.aborted)
        setFiles((current) =>
          current.map((item) =>
            item.id === draft.id
              ? {
                  ...item,
                  status: 'failed',
                  error: error instanceof Error ? error.message : '上传失败',
                }
              : item,
          ),
        );
    } finally {
      controllers.current.delete(draft.id);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllers.current.forEach((controller) => controller.abort());
      filesRef.current.forEach((item) => {
        if (item.attachment)
          void api
            .request(`/api/agent/chat-attachments/${item.attachment.id}`, {
              method: 'DELETE',
            })
            .catch(() => {});
      });
    };
  }, []);
  const pick = useCallback(async () => {
    const result = await getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled || !mounted.current) return;
    if (filesRef.current.length + result.assets.length > 5)
      throw new Error('每条消息最多上传 5 个附件');
    const selected = result.assets.map((asset) => ({
      uri: asset.uri,
      name: asset.name,
      size: asset.size ?? new File(asset.uri).size,
      mimeType: asset.mimeType,
    }));
    selected.forEach(validateFile);
    const drafts: DraftAttachment[] = selected.map((file, index) => ({
      id: `${Date.now()}-${index}-${Math.random()}`,
      file,
      status: 'uploading',
      progress: { phase: 'preparing', progress: 0 },
    }));
    filesRef.current = [...filesRef.current, ...drafts];
    setFiles(filesRef.current);
    drafts.forEach((draft) => {
      void transfer(draft);
    });
  }, [transfer]);
  const remove = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    const item = filesRef.current.find((file) => file.id === id);
    if (item?.attachment)
      void api
        .request(`/api/agent/chat-attachments/${item.attachment.id}`, {
          method: 'DELETE',
        })
        .catch(() => {});
    filesRef.current = filesRef.current.filter((file) => file.id !== id);
    setFiles(filesRef.current);
  }, []);
  const consume = useCallback(() => {
    filesRef.current = [];
    setFiles([]);
  }, []);
  return {
    files,
    pick,
    remove,
    consume,
    retry: transfer,
    ready: files.length > 0 && files.every((file) => file.status === 'ready'),
  };
}
