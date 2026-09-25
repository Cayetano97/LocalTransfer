// LocalTransfer — central EN/ES dictionary (T5).
// All UI copy lives here. `applyI18n()` in main.ts re-renders every static
// and dynamic string on language change. Spanish is neutral/professional
// (explicitly requested by the user, so ES artifacts are allowed here).

export const LANGS = ['en', 'es'] as const;
export type Lang = (typeof LANGS)[number];

type Dict = Record<string, string>;

const en: Dict = {
  docTitle: 'LocalTransfer — P2P file sharing for your network',
  metaDesc: 'LocalTransfer — share files peer-to-peer over your local network. No uploads, no server storage.',
  themeLabel: 'Cycle theme: auto, light, dark',
  langLabel: 'Language',
  roomBadgeTitle: 'Connected room',
  selfBadgeTitle: 'Your peer id',
  entryTitle: 'Create or join a room',
  entrySub: 'Files travel directly between browsers — nothing is uploaded.',
  entryModeLabel: 'Entry mode',
  modeCreate: 'Create',
  modeJoin: 'Join',
  nickLabel: 'Nickname',
  nickPh: 'e.g. ana-laptop',
  roomLabelCreate: 'Room name (optional)',
  roomLabelJoin: 'Room ID',
  roomPhCreate: 'e.g. living-room',
  roomPhJoin: 'e.g. k7m2q',
  roomHelpCreate: 'Leave empty to get a random code.',
  roomHelpJoin: 'Required — the code from a friend’s invite.',
  join: 'Join room',
  create: 'Create room',
  leave: 'Leave',
  copyInvite: 'Copy invite link',
  qrLabel: 'Invite QR code',
  peers: 'Peers',
  peerCountOne: '{count} peer',
  peerCountOther: '{count} peers',
  notInRoom: 'Not in a room yet.',
  rename: 'Rename',
  renameNick: 'Edit your nickname',
  files: 'Files',
  dropStrong: 'Drop files here',
  dropOr: 'or',
  dropChoose: 'choose from your device',
  dropHint: 'Choose files or drag and drop them here',
  dropNote: 'Files are sent directly to peers — nothing is uploaded anywhere.',
  sendTo: 'Send to',
  everyone: 'Everyone in the room',
  received: 'Received',
  historyEmpty: 'No files yet — they’ll appear here.',
  queueEmpty: 'Files you send will appear here.',
  download: 'Download',
  you: '(you)',
  peerFallback: 'peer-{id}',
  selfBadge: 'you: {id}',
  roomBadge: '# {room}',
  needRoom: 'Pick a room code first.',
  joinedRoom: 'Joined room “{room}”. Share the link or QR.',
  leftRoom: 'Left the room.',
  inviteCopied: 'Invite link copied — share it with this network.',
  clipboardFail: 'Could not access the clipboard.',
  joinFirst: 'Join a room before sending files.',
  nobodyHere: 'Nobody else is in the room yet — share the invite link.',
  connProblem: 'Connection problem — check your network. We keep retrying.',
  sendFail: 'Could not send “{name}”.',
  gotFile: 'Received “{name}” from {peer}.',
  peerJoined: '{peer} joined.',
  peerLeft: '{peer} left.',
  incomingFile: 'incoming file',
  sendProgress: 'Sending to {target} — {pct}% · {size}',
  sentTo: 'Sent to {target} · {size}',
  sendFailed: 'Failed to send to {target}. Peer may have left — try again.',
  recvProgress: 'Receiving from {peer} — {pct}%',
  recvDone: '{size} · from {peer}',
  cancel: 'Cancel',
  waitingReceiver: 'Waiting for {target} to accept…',
  largeIncoming: '“{name}” ({size}) is waiting for your accept.',
  acceptFile: 'Accept · {size}',
  declineFile: 'Decline',
  preparing: 'Preparing…',
  recvPending: 'Incoming — {size}. Waiting for your accept.',
  resumeNote: 'Resuming “{name}” from {pct}%.',
  recvInterrupted: 'Interrupted — “{name}”. Ask the sender to send it again to resume.',
  recvInsecure: 'This context can’t store large files. Open the app over HTTPS (npm run lan) to receive files over 256 MB.',
  recvNoSpace: 'Not enough browser storage for “{name}” ({size}). Free space or save it to a file when asked.',
  recvDeclined: 'Declined.',
  recvCanceled: 'Canceled.',
  recvFail: 'Could not save “{name}”.',
  recvGap: 'Transfer error — ask the sender to send the file again to resume.',
  canceledByPeer: 'Canceled by {peer}.',
  sendCanceled: 'Canceled.',
  sendPartial: 'Sent to {done} of {total} peers.',
  declinedByPeer: 'Declined by {target}.',
  fileSaved: 'Saved to disk · {size}',
  storedFile: 'Stored in this browser · {size}',
  deleteFile: 'Delete',
  largeHint: 'Large files stream to disk in slices — keep both tabs open until the transfer finishes.',
  insecureHint: 'Large-file receiving needs HTTPS on the LAN. Run “npm run lan” and accept the certificate — until then files over 256 MB are refused.',
  skipLink: 'Skip to main content',
  footNote: 'Peer-to-peer · No uploads · Nothing stored'
};

