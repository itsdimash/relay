/** Notch panel: polls the local engine for the active task and shows it, with music, notes, files to deliver and the agent office. */
import { createRoom } from './js/notch-room.js';
import { limitRow } from './js/limits.js';
import { createDesktopSessions } from './js/desktop-sessions.js';
import { createCollaboration } from './js/notch-collaboration.js';
import { createActivity } from './js/notch-activity.js';
import { createMusicFx, STYLES, DEFAULT_STYLE, isStyle } from './js/notch-music-fx.js';
import { createBatteryWatcher } from './js/notch-battery.js';
import { VOICE_KEY, LANGUAGE_KEY, WAKE_KEY, speechLocale, otherLanguage, languageCode, joinSpeech, spokenCommand, voiceProblem, wakeProblem } from './js/notch-voice.js';
import { SPEAK_KEY, speakMode, shouldSpeak, languageOf, lineForRun, lineForReminder, remember } from './js/notch-speech.js';
import { routeCommand, VIEW_NAMES, briefFor, pickProject, teamFor, fitMode, typedText } from './js/notch-commands.js';
import { createTranslator } from './js/notch-translate.js';
import { parseReminder, dueLabel, createReminderWatcher, quickChoices, startingMoment, stepMoment, canSet, dayLabel, hourText, minuteText } from './js/notch-reminders.js';

const $ = id => document.getElementById(id);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const room = createRoom($('room'), { reducedMotion });
const native = window.webkit?.messageHandlers?.relayPanel;
const tell = message => {
  try {
    native?.postMessage(message);
  } catch (_) {
    /* Running in a normal browser. */
  }
};
const openRun = destination => {
  if (native) tell({ type: 'open', ...destination });
  else window.open('/#' + new URLSearchParams({ run: destination.runId, tab: destination.tab, step: destination.step }), '_blank', 'noopener');
};
const collaboration = createCollaboration({ reducedMotion, openRun });
const activity = createActivity({ post: postTracked, openRun });

// Music animation (drawn by js/notch-music-fx.js): behind the Music view, beside its title, and in the track-change pill.
// "Customize" (or the animation next to the title) opens a small picker with two tabs: the animation in the panel, and, in
// the app, the light around the notch on the screen, which the app itself draws and remembers.
const fx = createMusicFx({ reducedMotion });
const rectOf = (canvas, element, radius) => () => {
  const area = canvas.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  return box.width ? { x: box.left - area.left, y: box.top - area.top, w: box.width, h: box.height, r: radius } : null;
};
fx.attach($('musicFx'), { kind: 'stage', anchor: rectOf($('musicFx'), document.querySelector('#music .cover'), 14) });
fx.attach($('musicMini'), { kind: 'mini' });
fx.attach($('pillFx'), { kind: 'pill' });
let fxStyle = DEFAULT_STYLE;
try {
  const saved = localStorage.getItem('relay.musicFx');
  if (isStyle(saved)) fxStyle = saved;
} catch (_) {}
fx.setStyle(fxStyle);
$('panel').dataset.fx = fxStyle;

const GLOWS = [{ id: 'off', name: 'Off' }, { id: 'line', name: 'Line' }, { id: 'halo', name: 'Halo' }, { id: 'sparks', name: 'Sparks' }];
let glowStyle = 'line'; // the app keeps the real choice and tells us through relayGlowStyle
let fxTab = 'panel';
const fxTiles = { panel: new Map(), screen: new Map() };

function offPreview() {
  const preview = document.createElement('span');
  preview.className = 'fx-none';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 10h8');
  svg.append(path);
  preview.append(svg);
  return preview;
}

function addTile(group, grid, id, name, preview, choose) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'fx-tile';
  tile.setAttribute('role', 'radio');
  const label = document.createElement('span');
  label.textContent = name;
  tile.append(preview, label);
  tile.addEventListener('click', choose);
  $(grid).append(tile);
  fxTiles[group].set(id, tile);
}

function previewCanvas(style) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  fx.attach(canvas, { kind: 'tile', style });
  return canvas;
}

for (const { id, name } of STYLES) addTile('panel', 'fxGridPanel', id, name, id === 'off' ? offPreview() : previewCanvas(id), () => chooseFx(id));
for (const { id, name } of GLOWS) addTile('screen', 'fxGridScreen', id, name, id === 'off' ? offPreview() : previewCanvas(`glow-${id}`), () => chooseGlow(id));
$('fxTabs').hidden = !native; // the light on the screen belongs to the app: nothing to choose in a normal browser

function paintFxChoice() {
  for (const [group, chosen] of [['panel', fxStyle], ['screen', glowStyle]]) {
    for (const [id, tile] of fxTiles[group]) {
      tile.setAttribute('aria-checked', String(id === chosen));
      tile.tabIndex = id === chosen ? 0 : -1;
    }
  }
  $('panel').dataset.fx = fxStyle;
}

function setFxTab(name) {
  fxTab = name === 'screen' && native ? 'screen' : 'panel';
  for (const [tab, grid, key] of [['fxTabPanel', 'fxGridPanel', 'panel'], ['fxTabScreen', 'fxGridScreen', 'screen']]) {
    $(tab).setAttribute('aria-selected', String(fxTab === key));
    $(tab).tabIndex = fxTab === key ? 0 : -1;
    $(grid).hidden = fxTab !== key;
  }
  fx.refresh(); // the previews that just appeared start moving
}

function setFxPicker(open) {
  const picker = $('fxPicker');
  if (open === !picker.hidden) return;
  picker.hidden = !open;
  for (const id of ['fxOpen', 'fxCustomize']) $(id).setAttribute('aria-expanded', String(open));
  fx.setPicker(open);
  if (open) {
    setFxTab(fxTab);
    const tiles = fxTiles[fxTab];
    tiles.get(fxTab === 'panel' ? fxStyle : glowStyle)?.focus({ preventScroll: true });
  }
}

function closeSoon() {
  setTimeout(() => {
    if ($('fxPicker').contains(document.activeElement)) fxOpener.focus({ preventScroll: true });
    setFxPicker(false);
  }, 240);
}

function chooseFx(id) {
  fxStyle = id;
  try {
    localStorage.setItem('relay.musicFx', id);
  } catch (_) {}
  fx.setStyle(id);
  paintFxChoice();
  closeSoon();
}

function chooseGlow(id) {
  glowStyle = id;
  paintFxChoice();
  tell({ type: 'glowStyle', style: id });
  closeSoon();
}

// The app tells us which glow is saved, when the page loads and whenever it changes.
window.relayGlowStyle = style => {
  if (!GLOWS.some(glow => glow.id === style)) return;
  glowStyle = style;
  paintFxChoice();
};

paintFxChoice();
setFxTab('panel');
// Two ways in, the animation next to the title and the Customize button; both open the same picker.
let fxOpener = $('fxOpen');
for (const id of ['fxOpen', 'fxCustomize']) {
  $(id).addEventListener('click', () => {
    fxOpener = $(id);
    setFxPicker($('fxPicker').hidden);
  });
}
$('fxClose').addEventListener('click', () => {
  setFxPicker(false);
  fxOpener.focus({ preventScroll: true });
});
$('fxTabPanel').addEventListener('click', () => setFxTab('panel'));
$('fxTabScreen').addEventListener('click', () => setFxTab('screen'));
document.addEventListener('pointerdown', event => {
  if (!$('fxPicker').hidden && !event.target.closest('#fxPicker, #fxOpen, #fxCustomize')) setFxPicker(false);
});
// Capture phase: Escape closes the picker first, and only a second Escape hides the whole panel.
document.addEventListener('keydown', event => {
  if ($('fxPicker').hidden) return;
  if (event.key === 'Escape') {
    event.stopPropagation();
    setFxPicker(false);
    fxOpener.focus({ preventScroll: true });
    return;
  }
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  if (document.activeElement?.classList.contains('fx-tab')) {
    if (!$('fxTabs').hidden) {
      setFxTab(fxTab === 'panel' ? 'screen' : 'panel');
      $(fxTab === 'panel' ? 'fxTabPanel' : 'fxTabScreen').focus({ preventScroll: true });
    }
    return;
  }
  const tiles = [...fxTiles[fxTab].values()];
  const at = tiles.indexOf(document.activeElement);
  tiles[(at + step + tiles.length) % tiles.length].focus({ preventScroll: true });
}, true);

const LINES = {
  idle: ['Relay is idle', 'Your agents are waiting for a task.'],
  queued: ['Starting', 'Getting ready.'],
  preparing: ['Preparing', 'Making a safe copy of your project.'],
  observing: ['Observer is inspecting', 'Reading your project and planning the change.'],
  awaiting_clarification: ['Needs your answers', 'The Observer has a few questions.'],
  awaiting_approval: ['Needs your approval', 'Nothing is edited until you approve.'],
  building: ['Builder is working', 'Editing your folder.'],
  fixing: ['Builder is refining', 'Applying the reviewer’s findings.'],
  reviewing: ['Reviewer is checking', 'Reading the actual changes.'],
  done: ['Finished', 'The result is ready in Relay.'],
  needs_attention: ['Needs attention', 'Open Relay to see what happened.'],
  failed: ['Stopped with an error', 'Open Relay to see what happened.'],
  stopped: ['Stopped', 'The task was stopped.'],
  interrupted: ['Interrupted', 'Open Relay to continue the task.']
};

let token = '';
let current = null;
let elapsedBase = 0;
let elapsedAt = 0;
let notified = '';
let busy = false;
let view = 'notes';
// The tab the person picked last. The first opening after the app starts is the Notes; after that the panel comes back to this.
let chosenView = 'notes';
let mode = 'compact'; // pill | compact | full, set by the app
const VIEWS = ['music', 'notes', 'deliver', 'translate', 'task', 'office'];
let notes = [];
let deliver = [];
let noteBusy = false;
let shownNotes = null; // ids of the notes drawn last time (null before the first draw, so the first list does not animate)
let inputFocused = false;
let holding = false;
const voice = { on: false, latched: false, base: '', pressedAt: 0, target: 'note' }; // the microphone: on while it is listening
const wake = { hearing: false, sent: null, announce: false }; // "Hey Relay": the person has said it and the request is being heard
const ask = { open: false, mode: 'build', agent: '', team: null, busy: false, resizing: false }; // a spoken request for the agents, waiting for a yes
const typing = { open: false, app: '' };   // spoken words to type into another app, waiting for a yes
let openingApp = null;                      // the app that was asked for, in case no app has that name
let music = null;
let musicArt = '';
let musicTrack = '';
let officeMusicEnabled = true;
try { officeMusicEnabled = localStorage.getItem('relay.officeMusic') !== 'off'; } catch (_) {}
$('officeMusic').setAttribute('aria-pressed', String(officeMusicEnabled));
$('officeMusic').addEventListener('click', () => {
  officeMusicEnabled = !officeMusicEnabled;
  $('officeMusic').setAttribute('aria-pressed', String(officeMusicEnabled));
  try { localStorage.setItem('relay.officeMusic', officeMusicEnabled ? 'on' : 'off'); } catch (_) {}
  room.setMusic(!!music?.playing && officeMusicEnabled);
});

