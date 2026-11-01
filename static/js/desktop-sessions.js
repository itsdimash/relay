/** Relay observes original app sessions; it never submits a task to a provider. */
const NAMES = { codex: 'Codex', claude: 'Claude Code' };
const STATES = { working: 'Working', finished: 'Finished', idle: 'Idle', needs_approval: 'Needs approval', needs_attention: 'Needs attention', unknown: 'Last observed' };
function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  if (tag === 'pre') el.setAttribute('translate', 'no');
  return el;
}
function ago(timestamp) {
  const seconds = Math.max(0, Date.now() / 1000 - timestamp);
  return seconds < 60 ? 'just now' : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago` : `${Math.floor(seconds / 3600)} h ago`;
}
const ACTIVE_STATES = new Set(['working', 'needs_approval', 'needs_attention']);
export function preferredOfficeProvider(sessions, teamRun, fallback = 'team') {
  if (teamRun?.running && !teamRun.paused) return 'team';
  for (const provider of ['claude', 'codex']) {
    if (sessions.some(session => session.provider === provider && (ACTIVE_STATES.has(session.status) || session.requests?.length))) return provider;
  }
  return fallback;
}

export function createDesktopSessions(host, { post, changed, open, selected, attention }) {
  let provider = 'team', sessions = [], connections = {}, selectedId = '', busy = false, contentKey = '';
  let manualSelection = false, teamRun = null;
  const announced = new Set();
  function followActivity(reset = false) {
    if (reset) { manualSelection = false; selectedId = ''; }
    if (!manualSelection) {
      const preferred = preferredOfficeProvider(sessions, teamRun, provider);
      if (preferred !== provider) { provider = preferred; selectedId = ''; contentKey = ''; }
    }
  }
  const modes = element('div', undefined, 'desktop-modes'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Office mode');
  const body = element('div', undefined, 'desktop-body');
  const error = element('p', '', 'error'); error.setAttribute('role', 'alert');
  const requests = element('button', '', 'desktop-attention'); requests.type = 'button'; requests.hidden = true;
  const buttons = {};
  for (const [id, label] of [['team', 'Relay Team'], ['codex', 'Codex app'], ['claude', 'Claude app']]) {
    const button = element('button', label); button.type = 'button'; button.setAttribute('aria-pressed', String(provider === id));
    button.addEventListener('click', () => { manualSelection = true; provider = id; selectedId = ''; contentKey = ''; error.textContent = ''; draw(); });
    modes.append(button); buttons[id] = button;
  }
  requests.addEventListener('click', () => {
    const next = sessions.find(s => s.requests?.length);
    if (next) { manualSelection = true; provider = next.provider; selectedId = next.id; contentKey = ''; draw(); }
  });
  host.append(modes, requests, body, error);
  async function action(path, payload) {
    if (busy) return;
    manualSelection = true;
    busy = true; error.textContent = ''; host.setAttribute('aria-busy', 'true');
    for (const button of body.querySelectorAll('button')) button.disabled = true;
    try { await post(path, payload); await changed(); }
    catch (err) { error.textContent = err.message; }
    finally { busy = false; host.removeAttribute('aria-busy'); contentKey = ''; draw(); }
  }
  function draw() {
    for (const [id, button] of Object.entries(buttons)) button.setAttribute('aria-pressed', String(provider === id));
    body.hidden = provider === 'team';
    const matching = sessions.filter(s => s.provider === provider);
    const session = matching.find(s => s.id === selectedId) || matching.find(s => s.requests?.length) || matching.find(s => s.status === 'working') || matching[0];
    selected(provider, session);
    requests.hidden = !sessions.some(s => s.requests?.length && s.provider !== provider);
    if (provider === 'team') return;
    body.toggleAttribute('data-pending', !!session?.requests?.length);
    const connection = connections[provider] || {};
    const key = JSON.stringify([provider, session?.id, matching, connection, Math.floor(Date.now() / 60000)]);
    if (key === contentKey) return;
    contentKey = key; body.replaceChildren();
    const tools = element('div', undefined, 'desktop-toolbar');
    const openApp = element('button', `Open ${NAMES[provider]}`, 'btn quiet'); openApp.type = 'button'; openApp.addEventListener('click', () => open(provider));
    tools.append(openApp);
    if (matching.length > 1 && !session?.requests?.length) {
      const picker = element('select'); picker.setAttribute('aria-label', 'App session');
      for (const row of matching) picker.append(new Option(`${STATES[row.status] || 'Last observed'} · ${row.title}`, row.id));
      picker.value = session.id; picker.addEventListener('change', () => { manualSelection = true; selectedId = picker.value; contentKey = ''; draw(); }); body.append(picker);
    }
    if (session) {
      const heading = element('strong', session.title, 'desktop-title'); heading.setAttribute('translate', 'no');
      const project = element('span', session.project.split('/').filter(Boolean).pop() || 'App session', 'desktop-meta'); project.title = session.project;
      const status = element('div', undefined, 'desktop-session-status'); status.dataset.state = session.status;
      status.append(element('strong', STATES[session.status] || 'Last observed'), project, element('span', ago(session.updated), 'desktop-meta'), tools);
      body.append(heading, status);
      if (session.activity) body.append(element('p', session.activity, 'desktop-activity'));
      for (const request of session.requests || []) {
        const card = element('div', undefined, 'desktop-request');
        card.append(element('strong', 'Approve this action?'), element('p', request.tool));
        const preview = request.details.command || request.details.file_path || request.details.path || request.details.host || request.details.url;
        if (preview) card.append(element('pre', typeof preview === 'string' ? preview : JSON.stringify(preview)));
        const details = element('details'); details.append(element('summary', 'Action details'), element('pre', JSON.stringify(request.details, null, 2))); card.append(details);
        for (const [decision, label] of [['reject', 'Reject'], ['approve', 'Approve once'], ['app', 'Answer in app']]) {
          const button = element('button', label, `btn ${decision === 'approve' ? 'primary' : 'quiet'}`); button.type = 'button'; button.disabled = busy;
          button.addEventListener('click', () => {
            if (decision === 'app') open(provider);
            action('/api/desktop/decide', { request_id: request.id, decision });
          }); card.append(button);
        }
        body.append(card);
      }
    } else {
      body.append(tools);
      body.append(element('strong', `No ${NAMES[provider]} activity in the last 20 minutes`, 'desktop-title'));
      body.append(element('p', 'Keep using the original app. Recent local sessions will appear here.', 'desktop-help'));
    }
    if (connection.problem) body.append(element('p', connection.problem, 'desktop-help'));
    if (!connection.installed) {
      const setup = element('div', undefined, 'desktop-setup');
      setup.append(element('p', 'Enable live updates and supported approvals.', 'desktop-help'));
      const connect = element('button', 'Enable live connection', 'btn quiet'); connect.type = 'button'; connect.disabled = busy;
      connect.addEventListener('click', () => action('/api/desktop/connect', { provider, enabled: true })); setup.append(connect); body.append(setup);
    } else {
      const setup = element('details', undefined, 'desktop-setup');
      setup.append(element('summary', connection.last_event ? 'Live connection enabled' : 'Finish connecting'));
      setup.append(element('p', provider === 'codex' ? 'Review the Relay hooks in Codex with /hooks, then start a new app session.' : 'Start a new Code session in the Claude app to load the connection.', 'desktop-help'));
      const disconnect = element('button', 'Disconnect live updates', 'btn quiet'); disconnect.type = 'button'; disconnect.disabled = busy;
      disconnect.addEventListener('click', () => action('/api/desktop/connect', { provider, enabled: false })); setup.append(disconnect); body.append(setup);
    }
  }
  return {
    activate() { followActivity(true); draw(); },
    update(data, run = null) {
    sessions = data?.sessions || []; connections = data?.connections || {};
    teamRun = run;
    followActivity();
    const pending = sessions.flatMap(s => (s.requests || []).map(r => ({ session: s, request: r })));
    requests.textContent = `${pending.length} ${pending.length === 1 ? 'approval needs' : 'approvals need'} you`;
    for (const { session, request } of pending) if (!announced.has(request.id)) {
      announced.add(request.id); host.scrollTop = 0; attention(session);
    }
    draw();
  } };
}