const es: Dict = {
  docTitle: 'LocalTransfer — comparte archivos P2P en tu red',
  metaDesc: 'LocalTransfer — comparte archivos peer-to-peer en tu red local. Sin subidas ni almacenamiento en servidores.',
  themeLabel: 'Cambiar tema: auto, claro, oscuro',
  langLabel: 'Idioma',
  roomBadgeTitle: 'Sala conectada',
  selfBadgeTitle: 'Tu identificador',
  entryTitle: 'Crea o únete a una sala',
  entrySub: 'Los archivos viajan directamente entre navegadores — no se sube nada.',
  entryModeLabel: 'Modo de entrada',
  modeCreate: 'Crear',
  modeJoin: 'Unirse',
  nickLabel: 'Apodo',
  nickPh: 'p. ej. ana-portatil',
  roomLabelCreate: 'Nombre de la sala (opcional)',
  roomLabelJoin: 'ID de la sala',
  roomPhCreate: 'p. ej. sala-estar',
  roomPhJoin: 'p. ej. k7m2q',
  roomHelpCreate: 'Déjalo vacío para obtener un código aleatorio.',
  roomHelpJoin: 'Obligatorio — el código de la invitación de un amigo.',
  join: 'Unirse a la sala',
  create: 'Crear sala',
  leave: 'Salir',
  copyInvite: 'Copiar enlace de invitación',
  qrLabel: 'Código QR de invitación',
  peers: 'Participantes',
  peerCountOne: '{count} participante',
  peerCountOther: '{count} participantes',
  notInRoom: 'Aún no estás en una sala.',
  rename: 'Renombrar',
  renameNick: 'Editar tu apodo',
  files: 'Archivos',
  dropStrong: 'Suelta archivos aquí',
  dropOr: 'o',
  dropChoose: 'elige desde tu dispositivo',
  dropHint: 'Elige archivos o arrástralos aquí',
  dropNote: 'Los archivos se envían directamente a los participantes — nada se sube a ningún servidor.',
  sendTo: 'Enviar a',
  everyone: 'Todos en la sala',
  received: 'Recibidos',
  historyEmpty: 'Aún no hay archivos — aparecerán aquí.',
  queueEmpty: 'Los archivos que envíes aparecerán aquí.',
  download: 'Descargar',
  you: '(tú)',
  peerFallback: 'par-{id}',
  selfBadge: 'tú: {id}',
  roomBadge: '# {room}',
  needRoom: 'Elige primero un código de sala.',
  joinedRoom: 'Te uniste a la sala “{room}”. Comparte el enlace o el QR.',
  leftRoom: 'Saliste de la sala.',
  inviteCopied: 'Enlace de invitación copiado — compártelo en esta red.',
  clipboardFail: 'No se pudo acceder al portapapeles.',
  joinFirst: 'Únete a una sala antes de enviar archivos.',
  nobodyHere: 'Aún no hay nadie más en la sala — comparte el enlace de invitación.',
  connProblem: 'Problema de conexión — revisa tu red. Seguimos reintentando.',
  sendFail: 'No se pudo enviar “{name}”.',
  gotFile: '“{name}” recibido de {peer}.',
  peerJoined: '{peer} se unió.',
  peerLeft: '{peer} salió.',
  incomingFile: 'archivo entrante',
  sendProgress: 'Enviando a {target} — {pct} % · {size}',
  sentTo: 'Enviado a {target} · {size}',
  sendFailed: 'No se pudo enviar a {target}. Es posible que el participante haya salido — inténtalo de nuevo.',
  recvProgress: 'Recibiendo de {peer} — {pct} %',
  recvDone: '{size} · de {peer}',
  cancel: 'Cancelar',
  waitingReceiver: 'Esperando a que {target} acepte…',
  largeIncoming: '“{name}” ({size}) espera tu aceptación.',
  acceptFile: 'Aceptar · {size}',
  declineFile: 'Rechazar',
  preparing: 'Preparando…',
  recvPending: 'Entrante — {size}. Esperando tu aceptación.',
  resumeNote: 'Reanudando “{name}” desde el {pct} %.',
  recvInterrupted: 'Interrumpido — “{name}”. Pide a quien lo envía que lo mande de nuevo para reanudar.',
  recvInsecure: 'Este contexto no puede guardar archivos grandes. Abre la app por HTTPS (npm run lan) para recibir más de 256 MB.',
  recvNoSpace: 'No hay espacio suficiente en el navegador para “{name}” ({size}). Libera espacio o guárdalo a un archivo cuando se pregunte.',
  recvDeclined: 'Rechazado.',
  recvCanceled: 'Cancelado.',
  recvFail: 'No se pudo guardar “{name}”.',
  recvGap: 'Error de transferencia — pide que envíen el archivo de nuevo para reanudar.',
  canceledByPeer: '{peer} lo canceló.',
  sendCanceled: 'Cancelado.',
  sendPartial: 'Enviado a {done} de {total} participantes.',
  declinedByPeer: '{target} lo rechazó.',
  fileSaved: 'Guardado en disco · {size}',
  storedFile: 'Guardado en este navegador · {size}',
  deleteFile: 'Eliminar',
  largeHint: 'Los archivos grandes se escriben en disco por partes — mantén ambas pestañas abiertas hasta que termine.',
  insecureHint: 'Recibir archivos grandes necesita HTTPS en la LAN. Ejecuta “npm run lan” y acepta el certificado — hasta entonces se rechazan los archivos de más de 256 MB.',
  skipLink: 'Saltar al contenido principal',
  footNote: 'Peer-to-peer · Sin subidas · Nada se almacena'
};

const STRINGS: Record<Lang, Dict> = {en, es};

const LANG_KEY = 'localtransfer-lang';

function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === 'en' || stored === 'es') return stored;
  } catch {
    // Private mode etc: fall through to navigator default.
  }
  return window.navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en';
}

let current: Lang = detectLang();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Persist is best-effort; the in-memory language still applies.
  }
  document.documentElement.lang = lang;
}

/** Translate a key, interpolating `{var}` placeholders. Falls back to `en`. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const template = STRINGS[current][key] ?? en[key] ?? key;
  if (!vars) return template;
  return Object.entries(vars).reduce(
    (out, [name, value]) => out.split(`{${name}}`).join(String(value)),
    template
  );
}
