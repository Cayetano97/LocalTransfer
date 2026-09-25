import './styles.css';
import QRCode from 'qrcode';
import {getRelaySockets, joinRoom, selfId} from 'trystero';
import {getLang, setLang, t, type Lang} from './i18n';
import {
  AUTO_ACCEPT_BYTES,
  PICKER_MIN_BYTES,
  SLICE_SIZE,
  StorageError,
  completedIncomingUrl,
  createSink,
  deleteIncomingFile,
  headHash,
  isSaneSliceSize,
  requestPersistence,
  transferKey,
  type SinkCloseResult,
  type TransferSink
} from './chunked-file';

type TrysteroRoom = ReturnType<typeof joinRoom>;

const APP_ID = 'localtransfer';

// --- tiny dom helpers -------------------------------------------------------

export function $(selector: string): HTMLElement {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el as HTMLElement;
}

export function toast(message: string): void {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  box.appendChild(el);
  window.setTimeout(() => el.remove(), 3600);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 6)}…` : id;
}

// --- theme: prefers-color-scheme default, localStorage persist --------------

const THEME_KEY = 'localtransfer-theme';

function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme;
  const icon = document.querySelector('#themeIcon');
  const isDark =
    theme === 'dark' ||
    (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (icon) {
    icon.innerHTML = isDark
      ? '<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />'
      : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />';
  }
}

function initTheme(): void {
  const stored = localStorage.getItem(THEME_KEY);
  applyTheme(stored ?? 'auto');
  $('#themeToggle').addEventListener('click', (event) => {
    const current = document.documentElement.dataset.theme ?? 'auto';
    // Fixed cycle: auto → light → dark → auto (auto is always reachable).
    const next = current === 'auto' ? 'light' : current === 'light' ? 'dark' : 'auto';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    // Icon morph feedback: quick rotate-settle via WAAPI (GPU transform only).
    // Skipped under reduced-motion — the icon swap alone carries the meaning.
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const btn = event.currentTarget as HTMLElement;
      btn.animate(
        [{transform: 'rotate(0deg) scale(1)'}, {transform: 'rotate(120deg) scale(0.85)'}, {transform: 'rotate(0deg) scale(1)'}],
        {duration: 300, easing: 'cubic-bezier(0.23, 1, 0.32, 1)'}
      );
    }
  });
}

// --- room code: `#room=XXXX` or `#XXXX` --------------------------------------

export function roomFromHash(): string {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return '';
  const params = new URLSearchParams(hash.includes('=') ? hash : `room=${hash}`);
  return (params.get('room') ?? '').trim().slice(0, 32);
}

export function inviteLink(room: string): string {
  const url = new URL(window.location.href);
  url.hash = `room=${encodeURIComponent(room)}`;
  return url.toString();
}

