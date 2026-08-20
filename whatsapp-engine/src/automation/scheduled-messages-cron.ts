import prisma from '../lib/db.js';
import { addMessageToQueue } from '../queue/message-queue.js';

// Parse message body — if it's a __template__ JSON payload, return the parsed object; otherwise null
function parseTemplatePayload(message: string): Record<string, string> | null {
    if (!message.startsWith('{')) return null;
    try {
        const obj = JSON.parse(message);
        return obj.__template__ ? obj : null;
    } catch { return null; }
}

async function sendViaCloudApi(platform: string, pageId: string, accessToken: string, to: string, message: string): Promise<void> {
    const tmpl = parseTemplatePayload(message);

    if (tmpl) {
        // Named-parameter template message (e.g. booking_reminder_provider)
        const params = Object.entries(tmpl)
            .filter(([k]) => k !== '__template__')
            .map(([k, v]) => ({ type: 'text', parameter_name: k, text: String(v) }));
        const payload = {
            messaging_product: 'whatsapp', to, type: 'template',
            template: {
                name: tmpl.__template__,
                language: { code: 'ar' },
                components: [{ type: 'body', parameters: params }],
            },
        };
        if (platform === 'whatsapp_cloud') {
            const res = await fetch(`https://graph.facebook.com/v22.0/${pageId}/messages`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const json = await res.json().catch(() => ({})) as any;
            if (!res.ok || json?.error) throw new Error(`Meta template ${res.status}: ${JSON.stringify(json?.error || json)}`);
        } else if (platform === 'whatsapp_360') {
            const res = await fetch('https://waba-v2.360dialog.io/messages', {
                method: 'POST',
                headers: { 'D360-API-KEY': accessToken, 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const json = await res.json().catch(() => ({})) as any;
            const errCode = json?.error?.code || json?.errors?.[0]?.code;
            if (!res.ok || errCode) throw new Error(`360dialog template ${res.status}: ${JSON.stringify(json?.error || json?.errors || json)}`);
        }
        return;
    }

    // Plain text message
    if (platform === 'whatsapp_cloud') {
        const res = await fetch(`https://graph.facebook.com/v22.0/${pageId}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } }),
        });
        const json = await res.json().catch(() => ({})) as any;
        if (!res.ok || json?.error) {
            const errCode = json?.error?.code;
            const hint = errCode === 131047 ? ' [24h window expired — customer must message first]' : '';
            throw new Error(`Meta API ${res.status} code=${errCode}${hint}: ${JSON.stringify(json?.error || json)}`);
        }
    } else if (platform === 'whatsapp_360') {
        const res = await fetch('https://waba-v2.360dialog.io/messages', {
            method: 'POST',
            headers: { 'D360-API-KEY': accessToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } }),
        });
        const json = await res.json().catch(() => ({})) as any;
        const errCode = json?.error?.code || json?.errors?.[0]?.code;
        if (!res.ok || errCode) {
            const hint = errCode === 131047 ? ' [24h window expired — customer must message first]' : '';
            throw new Error(`360dialog API ${res.status} code=${errCode}${hint}: ${JSON.stringify(json?.error || json?.errors || json)}`);
        }
    }
}

/* ───────────────────────────────────────────────────────────
 *  Scheduled Messages Cron
 *
 *  Runs every minute.
 *  Finds ScheduledMessage records with:
 *    - status = "pending"
 *    - scheduledAt <= now
 *
 *  For targetType="contact": sends to the conversation's phone
 *  For targetType="tag": finds all contacts with that tag and sends to each
 * ─────────────────────────────────────────────────────────── */

export async function runScheduledMessagesCron(): Promise<void> {
    try {
        const now = new Date();

        // Find all due pending messages
        const dueMessages = await prisma.scheduledMessage.findMany({
            where: {
                status: 'pending',
                scheduledAt: { lte: now },
            },
        });

        if (dueMessages.length === 0) return;

        console.log(`[ScheduledCron] ⏰ Found ${dueMessages.length} scheduled message(s) to send`);

        for (const msg of dueMessages) {
            // Mark as "sending" immediately to prevent duplicate processing
            await prisma.scheduledMessage.update({
                where: { id: msg.id },
                data: { status: 'sending' },
            });

            try {
                let recipients: { phone: string }[] = [];

                if (msg.targetType === 'contact') {
                    // targetValue = conversationId
                    const conv = await prisma.conversation.findFirst({
                        where: { id: msg.targetValue, businessId: msg.businessId },
                        select: { customerPhone: true },
                    });
                    if (conv?.customerPhone) {
                        recipients = [{ phone: conv.customerPhone }];
                    }
                } else if (msg.targetType === 'tag') {
                    // targetValue = tag name — find all contacts with this tag
                    const contacts = await prisma.contact.findMany({
                        where: {
                            businessId: msg.businessId,
                            tags: { contains: msg.targetValue },
                        },
                        select: { phone: true },
                    });
                    recipients = contacts.map((c: any) => ({ phone: c.phone }));
                } else if (msg.targetType === 'phone') {
                    // targetValue = phone number (used for provider reminders)
                    if (msg.targetValue) {
                        // Strip non-digits and normalize (strip leading 00, keep country code)
                        const raw = msg.targetValue.replace(/[^0-9]/g, '');
                        const normalized = raw.startsWith('00') ? raw.slice(2) : raw;
                        if (normalized) recipients = [{ phone: normalized }];
                    }
                }

                if (recipients.length === 0) {
                    console.warn(`[ScheduledCron] ⚠️ No recipients found for message ${msg.id} (${msg.targetType}: ${msg.targetValue})`);
                    await prisma.scheduledMessage.update({
                        where: { id: msg.id },
                        data: { status: 'failed', errorMsg: 'No recipients found', sentAt: new Date() },
                    });
                    continue;
                }

                console.log(`[ScheduledCron] 📤 Sending to ${recipients.length} recipient(s) via channel ${msg.channelId}`);

                // Look up channel platform to route correctly
                const channel = await (prisma as any).businessChannel.findFirst({
                    where: { channelId: msg.channelId },
                    select: { platform: true, pageId: true, pageAccessToken: true },
                });
                const platform = channel?.platform || 'whatsapp';

                // For template payloads, render plain text for Baileys fallback
                const tmplData = parseTemplatePayload(msg.message);
                let plainText = msg.message;
                if (tmplData) {
                    if (tmplData.__template__ === 'booking_reminder_customer') {
                        // Customer reminder
                        const providerLine = tmplData.provider_name ? `\n👤 مع ${tmplData.provider_name}` : '';
                        plainText = `🔔 تذكير بموعدك:\n\n📋 ${tmplData.service_name}${providerLine}\n📅 ${tmplData.appointment_date}\n🕐 الساعة ${tmplData.appointment_time}\n\nنحن في انتظارك!`;
                    } else {
                        // Provider reminder (booking_reminder_provider) or other templates
                        plainText = `🔔 تذكير بموعد قادم:\n\n👤 العميل: ${tmplData.customer_name || ''}\n📋 ${tmplData.service_name}\n📅 ${tmplData.appointment_date}\n🕐 الساعة ${tmplData.appointment_time}\n\nيرجى الاستعداد!`;
                    }
                }

                for (const r of recipients) {
                    if ((platform === 'whatsapp_cloud' || platform === 'whatsapp_360') && channel?.pageId && channel?.pageAccessToken) {
                        await sendViaCloudApi(platform, channel.pageId, channel.pageAccessToken, r.phone, msg.message);
                    } else {
                        if (platform === 'whatsapp_cloud' || platform === 'whatsapp_360') {
                            console.warn(`[ScheduledCron] ⚠️ Cloud channel ${msg.channelId} missing pageId/pageAccessToken — falling back to Baileys queue (message may not deliver)`);
                        }
                        await addMessageToQueue({
                            channelId: msg.channelId,
                            to: r.phone,
                            messageType: 'text',
                            message: plainText,
                        });
                    }
                }

                await prisma.scheduledMessage.update({
                    where: { id: msg.id },
                    data: {
                        status: 'sent',
                        sentAt: new Date(),
                        recipientCount: recipients.length,
                    },
                });

                console.log(`[ScheduledCron] ✅ Sent message ${msg.id} to ${recipients.length} recipient(s)`);
            } catch (err: any) {
                console.error(`[ScheduledCron] ❌ Failed to send message ${msg.id}:`, err.message);
                await prisma.scheduledMessage.update({
                    where: { id: msg.id },
                    data: { status: 'failed', errorMsg: err.message, sentAt: new Date() },
                });
            }
        }
    } catch (error: any) {
        console.error(`[ScheduledCron] ❌ Cron error:`, error.message);
    }
}

/**
 * Starts the scheduled messages cron (runs every minute).
 */
export function startScheduledMessagesCron(): void {
    const INTERVAL_MS = 60 * 1000; // every minute

    console.log(`[ScheduledCron] 🕐 Started — checking every minute`);

    // Run immediately
    runScheduledMessagesCron();

    setInterval(runScheduledMessagesCron, INTERVAL_MS);
}