const format = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

function actorKey(run) {
  if (!run) return 'idle';
  if (run.status === 'done') return 'done';
  if (['failed', 'needs_attention', 'stopped', 'interrupted'].includes(run.status)) return 'failed';
  return run.actor || 'idle';
}

function render(run) {
  const key = actorKey(run);
  $('panel').dataset.actor = key;
  for (const label of document.querySelectorAll('[data-room-role]')) {
    const active = label.dataset.roomRole === key;
    label.toggleAttribute('data-active', active);
    if (active) label.setAttribute('aria-current', 'step');
    else label.removeAttribute('aria-current');
  }
  $('panel').toggleAttribute('data-working', !!run?.running && !run.paused);
  $('panel').toggleAttribute('data-attention', !!run?.running && (!!run.plan || run.status === 'awaiting_clarification'));
  tabs.task.toggleAttribute('data-live', !!run?.running && !run.paused);
  updateGlow();
  const [status, line] = LINES[run?.status] || LINES.idle;
  $('status').textContent = run?.paused ? 'Paused' : status;
  $('title').textContent = run ? run.title || 'Task' : 'Nothing running';
  $('roomLabel').textContent = run?.running ? (run.demo ? 'Example run. No real agents are called.' : line) : run ? line : LINES.idle[1];
  $('steps').replaceChildren(...(run?.steps || []).map(item => {
    const li = document.createElement('li');
    li.className = item.state;
    li.textContent = item.label;
    return li;
  }));
  const stepIndex = (run?.steps || []).findIndex(item => item.state === 'current');
  $('stepText').textContent = run?.steps?.length && stepIndex >= 0 ? `Step ${stepIndex + 1} of ${run.steps.length} · ${run.steps[stepIndex].label}` : '';
  const last = run?.last;
  $('last').replaceChildren();
  if (last && run.running) {
    const who = document.createElement('strong');
    who.textContent = last.agent ? `${last.agent}: ` : '';
    $('last').append(who, last.message);
  } else if (run && !run.running && run.summary) {
    $('last').textContent = run.summary;
  }
  const plan = run?.plan;
  $('approval').hidden = !plan;
  if (plan) $('panel').dataset.plan = '1';
  else delete $('panel').dataset.plan;
  if (plan && (view === 'notes' || view === 'music')) setView('task');
  if (plan) {
    $('planSummary').textContent = plan.summary;
    $('planChecks').replaceChildren(...plan.checks.map(check => {
      const li = document.createElement('li');
      li.textContent = check;
      return li;
    }));
  }
  if (!plan) $('approvalError').textContent = '';
  room.setScene({ actor: run?.running && !run.paused ? run.actor : null, terminal: key === 'done' ? 'done' : key === 'failed' ? 'failed' : null, id: run?.id, auto: !!run?.auto, steps: run?.steps || [] });
  elapsedBase = run?.running ? run.elapsed : 0;
  elapsedAt = Date.now();
  tickTimer();
  collaboration.update(run);
}

function tickTimer() {
  $('timer').textContent = current?.running ? format(elapsedBase + Math.floor((Date.now() - elapsedAt) / 1000)) : '';
}

// Ask the app to bring the panel forward once per thing that needs attention or finishes.
let firstSnapshot = true;
let held = false;

function notifyNative(run) {
  if (!run || run.demo) return;
  const needsYou = !!run.plan || run.status === 'awaiting_clarification';
  let key = '';
  if (run.plan) key = `approve:${run.plan.id}`;
  else if (run.status === 'awaiting_clarification') key = `clarify:${run.id}`;
  else if (!run.running) key = `${run.status}:${run.id}`;
  if (held && !needsYou) {
    held = false;
    tell({ type: 'settle' });
  }
  const startup = firstSnapshot;
  firstSnapshot = false;
  if (!key || key === notified) return;
  notified = key;
  // A task that finished before the app opened is old news; one that waits for the person is not.
  if (startup && !needsYou) return;
  held = needsYou;
  if (view !== 'office' && !(view === 'notes' && inputFocused)) setView('task');
  tell({ type: 'attention', keep: needsYou });
}

// The Office defaults to 5 hours. Only the selected window controls its bar and colour.
let limitsKey = '';
let officeLimitWindow = 'session';
let latestLimits = null;
try { if (localStorage.getItem('relay.officeLimitWindow') === 'week') officeLimitWindow = 'week'; } catch (_) {}
function renderLimits(limits) {
  if (!limits) return;
  latestLimits = limits;
  const { now, ...readings } = limits;
  const key = JSON.stringify([officeLimitWindow, readings, Math.floor(now / 60)]);
  if (key === limitsKey) return;
  limitsKey = key;
  const controls = document.createElement('div');
  controls.className = 'limit-period';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Usage period');
  const label = document.createElement('span');
  label.textContent = 'Limits';
  controls.append(label);
  for (const [period, text] of [['session', '5h'], ['week', 'Weekly']]) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = text;
    button.setAttribute('aria-pressed', String(officeLimitWindow === period));
    button.addEventListener('click', () => {
      officeLimitWindow = period;
      try { localStorage.setItem('relay.officeLimitWindow', period); } catch (_) {}
      renderLimits(latestLimits);
    });
    controls.append(button);
  }
  const empty = officeLimitWindow === 'session' ? 'no 5h reading' : 'no weekly reading';
  $('limits').replaceChildren(
    controls,
    limitRow(document, 'Claude', readings.claude, now, empty, officeLimitWindow),
    limitRow(document, 'Codex', readings.codex, now, empty, officeLimitWindow)
  );
  if (!readings.claude || readings.claude.stale) {
    const notice = document.createElement('div'); notice.className = 'limit-notice';
    const message = document.createElement('span');
    message.textContent = "Claude usage is refreshing or unavailable. Open Claude to check.";
    const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Open Claude';
    open.addEventListener('click', () => tell({ type: 'open-provider', provider: 'claude' }));
    notice.append(message, open); $('limits').append(notice);
  }
}

// Banners that drop in from the notch. Music has its own animations and is not announced here.
const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/></svg>',
  help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.6 2.6 0 1 1 3.6 2.4c-.8.4-1.2 1-1.2 1.9M12 17h.01"/></svg>',
  check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path class="draw" d="M7.5 12.5l3 3 6-6.5"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 4l9 16H3zM12 10v4M12 17h.01"/></svg>',
  cross: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
  sync: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.5-4M4 13a8 8 0 0 0 14.5 4M4 4.5V8h3.5M20 19.5V16h-3.5"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 3 5.5 13.5H11L10 21l7.5-10.5H12z"/></svg>',
  battery: '<svg viewBox="0 0 24 24"><rect x="3" y="8" width="16" height="9" rx="2.2"/><path d="M21.5 11v3M6.5 11.5v2"/></svg>'
};
const TOASTS = {
  start: { icon: 'play' }, approve: { icon: 'bell' }, question: { icon: 'help' }, approved: { icon: 'check' },
  done: { icon: 'check', burst: true }, attention: { icon: 'alert' }, failed: { icon: 'cross' }, retry: { icon: 'sync' }, decision: { icon: 'spark' },
  charging: { icon: 'bolt' }, lowbattery: { icon: 'battery' }, reminder: { icon: 'bell' }
};
let toastTimer = null;
let toastLeave = null;
let flashTimer = null;
function toast(kind, title, detail = '') {
  const spec = TOASTS[kind];
  if (!spec) return;
  clearTimeout(toastTimer);
  clearTimeout(toastLeave);
  const box = $('toast');
  box.hidden = false;
  box.dataset.kind = kind;
  box.removeAttribute('data-show');
  box.removeAttribute('data-leaving');
  $('toastIcon').innerHTML = ICONS[spec.icon];
  $('toastTitle').textContent = title;
  $('toastDetail').textContent = detail;
  $('toastDetail').hidden = !detail;
  void box.offsetWidth; // restart the entrance animation
  box.setAttribute('data-show', '');
  $('panel').dataset.flash = kind;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => delete $('panel').dataset.flash, 1400);
  const burst = $('toastBurst');
  burst.replaceChildren();
  if (spec.burst && !reducedMotion) {
    const colors = ['#4fb594', '#f0a63f', '#a18bf0', '#4db6c9', '#fff6c2'];
    for (let i = 0; i < 22; i++) {
      const angle = (i / 22) * Math.PI * 2 + Math.random() * 0.4;
      const distance = 50 + Math.random() * 70;
      const dot = document.createElement('i');
      dot.style.setProperty('--dx', `${Math.cos(angle) * distance * 1.5}px`);
      dot.style.setProperty('--dy', `${Math.sin(angle) * distance * 0.8 + 24}px`);
      dot.style.setProperty('--rot', `${Math.round(Math.random() * 540 - 270)}deg`);
      dot.style.setProperty('--c', colors[i % colors.length]);
      burst.append(dot);
    }
  }
  toastTimer = setTimeout(() => {
    box.setAttribute('data-leaving', '');
    toastLeave = setTimeout(() => { box.hidden = true; box.removeAttribute('data-show'); box.removeAttribute('data-leaving'); burst.replaceChildren(); }, reducedMotion ? 0 : 280);
  }, spec.burst ? 4200 : 3400);
}

// Battery: the engine reads it from macOS. The person can turn the alerts off in the Relay window (Notch menu).
const batteryAlertsOn = () => {
  try {
    return localStorage.getItem('relay.batteryAlerts') !== 'off';
  } catch (_) {
    return true;
  }
};
const batteryWatcher = createBatteryWatcher({
  enabled: batteryAlertsOn,
  announce: message => {
    toast(message.kind, message.title, message.detail);
    tell({ type: 'attention', keep: false }); // the panel peeks out for a moment
  }
});

