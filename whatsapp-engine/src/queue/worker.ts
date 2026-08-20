import { Worker, Job } from 'bullmq';
import { redisQueue as redis, isRedisAvailable } from '../lib/redis.js';
import { MessageJob } from './message-queue.js';
import { sessionManager } from '../index.js';
import dotenv from 'dotenv';

dotenv.config();

// Random delay between 5s and 12s to avoid WhatsApp spam detection but still be reasonably fast
const MIN_DELAY_MS = 5000;
const MAX_DELAY_MS = 12000;

function getRandomDelay() {
    return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS;
}

export function startWorker() {
    const worker = new Worker<MessageJob>(
        'messages',
        async (job: Job<MessageJob>) => {
            console.log(`[Worker] 🛠️ Processing job ${job.id} for channel ${job.data.channelId} to ${job.data.to}`);
            
            const { channelId, to, messageType, message, mediaUrl, mediaMimetype, campaignId, campaignMessageId } = job.data;
            const session = sessionManager.getSession(channelId);

            if (!session || session.status !== 'ready' || !session.client) {
                throw new Error(`Channel ${channelId} is not connected.`);
            }

            try {
                // Strip non-numeric chars (e.g. leading "+") so the JID is valid for Baileys
                const normalizedPhone = to.includes('@') ? to : String(to).replace(/[^\d]/g, '');
                const jid = normalizedPhone.includes('@s.whatsapp.net') ? normalizedPhone : `${normalizedPhone}@s.whatsapp.net`;
                
                // Add the randomized anti-ban delay before sending
                const delayMs = getRandomDelay();
                console.log(`[Worker] ⏳ Waiting ${delayMs}ms before sending to ${to}...`);
                try {
                    // Send typing or recording presence to look human
                    const presence = messageType === 'audio' ? 'recording' : 'composing';
                    await session.client.sendPresenceUpdate(presence, jid);
                } catch (err) {
                    console.log(`[Worker] Failed to send presence update for ${to}:`, (err as Error).message);
                }

                await new Promise(resolve => setTimeout(resolve, delayMs));

                try {
                    await session.client.sendPresenceUpdate('paused', jid);
                } catch (err) {
                    // ignore
                }

                let waMessage;
                if (messageType === 'text') {
                    waMessage = await session.client.sendMessage(jid, { text: message || '' });
                } else if (mediaUrl) {
                    // Send media (requires fetching the media buffer first)
                    // Currently assuming Business API downloads the remote URL into a buffer or we give WA Baileys the URL
                    // Baileys allows { image: { url: string } }
                    waMessage = await session.client.sendMessage(jid, {
                        [messageType]: { url: mediaUrl },
                        caption: message,
                        mimetype: mediaMimetype
                    } as any);
                } else {
                    throw new Error('Invalid messageType or missing mediaUrl');
                }

                console.log(`[Worker] ✅ Sent job ${job.id} to ${to}`);

                // If this is part of a campaign, report success back to Business App
                if (campaignId && campaignMessageId) {
                    await reportCampaignProgress(campaignId, campaignMessageId, 'sent');
                }

                return waMessage?.key?.id;
            } catch (error: any) {
                console.error(`[Worker] ❌ Failed job ${job.id}:`, error.message);
                
                // Report failure back
                if (campaignId && campaignMessageId) {
                    await reportCampaignProgress(campaignId, campaignMessageId, 'failed', error.message);
                }
                
                throw error; // Let BullMQ handle retries based on backoff
            }
        },
        {
            connection: redis,
            concurrency: 1, // Process 1 message at a time per worker instance to respect rate limits globally
            limiter: {
                max: 10,       // Max 10 messages
                duration: 60000 // per 60 seconds (1 minute) cluster-wide rate limit
            }
        }
    );

    worker.on('completed', (job) => {
        console.log(`[Worker] 🏆 Job ${job.id} completed successfully`);
    });

    worker.on('failed', (job, err) => {
        console.error(`[Worker] 💥 Job ${job?.id} has failed with error: ${err.message}`);
    });

    console.log('👷 Message Worker started');
}

async function reportCampaignProgress(campaignId: string, campaignMessageId: string, status: 'sent' | 'failed', error?: string) {
    const webhookUrl = process.env.BUSINESS_WEBHOOK_URL;
    if (!webhookUrl) return;

    try {
        const cleanUrl = webhookUrl.replace(/(^"|"$)/g, '');
        const cleanSecret = (process.env.ENGINE_WEBHOOK_SECRET || '').replace(/(^"|"$)/g, '');

        await fetch(`${cleanUrl}/api/webhook/campaigns`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-engine-secret': cleanSecret
            },
            body: JSON.stringify({
                campaignId,
                campaignMessageId,
                status,
                error
            })
        });
    } catch (err: any) {
        console.error('[Worker] Failed to report campaign progress', err.message);
    }
}
