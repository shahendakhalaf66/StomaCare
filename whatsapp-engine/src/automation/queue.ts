import { Queue } from 'bullmq';
import { redisQueue as redis } from '../lib/redis.js';

/* ───────────────────────────────────────────────────────────
 *  Automation Job — the shape of every job enqueued
 * ─────────────────────────────────────────────────────────── */
export interface AutomationJob {
    automationId: string;
    automationStepId: string;
    stepOrder: number;
    stepType: 'action' | 'delay' | 'condition';
    payload: Record<string, any>;
    dealId?: string;
    conversationId?: string;
    workspaceId: string;
    entityType?: 'deal' | 'conversation';
}

/* ───────────────────────────────────────────────────────────
 *  Queue — dedicated queue for automation jobs
 *  Separate from the 'messages' queue to avoid interference
 * ─────────────────────────────────────────────────────────── */
export const automationQueue = new Queue<AutomationJob>('automations', {
    connection: redis,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 10_000, // 10s → 20s → 40s
        },
        removeOnComplete: 200,
        removeOnFail: 100,
    },
});

/**
 * Enqueue an automation step.
 * If `delayMs` is provided, the job will wait before being processed.
 */
export async function enqueueStep(
    job: AutomationJob,
    delayMs?: number
): Promise<string> {
    const added = await automationQueue.add(
        `step:${job.stepOrder}`,
        job,
        {
            ...(delayMs ? { delay: delayMs } : {}),
            // Unique per automation+deal+step to prevent duplicates
            jobId: `auto_${job.automationId}_entity_${job.dealId || job.conversationId}_step_${job.stepOrder}`,
        }
    );
    return added.id!;
}
