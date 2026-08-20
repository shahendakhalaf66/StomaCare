import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

import { channelsRouter } from './routes/channels.js';
import { SessionManager } from './whatsapp/session-manager.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);

// Socket.IO for real-time updates
export const io = new Server(httpServer, {
    cors: {
        origin: process.env.WEB_URL || 'http://localhost:3000',
        methods: ['GET', 'POST'],
    },
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/channels', channelsRouter);


// Session Manager (singleton)
export const sessionManager = new SessionManager();

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('subscribe:channel', (channelId: string) => {
        socket.join(`channel:${channelId}`);
        console.log(`Socket ${socket.id} subscribed to channel:${channelId}`);

        // Send cached QR if available
        const session = sessionManager.getSession(channelId);
        if (session && session.qrCode && session.status === 'qr') {
            socket.emit('qr', {
                channelId: channelId,
                qrCode: session.qrCode,
            });
            console.log(`Sent cached QR to ${socket.id}`);
        }
    });

    // Legacy event name for backwards compatibility
    socket.on('subscribe', (channelId: string) => {
        socket.join(`channel:${channelId}`);
        console.log(`Socket ${socket.id} subscribed to channel:${channelId}`);

        // Send cached QR if available
        const session = sessionManager.getSession(channelId);
        if (session && session.qrCode && session.status === 'qr') {
            socket.emit('qr', {
                channelId: channelId,
                qrCode: session.qrCode,
            });
            console.log(`Sent cached QR to ${socket.id}`);
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, async () => {
    console.log(`🚀 WhatsApp Engine running on port ${PORT}`);
    console.log(`📡 Socket.IO ready for connections`);

    if (process.env.DATABASE_URL) {
        await sessionManager.restoreAllSessions();
    } else {
        console.log('📁 Standalone mode: skipping database session restore; use sessions/ for local auth state.');
    }
});

// Graceful shutdown handling
async function gracefulShutdown(signal: string) {
    console.log(`\n⚠️ Received ${signal}, shutting down gracefully...`);

    try {
        // Close all WhatsApp sessions properly
        const sessions = sessionManager.getAllSessions();
        console.log(`📱 Closing ${sessions.length} session(s)...`);

        for (const session of sessions) {
            try {
                await session.client.destroy();
                console.log(`✅ Closed session: ${session.id}`);
            } catch (err) {
                console.error(`❌ Error closing session ${session.id}:`, (err as Error).message);
            }
        }

        // Close HTTP server
        httpServer.close(() => {
            console.log('🛑 HTTP server closed');
            process.exit(0);
        });

        // Force exit after 10 seconds if graceful shutdown fails
        setTimeout(() => {
            console.log('⚠️ Forcing exit after timeout');
            process.exit(1);
        }, 10000);

    } catch (err) {
        console.error('❌ Error during shutdown:', (err as Error).message);
        process.exit(1);
    }
}

// Handle different shutdown signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err.message);
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
