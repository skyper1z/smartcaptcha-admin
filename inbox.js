// WhatsApp Inbox tab: conversation list and thread, human takeover/release,
// staff replies, and the global automation pause. Reads use the signed-in
// user's session (staff RLS); every action goes through the Worker API.
document.addEventListener('DOMContentLoaded', () => {
  const env = window.SMARTCAP_ENV;
  const tabButton = document.getElementById('inbox-tab-btn');
  const section = document.getElementById('inbox-tab');
  if (!env || !tabButton || !section) return;
  if (!env.workerUrl) {
    tabButton.remove();
    section.remove();
    return;
  }

  const { escapeHtml, workerFetch, staffProfile } = window.SmartcapWorker;
  const POLL_MS = 5000;
  const WINDOW_MS = 24 * 60 * 60 * 1000;

  const el = (id) => document.getElementById(id);
  const listEl = el('inbox-conversations');
  const threadEl = el('inbox-thread');
  const headerEl = el('inbox-thread-header');
  const statusEl = el('inbox-status');
  const automationEl = el('inbox-automation');
  const replyForm = el('inbox-reply-form');
  const replyInput = el('inbox-reply-input');
  const replyNote = el('inbox-reply-note');
  const draftEl = el('inbox-draft');
  let renderedDraftId = null;

  let me = null;
  let conversations = [];
  let selectedId = null;
  let pollTimer = null;
  let automation = null;

  const can = (permission) => Boolean(me && me.permissions.includes(permission));

  function formatTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  const STATUS_MARKS = { queued: '🕓', sent: '✓', delivered: '✓✓', read: '✓✓ read', failed: '⚠ failed' };

  async function loadAutomation() {
    let { data, error } = await window.supabaseClient.from('automation_settings').select('paused, auto_reply_scope').maybeSingle();
    if (error) {
      // Database not yet updated with auto_reply_scope: fall back to pause only.
      ({ data } = await window.supabaseClient.from('automation_settings').select('paused').maybeSingle());
    }
    automation = data;
    renderAutomation();
  }

  function renderAutomation() {
    if (!automation) {
      automationEl.innerHTML = '';
      return;
    }
    const paused = automation.paused;
    const button = paused
      ? (can('automation.resume') ? '<button class="button primary" data-automation="resume">Resume automation</button>' : '')
      : (can('automation.pause') ? '<button class="button danger" data-automation="pause">Pause all automation</button>' : '');
    const scope = automation.auto_reply_scope;
    const SCOPES = {
      off: 'Approve every reply',
      allowlist: 'Auto-reply to test numbers only',
      all: 'Auto-reply to all customers'
    };
    const scopeControl = !scope ? ''
      : can('automation.resume')
        ? `<label class="inbox-scope">AI replies:
             <select data-scope aria-label="Automatic replies">
               ${Object.entries(SCOPES).map(([value, label]) => `<option value="${value}" ${value === scope ? 'selected' : ''}>${label}</option>`).join('')}
             </select>
           </label>`
        : `<span class="pricing-muted">AI replies: ${escapeHtml(SCOPES[scope] || scope)}</span>`;
    automationEl.innerHTML = `
      <span class="inbox-pill ${paused ? 'inbox-pill--paused' : 'inbox-pill--active'}">
        ${paused ? '⏸ Automation paused — no bot messages are sent' : '● Automation active'}
      </span> ${button} ${scopeControl}
      ${scope === 'all' && !paused ? '<span class="pricing-muted">Payments, bookings, complaints, discounts and unverified prices still wait for you below.</span>' : ''}`;
  }

  automationEl.addEventListener('change', (event) => {
    const select = event.target.closest('[data-scope]');
    if (!select) return;
    const scope = select.value;
    const warning = scope === 'all'
      ? 'Let the AI reply to ALL customers automatically?\n\nIt only auto-sends replies with verified prices and no warnings. Payments, bookings, complaints, discounts and "talk to a person" still wait for you.'
      : scope === 'off' ? 'Require your approval for every AI reply?' : 'Auto-reply only to the test numbers?';
    if (!confirm(warning)) {
      renderAutomation();
      return;
    }
    act('Updating AI replies', () =>
      workerFetch('/admin/automation/scope', { method: 'POST', body: JSON.stringify({ scope }) }));
  });

  async function loadConversations() {
    const { data, error } = await window.supabaseClient
      .from('conversations')
      .select('id, wa_id, profile_name, mode, last_inbound_at, last_message_at')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(100);
    if (error) {
      statusEl.textContent = `Error loading conversations: ${error.message}`;
      return;
    }
    conversations = data;
    renderConversations();
  }

  function renderConversations() {
    if (conversations.length === 0) {
      listEl.innerHTML = '<p class="pricing-muted">No conversations yet.</p>';
      return;
    }
    listEl.innerHTML = conversations.map((c) => `
      <button class="inbox-convo ${c.id === selectedId ? 'is-selected' : ''}" data-convo="${c.id}">
        <span class="inbox-convo-name">${escapeHtml(c.profile_name || c.wa_id)}</span>
        <span class="inbox-mode inbox-mode--${escapeHtml(c.mode)}">${c.mode === 'human' ? '👤 Human' : '🤖 AI'}</span>
        <span class="inbox-convo-meta">+${escapeHtml(c.wa_id)} · ${escapeHtml(formatTime(c.last_message_at))}</span>
      </button>`).join('');
  }

  async function loadThread() {
    const convo = conversations.find((c) => c.id === selectedId);
    if (!convo) {
      headerEl.innerHTML = '';
      threadEl.innerHTML = '<p class="pricing-muted">Select a conversation.</p>';
      replyForm.classList.add('hidden');
      return;
    }
    const { data, error } = await window.supabaseClient
      .from('messages')
      .select('id, direction, sender_kind, body, message_type, status, error, created_at')
      .eq('conversation_id', convo.id)
      .order('created_at', { ascending: true })
      .limit(200);
    if (error) {
      threadEl.innerHTML = `<p class="status-text">Error: ${escapeHtml(error.message)}</p>`;
      return;
    }

    const modeButton = convo.mode === 'ai'
      ? (can('conversations.takeover') ? '<button class="button danger" data-mode="takeover">Take over</button>' : '')
      : (can('conversations.takeover') ? '<button class="button" data-mode="release">Return to AI</button>' : '');
    headerEl.innerHTML = `
      <div>
        <strong>${escapeHtml(convo.profile_name || convo.wa_id)}</strong>
        <span class="pricing-muted">+${escapeHtml(convo.wa_id)}</span>
      </div>
      <div class="inbox-header-actions">
        <span class="inbox-mode inbox-mode--${escapeHtml(convo.mode)}">${convo.mode === 'human' ? '👤 Human has this chat — bot is silent' : '🤖 AI mode'}</span>
        ${modeButton}
      </div>`;

    const atBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 40;
    threadEl.innerHTML = data.map((m) => `
      <div class="inbox-msg inbox-msg--${escapeHtml(m.direction)} inbox-msg--${escapeHtml(m.sender_kind)}">
        <div class="inbox-msg-body">${m.body ? escapeHtml(m.body) : `<em>[${escapeHtml(m.message_type)}]</em>`}</div>
        <div class="inbox-msg-meta">
          ${m.sender_kind === 'bot' ? 'Bot · ' : m.sender_kind === 'staff' ? 'Staff · ' : ''}${escapeHtml(formatTime(m.created_at))}
          ${m.direction === 'outbound' ? ` · ${escapeHtml(STATUS_MARKS[m.status] || m.status)}` : ''}
          ${m.error ? `<span class="inbox-error">${escapeHtml(m.error)}</span>` : ''}
        </div>
      </div>`).join('') || '<p class="pricing-muted">No messages.</p>';
    if (atBottom) threadEl.scrollTop = threadEl.scrollHeight;

    const windowOpen = convo.last_inbound_at && Date.now() - Date.parse(convo.last_inbound_at) < WINDOW_MS;
    replyForm.classList.toggle('hidden', !can('conversations.reply'));
    replyInput.disabled = !windowOpen;
    replyForm.querySelector('button').disabled = !windowOpen;
    replyNote.textContent = !windowOpen
      ? 'Outside WhatsApp’s 24-hour window — free-form replies are blocked (templates come later).'
      : convo.mode === 'ai'
        ? 'Sending a reply takes over this chat: the bot stops replying to this customer.'
        : '';

    await loadDraft(convo, windowOpen);
  }

  // Shadow mode: show the newest pending AI draft for staff review.
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
    const draft = data && data[0];
    if (!draft) {
      renderedDraftId = null;
      draftEl.classList.add('hidden');
      draftEl.innerHTML = '';
      return;
    }
    // Keep a staff member's in-progress edits across polling refreshes.
    if (draft.id === renderedDraftId) return;
    renderedDraftId = draft.id;

    let quoteLine = '';
    if (draft.quote_id) {
      const { data: quote } = await window.supabaseClient
        .from('quotes')
        .select('quote_number, status, total_minor, deposit_minor, deposit_basis_points')
        .eq('id', draft.quote_id)
        .maybeSingle();
      if (quote) {
        const money = (minor) => minor === null ? '—'
          : `GHS ${(BigInt(minor) / 100n).toLocaleString('en-US')}.${(BigInt(minor) % 100n).toString().padStart(2, '0')}`;
        quoteLine = `<p class="inbox-draft-quote">Quote ${escapeHtml(quote.quote_number)} · ${escapeHtml(quote.status.replace('_', ' '))} · total ${escapeHtml(money(quote.total_minor))} · deposit ${escapeHtml(money(quote.deposit_minor))}</p>`;
      }
    }
    const flags = draft.flags || [];
    const escalation = (draft.tool_trace || []).find((t) => t.name === 'escalate_to_human');
    const tools = [...new Set((draft.tool_trace || []).map((t) => t.name))];
    const warnings = [
      flags.includes('ungrounded_price')
        ? '<p class="inbox-draft-warn inbox-draft-warn--danger">⚠ Contains a price or percentage not found in the approved catalog or quote. Edit it before sending.</p>' : '',
      flags.includes('escalation_requested')
        ? `<p class="inbox-draft-warn">🙋 The assistant asked for a human${escalation && escalation.args && escalation.args.reason ? `: ${escapeHtml(escalation.args.reason)}` : ''}</p>` : ''
    ].join('');

    draftEl.innerHTML = `
      <div class="inbox-draft-head">
        <strong>🤖 AI draft — not sent</strong>
        <span class="pricing-muted">${escapeHtml(tools.length ? `used ${tools.join(', ')}` : 'no tools used')} · ${escapeHtml(String(draft.latency_ms ?? '–'))} ms</span>
      </div>
      ${warnings}${quoteLine}
      <textarea id="inbox-draft-body" rows="4" maxlength="4096" aria-label="Draft reply">${escapeHtml(draft.body)}</textarea>
      <div class="inbox-draft-actions">
        <button class="button primary" data-draft="approved" ${windowOpen ? '' : 'disabled'}>Approve &amp; send</button>
        <button class="button danger" data-draft="rejected">Reject</button>
        <span class="pricing-muted">Approving sends as you; the chat stays in AI mode.</span>
      </div>`;
    draftEl.dataset.draftId = String(draft.id);
    draftEl.classList.remove('hidden');
  }

  draftEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-draft]');
    if (!button) return;
    const draftId = draftEl.dataset.draftId;
    const decision = button.dataset.draft;
    const body = el('inbox-draft-body').value.trim();
    if (decision === 'approved' && !body) return;
    if (decision === 'rejected' && !confirm('Reject this AI draft?')) return;
    draftEl.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    act(decision === 'approved' ? 'Sending draft' : 'Rejecting draft', async () => {
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
    });
  });

  async function refresh() {
    try {
      await Promise.all([loadConversations(), loadAutomation()]);
      await loadThread();
    } catch (err) {
      statusEl.textContent = `Refresh failed: ${err.message}`;
    }
  }

  async function open() {
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
      statusEl.textContent = 'Your role cannot view conversations.';
      return;
    }
    statusEl.textContent = '';
    await refresh();
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!document.hidden && !section.classList.contains('hidden')) refresh();
    }, POLL_MS);
  }

  async function act(label, action) {
    statusEl.textContent = `${label}…`;
    try {
      await action();
      statusEl.textContent = '';
      await refresh();
    } catch (err) {
      statusEl.textContent = `${label} failed: ${err.message}`;
    }
  }

  listEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-convo]');
    if (!button) return;
    selectedId = Number(button.dataset.convo);
    renderedDraftId = null;
    renderConversations();
    threadEl.innerHTML = '';
    loadThread().then(() => { threadEl.scrollTop = threadEl.scrollHeight; });
  });

  headerEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-mode]');
    if (!button || !selectedId) return;
    const takeover = button.dataset.mode === 'takeover';
    if (!takeover && !confirm('Return this chat to AI? The bot may reply to this customer again.')) return;
    act(takeover ? 'Taking over' : 'Returning to AI', () =>
      workerFetch(`/admin/conversations/${selectedId}/${takeover ? 'takeover' : 'release'}`, {
        method: 'POST',
        body: JSON.stringify({ reason: takeover ? 'inbox_takeover' : 'inbox_release' })
      }));
  });

  automationEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-automation]');
    if (!button) return;
    const pause = button.dataset.automation === 'pause';
    if (!confirm(pause
      ? 'Pause ALL automated messages for every customer?'
      : 'Resume automation? Bots may message customers again (subject to all other checks).')) return;
    act(pause ? 'Pausing automation' : 'Resuming automation', () =>
      workerFetch(`/admin/automation/${pause ? 'pause' : 'resume'}`, { method: 'POST', body: '{}' }));
  });

  replyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = replyInput.value.trim();
    if (!text || !selectedId) return;
    const sendButton = replyForm.querySelector('button');
    sendButton.disabled = true;
    // Stable id per attempt makes a double-click or retry idempotent.
    const clientMessageId = replyForm.dataset.pendingId || crypto.randomUUID();
    replyForm.dataset.pendingId = clientMessageId;
    act('Sending', async () => {
      try {
        await workerFetch(`/admin/conversations/${selectedId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ body: text, client_message_id: clientMessageId })
        });
        replyInput.value = '';
        delete replyForm.dataset.pendingId;
      } catch (err) {
        // 502 = Meta rejected the send and it was recorded as failed; a retry
        // must be a new message. Other errors keep the id so retries dedupe.
        if (err.status === 502) delete replyForm.dataset.pendingId;
        throw err;
      } finally {
        sendButton.disabled = false;
      }
    });
  });
  replyInput.addEventListener('input', () => { delete replyForm.dataset.pendingId; });

  el('inbox-refresh').addEventListener('click', refresh);
  tabButton.addEventListener('click', open);
});
