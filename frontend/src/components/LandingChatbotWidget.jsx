import { useEffect, useRef, useState } from 'react';
import { Bot, MessageCircle, RotateCcw, Send, X } from 'lucide-react';

const STORAGE_KEY = 'globus-landing-chat-lead';
const VISITOR_KEY = 'globus-landing-chat-visitor';
const VISITOR_COOKIE_MAX_AGE_DAYS = 30;

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function declinedLeadCapture(value) {
  return /^(no|nope|nah|not now|skip|none|prefer not|don't want to|dont want to)$/i.test(String(value || '').trim());
}

function firstReply(message) {
  const text = String(message || '').toLowerCase();
  if (text.includes('price') || text.includes('cost') || text.includes('plan')) {
    return 'I can help with plans and pricing. We also offer a free trial so you can explore the CRM before choosing a plan.';
  }
  if (text.includes('call') || text.includes('ai') || text.includes('follow')) {
    return 'Globus CRM helps teams automate AI calls, notes, lead scoring, and follow-ups from one workspace.';
  }
  if (text.includes('demo') || text.includes('trial') || text.includes('start')) {
    return 'I can help you get started with a free trial or connect you with the team for a product demo.';
  }
  return 'I can help with features, pricing, demos, and getting started with Globus CRM.';
}

function message(text, from = 'bot', serverKey = '') {
  return { id: `${Date.now()}-${Math.random()}`, text, from, serverKey };
}

function readCookie(name) {
  const prefix = `${name}=`;
  return document.cookie.split('; ').find((item) => item.startsWith(prefix))?.slice(prefix.length) || '';
}

function writeVisitorCookie(value) {
  document.cookie = `${VISITOR_KEY}=${encodeURIComponent(value)}; Max-Age=${VISITOR_COOKIE_MAX_AGE_DAYS * 24 * 60 * 60}; Path=/; SameSite=Lax`;
}

function createVisitorId() {
  return typeof window.crypto?.randomUUID === 'function'
    ? window.crypto.randomUUID()
    : `visitor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function storedMessage(item, index) {
  const from = item?.role === 'user' ? 'user' : item?.role === 'agent' ? 'agent' : 'bot';
  const serverKey = `server:${item?.at || ''}:${item?.role || ''}:${index}:${item?.content || ''}`;
  return message(item?.content || '', from, serverKey);
}

export default function LandingChatbotWidget() {
  const [aiAvailable, setAiAvailable] = useState(null);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [step, setStep] = useState('initial');
  const [lead, setLead] = useState({ name: '', email: '', interest: '' });
  const [visitorId, setVisitorId] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [messages, setMessages] = useState([
    message('Hi! I’m the Globus CRM assistant. What would you like to know?'),
  ]);
  const messagesRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/generic-landing-chat/availability')
      .then((response) => (response.ok ? response.json() : { available: false }))
      .then((data) => {
        if (!cancelled) setAiAvailable(data?.available === true);
      })
      .catch(() => {
        if (!cancelled) setAiAvailable(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved?.name || saved?.email || saved?.interest) setLead(saved);
      let savedVisitorId = readCookie(VISITOR_KEY);
      if (!savedVisitorId) {
        // Migrate one existing browser identifier to the expiring cookie.
        // Remove the old persistent copy so it cannot bypass the 30-day TTL.
        savedVisitorId = window.localStorage.getItem(VISITOR_KEY) || '';
        try { window.localStorage.removeItem(VISITOR_KEY); } catch { /* optional migration cleanup */ }
      }
      if (!savedVisitorId) {
        savedVisitorId = createVisitorId();
      }
      writeVisitorCookie(savedVisitorId);
      setVisitorId(savedVisitorId);
    } catch {
      // Local storage is optional; the conversation still works without it.
    }
  }, []);

  // A Generic CRM agent can reply from the Live Chat inbox. Poll only this
  // public widget's conversation so replies appear without changing the
  // existing AI flow or any Travel/Wellness chat surface.
  useEffect(() => {
    if (!visitorId) return undefined;
    let cancelled = false;
    const syncAgentReplies = async () => {
      try {
        const response = await fetch(`/api/generic-landing-chat/conversation/${encodeURIComponent(visitorId)}`);
        if (!response.ok || cancelled) return;
        const data = await response.json();
        setMessages((current) => {
          const serverMessages = (Array.isArray(data.messages) ? data.messages : [])
            .filter((item) => item?.content)
            .map((item, index) => storedMessage(item, index));
          const welcome = current[0]?.from === 'bot' && !current[0].serverKey ? current[0] : null;
          const unsavedLocalMessages = current.filter((item) => (
            !item.serverKey && item !== welcome
          ));
          const visibleServerMessages = serverMessages.filter((serverItem) => (
            !unsavedLocalMessages.some((localItem) => (
              localItem.from === serverItem.from
              && (localItem.text === serverItem.text
                || localItem.text.startsWith(`${serverItem.text} `)
                || localItem.text.startsWith(`${serverItem.text}\n`))
            ))
          ));
          return [welcome, ...visibleServerMessages, ...unsavedLocalMessages].filter(Boolean);
        });
        if (data.requesterName || data.requesterEmail) {
          setLead((current) => ({
            ...current,
            name: data.requesterName || current.name,
            email: data.requesterEmail || current.email,
          }));
        }
      } catch {
        // The public widget continues working if the optional inbox sync is unavailable.
      }
    };
    syncAgentReplies();
    const timer = window.setInterval(syncAgentReplies, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [visitorId]);

  useEffect(() => {
    const element = messagesRef.current;
    if (element && typeof element.scrollTo === 'function') {
      element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  const saveLead = (nextLead) => {
    setLead(nextLead);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextLead)); } catch { /* optional */ }
  };

  const saveConversationTurn = async (text, nextLead, saveOnly = false) => {
    if (!visitorId) return null;
    try {
      const response = await fetch('/api/generic-landing-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visitorId,
          message: text,
          requesterName: nextLead?.name || '',
          requesterEmail: nextLead?.email || '',
          saveOnly,
        }),
      });
      if (!response.ok) return null;
      return response.json();
    } catch {
      return null;
    }
  };

  const respond = async (value) => {
    const text = String(value || '').trim();
    if (!text || isSending) return;
    setInput('');
    setMessages((current) => [...current, message(text, 'user')]);
    setIsSending(true);

    if (step === 'initial') {
      const aiResponse = await saveConversationTurn(text, lead);
      const reply = aiResponse?.reply || firstReply(text);
      const needsSupport = aiResponse?.intent === 'business' && aiResponse?.canAnswer === false;
      const captureLead = aiResponse?.intent === 'business' && !needsSupport;
      setMessages((current) => [...current, message(needsSupport ? `${reply} Would you like me to connect you with our support team?` : (captureLead ? `${reply} May I get your name so our team can follow up?` : reply))]);
      setStep(needsSupport ? 'support-consent' : (captureLead ? 'name' : 'done'));
      setIsSending(false);
      return;
    }
    if (step === 'support-consent') {
      const aiResponse = await saveConversationTurn(text, lead);
      setMessages((current) => [...current, message(aiResponse?.reply || 'I’m here to help. What would you like to know?')]);
      setStep(aiResponse?.leadCaptureStep || 'done');
      setIsSending(false);
      return;
    }
    if (step === 'name') {
      if (declinedLeadCapture(text)) {
        const aiResponse = await saveConversationTurn(text, lead);
        setMessages((current) => [...current, message(aiResponse?.reply || 'No problem. What would you like to know?')]);
        setStep('done');
        setIsSending(false);
        return;
      }
      const nextLead = { ...lead, name: text };
      saveLead(nextLead);
      await saveConversationTurn(text, nextLead, true);
      setMessages((current) => [...current, message(`Thanks, ${text}. What email address should we use to reach you?`)]);
      setStep('email');
      setIsSending(false);
      return;
    }
    if (step === 'email') {
      if (!isEmail(text)) {
        setMessages((current) => [...current, message('Please enter a valid email address so we can contact you.')]);
        setIsSending(false);
        return;
      }
      const nextLead = { ...lead, email: text.toLowerCase() };
      saveLead(nextLead);
      const ticketResponse = await saveConversationTurn(text, nextLead, true);
      setMessages((current) => [...current, message(`${ticketResponse?.ticketCreated ? 'I have sent your unanswered question to our support team. ' : ''}Thank you. What would you like help with: a demo, pricing, or a specific CRM feature?`)]);
      setStep('interest');
      setIsSending(false);
      return;
    }
    const nextLead = { ...lead, interest: text };
    saveLead(nextLead);
    const aiResponse = await saveConversationTurn(text, nextLead);
    const reply = aiResponse?.reply || 'I could not verify that answer right now, so our support team can follow up.';
    setMessages((current) => [...current, message(`${reply}${aiResponse?.ticketCreated ? ' Your question has been sent to our support team.' : ''}`)]);
    setStep(aiResponse?.leadCaptureStep === 'name' ? 'name' : 'done');
    setIsSending(false);
  };

  const clearChat = () => {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(VISITOR_KEY);
      document.cookie = `${VISITOR_KEY}=; Max-Age=0; Path=/; SameSite=Lax`;
    } catch { /* browser storage is optional */ }
    const nextVisitorId = createVisitorId();
    writeVisitorCookie(nextVisitorId);
    setVisitorId(nextVisitorId);
    setLead({ name: '', email: '', interest: '' });
    setStep('initial');
    setInput('');
    setMessages([message('Hi! I’m the Globus CRM assistant. What would you like to know?')]);
  };

  if (aiAvailable !== true) return null;

  return (
    <div className="landing-chatbot" data-testid="landing-chatbot">
      {open && (
        <section className="landing-chatbot__panel" aria-label="Globus CRM assistant">
          <header className="landing-chatbot__header">
            <div className="landing-chatbot__identity">
              <span className="landing-chatbot__avatar"><Bot size={18} /></span>
              <div>
                <strong>Globus CRM assistant</strong>
                <span>Here to help you get started</span>
              </div>
            </div>
            <div className="landing-chatbot__header-actions">
              <button type="button" className="landing-chatbot__clear" aria-label="Clear chat" title="Clear chat" onClick={clearChat}>
                <RotateCcw size={16} />
              </button>
              <button type="button" className="landing-chatbot__close" aria-label="Close chat" onClick={() => setOpen(false)}>
                <X size={18} />
              </button>
            </div>
          </header>

          <div className="landing-chatbot__messages" ref={messagesRef} aria-live="polite">
            {messages.map((item) => (
              <div key={item.id} className={`landing-chatbot__message landing-chatbot__message--${item.from}`}>
                {item.text}
              </div>
            ))}
          </div>

          <form className="landing-chatbot__composer" onSubmit={(event) => { event.preventDefault(); respond(input); }}>
            <input
              aria-label="Chat message"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={step === 'done' ? 'Add another message...' : 'Type your message...'}
              autoComplete="off"
            />
            <button type="submit" aria-label="Send message" disabled={!input.trim() || isSending}>
              <Send size={16} />
            </button>
          </form>
        </section>
      )}

      {!open && (
        <button
          type="button"
          className="landing-chatbot__launcher"
          aria-label="Open chat"
          onClick={() => setOpen(true)}
        >
          <MessageCircle size={23} />
          <span>Chat with us</span>
        </button>
      )}
    </div>
  );
}
