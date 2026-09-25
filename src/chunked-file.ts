// Chunked file streaming primitives for LocalTransfer (large-file support).
//
// The transport action in `main.ts` sends 4 MiB slices. This module owns the
// receiving side: picking a sink (File System Access direct save, OPFS
// streaming or an in-memory fallback), writing slices with bounded memory,
// resume offsets and partial cleanup. Keeping storage concerns here keeps the
// protocol and DOM code out of them.
//
// All Web Crypto usage is avoided on purpose: the app is served over plain
// HTTP on the LAN by default, where `crypto.subtle` is unavailable. Identity
// fingerprints use FNV-1a over the file metadata plus its first 64 KiB.

/** Wire slice size for outgoing files. 4 MiB keeps peak sender memory low. */
export const SLICE_SIZE = 4 * 1024 * 1024;

/** Files at or below this size are received without asking the user. */
export const AUTO_ACCEPT_BYTES = 512 * 1024 * 1024;

/** Above this size (and when available) we ask for a destination file. */
export const PICKER_MIN_BYTES = 1024 * 1024 * 1024;

/** Memory sink ceiling when no disk API is available (insecure context, old browsers). */
export const MEMORY_SINK_MAX = 256 * 1024 * 1024;

const INCOMING_DIR = 'incoming';
/** Legacy single-file naming, only referenced to clean up older partials. */
const PART_SUFFIX = '.part';
const SWAP_SUFFIX = '.crswap';
const HEAD_BYTES = 64 * 1024;
const SLICE_SEQ_RE = /^\d+$/;
/** Batches for collecting thousands of slice files without a promise storm. */
const PART_BATCH = 256;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MAX_SLICE_BYTES = 64 * 1024 * 1024;

export type StorageErrorCode = 'unsupported' | 'quota' | 'denied' | 'io';

export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export type SinkKind = 'fsa' | 'opfs' | 'memory';

export type SinkCloseResult = {
  /** Object URL when the sink keeps the file in browser storage. */
  downloadUrl?: string;
  /** True when the bytes already live at a user-picked path. */
  savedToDisk: boolean;
};

export interface TransferSink {
  readonly kind: SinkKind;
  /** Bytes already persisted before this attempt (resume point). */
  readonly offset: number;
  /** True when this exact file was already fully received earlier. */
  readonly complete: boolean;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<SinkCloseResult>;
  /** Keep the partial for a later resume and release handles. */
  suspend(): Promise<void>;
  /** Discard the partial. */
  abort(): Promise<void>;
}

// --- identity ---------------------------------------------------------------

function fnv1a64(bytes: Uint8Array): string {
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

export function hashText(text: string): string {
  return fnv1a64(new TextEncoder().encode(text));
}

export async function headHash(file: Blob): Promise<string> {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  return fnv1a64(head);
}

export type FileIdentity = {
  name: string;
  size: number;
  lastModified: number;
  type: string;
  head: string;
};

/** Stable per-file key: same name+size+mtime+type+head means same bytes. */
export function transferKey(identity: FileIdentity): string {
  return hashText(
    `${identity.name}|${identity.size}|${identity.lastModified}|${identity.type}|${identity.head}`
  );
}

/** Slice size advertised by a peer must stay in a sane band. */
export function isSaneSliceSize(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_SLICE_BYTES;
}

// --- sinks ------------------------------------------------------------------

class MemorySink implements TransferSink {
  readonly kind = 'memory' as const;
  readonly complete = false;
  private chunks: Uint8Array[] = [];
  private bytes = 0;

  constructor(private readonly type: string) {}

  get offset(): number {
    return this.bytes;
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
  }

  async close(): Promise<SinkCloseResult> {
    const blob = new Blob(this.chunks as BlobPart[], {
      type: this.type || 'application/octet-stream'
    });
    return {downloadUrl: URL.createObjectURL(blob), savedToDisk: false};
  }

  async suspend(): Promise<void> {
    // In-memory partials cannot outlive a failed attempt: free them.
    await this.abort();
  }

  async abort(): Promise<void> {
    this.chunks = [];
    this.bytes = 0;
  }
}

async function tryGetDir(
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await dir.getDirectoryHandle(name);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return null;
    throw err;
  }
}

// TypeScript 5.7+ distinguishes ArrayBuffer from SharedArrayBuffer in views;
// the writable-stream API only accepts the former. Our chunks are always
// plain ArrayBuffer-backed views, so this cast is safe and local.
type WritePayload = Uint8Array<ArrayBuffer> & ArrayBufferView<ArrayBuffer>;
function writePayload(chunk: Uint8Array): WritePayload {
  return chunk as WritePayload;
}

