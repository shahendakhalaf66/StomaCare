/**
 * One-time migration: reads existing Baileys session files from disk
 * and inserts them into the whatsapp_auth_state MySQL table.
 *
 * Run once on the server after deploying the MySQL session store:
 *   pnpm --filter whatsapp-engine migrate:sessions
 */
import { promises as fs } from 'fs';
import path from 'path';
import prisma from '../lib/db.js';

const SESSIONS_DIR = './sessions';

async function migrateSessionsToMySQL() {
    let dirs: string[];
    try {
        dirs = await fs.readdir(SESSIONS_DIR);
    } catch {
        console.log('No sessions directory found — nothing to migrate.');
        process.exit(0);
    }

    let migrated = 0;
    let skipped = 0;

    for (const dir of dirs) {
        if (!dir.startsWith('session-')) continue;
        const channelId = dir.replace(/^session-/, '');
        const dirPath = path.join(SESSIONS_DIR, dir);

        let files: string[];
        try {
            files = await fs.readdir(dirPath);
        } catch {
            continue;
        }

        for (const file of files) {
            const keyName = file.replace(/\.json$/, '');
            const filePath = path.join(dirPath, file);
            try {
                const raw = await fs.readFile(filePath, 'utf8');
                const keyData = JSON.parse(raw);
                await prisma.whatsAppAuthState.upsert({
                    where: { channelId_keyName: { channelId, keyName } },
                    create: { channelId, keyName, keyData },
                    update: { keyData }
                });
                migrated++;
            } catch {
                skipped++;
            }
        }
        console.log(`✅ Migrated channel: ${channelId} (${files.length} keys)`);
    }

    console.log(`\nMigration complete: ${migrated} keys migrated, ${skipped} skipped.`);
    await prisma.$disconnect();
}

migrateSessionsToMySQL().catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
});
