import { Router, Request, Response } from 'express';
import { sessionManager } from '../index.js';
import prisma from '../lib/db.js';
import { addMessageToQueue } from '../queue/message-queue.js';
import { randomUUID } from 'crypto';

export const channelsRouter: Router = Router();



// Get batch status for multiple channels (for performance - avoids N+1 queries)
channelsRouter.post('/status-batch', async (req: Request, res: Response) => {
    try {
        const { channelIds } = req.body;

        if (!Array.isArray(channelIds)) {
            return res.status(400).json({ success: false, error: 'channelIds must be an array' });
        }

        const statuses: Record<string, string> = {};
        for (const id of channelIds) {
            const session = sessionManager.getSession(id);
            if (session) {
                statuses[id] = session.status;
            }
        }

        res.json({ success: true, statuses });
    } catch (error) {
        console.error('Error getting batch status:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});
channelsRouter.post('/connect', async (req: Request, res: Response) => {
    try {
        const { name, userId, storeId } = req.body;

        const sessionId = randomUUID();

        // Check if an existing disconnected or initializing channel needs setup instead of new creation
        // Note: business app already creates the row prior to calling this endpoint.
        // So we might only need to initialize the Baileys session or find if one was just created recently.
        // To be safe, let's just create a new session ID and let Business side stitch it.
        const session = await sessionManager.createSession(sessionId);

        res.json({
            success: true,
            channel: {
                id: sessionId,
                name: name || 'New Channel',
                status: session.status,
            },
        });
    } catch (error) {
        console.error('Error creating channel:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

// POST /channels/:id/reconnect - Reconnect an existing channel
channelsRouter.post('/:id/reconnect', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        // Check if channel exists in database
        const channel = await prisma.businessChannel.findFirst({
            where: { channelId: id }
        });

        if (!channel) {
            return res.status(404).json({ success: false, error: 'Channel not found' });
        }

        // Destroy existing session if any
        try {
            await sessionManager.destroySession(id);
        } catch {
            // Session might not exist
        }

        // Update status to reconnecting
        await prisma.businessChannel.updateMany({
            where: { channelId: id },
            data: { status: 'reconnecting' }
        });

        // Create new session for existing channel (will trigger QR code)
        const session = await sessionManager.createSession(id);

        console.log(`🔄 Channel reconnecting: ${channel.name} (${id})`);

        res.json({
            success: true,
            channel: {
                id: id,
                name: channel.name,
                status: session.status,
            },
        });
    } catch (error) {
        console.error('Error reconnecting channel:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

// Get channel status
channelsRouter.get('/:id/status', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const session = sessionManager.getSession(id);

        if (!session) {
            // Check database
            const data = await prisma.businessChannel.findFirst({
                where: { channelId: id }
            });

            if (!data) {
                return res.status(404).json({ success: false, error: 'Channel not found' });
            }

            return res.json({
                success: true,
                channel: {
                    id: data.channelId,
                    name: data.name,
                    status: data.status,
                    phoneNumber: data.phone,
                },
            });
        }

        res.json({
            success: true,
            channel: {
                id: session.id,
                status: session.status,
                phoneNumber: session.phoneNumber,
                qrCode: session.qrCode,
            },
        });
    } catch (error) {
        console.error('Error getting channel status:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

// Get QR code
channelsRouter.get('/:id/qr', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const session = sessionManager.getSession(id);

        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }

        if (session.status !== 'qr' || !session.qrCode) {
            return res.json({
                success: true,
                status: session.status,
                qrCode: null,
            });
        }

        res.json({
            success: true,
            status: session.status,
            qrCode: session.qrCode,
        });
    } catch (error) {
        console.error('Error getting QR code:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

// DELETE /channels/:id - Delete a channel completely
channelsRouter.delete('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        console.log(`🗑️ DELETE request received for channel: ${id}`);

        // Destroy WhatsApp session if exists
        try {
            await sessionManager.destroySession(id);
            console.log(`🗑️ Session destroyed: ${id}`);
        } catch (sessionError) {
            console.log(`Session ${id} not found or already destroyed`);
        }

        // Delete from database (not just update status)
        await prisma.businessChannel.deleteMany({
            where: { channelId: id }
        });

        console.log(`🗑️ Channel deleted successfully: ${id}`);

        res.json({ success: true, message: 'Channel deleted successfully' });
    } catch (error) {
        console.error('Error deleting channel:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

// Send message
channelsRouter.post('/:id/send', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { to, message, priority } = req.body;

        if (!to || !message) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: to, message',
            });
        }

        // Get the session
        const client = sessionManager.getClient(id);
        if (!client) {
            return res.status(404).json({
                success: false,
                error: 'Channel not found or not connected',
            });
        }

        const session = client.getSession();
        if (session.status !== 'ready') {
            return res.status(400).json({
                success: false,
                error: `Channel is not ready (status: ${session.status})`,
            });
        }

        // Send directly (since Redis is not available for dev)
        const sendResult = await client.sendMessage(to, message, req.body.quotedId);

        res.json({
            success: true,
            message: 'Message sent successfully',
            waMessageId: sendResult?.key?.id
        });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

// Send media
channelsRouter.post('/:id/send-media', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { to, mediaBase64, mimeType, fileName, caption, ptt, quotedId } = req.body;

        if (!to || !mediaBase64 || !mimeType || !fileName) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: to, mediaBase64, mimeType, fileName',
            });
        }

        const client = sessionManager.getClient(id);
        if (!client) {
            return res.status(404).json({
                success: false,
                error: 'Channel not found or not connected',
            });
        }

        const session = client.getSession();
        if (session.status !== 'ready') {
            return res.status(400).json({
                success: false,
                error: `Channel is not ready (status: ${session.status})`,
            });
        }

        const mediaBuffer = Buffer.from(mediaBase64, 'base64');
        await client.sendMedia(to, mediaBuffer, mimeType, fileName, caption, ptt, quotedId);

        res.json({
            success: true,
            message: 'Media sent successfully',
        });
    } catch (error) {
        console.error('Error sending media:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

channelsRouter.post('/:id/react', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { to, waMessageId, emoji, isFromMe } = req.body;

        if (!to || !waMessageId) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: to, waMessageId',
            });
        }

        const client = sessionManager.getClient(id);
        if (!client) {
            return res.status(404).json({ success: false, error: 'Channel not found or not connected' });
        }

        const session = client.getSession();
        if (session.status !== 'ready') {
            return res.status(400).json({ success: false, error: `Channel is not ready` });
        }

        await client.sendReaction(to, waMessageId, emoji, isFromMe);

        res.json({ success: true, message: 'Reaction sent successfully' });
    } catch (error) {
        console.error('Error sending reaction:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

channelsRouter.post('/:id/delete-message', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { to, waMessageId, fromMe = true } = req.body;

        if (!to || !waMessageId) {
            return res.status(400).json({ success: false, error: 'Missing required fields: to, waMessageId' });
        }

        const client = sessionManager.getClient(id);
        if (!client) {
            return res.status(404).json({ success: false, error: 'Channel not found or not connected' });
        }

        const session = client.getSession();
        if (session.status !== 'ready') {
            return res.status(400).json({ success: false, error: 'Channel is not ready' });
        }

        await client.deleteMessage(to, waMessageId, fromMe);

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting message:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

channelsRouter.post('/:id/read', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { phone } = req.body;

        if (!phone) {
            return res.status(400).json({ success: false, error: 'Missing phone' });
        }

        const client = sessionManager.getClient(id);
        if (!client) {
            return res.status(404).json({ success: false, error: 'Channel not found or not connected' });
        }

        await client.markAsRead(phone);

        res.json({ success: true, message: 'Message read receipt sent' });
    } catch (error) {
        console.error('Error sending read receipt:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

// Enqueue bulk campaign messages
channelsRouter.post('/:id/campaigns/send', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { messages, campaignId } = req.body;

        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ success: false, error: 'Messages array is required' });
        }

        const session = sessionManager.getSession(id);
        if (!session || session.status !== 'ready') {
            return res.status(404).json({ success: false, error: 'Channel not found or not connected' });
        }

        // Enqueue all messages using the imported queue
        await Promise.all(messages.map((msg: any) => addMessageToQueue({
            channelId: id,
            to: msg.to,
            messageType: msg.messageType || 'text',
            message: msg.message,
            mediaUrl: msg.mediaUrl,
            mediaMimetype: msg.mediaMimetype,
            campaignId: campaignId,
            campaignMessageId: msg.campaignMessageId,
            priority: msg.priority || 1
        })));

        res.json({
            success: true,
            message: `Enqueued ${messages.length} messages for campaign ${campaignId}`,
        });
    } catch (error) {
        console.error('Error enqueueing campaign messages:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});

// List all channels for a user
channelsRouter.get('/', async (req: Request, res: Response) => {
    try {
        const channels = await prisma.businessChannel.findMany({
            orderBy: { createdAt: 'desc' }
        });

        // Enrich with live session status
        const enrichedChannels = channels.map((channel: any) => {
            const session = sessionManager.getSession(channel.channelId);
            return {
                ...channel,
                liveStatus: session?.status || channel.status,
            };
        });

        res.json({ success: true, channels: enrichedChannels });
    } catch (error) {
        console.error('Error listing channels:', error);
        res.status(500).json({ success: false, error: (error as Error).message });
    }
});
