import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Activity, ArrowRight, Bot, ChevronRight, Eye, EyeOff, HeartPulse, History, LockKeyhole, Mail, Menu, MessageCircle, Mic, Moon, Paperclip, Plus, Send, ShieldCheck, Sparkles, Sun, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { askClinicalAssistant, askLocalRag, localRagApiUrl, supabase, type ChatMessage } from './lib/supabase'

type SpeechRecognitionInstance = { lang: string; continuous: boolean; interimResults: boolean; start: () => void; stop: () => void; onresult: ((event: any) => void) | null; onend: (() => void) | null; onerror: ((event: any) => void) | null }
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance

const seed: ChatMessage[] = [
  { id: '1', role: 'assistant', content: "Hello, I'm StomaCare, your medical information assistant. How can I help you today?", created_at: '9:41 AM' },
  { id: '2', role: 'user', content: 'I have been experiencing heartburn and acid reflux after meals.', created_at: '9:43 AM' },
  { id: '3', role: 'assistant', content: 'I understand. Heartburn after meals can be associated with acid reflux. I can help you review relevant clinical guidance and ask a few questions to clarify your symptoms.', created_at: '9:44 AM' }
]

const nav = [{ icon: MessageCircle, label: 'Current chat' }, { icon: History, label: 'History' }]
const whatsappEngineUrl = (import.meta.env.VITE_WHATSAPP_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '')

export default function App() {
  const [authenticated, setAuthenticated] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [showLanding, setShowLanding] = useState(true)
  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => { setAuthenticated(Boolean(data.session)); setUserEmail(data.session?.user.email ?? '') })
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => { setAuthenticated(Boolean(session)); setUserEmail(session?.user.email ?? '') })
    return () => subscription.subscription.unsubscribe()
  }, [])
  if (showLanding) return <Landing onStart={() => setShowLanding(false)} />
  const adminEmails = (import.meta.env.VITE_ADMIN_EMAILS ?? '').split(',').map((email: string) => email.trim().toLowerCase()).filter(Boolean)
  const isAdmin = Boolean(userEmail && adminEmails.includes(userEmail.toLowerCase()))
  return authenticated ? <ChatApp isAdmin={isAdmin} onSignOut={() => { setAuthenticated(false); setUserEmail(''); supabase?.auth.signOut() }} /> : <AuthPage onDemo={() => { setAuthenticated(true); setUserEmail('') }} />
}