export function randomRoom(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function renderQr(room: string): Promise<void> {
  const canvas = $('#qrCanvas') as unknown as HTMLCanvasElement;
  try {
    await QRCode.toCanvas(canvas, room ? inviteLink(room) : window.location.href, {
      width: 192,
      margin: 1
    });
    // qrcode writes inline width/height styles — clear them so CSS owns
    // the display size (96px, 80px on short screens) without re-rendering.
    canvas.style.width = '';
    canvas.style.height = '';
  } catch {
    // QR is a convenience; never block joining on it.
  }
}

// --- presence (T2): room join, names, peer list ------------------------------

let room: TrysteroRoom | null = null;
let currentRoom = '';
let sendName: ((name: string, options?: {target?: string | string[] | null}) => Promise<void>) | null = null;
const peerNames = new Map<string, string>();

// Relay socket health via trystero's public `getRelaySockets()` (URL → WebSocket).
// 'unknown' means we cannot observe the sockets — never claim a failure then.
type RelayHealth = 'ok' | 'down' | 'unknown';
let lastRelayHealth: RelayHealth = 'unknown';

function checkRelayHealth(): RelayHealth {
  try {
    const sockets = Object.values(
      ((getRelaySockets() ?? {}) as Record<string, {readyState?: number}>)
    );
    if (sockets.length === 0) return 'unknown';
    // CONNECTING(0) or OPEN(1) counts as healthy; only all-closed is down.
    return sockets.some((s) => s.readyState === 0 || s.readyState === 1) ? 'ok' : 'down';
  } catch {
    return 'unknown';
  }
}

/** Watch relay sockets while alone so a silent signalling drop surfaces. */
function initRelayWatch(): void {
  window.setInterval(() => {
    if (!room || peerNames.size > 0) return;
    // Never clobber an in-progress inline rename.
    if (document.querySelector('.peer-rename-input')) return;
    const health = checkRelayHealth();
    if (health !== lastRelayHealth) renderPeers();
  }, 4000);
}

export function getRoom(): TrysteroRoom | null {
  return room;
}

export function getCurrentRoom(): string {
  return currentRoom;
}

export function peerDisplayName(peerId: string): string {
  return peerNames.get(peerId) ?? t('peerFallback', {id: shortId(peerId)});
}

function ownNick(): string {
  const value = ($('#nickInput') as HTMLInputElement).value.trim().slice(0, 24);
  return value || `guest-${shortId(selfId)}`;
}

/** Commit an inline self-rename: persist, update nickInput, broadcast `name`. */
function commitSelfRename(raw: string): void {
  const next = raw.trim().slice(0, 24);
  const nickInput = $('#nickInput') as HTMLInputElement;
  if (next && next !== ownNick()) {
    nickInput.value = next;
    localStorage.setItem('localtransfer-nick', next);
    // Self display name lives in nickInput (peerNames tracks remote peers
    // only); broadcast through the existing `name` action.
    if (room) void sendName?.(next);
  }
  renderPeers();
}

/** Replace the self row's name span with an inline input (Enter/blur commit). */
function beginSelfRename(row: HTMLLIElement, nameEl: HTMLElement): void {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'peer-rename-input';
  input.maxLength = 24;
  input.value = ownNick();
  input.setAttribute('aria-label', t('renameNick'));
  row.replaceChild(input, nameEl);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    if (commit) commitSelfRename(input.value);
    else renderPeers(); // Escape: cancel and rebuild the row.
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
}

function renderPeers(): void {
  const list = $('#peerList');
  list.innerHTML = '';
  // Truthful count: self always participates once in a room.
  const total = room ? peerNames.size + 1 : 0;
  $('#peerCount').textContent = String(total);
  $('#peerCount').setAttribute(
    'aria-label',
    t(total === 1 ? 'peerCountOne' : 'peerCountOther', {count: total})
  );

  if (!room) {
    // Pre-join: workspace is hidden, but the list stays honest for i18n.
    const empty = document.createElement('li');
    empty.id = 'peerEmpty';
    empty.className = 'muted';
    empty.textContent = t('notInRoom');
    list.appendChild(empty);
    syncTargetSelect();
    return;
  }

  const selfItem = document.createElement('li');
  selfItem.className = 'peer self';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = `${ownNick()} ${t('you')}`;
  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'btn btn-ghost peer-rename';
  renameBtn.textContent = t('rename');
  renameBtn.setAttribute('aria-label', t('renameNick'));
  renameBtn.addEventListener('click', () => beginSelfRename(selfItem, name));
  const id = document.createElement('span');
  id.className = 'id';
  id.textContent = shortId(selfId);
  selfItem.append(dot, name, renameBtn, id);
  list.appendChild(selfItem);

  for (const peerId of peerNames.keys()) {
    const item = document.createElement('li');
    item.className = 'peer';
    const peerDot = document.createElement('span');
    peerDot.className = 'dot';
    peerDot.setAttribute('aria-hidden', 'true');
    const peerName = document.createElement('span');
    peerName.className = 'name';
    peerName.textContent = peerDisplayName(peerId);
    const peerIdEl = document.createElement('span');
    peerIdEl.className = 'id';
    peerIdEl.textContent = shortId(peerId);
    item.append(peerDot, peerName, peerIdEl);
    list.appendChild(item);
  }

  // Persistent waiting state while alone — no transient flash. When the
  // signalling relays are unreachable, surface that honestly instead of
  // pretending everything is fine (auto-retry is trystero's own behaviour).
  if (peerNames.size === 0) {
    lastRelayHealth = checkRelayHealth();
    const waiting = document.createElement('li');
    waiting.className = lastRelayHealth === 'down' ? 'muted peer-waiting is-error' : 'muted peer-waiting';
    waiting.textContent = lastRelayHealth === 'down' ? t('connProblem') : t('nobodyHere');
    list.appendChild(waiting);
  }

  syncTargetSelect();
}

function syncTargetSelect(): void {
  const select = $('#targetSelect') as HTMLSelectElement;
  const previous = select.value;
  select.innerHTML = '';
  const everyone = document.createElement('option');
  everyone.value = '*';
  everyone.textContent = t('everyone');
  select.appendChild(everyone);
  for (const peerId of peerNames.keys()) {
    const option = document.createElement('option');
    option.value = peerId;
    option.textContent = peerDisplayName(peerId);
    select.appendChild(option);
  }
  select.value = [...select.options].some((o) => o.value === previous) ? previous : '*';
}

function setJoinedUI(joined: boolean): void {
  document.body.classList.toggle('is-joined', joined);
  $('#entryPanel').classList.toggle('hidden', joined);
  $('#workspace').classList.toggle('hidden', !joined);
  const badge = $('#roomBadge');
  badge.classList.toggle('hidden', !joined);
  if (joined) badge.textContent = t('roomBadge', {room: currentRoom});
}

export async function joinRoomByCode(code: string): Promise<void> {
  const roomCode = code.trim().slice(0, 32);
  if (!roomCode) {
    toast(t('needRoom'));
    return;
  }
  await leaveRoom(true);

  currentRoom = roomCode;
  room = joinRoom({appId: APP_ID}, roomCode);
  peerNames.clear();
  for (const peerId of Object.keys(room.getPeers())) peerNames.set(peerId, peerDisplayName(peerId));

  const nameAction = room.makeAction<string>('name');
  sendName = (name, options) => nameAction.send(name, options);
  nameAction.onMessage = (name, {peerId}) => {
    peerNames.set(peerId, name.trim().slice(0, 24) || peerDisplayName(peerId));
    renderPeers();
  };

  setupFileChannel(room);

  room.onPeerJoin = (peerId) => {
    peerNames.set(peerId, peerDisplayName(peerId));
    renderPeers();
    toast(t('peerJoined', {peer: peerDisplayName(peerId)}));
    // Introduce ourselves to the newcomer and refresh everyone.
    void sendName?.(ownNick(), {target: peerId});
  };
  room.onPeerLeave = (peerId) => {
    const label = peerDisplayName(peerId);
    peerNames.delete(peerId);
    onPeerLeft(peerId);
    renderPeers();
    toast(t('peerLeft', {peer: label}));
  };

  if (window.location.hash !== `#room=${encodeURIComponent(roomCode)}`) {
    window.location.hash = `room=${encodeURIComponent(roomCode)}`;
  }
  localStorage.setItem('localtransfer-nick', ($('#nickInput') as HTMLInputElement).value.trim());
  setJoinedUI(true);
  renderPeers();
  void renderQr(roomCode);
  void sendName?.(ownNick());
  toast(t('joinedRoom', {room: roomCode}));
}

export async function leaveRoom(silent = false): Promise<void> {
  // Stop live transfers first: abort messages still have the old room's action.
  // Completed history, its object URLs and the stored files are left untouched.
  abortRoomTransfers();
  if (room) {
    try {
      await room.leave();
    } catch {
      // Leaving is best-effort; dropping the reference is what matters.
    }
    room = null;
    sendName = null;
    fileChunks = null;
    fileCtl = null;
  }
  peerNames.clear();
  currentRoom = '';
  if (!silent) {
    setJoinedUI(false);
    ($('#roomInput') as HTMLInputElement).value = '';
    // Drop the room hash so a refresh lands on the entry form, not a rejoined room.
    if (window.location.hash) {
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
    renderPeers();
    toast(t('leftRoom'));
  }
}

// --- join panel (T2): segmented create/join entry -----------------------------

type EntryMode = 'create' | 'join';

let entryMode: EntryMode = 'create';

/** Mode-aware copy: labels, helper, placeholder, required, submit text. */
function updateEntryModeCopy(): void {
  const create = entryMode === 'create';
  $('#entryModesLabel').textContent = t('entryModeLabel');
  $('#modeCreateLabel').textContent = t('modeCreate');
  $('#modeJoinLabel').textContent = t('modeJoin');
  $('#roomLabel').textContent = t(create ? 'roomLabelCreate' : 'roomLabelJoin');
  const roomInput = $('#roomInput') as HTMLInputElement;
  roomInput.placeholder = t(create ? 'roomPhCreate' : 'roomPhJoin');
  // Join semantics are enforced in the submit handler so the existing
  // `needRoom` toast stays the recovery path (native `required` would
  // block submit before the toast could fire).
  roomInput.setAttribute('aria-required', String(!create));
  $('#roomHelp').textContent = t(create ? 'roomHelpCreate' : 'roomHelpJoin');
  $('#entrySubmit').textContent = t(create ? 'create' : 'join');
}

function setEntryMode(mode: EntryMode): void {
  entryMode = mode;
  ($('#modeCreate') as HTMLInputElement).checked = mode === 'create';
  ($('#modeJoin') as HTMLInputElement).checked = mode === 'join';
  updateEntryModeCopy();
}

function initJoinPanel(): void {
  const roomInput = $('#roomInput') as HTMLInputElement;
  const nickInput = $('#nickInput') as HTMLInputElement;
  nickInput.value = localStorage.getItem('localtransfer-nick') ?? '';

  const initial = roomFromHash();
  roomInput.value = initial;
  setEntryMode(initial ? 'join' : 'create');

  $('#modeCreate').addEventListener('change', () => {
    if (($('#modeCreate') as HTMLInputElement).checked) setEntryMode('create');
  });
  $('#modeJoin').addEventListener('change', () => {
    if (($('#modeJoin') as HTMLInputElement).checked) setEntryMode('join');
  });

  nickInput.addEventListener('change', () => {
    localStorage.setItem('localtransfer-nick', nickInput.value.trim());
    if (room) {
      void sendName?.(ownNick());
      renderPeers();
    }
  });

  // Mode-aware submit: Create uses the typed name as the room code or mints
  // a random one; Join requires a non-empty code (needRoom toast recovery).
  $('#entryForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if (room) return;
    const code = roomInput.value.trim();
    if (entryMode === 'join') {
      if (!code) {
        toast(t('needRoom'));
        return;
      }
      void joinRoomByCode(code);
    } else {
      void joinRoomByCode(code || randomRoom());
    }
  });

  $('#leaveBtn').addEventListener('click', () => void leaveRoom());

  $('#copyLinkBtn').addEventListener('click', async (event) => {
    const target = currentRoom;
    if (!target) {
      toast(t('needRoom'));
      return;
    }
    try {
      await navigator.clipboard.writeText(inviteLink(target));
      toast(t('inviteCopied'));
      // Success pop: green edge + press-settle. Class removed so it never sticks.
      const btn = event.currentTarget as HTMLButtonElement;
      btn.classList.add('is-success');
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        btn.animate(
          [{transform: 'scale(1)'}, {transform: 'scale(0.95)'}, {transform: 'scale(1)'}],
          {duration: 220, easing: 'cubic-bezier(0.23, 1, 0.32, 1)'}
        );
      }
      window.setTimeout(() => btn.classList.remove('is-success'), 1400);
    } catch {
      toast(t('clipboardFail'));
    }
  });

  window.addEventListener('hashchange', () => {
    const next = roomFromHash();
    if (next && next !== currentRoom) {
      if (next !== roomInput.value) roomInput.value = next;
      // A room hash is an invitation to connect — prefill Join mode.
      setEntryMode('join');
    }
  });

  // Deep link: opening a room URL joins it immediately (skip the entry form).
  if (initial) {
    $('#entryPanel').classList.add('hidden');
    $('#workspace').classList.remove('hidden');
    void joinRoomByCode(initial);
  }
}

