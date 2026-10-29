export interface StreamEvent {
  type: string;
  data: unknown;
}

export interface BusClient {
  send(event: StreamEvent): void;
  close(): void;
}

/**
 * SSE 广播总线：按 userId 维护订阅者。
 * 配置 A 中这是唯一的实时出口——服务端决定推什么，浏览器负责弹横幅。
 */
export class NotificationBus {
  private readonly clients = new Map<string, Set<BusClient>>();

  add(userId: string, client: BusClient): () => void {
    let set = this.clients.get(userId);
    if (!set) {
      set = new Set();
      this.clients.set(userId, set);
    }
    set.add(client);

    return () => {
      const current = this.clients.get(userId);
      if (!current) return;
      current.delete(client);
      if (current.size === 0) this.clients.delete(userId);
    };
  }

  publish(userId: string, event: StreamEvent): void {
    const set = this.clients.get(userId);
    if (!set || set.size === 0) return;
    for (const client of set) {
      try {
        client.send(event);
      } catch {
        // 单个连接异常不影响其他订阅者
      }
    }
  }

  clientCount(userId: string): number {
    return this.clients.get(userId)?.size ?? 0;
  }

  totalClients(): number {
    let n = 0;
    for (const set of this.clients.values()) n += set.size;
    return n;
  }
}
