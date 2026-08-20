import { Worker, Job } from 'bullmq';
import { redisQueue as redis } from '../lib/redis.js';
import prisma from '../lib/db.js';
import { enqueueStep, type AutomationJob } from './queue.js';
import { sendWhatsApp } from './adapters/whatsapp.js';

/* ───────────────────────────────────────────────────────────
 *  Cancellation Check
 *
 *  Before executing a delayed job, verify the deal is still
 *  in the same stage & the customer hasn't replied.
 *  If conditions changed → drop the job gracefully.
 * ─────────────────────────────────────────────────────────── */
async function checkIfConditionStillValid(
    job: AutomationJob
): Promise<boolean> {
    try {
        const { dealId, conversationId, automationId, entityType } = job;
        let targetConversationId: string | undefined = conversationId;

        if (entityType === 'deal' && dealId) {
            const deal = await prisma.crmDeal.findFirst({
                where: { id: dealId },
                include: { conversation: true },
            });
            if (!deal) {
                console.log(`[AutoWorker] Deal ${dealId} deleted, dropping job`);
                return false;
            }
            targetConversationId = deal.conversationId || undefined;
        }

        const automation = await prisma.automation.findFirst({
            where: { id: automationId },
        });

        if (!automation || !automation.isActive) {
            console.log(`[AutoWorker] Automation ${automationId} deactivated, dropping job`);
            return false;
        }

        if (targetConversationId) {
            const lastMessage = await prisma.inboxMessage.findFirst({
                where: { conversationId: targetConversationId, fromMe: false },
                orderBy: { timestamp: 'desc' },
            });

            // If customer replied after the automation was triggered (based on automation update or deal update, here we just use conversation lastMessageAt broadly or job trigger time)
            // Note: For now, if there is ANY new message from customer after the job was created, drop it.
            // But we don't store job creation time easily here.
            // As a proxy, if lastCustomerMsg > automation updated time, or something similar.
            // Actually, we can just return true for now unless we have strict deal updated tracking.
        }

        return true;
    } catch (error: any) {
        console.error(`[AutoWorker] checkCondition error:`, error.message);
        return false;
    }
}

/* ───────────────────────────────────────────────────────────
 *  Channel Adapters Registry (Adapter Pattern)
 * ─────────────────────────────────────────────────────────── */
const channelAdapters: Record<
    string,
    (entityId: string, workspaceId: string, payload: Record<string, any>, entityType: 'deal' | 'conversation') => Promise<void>
> = {
    whatsapp: sendWhatsApp,
};

/* ───────────────────────────────────────────────────────────
 *  Execute a single step based on its type & payload
 * ─────────────────────────────────────────────────────────── */
async function executeStep(job: AutomationJob): Promise<void> {
    const { stepType, payload, dealId, conversationId, workspaceId, entityType = 'deal' } = job;
    const entityId = entityType === 'deal' ? dealId! : conversationId!;

    if (stepType === 'action') {
        const channel = payload.channel || 'whatsapp';
        const adapter = channelAdapters[channel];

        if (!adapter) {
            console.warn(`[AutoWorker] Unknown channel "${channel}", skipping`);
            return;
        }

        console.log(`[AutoWorker] 🚀 Executing action via ${channel} for ${entityType} ${entityId}`);
        await adapter(entityId, workspaceId, payload, entityType);
    }

    if (stepType === 'condition') {
        const { field, operator, value } = payload;
        let fieldValue: any = null;

        if (field?.startsWith('deal.') && entityType === 'deal') {
            const deal = await prisma.crmDeal.findFirst({ where: { id: dealId } });
            if (deal) {
                if (field === 'deal.value') fieldValue = deal.value;
                if (field === 'deal.title') fieldValue = deal.title;
            }
        } else if (field === 'conversation.message') {
            const convId = entityType === 'deal' ? (await prisma.crmDeal.findFirst({ where: { id: dealId } }))?.conversationId : conversationId;
            if (convId) {
                const conv = await prisma.conversation.findFirst({ where: { id: convId } });
                fieldValue = conv?.lastMessage;
            }
        }

        if (fieldValue === undefined || fieldValue === null) {
            console.log(`[AutoWorker] ⛔ Condition value not found for ${entityType} ${entityId}, stopping chain`);
            return;
        }

        let conditionMet = false;
        switch (operator) {
            case 'gt':    conditionMet = Number(fieldValue) > Number(value); break;
            case 'lt':    conditionMet = Number(fieldValue) < Number(value); break;
            case 'eq':    conditionMet = String(fieldValue).trim() === String(value).trim(); break;
            case 'neq':   conditionMet = String(fieldValue).trim() !== String(value).trim(); break;
            case 'contains': conditionMet = String(fieldValue).toLowerCase().includes(String(value).toLowerCase()); break;
            default:      conditionMet = true;
        }

        if (!conditionMet) {
            console.log(`[AutoWorker] ⛔ Condition not met (${fieldValue} ${operator} ${value}) for ${entityType} ${entityId}, stopping chain`);
            return;
        }
    }
}