// --- i18n (T5): EN/ES toggle, persisted, navigator default --------------------

function applyI18n(): void {
  document.title = t('docTitle');
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute('content', t('metaDesc'));

  $('#entryTitle').textContent = t('entryTitle');
  $('#entrySub').textContent = t('entrySub');
  $('#nickLabel').textContent = t('nickLabel');
  ($('#nickInput') as HTMLInputElement).placeholder = t('nickPh');
  // Mode-aware copy: labels, helpers, placeholder, required, submit text.
  updateEntryModeCopy();
  $('#leaveBtn').textContent = t('leave');
  $('#copyLinkBtn').textContent = t('copyInvite');
  ($('#qrCanvas') as HTMLCanvasElement).setAttribute('aria-label', t('qrLabel'));
  $('#peersLabel').textContent = t('peers');
  // Pre-JS placeholder: removed from the DOM by the first renderPeers().
  const peerEmpty = document.querySelector('#peerEmpty');
  if (peerEmpty) peerEmpty.textContent = t('notInRoom');
  $('#filesTitle').textContent = t('files');
  $('#dropStrong').textContent = t('dropStrong');
  $('#dropOr').textContent = t('dropOr');
  $('#dropChoose').textContent = t('dropChoose');
  $('#dropZone').setAttribute('aria-label', t('dropHint'));
  $('#dropNote').textContent = t('dropNote');
  $('#fileHint').textContent = window.isSecureContext ? t('largeHint') : t('insecureHint');
  $('#sendToLabel').textContent = t('sendTo');
  $('#receivedTitle').textContent = t('received');
  $('#historyEmpty').textContent = t('historyEmpty');
  $('#queueEmpty').textContent = t('queueEmpty');
  $('#tabPeers').textContent = t('peers');
  $('#tabFiles').textContent = t('files');
  const skip = document.querySelector('.skip-link');
  if (skip) skip.textContent = t('skipLink');
  const foot = document.querySelector('.foot span');
  if (foot) foot.textContent = t('footNote');
  const panelTabs = document.querySelector('.panel-tabs');
  if (panelTabs) panelTabs.setAttribute('aria-label', t('files') + ' / ' + t('peers'));
  $('#themeToggle').setAttribute('aria-label', t('themeLabel'));
  $('#roomBadge').title = t('roomBadgeTitle');
  ($('.lang-switch') as HTMLElement | null)?.setAttribute('aria-label', t('langLabel'));

  syncLangButtons();
  // Re-render everything dynamic: badges, peers, target options, transfers.
  setJoinedUI(room !== null);
  renderPeers();
  rerenderTransfers();
}

function syncLangButtons(): void {
  const lang = getLang();
  for (const code of ['en', 'es'] as Lang[]) {
    const btn = $(`#lang${code === 'en' ? 'En' : 'Es'}`);
    const active = lang === code;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
}

function initI18n(): void {
  // setLang applies the stored (or navigator-derived) default + <html lang>.
  setLang(getLang());
  $('#langEn').addEventListener('click', () => {
    if (getLang() !== 'en') {
      setLang('en');
      applyI18n();
    }
  });
  $('#langEs').addEventListener('click', () => {
    if (getLang() !== 'es') {
      setLang('es');
      applyI18n();
    }
  });
}

// --- single viewport (T6): mobile peers/files tab switch ---------------------

type Panel = 'peers' | 'files';

function setPanel(panel: Panel): void {
  document.body.dataset.panel = panel;
  const isDesktop = window.matchMedia('(min-width: 768px)').matches;
  for (const name of ['peers', 'files'] as Panel[]) {
    const tab = $(`#tab${name === 'peers' ? 'Peers' : 'Files'}`);
    const active = panel === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.setAttribute('tabindex', active ? '0' : '-1');
    const card = $(`#${name}Card`);
    // `hidden` drives the mobile single-panel view; desktop CSS re-shows both.
    if (isDesktop) card.removeAttribute('hidden');
    else if (active) card.removeAttribute('hidden');
    else card.setAttribute('hidden', '');
  }
}

function initPanelTabs(): void {
  $('#tabPeers').addEventListener('click', () => setPanel('peers'));
  $('#tabFiles').addEventListener('click', () => setPanel('files'));
  // Roving tabindex: arrow keys move between tabs (WCAG 2.1 keyboard pattern).
  for (const [name, next] of [['peers', 'files'], ['files', 'peers']] as Panel[][]) {
    $(`#tab${name === 'peers' ? 'Peers' : 'Files'}`).addEventListener('keydown', (event) => {
      const e = event as KeyboardEvent;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const target = $(`#tab${next === 'peers' ? 'Peers' : 'Files'}`);
        (target as HTMLButtonElement).focus();
        setPanel(next as Panel);
      }
    });
  }
  window.matchMedia('(min-width: 768px)').addEventListener?.('change', () =>
    setPanel((document.body.dataset.panel as Panel) === 'files' ? 'files' : 'peers')
  );
  setPanel((document.body.dataset.panel as Panel) === 'files' ? 'files' : 'peers');
}

// --- files (T3): send/receive over the `file` action --------------------------

// Message and action types for the sliced file protocol live at the top of the
// file-channel section below.

// --- file channel: sliced protocol for large files ---------------------------
//
// Trystero materialises a whole payload before chunking it
// (`await data.arrayBuffer()` + a pre-allocated chunk array), so a 5 GB file
// would need ~2-3x its size in RAM and Chromium refuses single Blob reads past
// ~2 GiB. Files therefore travel as 4 MiB slices over the `file` action,
// coordinated by JSON messages on `fileCtl`; the receiver streams every slice
// straight to disk. See odd/tasks/large-file-transfer.md.

type Json = string | number | boolean | null | Json[] | {[key: string]: Json};

type BinaryData = ArrayBuffer | Uint8Array | Blob;