// Reminders: a note with a time ("in 30 min", "tomorrow at 9:00") is kept by the engine, which says on every poll which ones
// are due. The panel slides out on the Notes for a few seconds, longer than for other banners.
const reminderWatcher = createReminderWatcher({
  announce: message => {
    toast(message.kind, message.title, message.detail);
    if (speechMode() === 'all') speak(lineForReminder(message, translated));
    if (current?.plan) tell({ type: 'attention', keep: true }); // a plan waiting for an answer needs the big panel anyway
    else tell({ type: 'reminder' });                           // otherwise the small panel opens on the Notes for a while
    loadNotes();
  },
  acknowledge: ids => post('/api/notes/reminded', { ids }).then(result => { if (Array.isArray(result.notes)) { notes = result.notes; renderNotes(); } })
});

const announced = { id: '', status: '', event: -1, first: true };
const brief = (text, limit = 90) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit - 1).trimEnd() + '…' : flat;
};
function announce(run) {
  if (!run || run.demo) {
    announced.id = '';
    return;
  }
  const events = run.recent_events || [];
  const newest = events.reduce((highest, event) => Math.max(highest, Number(event.id)), -1);
  const startup = announced.first;
  announced.first = false;
  if (run.id !== announced.id) {
    // A different task: remember where it stands and say hello, unless the app only just opened.
    announced.id = run.id;
    announced.status = run.status;
    announced.event = newest;
    if (run.running && !startup) {
      toast('start', run.auto ? 'Auto mode started' : 'Task started', brief(run.title));
      room.pulse('start');
    }
    return;
  }
  for (const event of [...events].reverse()) {
    if (Number(event.id) <= announced.event) continue;
    const message = event.message || '';
    const retry = message.match(/Retrying in (\d+) seconds \(try (\d+) of (\d+)\)/);
    if (event.kind === 'control' && /^Auto mode approved the plan/.test(message)) {
      toast('approved', 'Plan approved', 'Auto mode approved it. The Builder is starting.');
      room.pulse('approved');
    } else if (event.kind === 'control' && /^Auto mode decided/.test(message)) {
      toast('decision', 'Auto mode decided', brief(message.replace(/^Auto mode decided\s*/, ''), 110));
      room.pulse('decision');
    } else if (retry) {
      toast('retry', 'Retrying after an error', `In ${retry[1]} seconds · try ${retry[2]} of ${retry[3]}`);
      room.pulse('retry');
    }
  }
  announced.event = Math.max(announced.event, newest);
  if (run.status === announced.status) return;
  const previous = announced.status;
  announced.status = run.status;
  speakRun(run);
  if (run.status === 'awaiting_approval') toast('approve', 'Needs your approval', 'Nothing is edited until you approve.');
  else if (run.status === 'awaiting_clarification') toast('question', 'Needs your answers', 'The Observer has a few questions.');
  else if (previous === 'awaiting_approval' && ['building', 'preparing'].includes(run.status)) {
    toast('approved', 'Plan approved', 'The Builder is starting.');
    room.pulse('approved');
  } else if (run.status === 'done') {
    const files = run.result?.files;
    toast('done', run.accepted ? 'Finished with open items' : 'Finished', Number.isInteger(files) && files > 0 ? `${files} changed ${files === 1 ? 'file' : 'files'} · ready to review` : 'The result is ready in Relay.');
  } else if (run.status === 'needs_attention') toast('attention', 'Needs your decision', 'Open Relay to see what is left.');
  else if (run.status === 'failed') toast('failed', 'Stopped with an error', brief(run.summary) || 'Open Relay to see what happened.');
}

const desktopOffice = createDesktopSessions($('desktopOffice'), {
  post, changed: () => poll(),
  open: provider => tell({ type: 'open-provider', provider }),
  attention: session => {
    toast('approve', `${session.provider === 'codex' ? 'Codex' : 'Claude Code'} needs you`, session.title);
    tell({ type: 'expand', view: 'office' });
  },
  selected: (provider, session) => {
    $('panel').toggleAttribute('data-desktop', provider !== 'team');
    if (provider === 'team') {
      for (const el of document.querySelectorAll('[data-room-role]')) {
        const role = el.dataset.roomRole;
        el.replaceChildren(document.createElement('i'), role[0].toUpperCase() + role.slice(1)); el.disabled = false; el.setAttribute('aria-label', 'Inspect ' + role[0].toUpperCase() + role.slice(1));
      }
      render(current); return;
    }
    const role = provider === 'codex' ? 'observer' : 'builder';
    const working = session?.status === 'working';
    const waiting = ['needs_approval', 'needs_attention'].includes(session?.status);
    $('panel').toggleAttribute('data-working', working);
    $('panel').toggleAttribute('data-attention', waiting);
    $('panel').dataset.actor = waiting ? 'you' : working ? role : 'idle';
    room.setScene({ id: session?.id || 'desktop-idle', actor: waiting ? 'you' : working ? role : null, attentionRole: role,
      terminal: session?.status === 'finished' ? 'done' : null });
    for (const el of document.querySelectorAll('[data-room-role]')) {
      const label = el.dataset.roomRole === 'observer' ? 'Codex' : el.dataset.roomRole === 'builder' ? 'Claude Code' : 'Relay';
      el.replaceChildren(document.createElement('i'), label); el.disabled = true; el.setAttribute('aria-label', label);
    }
    updateGlow();
  },
});
async function poll() {
  try {
    const data = await fetch('/api/notch', { cache: 'no-store' }).then(r => r.json());
    token = data.token || token;
    const before = JSON.stringify(current);
    current = data.run;
    if (JSON.stringify(current) !== before) render(current);
    announce(current);
    renderLimits(data.limits);
    desktopOffice.update(data.desktop, current);
    batteryWatcher.update(data.battery);
    reminderWatcher.update(data.reminders);
    activity.update(data.queue, current);
    notifyNative(current);
  } catch (_) {
    $('status').textContent = 'Relay is not responding';
  }
}

async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Relay-Token': token }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function decide(path, body) {
  if (busy) return;
  busy = true;
  $('approve').disabled = true;
  $('reject').disabled = true;
  $('approvalError').textContent = '';
  try {
    await post(path, body);
    await poll();
  } catch (error) {
    $('approvalError').textContent = error.message;
  } finally {
    busy = false;
    $('approve').disabled = false;
    $('reject').disabled = false;
  }
}

// Views: Music, Notes, Deliver, Translate, Task and (in the full panel only) Office.
const tabs = { music: $('tabMusic'), notes: $('tabNotes'), deliver: $('tabDeliver'), translate: $('tabTranslate'), task: $('tabTask'), office: $('tabOffice') };
// Translate: the engine translates; the page asks the app to make the small panel taller when the result is long.
const translator = createTranslator({
  post, tell, native: !!native, onHold: () => syncHold(),
  // A translation asked for by voice is said aloud when answers are spoken (Kazakh is left to the eyes: the Mac has no voice for it).
  onSpeak: result => { if (result.to !== 'kk' && speechMode() !== 'off') speak(result.translation); },
});

// Tabs the person hid (Notch menu in the Relay window). The Task tab always stays: plans wait there for approval.
const TAB_KEY = 'relay.notchTabs';
let hiddenTabs = new Set();
const shown = name => !hiddenTabs.has(name);

function fallbackView() {
  if (shown(chosenView)) return chosenView;
  return ['notes', 'music', 'deliver', 'task'].find(shown) || 'task';
}

function setView(next, { focus = true, autoOffice = false } = {}) {
  if (next === 'notes' && current?.plan) next = 'task'; // a waiting plan always comes first
  if (!VIEWS.includes(next) || !shown(next) || (next === 'office' && mode !== 'full')) next = fallbackView();
  const before = view;
  view = next;
  $('panel').dataset.view = view;
  if (view === 'office' && (before !== 'office' || autoOffice)) desktopOffice.activate();
  fx.setScene({ mode, view });
  if (view !== 'music') setFxPicker(false);
  if (view === 'office' && !document.hidden) room.start();
  else room.stop();
  updateGlow();
  for (const [name, tab] of Object.entries(tabs)) tab.setAttribute('aria-selected', String(name === view));
  if (view === 'notes' && focus) {
    $('noteInput').focus();
    loadNotes();
  } else {
    if (view === 'notes') loadNotes();
    else $('noteInput').blur();
  }
  if (view === 'deliver') loadDeliver();
  if (before === 'translate' && view !== 'translate') translator.leave(); // the panel goes back to its usual size
  if (view === 'translate') translator.enter({ focus });
  tickProgress();
  syncHold();
}

// While the person is typing, the panel must not close because the pointer moved away.
function syncHold() {
  const want = (view === 'notes' && inputFocused) || (view === 'translate' && translator.wantsHold()) || voice.on || (ask.open && view === 'task') || (typing.open && view === 'notes');
  if (want === holding) return;
  holding = want;
  tell({ type: 'hold', on: want });
}

function noteItem(note) {
  const li = document.createElement('li');
  li.className = `note ${note.kind}${note.done ? ' done' : ''}`;
  let lead;
  if (note.kind === 'todo') {
    lead = document.createElement('input');
    lead.type = 'checkbox';
    lead.className = 'note-check';
    lead.checked = !!note.done;
    lead.setAttribute('aria-label', `Done: ${note.text}`);
    lead.addEventListener('change', () => {
      li.classList.toggle('done', lead.checked); // the tick and the strike-through show at once; the list follows when the engine answers
      changeNotes('/api/notes/done', { id: note.id, done: lead.checked });
    });
  } else {
    lead = document.createElement('span');
    lead.classList.add('note-dot');
  }
  lead.classList.add('note-lead');
  const text = document.createElement('span');
  text.className = 'note-text';
  text.textContent = note.text;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'note-remove';
  remove.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>';
  remove.setAttribute('aria-label', `Delete: ${note.text}`);
  remove.addEventListener('click', () => changeNotes('/api/notes/remove', { id: note.id }));
  li.append(lead, text);
  if (Number.isFinite(note.due) && note.reminded && !note.done) {
    // A reminder that has gone off can be put off by ten minutes; it stays in view for the first hour, then only on hover.
    const snooze = document.createElement('button');
    snooze.type = 'button';
    snooze.className = `note-snooze${Date.now() - note.due < 3600000 ? ' recent' : ''}`;
    snooze.textContent = '+10 min';
    snooze.title = 'Snooze 10 minutes';
    snooze.setAttribute('aria-label', `Snooze: ${note.text}`);
    snooze.addEventListener('click', () => changeNotes('/api/notes/snooze', { id: note.id, minutes: 10 }));
    li.append(snooze);
  }
  if (Number.isFinite(note.due)) {
    const due = document.createElement('span');
    due.className = `note-due${note.reminded ? ' passed' : ''}`;
    due.textContent = dueLabel(note.due);
    due.title = new Date(note.due).toLocaleString();
    li.append(due);
  }
  li.append(remove);
  return li;
}

