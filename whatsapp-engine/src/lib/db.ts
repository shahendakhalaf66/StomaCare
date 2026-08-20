import { PrismaClient } from '@prisma/client'

import { encrypt, decrypt, hashForSearch } from './encryption';

const prismaClientSingleton = () => {
  const baseClient = new PrismaClient();

  const isAleEnabled = !!process.env.ENCRYPTION_KEY && !!process.env.HASH_SECRET;
  if (!isAleEnabled) {
      console.warn("[ALE] Encryption keys not found in .env, Application-Level Encryption is disabled.");
      return baseClient as any;
  }

  return baseClient.$extends({
      query: {
          contact: {
              async create({ args, query }) {
                  if (args.data.phone) {
                      args.data.phoneHash = hashForSearch(args.data.phone as string);
                      args.data.phone = encrypt(args.data.phone as string);
                  }
                  const result = await query(args);
                  if (result.phone) result.phone = decrypt(result.phone as string) || result.phone;
                  return result;
              },
              async findFirst({ args, query }) {
                  if (args.where?.phone) {
                      args.where.phoneHash = hashForSearch(args.where.phone as string);
                      delete args.where.phone;
                  }
                  const result = await query(args);
                  if (result && result.phone) result.phone = decrypt(result.phone as string) || result.phone;
                  return result;
              }
          },
          conversation: {
              async create({ args, query }) {
                  if (args.data.customerPhone) {
                      args.data.customerPhoneHash = hashForSearch(args.data.customerPhone as string);
                      args.data.customerPhone = encrypt(args.data.customerPhone as string);
                  }
                  const result = await query(args);
                  if (result.customerPhone) result.customerPhone = decrypt(result.customerPhone as string) || result.customerPhone;
                  return result;
              },
              async findFirst({ args, query }) {
                  if (args.where?.customerPhone) {
                      args.where.customerPhoneHash = hashForSearch(args.where.customerPhone as string);
                      delete args.where.customerPhone;
                  }
                  const result = await query(args);
                  if (result && result.customerPhone) result.customerPhone = decrypt(result.customerPhone as string) || result.customerPhone;
                  return result;
              }
          },
          inboxMessage: {
              async create({ args, query }) {
                  if (args.data.body) args.data.body = encrypt(args.data.body as string);
                  if (args.data.senderPhone) {
                      args.data.senderPhoneHash = hashForSearch(args.data.senderPhone as string);
                      args.data.senderPhone = encrypt(args.data.senderPhone as string);
                  }
                  const result = await query(args);
                  if (result.body) result.body = decrypt(result.body as string) || result.body;
                  if (result.senderPhone) result.senderPhone = decrypt(result.senderPhone as string) || result.senderPhone;
                  return result;
              },
              async findMany({ args, query }) {
                  const results = await query(args);
                  return results.map(msg => ({
                      ...msg,
                      body: msg.body ? (decrypt(msg.body as string) || msg.body) : msg.body,
                      senderPhone: msg.senderPhone ? (decrypt(msg.senderPhone as string) || msg.senderPhone) : msg.senderPhone
                  }));
              }
          }
      }
  }) as any;
}

declare global {
  var prismaGlobal: undefined | ReturnType<typeof prismaClientSingleton>
}

const prisma = globalThis.prismaGlobal ?? prismaClientSingleton()

export default prisma

if (process.env.NODE_ENV !== 'production') globalThis.prismaGlobal = prisma
