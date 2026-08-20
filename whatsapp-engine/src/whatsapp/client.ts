import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion
    ,useMultiFileAuthState
} from '@whiskeysockets/baileys';
import { useMySQLAuthState } from './mysql-auth-state.js';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs/promises';

import { io } from '../index.js';
import prisma from '../lib/db.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import { writeFile, unlink, readFile } from 'fs/promises';
import dns from 'dns';

// Fix Node 18+ fetch failing on IPv6 for Meta domains
dns.setDefaultResultOrder('ipv4first');

const execFileAsync = promisify(execFile);

// Get ffmpeg path from ffmpeg-static
let ffmpegPath: string;
try {
    ffmpegPath = require('ffmpeg-static') as string;
    console.log('[ffmpeg] Using ffmpeg-static at:', ffmpegPath);
} catch {
    ffmpegPath = 'ffmpeg';
    console.log('[ffmpeg] Falling back to system ffmpeg');
}

async function convertToOggOpus(inputBuffer: Buffer): Promise<Buffer> {
    const tmpDir = os.tmpdir();
    const ts = Date.now();
    const inputPath = path.join(tmpDir, `wa_in_${ts}.webm`);
    const outputPath = path.join(tmpDir, `wa_out_${ts}.ogg`);

    try {
        await writeFile(inputPath, inputBuffer);
        console.log(`[ffmpeg] Converting ${inputBuffer.length} bytes WebM -> OGG Opus...`);
        await execFileAsync(ffmpegPath, [
            '-i', inputPath,
            '-vn',
            '-c:a', 'libopus',
            '-b:a', '64k',
            '-ar', '48000',
            '-ac', '1',
            '-application', 'voip',
            '-f', 'ogg',
            '-y',
            outputPath
        ]);
        const outputBuffer = await readFile(outputPath);
        console.log(`[ffmpeg] Conversion done: ${outputBuffer.length} bytes OGG`);
        return outputBuffer;
    } finally {
        await unlink(inputPath).catch(() => { });
        await unlink(outputPath).catch(() => { });
    }
}


export interface WhatsAppSession {
    id: string;
    client: any;
    status: 'initializing' | 'qr' | 'authenticated' | 'ready' | 'disconnected' | 'reconnecting' | 'failed' | 'banned';
    qrCode?: string;
    phoneNumber?: string;
    reconnectAttempts: number;
    lastHealthCheck?: Date;
}

const MAX_RECONNECT_DELAY_MS = 120_000; // Cap at 2 minutes
const BASE_RECONNECT_DELAY_MS = 3000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 60_000; // Check every 1 minute

export class WhatsAppClient {
    private session: WhatsAppSession;
    private healthCheckInterval?: NodeJS.Timeout;
    private watchdogInterval?: NodeJS.Timeout;
    private isReconnecting = false;
    private isDestroyed = false;
    private reconnectAttempts = 0;
    private unreadKeys: Map<string, any[]> = new Map();
    private sock: ReturnType<typeof makeWASocket> | null = null;
    private _clearState?: () => Promise<void>;

    constructor(sessionId: string) {
        this.session = {
            id: sessionId,
            client: null,
            status: 'initializing',
            reconnectAttempts: 0,
        };
        // Start the watchdog to revive any dead connections
        this.startWatchdog();
    }

    async initialize(): Promise<void> {
        await this.connect();
    }

