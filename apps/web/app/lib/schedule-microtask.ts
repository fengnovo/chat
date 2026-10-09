/**
 * 在当前调用栈结束后安排任务，不依赖原生 queueMicrotask API。
 * 较旧的浏览器会回退到 Promise 或定时器。
 */
export function scheduleMicrotask(callback: () => void): void {
  if (typeof globalThis !== 'undefined' && typeof globalThis.queueMicrotask === 'function') {
    globalThis.queueMicrotask(callback);
    return;
  }
  if (typeof Promise !== 'undefined') {
    void Promise.resolve().then(callback);
    return;
  }
  setTimeout(callback, 0);
}
