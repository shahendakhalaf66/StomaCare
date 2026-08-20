import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const systemPrompt = `You are Clinical Clarity, a careful medical information assistant. You do not diagnose, prescribe, or replace a clinician. Be empathetic and concise. If symptoms may indicate an emergency (e.g. chest pain with shortness of breath, fainting, sweating, or spreading pain), clearly tell the person to seek emergency care now. Use supplied knowledge only as supporting context. State uncertainty and encourage appropriate professional care.`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Unauthorized')
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    const { data: { user } } = await client.auth.getUser()
    if (!user) throw new Error('Unauthorized')
    const { conversationId, message } = await req.json()
    if (!conversationId || typeof message !== 'string' || !message.trim()) throw new Error('A message is required')

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    await client.from('messages').insert({ conversation_id: conversationId, role: 'user', content: message.trim() })

    // When configured, the Python service owns Sentence Transformers + Chroma retrieval.
    // Gemini remains the current generation API and is never read from the new backend folder.
    const ragUrl = Deno.env.get('RAG_API_URL')?.replace(/\/$/, '')
    let content: string
    let sourceList: { title: string; url?: string; page?: number; section?: string; excerpt?: string }[]
    if (ragUrl) {
      const ragResponse = await fetch(`${ragUrl}/v1/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RAG-Secret': Deno.env.get('RAG_API_SECRET') ?? '' }, body: JSON.stringify({ query: message }) })
      if (!ragResponse.ok) throw new Error(`RAG service failed (${ragResponse.status})`)
      const ragJson = await ragResponse.json()
      content = ragJson.answer ?? 'I am unable to provide a response at the moment.'
      sourceList = ragJson.sources ?? []
    } else {
      const geminiKey = Deno.env.get('GEMINI_API_KEY')!
      const embeddingResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${geminiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'models/gemini-embedding-001', content: { parts: [{ text: message }] }, outputDimensionality: 768 }) })
      const embeddingJson = await embeddingResponse.json()
      const embedding = embeddingJson.embedding?.values
      const { data: sources = [] } = embedding ? await admin.rpc('match_knowledge_chunks', { query_embedding: embedding, match_count: 5 }) : { data: [] }
      const context = sources.map((s: { source_title: string; content: string; metadata: Record<string, unknown> }) => `Source: ${s.source_title}, page ${s.metadata?.page_number ?? 'unknown'}, section ${s.metadata?.header_path ?? '/'}\n${s.content}`).join('\n\n')
      const prompt = `${systemPrompt}\n\nReviewed knowledge:\n${context || 'No relevant reviewed source available.'}\n\nPatient message: ${message}\n\nGive a complete, practical answer in 2–4 short paragraphs. Do not begin with an apology. Response:`
      const chatResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${geminiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 2048 } }) })
      const chatJson = await chatResponse.json()
      content = chatJson.candidates?.[0]?.content?.parts?.[0]?.text ?? 'I am unable to provide a response at the moment.'
      sourceList = sources.map((s: { source_title: string; source_url?: string; content: string; metadata: { page_number?: number; header_path?: string } }) => ({ title: s.source_title, url: s.source_url, page: s.metadata?.page_number, section: s.metadata?.header_path, excerpt: s.content.replace(/\s+/g, ' ').slice(0, 220) }))
    }
    const { data, error } = await client.from('messages').insert({ conversation_id: conversationId, role: 'assistant', content, sources: sourceList }).select().single()
    if (error) throw error
    await client.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId)
    return Response.json({ message: data }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }
})
