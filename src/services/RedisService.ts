// src/services/RedisService.ts

import Redis from 'ioredis';

export class RedisService {
    private client: Redis;

    constructor() {
        this.client = new Redis({
            host: process.env.REDIS_HOST || 'localhost',
            port: Number(process.env.REDIS_PORT) || 6379,
        });
        console.log('✅ RedisService initialized.');
    }

    public async get<T>(key: string): Promise<T | null> {
        const data = await this.client.get(key);
        return data ? JSON.parse(data) : null;
    }

    public async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
        const data = JSON.stringify(value);
        if (ttlSeconds) {
            await this.client.setex(key, ttlSeconds, data);
        } else {
            await this.client.set(key, data);
        }
    }

    // "Умный" метод: если есть в кэше — верни, если нет — выполни функцию и сохрани
    public async getOrFetch<T>(key: string, fetchFn: () => Promise<T>, ttlSeconds: number): Promise<T> {
        const cached = await this.get<T>(key);
        if (cached) return cached;

        const freshData = await fetchFn();
        if (freshData) {
            await this.set(key, freshData, ttlSeconds);
        }
        return freshData;
    }
}