type FileMetaMsg = {
  t: 'meta';
  id: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  /** FNV-1a of the first 64 KiB; keeps resume keys content-aware without Web Crypto. */
  head: string;
  sliceSize: number;
  total: number;
};

type FileCtlMsg =
  | FileMetaMsg
  | {t: 'offer'; id: string; offset: number}
  | {t: 'decline'; id: string}
  | {t: 'done'; id: string; size: number}
  | {t: 'abort'; id: string; reason: 'user' | 'error' | 'peer'};

type FileChunkAction = {
  send: (
    data: BinaryData,
    options?: {target?: string | string[] | null; metadata?: {[key: string]: Json}}
  ) => Promise<void>;
  onMessage:
    | ((data: BinaryData, context: {peerId: string; metadata?: Json}) => void | Promise<void>)
    | null;
};

type FileCtlAction = {
  send: (data: FileCtlMsg, options?: {target?: string | string[] | null}) => Promise<void>;
  onMessage: ((data: unknown, context: {peerId: string}) => void | Promise<void>) | null;
};

let fileChunks: FileChunkAction | null = null;
let fileCtl: FileCtlAction | null = null;

/** UUID v4 with a getRandomValues fallback (randomUUID needs a secure context). */
function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- wake lock: long transfers must survive screen sleep ---------------------

let wakeLock: WakeLockSentinel | null = null;

function hasActiveTransfers(): boolean {
  for (const out of outgoing.values()) {
    for (const peer of out.targets.values()) {
      if (!peer.done && !peer.failed) return true;
    }
  }
  for (const rec of incoming.values()) {
    if (rec.phase === 'active' || rec.phase === 'pending') return true;
  }
  return false;
}

async function syncWakeLock(): Promise<void> {
  if (!('wakeLock' in navigator)) return;
  const active = hasActiveTransfers();
  if (active && !wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      wakeLock = null;
    }
  } else if (!active && wakeLock) {
    try {
      await wakeLock.release();
    } catch {
      // The browser already released it (hidden tab, low battery).
    }
    wakeLock = null;
  }
}

// --- outgoing transfers ------------------------------------------------------

type OutPeer = {
  peerId: string;
  offset: number;
  sent: number;
  done: boolean;
  failed: boolean;
  declined: boolean;
  sending: boolean;
};

type Outgoing = {
  id: string;
  file: File;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  total: number;
  targets: Map<string, OutPeer>;
  aborted: boolean;
};

const outgoing = new Map<string, Outgoing>();

function cancelOutgoing(id: string): void {
  const out = outgoing.get(id);
  if (!out || out.aborted) return;
  out.aborted = true;
  const targets: string[] = [];
  for (const peer of out.targets.values()) {
    if (!peer.done) {
      peer.failed = true;
      targets.push(peer.peerId);
    }
  }
  if (targets.length > 0 && fileCtl) {
    void fileCtl.send({t: 'abort', id, reason: 'user'}, {target: targets});
  }
  refreshOutgoing(out);
}

function refreshOutgoing(out: Outgoing): void {
  upsertTransferItem($('#fileQueue'), `out-${out.id}`, outgoingState(out));
  void syncWakeLock();
}

async function startPeerSend(out: Outgoing, peer: OutPeer): Promise<void> {
  if (peer.sending || out.aborted) return;
  peer.sending = true;
  if (peer.offset > 0 && out.size > 0) {
    toast(t('resumeNote', {name: out.name, pct: Math.round((peer.offset / out.size) * 100)}));
  }
  try {
    let seq = Math.floor(peer.offset / SLICE_SIZE);
    while (!out.aborted && seq < out.total) {
      const start = seq * SLICE_SIZE;
      const end = Math.min(start + SLICE_SIZE, out.size);
      const buffer = await out.file.slice(start, end).arrayBuffer();
      if (out.aborted || peer.failed || peer.done) break;
      if (!fileChunks || !peerNames.has(peer.peerId)) {
        peer.failed = true;
        break;
      }
      await fileChunks.send(buffer, {target: peer.peerId, metadata: {id: out.id, seq}});
      peer.sent = end;
      seq += 1;
      queueTransferItem($('#fileQueue'), `out-${out.id}`, outgoingState(out));
    }
  } catch {
    peer.failed = true;
  }
  peer.sending = false;
  refreshOutgoing(out);
}

async function startOutgoing(file: File): Promise<void> {
  if (!fileCtl) return;
  const targetValue = ($('#targetSelect') as HTMLSelectElement).value;
  const targetIds = targetValue === '*' ? [...peerNames.keys()] : [targetValue];
  if (targetIds.length === 0) {
    toast(t('nobodyHere'));
    return;
  }
  const id = randomId();
  const head = await headHash(file);
  const out: Outgoing = {
    id,
    file,
    name: file.name.slice(0, 128) || t('incomingFile'),
    type: file.type || 'application/octet-stream',
    size: file.size,
    lastModified: file.lastModified,
    total: Math.max(1, Math.ceil(file.size / SLICE_SIZE)),
    targets: new Map(
      targetIds.map((peerId) => [
        peerId,
        {peerId, offset: 0, sent: 0, done: false, failed: false, declined: false, sending: false}
      ])
    ),
    aborted: false
  };
  outgoing.set(id, out);
  refreshOutgoing(out);
  void requestPersistence();
  const meta: FileMetaMsg = {
    t: 'meta',
    id,
    name: out.name,
    type: out.type,
    size: out.size,
    lastModified: out.lastModified,
    head,
    sliceSize: SLICE_SIZE,
    total: out.total
  };
  for (const peerId of targetIds) await fileCtl.send(meta, {target: peerId});
}

// --- incoming transfers ------------------------------------------------------

type Incoming = {
  id: string;
  key: string;
  peerId: string;
  name: string;
  type: string;
  size: number;
  sliceSize: number;
  total: number;
  sink: TransferSink | null;
  kind: TransferSink['kind'] | null;
  bytes: number;
  nextSeq: number;
  phase: TransferPhase;
  canceled: boolean;
  finishing: boolean;
  /** Serialises slice handling: onMessage can fire again while a write awaits. */
  queue: Promise<void>;
  /** Detail override for failure/status cases the generic states cannot name. */
  detail?: TransferDetail;
};

const incoming = new Map<string, Incoming>();

async function failIncoming(
  rec: Incoming,
  detail: TransferDetail,
  notify: 'abort' | 'decline',
  discard = false
): Promise<void> {
  const sink = rec.sink;
  rec.sink = null;
  if (sink) {
    // A sequence gap means the partial is missing bytes: resuming from its
    // size would silently corrupt the file, so it must be discarded.
    if (rec.kind === 'opfs' && !discard) await sink.suspend().catch(() => {});
    else await sink.abort().catch(() => {});
  }
  rec.phase = 'failed';
  rec.detail = detail;
  upsertTransferItem($('#fileHistory'), `in-${rec.id}`, incomingState(rec));
  if (fileCtl) {
    const msg: FileCtlMsg =
      notify === 'abort' ? {t: 'abort', id: rec.id, reason: 'error'} : {t: 'decline', id: rec.id};
    void fileCtl.send(msg, {target: rec.peerId});
  }
  void syncWakeLock();
}

