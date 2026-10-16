// Learn tab: the WhatsApp assistant's knowledge base. Staff add short facts;
// the AI suggests lessons from chats a team member handled. The assistant
// uses only PUBLISHED facts, and only admins publish. Reads use staff RLS;
// every write goes through the role-checked Worker API.
document.addEventListener('DOMContentLoaded', () => {
  const env = window.SMARTCAP_ENV;
  const tabButton = document.getElementById('knowledge-tab-btn');
  const section = document.getElementById('knowledge-tab');
  if (!env || !tabButton || !section) return;
  if (!env.workerUrl) {
    tabButton.remove();
    section.remove();
    return;
  }

  const { escapeHtml, workerFetch, staffProfile } = window.SmartcapWorker;
  const list = document.getElementById('kb-list');
  const statusEl = document.getElementById('kb-status');
  const roleEl = document.getElementById('kb-role');
  const filterEl = document.getElementById('kb-filter');
  const searchEl = document.getElementById('kb-search');
  const countsEl = document.getElementById('kb-counts');
  const addForm = document.getElementById('kb-add');

  let entries = [];
  let canEdit = false;
  let canPublish = false;
  let editingId = null;
  let loaded = false;

  const ERRORS = {
    knowledge_contains_price: 'Remove prices and amounts. The assistant only takes prices from the Prices tab.',
    knowledge_contains_percentage: 'Remove percentages. Deposits and add-ons come from the Prices tab.',
    knowledge_contains_phone_number: 'Remove phone or account numbers.',
    knowledge_contains_email: 'Remove email addresses.',
    knowledge_contains_link: 'Remove links. The assistant shares only the verified business links.',
    knowledge_published_requires_publisher: 'Only an admin can change a published fact.',
    invalid_knowledge: 'The question needs 3–120 characters and the answer 3–1000.'
  };
  const explain = (err) => ERRORS[err.message] || err.message;

  const STATUS_LABEL = {
    suggested: 'Suggested by AI', draft: 'Draft', published: 'Live', archived: 'Archived', rejected: 'Rejected'
  };

  async function load() {
    statusEl.textContent = 'Loading…';
    try {
      const me = await staffProfile();
      canEdit = me.permissions.includes('knowledge.edit');
      canPublish = me.permissions.includes('knowledge.publish');
      roleEl.textContent = canPublish ? '' : 'You can add drafts; an admin makes them live.';
      if (!canEdit) {
        statusEl.textContent = 'Your role cannot manage the knowledge base.';
        addForm.hidden = true;
        return;
      }
    } catch (err) {
      statusEl.textContent = err.status === 403
        ? 'This account has no staff role. Ask an admin to assign one.'
        : `Could not verify your role: ${err.message}`;
      return;
    }
    addForm.querySelector('[data-publish]').hidden = !canPublish;

    const { data, error } = await window.supabaseClient
      .from('knowledge_entries')
      .select('id, topic, answer, keywords, status, source, source_conversation_id, version, updated_at')
      .order('updated_at', { ascending: false });
    if (error) {
      statusEl.textContent = `Error loading knowledge: ${error.message}`;
      return;
    }
    entries = data;
    if (!loaded && entries.some((e) => e.status === 'suggested')) filterEl.value = 'suggested';
    loaded = true;
    statusEl.textContent = '';
    render();
  }

  function editForm(entry) {
    return `
      <form class="kb-form" data-edit-form="${entry.id}">
        <input name="topic" maxlength="120" required value="${escapeHtml(entry.topic)}" aria-label="Customer question">
        <textarea name="answer" maxlength="1000" rows="3" required aria-label="Answer">${escapeHtml(entry.answer)}</textarea>
        <input name="keywords" maxlength="300" value="${escapeHtml(entry.keywords)}" placeholder="Search words (optional)" aria-label="Keywords">
        <div class="kb-form-actions">
          ${canPublish ? '<button class="button primary" value="publish">Save &amp; make live</button>' : ''}
          ${entry.status !== 'published' ? '<button class="button" value="save">Save draft</button>' : ''}
          <button type="button" class="button" data-cancel>Cancel</button>
        </div>
      </form>`;
  }

  function actions(entry) {
    const buttons = [];
    if (canPublish && ['suggested', 'draft', 'archived'].includes(entry.status)) {
      buttons.push(`<button class="button primary" data-review="publish" data-id="${entry.id}">${entry.status === 'archived' ? 'Make live again' : 'Approve'}</button>`);
    }
    if (canEdit && (entry.status !== 'published' || canPublish)) {
      buttons.push(`<button class="button" data-edit="${entry.id}">Edit</button>`);
    }
    if (canPublish && ['suggested', 'draft'].includes(entry.status)) {
      buttons.push(`<button class="button danger" data-review="reject" data-id="${entry.id}">Reject</button>`);
    }
    if (canPublish && entry.status === 'published') {
      buttons.push(`<button class="button danger" data-review="archive" data-id="${entry.id}">Turn off</button>`);
    }
    return buttons.join('');
  }

  function render() {
    const counts = {};
    entries.forEach((e) => { counts[e.status] = (counts[e.status] || 0) + 1; });
    countsEl.textContent = `${counts.published || 0} live · ${counts.suggested || 0} suggested · ${counts.draft || 0} drafts`;

    const filter = filterEl.value;
    const query = searchEl.value.trim().toLowerCase();
    const rows = entries.filter((e) =>
      (filter === 'all' || e.status === filter || (filter === 'off' && ['archived', 'rejected'].includes(e.status))) &&
      (!query || `${e.topic} ${e.answer} ${e.keywords}`.toLowerCase().includes(query)));

    if (rows.length === 0) {
      list.innerHTML = `<p class="pricing-muted">${filter === 'suggested'
        ? 'No suggestions waiting. When a team member answers a chat and hands it back to the AI, useful facts appear here.'
        : 'Nothing here yet.'}</p>`;
      return;
    }
    list.innerHTML = rows.map((entry) => `
      <article class="pricing-row kb-row">
        <div class="pricing-main">
          <h3>${escapeHtml(entry.topic)}</h3>
          <p class="kb-answer">${escapeHtml(entry.answer)}</p>
          <p class="pricing-meta">
            <span class="pricing-badge pricing-badge--${entry.status === 'published' ? 'approved' : escapeHtml(entry.status)}">${escapeHtml(STATUS_LABEL[entry.status] || entry.status)}</span>
            ${entry.source === 'ai_suggestion' && entry.source_conversation_id
              ? ` · from <a href="?tab=inbox&amp;c=${Number(entry.source_conversation_id)}">this chat</a>` : ''}
            ${entry.keywords ? ` · ${escapeHtml(entry.keywords)}` : ''}
            · v${Number(entry.version)}
          </p>
        </div>
        <div class="pricing-actions">${actions(entry)}</div>
      </article>
      ${editingId === entry.id ? editForm(entry) : ''}`).join('');
  }

  async function saveEntry(id, form, publish) {
    const f = Object.fromEntries(new FormData(form).entries());
    const path = id ? `/admin/knowledge/${id}` : '/admin/knowledge';
    const result = await workerFetch(path, {
      method: 'POST',
      body: JSON.stringify({ topic: f.topic, answer: f.answer, keywords: f.keywords || '', publish })
    });
    statusEl.textContent = result.status === 'published' ? 'Saved. The assistant can use it now.' : 'Saved as a draft.';
  }

  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const publish = event.submitter && event.submitter.dataset.publish !== undefined;
    try {
      await saveEntry(null, addForm, publish);
      addForm.reset();
      await load();
    } catch (err) {
      statusEl.textContent = `Not saved: ${explain(err)}`;
    }
  });

  list.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-edit-form]');
    if (!form) return;
    event.preventDefault();
    try {
      await saveEntry(Number(form.dataset.editForm), form, event.submitter && event.submitter.value === 'publish');
      editingId = null;
      await load();
    } catch (err) {
      statusEl.textContent = `Not saved: ${explain(err)}`;
    }
  });

  list.addEventListener('click', async (event) => {
    if (event.target.closest('[data-cancel]')) {
      editingId = null;
      render();
      return;
    }
    const edit = event.target.closest('[data-edit]');
    if (edit) {
      editingId = Number(edit.dataset.edit);
      render();
      return;
    }
    const button = event.target.closest('[data-review]');
    if (!button) return;
    const entry = entries.find((e) => e.id === Number(button.dataset.id));
    const decision = button.dataset.review;
    const question = {
      publish: 'Make this live? The WhatsApp assistant will start using it in replies.',
      reject: 'Reject this suggestion?',
      archive: 'Turn this off? The assistant stops using it immediately.'
    }[decision];
    if (!entry || !confirm(`${question}\n\n${entry.topic}\n${entry.answer}`)) return;
    button.disabled = true;
    try {
      await workerFetch(`/admin/knowledge/${entry.id}/review`, { method: 'POST', body: JSON.stringify({ decision }) });
      statusEl.textContent = '';
      await load();
    } catch (err) {
      statusEl.textContent = `Could not update: ${explain(err)}`;
      button.disabled = false;
    }
  });

  filterEl.addEventListener('change', () => loaded && render());
  searchEl.addEventListener('input', () => loaded && render());
  document.getElementById('kb-refresh').addEventListener('click', load);
  tabButton.addEventListener('click', () => { if (!loaded) load(); });
});