function renderNotes() {
  const list = $('noteList');
  const top = list.scrollTop;
  const ordered = [...notes].sort((a, b) => Number(!!a.done) - Number(!!b.done)); // open items first
  if (ordered.length) {
    // Rows that were not on the screen before slide in; the ones already there stay still when something else changes.
    const rows = ordered.map(note => {
      const row = noteItem(note);
      if (shownNotes && !shownNotes.has(note.id)) row.classList.add('enter');
      return row;
    });
    list.replaceChildren(...rows);
  } else {
    const empty = document.createElement('li');
    empty.className = 'note-empty';
    empty.innerHTML = '<span class="note-empty-icon"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="3" width="12" height="14" rx="2.2"/><path d="M7.2 7.6h5.6M7.2 11.2h3.6"/></svg></span><strong></strong><small></small>';
    empty.querySelector('strong').textContent = 'Nothing yet.';
    empty.querySelector('small').textContent = 'Try “call mom in 30 min” and Relay will remind you.';
    list.replaceChildren(empty);
  }
  shownNotes = new Set(notes.map(note => note.id));
  list.scrollTop = top;
  const open = notes.filter(note => note.kind === 'todo' && !note.done).length;
  $('noteCount').textContent = String(open);
  $('noteCount').hidden = open === 0;
}

async function loadNotes() {
  try {
    const data = await fetch('/api/notes', { cache: 'no-store' }).then(r => r.json());
    if (Array.isArray(data.notes)) {
      notes = data.notes;
      renderNotes();
    }
  } catch (_) {
    /* The next poll will bring the engine back; notes keep their last list. */
  }
}

async function changeNotes(path, body) {
  $('noteError').textContent = '';
  try {
    notes = (await post(path, body)).notes;
    renderNotes();
  } catch (error) {
    $('noteError').textContent = error.message;
    loadNotes();
  }
}

async function addNote(kind) {
  const typed = $('noteInput').value.trim();
  if (!typed || noteBusy) return;
  // A time picked with the buttons wins; otherwise the words are read for one ("in 30 min", "tomorrow at 9:00").
  const picked = pendingDue();
  const reminder = picked ? { text: typed, due: picked } : parseReminder(typed);
  noteBusy = true;
  $('noteError').textContent = '';
  try {
    notes = (await post('/api/notes/add', reminder ? { text: reminder.text, kind, due: reminder.due } : { text: typed, kind })).notes;
    $('noteInput').value = '';
    pending = null;
    setRemind(false);
    showNoteHint();
    renderNotes();
    $('noteList').scrollTop = 0;
  } catch (error) {
    $('noteError').textContent = error.message;
  } finally {
    noteBusy = false;
  }
}

// Picking a tab, by a click or because files were dropped on the panel.
function pickTab(name) {
  if (name !== 'office') chosenView = name; // the Office needs the big panel, so it is never what a hover comes back to
  // The office lives in the full panel: from the small one, this button asks the app to grow it.
  if (name === 'office' && mode !== 'full') {
    tell({ type: 'expand', view: 'office' });
    return;
  }
  // Only the Office, and a plan waiting for an answer, need the big panel; every other view goes back to the small one.
  if (name !== 'task') closeAsk(false);
  if (name !== 'notes') closeType();
  const needsRoom = name === 'office' || (name === 'task' && (!!current?.plan || ask.open));
  if (mode === 'full' && !needsRoom) tell({ type: 'shrink' });
  if (mode === 'compact' && needsRoom) {
    if (ask.open) ask.resizing = true; // the card is too wide for the small panel (and Russian is wider still): a wider one it is
    tell(ask.open && !current?.plan ? { type: 'expand', card: true } : { type: 'expand' }); // wide, but only as tall as the card
  }
  setView(name);
}

for (const [name, tab] of Object.entries(tabs)) tab.addEventListener('click', () => pickTab(name));

function applyTabs() {
  try {
    const saved = JSON.parse(localStorage.getItem(TAB_KEY) || 'null');
    hiddenTabs = new Set((Array.isArray(saved?.hidden) ? saved.hidden : []).filter(name => VIEWS.includes(name) && name !== 'task'));
  } catch (_) {
    hiddenTabs = new Set();
  }
  for (const [name, tab] of Object.entries(tabs)) tab.hidden = hiddenTabs.has(name);
  if (hiddenTabs.has(view)) setView(fallbackView(), { focus: false });
}
// The Relay window and this panel are separate pages; a change made in the window reaches the panel here.
window.addEventListener('storage', event => { if (event.key === TAB_KEY) applyTabs(); });

// More: a small menu with the two things that have no tab. It only exists in the app; a browser has nothing to quit.
const moreButton = $('moreButton');
const moreMenu = $('moreMenu');
moreButton.hidden = !native;
let quitArmed = false; // a task is running, so the first press on Quit only asks
function paintQuit() {
  $('quitLabel').hidden = quitArmed;
  $('quitConfirm').hidden = !quitArmed;
}
function setMore(open) {
  moreMenu.hidden = !open;
  moreButton.setAttribute('aria-expanded', String(open));
  quitArmed = false;
  paintQuit();
  if (open) $('moreOpen').focus({ preventScroll: true });
}
moreButton.addEventListener('click', () => setMore(moreMenu.hidden));
$('moreOpen').addEventListener('click', () => {
  setMore(false);
  tell({ type: 'open' });
});
$('moreQuit').addEventListener('click', () => {
  if (current?.running && !quitArmed) {
    quitArmed = true;
    paintQuit();
    return;
  }
  setMore(false);
  tell({ type: 'quit' });
});
document.addEventListener('pointerdown', event => {
  if (!moreMenu.hidden && !event.target.closest('#moreMenu, #moreButton')) setMore(false);
});
// Capture phase: Escape closes the menu first, and only a second Escape hides the whole panel.
document.addEventListener('keydown', event => {
  if (moreMenu.hidden) return;
  if (event.key === 'Escape') {
    event.stopPropagation();
    setMore(false);
    moreButton.focus({ preventScroll: true });
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const items = [$('moreOpen'), $('moreQuit')];
    items[(items.indexOf(document.activeElement) + 1) % items.length].focus({ preventScroll: true });
  }
}, true);
// While typing, the line under the field says what was understood as a time, before anything is saved.
// pending: a time chosen with the buttons, kept until the note is saved. "minutes" counts from the moment of saving.
let pending = null;
const pendingDue = () => (pending ? (pending.minutes ? Date.now() + pending.minutes * 60000 : pending.at) : 0);
function showNoteHint() {
  const hint = $('noteHint');
  const due = pendingDue() || parseReminder($('noteInput').value)?.due;
  if (due) hint.textContent = `Reminder · ${dueLabel(due)}`;
  hint.hidden = !due;
  hint.toggleAttribute('data-clearable', !!pending);
  hint.title = pending ? 'Remove reminder' : '';
  $('noteKeys').hidden = !!due;
  document.querySelector('.composer').toggleAttribute('data-typing', !!$('noteInput').value);
}
$('noteHint').addEventListener('click', () => {
  if (!pending) return;
  pending = null;
  showNoteHint();
  $('noteInput').focus({ preventScroll: true });
});

// Voice: the microphone button (hold to talk, or tap to start and tap again to stop) and the right Option key, which the app
// watches everywhere. The app listens and sends the words; they go into the field after whatever was typed. Nothing is
// saved until you press Enter, unless you end with "save" (or "save as to-do").
const readStored = key => { try { return localStorage.getItem(key); } catch (_) { return null; } };
const voiceEnabled = () => !!native && readStored(VOICE_KEY) !== 'off';
const voiceLocale = () => speechLocale(readStored(LANGUAGE_KEY), window.relayI18n?.language);
// The words can go to the note field or, from the Translate tab, to the text to translate (they replace it).
const intoTranslate = () => voice.target === 'translate';
const setVoiceText = text => { if (intoTranslate()) translator.fill(text); else $('noteInput').value = text; };
function paintVoice() {
  for (const [mic, lang] of [['micButton', 'voiceLang'], ['trMic', 'trVoiceLang']]) {
    $(mic).hidden = !voiceEnabled();
    $(lang).hidden = !voiceEnabled();
    $(lang).textContent = languageCode(voiceLocale());
  }
  const noting = voice.on && !intoTranslate();
  $('micButton').setAttribute('aria-pressed', String(noting));
  $('trMic').setAttribute('aria-pressed', String(voice.on && intoTranslate()));
  const composer = document.querySelector('.composer');
  composer.toggleAttribute('data-listening', noting || wake.hearing);
  $('noteInput').placeholder = noting || wake.hearing ? 'Listening…' : 'Write a note…';
  translator.listening(voice.on && intoTranslate());
}
function startVoice(target = 'note') {
  if (voice.on || !voiceEnabled()) return;
  stopSpeaking(); // the microphone must not hear the answer
  voice.on = true;
  voice.latched = false;
  voice.target = target;
  voice.base = target === 'translate' ? translator.text() : $('noteInput').value;
  $('noteError').textContent = '';
  paintVoice();
  syncHold();
  tell({ type: 'dictate', action: 'start', locale: voiceLocale() });
}
function stopVoice() {
  if (voice.on) tell({ type: 'dictate', action: 'stop' }); // the words arrive in a moment, with "done"
}
function cancelVoice() {
  if (!voice.on) return;
  tell({ type: 'dictate', action: 'cancel' });
  endVoice(voice.base);
}
function endVoice(text) {
  const wasTranslate = intoTranslate();
  voice.on = false;
  voice.latched = false;
  if (typeof text === 'string') setVoiceText(text);
  voice.target = 'note';
  if (wasTranslate) { paintVoice(); syncHold(); return; }
  paintVoice();
  syncHold();
  showNoteHint();
}
window.relayDictation = (state, text, error) => {
  if (!voice.on) return;
  if (state === 'text') {
    setVoiceText(intoTranslate() ? String(text || '').trim() : joinSpeech(voice.base, text));
    if (!intoTranslate()) showNoteHint();
  } else if (state === 'done') {
    if (intoTranslate()) {
      // Click and speak: what was said is the text, and it is translated into the language picked on the page.
      const words = String(text || '').trim();
      endVoice(words || voice.base);
      if (words) translator.request({ text: words, spoken: true });
      return;
    }
    const spoken = joinSpeech(voice.base, text);
    const command = voice.base.trim() ? null : routeCommand(spoken); // a command counts only when the field was empty
    if (command) {
      endVoice('');
      runCommand(command);
      return;
    }
    const heard = spokenCommand(spoken);
    endVoice(heard.text);
    $('noteInput').focus({ preventScroll: true });
    if (heard.save && heard.text) addNote(heard.save);
  } else if (state === 'cancelled') {
    endVoice(voice.base);
  } else if (state === 'error') {
    const message = voiceProblem(error);
    const wasTranslate = intoTranslate();
    endVoice(voice.base);
    if (wasTranslate) translator.problem(message);
    else $('noteError').textContent = message;
  }
};
// The app saw the right Option key held down (or let go).
window.relayVoiceKey = down => {
  if (down) {
    const toTranslate = view === 'translate' && shown('translate') && translator.dictatable(); // on the Translate tab the key talks to it
    if (!voiceEnabled() || (!toTranslate && !shown('notes')) || current?.plan) return;
    if (!toTranslate) setView('notes', { focus: false });
    startVoice(toTranslate ? 'translate' : 'note');
  } else if (!voice.latched) {
    stopVoice();
  }
};
for (const [id, target] of [['micButton', 'note'], ['trMic', 'translate']]) {
  $(id).addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    if (voice.on && voice.latched) {
      stopVoice();
      return;
    }
    voice.pressedAt = Date.now();
    startVoice(target);
  });
}
const releaseMic = () => {
  if (!voice.on || voice.latched || !voice.pressedAt) return;
  if (Date.now() - voice.pressedAt < 300) voice.latched = true; // a tap: keep listening until the next tap
  else stopVoice();                                           // a hold: let go to finish
  voice.pressedAt = 0;
};
for (const id of ['micButton', 'trMic']) {
  $(id).addEventListener('pointerup', releaseMic);
  $(id).addEventListener('pointercancel', releaseMic);
  $(id).addEventListener('mousedown', event => event.preventDefault());
}
for (const id of ['voiceLang', 'trVoiceLang']) {
  $(id).addEventListener('click', () => {
    try { localStorage.setItem(LANGUAGE_KEY, otherLanguage(voiceLocale())); } catch (_) { /* the choice lasts until the panel is closed */ }
    paintVoice();
    syncWake(); // "Hey Relay" listens in the language picked here
  });
  $(id).addEventListener('mousedown', event => event.preventDefault());
}
window.addEventListener('storage', event => {
  if (event.key === VOICE_KEY || event.key === LANGUAGE_KEY) paintVoice();
  if (event.key === VOICE_KEY || event.key === LANGUAGE_KEY || event.key === WAKE_KEY) syncWake();
});
window.addEventListener('relaylangchange', () => { paintVoice(); syncWake(); });
// Escape while listening throws the words away (a second Escape hides the panel).
document.addEventListener('keydown', event => {
  if (!voice.on || event.key !== 'Escape') return;
  event.stopPropagation();
  cancelVoice();
}, true);
paintVoice();

