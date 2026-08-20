import { Queue } from 'bullmq';
import { redisQueue as redis } from '../lib/redis.js';

export interface MessageJob {
    channelId: string;
    to: string;
    messageType: 'text' | 'image' | 'video' | 'document' | 'audio';
    message?: string; // Caption or text body
    mediaUrl?: string; // If it's a media message
    mediaMimetype?: string;
    campaignId?: string; // To track campaign progress
    campaignMessageId?: string; // To update specific recipient status
    priority?: number;
}

export const messageQueue = new Queue<MessageJob>('messages', {
    connection: redis,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 5000,
        },
        removeOnComplete: 100,
        removeOnFail: 50,
    },
});

export async function addMessageToQueue(job: MessageJob): Promise<string> {
    const added = await messageQueue.add('send', job, {
        priority: job.priority || 1,
    });
    return added.id!;
}