function Landing({ onStart }: { onStart: () => void }) { return <main className="landing"><nav className="landing-nav"><img src="/stomalogo.png" alt="StomaCare"/><div className="landing-nav-links"><span className="landing-scroll-hint">Scroll to explore</span><button onClick={onStart}>Sign in <ArrowRight size={16}/></button></div></nav><section className="landing-hero"><div className="hero-copy"><h1>Better questions.<br/><em>Clearer care.</em></h1><p>StomaCare helps you turn trusted medical guidance into thoughtful, more informed health conversations.</p><div className="hero-cta"><button onClick={onStart}>Start a conversation <ArrowRight size={19}/></button><span className="scroll-cue">↓ Keep scrolling</span></div><div className="hero-trust"><span><ShieldCheck size={18}/> Private by design</span><span><HeartPulse size={18}/> Built for care</span></div></div><div className="hero-art" aria-label="StomaCare medical assistant illustration"><div className="art-glow"/><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="art-card card-top"><span className="pulse-dot"/><div><small>GUIDANCE READY</small><strong>Clinical insight</strong></div></div><div className="art-core"><div className="core-ring"/><Bot size={78}/><span className="core-plus">+</span></div><div className="art-card card-bottom"><div className="mini-avatar"><HeartPulse size={19}/></div><div><small>STOMACARE AI</small><strong>How can I help?</strong></div><span className="typing-mini"><i/><i/><i/></span></div><div className="art-pill"><Activity size={17}/> Live, cited answers</div></div></section><section className="landing-strip" id="how"><div><span>01</span><strong>Ask naturally</strong><p>Describe your question in your own words.</p></div><div><span>02</span><strong>Grounded guidance</strong><p>We retrieve relevant clinical references.</p></div><div><span>03</span><strong>Review sources</strong><p>See pages and excerpts behind the answer.</p></div></section><section className="feature-section" id="features"><div className="feature-heading"><p className="eyebrow">BUILT FOR CLARITY</p><h2>Thoughtful support,<br/>at every step.</h2><p>Designed to make health guidance easier to understand and easier to discuss with your care team.</p></div><div className="feature-grid"><article><span className="feature-icon"><MessageCircle size={23}/></span><h3>Natural conversation</h3><p>Ask follow-up questions as your concerns evolve — no clinical jargon required.</p></article><article><span className="feature-icon teal"><ShieldCheck size={23}/></span><h3>Grounded in sources</h3><p>Explore page references and excerpts from the medical guidance used in an answer.</p></article><article><span className="feature-icon purple"><HeartPulse size={23}/></span><h3>Care-aware guardrails</h3><p>Clear guidance around urgent symptoms and when to seek professional care.</p></article></div></section><section className="landing-safe" id="safe"><ShieldCheck size={31}/><div><p className="eyebrow">DESIGNED FOR TRUST</p><h2>Information to support care — not replace it.</h2></div><p>StomaCare flags emergencies, encourages professional consultation, and shows where guidance came from.</p></section><section className="landing-cta"><div><p className="eyebrow">START WITH CLARITY</p><h2>Your next health question deserves a thoughtful answer.</h2><p>Sign in to start a secure, source-aware conversation.</p><button onClick={onStart}>Get started <ArrowRight size={18}/></button></div><div className="cta-orb"><Sparkles size={45}/></div></section><footer className="landing-footer"><img src="/stomalogo.png" alt="StomaCare"/><p>Better questions. Clearer care.</p><div><span>© 2026 StomaCare</span></div></footer></main> }

