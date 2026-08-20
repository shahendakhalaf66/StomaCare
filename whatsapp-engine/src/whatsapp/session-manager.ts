import { WhatsAppClient, WhatsAppSession } from './client.js';
import prisma from '../lib/db.js';

export class SessionManager {
    private sessions: Map<string, WhatsAppClient> = new Map();

    async createSession(sessionId: string): Promise<WhatsAppSession> {
        // Check if session already exists
        if (this.sessions.has(sessionId)) {
            const existing = this.sessions.get(sessionId)!;
            return existing.getSession();
        }

        // Create new client
        const client = new WhatsAppClient(sessionId);
        this.sessions.set(sessionId, client);

        // Initialize (will trigger QR code or auto-auth from saved session)
        await client.initialize();

        return client.getSession();
    }

    getSession(sessionId: string): WhatsAppSession | null {
        const client = this.sessions.get(sessionId);
        return client ? client.getSession() : null;
    }

    getClient(sessionId: string): WhatsAppClient | null {
        return this.sessions.get(sessionId) || null;
    }

    async destroySession(sessionId: string): Promise<boolean> {
        const client = this.sessions.get(sessionId);
        if (!client) return false;

        await client.destroy();
        this.sessions.delete(sessionId);
        return true;
    }

    getAllSessions(): WhatsAppSession[] {
        return Array.from(this.sessions.values()).map(c => c.getSession());
    }

    async sendMessage(sessionId: string, to: string, message: string): Promise<void> {
        const client = this.sessions.get(sessionId);
        if (!client) {
            throw new Error(`Session ${sessionId} not found`);
        }

        await client.sendMessage(to, message);
    }

    /**
     * Restore all connected sessions from the database on startup
     * Only restores channels that have a phone_number (were actually authenticated)
     */
    async restoreAllSessions(): Promise<void> {
        console.log('🔄 Checking for sessions to restore...');

        let channels;
        let retries = 0;
        const maxRetries = 15;
        
        while (retries < maxRetries) {
            try {
                // Get all channels that were connected, disconnected, or failed AND have a phone number
                // (channels without phone_number never completed authentication)
                channels = await prisma.businessChannel.findMany({
                    where: {
                        platform: 'whatsapp',
                        status: { in: ['connected', 'disconnected', 'failed', 'ready'] },
                        phone: { not: null }
                    }
                });

                // qr + phone = was banned before 'banned' status existed → mark banned
                await prisma.businessChannel.updateMany({
                    where: { platform: 'whatsapp', status: 'qr', phone: { not: null } },
                    data: { status: 'banned' }
                });

                // qr + no phone = never completed auth, stuck in limbo → reset to disconnected
                await prisma.businessChannel.updateMany({
                    where: { platform: 'whatsapp', status: 'qr', phone: null },
                    data: { status: 'disconnected' }
                });

                break; // Success, exit retry loop
            } catch (err) {
                retries++;
                console.log(`⏳ Database not ready. Retrying in 5s... (${retries}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

        if (!channels) {
            console.error('❌ Could not connect to database after multiple retries. Aborting session restore.');
            return;
        }

        try {
            if (channels.length === 0) {
                console.log('📭 No connected channels to restore');
                return;
            }

            console.log(`📱 Found ${channels.length} channel(s) to restore`);

            // Restore each session
            for (const channel of channels) {
                try {
                    // Only restore if auth state exists in MySQL — no rows means no saved auth
                    const authRowCount = await prisma.whatsAppAuthState.count({
                        where: { channelId: channel.channelId }
                    });

                    if (authRowCount === 0) {
                        console.log(`⚠️ Skipping ${channel.name} — no auth state in DB, marking disconnected`);
                        await prisma.businessChannel.updateMany({
                            where: { channelId: channel.channelId },
                            data: { status: 'disconnected' }
                        });
                        continue;
                    }

                    console.log(`🔗 Restoring session: ${channel.name} (${channel.id})`);

                    // Create client (will auto-authenticate from saved session)
                    const client = new WhatsAppClient(channel.channelId);
                    this.sessions.set(channel.channelId, client);

                    // Initialize without awaiting to speed up startup
                    client.initialize().then(() => {
                        const session = client.getSession();
                        if (session.status === 'ready') {
                            console.log(`✅ Session restored: ${channel.name} (${session.phoneNumber})`);
                        }
                    }).catch((err) => {
                        console.error(`❌ Failed to restore ${channel.name}:`, err.message);
                        // Update status in database
                        prisma.businessChannel.updateMany({
                            where: { channelId: channel.channelId },
                            data: { status: 'disconnected' }
                        }).catch(console.error);
                    });

                } catch (err) {
                    console.error(`❌ Error restoring channel ${channel.id}:`, (err as Error).message);
                }
            }

        } catch (err) {
            console.error('❌ Error in restoreAllSessions:', (err as Error).message);
        }
    }
}