async function prepareIncoming(rec: Incoming): Promise<void> {
  if (rec.phase !== 'pending' || rec.canceled || !fileCtl) return;
  rec.phase = 'active';
  upsertTransferItem($('#fileHistory'), `in-${rec.id}`, incomingState(rec));
  let sink: TransferSink;
  try {
    sink = await createSink({
      key: rec.key,
      name: rec.name,
      type: rec.type,
      size: rec.size,
      sliceSize: rec.sliceSize,
      preferPicker: rec.size >= PICKER_MIN_BYTES
    });
  } catch (err) {
    const quota = err instanceof StorageError && err.code === 'quota';
    const detail: TransferDetail = quota
      ? {key: 'recvNoSpace', vars: {name: rec.name, size: formatBytes(rec.size)}}
      : window.isSecureContext
        ? {key: 'recvFail', vars: {name: rec.name}}
        : {key: 'recvInsecure'};
    await failIncoming(rec, detail, 'decline');
    if (quota) toast(t(detail.key, detail.vars));
    return;
  }
  // The user may have cancelled while the picker/sink was being created.
  if (rec.canceled) {
    await sink.abort().catch(() => {});
    return;
  }
  rec.sink = sink;
  rec.kind = sink.kind;
  rec.bytes = sink.offset;
  if (rec.sliceSize > 0) rec.nextSeq = Math.round(sink.offset / rec.sliceSize);
  upsertTransferItem($('#fileHistory'), `in-${rec.id}`, incomingState(rec));
  void requestPersistence();
  if (sink.offset > 0 && rec.size > 0) {
    toast(t('resumeNote', {name: rec.name, pct: Math.round((sink.offset / rec.size) * 100)}));
  }
  if (sink.complete) {
    await finishIncoming(rec, sink);
    return;
  }
  void syncWakeLock();
  await fileCtl.send({t: 'offer', id: rec.id, offset: sink.offset}, {target: rec.peerId});
}

async function declineIncoming(rec: Incoming): Promise<void> {
  if (rec.phase !== 'pending') return;
  rec.phase = 'canceled';
  rec.detail = {key: 'recvDeclined'};
  upsertTransferItem($('#fileHistory'), `in-${rec.id}`, incomingState(rec));
  if (fileCtl) void fileCtl.send({t: 'decline', id: rec.id}, {target: rec.peerId});
  void syncWakeLock();
}

async function cancelIncoming(rec: Incoming): Promise<void> {
  if (rec.phase !== 'active') return;
  rec.canceled = true;
  const sink = rec.sink;
  rec.sink = null;
  if (sink) await sink.abort().catch(() => {});
  rec.phase = 'canceled';
  upsertTransferItem($('#fileHistory'), `in-${rec.id}`, incomingState(rec));
  if (fileCtl) void fileCtl.send({t: 'abort', id: rec.id, reason: 'user'}, {target: rec.peerId});
  void syncWakeLock();
}

/** Peer disappeared mid-transfer: keep the OPFS partial for a later resume. */
async function suspendIncoming(rec: Incoming): Promise<void> {
  const sink = rec.sink;
  rec.sink = null;
  if (sink) {
    if (rec.kind === 'opfs') await sink.suspend().catch(() => {});
    else await sink.abort().catch(() => {});
  }
  rec.phase = 'failed';
  rec.detail = {key: 'recvInterrupted', vars: {name: rec.name}};
  upsertTransferItem($('#fileHistory'), `in-${rec.id}`, incomingState(rec));
  void syncWakeLock();
}

async function finishIncoming(rec: Incoming, sink: TransferSink): Promise<void> {
  rec.finishing = true;
  let result: SinkCloseResult;
  try {
    result = await sink.close();
  } catch {
    rec.sink = null;
    rec.finishing = false;
    await failIncoming(rec, {key: 'recvFail', vars: {name: rec.name}}, 'abort');
    return;
  }
  rec.sink = null;
  rec.finishing = false;
  rec.bytes = rec.size;
  rec.phase = 'done';
  const state = incomingState(rec);
  if (result.downloadUrl) state.downloadUrl = result.downloadUrl;
  const storageKey = rec.kind === 'opfs' && result.downloadUrl ? rec.key : undefined;
  if (storageKey) rememberReceived({key: rec.key, name: rec.name, type: rec.type, size: rec.size});
  // A re-sent already-complete file must reuse the row that owns this storage;
  // otherwise evicting one row would break the other one's download link.
  const rowKey = storageKey ? rowKeyForStorage(storageKey, `in-${rec.id}`) : `in-${rec.id}`;
  const transientKey = `in-${rec.id}`;
  if (rowKey !== transientKey) {
    const transient = transferStates.get(transientKey);
    if (transient) {
      if (transient.state.downloadUrl) URL.revokeObjectURL(transient.state.downloadUrl);
      transient.refs.item.remove();
      transferStates.delete(transientKey);
    }
  }
  const previousUrl = transferStates.get(rowKey)?.state.downloadUrl;
  if (previousUrl && previousUrl !== state.downloadUrl) URL.revokeObjectURL(previousUrl);
  upsertTransferItem($('#fileHistory'), rowKey, state, storageKey);
  incoming.delete(rec.id);
  enforceTransferCap();
  if (fileCtl) void fileCtl.send({t: 'done', id: rec.id, size: rec.size}, {target: rec.peerId});
  toast(t('gotFile', {name: rec.name, peer: peerDisplayName(rec.peerId)}));
  void syncWakeLock();
}

function readSliceMeta(metadata: Json | undefined): {id: string; seq: number} | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const id = metadata['id'];
  const seq = metadata['seq'];
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null;
  return {id, seq};
}

async function handleIncomingMeta(msg: FileMetaMsg, peerId: string): Promise<void> {
  const key = transferKey({
    name: msg.name,
    size: msg.size,
    lastModified: msg.lastModified,
    type: msg.type,
    head: msg.head
  });
  for (const other of incoming.values()) {
    if (other.id !== msg.id && other.key === key && other.phase === 'active') {
      void fileCtl?.send({t: 'decline', id: msg.id}, {target: peerId});
      return;
    }
  }
  const name = msg.name.slice(0, 128) || t('incomingFile');
  const type = msg.type.slice(0, 128);

  // Already stored from an earlier attempt? Short-circuit: no bytes move.
  const storedUrl = await completedIncomingUrl(key, msg.size, type);
  if (storedUrl) {
    rememberReceived({key, name, type, size: msg.size});
    const rowKey = rowKeyForStorage(key, `in-${msg.id}`);
    const previousUrl = transferStates.get(rowKey)?.state.downloadUrl;
    if (previousUrl && previousUrl !== storedUrl) URL.revokeObjectURL(previousUrl);
    upsertTransferItem(
      $('#fileHistory'),
      rowKey,
      {
        direction: 'in',
        name,
        size: msg.size,
        peerId,
        progress: 1,
        phase: 'done',
        detail: {key: 'storedFile', vars: {size: formatBytes(msg.size)}},
        downloadUrl: storedUrl,
        actions: [
          {
            id: 'delete',
            labelKey: 'deleteFile',
            onClick: () => void evictTransferRow(rowKeyForStorage(key, rowKey))
          }
        ]
      },
      key
    );
    enforceTransferCap();
    if (fileCtl) void fileCtl.send({t: 'done', id: msg.id, size: msg.size}, {target: peerId});
    toast(t('gotFile', {name, peer: peerDisplayName(peerId)}));
    return;
  }

  const rec: Incoming = {
    id: msg.id,
    key,
    peerId,
    name,
    type,
    size: msg.size,
    sliceSize: msg.sliceSize,
    total: msg.total,
    sink: null,
    kind: null,
    bytes: 0,
    nextSeq: 0,
    phase: 'pending',
    canceled: false,
    finishing: false,
    queue: Promise.resolve()
  };
  incoming.set(rec.id, rec);
  upsertTransferItem($('#fileHistory'), `in-${rec.id}`, incomingState(rec));
  if (rec.size <= AUTO_ACCEPT_BYTES) {
    await prepareIncoming(rec);
  } else {
    toast(t('largeIncoming', {name: rec.name, size: formatBytes(rec.size)}));
    void syncWakeLock();
  }
}