class OpfsSink implements TransferSink {
  readonly kind = 'opfs' as const;
  private bytes: number;
  private seq: number;
  private completeFlag: boolean;

  private constructor(
    private readonly parent: FileSystemDirectoryHandle,
    private readonly dir: FileSystemDirectoryHandle,
    private readonly key: string,
    private readonly size: number,
    private readonly sliceSize: number,
    private readonly type: string,
    bytes: number,
    seq: number,
    complete: boolean
  ) {
    this.bytes = bytes;
    this.seq = seq;
    this.completeFlag = complete;
  }

  /**
   * Each slice is its own committed OPFS file (`<key>/<seq>`), so a killed tab
   * loses at most the slice being written, and `keepExistingData` copies are
   * never needed (they are O(file size) in Chromium).
   */
  static async open(
    parent: FileSystemDirectoryHandle,
    key: string,
    size: number,
    sliceSize: number,
    type: string
  ): Promise<OpfsSink> {
    // Legacy single-file partials from older builds are not readable anymore.
    await parent.removeEntry(`${key}${PART_SUFFIX}`).catch(() => {});
    await parent.removeEntry(`${key}${PART_SUFFIX}${SWAP_SUFFIX}`).catch(() => {});

    const dir = await parent.getDirectoryHandle(key, {create: true});
    const total = Math.max(1, Math.ceil(size / sliceSize));
    const sizes = new Map<number, number>();
    for await (const [name, handle] of dir.entries()) {
      if (!SLICE_SEQ_RE.test(name) || Number(name) >= total) {
        await dir.removeEntry(name).catch(() => {});
        continue;
      }
      try {
        sizes.set(Number(name), (await (handle as FileSystemFileHandle).getFile()).size);
      } catch {
        // Unreadable entry: it will be rewritten if it is part of the prefix.
      }
    }

    let seq = 0;
    let bytes = 0;
    while (seq < total) {
      const expected = seq === total - 1 ? size - seq * sliceSize : sliceSize;
      if (sizes.get(seq) !== expected) break;
      bytes += expected;
      seq += 1;
    }
    // Anything past the contiguous prefix gets rewritten; drop it now.
    for (const existing of sizes.keys()) {
      if (existing >= seq) await dir.removeEntry(String(existing)).catch(() => {});
    }
    return new OpfsSink(parent, dir, key, size, sliceSize, type, bytes, seq, bytes === size);
  }

  get offset(): number {
    return this.bytes;
  }

  get complete(): boolean {
    return this.completeFlag;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.completeFlag) throw new StorageError('io', 'sink is complete');
    const total = Math.max(1, Math.ceil(this.size / this.sliceSize));
    const expected =
      this.seq === total - 1 ? this.size - this.seq * this.sliceSize : this.sliceSize;
    if (chunk.byteLength !== expected) {
      throw new StorageError('io', `slice ${this.seq}: expected ${expected} bytes`);
    }
    const handle = await this.dir.getFileHandle(String(this.seq), {create: true});
    const writable = await handle.createWritable();
    await writable.write(writePayload(chunk));
    await writable.close();
    this.bytes += expected;
    this.seq += 1;
  }

  async close(): Promise<SinkCloseResult> {
    if (this.bytes !== this.size) throw new StorageError('io', 'sink is incomplete');
    this.completeFlag = true;
    const parts = await this.collectParts();
    const blob = new Blob(parts as BlobPart[], {
      type: this.type || 'application/octet-stream'
    });
    return {downloadUrl: URL.createObjectURL(blob), savedToDisk: false};
  }

  private async collectParts(): Promise<File[]> {
    const total = Math.max(1, Math.ceil(this.size / this.sliceSize));
    const files: File[] = [];
    for (let start = 0; start < total; start += PART_BATCH) {
      const batch: Promise<File>[] = [];
      for (let seq = start; seq < Math.min(start + PART_BATCH, total); seq++) {
        batch.push(
          this.dir.getFileHandle(String(seq)).then((handle) => handle.getFile())
        );
      }
      files.push(...(await Promise.all(batch)));
    }
    return files;
  }

  async suspend(): Promise<void> {
    // Every completed slice is already a committed file; nothing to flush.
  }

  async abort(): Promise<void> {
    await this.parent.removeEntry(this.key, {recursive: true}).catch(() => {});
  }
}

type SaveFilePicker = (options?: {suggestedName?: string}) => Promise<FileSystemFileHandle>;

declare global {
  interface Window {
    showSaveFilePicker?: SaveFilePicker;
  }
}

