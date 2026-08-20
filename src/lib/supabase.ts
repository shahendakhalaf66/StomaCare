import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = url && key ? createClient(url, key) : null
export const localRagApiUrl = (import.meta.env.VITE_RAG_API_URL ?? '').replace(/\/$/, '')
const localRagApiSecret = import.meta.env.VITE_RAG_API_SECRET ?? ''

export type ChatMessage = { id: string; role: 'assistant' | 'user'; content: string; created_at: string; sources?: { title: string; url?: string; page?: number; section?: string; excerpt?: string; score?: number; cosine_score?: number; meets_threshold?: boolean }[] }

export async function askClinicalAssistant(conversationId: string, message: string) {
  if (!supabase) return null
  const { data, error } = await supabase.functions.invoke('clinical-chat', {
    body: { conversationId, message }
  })
  if (error) throw error
  return data as { message: ChatMessage }
}

export async function askLocalRag(message: string) {
  if (!localRagApiUrl) return null
  const response = await fetch(`${localRagApiUrl}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(localRagApiSecret ? { 'X-RAG-Secret': localRagApiSecret } : {}) },
    body: JSON.stringify({ query: message })
  })
  if (!response.ok) throw new Error(`Local RAG API returned ${response.status}`)
  const data = await response.json() as { answer: string; sources?: ChatMessage['sources'] }
  return { message: { id: crypto.randomUUID(), role: 'assistant' as const, content: data.answer, created_at: new Date().toISOString(), sources: data.sources ?? [] } }
}
