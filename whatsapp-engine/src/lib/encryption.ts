import crypto from 'node:crypto'

const key = () => crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY || 'stomacare-demo-key').digest()
export function encrypt(value: string) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`
}
export function decrypt(value: string) {
  try {
    const [ivText, tagText, dataText] = value.split('.')
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivText, 'base64'))
    decipher.setAuthTag(Buffer.from(tagText, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64')), decipher.final()]).toString('utf8')
  } catch { return undefined }
}
export function hashForSearch(value: string) {
  return crypto.createHmac('sha256', process.env.HASH_SECRET || 'stomacare-demo-hash').update(value).digest('hex')
}
