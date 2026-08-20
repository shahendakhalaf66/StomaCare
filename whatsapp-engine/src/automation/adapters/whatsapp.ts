import { addMessageToQueue } from '../../queue/message-queue.js';
import prisma from '../../lib/db.js';

/* ───────────────────────────────────────────────────────────
 *  WhatsApp Adapter
 *
 *  Sends a WhatsApp message via the appropriate platform:
 *    - whatsapp_cloud: Meta Graph API
 *    - whatsapp_360: 360dialog API
 *    - whatsapp (Baileys/QR): message queue
 *
 *  The payload should contain:
 *    - template: string (message body)
 *    - channelId?: string (if not provided, uses the deal's conversation channel)
 * ─────────────────────────────────────────────────────────── */

async function sendViaMetaCloud(pageId: string, accessToken: string, to: string, message: string): Promise<void> {
    const res = await fetch(`https://graph.facebook.com/v22.0/${pageId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } })
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`[WA Adapter] Meta Cloud API error: ${err}`);
    }
}

async function sendVia360(apiKey: string, to: string, message: string): Promise<void> {
    const res = await fetch('https://waba-v2.360dialog.io/messages', {
        method: 'POST',
        headers: { 'D360-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } })
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`[WA Adapter] 360dialog API error: ${err}`);
    }
}

export async function sendWhatsApp(
    entityId: string,
    workspaceId: string,
    payload: Record<string, any>,
    entityType: 'deal' | 'conversation' = 'deal'
): Promise<void> {
    let targetConversation: any = null;

    if (entityType === 'deal') {
        const deal = await prisma.crmDeal.findFirst({
            where: { id: entityId },
            include: { conversation: { include: { channel: true } } },
        });
        targetConversation = deal?.conversation;
    } else {
        targetConversation = await prisma.conversation.findFirst({
            where: { id: entityId },
            include: { channel: true },
        });
    }

    if (!targetConversation) {
        console.warn(`[WA Adapter] No linked conversation found for ${entityType} ${entityId}, skipping`);
        return;
    }

    const to = targetConversation.customerPhone;
    const message = payload.template || payload.message || '';
    const platform = targetConversation.channel?.platform;

    console.log(`[WA Adapter] 📤 Sending to ${to} via ${platform}: "${message.slice(0, 50)}..."`);

    if (platform === 'whatsapp_cloud') {
        const pageId = targetConversation.channel?.pageId;
        const accessToken = targetConversation.channel?.pageAccessToken;
        if (!pageId || !accessToken) {
            console.warn(`[WA Adapter] Missing pageId or accessToken for whatsapp_cloud channel, skipping`);
            return;
        }
        await sendViaMetaCloud(pageId, accessToken, to, message);
    } else if (platform === 'whatsapp_360') {
        const apiKey = targetConversation.channel?.pageAccessToken;
        if (!apiKey) {
            console.warn(`[WA Adapter] Missing API key for whatsapp_360 channel, skipping`);
            return;
        }
        await sendVia360(apiKey, to, message);
    } else {
        // Baileys/QR
        const channelId = payload.channelId || targetConversation.channel?.channelId;
        if (!channelId) {
            console.warn(`[WA Adapter] No channelId found for ${entityType} ${entityId}, skipping`);
            return;
        }
        await addMessageToQueue({
            channelId,
            to,
            messageType: 'text',
            message,
        });
    }

    // Notify Business App so it appears in the UI
    const businessWebhookUrl = process.env.BUSINESS_WEBHOOK_URL;
    if (businessWebhookUrl) {
        try {
            const url = businessWebhookUrl.replace(/(^"|"$)/g, '');
            const secret = (process.env.ENGINE_WEBHOOK_SECRET || '').replace(/(^"|"$)/g, '');
            await fetch(`${url}/api/webhook/internal-message`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-engine-secret': secret
                },
                body: JSON.stringify({
                    conversationId: targetConversation.id,
                    businessId: workspaceId,
                    messageBody: message,
                    senderPhone: targetConversation.channel?.phone || "automation"
                })
            });
        } catch (err) {
            console.error('[WA Adapter] Failed to report internal message', err);
        }
    }
}