async function handleChunk(data: BinaryData, peerId: string, metadata: Json | undefined): Promise<void> {
  const meta = readSliceMeta(metadata);
  if (!meta) return;
  const rec = incoming.get(meta.id);
  if (!rec || rec.peerId !== peerId) return;
  // Slices arrive in order, but each handler awaits a disk write: chain them so
  // `nextSeq` and the sink only ever see one slice at a time.
  rec.queue = rec.queue.then(() => processSlice(rec, data, meta)).catch(() => {});
  await rec.queue;
}

async function processSlice(
  rec: Incoming,
  data: BinaryData,
  meta: {id: string; seq: number}
): Promise<void> {
  if (rec.phase !== 'active' || !rec.sink || rec.finishing) return;
  if (meta.seq < rec.nextSeq) return; // Duplicate slice after a resume overlap.
  if (meta.seq > rec.nextSeq) {
    await failIncoming(rec, {key: 'recvGap'}, 'abort', true);
    return;
  }
  const chunk =
    data instanceof Blob
      ? new Uint8Array(await data.arrayBuffer())
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  try {
    await rec.sink.write(chunk);
  } catch {
    await failIncoming(rec, {key: 'recvFail', vars: {name: rec.name}}, 'abort', true);
    return;
  }
  rec.bytes += chunk.byteLength;
  rec.nextSeq += 1;
  queueTransferItem($('#fileHistory'), `in-${rec.id}`, incomingState(rec));
  if (rec.bytes >= rec.size) await finishIncoming(rec, rec.sink);
}

function isFileMetaMsg(value: unknown): value is FileMetaMsg {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    m['t'] === 'meta' &&
    typeof m['id'] === 'string' &&
    m['id'].length > 0 &&
    m['id'].length <= 64 &&
    typeof m['name'] === 'string' &&
    typeof m['type'] === 'string' &&
    typeof m['size'] === 'number' &&
    Number.isFinite(m['size']) &&
    m['size'] >= 0 &&
    typeof m['lastModified'] === 'number' &&
    Number.isFinite(m['lastModified']) &&
    typeof m['head'] === 'string' &&
    typeof m['sliceSize'] === 'number' &&
    isSaneSliceSize(m['sliceSize']) &&
    typeof m['total'] === 'number' &&
    Number.isFinite(m['total']) &&
    m['total'] >= 1
  );
}

async function handleCtl(msg: unknown, peerId: string): Promise<void> {
  if (typeof msg !== 'object' || msg === null) return;
  const type = (msg as {t?: unknown}).t;

  if (type === 'meta') {
    if (isFileMetaMsg(msg)) await handleIncomingMeta(msg, peerId);
    return;
  }

  const id = (msg as {id?: unknown}).id;
  if (typeof id !== 'string') return;

  if (type === 'offer') {
    const offset = (msg as {offset?: unknown}).offset;
    if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0) return;
    const out = outgoing.get(id);
    const peer = out?.targets.get(peerId);
    if (!out || !peer || peer.done || peer.failed || out.aborted) return;
    peer.offset = Math.min(Math.floor(offset), out.size);
    void startPeerSend(out, peer);
    return;
  }

  if (type === 'decline') {
    const out = outgoing.get(id);
    const peer = out?.targets.get(peerId);
    if (!out || !peer || out.aborted) return;
    peer.declined = true;
    peer.failed = true;
    refreshOutgoing(out);
    return;
  }

  if (type === 'done') {
    const out = outgoing.get(id);
    const peer = out?.targets.get(peerId);
    if (!out || !peer || out.aborted) return;
    peer.done = true;
    peer.sent = out.size;
    refreshOutgoing(out);
    return;
  }

  if (type === 'abort') {
    const out = outgoing.get(id);
    if (out) {
      const peer = out.targets.get(peerId);
      if (peer && !peer.done) {
        peer.failed = true;
        peer.offset = 0;
        refreshOutgoing(out);
      }
      return;
    }
    const rec = incoming.get(id);
    if (rec && rec.peerId === peerId && rec.phase === 'active') {
      const sink = rec.sink;
      rec.sink = null;
      if (sink) void sink.abort().catch(() => {});
      rec.phase = 'canceled';
      rec.detail = {key: 'canceledByPeer', vars: {peer: peerDisplayName(peerId)}};
      upsertTransferItem($('#fileHistory'), `in-${rec.id}`, incomingState(rec));
      void syncWakeLock();
    }
  }
}

function setupFileChannel(room: TrysteroRoom): void {
  const chunks = room.makeAction<BinaryData>('file');
  const ctl = room.makeAction<FileCtlMsg>('fileCtl');
  fileChunks = chunks as unknown as FileChunkAction;
  fileCtl = ctl as unknown as FileCtlAction;

  chunks.onMessage = (data, {peerId, metadata}) => {
    void handleChunk(data, peerId, metadata);
  };
  ctl.onMessage = (msg, {peerId}) => {
    void handleCtl(msg, peerId);
  };
}

/** A peer left: fail its outgoing targets and suspend incoming transfers. */
function onPeerLeft(peerId: string): void {
  for (const out of outgoing.values()) {
    const peer = out.targets.get(peerId);
    if (!peer || peer.done) continue;
    peer.failed = true;
    peer.sending = false;
    refreshOutgoing(out);
  }
  for (const rec of [...incoming.values()]) {
    if (rec.peerId !== peerId) continue;
    if (rec.phase === 'active') void suspendIncoming(rec);
    else if (rec.phase === 'pending') {
      rec.phase = 'failed';
      rec.detail = {key: 'recvInterrupted', vars: {name: rec.name}};
      upsertTransferItem($('#fileHistory'), `in-${rec.id}`, incomingState(rec));
    }
  }
}

// Transfer rows keep structured state (peer id, phase, progress, detail key)
// so their copy can be re-rendered via `t()` on language change. Progress
// ticks update the existing nodes in place and paint at most once per frame —
// a 10 GB file produces ~640k ticks and must not rebuild the DOM per tick.

type TransferPhase = 'pending' | 'active' | 'done' | 'failed' | 'canceled';

type TransferDetail = {key: string; vars?: Record<string, string | number>};

type TransferAction = {
  id: string;
  labelKey: string;
  vars?: Record<string, string | number>;
  primary?: boolean;
  onClick: () => void;
};

type TransferState = {
  direction: 'out' | 'in';
  name: string;
  size: number;
  /** '*' for broadcast sends, otherwise the peer id. */
  peerId: string;
  progress: number;
  phase: TransferPhase;
  detail?: TransferDetail;
  downloadUrl?: string;
  actions?: TransferAction[];
};

type RowRefs = {
  item: HTMLLIElement;
  bar: HTMLProgressElement;
  status: HTMLElement;
  actions: HTMLElement;
  link: HTMLAnchorElement;
  actionSig: string;
};

