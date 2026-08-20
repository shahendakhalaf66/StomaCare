import { Redis } from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

function makeRedis(url: string, label: string) {
    const client = new Redis(url, {
        maxRetriesPerRequest: null,
        lazyConnect: true,
        retryStrategy: (times) => {
            if (times > 20) console.log(`⚠️ [${label}] Redis not available after many retries`);
            return Math.min(times * 500, 5000);
        },
    });
    client.on('connect', () => console.log(`🔗 Connected to Redis (${label})`));
    client.on('error', (err) => console.error(`❌ Redis error (${label}):`, err.message));
    return client;
}

// General pub/sub Redis — allkeys-lru, used for general communication
export const redis = makeRedis(
    process.env.REDIS_URL || 'redis://localhost:6379',
    'pubsub'
);

// Queue-dedicated Redis — noeviction policy, BullMQ jobs are never evicted
export const redisQueue = makeRedis(
    process.env.REDIS_QUEUE_URL || process.env.REDIS_URL || 'redis://localhost:6379',
    'queue'
);

let redisConnected = false;
redis.on('connect', () => { redisConnected = true; });

export const isRedisAvailable = () => redisConnected;
