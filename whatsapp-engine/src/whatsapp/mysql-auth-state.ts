import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';
import { initAuthCreds, proto, BufferJSON } from '@whiskeysockets/baileys';
import prisma from '../lib/db.js';

type SignalDataSet = { [T in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[T] } };

/**
 * Baileys auth state backed by MySQL.
 * Replaces useMultiFileAuthState (filesystem) with DB storage so sessions
 * survive container restarts, volume loss, and server migrations.
 *
 * Each "file" Baileys would write to disk becomes one row in whatsapp_auth_state:
 *   channelId + keyName → keyData (JSON blob)
 */
export async function useMySQLAuthState(channelId: string): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    clearState: () => Promise<void>;
}> {
    async function read(keyName: string): Promise<any | null> {
        const row = await prisma.whatsAppAuthState.findUnique({
            where: { channelId_keyName: { channelId, keyName } },
            select: { keyData: true }
        });
        if (!row) return null;
        // Re-parse through BufferJSON reviver to reconstruct Buffer/Uint8Array instances
        return JSON.parse(JSON.stringify(row.keyData), BufferJSON.reviver);
    }

    async function write(keyName: string, data: any): Promise<void> {
        // Serialize with BufferJSON replacer so Buffer objects survive the JSON round-trip
        const keyData = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await prisma.whatsAppAuthState.upsert({
            where: { channelId_keyName: { channelId, keyName } },
            create: { channelId, keyName, keyData },
            update: { keyData }
        });
    }

    async function remove(keyName: string): Promise<void> {
        await prisma.whatsAppAuthState.deleteMany({
            where: { channelId, keyName }
        }).catch(() => {});
    }

    // Load or initialise credentials
    const credsRaw = await read('creds');
    const creds: AuthenticationCreds = credsRaw
        ? (credsRaw as AuthenticationCreds)
        : initAuthCreds();

    const state: AuthenticationState = {
        creds,
        keys: {
            get: async (type, ids) => {
                const result: { [id: string]: SignalDataTypeMap[typeof type] } = {};
                await Promise.all(
                    ids.map(async (id) => {
                        const keyName = `${type}-${id}`;
                        const data = await read(keyName);
                        if (data) {
                            // pre-key and sender-key-memory need Buffer reconstruction
                            result[id] = type === 'app-state-sync-key'
                                ? proto.Message.AppStateSyncKeyData.fromObject(data)
                                : data;
                        }
                    })
                );
                return result;
            },
            set: async (data: SignalDataSet) => {
                const tasks: Promise<void>[] = [];
                for (const [type, entries] of Object.entries(data)) {
                    for (const [id, value] of Object.entries(entries ?? {})) {
                        const keyName = `${type}-${id}`;
                        tasks.push(value ? write(keyName, value) : remove(keyName));
                    }
                }
                await Promise.all(tasks);
            }
        }
    };

    return {
        state,
        saveCreds: () => write('creds', state.creds),
        clearState: async () => {
            await prisma.whatsAppAuthState.deleteMany({ where: { channelId } });
        }
    };
}