// "Hey Relay": the app listens all the time, only when the person turned it on, and only with speech recognition that runs on
// this Mac. It says when the words were heard ("heard"), and then what came after them ("command"). The request is handled
// like one spoken with the right Option key: a command is carried out, anything else becomes a note in the field.
const wakeEnabled = () => voiceEnabled() && readStored(WAKE_KEY) === 'on';
function syncWake() {
  if (!native) return;
  const on = wakeEnabled();
  const state = on ? voiceLocale() : '';
  if (state === wake.sent) return;
  wake.announce = on && wake.sent === '';     // switched on while the panel was running (not at every launch): say when it is listening
  wake.sent = state;
  tell({ type: 'wake', on, locale: voiceLocale() });
}
function endWake() {
  if (!wake.hearing) return;
  wake.hearing = false;
  paintVoice();
}
window.relayWake = (state, text, error) => {
  if (!wakeEnabled()) return;
  if (state === 'ready') {
    if (!wake.announce) return;
    wake.announce = false;
    toast('done', 'Hey Relay is on', 'Say “Hey Relay”, then your request.');
    tell({ type: 'attention', keep: false });
  } else if (state === 'heard') {
    if (voice.on) return; // the microphone button is already listening
    stopSpeaking();
    wake.hearing = true;
    paintVoice();
    if (shown('notes') && !current?.plan) setView('notes', { focus: false });
    tell({ type: 'attention', keep: false }); // the panel peeks out, so you see that Relay is listening
  } else if (state === 'command') {
    endWake();
    const spoken = String(text || '').trim();
    if (!spoken || voice.on) return;
    const command = routeCommand(spoken);
    if (command) {
      tell({ type: 'attention', keep: true });
      runCommand(command);
      return;
    }
    const heard = spokenCommand(joinSpeech($('noteInput').value, spoken));
    $('noteInput').value = heard.text;
    showNoteHint();
    tell({ type: 'attention', keep: false });
    if (heard.save && heard.text) addNote(heard.save);
  } else if (state === 'error') {
    endWake();
    wake.announce = false;
    const message = wakeProblem(error);
    $('noteError').textContent = message;
    toast('failed', 'Hey Relay is off', message); // whatever tab is showing, and even if the panel was hidden
    tell({ type: 'attention', keep: false });
  }
};
syncWake();
// The Relay window and this panel are separate pages: when the choice is changed there, a hidden panel may never be told,
// so the choice is looked at again every few seconds, and whenever the panel appears.
setInterval(syncWake, 2000);

// Answers said out loud. The Mac app speaks. A task that was asked for by voice says what became of it (its result, a plan that
// waits for approval, a question, a failure); "everything" in the window's Notch menu adds tasks started by hand and
// reminders. Escape, the Stop button, or starting to talk silences it.
const BRIEFS_KEY = 'relay.spokenBriefs'; // queued tasks that came from a spoken request
const RUNS_KEY = 'relay.spokenRuns';     // the runs they became
const storedList = key => { try { const list = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(list) ? list : []; } catch (_) { return []; } };
const saveList = (key, list) => { try { localStorage.setItem(key, JSON.stringify(list)); } catch (_) { /* then the answer is simply not spoken */ } };
const speaking = { on: false };
const speechMode = () => speakMode(readStored(SPEAK_KEY));
const translated = text => (window.relayI18n?.translate ? window.relayI18n.translate(text) : text);
function speak(text) {
  const words = String(text || '').trim();
  if (native && words) tell({ type: 'speak', text: words, locale: languageOf(words) });
}
function stopSpeaking() {
  if (speaking.on) tell({ type: 'speak', action: 'stop' });
}
function speakRun(run) {
  if (!shouldSpeak(speechMode(), storedList(RUNS_KEY).includes(run.id))) return;
  const line = lineForRun(run, translated);
  if (line) speak(line);
}
// A queued task that is started from the notch: when it was a spoken one, the run it becomes is remembered.
async function postTracked(path, body) {
  const result = await post(path, body);
  if (path === '/api/queue/start' && result?.id && storedList(BRIEFS_KEY).includes(body?.id)) saveList(RUNS_KEY, remember(storedList(RUNS_KEY), result.id));
  return result;
}
window.relaySpeech = state => {
  speaking.on = state === 'start';
  $('speakStop').hidden = !speaking.on;
  if (state === 'unavailable') say('This Mac has no voice installed for that language.');
};
$('speakStop').addEventListener('click', stopSpeaking);
$('speakStop').addEventListener('mousedown', event => event.preventDefault());
document.addEventListener('keydown', event => {
  if (!speaking.on || event.key !== 'Escape') return;
  event.stopPropagation();
  stopSpeaking();
}, true);