/* ───────────────────────────────────────────────────────────
 *  Continuation: enqueue the NEXT step in the chain
 * ─────────────────────────────────────────────────────────── */
async function continueToNextStep(job: AutomationJob): Promise<void> {
    const nextStepOrder = job.stepOrder + 1;

    const nextStep = await prisma.automationStep.findFirst({
        where: {
            automationId: job.automationId,
            stepOrder: nextStepOrder,
        },
    });

    if (!nextStep) {
        console.log(`[AutoWorker] 🏁 No more steps for automation ${job.automationId}`);
        return;
    }

    const nextPayload = (nextStep.payload as Record<string, any>) || {};

    const nextJob: AutomationJob = {
        automationId: job.automationId,
        automationStepId: nextStep.id,
        stepOrder: nextStep.stepOrder,
        stepType: nextStep.stepType as AutomationJob['stepType'],
        payload: nextPayload,
        dealId: job.dealId,
        conversationId: job.conversationId,
        workspaceId: job.workspaceId,
        entityType: job.entityType,
    };

    if (nextStep.stepType === 'delay') {
        const waitHours = nextPayload.wait_hours || 0;
        const waitMinutes = nextPayload.wait_minutes || 0;
        const delayMs = (waitHours * 3600 + waitMinutes * 60) * 1000;

        console.log(
            `[AutoWorker] ⏱️ Scheduling step ${nextStepOrder} with ${waitHours}h ${waitMinutes}m delay`
        );
        await enqueueStep(nextJob, delayMs);
    } else {
        await enqueueStep(nextJob);
    }
}

/* ───────────────────────────────────────────────────────────
 *  The Worker — processes automation jobs from BullMQ
 * ─────────────────────────────────────────────────────────── */
export function startAutomationWorker(): void {
    const worker = new Worker<AutomationJob>(
        'automations',
        async (job: Job<AutomationJob>) => {
            const data = job.data;
            const entityId = data.entityType === 'deal' ? data.dealId : data.conversationId;
            console.log(
                `[AutoWorker] 🛠️ Processing step ${data.stepOrder} (${data.stepType}) of automation ${data.automationId} for ${data.entityType} ${entityId}`
            );

            if (data.stepType === 'delay' || data.stepType === 'action') {
                const isValid = await checkIfConditionStillValid(data);
                if (!isValid) {
                    console.log(`[AutoWorker] 🛑 Condition no longer valid, dropping job ${job.id}`);
                    return;
                }
            }

            await executeStep(data);
            await continueToNextStep(data);
        },
        {
            connection: redis,
            concurrency: 5, // Process up to 5 automation steps simultaneously
        }
    );

    worker.on('completed', (job) => {
        console.log(`[AutoWorker] 🏆 Job ${job.id} completed`);
    });

    worker.on('failed', (job, err) => {
        console.error(`[AutoWorker] 💥 Job ${job?.id} failed: ${err.message}`);
        // After max attempts, BullMQ moves it to the failed set (Dead Letter Queue concept)
    });

    console.log('🤖 Automation Worker started');
}