function ChatApp({ onSignOut, isAdmin }: { onSignOut: () => void; isAdmin: boolean }) {
  const [resolvedAdmin, setResolvedAdmin] = useState(isAdmin)
  const [messages, setMessages] = useState(seed)
  const [draft, setDraft] = useState('')
  const [listening, setListening] = useState(false)
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('stomacare-theme') === 'dark')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'chat' | 'history'>('chat')
  const [conversations, setConversations] = useState<{ id: string; title: string; updated_at: string }[]>([])
  const [whatsappOpen, setWhatsappOpen] = useState(false)
  const [whatsappStatus, setWhatsappStatus] = useState<'disconnected' | 'connecting' | 'qr' | 'ready' | 'error'>('disconnected')
  const [whatsappChannelId, setWhatsappChannelId] = useState<string | null>(null)
  const [whatsappQr, setWhatsappQr] = useState<string | null>(null)
  const [whatsappError, setWhatsappError] = useState('')
  const whatsappPollRef = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const speechRef = useRef<SpeechRecognitionInstance | null>(null)
  useEffect(() => {
    if (!supabase) return
    supabase.auth.getUser().then(({ data }) => {
      const allowed = (import.meta.env.VITE_ADMIN_EMAILS ?? '').split(',').map((email: string) => email.trim().toLowerCase()).filter(Boolean)
      setResolvedAdmin(Boolean(data.user?.email && allowed.includes(data.user.email.toLowerCase())))
    })
  }, [])

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }) }, [messages, busy])
  useEffect(() => { localStorage.setItem('stomacare-theme', darkMode ? 'dark' : 'light') }, [darkMode])
  function toggleVoiceInput() {
    if (listening) { speechRef.current?.stop(); setListening(false); return }
    const SpeechRecognition = (window as Window & { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor }).SpeechRecognition ?? (window as Window & { webkitSpeechRecognition?: SpeechRecognitionConstructor }).webkitSpeechRecognition
    if (!SpeechRecognition) { setMessages(current => [...current, { id: crypto.randomUUID(), role: 'assistant', content: 'Voice input is not supported in this browser. Please use Chrome or Edge.', created_at: 'Now' }]); return }
    const recognition = new SpeechRecognition()
    recognition.lang = 'ar-EG'; recognition.continuous = true; recognition.interimResults = true
    const draftBeforeListening = draft.trim()
    recognition.onresult = (event: any) => {
      let transcript = ''
      for (let index = 0; index < event.results.length; index += 1) transcript += event.results[index][0].transcript
      if (transcript.trim()) setDraft(`${draftBeforeListening} ${transcript}`.trim())
    }
    recognition.onerror = () => { setListening(false); speechRef.current = null }
    recognition.onend = () => { setListening(false); speechRef.current = null }
    speechRef.current = recognition; setListening(true); recognition.start()
  }
  function stopWhatsAppPolling() { if (whatsappPollRef.current !== null) { window.clearInterval(whatsappPollRef.current); whatsappPollRef.current = null } }
  async function pollWhatsAppStatus(id: string) {
    try {
      const response = await fetch(`${whatsappEngineUrl}/channels/${id}/status`)
      if (!response.ok) throw new Error('WhatsApp engine is unavailable.')
      const payload = await response.json()
      const channel = payload.channel ?? payload
      const status = String(channel.status ?? '').toLowerCase()
      setWhatsappQr(channel.qrCode ?? channel.qr ?? null)
      if (['ready', 'connected', 'open'].includes(status)) { setWhatsappStatus('ready'); stopWhatsAppPolling() }
      else if (status === 'qr' || channel.qrCode || channel.qr) setWhatsappStatus('qr')
      else if (['failed', 'banned', 'disconnected'].includes(status)) { setWhatsappStatus(status === 'disconnected' ? 'disconnected' : 'error'); stopWhatsAppPolling() }
      else setWhatsappStatus('connecting')
    } catch (error) { setWhatsappError(error instanceof Error ? error.message : 'Could not read WhatsApp connection status.'); setWhatsappStatus('error') }
  }
  function startWhatsAppPolling(id: string) { stopWhatsAppPolling(); void pollWhatsAppStatus(id); whatsappPollRef.current = window.setInterval(() => void pollWhatsAppStatus(id), 2000) }
  async function connectWhatsApp() {
    setWhatsappError(''); setWhatsappQr(null); setWhatsappStatus('connecting')
    try {
      const response = await fetch(`${whatsappEngineUrl}/channels/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      if (!response.ok) throw new Error('Could not start the WhatsApp session.')
      const payload = await response.json(); const id = payload.channel?.id ?? payload.id
      if (!id) throw new Error('The WhatsApp engine did not return a channel id.')
      setWhatsappChannelId(id); setWhatsappOpen(true); startWhatsAppPolling(id)
    } catch (error) { setWhatsappStatus('error'); setWhatsappError(error instanceof Error ? error.message : 'Could not connect WhatsApp.') }
  }
  async function disconnectWhatsApp() {
    if (whatsappChannelId) await fetch(`${whatsappEngineUrl}/channels/${whatsappChannelId}`, { method: 'DELETE' }).catch(() => undefined)
    stopWhatsAppPolling(); setWhatsappChannelId(null); setWhatsappQr(null); setWhatsappStatus('disconnected'); setWhatsappError('')
  }
  useEffect(() => () => stopWhatsAppPolling(), [])
  function startNewConsultation() {
    if (busy) return
    setConversationId(null)
    setDraft('')
    setMessages([{ id: crypto.randomUUID(), role: 'assistant', content: "Hello, I'm StomaCare. What would you like help with today?", created_at: 'Now' }])
    setActiveTab('chat')
    setMenuOpen(false)
  }
  async function showHistory() {
    setActiveTab('history'); setMenuOpen(false)
    if (!supabase) return
    const { data } = await supabase.from('conversations').select('id,title,updated_at').order('updated_at', { ascending: false })
    setConversations(data ?? [])
  }
  async function openConversation(id: string) {
    if (!supabase) return
    const { data, error } = await supabase.from('messages').select('id,role,content,created_at,sources').eq('conversation_id', id).in('role', ['user', 'assistant']).order('created_at')
    if (error || !data) return
    setMessages(data as ChatMessage[]); setConversationId(id); setActiveTab('chat')
  }

  async function send() {
    const text = draft.trim()
    if (!text || busy) return
    const message: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text, created_at: 'Now' }
    setMessages(current => [...current, message]); setDraft(''); setBusy(true)
    try {
      // During local RAG development, bypass Supabase and call FastAPI directly.
      if (localRagApiUrl) {
        const response = await askLocalRag(text)
        if (response?.message) setMessages(current => [...current, response.message])
        return
      }
      // Use a real Supabase Edge Function when environment variables are configured.
      let activeConversationId = conversationId
      if (supabase && !activeConversationId) {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) throw new Error('Your session has expired. Please sign in again.')
        const { data, error } = await supabase.from('conversations').insert({ user_id: user.id, title: text.slice(0, 80) }).select('id').single()
        if (error) throw error
        activeConversationId = data.id
        setConversationId(data.id)
      }
      const response = await askClinicalAssistant(activeConversationId ?? 'demo-conversation', text)
      if (response?.message) setMessages(current => [...current, response.message])
      else setMessages(current => [...current, { id: crypto.randomUUID(), role: 'assistant', created_at: 'Now', content: 'Your Supabase connection is not configured yet. Add the values in .env to start using Gemini and your clinical knowledge base.' }])
    } catch {
      setMessages(current => [...current, { id: crypto.randomUUID(), role: 'assistant', created_at: 'Now', content: 'I could not reach the secure clinical service. Please try again in a moment.' }])
    } finally { setBusy(false) }
  }

  return <div className={`app-shell ${darkMode ? 'dark' : ''}`}>
    <aside className={`sidebar ${menuOpen ? 'is-open' : ''}`}>
      <div className="brand"><img src="/stomalogo.png" alt="StomaCare"/><button className="mobile-close" onClick={() => setMenuOpen(false)} aria-label="Close menu"><X/></button></div>
      <button className="new-chat" onClick={startNewConsultation}><Plus size={19}/> New consultation</button>
      <nav>{nav.map(({ icon: Icon, label }) => <button key={label} onClick={() => label === 'History' ? showHistory() : setActiveTab('chat')} className={(label === 'History' ? activeTab === 'history' : activeTab === 'chat') ? 'active' : ''}><Icon size={19}/>{label}<ChevronRight className="chevron" size={16}/></button>)}</nav>
      <div className="sidebar-foot"><button onClick={onSignOut}>Sign out</button></div>
    </aside>
    {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)}/>} 
    <main>
      <div className="dashboard-ambient" aria-hidden="true"><div className="ambient-orbit orbit-a"/><div className="ambient-orbit orbit-b"/><div className="ambient-core"><img src="/stomach-illustration.png" alt=""/><span/></div><i className="ambient-dot dot-a"/><i className="ambient-dot dot-b"/></div>
      <header><div className="header-title"><button className="menu-button" onClick={() => setMenuOpen(true)} aria-label="Open menu"><Menu/></button><div><span className="eyebrow">CARE ASSISTANT</span><h1>Health conversation</h1></div></div><div className="header-actions">{resolvedAdmin && <button className="whatsapp-connect" onClick={() => setWhatsappOpen(true)}><MessageCircle size={18}/><span>{whatsappStatus === 'ready' ? 'WhatsApp connected' : 'Connect WhatsApp'}</span></button>}<button className="theme-toggle" onClick={() => setDarkMode(value => !value)} aria-label={darkMode ? 'Use light theme' : 'Use dark theme'}>{darkMode ? <Sun size={19}/> : <Moon size={19}/>}</button></div></header>
      <section className="content">
        <div className="chat-column">
          <div className="safety-banner"><ShieldCheck size={18}/><span>Your health information is protected. This assistant provides information, not a diagnosis.</span></div>
          {activeTab === 'history' ? <HistoryPanel conversations={conversations} onOpen={openConversation} onNew={startNewConsultation}/> : <><div className="messages" ref={listRef}>{messages.map(message => <Message key={message.id} {...message}/>)}{busy && <div className="typing"><Bot size={18}/><div><strong>StomaCare AI</strong><small>Searching medical guidelines…</small></div><span></span><span></span><span></span></div>}</div>{messages.length === seed.length && <div className="quick-actions"><span>How can I help?</span><button onClick={() => setDraft('What are the symptoms of heartburn and GERD?')}>🔥 Heartburn</button><button onClick={() => setDraft('What treatment options are recommended for H. pylori?')}>🦠 H. pylori</button><button onClick={() => setDraft('What foods should I avoid with acid reflux?')}>🍽️ Diet &amp; GERD</button><button onClick={() => setDraft('What medicines are used for reflux?')}>💊 Medications</button></div>}<div className="composer-wrap"><div className="composer"><button aria-label="Attach a document"><Paperclip size={20}/></button><textarea value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} placeholder={listening ? 'Listening… speak in Arabic' : 'Describe your symptoms or ask a health question…'} rows={1}/><button className={listening ? 'voice-listening' : ''} onClick={toggleVoiceInput} aria-label={listening ? 'Stop voice input' : 'Start voice input'} title={listening ? 'Stop voice input' : 'Voice input'}><Mic size={20}/></button><button className="send" onClick={send} disabled={!draft.trim() || busy} aria-label="Send message"><Send size={18}/></button></div><p>For emergencies or severe symptoms, call your local emergency number immediately.</p></div></>}
        </div>
      </section>
    </main>
    {resolvedAdmin && whatsappOpen && <div className="whatsapp-modal-backdrop" onClick={() => setWhatsappOpen(false)}><section className="whatsapp-modal" onClick={event => event.stopPropagation()}><div className="whatsapp-modal-head"><div><span className="eyebrow">WHATSAPP CHANNEL</span><h2>Connect WhatsApp</h2></div><button className="whatsapp-modal-close" onClick={() => setWhatsappOpen(false)} aria-label="Close"><X size={20}/></button></div>{whatsappStatus === 'ready' ? <div className="whatsapp-status ready">WhatsApp is connected. Incoming messages can be answered by StomaCare.</div> : whatsappQr ? <><p className="whatsapp-help">Open WhatsApp → Linked devices → Link a device, then scan this QR code.</p><img className="whatsapp-qr" src={whatsappQr} alt="WhatsApp pairing QR code"/></> : <div className="whatsapp-status">{whatsappStatus === 'connecting' ? 'Starting a secure WhatsApp session…' : 'Click connect to generate a pairing QR code.'}</div>}{whatsappError && <p className="auth-error">{whatsappError}</p>}<div className="whatsapp-modal-actions">{whatsappStatus === 'ready' ? <button className="whatsapp-muted" onClick={disconnectWhatsApp}>Disconnect</button> : <button className="whatsapp-primary" onClick={connectWhatsApp} disabled={whatsappStatus === 'connecting'}>{whatsappStatus === 'connecting' ? 'Connecting…' : 'Generate QR code'}</button>}</div></section></div>}
  </div>
}

type AuthMode = 'sign-in' | 'sign-up' | 'reset'
function AuthPage({ onDemo }: { onDemo: () => void }) {
  const [mode, setMode] = useState<AuthMode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const copy = mode === 'sign-in' ? ['Welcome back', 'Sign in to continue your health conversation.'] : mode === 'sign-up' ? ['Create your account', 'Start your secure health conversation today.'] : ['Reset your password', 'We’ll send you a secure password-reset link.']
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice(''); setLoading(true)
    try {
      if (!supabase) { onDemo(); return }
      if (mode === 'sign-in') { const { error } = await supabase.auth.signInWithPassword({ email, password }); if (error) throw error }
      if (mode === 'sign-up') { if (password.length < 8) throw new Error('Use a password with at least 8 characters.'); const { error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } }); if (error) throw error; setNotice('Check your inbox to confirm your email, then sign in.') }
      if (mode === 'reset') { const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin }); if (error) throw error; setNotice('Password-reset link sent. Check your inbox.') }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Something went wrong. Please try again.') } finally { setLoading(false) }
  }
  function changeMode(next: AuthMode) { setMode(next); setError(''); setNotice(''); setPassword('') }
  return <div className="auth-page"><section className="auth-hero"><div className="auth-brand"><img src="/stomalogo.png" alt="StomaCare"/></div><div className="hero-copy"><div className="hero-icon"><ShieldCheck size={30}/></div><p className="eyebrow">SECURE, PERSONALIZED CARE</p><h1>Clarity for every health question.</h1><p>Have more informed conversations with trustworthy information at your fingertips.</p></div><div className="hero-points"><span>✓ Private by design</span><span>✓ Built for better conversations</span></div></section><section className="auth-form-area"><div className="auth-card"><div className="mobile-brand"><img src="/stomalogo.png" alt="StomaCare"/></div><p className="eyebrow">YOUR SECURE SPACE</p><h2>{copy[0]}</h2><p className="auth-subtitle">{copy[1]}</p>{!supabase && <button className="demo-notice" onClick={onDemo}>Demo mode is active — enter the preview <ChevronRight size={16}/></button>}<form onSubmit={submit}><label>Email address<div className="field"><Mail size={18}/><input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required autoComplete="email"/></div></label>{mode !== 'reset' && <label>Password<div className="field"><LockKeyhole size={18}/><input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required minLength={8} autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}/><button type="button" onClick={() => setShowPassword(!showPassword)} aria-label="Show password">{showPassword ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div></label>}{mode === 'sign-in' && <button className="text-link forgot" type="button" onClick={() => changeMode('reset')}>Forgot password?</button>}{error && <p className="auth-error">{error}</p>}{notice && <p className="auth-notice">{notice}</p>}<button className="auth-submit" disabled={loading}>{loading ? 'Please wait…' : mode === 'sign-in' ? 'Sign in securely' : mode === 'sign-up' ? 'Create account' : 'Send reset link'} <ChevronRight size={18}/></button></form><p className="auth-switch">{mode === 'sign-in' ? <>New to StomaCare? <button onClick={() => changeMode('sign-up')}>Create an account</button></> : mode === 'sign-up' ? <>Already have an account? <button onClick={() => changeMode('sign-in')}>Sign in</button></> : <button onClick={() => changeMode('sign-in')}>Back to sign in</button>}</p><p className="auth-legal">By continuing, you agree to our Terms of Use and Privacy Notice.</p></div></section></div>
}

function cleanAnswer(value: string) {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function Message({ role, content, created_at, sources }: ChatMessage) { const ai = role === 'assistant'; const arabic = /[\u0600-\u06ff]/.test(content); const time = created_at === 'Now' ? 'Now' : Number.isNaN(Date.parse(created_at)) ? created_at : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(created_at)); return <article className={`message ${ai ? 'assistant' : 'user'}`}><div className="message-avatar">{ai ? <Bot size={19}/> : 'JD'}</div><div><div className={`bubble ${ai ? 'formatted-answer' : ''}`} dir={arabic ? 'rtl' : 'ltr'}>{ai ? <ReactMarkdown>{content}</ReactMarkdown> : content}</div>{ai && sources?.length ? <details className="message-sources"><summary>Sources used ({sources.length})</summary>{sources.map((source, index) => <div className="source-item" key={`${source.section}-${index}`}><strong>{source.title}{source.page ? ` · Page ${source.page}` : ''}</strong>{source.cosine_score != null && <span>Match score: {source.cosine_score.toFixed(2)} · Threshold passed</span>}{source.section && <span>{cleanAnswer(source.section)}</span>}{source.excerpt && <q>{cleanAnswer(source.excerpt)}</q>}</div>)}</details> : null}<small>{ai ? 'StomaCare AI' : 'You'} · {time}</small></div></article> }

function HistoryPanel({ conversations, onOpen, onNew }: { conversations: { id: string; title: string; updated_at: string }[]; onOpen: (id: string) => void; onNew: () => void }) { return <div className="history-panel"><div><span className="eyebrow">YOUR CONVERSATIONS</span><h2>Chat history</h2><p>Return to any previous health conversation.</p></div>{conversations.length ? <div className="conversation-list">{conversations.map(conversation => <button key={conversation.id} onClick={() => onOpen(conversation.id)}><MessageCircle size={19}/><span><strong>{conversation.title}</strong><small>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(conversation.updated_at))}</small></span><ChevronRight size={18}/></button>)}</div> : <div className="history-empty"><History size={27}/><strong>No saved conversations yet</strong><span>Your consultations will appear here.</span><button onClick={onNew}>Start a consultation</button></div>}</div> }