// What was said can also be a command: "open music", "next song", "to-do buy milk". A request for the agents is not carried
// out at once: it opens a small card to check the words, the kind of work and the project, and then goes to the queue.
let sayTimer = 0;
function say(text) {
  $('voiceNote').textContent = text;
  clearTimeout(sayTimer);
  if (text) sayTimer = setTimeout(() => { $('voiceNote').textContent = ''; }, 4500);
}
const PROJECT_KEY = 'relay.voiceProject';
function runCommand(command) {
  say('');
  if (command.kind === 'view') {
    if (!shown(command.view)) say('That tab is turned off in the Relay window.');
    else pickTab(command.view);
  } else if (command.kind === 'media') {
    if (!native) say('Music controls work in the Relay app.');
    else if (!music) say('Nothing is playing.');
    else {
      const playing = !!music.playing;
      const wanted = command.command;
      if (wanted === 'next' || wanted === 'previous') tell({ type: 'media', command: wanted });
      else if ((wanted === 'pause') === playing) tell({ type: 'media', command: 'toggle' }); // already as asked: nothing to press
      say({ pause: 'Paused.', play: 'Playing.', next: 'Next song.', previous: 'Previous song.' }[wanted]);
    }
  } else if (command.kind === 'translate') {
    if (!shown('translate')) say('That tab is turned off in the Relay window.');
    else {
      pickTab('translate');
      translator.request({ text: command.text, target: command.target, spoken: true });
    }
  } else if (command.kind === 'todo' || command.kind === 'note') {
    if (shown('notes')) setView('notes', { focus: false }); // the new note appears in front of the person
    $('noteInput').value = command.text;
    showNoteHint();
    addNote(command.kind);
  } else if (command.kind === 'agents') {
    openAsk(command);
    pickTab('task'); // everything about the agents lives on the Task page, not in the notes
  } else if (command.kind === 'app') {
    if (!native) say('Opening apps works in the Relay app.');
    else {
      openingApp = command; // if no app has that name, the words were only a note
      tell({ type: 'app', names: command.names });
    }
  } else if (command.kind === 'telegram') {
    if (!native) say('Telegram drafts work in the Relay app.');
    else {
      tell({ type: 'telegram', text: command.text });
      say('Opening Telegram…');
    }
  } else if (command.kind === 'type') {
    if (!native) say('Typing into other apps works in the Relay app.');
    else openType(command.text);
  }
}
// "type hello" shows the words and the app they would land in, and waits for a press. Nothing is typed before that, a Return is
// never pressed, and a cancel puts the words back into the note field.
function paintType() {
  const known = !!typing.app;
  $('typeTarget').textContent = known ? `Type into ${typing.app}` : 'No app to type into. Switch to one first.';
  $('typeTarget').toggleAttribute('data-none', !known);
  $('typeGo').disabled = !known || !typedText($('typeText').value);
}
function openType(text) {
  typing.open = true;
  typing.app = '';
  $('typeText').value = text;
  $('typeCard').hidden = false;
  paintType();
  syncHold();
  tell({ type: 'front' }); // which app is it? the answer comes back in relayAction
  $('typeText').focus({ preventScroll: true });
}
function closeType(keepWords = false) {
  if (!typing.open) return;
  typing.open = false;
  $('typeCard').hidden = true;
  if (keepWords && !$('noteInput').value.trim()) {
    $('noteInput').value = $('typeText').value;
    showNoteHint();
  }
  syncHold();
}
function sendType() {
  const text = typedText($('typeText').value);
  if (!typing.open || !typing.app || !text) return;
  closeType();
  tell({ type: 'type', text });
}
$('typeGo').addEventListener('click', sendType);
$('typeCancel').addEventListener('click', () => closeType(true));
$('typeText').addEventListener('input', paintType);
$('typeText').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); sendType(); }
});
document.addEventListener('keydown', event => {
  if (!typing.open || event.key !== 'Escape') return;
  event.stopPropagation();
  closeType(true);
}, true);
for (const element of [$('typeGo'), $('typeCancel')]) element.addEventListener('mousedown', event => event.preventDefault());
// What the app answered about opening an app, typing, or a Telegram draft.
window.relayAction = (kind, state, detail) => {
  if (kind === 'front') {
    typing.app = state === 'ok' ? String(detail || '') : '';
    paintType();
  } else if (kind === 'app') {
    if (state === 'missing' && openingApp) {
      $('noteInput').value = openingApp.spoken; // no app has that name: it was only something to write down
      showNoteHint();
      say('No app has that name. Your words are in the note field.');
    } else if (state === 'failed') {
      say('That app could not be opened.');
    }
    openingApp = null;
  } else if (kind === 'telegram') {
    if (state === 'opened') say('Telegram is open. The words are on your clipboard: choose a chat and press ⌘V.');
    else if (state === 'missing') say('Telegram is not installed on this Mac.');
    else if (state === 'failed') say('Telegram could not be opened.');
  } else if (kind === 'type') {
    if (state === 'access') say('Allow Relay under Privacy & Security, Accessibility, then try again.');
    else if (state === 'gone') say('That app was closed.');
    else if (state === 'changed') say('Another app came to the front. Switch back and try again.');
    else if (state === 'failed') say('Nothing was typed.');
  }
};
// What the person asked for by name, in a sentence. The observer and the reviewer only look; only the builder changes files.
const WHO_LINES = {
  observer: 'The Observer only looks and plans. Nothing is changed.',
  reviewer: 'The Reviewer looks with its own tool and model. Nothing is changed.',
  builder: 'The Builder changes the files, after you approve the plan.',
  builderLooks: 'The Builder answers with its own tool and model. Nothing is changed.',
  claude: 'Claude takes the lead in this task.',
  codex: 'Codex takes the lead in this task.'
};
function paintAsk() {
  ask.mode = fitMode(ask.agent, ask.mode);
  for (const button of $('askModes').children) {
    button.setAttribute('aria-checked', String(button.dataset.mode === ask.mode));
    button.disabled = button.dataset.mode === 'build' && (ask.agent === 'observer' || ask.agent === 'reviewer'); // they cannot change files
  }
  $('askAgent').value = ask.agent;
  $('askAgent').toggleAttribute('data-named', !!ask.agent);
  const line = ask.agent === 'builder' && ask.mode !== 'build' ? WHO_LINES.builderLooks : WHO_LINES[ask.agent] || '';
  $('askWho').hidden = !line;
  $('askWho').textContent = line;
}
function askNote(text, error = false) {
  $('askNote').textContent = text;
  $('askNote').toggleAttribute('data-error', error);
}
async function openAsk({ text, mode, agent }) {
  ask.open = true;
  ask.agent = agent || '';
  ask.mode = mode;
  ask.team = null;
  ask.busy = false;
  $('askTask').value = text;
  $('askQueue').disabled = true;
  $('askCard').hidden = false;
  $('askCard').parentElement.toggleAttribute('data-asking', true);
  askNote('It waits in the queue until you press Start task.');
  paintAsk();
  syncHold();
  fetch('/api/teams', { cache: 'no-store' }).then(r => r.json()).then(data => { ask.team = data?.default?.roles ? data.default : null; }).catch(() => {});
  try {
    const data = await fetch('/api/projects', { cache: 'no-store' }).then(r => r.json());
    const projects = Array.isArray(data.projects) ? data.projects.filter(project => project.exists !== false) : [];
    const chosen = pickProject(projects, readStored(PROJECT_KEY));
    $('askProject').replaceChildren(...projects.map(project => {
      const option = document.createElement('option');
      option.value = project.path;
      option.textContent = project.name || project.path.split('/').filter(Boolean).pop();
      return option;
    }));
    if (chosen) $('askProject').value = chosen.path;
    $('askProject').hidden = !projects.length;
    if (!projects.length) askNote('Save a project in the Relay window first, then try again.', true);
    $('askQueue').disabled = !projects.length;
  } catch (_) {
    askNote('Relay is not responding.', true);
  }
  if (ask.open) $('askTask').focus({ preventScroll: true });
}
function closeAsk(shrink = true) {
  if (!ask.open) return;
  ask.open = false;
  $('askCard').hidden = true;
  $('askCard').parentElement.removeAttribute('data-asking');
  syncHold();
  if (shrink && mode === 'full' && view === 'task' && !current?.plan) { // back to the small panel
    ask.resizing = true;
    tell({ type: 'shrink' });
  }
}
async function queueAsk() {
  const task = $('askTask').value.trim();
  const project = $('askProject').value;
  if (!ask.open || ask.busy || !task || !project) return;
  ask.busy = true;
  $('askQueue').disabled = true;
  try {
    if (ask.agent && !ask.team) throw new Error('Relay could not read the team. Try again.'); // never send it to the wrong agent
    const mode = fitMode(ask.agent, ask.mode);
    const result = await post('/api/queue/add', briefFor(task, project, mode, teamFor(ask.team, ask.agent, mode)));
    try { localStorage.setItem(PROJECT_KEY, project); } catch (_) { /* the choice lasts until the panel is closed */ }
    saveList(BRIEFS_KEY, remember(storedList(BRIEFS_KEY), result.items?.at(-1)?.id)); // so its answer is spoken
    activity.update(result, current); // the queue (the engine answers with it), and its Start button, are on this page
    closeAsk();
  } catch (error) {
    askNote(error.message, true);
    $('askQueue').disabled = false;
  } finally {
    ask.busy = false;
  }
}
for (const button of $('askModes').children) button.addEventListener('click', () => { ask.mode = button.dataset.mode; paintAsk(); });
$('askAgent').addEventListener('change', () => { ask.agent = $('askAgent').value; paintAsk(); });
$('askQueue').addEventListener('click', queueAsk);
$('askCancel').addEventListener('click', closeAsk);
$('askTask').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); queueAsk(); }
});
document.addEventListener('keydown', event => {
  if (!ask.open || event.key !== 'Escape') return;
  event.stopPropagation();
  closeAsk();
}, true);
for (const element of [$('askModes'), $('askQueue'), $('askCancel')]) element.addEventListener('mousedown', event => event.preventDefault());

// The reminder picker (the clock beside the field): a few ready-made times, and a time set by hand.
const remindPop = $('remindPop');
let custom = 0; // the moment the steppers show
function paintCustom() {
  const now = Date.now();
  $('remindDay').textContent = dayLabel(custom, now);
  $('remindHour').textContent = hourText(custom);
  $('remindMinute').textContent = minuteText(custom);
  $('remindSet').disabled = !canSet(custom, now);
}
function choose(choice) {
  pending = choice;
  setRemind(false);
  showNoteHint();
  $('noteInput').focus({ preventScroll: true });
}
function setRemind(open) {
  remindPop.hidden = !open;
  $('remindButton').setAttribute('aria-expanded', String(open));
  if (!open) return;
  const now = Date.now();
  $('remindQuick').replaceChildren(...quickChoices(now).map(choice => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'remind-chip';
    const label = document.createElement('span');
    label.textContent = choice.label;
    button.append(label);
    if (choice.time) {
      const time = document.createElement('small');
      time.textContent = choice.time;
      button.append(time);
    }
    button.addEventListener('click', () => choose(choice.minutes ? { minutes: choice.minutes } : { at: choice.at }));
    return button;
  }));
  custom = pending?.at && pending.at > now ? pending.at : startingMoment(now);
  paintCustom();
}
$('remindButton').addEventListener('click', () => setRemind(remindPop.hidden));
for (const stepper of remindPop.querySelectorAll('.stepper')) {
  for (const button of stepper.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      custom = stepMoment(custom, stepper.dataset.field, Number(button.dataset.dir));
      paintCustom();
    });
  }
}
$('remindSet').addEventListener('click', () => {
  if (canSet(custom)) choose({ at: custom });
});
// Pressing a button here must not take the keyboard away from the note field.
for (const element of [remindPop, $('remindButton'), $('noteHint')]) element.addEventListener('mousedown', event => event.preventDefault());
document.addEventListener('pointerdown', event => {
  if (!remindPop.hidden && !event.target.closest('#remindPop, #remindButton')) setRemind(false);
});
// Capture phase, like the menus: Escape closes the picker first, and only a second Escape hides the panel.
document.addEventListener('keydown', event => {
  if (remindPop.hidden || event.key !== 'Escape') return;
  event.stopPropagation();
  setRemind(false);
}, true);
$('noteInput').addEventListener('input', showNoteHint);
$('noteInput').addEventListener('focus', () => { inputFocused = true; syncHold(); });
$('noteInput').addEventListener('blur', () => { inputFocused = false; syncHold(); });
$('noteInput').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing) return; // Escape bubbles up and hides the panel
  event.preventDefault();
  addNote(event.metaKey || event.ctrlKey ? 'todo' : 'note');
});
// Deliver: files waiting on the shelf. The app does the real dragging, in and out, because a web page never gets
// the path of a dropped file; this page keeps the list and tells the app which files a press on a row would drag.
let selected = new Set(); // ids of the rows picked to be dragged together
let lastPicked = '';
let carrying = [];        // ids of the files that are being dragged out right now
let deliverSettings = { remove_after_drop: false, auto_catch: false, expire_hours: 0 };
let zipping = false; // a zip is being made
let deliverProblem = null; // why Auto-catch cannot read the Downloads folder, when it cannot

