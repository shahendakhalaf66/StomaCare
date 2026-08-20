import prisma from '../lib/db.js';
import { enqueueStep, type AutomationJob } from './queue.js';

/* ───────────────────────────────────────────────────────────
 *  Trigger Engine
 *
 *  Called by any part of the system when a trigger event fires.
 *  Example: triggerAutomation('DEAL_STAGE_CHANGED', dealId, workspaceId)
 * ─────────────────────────────────────────────────────────── */

export async function triggerAutomation(
    eventName: string,
    entityId: string,
    workspaceId: string,
    entityType: 'deal' | 'conversation' = 'deal'
): Promise<void> {
    try {
        console.log(`[AutoEngine] 🔍 Triggering ${eventName} for ${entityType} ${entityId} (Workspace: ${workspaceId})`);
        
        // 1. Find all active automations matching this event + workspace
        const automations = await prisma.automation.findMany({
            where: {
                workspaceId,
                triggerEvent: eventName,
                isActive: true,
            },
        });

        console.log(`[AutoEngine] Found ${automations.length} active automations for ${eventName}`);

        if (automations.length === 0) return;

        console.log(
            `[AutoEngine] 🎯 Event "${eventName}" matched ${automations.length} automation(s) for ${entityType} ${entityId}`
        );

        // 2. For each automation, fetch the FIRST step (stepOrder = 1)
        for (const auto of automations) {
            const firstStep = await prisma.automationStep.findFirst({
                where: {
                    automationId: auto.id,
                    stepOrder: 1,
                },
            });

            if (!firstStep) {
                console.warn(`[AutoEngine] ⚠️ Automation "${auto.name}" has no steps, skipping`);
                continue;
            }

            const payload = (firstStep.payload as Record<string, any>) || {};

            const job: AutomationJob = {
                automationId: auto.id,
                automationStepId: firstStep.id,
                stepOrder: firstStep.stepOrder,
                stepType: firstStep.stepType as AutomationJob['stepType'],
                payload,
                dealId: entityType === 'deal' ? entityId : '',
                conversationId: entityType === 'conversation' ? entityId : '',
                workspaceId,
                entityType,
            };

            // 3. Enqueue based on step type
            if (firstStep.stepType === 'delay') {
                const waitHours = payload.wait_hours || 0;
                const waitMinutes = payload.wait_minutes || 0;
                const delayMs = (waitHours * 3600 + waitMinutes * 60) * 1000;

                console.log(
                    `[AutoEngine] ⏱️ Scheduling first step with ${waitHours}h ${waitMinutes}m delay`
                );
                await enqueueStep(job, delayMs);
            } else {
                // 'action' or 'condition' → enqueue immediately
                await enqueueStep(job);
            }

            console.log(
                `[AutoEngine] ✅ Enqueued step 1 of "${auto.name}" for ${entityType} ${entityId}`
            );
        }
    } catch (error: any) {
        console.error(`[AutoEngine] ❌ triggerAutomation error:`, error.message);
    }
}
