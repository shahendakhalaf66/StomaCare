import prisma from '../lib/db.js';
import { triggerAutomation } from './engine.js';

/* ───────────────────────────────────────────────────────────
 *  NO_REPLY_24H Cron Job
 *
 *  Runs every 30 minutes.
 *  Finds conversations where:
 *    - The last message was FROM the business (fromMe = true)
 *    - The customer has NOT replied since then
 *    - The last outbound message was sent >= 24 hours ago
 *    - The conversation is OPEN (not resolved/closed)
 *
 *  For each match, triggers the NO_REPLY_24H automation once.
 *  Uses a Redis key to prevent duplicate triggers on the same conversation.
 * ─────────────────────────────────────────────────────────── */

// Simple in-memory Set to prevent duplicate triggers within the same process run.
// Persists as long as the engine is running.
const recentlyTriggered = new Set<string>();

export async function runNoReplyCron(): Promise<void> {
    try {
        const now = new Date();

        console.log(`[NoReplyCron] ⏰ Running check at ${now.toISOString()}`);

        // Check if there are any active NO_REPLY or NO_REPLY_24H automations
        const activeAutomations = await prisma.automation.findMany({
            where: {
                triggerEvent: { in: ['NO_REPLY', 'NO_REPLY_24H'] },
                isActive: true,
            },
            select: { id: true, workspaceId: true, triggerEvent: true, triggerConfig: true },
        });

        if (activeAutomations.length === 0) {
            console.log(`[NoReplyCron] No active NO_REPLY automations found, skipping`);
            return;
        }

        // Group automations by workspace
        const byWorkspace = new Map<string, typeof activeAutomations>();
        for (const auto of activeAutomations) {
            const list = byWorkspace.get(auto.workspaceId) || [];
            list.push(auto);
            byWorkspace.set(auto.workspaceId, list);
        }

        console.log(`[NoReplyCron] Found active automations in ${byWorkspace.size} workspace(s)`);

        let triggered = 0;
        let skipped = 0;

        for (const [workspaceId, automations] of byWorkspace) {
            // Use the minimum threshold to fetch candidates, then filter per automation
            const minHours = Math.min(...automations.map((a: any) => {
                const cfg = a.triggerConfig as any;
                if (a.triggerEvent === 'NO_REPLY_24H') return 24;
                return cfg?.no_reply_hours || 24;
            }));

            const threshold = new Date(now.getTime() - minHours * 60 * 60 * 1000);

            const conversations = await prisma.conversation.findMany({
                where: {
                    businessId: workspaceId,
                    status: 'open',
                    lastMessageAt: { lte: threshold },
                },
                select: { id: true, businessId: true, lastMessageAt: true, customerPhone: true },
            });

            for (const conv of conversations) {
                // Check if the last message is from us (outbound)
                const lastMsg = await prisma.inboxMessage.findFirst({
                    where: { conversationId: conv.id },
                    orderBy: { timestamp: 'desc' },
                });

                if (!lastMsg || !lastMsg.fromMe) { skipped++; continue; }

                // For each automation, check its specific threshold
                for (const auto of automations) {
                    const cfg = auto.triggerConfig as any;
                    const hours = auto.triggerEvent === 'NO_REPLY_24H' ? 24 : (cfg?.no_reply_hours || 24);
                    const autoThreshold = new Date(now.getTime() - hours * 60 * 60 * 1000);

                    if (!conv.lastMessageAt || conv.lastMessageAt > autoThreshold) continue;

                    const today = now.toISOString().split('T')[0];
                    const dedupKey = `no_reply_${auto.id}_${conv.id}_${today}`;
                    if (recentlyTriggered.has(dedupKey)) { skipped++; continue; }

                    console.log(`[NoReplyCron] 🚀 Triggering ${auto.triggerEvent} (${hours}h) for conv ${conv.id}`);
                    await triggerAutomation(auto.triggerEvent, conv.id, workspaceId, 'conversation');
                    recentlyTriggered.add(dedupKey);
                    triggered++;
                }
            }
        }

        console.log(`[NoReplyCron] ✅ Done — triggered: ${triggered}, skipped: ${skipped}`);
    } catch (error: any) {
        console.error(`[NoReplyCron] ❌ Error:`, error.message);
    }
}

/**
 * Starts the cron job that runs every 30 minutes.
 */
export function startNoReplyCron(): void {
    const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

    console.log(`[NoReplyCron] 🕐 Started — will check every 30 minutes`);

    // Run immediately on startup
    runNoReplyCron();

    // Then repeat every 30 minutes
    setInterval(runNoReplyCron, INTERVAL_MS);
}
