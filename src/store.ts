import { createRequire } from "node:module";

export interface PersistentStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
}

class MemoryStore implements PersistentStore {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async keys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    const prefix = pattern.replace("*", "");
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) keys.push(k);
    }
    return keys;
  }
}

class RedisStore implements PersistentStore {
  private client: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<unknown>; del(k: string): Promise<unknown>; keys(p: string): Promise<string[]> };

  constructor(url: string) {
    const require = createRequire(import.meta.url);
    const ioredis: any = require("ioredis");
    const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
    this.client = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.client.set(key, value);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async keys(pattern: string): Promise<string[]> {
    return this.client.keys(pattern);
  }
}

let _store: PersistentStore | null = null;

export function getStore(): PersistentStore {
  if (_store) return _store;
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    _store = new RedisStore(redisUrl);
  } else {
    _store = new MemoryStore();
  }
  return _store;
}

export function resetStore(): void {
  _store = null;
}