    private async connect(): Promise<void> {
        const { id } = this.session;

        // For the standalone demo/VPS deployment, persist Baileys credentials on disk
        // unless a MySQL DATABASE_URL is explicitly configured.
        const auth = process.env.DATABASE_URL
            ? await useMySQLAuthState(id)
            : await useMultiFileAuthState(path.join(process.cwd(), 'sessions', id));
        const { state, saveCreds, clearState } = auth;
        this._clearState = clearState;
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }) as any,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30000,
        });

        this.sock = sock;
        this.session.client = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // QR Code event
            if (qr) {
                this.session.status = 'qr';
                this.session.qrCode = await QRCode.toDataURL(qr);

                io.to(`channel:${id}`).emit('qr', {
                    channelId: id,
                    qrCode: this.session.qrCode,
                });
                console.log(`[${id}] QR Code generated`);
            }

            if (connection === 'close') {
                const error = lastDisconnect?.error as Boom;
                const statusCode = error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                if (shouldReconnect && !this.isDestroyed) {
                    this.session.status = 'disconnected';
                    console.log(`[${id}] Connection closed (code: ${statusCode}). Will auto-reconnect...`);
                    io.to(`channel:${id}`).emit('disconnected', { reason: error?.message || 'Connection Lost' });

                    // Update DB to reflect disconnected temporarily
                    await prisma.businessChannel.updateMany({
                        where: { channelId: id },
                        data: { status: 'disconnected' }
                    });

                    this.attemptReconnect();
                } else {
                    console.log(`[${id}] Logged out or banned — stopping auto-reconnect.`);
                    this.session.status = 'banned';
                    this.reconnectAttempts = 0;
                    await prisma.businessChannel.updateMany({
                        where: { channelId: id },
                        data: { status: 'banned' }
                    });

                    this.stopHealthCheck();

                    // Clear MySQL auth state so next scan starts fresh
                    try {
                        await this._clearState?.();
                    } catch (e) { }

                    io.to(`channel:${id}`).emit('auth_failure', { message: 'Logged out' });
                }
            }

            if (connection === 'open') {
                this.session.status = 'ready';
                this.session.reconnectAttempts = 0;
                this.reconnectAttempts = 0;
                this.isReconnecting = false;

                const userJid = sock.user?.id || '';
                this.session.phoneNumber = userJid.split(':')[0].split('@')[0];

                console.log(`[${id}] Ready - ${this.session.phoneNumber}`);

                await prisma.businessChannel.updateMany({
                    where: { channelId: id },
                    data: {
                        status: 'connected',
                        phone: this.session.phoneNumber
                    }
                });

                io.to(`channel:${id}`).emit('ready', {
                    channelId: id,
                    phoneNumber: this.session.phoneNumber,
                });

                io.to(`channel:${id}`).emit('authenticated', { channelId: id });

                this.startHealthCheck();
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;

            for (const msg of m.messages) {
                if (!msg.message) continue;

                const key = msg.key as any;
                const originalJid = key.remoteJid || '';

                // Log ALL raw messages before any filtering to aid debugging
                console.log(`[${id}] Raw Incoming Message:\n`, JSON.stringify(msg, (key, value) => {
                    if (value && value.type === 'Buffer') return '[Buffer]';
                    return value;
                }, 2));

                // Handle LID addressing mode (WhatsApp's newer addressing).
                // remoteJidAlt contains the real phone JID, but it may be an "unknown proto field"
                // in older Baileys builds — accessible via toJSON() but not as a direct property.
                let remoteJid = key.remoteJidAlt || originalJid;
                if (remoteJid.endsWith('@lid')) {
                    try {
                        const keyJson: Record<string, any> = typeof key.toJSON === 'function' ? key.toJSON() : {};
                        if (keyJson.remoteJidAlt && !keyJson.remoteJidAlt.endsWith('@lid')) {
                            remoteJid = keyJson.remoteJidAlt;
                        }
                    } catch {}
                }
                // Last resort: try participant field (sometimes set for incoming LID messages)
                if (remoteJid.endsWith('@lid') && key.participant && !key.participant.endsWith('@lid')) {
                    remoteJid = key.participant;
                }
                if (remoteJid.endsWith('@lid')) {
                    console.log(`[${id}] Cannot resolve LID JID ${originalJid} — skipping message`);
                    continue;
                }

                // 🚨 Strict filter for Status/Stories and Broadcasts
                if (
                    originalJid === 'status@broadcast' ||
                    remoteJid === 'status@broadcast' ||
                    msg.broadcast ||
                    originalJid.includes('broadcast') ||
                    remoteJid.includes('broadcast') ||
                    originalJid.includes('@g.us') ||
                    remoteJid.includes('@g.us') ||
                    msg.message?.senderKeyDistributionMessage
                ) {
                    continue;
                }

                // Handle Incoming Reactions
                if (msg.message?.reactionMessage) {
                    const reactionMessage = msg.message.reactionMessage;
                    const reactedMessageId = reactionMessage.key?.id;
                    const reactionText = reactionMessage.text || '';

                    if (reactedMessageId) {
                        console.log(`[${id}] Incoming reaction from ${remoteJid}: ${reactionText} on ${reactedMessageId}`);
                        const businessWebhookUrl = process.env.BUSINESS_WEBHOOK_URL || process.env.NEXTAUTH_URL_BUSINESS || 'http://business:3000';
                        console.log(`[${id}] Forwarding reaction to webhook: ${businessWebhookUrl}/api/webhook/reaction`);
                        try {
                            const url = businessWebhookUrl.replace(/(^"|"$)/g, '');
                            const resp = await fetch(`${url}/api/webhook/reaction`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'x-engine-secret': process.env.ENGINE_WEBHOOK_SECRET?.replace(/(^"|"$)/g, '') || ''
                                },
                                body: JSON.stringify({
                                    waMessageId: reactedMessageId,
                                    reaction: reactionText,
                                    platform: 'whatsapp'
                                })
                            });
                            const respBody = await resp.text();
                            console.log(`[${id}] Reaction webhook response: ${resp.status} - ${respBody}`);
                        } catch (err) {
                            console.error(`[${id}] Incoming Reaction Webhook Failed:`, err);
                        }
                    }
                    continue; // Done handling reaction
                }

                const isFromMe = msg.key.fromMe || false;

                // Parse message correctly, accounting for Baileys objects like ExtendedTextMessage
                const messageObj = msg.message;
                let text = messageObj.conversation ||
                    messageObj.extendedTextMessage?.text ||
                    messageObj.ephemeralMessage?.message?.extendedTextMessage?.text ||
                    '';

                let mediaType: string | null = null;
                let mediaUrl: string | null = null;

                // Detect media messages. Priority check since media might also have caption text.
                if (messageObj.imageMessage) {
                    mediaType = 'image';
                    text = text || messageObj.imageMessage.caption || '📷 صورة';
                } else if (messageObj.audioMessage) {
                    mediaType = messageObj.audioMessage.ptt ? 'ptt' : 'audio';
                    text = text || (mediaType === 'ptt' ? '🎙️ رسالة صوتية' : '🎵 ملف صوتي');
                } else if (messageObj.videoMessage) {
                    mediaType = 'video';
                    text = text || messageObj.videoMessage.caption || '🎥 فيديو';
                } else if (messageObj.documentMessage) {
                    mediaType = 'document';
                    text = text || messageObj.documentMessage.fileName || messageObj.documentMessage.caption || '📄 مستند';
                } else if (messageObj.stickerMessage) {
                    mediaType = 'sticker';
                    text = '🏷️ ملصق';
                }

                // Download media if present
                if (mediaType && !isFromMe) {
                    try {
                        const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
                        const buffer = await downloadMediaMessage(
                            msg, 
                            'buffer', 
                            {},
                            {
                                logger: sock.logger,
                                reuploadRequest: sock.updateMediaMessage
                            }
                        );
                        if (buffer) {
                            const mimeType = messageObj.imageMessage?.mimetype ||
                                messageObj.audioMessage?.mimetype ||
                                messageObj.videoMessage?.mimetype ||
                                messageObj.documentMessage?.mimetype ||
                                'application/octet-stream';
                            mediaUrl = `data:${mimeType};base64,${(buffer as Buffer).toString('base64')}`;
                            console.log(`[${id}] Downloaded media: ${mediaType}, ${(buffer as Buffer).length} bytes`);
                        }
                    } catch (dlErr) {
                        console.error(`[${id}] Failed to download media:`, (dlErr as Error).message);
                    }
                }

                if (!text && !mediaType) continue;
                if (text === '🏷️ ملصق' && !mediaType) mediaType = 'sticker';

                // StomaCare demo mode: answer inbound text with the local RAG API.
                if (!isFromMe && text && process.env.STOMACARE_AUTO_REPLY === 'true') {
                    const ragUrl = (process.env.STOMACARE_RAG_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
                    try {
                        const ragResponse = await fetch(`${ragUrl}/v1/chat`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                ...(process.env.STOMACARE_RAG_SECRET ? { 'x-rag-secret': process.env.STOMACARE_RAG_SECRET } : {})
                            },
                            body: JSON.stringify({ query: text })
                        });
                        if (!ragResponse.ok) throw new Error(`RAG API returned ${ragResponse.status}`);
                        const ragData = await ragResponse.json() as { answer?: string };
                        if (ragData.answer) await this.sendMessage(remoteJid, ragData.answer);
                    } catch (error) {
                        console.error(`[${id}] StomaCare RAG reply failed:`, (error as Error).message);
                    }
                }

                const contactName = msg.pushName || '';
                const timestampSecs = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Date.now() / 1000;
                const timestampIso = new Date(timestampSecs * 1000).toISOString();

                const senderPhone = ((isFromMe ? this.session.phoneNumber : (remoteJid?.split('@')[0])) || '').split(':')[0];
                const targetPhone = ((isFromMe ? (remoteJid?.split('@')[0]) : this.session.phoneNumber) || '').split(':')[0];

                // Extract reply context
                const contextInfo = messageObj.extendedTextMessage?.contextInfo ||
                    messageObj.imageMessage?.contextInfo ||
                    messageObj.videoMessage?.contextInfo ||
                    messageObj.audioMessage?.contextInfo ||
                    messageObj.documentMessage?.contextInfo;

                const quotedId = contextInfo?.stanzaId;
                const quotedBody = contextInfo?.quotedMessage?.conversation ||
                    contextInfo?.quotedMessage?.extendedTextMessage?.text ||
                    (contextInfo?.quotedMessage?.imageMessage ? '📷 صورة' : null) ||
                    (contextInfo?.quotedMessage?.videoMessage ? '🎥 فيديو' : null) ||
                    (contextInfo?.quotedMessage?.audioMessage ? '🎙️ رسالة صوتية' : null) ||
                    (contextInfo?.quotedMessage?.documentMessage ? '📄 مستند' : null);

                // Replaced legacy direct db insert of messages since webhook handles this properly 
                
                const safeSenderPhone = senderPhone || '';
                if (!isFromMe && safeSenderPhone) {
                    if (!this.unreadKeys.has(safeSenderPhone)) {
                        this.unreadKeys.set(safeSenderPhone, []);
                    }
                    this.unreadKeys.get(safeSenderPhone)!.push(msg.key);
                }

                // Socket Emits for incoming ONLY
                if (!isFromMe) {
                    io.to(`channel:${id}`).emit('message:received', {
                        channelId: id,
                        message: {
                            from: senderPhone,
                            body: text,
                            timestamp: timestampSecs,
                            contactName,
                            mediaType,
                        },
                    });
                }

                // Forward to business platform webhook
                const businessWebhookUrl = process.env.BUSINESS_WEBHOOK_URL;
                if (businessWebhookUrl) {
                    try {
                        const url = businessWebhookUrl.replace(/(^"|"$)/g, '');
                        await fetch(`${url}/api/webhook/incoming`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'x-engine-secret': process.env.ENGINE_WEBHOOK_SECRET?.replace(/(^"|"$)/g, '') || ''
                            },
                            body: JSON.stringify({
                                channelId: id,
                                from: isFromMe ? this.session.phoneNumber : (remoteJid.split('@')[0].split(':')[0]),
                                to: isFromMe ? (remoteJid.split('@')[0].split(':')[0]) : this.session.phoneNumber,
                                body: text,
                                type: mediaType || 'text',
                                mediaUrl: mediaUrl,
                                isFromMe: isFromMe,
                                contactName: contactName,
                                timestamp: timestampSecs,
                                waMessageId: msg.key.id,
                                quotedId: quotedId,
                                quotedBody: quotedBody
                            }),
                        });
                    } catch (err) {
                        console.error(`[${id}] Business Webhook Failed:`, (err as Error).message);
                    }
                }
            }
        });

        sock.ev.on('messages.update', async (updates: any[]) => {
            for (const update of updates) {
                if (update.update.status) {
                    const statusVal = update.update.status;
                    let readableStatus = 'sent';
                    if (statusVal === 3) readableStatus = 'delivered';
                    if (statusVal === 4) readableStatus = 'read';

                    const businessWebhookUrl = process.env.BUSINESS_WEBHOOK_URL;
                    if (businessWebhookUrl) {
                        try {
                            const url = businessWebhookUrl.replace(/(^"|"$)/g, '');
                            await fetch(`${url}/api/webhook/status`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'x-engine-secret': process.env.ENGINE_WEBHOOK_SECRET?.replace(/(^"|"$)/g, '') || ''
                                },
                                body: JSON.stringify({
                                    waMessageId: update.key.id,
                                    status: readableStatus,
                                    platform: 'whatsapp'
                                })
                            });
                        } catch (err) { }
                    }
                }
            }
        });
    }

    private async attemptReconnect(): Promise<void> {
        if (this.isReconnecting) return;
        this.isReconnecting = true;

        this.reconnectAttempts++;
        this.session.reconnectAttempts = this.reconnectAttempts;
        this.session.status = 'reconnecting';

        // Exponential backoff, capped at MAX_RECONNECT_DELAY_MS
        const delay = Math.min(
            BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
            MAX_RECONNECT_DELAY_MS
        );
        console.log(`[${this.session.id}] Reconnect attempt #${this.reconnectAttempts} in ${Math.round(delay / 1000)}s...`);

        await new Promise(res => setTimeout(res, delay));

        try {
            this.stopHealthCheck();
            // Clean up old socket
            if (this.sock) {
                try { this.sock.ws.close(); } catch (e) { }
                this.sock = null;
            }
            await this.connect();
        } catch (err) {
            console.error(`[${this.session.id}] Reconnect failed:`, (err as Error).message);
            this.session.status = 'disconnected';
        } finally {
            // Always reset so we can try again later
            this.isReconnecting = false;
        }
    }

    private startHealthCheck(): void {
        this.stopHealthCheck();
        this.healthCheckInterval = setInterval(() => {
            if (this.session.status === 'ready' && this.sock?.ws?.isOpen) {
                this.session.lastHealthCheck = new Date();
            } else if (!this.isReconnecting) {
                console.log(`[${this.session.id}] Health check failed. WS Closed.`);
                this.attemptReconnect();
            }
        }, HEALTH_CHECK_INTERVAL_MS);
    }

    private stopHealthCheck(): void {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = undefined;
        }
    }

    /**
     * Watchdog: periodically checks if the session is alive.
     * If disconnected and not currently reconnecting, it triggers a reconnect.
     * This ensures we never stay dead permanently.
     */
    private startWatchdog(): void {
        this.watchdogInterval = setInterval(() => {
            const { status, id } = this.session;
            if ((status === 'disconnected' || status === 'failed') && !this.isReconnecting) {
                console.log(`[${id}] ⏰ Watchdog: dead session (${status}). Auto-reconnecting...`);
                this.attemptReconnect();
            } else if (status === 'banned') {
                console.log(`[${id}] ⏰ Watchdog: banned session — skipping auto-reconnect.`);
            }
        }, WATCHDOG_INTERVAL_MS);
    }

    async sendMessage(to: string | number, message: string, quotedId?: string): Promise<any> {
        if (!this.sock) throw new Error("Socket not initialized");

        let phoneStr = String(to).replace(/[^0-9]/g, '');

        // Normalize Egyptian local numbers
        if (phoneStr.startsWith('01') && phoneStr.length === 11) {
            phoneStr = `2${phoneStr}`; // 01... -> 201...
        } else if (phoneStr.startsWith('1') && phoneStr.length === 10) {
            phoneStr = `20${phoneStr}`; // 1... -> 201...
        }
        const jid = `${phoneStr}@s.whatsapp.net`;

        console.log(`[${this.session.id}] Sending message to JID: ${jid}. Content: ${message}, Quotted: ${quotedId}`);

        let options: any = {};
        if (quotedId) {
            // Find the quoted message in supabase to construct a basic quoted object
            // This is a bit of a hack since we don't have a reliable store in the engine for ALL messages
            // but we can try to fetch it from supabase or just pass a minimal object if Baileys allows

            // For now, let's try to construct a minimal WAMessage object that Baileys might accept
            // Baileys needs the full WAMessage to quote it properly usually.
            // If we don't have it, quoting might fail or look partial.
            options.quoted = {
                key: {
                    remoteJid: jid,
                    fromMe: false, // If we are replying to a customer
                    id: quotedId
                },
                message: {
                    conversation: "..." // Placeholder, Baileys usually needs the actual content for some visual things
                }
            };
        }

        const result = await this.sock.sendMessage(jid, { text: message }, options);
        console.log(`[${this.session.id}] Send message result:`, result);

        return result;
    }

    async sendReaction(to: string | number, waMessageId: string, emoji: string, isFromMe: boolean = false): Promise<void> {
        if (!this.sock) throw new Error("Socket not initialized");

        let phoneStr = String(to).replace(/[^0-9]/g, '');
        if (phoneStr.startsWith('01') && phoneStr.length === 11) {
            phoneStr = `2${phoneStr}`;
        } else if (phoneStr.startsWith('1') && phoneStr.length === 10) {
            phoneStr = `20${phoneStr}`;
        }
        const jid = `${phoneStr}@s.whatsapp.net`;

        console.log(`[${this.session.id}] Sending reaction to JID: ${jid}. Msg: ${waMessageId}, Emoji: ${emoji}`);

        const reactionMessage = {
            react: {
                text: emoji || "", // Empty string removes the reaction
                key: {
                    remoteJid: jid,
                    id: waMessageId,
                    fromMe: isFromMe,
                    participant: !isFromMe ? jid : undefined
                }
            }
        };

        const result = await this.sock.sendMessage(jid, reactionMessage);
        console.log(`[${this.session.id}] Send reaction result:`, result);
    }

    async deleteMessage(to: string | number, waMessageId: string, fromMe: boolean = true): Promise<void> {
        if (!this.sock) throw new Error("Socket not initialized");

        let phoneStr = String(to).replace(/[^0-9]/g, '');
        if (phoneStr.startsWith('01') && phoneStr.length === 11) {
            phoneStr = `2${phoneStr}`;
        } else if (phoneStr.startsWith('1') && phoneStr.length === 10) {
            phoneStr = `20${phoneStr}`;
        }
        const jid = `${phoneStr}@s.whatsapp.net`;

        console.log(`[${this.session.id}] Deleting message JID: ${jid}, msgId: ${waMessageId}, fromMe: ${fromMe}`);

        await this.sock.sendMessage(jid, {
            delete: {
                remoteJid: jid,
                id: waMessageId,
                fromMe,
                participant: !fromMe ? jid : undefined
            }
        });

        console.log(`[${this.session.id}] Message deleted successfully`);
    }

    async sendMedia(to: string | number, mediaBuffer: Buffer, mimeType: string, fileName: string, caption?: string, ptt?: boolean, quotedId?: string): Promise<void> {
        if (!this.sock) throw new Error("Socket not initialized");

        let phoneStr = String(to).replace(/[^0-9]/g, '');
        if (phoneStr.startsWith('01') && phoneStr.length === 11) {
            phoneStr = `2${phoneStr}`;
        } else if (phoneStr.startsWith('1') && phoneStr.length === 10) {
            phoneStr = `20${phoneStr}`;
        }
        const jid = `${phoneStr}@s.whatsapp.net`;

        let content: Record<string, unknown>;
        if (mimeType.startsWith('image/')) {
            content = { image: mediaBuffer, caption: caption || undefined, mimetype: mimeType };
        } else if (mimeType.startsWith('video/')) {
            content = { video: mediaBuffer, caption: caption || undefined, mimetype: mimeType };
        } else if (mimeType.startsWith('audio/')) {
            // Convert to OGG Opus for WhatsApp compatibility
            let audioBuffer = mediaBuffer;
            try {
                audioBuffer = await convertToOggOpus(mediaBuffer);
                console.log(`[${this.session.id}] Converted audio to OGG Opus (${mediaBuffer.length} -> ${audioBuffer.length} bytes)`);
            } catch (convErr) {
                console.error(`[${this.session.id}] Audio conversion failed, sending raw:`, convErr);
            }
            content = { audio: audioBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: ptt ?? false };
        } else {
            content = { document: mediaBuffer, mimetype: mimeType, fileName: fileName, caption: caption || undefined };
        }

        let options: any = {};
        if (quotedId) {
            options.quoted = {
                key: {
                    remoteJid: jid,
                    fromMe: false,
                    id: quotedId
                },
                message: {
                    conversation: "..."
                }
            };
        }

        console.log(`[${this.session.id}] Sending media to JID: ${jid}. Type: ${mimeType}, Quotted: ${quotedId}`);
        const result = await this.sock.sendMessage(jid, content as any, options);
        console.log(`[${this.session.id}] Send media result:`, result);
    }

    async destroy(): Promise<void> {
        this.isDestroyed = true;
        this.stopHealthCheck();
        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
            this.watchdogInterval = undefined;
        }
        if (this.sock) {
            try { await this.sock.logout(); } catch (e) { }
            try { this.sock.ws.close(); } catch (e) { }
            this.sock = null;
        }

        try {
            await this._clearState?.();
        } catch (e) { }
    }

    async markAsRead(phone: string): Promise<void> {
        const keys = this.unreadKeys.get(phone);
        if (keys && keys.length > 0 && this.sock) {
            try {
                await this.sock.readMessages(keys);
                this.unreadKeys.delete(phone);
                console.log(`[${this.session.id}] Marked ${keys.length} messages as read for ${phone}`);
            } catch (e) {
                console.error(`[${this.session.id}] Error marking as read for ${phone}:`, e);
            }
        }
    }

    getSession(): WhatsAppSession {
        return this.session;
    }

    isHealthy(): boolean {
        return this.session.status === 'ready' &&
            (!this.session.lastHealthCheck ||
                Date.now() - this.session.lastHealthCheck.getTime() < HEALTH_CHECK_INTERVAL_MS * 2);
    }
}
