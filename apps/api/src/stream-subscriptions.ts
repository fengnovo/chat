import type { Redis } from 'ioredis';

type MessageListener = () => void;

interface SubscriberEntry {
  subscriber: Redis;
  channel: string;
  listeners: Set<MessageListener>;
}

/**
 * 复用同一个 Redis 订阅连接：相同 channel 的多个 SSE 客户端共享一条连接，
 * 由引用计数决定何时真正断开。每次重连（页面切走再切回）都新建一条 ioredis
 * 连接会累积订阅泄漏，直到进程退出才释放；这里集中管理并随 app 关闭统一清理。
 */
export class StreamSubscriptionHub {
  private readonly entries = new Map<string, SubscriberEntry>();

  constructor(private readonly createSubscriber: () => Redis) {}

  /**
   * 订阅一个 channel。返回的取消函数是幂等的：最后一个监听者离开时，
   * 对应的 Redis 连接会被释放。
   */
  async subscribe(
    channel: string,
    listener: MessageListener,
    onError?: (error: Error) => void,
  ): Promise<() => void> {
    const existing = this.entries.get(channel);
    if (existing) {
      existing.listeners.add(listener);
      return () => {
        existing.listeners.delete(listener);
        this.release(channel, existing);
      };
    }

    const subscriber = this.createSubscriber();
    const entry: SubscriberEntry = {
      subscriber,
      channel,
      listeners: new Set([listener]),
    };
    this.entries.set(channel, entry);
    subscriber.on('message', () => {
      for (const item of entry.listeners) item();
    });
    subscriber.on('error', (error: Error) => onError?.(error));

    try {
      await subscriber.connect();
      await subscriber.subscribe(channel);
    } catch (error) {
      // 订阅失败不能留下半初始化的 entry 和一个空转连接。
      this.entries.delete(channel);
      void subscriber.quit().catch(() => undefined);
      throw error;
    }

    return () => {
      entry.listeners.delete(listener);
      this.release(channel, entry);
    };
  }

  private release(channel: string, entry: SubscriberEntry) {
    if (entry.listeners.size > 0) return;
    if (this.entries.get(channel) !== entry) return;
    this.entries.delete(channel);
    void entry.subscriber.quit().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(
      entries.map((entry) => entry.subscriber.quit().catch(() => undefined)),
    );
  }
}