class FsaSink implements TransferSink {
  readonly kind = 'fsa' as const;
  readonly offset = 0;
  readonly complete = false;
  private closed = false;

  private constructor(private readonly writable: FileSystemWritableFileStream) {}

  static async ask(name: string): Promise<FsaSink> {
    const picker = window.showSaveFilePicker;
    if (typeof picker !== 'function') {
      throw new StorageError('unsupported', 'File System Access API unavailable');
    }
    const handle = await picker({suggestedName: name});
    return new FsaSink(await handle.createWritable());
  }

  async write(chunk: Uint8Array): Promise<void> {
    await this.writable.write(writePayload(chunk));
  }

  async close(): Promise<SinkCloseResult> {
    if (!this.closed) {
      this.closed = true;
      await this.writable.close();
    }
    return {savedToDisk: true};
  }

  async suspend(): Promise<void> {
    await this.close();
  }

  async abort(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      try {
        await this.writable.abort();
      } catch {
        // Best effort: the picked file may keep a partial header.
      }
    }
  }
}

export type SinkRequest = {
  key: string;
  name: string;
  type: string;
  size: number;
  /** Slice size advertised by the sender; defines the part-file layout. */
  sliceSize: number;
  /** Large files prefer a user-picked destination when the API exists. */
  preferPicker: boolean;
};

export async function createSink(req: SinkRequest): Promise<TransferSink> {
  if (req.preferPicker && typeof window.showSaveFilePicker === 'function') {
    try {
      return await FsaSink.ask(req.name);
    } catch (err) {
      // User cancel or picker failure: fall through to browser storage.
      if (!(err instanceof DOMException)) throw err;
    }
  }

  if (typeof navigator.storage?.getDirectory === 'function') {
    if (req.size > MEMORY_SINK_MAX) {
      const estimate = await navigator.storage.estimate();
      const free = (estimate.quota ?? 0) - (estimate.usage ?? 0);
      if (estimate.quota && free < req.size * 1.05) {
        throw new StorageError('quota', `needs ${req.size} bytes, ${free} available`);
      }
    }
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(INCOMING_DIR, {create: true});
    return OpfsSink.open(dir, req.key, req.size, req.sliceSize, req.type);
  }

  if (req.size <= MEMORY_SINK_MAX) return new MemorySink(req.type);
  throw new StorageError('unsupported', 'no disk storage API in this context');
}

/** Ask the browser to keep our storage around (best effort). */
export async function requestPersistence(): Promise<void> {
  try {
    if (typeof navigator.storage?.persist === 'function') await navigator.storage.persist();
  } catch {
    // Not critical: persistence is a hint.
  }
}

/** Remove a single completed/partial incoming file (eviction, delete). */
export async function deleteIncomingFile(key: string): Promise<void> {
  if (typeof navigator.storage?.getDirectory !== 'function') return;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await tryGetDir(root, INCOMING_DIR);
    if (!dir) return;
    await dir.removeEntry(key, {recursive: true}).catch(() => {});
    // Legacy single-file naming from earlier builds.
    await dir.removeEntry(`${key}${PART_SUFFIX}`).catch(() => {});
    await dir.removeEntry(`${key}${PART_SUFFIX}${SWAP_SUFFIX}`).catch(() => {});
  } catch {
    // Nothing stored or storage unavailable.
  }
}

/** Object URL for an already-completed incoming file, if all slices exist. */
export async function completedIncomingUrl(
  key: string,
  size: number,
  type: string
): Promise<string | null> {
  if (typeof navigator.storage?.getDirectory !== 'function') return null;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await tryGetDir(root, INCOMING_DIR);
    const part = dir ? await tryGetDir(dir, key) : null;
    if (!part) return null;

    const files: File[] = [];
    for await (const [name, handle] of part.entries()) {
      if (!SLICE_SEQ_RE.test(name)) continue;
      files.push(await (handle as FileSystemFileHandle).getFile());
    }
    if (files.length === 0) return null;
    files.sort((a, b) => Number(a.name) - Number(b.name));
    // Contiguous sequence numbers starting at zero.
    if (files.some((file, index) => Number(file.name) !== index)) return null;
    // Uniform slice sizes except for the last one, and the exact total.
    const first = files[0]!.size;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total !== size) return null;
    if (files.length > 1 && files.slice(0, -1).some((file) => file.size !== first)) return null;
    if (files.length > 1 && files[files.length - 1]!.size > first) return null;

    const blob = new Blob(files as BlobPart[], {type: type || 'application/octet-stream'});
    return URL.createObjectURL(blob);
  } catch {
    // Nothing stored or storage unavailable.
  }
  return null;
}