type TransferRow = {list: HTMLElement; state: TransferState; refs: RowRefs; storageKey?: string};

const transferStates = new Map<string, TransferRow>();
const pendingRows = new Map<string, HTMLElement>();
let rowFrame = 0;
let rowTimer = 0;

/** Received history is bounded; a 10 GB row cannot be kept forever. */
const HISTORY_CAP = 50;

function targetLabel(peerId: string): string {
  return peerId === '*' ? t('everyone') : peerDisplayName(peerId);
}

function transferDetail(state: TransferState): string {
  if (state.detail) return t(state.detail.key, state.detail.vars);
  const size = formatBytes(state.size);
  if (state.direction === 'out') {
    if (state.phase === 'done') return t('sentTo', {target: targetLabel(state.peerId), size});
    if (state.phase === 'failed') return t('sendFailed', {target: targetLabel(state.peerId)});
    if (state.phase === 'canceled') return t('sendCanceled');
    return t('sendProgress', {
      target: targetLabel(state.peerId),
      pct: Math.round(state.progress * 100),
      size
    });
  }
  if (state.phase === 'done') return t('recvDone', {size, peer: peerDisplayName(state.peerId)});
  if (state.phase === 'failed') return t('recvFail', {name: state.name});
  if (state.phase === 'canceled') return t('recvCanceled');
  return t('recvProgress', {peer: peerDisplayName(state.peerId), pct: Math.round(state.progress * 100)});
}

function createRow(list: HTMLElement, key: string): RowRefs {
  const item = document.createElement('li');
  item.className = 'file-item';
  item.setAttribute('data-key', key);

  const row = document.createElement('div');
  row.className = 'row';
  const name = document.createElement('span');
  name.className = 'fname';
  row.appendChild(name);
  item.appendChild(row);

  const bar = document.createElement('progress');
  bar.max = 1;
  bar.value = 0;
  item.appendChild(bar);

  const status = document.createElement('span');
  status.className = 'status';
  item.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.hidden = true;
  item.appendChild(actions);

  const link = document.createElement('a');
  link.hidden = true;
  item.appendChild(link);

  list.prepend(item);
  return {item, bar, status, actions, link, actionSig: ''};
}

function renderActionButtons(refs: RowRefs, state: TransferState): void {
  const actions = state.actions ?? [];
  const signature = actions.map((action) => `${action.id}:${action.labelKey}`).join('|');
  if (signature === refs.actionSig) return;
  refs.actionSig = signature;
  refs.actions.textContent = '';
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action.primary ? 'btn btn-primary' : 'btn btn-ghost';
    button.textContent = t(action.labelKey, action.vars);
    button.addEventListener('click', action.onClick);
    refs.actions.appendChild(button);
  }
  refs.actions.hidden = actions.length === 0;
}

function applyTransferRow(state: TransferState, refs: RowRefs): void {
  const name = refs.item.querySelector('.fname');
  if (name && name.textContent !== state.name) name.textContent = state.name;
  refs.bar.value = state.progress;
  refs.bar.setAttribute('aria-label', `${state.name} — ${Math.round(state.progress * 100)}%`);
  refs.status.textContent = transferDetail(state);
  refs.link.hidden = !state.downloadUrl;
  if (state.downloadUrl && refs.link.getAttribute('href') !== state.downloadUrl) {
    refs.link.href = state.downloadUrl;
    refs.link.download = state.name;
    refs.link.textContent = t('download');
  }
  renderActionButtons(refs, state);
}

function upsertTransferItem(
  list: HTMLElement,
  key: string,
  state: TransferState,
  storageKey?: string
): void {
  pendingRows.delete(key);
  const existing = transferStates.get(key);
  if (existing) {
    existing.state = state;
    if (storageKey) existing.storageKey = storageKey;
    applyTransferRow(state, existing.refs);
    return;
  }
  const refs = createRow(list, key);
  transferStates.set(key, {list, state, refs, ...(storageKey ? {storageKey} : {})});
  applyTransferRow(state, refs);
}

/** Coalesce slice-by-slice progress into one paint per frame. rAF is paused in
 *  hidden tabs, so a timeout watchdog keeps background progress moving. */
function queueTransferItem(list: HTMLElement, key: string, state: TransferState): void {
  const existing = transferStates.get(key);
  if (!existing) {
    upsertTransferItem(list, key, state);
    return;
  }
  existing.state = state;
  pendingRows.set(key, list);
  if (!rowFrame) rowFrame = requestAnimationFrame(flushTransferRows);
  if (!rowTimer) rowTimer = window.setTimeout(flushTransferRows, 250);
}

function flushTransferRows(): void {
  if (rowFrame) cancelAnimationFrame(rowFrame);
  rowFrame = 0;
  if (rowTimer) window.clearTimeout(rowTimer);
  rowTimer = 0;
  const queued = [...pendingRows.keys()];
  pendingRows.clear();
  for (const key of queued) {
    const row = transferStates.get(key);
    if (row) applyTransferRow(row.state, row.refs);
  }
}

function rerenderTransfers(): void {
  for (const [key, row] of transferStates) {
    if (row.list.isConnected) applyTransferRow(row.state, row.refs);
    else transferStates.delete(key);
  }
}

// --- received history: bounded, and its storage is freed with the row -------

function rowKeyForStorage(storageKey: string, fallback: string): string {
  return (
    [...transferStates.keys()].find(
      (rowKey) => transferStates.get(rowKey)?.storageKey === storageKey
    ) ?? fallback
  );
}

async function evictTransferRow(key: string): Promise<void> {
  const row = transferStates.get(key);
  if (!row) return;
  if (row.state.downloadUrl) URL.revokeObjectURL(row.state.downloadUrl);
  row.refs.item.remove();
  transferStates.delete(key);
  if (row.storageKey) {
    forgetReceived(row.storageKey);
    await deleteIncomingFile(row.storageKey);
  }
}

function enforceTransferCap(): void {
  const history = $('#fileHistory');
  const terminal = [...transferStates.entries()].filter(
    ([, row]) =>
      row.list === history &&
      (row.state.phase === 'done' || row.state.phase === 'failed' || row.state.phase === 'canceled')
  );
  while (terminal.length > HISTORY_CAP) {
    const [key] = terminal.shift()!;
    void evictTransferRow(key);
  }
}

// --- received history: bounded, and it survives leaving or reloading -------
//
// Received OPFS files are referenced by a small localStorage index so a reload
// can rebuild their download rows instead of orphaning (or deleting) GBs of
// user data. This index is the only durable UI state the app keeps.

const RECEIVED_KEY = 'localtransfer-received';

type ReceivedEntry = {key: string; name: string; type: string; size: number};

function isReceivedEntry(value: unknown): value is ReceivedEntry {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m['key'] === 'string' &&
    m['key'].length > 0 &&
    m['key'].length <= 64 &&
    typeof m['name'] === 'string' &&
    typeof m['type'] === 'string' &&
    typeof m['size'] === 'number' &&
    Number.isFinite(m['size']) &&
    m['size'] >= 0
  );
}

function loadReceivedIndex(): ReceivedEntry[] {
  try {
    const raw = localStorage.getItem(RECEIVED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isReceivedEntry).slice(-HISTORY_CAP);
  } catch {
    return [];
  }
}

function saveReceivedIndex(entries: ReceivedEntry[]): void {
  try {
    localStorage.setItem(RECEIVED_KEY, JSON.stringify(entries.slice(-HISTORY_CAP)));
  } catch {
    // Persistence is best-effort; the current session still works.
  }
}