function sizeText(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function hintText() {
  const ready = deliver.filter(item => !item.missing).length;
  if (!deliver.length) return deliverSettings.auto_catch ? 'Catching downloads' : 'Drop files on the notch';
  if (!ready) return 'Nothing left to deliver';
  if (selected.size) return `${selected.size} selected · drag out`;
  return `${ready} ${ready === 1 ? 'file' : 'files'} · drag out`;
}

// Selection changes repaint the rows that are there, so a press on a row is never swallowed by a rebuilt list.
function paintSelection() {
  for (const row of $('deliverList').children) row.toggleAttribute('data-selected', selected.has(row.dataset.id));
  $('deliverHint').textContent = hintText();
}

// Tells the app which files a press on the shelf would drag if the pointer now moves with the button down.
function carryOut(entries) {
  carrying = entries.map(entry => entry.id);
  if (entries.length) tell({ type: 'deliverArm', paths: entries.map(entry => entry.path) });
}

// A press on a row picks it (⌘ adds or removes it, ⇧ takes a range) and arms the drag of everything picked.
function pressRow(event, item) {
  if (event.button !== 0 || item.missing || event.target.closest('.file-remove')) return;
  const additive = event.metaKey || event.ctrlKey;
  if (event.shiftKey && lastPicked) {
    const ids = deliver.filter(entry => !entry.missing).map(entry => entry.id);
    const from = ids.indexOf(lastPicked);
    const to = ids.indexOf(item.id);
    selected = from >= 0 && to >= 0 ? new Set(ids.slice(Math.min(from, to), Math.max(from, to) + 1)) : new Set([item.id]);
  } else if (additive) {
    if (selected.has(item.id)) {
      selected.delete(item.id); // taken out of the picked files: nothing to drag from this row
      lastPicked = item.id;
      paintSelection();
      return;
    }
    selected.add(item.id);
  } else if (!selected.has(item.id)) {
    selected = new Set([item.id]);
  }
  if (!event.shiftKey) lastPicked = item.id;
  paintSelection();
  carryOut(deliver.filter(entry => selected.has(entry.id) && !entry.missing));
}

// A plain click (no drag) on one of several picked rows leaves just that row picked, as in Finder.
function clickRow(event, item) {
  if (item.missing || event.shiftKey || event.metaKey || event.ctrlKey || event.target.closest('.file-remove')) return;
  if (selected.size > 1 && selected.has(item.id)) {
    selected = new Set([item.id]);
    paintSelection();
  }
}

function deliverRow(item) {
  const li = document.createElement('li');
  li.className = 'file';
  li.dataset.id = item.id;
  li.dataset.kind = item.kind;
  li.toggleAttribute('data-missing', !!item.missing);
  li.toggleAttribute('data-selected', selected.has(item.id));
  li.title = item.missing ? `${item.path} (moved or deleted)` : item.path;
  const icon = document.createElement('span');
  icon.className = 'file-icon';
  const extension = item.name.includes('.') ? item.name.split('.').pop() : '';
  icon.textContent = item.kind === 'folder' ? 'DIR' : (extension.slice(0, 4) || 'FILE');
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = item.name;
  const size = document.createElement('span');
  size.className = 'file-size';
  size.textContent = item.missing ? 'missing' : sizeText(item.size);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'file-remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', `Remove from Deliver: ${item.name}`);
  remove.addEventListener('click', () => changeDeliver('/api/deliver/remove', { id: item.id }));
  li.addEventListener('pointerdown', event => pressRow(event, item));
  li.addEventListener('click', event => clickRow(event, item));
  li.append(icon, name, size, remove);
  return li;
}

const PROBLEMS = {
  denied: 'Relay is not allowed to open your Downloads folder. Allow it in System Settings › Privacy & Security › Files & Folders.',
  unreadable: 'Relay cannot read your Downloads folder right now.',
};

const EXPIRY = [[0, 'forever'], [1, '1 hour'], [6, '6 hours'], [24, '1 day'], [168, '1 week']]; // hours a file may stay, as the engine allows

function paintSettings() {
  $('deliverAuto').setAttribute('aria-pressed', String(!!deliverSettings.remove_after_drop));
  $('deliverCatch').setAttribute('aria-pressed', String(!!deliverSettings.auto_catch));
  const keep = EXPIRY.find(([hours]) => hours === deliverSettings.expire_hours) || EXPIRY[0];
  $('deliverExpire').textContent = `Keep: ${keep[1]}`;
  $('deliverExpire').setAttribute('aria-pressed', String(keep[0] > 0));
  // The options are folded away; the button shows when one of them is on.
  $('deliverOptionsButton').toggleAttribute('data-active', !!(deliverSettings.remove_after_drop || deliverSettings.auto_catch || keep[0]));
  const problem = deliverSettings.auto_catch && deliverProblem ? PROBLEMS[deliverProblem] || PROBLEMS.unreadable : '';
  $('deliverNotice').textContent = problem;
  $('deliverNotice').hidden = !problem;
  $('deliverHint').textContent = hintText();
}

function renderDeliver() {
  const list = $('deliverList');
  const top = list.scrollTop;
  const ready = new Set(deliver.filter(item => !item.missing).map(item => item.id));
  selected = new Set([...selected].filter(id => ready.has(id))); // a file that went away is no longer picked
  list.replaceChildren(...deliver.map(deliverRow));
  list.scrollTop = top;
  $('deliverEmpty').hidden = deliver.length > 0;
  $('deliverHint').textContent = hintText();
  $('deliverAll').disabled = ready.size < 2;
  $('deliverZip').disabled = zipping || !ready.size;
  $('deliverZip').textContent = zipping ? 'Zipping…' : 'Zip';
  $('deliverClear').disabled = !deliver.length;
  $('deliverCount').textContent = String(ready.size);
  $('deliverCount').hidden = ready.size === 0;
  paintSettings();
}

async function loadDeliver() {
  try {
    const data = await fetch('/api/deliver', { cache: 'no-store' }).then(r => r.json());
    if (!Array.isArray(data.items)) return;
    const valid = typeof data.settings?.remove_after_drop === 'boolean' && typeof data.settings?.auto_catch === 'boolean'
      && Number.isInteger(data.settings?.expire_hours);
    const settings = valid ? data.settings : deliverSettings;
    const problem = typeof data.problem === 'string' ? data.problem : null;
    if (JSON.stringify([data.items, settings, problem]) === JSON.stringify([deliver, deliverSettings, deliverProblem])) return;
    deliver = data.items;
    deliverSettings = settings;
    deliverProblem = problem;
    renderDeliver();
  } catch (_) {
    /* The next poll will bring the engine back; the shelf keeps its last list. */
  }
}

async function changeDeliver(path, body) {
  $('deliverError').textContent = '';
  try {
    deliver = (await post(path, body)).items;
    renderDeliver();
  } catch (error) {
    $('deliverError').textContent = error.message;
    loadDeliver();
  }
}

$('deliverAll').addEventListener('pointerdown', event => {
  if (event.button === 0) carryOut(deliver.filter(item => !item.missing));
});
$('deliverClear').addEventListener('click', () => changeDeliver('/api/deliver/clear', {}));
async function changeSetting(change) {
  $('deliverError').textContent = '';
  try {
    deliverSettings = (await post('/api/deliver/settings', change)).settings;
    deliverProblem = null;
    paintSettings();
    return true;
  } catch (error) {
    $('deliverError').textContent = error.message;
    return false;
  }
}
$('deliverAuto').addEventListener('click', () => changeSetting({ remove_after_drop: !deliverSettings.remove_after_drop }));
$('deliverExpire').addEventListener('click', () => {
  const at = EXPIRY.findIndex(([hours]) => hours === deliverSettings.expire_hours);
  changeSetting({ expire_hours: EXPIRY[(at + 1) % EXPIRY.length][0] });
});
$('deliverOptionsButton').addEventListener('click', () => {
  const open = $('deliverOptions').hidden;
  $('deliverOptions').hidden = !open;
  $('deliverOptionsButton').setAttribute('aria-expanded', String(open));
});
// Zip: the picked files (all of them when none is picked) become one file on the shelf, which is then dragged out like any other.
$('deliverZip').addEventListener('click', async () => {
  const ready = deliver.filter(item => !item.missing);
  const picked = selected.size ? ready.filter(item => selected.has(item.id)) : ready;
  if (zipping || !picked.length) return;
  zipping = true;
  $('deliverError').textContent = '';
  renderDeliver();
  try {
    const data = await post('/api/deliver/zip', { ids: picked.map(item => item.id) });
    deliver = data.items;
    selected = new Set(deliver.filter(item => item.path === data.zip).map(item => item.id));
    lastPicked = [...selected][0] || '';
    $('deliverList').scrollTop = 0;
  } catch (error) {
    $('deliverError').textContent = error.message;
  } finally {
    zipping = false;
    renderDeliver();
  }
});
$('deliverCatch').addEventListener('click', async () => {
  // The engine looks at the folder every couple of seconds; ask again after its first look to show a problem if there is one.
  if (await changeSetting({ auto_catch: !deliverSettings.auto_catch }) && deliverSettings.auto_catch) setTimeout(loadDeliver, 2600);
});
// A press on the empty part of the list lets go of the picked rows.
$('deliverList').addEventListener('pointerdown', event => {
  if (event.target !== $('deliverList') || !selected.size) return;
  selected = new Set();
  paintSelection();
});

// The app calls these while files are dragged over the panel, when they are dropped, and when a drag out has ended.
window.relayDeliverDragState = over => $('panel').toggleAttribute('data-dropping', !!over);
window.relayDeliverDrop = async paths => {
  $('panel').removeAttribute('data-dropping');
  if (!Array.isArray(paths) || !paths.length) return;
  pickTab('deliver');
  $('deliverError').textContent = '';
  try {
    if (!token) await poll();
    deliver = (await post('/api/deliver/add', { paths })).items;
    renderDeliver();
  } catch (error) {
    $('deliverError').textContent = error.message;
  }
};
// accepted: somebody took the files. moved: they were moved, so they are no longer where the shelf has them.
window.relayDeliverDragEnded = async (accepted, moved) => {
  const ids = carrying;
  carrying = [];
  if (accepted && ids.length && (moved || deliverSettings.remove_after_drop)) {
    selected = new Set();
    await changeDeliver('/api/deliver/remove', { ids });
  } else {
    loadDeliver();
  }
};

// Now playing. The app reads it from the system and calls relayNowPlaying; the buttons send commands back.
function position() {
  if (!music || !(music.duration > 0) || !Number.isFinite(music.elapsed)) return null;
  const rate = music.playing ? (music.rate > 0 ? music.rate : 1) : 0;
  const since = Math.max(0, (Date.now() - (Number.isFinite(music.updatedAt) ? music.updatedAt : music.receivedAt)) / 1000);
  return Math.min(music.duration, Math.max(0, music.elapsed + rate * since));
}

