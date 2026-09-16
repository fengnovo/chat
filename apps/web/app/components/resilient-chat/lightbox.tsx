import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { apiFetch } from './api';
import { Icon } from './icon';

type LightboxImage = {
  url: string;
  filename?: string;
};

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const SCALE_STEP = 0.25;

/**
 * 聊天图片大图查看：Portal 挂到 body（避开 transform 容器造成的定位/缩放问题），
 * 支持滚轮/按钮缩放（1x–4x）与按住拖动平移；Esc 或点击遮罩关闭。
 */
function Lightbox({
  image,
  onClose,
}: {
  image: LightboxImage | null;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  );
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // 切换图片时复位；Esc 关闭并锁定背景滚动；wheel 走原生 listener 可显式 passive: false。
  useEffect(() => {
    if (!image) return;
    reset();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const overlay = overlayRef.current;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setScale((current) => {
        const delta = event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP;
        const next = Number((current + delta).toFixed(2));
        const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
        if (clamped === MIN_SCALE) setOffset({ x: 0, y: 0 });
        return clamped;
      });
    };
    overlay?.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      overlay?.removeEventListener('wheel', onWheel);
    };
  }, [image, onClose, reset]);

  if (!image) return null;

  const zoomBy = (delta: number) => {
    setScale((current) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number((current + delta).toFixed(2))));
      if (next === MIN_SCALE) setOffset({ x: 0, y: 0 });
      return next;
    });
  };

  return createPortal(
    <div
      ref={overlayRef}
      className="lightbox-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={image.filename ? `图片预览：${image.filename}` : '图片预览'}
      onClick={onClose}
    >
      <div className="lightbox-toolbar" onClick={(event) => event.stopPropagation()}>
        <span className="lightbox-filename" title={image.filename}>
          {image.filename}
        </span>
        <div className="lightbox-actions">
          <button
            type="button"
            aria-label="缩小"
            disabled={scale <= MIN_SCALE}
            onClick={() => zoomBy(-SCALE_STEP)}
          >
            <Icon name="zoom-out" size={17} />
          </button>
          <span className="lightbox-scale">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            aria-label="放大"
            disabled={scale >= MAX_SCALE}
            onClick={() => zoomBy(SCALE_STEP)}
          >
            <Icon name="zoom-in" size={17} />
          </button>
          <button type="button" aria-label="复位" onClick={reset}>
            <Icon name="refresh" size={15} />
          </button>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <Icon name="x" size={17} />
          </button>
        </div>
      </div>
      <img
        alt={image.filename ?? '聊天图片大图'}
        className="lightbox-image"
        draggable={false}
        src={image.url}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          cursor: scale > 1 ? (dragRef.current ? 'grabbing' : 'grab') : 'default',
        }}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          if (scale <= 1) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            startX: event.clientX,
            startY: event.clientY,
            baseX: offset.x,
            baseY: offset.y,
          };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          setOffset({
            x: drag.baseX + (event.clientX - drag.startX),
            y: drag.baseY + (event.clientY - drag.startY),
          });
        }}
        onPointerUp={(event) => {
          dragRef.current = null;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onDoubleClick={() => {
          if (scale > 1) reset();
          else setScale(2);
        }}
      />
    </div>,
    document.body,
  );
}

/**
 * 下载 attachment content URL：fetch 带 cookie 跟进 302 → 拿 blob，
 * 用临时 <a download> 触发浏览器下载，然后释放 object URL。
 * chrome 下载管理器不续 cookie，直接 `<a href>` 会 401。
 */
async function triggerAttachmentDownload(url: string, filename?: string): Promise<void> {
  const response = await apiFetch(url);
  if (!response.ok) {
    throw new Error(`下载失败 HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  if (filename) anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 浏览器开始下载后即可释放，下载走的是独立请求。
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

export { Lightbox, triggerAttachmentDownload, type LightboxImage };