function rememberReceived(entry: ReceivedEntry): void {
  const entries = loadReceivedIndex().filter((existing) => existing.key !== entry.key);
  entries.push(entry);
  saveReceivedIndex(entries);
}

function forgetReceived(key: string): void {
  saveReceivedIndex(loadReceivedIndex().filter((entry) => entry.key !== key));
}

async function restoreReceivedHistory(): Promise<void> {
  for (const entry of loadReceivedIndex()) {
    const url = await completedIncomingUrl(entry.key, entry.size, entry.type);
    if (!url) {
      forgetReceived(entry.key);
      continue;
    }
    upsertTransferItem(
      $('#fileHistory'),
      `in-restored-${entry.key}`,
      {
        direction: 'in',
        name: entry.name,
        size: entry.size,
        peerId: '',
        progress: 1,
        phase: 'done',
        detail: {key: 'storedFile', vars: {size: formatBytes(entry.size)}},
        downloadUrl: url,
        actions: [
          {
            id: 'delete',
            labelKey: 'deleteFile',
            onClick: () => void evictTransferRow(`in-restored-${entry.key}`)
          }
        ]
      },
      entry.key
    );
  }
  enforceTransferCap();
}

/** Leaving a room stops live transfers but never touches stored history. */
function abortRoomTransfers(): void {
  for (const out of outgoing.values()) {
    if (out.aborted) continue;
    out.aborted = true;
    const targets = [...out.targets.values()]
      .filter((peer) => !peer.done && !peer.failed)
      .map((peer) => peer.peerId);
    if (targets.length > 0 && fileCtl) {
      void fileCtl.send({t: 'abort', id: out.id, reason: 'peer'}, {target: targets});
    }
    for (const peer of out.targets.values()) {
      if (!peer.done) peer.failed = true;
    }
    upsertTransferItem($('#fileQueue'), `out-${out.id}`, outgoingState(out));
  }
  for (const rec of incoming.values()) {
    const sink = rec.sink;
    rec.sink = null;
    // Keep OPFS partials so the transfer can resume later.
    if (sink) void (rec.kind === 'opfs' ? sink.suspend() : sink.abort()).catch(() => {});
    if (rec.phase === 'active' || rec.phase === 'pending') {
      rec.phase = rec.phase === 'pending' ? 'canceled' : 'failed';
      rec.detail = {key: 'recvInterrupted', vars: {name: rec.name}};
      upsertTransferItem($('#fileHistory'), `in-${rec.id}`, incomingState(rec));
    }
  }
  outgoing.clear();
  incoming.clear();
  void syncWakeLock();
}

// --- state builders ---------------------------------------------------------

function outgoingState(out: Outgoing): TransferState {
  const peers = [...out.targets.values()];
  const targetValue = out.targets.size === 1 ? peers[0]!.peerId : '*';
  const doneCount = peers.filter((peer) => peer.done).length;
  const failedCount = peers.filter((peer) => peer.failed).length;
  let phase: TransferPhase = 'active';
  if (out.aborted) phase = 'canceled';
  else if (doneCount === peers.length) phase = 'done';
  else if (failedCount === peers.length) phase = 'failed';

  // Honest aggregate: the slowest healthy peer drives the bar.
  let progress = 0;
  if (phase === 'done') progress = 1;
  else {
    const healthy = peers.filter((peer) => !peer.failed);
    if (healthy.length > 0) {
      progress = Math.min(...healthy.map((peer) => (out.size === 0 ? 1 : peer.sent / out.size)));
    }
  }

  const state: TransferState = {
    direction: 'out',
    name: out.name,
    size: out.size,
    peerId: targetValue,
    progress,
    phase
  };
  if (phase === 'active') {
    if (peers.every((peer) => peer.sent === 0 && !peer.failed)) {
      state.detail = {key: 'waitingReceiver', vars: {target: targetLabel(targetValue)}};
    }
    state.actions = [{id: 'cancel', labelKey: 'cancel', onClick: () => cancelOutgoing(out.id)}];
  } else if (phase === 'failed') {
    state.detail =
      peers.length > 1
        ? {key: 'sendPartial', vars: {done: doneCount, total: peers.length}}
        : peers[0]?.declined
          ? {key: 'declinedByPeer', vars: {target: targetLabel(targetValue)}}
          : {key: 'sendFailed', vars: {target: targetLabel(targetValue)}};
  }
  return state;
}

function incomingState(rec: Incoming): TransferState {
  const state: TransferState = {
    direction: 'in',
    name: rec.name,
    size: rec.size,
    peerId: rec.peerId,
    progress: rec.size === 0 ? (rec.phase === 'done' ? 1 : 0) : Math.min(1, rec.bytes / rec.size),
    phase: rec.phase
  };
  if (rec.detail) state.detail = rec.detail;
  if (rec.phase === 'pending') {
    if (!state.detail) state.detail = {key: 'recvPending', vars: {size: formatBytes(rec.size)}};
    state.actions = [
      {
        id: 'accept',
        labelKey: 'acceptFile',
        vars: {size: formatBytes(rec.size)},
        primary: true,
        onClick: () => void prepareIncoming(rec)
      },
      {id: 'decline', labelKey: 'declineFile', onClick: () => void declineIncoming(rec)}
    ];
  } else if (rec.phase === 'active') {
    state.detail = rec.sink
      ? {key: 'recvProgress', vars: {peer: peerDisplayName(rec.peerId), pct: Math.round(state.progress * 100)}}
      : {key: 'preparing'};
    state.actions = [{id: 'cancel', labelKey: 'cancel', onClick: () => void cancelIncoming(rec)}];
  } else if (rec.phase === 'done' && rec.kind === 'fsa') {
    // Saved at a user-picked path: there is no download link to show.
    state.detail = {key: 'fileSaved', vars: {size: formatBytes(rec.size)}};
  } else if (rec.phase === 'done' && rec.kind === 'opfs') {
    state.actions = [
      {
        id: 'delete',
        labelKey: 'deleteFile',
        onClick: () => void evictTransferRow(`in-${rec.id}`)
      }
    ];
  }
  return state;
}

async function sendFiles(files: FileList | File[]): Promise<void> {
  if (!room || !fileChunks || !fileCtl) {
    toast(t('joinFirst'));
    return;
  }
  if (peerNames.size === 0) {
    toast(t('nobodyHere'));
    return;
  }
  for (const file of Array.from(files)) {
    try {
      await startOutgoing(file);
    } catch {
      toast(t('sendFail', {name: file.name}));
    }
  }
}

function initFiles(): void {
  const dropZone = $('#dropZone');
  const fileInput = $('#fileInput') as HTMLInputElement;

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) void sendFiles(fileInput.files);
    fileInput.value = '';
  });

  for (const type of ['dragenter', 'dragover'] as const) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop'] as const) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.remove('over');
    });
  }
  dropZone.addEventListener('drop', (event) => {
    if (event.dataTransfer?.files.length) void sendFiles(event.dataTransfer.files);
  });
}

// --- boot: runs last so every const above is initialized ----------------------

function initWakeLock(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncWakeLock();
  });
}

initI18n();
initTheme();
initJoinPanel();
initPanelTabs();
renderPeers();
initFiles();
initRelayWatch();
initWakeLock();
applyI18n();
void restoreReceivedHistory();