function tickProgress() {
  if (view !== 'music' || mode === 'pill') return;
  const pos = position();
  $('progress').toggleAttribute('data-empty', pos === null);
  if (pos === null) {
    $('musicElapsed').textContent = '';
    $('musicRemaining').textContent = '';
    return;
  }
  $('musicElapsed').textContent = format(Math.floor(pos));
  $('musicRemaining').textContent = `-${format(Math.max(0, Math.floor(music.duration) - Math.floor(pos)))}`;
  $('progressFill').style.width = `${(pos / music.duration * 100).toFixed(1)}%`;
}

// The colour of the cover, for the glow, the equalizer and the dot on the Music tab.
const colours = new Map();
function coverColour(src) {
  if (colours.has(src)) return Promise.resolve(colours.get(src));
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      let found = null;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 16;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, 16, 16);
        const data = context.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0, weight = 0;
        for (let i = 0; i < data.length; i += 4) {
          const high = Math.max(data[i], data[i + 1], data[i + 2]);
          const low = Math.min(data[i], data[i + 1], data[i + 2]);
          // Vivid, bright pixels speak for the cover; grey and dark ones barely count.
          const w = ((high ? (high - low) / high : 0) ** 2) * (high / 255) + 0.01;
          r += data[i] * w; g += data[i + 1] * w; b += data[i + 2] * w; weight += w;
        }
        r /= weight; g /= weight; b /= weight;
        const top = Math.max(r, g, b);
        if (top > 0) {
          const lift = top < 170 ? 170 / top : 1; // dark covers still need a visible glow
          found = `rgb(${Math.min(255, Math.round(r * lift))}, ${Math.min(255, Math.round(g * lift))}, ${Math.min(255, Math.round(b * lift))})`;
        }
      } catch (_) {
        /* No canvas, or the image cannot be read: keep the default colour. */
      }
      colours.set(src, found);
      if (colours.size > 20) colours.delete(colours.keys().next().value);
      resolve(found);
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

// The cover frame takes the cover's own shape (9:16, 3:4, square, 16:9...), so the whole picture shows.
function resetCoverShape() {
  const style = $('panel').style;
  for (const name of ['--cover-w', '--cover-h', '--pill-w', '--pill-h']) style.removeProperty(name);
}

function fitInto(ratio, maxWidth, maxHeight) {
  const width = Math.min(maxWidth, maxHeight * ratio);
  return [Math.round(width), Math.round(width / ratio)];
}

function fitCoverShape() {
  const { naturalWidth: width, naturalHeight: height } = $('musicArt');
  const ratio = width && height ? Math.min(3, Math.max(0.5, width / height)) : 1;
  if (Math.abs(ratio - 1) < 0.03) {
    resetCoverShape(); // square covers fill the square frame
    return;
  }
  const style = $('panel').style;
  const [coverWidth, coverHeight] = fitInto(ratio, 150, 112);
  const [pillWidth, pillHeight] = fitInto(ratio, 38, 24);
  style.setProperty('--cover-w', `${coverWidth}px`);
  style.setProperty('--cover-h', `${coverHeight}px`);
  style.setProperty('--pill-w', `${pillWidth}px`);
  style.setProperty('--pill-h', `${pillHeight}px`);
}
$('musicArt').addEventListener('load', fitCoverShape);

// What gives off light: agents at work, or music. The Music view prefers the music, everything else the agents.
function updateGlow() {
  const panel = $('panel');
  const working = !!current?.running && !current.paused;
  const playing = !!music?.playing;
  let glow = '';
  if (mode === 'pill') glow = playing ? 'music' : '';
  else if (view === 'music') glow = playing ? 'music' : working ? 'agent' : '';
  else glow = working ? 'agent' : playing ? 'music' : '';
  if (glow) panel.dataset.glow = glow;
  else delete panel.dataset.glow;
  room.setMusic(playing && officeMusicEnabled);
  $('officeMusic').hidden = !playing;
}

function renderMusic() {
  const panel = $('panel');
  if (!music) {
    delete panel.dataset.music;
    panel.style.removeProperty('--cover');
    resetCoverShape();
    $('musicTitle').textContent = 'Nothing is playing';
    $('musicArtist').textContent = 'Start music in any app and it shows up here.';
    $('music').removeAttribute('data-playing');
    $('pill').removeAttribute('data-playing');
    tabs.music.removeAttribute('data-live');
    $('musicArt').hidden = true;
    $('pillArt').hidden = true;
    $('musicSource').hidden = true;
    musicArt = '';
    musicTrack = '';
    fx.setPlaying(false);
    fx.setColour('');
    if (view === 'music' && mode === 'pill') setView(fallbackView(), { focus: false });
    updateGlow();
    return;
  }
  panel.dataset.music = '1';
  const artist = music.artist || music.album || '';
  const track = `${music.title}\n${artist}`;
  if (track !== musicTrack) {
    musicTrack = track;
    fx.setTrack(track); // every track gets its own tempo and phrasing
  }
  fx.setPlaying(!!music.playing);
  $('musicTitle').textContent = music.title;
  $('musicArtist').textContent = artist;
  $('pillTitle').textContent = music.title;
  $('pillArtist').textContent = artist;
  $('music').toggleAttribute('data-playing', !!music.playing);
  $('pill').toggleAttribute('data-playing', !!music.playing);
  tabs.music.toggleAttribute('data-live', !!music.playing);
  $('musicToggle').setAttribute('aria-label', music.playing ? 'Pause' : 'Play');
  const art = typeof music.artwork === 'string' ? music.artwork : '';
  if (art !== musicArt) {
    musicArt = art;
    for (const id of ['musicArt', 'pillArt']) {
      if (art) $(id).src = art;
      else $(id).removeAttribute('src');
    }
    panel.style.removeProperty('--cover');
    if (!art) fx.setColour(''); // with a cover, the old colours stay until the new cover's arrive: no flash of the default
    resetCoverShape();
    if (art) coverColour(art).then(colour => {
      if (!colour || art !== musicArt) return;
      panel.style.setProperty('--cover', colour);
      fx.setColour(colour);
    });
  }
  $('musicArt').hidden = !art;
  $('pillArt').hidden = !art;
  // Where the sound comes from: the app's icon and name, when the app told us.
  const appName = typeof music.appName === 'string' ? music.appName : '';
  const appIcon = typeof music.appIcon === 'string' && music.appIcon.startsWith('data:image/png') ? music.appIcon : '';
  $('musicSource').hidden = !appName;
  $('musicApp').textContent = appName;
  $('musicAppIcon').hidden = !appIcon;
  if (appIcon && $('musicAppIcon').getAttribute('src') !== appIcon) $('musicAppIcon').src = appIcon;
  updateGlow();
  tickProgress();
}

window.relayNowPlaying = state => {
  music = state && typeof state.title === 'string' && state.title ? { ...state, receivedAt: Date.now() } : null;
  renderMusic();
};

for (const [id, command] of [['musicPrev', 'previous'], ['musicToggle', 'toggle'], ['musicNext', 'next']]) {
  $(id).addEventListener('click', () => tell({ type: 'media', command }));
}

// The Paste button on the Translate page asked the app for the clipboard; this is its answer.
window.relayClipboard = text => translator.pasted(text);

// The app sets the shape of the panel (pill, compact or full) and tells us how tall the notch is.
window.relayPanelMode = info => {
  if (!info || typeof info !== 'object') return;
  const next = ['pill', 'compact', 'full'].includes(info.mode) ? info.mode : 'compact';
  const root = document.documentElement.style;
  if (Number.isFinite(info.notchHeight) && info.notchHeight > 0) root.setProperty('--notch-h', `${Math.round(info.notchHeight)}px`);
  if (Number.isFinite(info.notchWidth) && info.notchWidth > 0) root.setProperty('--notch-w', `${Math.round(info.notchWidth)}px`);
  mode = next;
  $('panel').dataset.mode = mode;
  setFxPicker(false); // a freshly shown panel never starts with the picker open
  setMore(false);
  setRemind(false);
  if (ask.resizing) ask.resizing = false; // the panel changed size because of the card: the card stays
  else closeAsk(false);                  // a panel that appears again starts without it
  closeType();
  paintVoice(); // the window may have turned the microphone on or off
  syncWake();
  applyTabs(); // the window may have changed the tabs while the panel was away
  fx.setScene({ mode, view });
  updateGlow();
  // A new appearance starts without the keyboard: typing begins only when the person clicks the note field.
  const wasHolding = holding;
  $('noteInput').blur();
  inputFocused = false;
  holding = false;
  if (wasHolding) tell({ type: 'hold', on: false });
  if (mode === 'pill') return;
  let target = typeof info.view === 'string' ? info.view : chosenView;
  if (current?.plan && (target === 'notes' || target === 'music')) target = 'task';
  setView(target, { focus: false, autoOffice: target === 'office' });
  translator.refit(); // the app forgets what height was asked for when the shape changes
  syncHold(); // a card that is still open keeps the panel open
  // A plan that needs an answer does not fit in the small panel.
  if (mode === 'compact' && current?.plan) tell({ type: 'expand' });
};

// The app may have found something playing before this page finished loading: ask it to send that now.
tell({ type: 'ready' });

$('approve').addEventListener('click', () => current?.plan && decide('/api/approve-plan', { id: current.id, plan_id: current.plan.id }));
$('reject').addEventListener('click', () => current?.plan && decide('/api/stop', { id: current.id }));
for (const id of ['open', 'open2']) $(id).addEventListener('click', () => tell({ type: 'open' }));
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  $('noteInput').blur(); // lets go of the hold before the panel hides
  translator.blur();
  tell({ type: 'hide' });
});

room.start();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) translator.reset(); // closing the panel clears the Translate page: the next opening starts clean
  fx.refresh(); // stops drawing while the panel is hidden, and picks up again when it shows
  if (!document.hidden && view === 'office') room.start();
  else room.stop();
});
window.addEventListener('pagehide', () => {
  room.stop();
  collaboration.hideHandoff();
});
render(null);
renderMusic();
renderDeliver();
applyTabs();
setView('notes', { focus: false });
loadNotes();
loadDeliver();
poll();
setInterval(poll, 1000);
if (new URLSearchParams(location.search).get('view') === 'office') window.relayPanelMode({ mode: 'full', view: 'office' });
setInterval(tickTimer, 1000);
setInterval(tickProgress, 500);
// A file may have been moved or deleted since; with Auto-catch or a time limit on, the shelf changes by itself on any tab.
setInterval(() => { if ((view === 'deliver' || deliverSettings.auto_catch || deliverSettings.expire_hours) && mode !== 'pill') loadDeliver(); }, 3000);
