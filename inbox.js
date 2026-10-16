// WhatsApp-style inbox: chat list with "needs you" and unread markers, a
// full-screen chat on phones, the AI suggestion card, takeover/release and
// staff replies. Reads use the signed-in user's session (staff RLS); every
// action goes through the role-checked Worker API.
document.addEventListener('DOMContentLoaded', () => {
  const env = window.SMARTCAP_ENV;
  const el = (id) => document.getElementById(id);
  const tabButton = el('inbox-tab-btn');
  const section = el('inbox-tab');
  if (!env || !tabButton || !section) return;
  if (!env.workerUrl) {
    tabButton.remove();
    section.remove();
    return;
  }

  const { escapeHtml: esc, workerFetch, staffProfile } = window.SmartcapWorker;
  const ACTIVE_POLL_MS = 4000;
  const BACKGROUND_POLL_MS = 20000;
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const SEEN_KEY = 'sc-inbox-seen-v1';
  const phoneLayout = window.matchMedia('(max-width: 760px)');
  const coarsePointer = window.matchMedia('(pointer: coarse)');

  const app = el('wa-app');
  const listEl = el('inbox-conversations');
  const threadEl = el('inbox-thread');
  const headerEl = el('inbox-thread-header');
  const statusEl = el('inbox-status');
  const automationEl = el('inbox-automation');
  const replyForm = el('inbox-reply-form');
  const replyInput = el('inbox-reply-input');
  const sendButton = replyForm.querySelector('button[type="submit"]');
  const replyNote = el('inbox-reply-note');
  const draftEl = el('inbox-draft');
  const jumpButton = el('wa-jump');
  const searchInput = el('inbox-search');
  const badgeEl = el('inbox-badge');
  const attentionCountEl = el('inbox-attention-count');
  const emptyThreadHtml = threadEl.innerHTML;

  let me = null;
  let conversations = [];
  let lastMessage = new Map();
  let unread = new Map();
  let drafts = new Set();
  let automation = null;
  let selectedId = null;
  let pendingOpenId = null;
  let filter = 'all';
  let query = '';
  let pollTimer = null;
  let refreshing = false;
  let renderedDraftId = null;
  let threadSignature = '';
  let headerSignature = '';
  let loaded = false;

  const can = (permission) => Boolean(me && me.permissions.includes(permission));

  // ── Per-device "read up to" marks (a convenience; not shared) ──
  let seen = null;
  try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || 'null'); } catch (_) { seen = null; }
  const saveSeen = () => { try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch (_) { /* private mode */ } };

  // ── Formatting ──
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return d; };
  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function listTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (sameDay(date, new Date())) return clock(iso);
    if (sameDay(date, yesterday())) return 'Yesterday';
    if (Date.now() - date < 6 * 864e5) return date.toLocaleDateString([], { weekday: 'long' });
    return date.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function dayLabel(iso) {
    const date = new Date(iso);
    if (sameDay(date, new Date())) return 'Today';
    if (sameDay(date, yesterday())) return 'Yesterday';
    if (Date.now() - date < 6 * 864e5) return date.toLocaleDateString([], { weekday: 'long' });
    return date.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
  }

  const nameOf = (c) => (c.profile_name && c.profile_name.trim()) || formatPhone(c.wa_id);

  function formatPhone(wa) {
    const digits = String(wa || '');
    // Customers who hide their number appear by WhatsApp user ID only.
    if (!/^\d+$/.test(digits)) return 'WhatsApp user (number hidden)';
    return /^233\d{9}$/.test(digits)
      ? `+233 ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`
      : `+${digits}`;
  }

  function initials(name) {
    const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '#';
    if (/^\d/.test(words[0])) return '#';
    return (words[0][0] + (words[1] ? words[1][0] : '')).toUpperCase();
  }

  const avatar = (c) => `<span class="wa-avatar" style="--h:${(Number(c.id) * 67) % 360}" aria-hidden="true">${esc(initials(nameOf(c)))}</span>`;

  function formatBody(text) {
    let html = esc(text);
    html = html.replace(/https?:\/\/[^\s<]+?(?=&quot;|&#39;|[\s<]|[.,!?)](?:\s|$)|$)/g,
      (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?:)]|$)/g, '$1<strong>$2</strong>');
    html = html.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?:)]|$)/g, '$1<em>$2</em>');
    html = html.replace(/(^|[\s(])~([^~\n]+)~(?=[\s.,!?:)]|$)/g, '$1<s>$2</s>');
    return html;
  }

  const MEDIA = {
    image: '📷 Photo', video: '🎥 Video', audio: '🎤 Voice message', document: '📄 Document',
    sticker: '🙂 Sticker', location: '📍 Location', contacts: '👤 Contact', reaction: 'Reaction'
  };
  const mediaLabel = (type) => MEDIA[type] || `[${type}]`;

  const CHECK = 'M1.2 5.9 4.6 9.3 11.8 1.9';
  const TICKS = {
    queued: '<svg class="wa-tick" viewBox="0 0 16 16" aria-label="Sending"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    sent: `<svg class="wa-tick" viewBox="0 0 18 11" aria-label="Sent"><path d="${CHECK}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    delivered: `<svg class="wa-tick" viewBox="0 0 18 11" aria-label="Delivered"><path d="${CHECK}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.6 8.7 8.2 9.3 15.4 1.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    failed: '<svg class="wa-tick wa-tick--failed" viewBox="0 0 16 16" aria-label="Not delivered"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M8 4.2v4.6M8 11.3v.1" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>'
  };
  TICKS.read = TICKS.delivered.replace('class="wa-tick"', 'class="wa-tick wa-tick--read"').replace('aria-label="Delivered"', 'aria-label="Read"');
  const tick = (status) => TICKS[status] || '';

  const SENDERS = { bot: '🤖 AI assistant', staff: '👤 Staff', system: '⚙️ Automatic' };

  // ── Toast (visible in both list and full-screen chat) ──
  const toastEl = document.createElement('div');
  toastEl.className = 'wa-toast';
  toastEl.setAttribute('role', 'status');
  document.body.appendChild(toastEl);
  let toastTimer = null;
  function toast(message, kind = 'info') {
    toastEl.textContent = message;
    toastEl.dataset.kind = kind;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), kind === 'error' ? 6000 : 2600);
  }

  // ── State helpers ──
  const selected = () => conversations.find((c) => c.id === selectedId) || null;
  const unreadCount = (c) => (c.id === selectedId && chatVisible() ? 0 : unread.get(c.id) || 0);
  function needsYou(c) {
    if (drafts.has(c.id)) return true;
    const last = lastMessage.get(c.id);
    return Boolean(last && last.direction === 'inbound' && (c.mode === 'human' || (automation && automation.paused)));
  }
  function chatVisible() {
    if (document.hidden || section.classList.contains('hidden') || selectedId === null) return false;
    return !phoneLayout.matches || app.classList.contains('has-chat');
  }

  // ── Loading ──
  async function loadAutomation() {
    let { data, error } = await window.supabaseClient.from('automation_settings').select('paused, auto_reply_scope').maybeSingle();
    if (error) {
      ({ data } = await window.supabaseClient.from('automation_settings').select('paused').maybeSingle());
    }
    automation = data;
  }

  async function loadList() {
    const sb = window.supabaseClient;
    const [convos, recent, pending] = await Promise.all([
      sb.from('conversations')
        .select('id, wa_id, profile_name, mode, last_inbound_at, last_message_at')
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(100),
      sb.from('messages')
        .select('conversation_id, direction, sender_kind, body, message_type, status, created_at')
        .order('created_at', { ascending: false })
        .limit(400),
      sb.from('ai_drafts').select('conversation_id').eq('status', 'pending').limit(200)
    ]);
    if (convos.error) throw convos.error;
    conversations = convos.data || [];
    if (!seen) {
      // First use on this device: everything so far counts as read.
      seen = {};
      conversations.forEach((c) => { if (c.last_message_at) seen[c.id] = c.last_message_at; });
      saveSeen();
    }
    lastMessage = new Map();
    unread = new Map();
    for (const m of recent.data || []) {
      if (!lastMessage.has(m.conversation_id)) lastMessage.set(m.conversation_id, m);
      const mark = seen[m.conversation_id];
      if (m.direction === 'inbound' && (!mark || Date.parse(m.created_at) > Date.parse(mark))) {
        unread.set(m.conversation_id, (unread.get(m.conversation_id) || 0) + 1);
      }
    }
    drafts = new Set((pending.data || []).map((d) => d.conversation_id));
  }

  // ── Rendering: automation bar ──
  const SCOPES = {
    off: 'You approve every reply',
    allowlist: 'Auto-replies to test numbers only',
    all: 'Auto-replies to every customer'
  };

  function renderAutomation() {
    if (!automation) {
      automationEl.innerHTML = '';
      return;
    }
    const paused = automation.paused;
    const scope = automation.auto_reply_scope;
    const scopeControl = scope && can('automation.resume')
      ? `<select data-scope aria-label="Automatic replies">
           ${Object.entries(SCOPES).map(([value, label]) => `<option value="${value}" ${value === scope ? 'selected' : ''}>${label}</option>`).join('')}
         </select>`
      : `<span>${esc(scope ? SCOPES[scope] || scope : '')}</span>`;
    const button = paused
      ? (can('automation.resume') ? '<button type="button" class="wa-btn wa-btn--primary" data-automation="resume">Resume</button>' : '')
      : (can('automation.pause') ? '<button type="button" class="wa-btn wa-btn--danger" data-automation="pause">Pause</button>' : '');
    const html = `
      <div class="wa-auto ${paused ? 'is-paused' : ''}">
        <span class="wa-auto-dot" aria-hidden="true"></span>
        <div class="wa-auto-text">
          <strong>${paused ? 'Automation paused · nothing is sent' : 'AI assistant is on'}</strong>
          ${scopeControl}
        </div>
        ${button}
      </div>`;
    if (automationEl.dataset.html !== html) {
      automationEl.innerHTML = html;
      automationEl.dataset.html = html;
    }
  }

  // ── Rendering: chat list ──
  function previewHtml(m) {
    if (!m) return '';
    const text = m.body ? m.body.replace(/\s+/g, ' ').slice(0, 120) : mediaLabel(m.message_type);
    const who = m.direction === 'outbound'
      ? `${tick(m.status)}${m.sender_kind === 'bot' ? '<span class="wa-mini">AI:</span> ' : m.sender_kind === 'system' ? '<span class="wa-mini">Auto:</span> ' : ''}`
      : '';
    return `${who}${esc(text)}`;
  }

  function updateBadges() {
    const attention = conversations.filter(needsYou).length;
    badgeEl.textContent = attention > 99 ? '99+' : String(attention);
    badgeEl.classList.toggle('hidden', attention === 0);
    attentionCountEl.textContent = attention ? String(attention) : '';
    document.title = attention ? `(${attention}) Smart Captcha Admin` : 'Smart Captcha Admin';
    if ('setAppBadge' in navigator) {
      (attention ? navigator.setAppBadge(attention) : navigator.clearAppBadge()).catch(() => undefined);
    }
  }

  function renderList() {
    const q = query.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const visible = conversations.filter((c) => {
      if (q && !(nameOf(c).toLowerCase().includes(q) || (digits.length >= 3 && c.wa_id.includes(digits)))) return false;
      if (filter === 'attention') return needsYou(c);
      if (filter === 'unread') return unreadCount(c) > 0;
      if (filter === 'human') return c.mode === 'human';
      return true;
    });
    const html = visible.map((c) => {
      const last = lastMessage.get(c.id);
      const count = unreadCount(c);
      const attention = needsYou(c);
      const flags = [
        c.mode === 'human' ? '<span class="wa-tag wa-tag--human">Staff</span>' : '',
        drafts.has(c.id) ? '<span class="wa-tag wa-tag--draft">Approve</span>' : '',
        count ? `<span class="wa-count">${count > 99 ? '99+' : count}</span>` : attention ? '<span class="wa-dot" aria-label="Needs you"></span>' : ''
      ].join('');
      return `
        <button type="button" class="wa-item${c.id === selectedId ? ' is-active' : ''}${attention ? ' needs-you' : ''}" data-convo="${c.id}">
          ${avatar(c)}
          <span class="wa-item-main">
            <span class="wa-item-row">
              <span class="wa-item-name">${esc(nameOf(c))}</span>
              <span class="wa-item-time${count || attention ? ' is-hot' : ''}">${esc(listTime(last ? last.created_at : c.last_message_at))}</span>
            </span>
            <span class="wa-item-row">
              <span class="wa-item-preview">${previewHtml(last)}</span>
              <span class="wa-item-flags">${flags}</span>
            </span>
          </span>
        </button>`;
    }).join('');
    listEl.innerHTML = html || `<p class="wa-list-empty">${
      conversations.length === 0 ? 'No chats yet. New WhatsApp messages appear here.'
        : filter === 'attention' ? 'Nothing needs you right now. 🎉'
          : 'No chats match.'}</p>`;
    updateBadges();
  }

  // ── Rendering: chat ──
  function renderHeader(convo) {
    const human = convo.mode === 'human';
    const action = !can('conversations.takeover') ? ''
      : human
        ? '<button type="button" class="wa-mode-btn wa-mode-btn--ai" data-mode="release">🤖 Hand back to AI</button>'
        : '<button type="button" class="wa-mode-btn" data-mode="takeover">✋ Take over</button>';
    const state = human ? 'Staff replying · AI silent'
      : automation && automation.paused ? 'Automation paused'
        : 'AI replying';
    const html = `
      <button type="button" class="wa-back" data-back aria-label="Back to chats">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H5M11 5l-7 7 7 7"/></svg>
      </button>
      ${avatar(convo)}
      <div class="wa-head-info">
        <strong>${esc(nameOf(convo))}</strong>
        <span><span class="wa-state wa-state--${human ? 'human' : 'ai'}"></span>${esc(state)} · ${esc(formatPhone(convo.wa_id))}</span>
      </div>
      <div class="wa-head-actions">${action}</div>`;
    if (html !== headerSignature) {
      headerEl.innerHTML = html;
      headerSignature = html;
    }
  }

  function renderMessages(rows) {
    if (rows.length === 0) return '<div class="wa-day"><span>No messages yet</span></div>';
    let html = '';
    let lastDay = '';
    let prev = null;
    for (const m of rows) {
      const day = new Date(m.created_at).toDateString();
      if (day !== lastDay) {
        html += `<div class="wa-day"><span>${esc(dayLabel(m.created_at))}</span></div>`;
        lastDay = day;
        prev = null;
      }
      const out = m.direction === 'outbound';
      const grouped = prev && prev.direction === m.direction && prev.sender_kind === m.sender_kind
        && Date.parse(m.created_at) - Date.parse(prev.created_at) < 10 * 60 * 1000;
      const label = out && !grouped && SENDERS[m.sender_kind] ? `<span class="wa-sender wa-sender--${esc(m.sender_kind)}">${SENDERS[m.sender_kind]}</span>` : '';
      html += `
        <div class="wa-msg ${out ? 'wa-msg--out' : 'wa-msg--in'}${grouped ? ' is-grouped' : ''}">
          <div class="wa-bubble">
            ${label}
            <span class="wa-text">${m.body ? formatBody(m.body) : `<em class="wa-media">${esc(mediaLabel(m.message_type))}</em>`}</span><span class="wa-spacer" aria-hidden="true"></span>
            <span class="wa-meta">${esc(clock(m.created_at))}${out ? tick(m.status) : ''}</span>
          </div>
          ${m.error ? `<div class="wa-msg-error">Not delivered · ${esc(m.error)}</div>` : ''}
        </div>`;
      prev = m;
    }
    return html;
  }

  const distanceFromBottom = () => threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight;
  const scrollToBottom = () => { threadEl.scrollTop = threadEl.scrollHeight; jumpButton.classList.add('hidden'); };

  async function loadThread({ toBottom = false } = {}) {
    const convo = selected();
    if (!convo) {
      headerEl.innerHTML = '';
      headerSignature = '';
      threadEl.innerHTML = emptyThreadHtml;
      threadSignature = '';
      replyForm.classList.add('hidden');
      replyNote.textContent = '';
      draftEl.classList.add('hidden');
      return;
    }
    const { data, error } = await window.supabaseClient
      .from('messages')
      .select('id, direction, sender_kind, body, message_type, status, error, created_at')
      .eq('conversation_id', convo.id)
      .order('created_at', { ascending: false })
      .limit(200);
    if (convo.id !== selectedId) return; // switched chats meanwhile
    if (error) {
      toast(`Could not load messages: ${error.message}`, 'error');
      return;
    }
    const rows = data.reverse();
    renderHeader(convo);

    const signature = rows.map((m) => `${m.id}:${m.status}`).join(',');
    const stick = toBottom || distanceFromBottom() < 120;
    if (signature !== threadSignature) {
      const nearBottom = stick;
      threadEl.innerHTML = renderMessages(rows);
      const grew = threadSignature !== '' && rows.length > 0;
      threadSignature = signature;
      if (toBottom || nearBottom) scrollToBottom();
      else if (grew) jumpButton.classList.remove('hidden');
    } else if (toBottom) {
      scrollToBottom();
    }

    if (rows.length && chatVisible()) {
      const latest = rows[rows.length - 1].created_at;
      if (seen[convo.id] !== latest) {
        seen[convo.id] = latest;
        saveSeen();
        unread.delete(convo.id);
        renderList();
      }
    }

    const windowOpen = Boolean(convo.last_inbound_at && Date.now() - Date.parse(convo.last_inbound_at) < WINDOW_MS);
    const canReply = can('conversations.reply');
    replyForm.classList.toggle('hidden', !canReply);
    replyInput.disabled = !windowOpen;
    sendButton.disabled = !windowOpen;
    replyInput.placeholder = !windowOpen ? 'Chat closed (24 h)' : convo.mode === 'ai' ? 'Message · sending takes over from AI' : 'Message';
    replyNote.textContent = canReply && !windowOpen
      ? 'This customer last wrote more than 24 hours ago. WhatsApp only allows approved templates now.'
      : '';
    replyNote.classList.toggle('hidden', !replyNote.textContent);

    await loadDraft(convo, windowOpen);
    // The note and suggestion card shrink the thread; keep the latest message in view.
    if (stick && convo.id === selectedId) scrollToBottom();
  }

  // The newest pending AI draft, for staff to send, edit or discard.
  async function loadDraft(convo, windowOpen) {
    if (!can('conversations.reply')) {
      draftEl.classList.add('hidden');
      return;
    }
    const { data } = await window.supabaseClient
      .from('ai_drafts')
      .select('id, body, flags, tool_trace, quote_id, model, latency_ms, created_at')
      .eq('conversation_id', convo.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1);
    if (convo.id !== selectedId) return;
    const draft = data && data[0];
    if (!draft) {
      renderedDraftId = null;
      draftEl.classList.add('hidden');
      draftEl.innerHTML = '';
      return;
    }
    // Keep a staff member's in-progress edits across refreshes.
    if (draft.id === renderedDraftId) {
      const send = draftEl.querySelector('[data-draft="approved"]');
      if (send) send.disabled = !windowOpen;
      return;
    }
    renderedDraftId = draft.id;

    let quoteLine = '';
    if (draft.quote_id) {
      const { data: quote } = await window.supabaseClient
        .from('quotes')
        .select('quote_number, status, total_minor, deposit_minor')
        .eq('id', draft.quote_id)
        .maybeSingle();
      if (quote) {
        const money = (minor) => minor === null ? '—'
          : `GHS ${(BigInt(minor) / 100n).toLocaleString('en-US')}.${(BigInt(minor) % 100n).toString().padStart(2, '0')}`;
        quoteLine = `<p class="wa-draft-quote">Quote ${esc(quote.quote_number)} · ${esc(quote.status.replace('_', ' '))} · total ${esc(money(quote.total_minor))} · deposit ${esc(money(quote.deposit_minor))}</p>`;
      }
    }
    const flags = draft.flags || [];
    const escalation = (draft.tool_trace || []).find((t) => t.name === 'escalate_to_human');
    const tools = [...new Set((draft.tool_trace || []).map((t) => t.name.replace(/_/g, ' ')))];
    const warnings = [
      flags.includes('ungrounded_price')
        ? '<p class="wa-draft-warn is-danger">⚠ Has a price that is not in the approved catalog or quote. Check it before sending.</p>' : '',
      flags.includes('unverified_booking_claim')
        ? '<p class="wa-draft-warn is-danger">⚠ Talks about a booking or date that was not actually held.</p>' : '',
      flags.includes('malformed_output')
        ? '<p class="wa-draft-warn">⚠ The AI output looked garbled; read it carefully.</p>' : '',
      flags.includes('escalation_requested')
        ? `<p class="wa-draft-warn">🙋 The customer needs a person${escalation && escalation.args && escalation.args.reason ? `: ${esc(escalation.args.reason)}` : ''}</p>` : ''
    ].join('');

    draftEl.innerHTML = `
      <div class="wa-draft-head">
        <span class="wa-draft-title">🤖 AI suggested reply</span>
        <span class="wa-draft-meta">${esc(tools.length ? tools.join(' · ') : 'no tools')}${draft.latency_ms ? ` · ${(draft.latency_ms / 1000).toFixed(1)} s` : ''}</span>
      </div>
      ${warnings}${quoteLine}
      <textarea id="inbox-draft-body" rows="3" maxlength="4096" aria-label="Suggested reply">${esc(draft.body)}</textarea>
      <div class="wa-draft-actions">
        <span class="wa-draft-foot">Sends as staff; AI keeps the chat.</span>
        <button type="button" class="wa-btn wa-btn--ghost" data-draft="rejected">Discard</button>
        <button type="button" class="wa-btn wa-btn--primary" data-draft="approved" ${windowOpen ? '' : 'disabled'}>Send</button>
      </div>`;
    draftEl.dataset.draftId = String(draft.id);
    draftEl.classList.remove('hidden');
  }

  // ── Refresh loop ──
  async function refresh() {
    if (refreshing || !me) return;
    refreshing = true;
    try {
      await Promise.all([loadList(), loadAutomation()]);
      loaded = true;
      renderAutomation();
      if (pendingOpenId !== null) {
        const id = pendingOpenId;
        pendingOpenId = null;
        if (conversations.some((c) => c.id === id)) openChat(id);
      }
      renderList();
      if (selectedId !== null) await loadThread();
      statusEl.textContent = '';
    } catch (err) {
      statusEl.textContent = `Could not refresh: ${err.message}`;
    } finally {
      refreshing = false;
    }
  }

  function schedule() {
    clearTimeout(pollTimer);
    const active = !section.classList.contains('hidden') && !document.hidden;
    pollTimer = setTimeout(async () => {
      if (!document.hidden) await refresh();
      schedule();
    }, active ? ACTIVE_POLL_MS : BACKGROUND_POLL_MS);
  }

  async function start() {
    if (!me) {
      statusEl.textContent = 'Loading…';
      try {
        me = await staffProfile();
      } catch (err) {
        statusEl.textContent = err.status === 403
          ? 'This account has no staff role. Ask an admin to assign one.'
          : `Could not verify your role: ${err.message}`;
        return;
      }
      if (!can('conversations.read')) {
        me = null;
        statusEl.textContent = 'Your role cannot view chats.';
        return;
      }
    }
    await refresh();
    schedule();
  }

  async function act(label, action, { quiet = false } = {}) {
    try {
      await action();
      if (!quiet) toast(`${label} ✓`);
    } catch (err) {
      toast(`${label} failed: ${err.message}`, 'error');
      throw err;
    } finally {
      threadSignature = '';
      await refresh();
    }
  }

  // ── Navigation between list and chat ──
  const chatUrl = (id) => `?tab=inbox&c=${id}`;

  function openChat(id) {
    if (!loaded) {
      pendingOpenId = id;
      return;
    }
    if (!conversations.some((c) => c.id === id)) return;
    const switching = id !== selectedId;
    selectedId = id;
    if (switching) {
      renderedDraftId = null;
      threadSignature = '';
      headerSignature = '';
      threadEl.innerHTML = '<div class="wa-day"><span>Loading…</span></div>';
      draftEl.classList.add('hidden');
      replyInput.value = '';
      autosize();
    }
    app.classList.add('has-chat');
    if (phoneLayout.matches) {
      // The chat sits on its own history entry so Back returns to the list,
      // including when it was opened from a notification.
      document.body.classList.add('wa-chat-open');
      if (history.state && history.state.waChat) {
        history.replaceState({ waChat: id }, '', chatUrl(id));
      } else {
        history.replaceState(null, '', '?tab=inbox');
        history.pushState({ waChat: id }, '', chatUrl(id));
      }
    } else {
      history.replaceState(history.state, '', chatUrl(id));
    }
    renderList();
    loadThread({ toBottom: true });
  }

  function closeChat() {
    app.classList.remove('has-chat');
    document.body.classList.remove('wa-chat-open');
    selectedId = null;
    threadSignature = '';
    headerSignature = '';
    history.replaceState(null, '', '?tab=inbox');
    renderList();
    loadThread();
  }

  window.addEventListener('popstate', (event) => {
    if (document.body.classList.contains('wa-chat-open') && !(event.state && event.state.waChat)) closeChat();
  });

  // ── Events ──
  listEl.addEventListener('click', (event) => {
    const item = event.target.closest('[data-convo]');
    if (item) openChat(Number(item.dataset.convo));
  });

  headerEl.addEventListener('click', (event) => {
    if (event.target.closest('[data-back]')) {
      if (history.state && history.state.waChat) history.back();
      else closeChat();
      return;
    }
    const button = event.target.closest('[data-mode]');
    if (!button || !selectedId) return;
    const takeover = button.dataset.mode === 'takeover';
    if (!takeover && !confirm('Hand this chat back to the AI? It may reply to this customer again.')) return;
    button.disabled = true;
    let learned = 0;
    act(takeover ? 'You took over' : 'Handed back to AI', async () => {
      const result = await workerFetch(`/admin/conversations/${selectedId}/${takeover ? 'takeover' : 'release'}`, {
        method: 'POST',
        body: JSON.stringify({ reason: takeover ? 'inbox_takeover' : 'inbox_release' })
      });
      // Releasing asks the AI to suggest facts from the team's replies.
      learned = Number(result.knowledge_suggestions) || 0;
    }).then(() => {
      if (learned) toast(`💡 ${learned} new fact${learned > 1 ? 's' : ''} to review in Learn`);
    }).catch(() => undefined);
  });

  automationEl.addEventListener('change', (event) => {
    const select = event.target.closest('[data-scope]');
    if (!select) return;
    const scope = select.value;
    const warning = scope === 'all'
      ? 'Let the AI reply to ALL customers automatically?\n\nIt only auto-sends replies with verified prices and no warnings. Payments, bookings, complaints, discounts and "talk to a person" still come to you.'
      : scope === 'off' ? 'Require your approval for every AI reply?' : 'Auto-reply only to the test numbers?';
    if (!confirm(warning)) {
      automationEl.dataset.html = '';
      renderAutomation();
      return;
    }
    act('AI replies updated', () =>
      workerFetch('/admin/automation/scope', { method: 'POST', body: JSON.stringify({ scope }) })).catch(() => undefined);
  });

  automationEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-automation]');
    if (!button) return;
    const pause = button.dataset.automation === 'pause';
    if (!confirm(pause
      ? 'Pause ALL automated messages for every customer?'
      : 'Resume automation? The AI may message customers again (subject to all other checks).')) return;
    act(pause ? 'Automation paused' : 'Automation resumed', () =>
      workerFetch(`/admin/automation/${pause ? 'pause' : 'resume'}`, { method: 'POST', body: '{}' })).catch(() => undefined);
  });

  draftEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-draft]');
    if (!button) return;
    const draftId = draftEl.dataset.draftId;
    const decision = button.dataset.draft;
    const body = el('inbox-draft-body').value.trim();
    if (decision === 'approved' && !body) return;
    if (decision === 'rejected' && !confirm('Discard this AI suggestion?')) return;
    draftEl.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    act(decision === 'approved' ? 'Reply sent' : 'Suggestion discarded', async () => {
      try {
        await workerFetch(`/admin/drafts/${draftId}/review`, {
          method: 'POST',
          body: JSON.stringify(decision === 'approved'
            ? { decision, body, client_message_id: crypto.randomUUID() }
            : { decision })
        });
        renderedDraftId = null;
      } catch (err) {
        draftEl.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        throw err;
      }
    }).catch(() => undefined);
  });

  function autosize() {
    replyInput.style.height = 'auto';
    // Hidden (display: none) fields measure 0; keep the CSS height then.
    if (replyInput.scrollHeight > 0) replyInput.style.height = `${Math.min(replyInput.scrollHeight, 140)}px`;
  }
  replyInput.addEventListener('input', () => {
    delete replyForm.dataset.pendingId;
    autosize();
  });
  replyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !coarsePointer.matches) {
      event.preventDefault();
      replyForm.requestSubmit();
    }
  });

  replyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = replyInput.value.trim();
    if (!text || !selectedId || sendButton.disabled) return;
    const convoId = selectedId;
    // A stable id per attempt makes a double tap or retry idempotent.
    const clientMessageId = replyForm.dataset.pendingId || crypto.randomUUID();
    replyForm.dataset.pendingId = clientMessageId;
    sendButton.disabled = true;
    threadEl.insertAdjacentHTML('beforeend', `
      <div class="wa-msg wa-msg--out is-pending">
        <div class="wa-bubble">
          <span class="wa-text">${formatBody(text)}</span><span class="wa-spacer" aria-hidden="true"></span>
          <span class="wa-meta">${esc(clock(new Date().toISOString()))}${tick('queued')}</span>
        </div>
      </div>`);
    scrollToBottom();
    replyInput.value = '';
    autosize();
    act('Sent', async () => {
      try {
        await workerFetch(`/admin/conversations/${convoId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ body: text, client_message_id: clientMessageId })
        });
        delete replyForm.dataset.pendingId;
      } catch (err) {
        // 502 = Meta refused and it was recorded as failed; a retry is a new
        // message. Other errors keep the id so a retry is de-duplicated.
        if (err.status === 502) delete replyForm.dataset.pendingId;
        if (!replyInput.value) replyInput.value = text;
        autosize();
        throw err;
      } finally {
        sendButton.disabled = false;
      }
    }, { quiet: true }).catch(() => undefined);
  });

  threadEl.addEventListener('scroll', () => {
    if (distanceFromBottom() < 80) jumpButton.classList.add('hidden');
  }, { passive: true });
  jumpButton.addEventListener('click', scrollToBottom);

  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    renderList();
  });
  section.querySelector('.wa-filters').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-filter]');
    if (!chip) return;
    filter = chip.dataset.filter;
    section.querySelectorAll('.wa-chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    renderList();
  });

  el('inbox-refresh').addEventListener('click', () => {
    threadSignature = '';
    refresh();
  });
  tabButton.addEventListener('click', () => {
    start();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && me) {
      refresh();
      schedule();
    }
  });
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'push' && me) refresh();
    });
  }
  // Leaving the phone layout while a chat is open must not leave the page locked.
  phoneLayout.addEventListener('change', () => {
    if (!phoneLayout.matches) document.body.classList.remove('wa-chat-open');
    else if (app.classList.contains('has-chat')) document.body.classList.add('wa-chat-open');
  });

  window.SmartcapInbox = Object.freeze({
    start,
    openChat: (id) => {
      start();
      openChat(Number(id));
    }
  });
});
