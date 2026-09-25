# LocalTransfer Large-File Streaming — Feature Document

## Objective
Transfer multi-GB files (target: 5–10 GB) over the existing WebRTC channel with
bounded memory on both sides, disk-backed receiving, resumable partials and
honest progress — without forking Trystero.

## Problem
Trystero 0.25.4 `action.send()` materialises the whole payload before chunking:
`await data.arrayBuffer()` plus a pre-allocated chunk array
(`@trystero-p2p/core/dist/action-wire.mjs:97,100-110`), and the receiver keeps
every chunk plus a contiguous copy (`:157-166`). Measured 2026-09-25 on
Chromium 153: `file.arrayBuffer()` fails with `NotReadableError` from
2 GiB − 1 MiB upwards (OK at 2 GiB − 8 MiB); a 1.5 GB file peaks at ~4.5 GB of
RAM through the old path. A 10 GB file would need 20 GB (send) / ~30 GB
(receive).

## Why
The app advertises "drop files" with no size caveat, and Trystero's README
claims "you can send very large files" (`node_modules/trystero/README.md:288`).
LAN users will drop ISOs and disk images; today those fail with a generic
error after burning RAM. The receive path also needs a secure context for
disk APIs, and the app currently ships only an HTTP LAN flow
(`http://192.168.x.x:5173`) where OPFS, File System Access, Wake Lock and Web
Crypto are unavailable.

## Scope
- New `src/chunked-file.ts`: slice constants, FNV-1a identity fingerprint,
  `createSink()` with three strategies — File System Access direct save
  (Chromium, user-picked path), OPFS streaming (all modern browsers, resumable),
  in-memory fallback (small files only).
- `src/main.ts`: replace the whole-file action with a sliced protocol —
  `file` (4 MiB binary slices, metadata `{id, seq}`) + `fileCtl` (JSON:
  `meta`/`offer`/`decline`/`done`/`abort`), per-peer send loops, resume offsets,
  accept/decline for large incoming files, cancel, wake lock, rAF-batched
  progress with in-place row updates, blob-URL revocation and OPFS eviction.
- `src/i18n.ts`: EN/ES strings for the new states.
- `index.html` / `src/styles.css`: hint line, action buttons.
- LAN HTTPS: `scripts/lan-cert.mjs` + `vite.config.ts` HTTPS when certs exist,
  so disk APIs work from other devices; insecure contexts degrade to a memory
  sink with a 256 MiB cap and a clear hint.
- Docs: README limits/how-it-works; this document records verification evidence.

## Constraints
- No new runtime dependencies.
- Keep vanilla DOM + strict TypeScript; preserve EN/ES parity and a11y.
- Trystero stays as the transport; no library fork or patch.
- Data channel stays ordered+reliable, so slices arrive in order; protocol
  still validates `seq` and aborts on gaps.
- Partial files: kept on network/peer failure (resume), deleted on explicit
  cancel/decline/leave.
- TDD: off (project default; no test runner). Verification via Playwright
  harness outside the repo + recorded evidence.

## Protocol
1. Sender → `meta {id, name, type, size, lastModified, headHash, total}`.
2. Receiver prepares a sink (picker/OPFS/memory), then → `offer {id, offset}`;
   `offset` is the byte resume point from a previous partial.
3. Sender slices from `offset` in 4 MiB steps, one `send(slice, {target, metadata:{id, seq}})` per slice.
4. Receiver validates `seq`, streams to the sink, tracks bytes.
5. Receiver → `done {id, size}` when the sink closes; sender marks that peer done
   only then. `abort {id, reason}` flows both ways.
6. Broadcast sends run one loop per peer; progress aggregates the minimum
   completed fraction, and per-peer failures do not cancel healthy peers.

## Identity / resume
- `key = FNV1a64(name|size|lastModified|type|headHash)`, `headHash` = FNV1a64 of
  the first 64 KiB (no Web Crypto, so it works on plain-HTTP LAN too).
- OPFS partials live at `incoming/<key>.part`; completion renames to
  `incoming/<key>` when `FileSystemHandle.move()` exists.
- Re-offering an already complete key short-circuits to `done` (dedupe).

## Acceptance criteria
- 3 GB file transfers between two browsers with correct bytes at the end
  (size + first/last MiB hashes) and no whole-file read in either direction.
- Whole-file operation never calls `File.arrayBuffer()` on payloads > 2 GiB.
- Resume: interrupted transfer (peer tab closed mid-flight) restarts from the
  receiver's partial offset and still produces identical bytes.
- Incoming files > 512 MiB require an explicit Accept; Cancel works on both
  sides; progress rows update without rebuilding the DOM per chunk.
- Insecure context (plain HTTP LAN) shows the HTTPS hint and refuses to
  receive files above the memory cap instead of crashing the tab.
- `npm run build` passes; `npm run lan` serves HTTPS with a cert valid for the
  machine's current LAN IPs.

## Tasks
- [x] T1 Feature doc.
- [x] T2 Primitives module (`src/chunked-file.ts`).
- [x] T3 Protocol + UI integration (`src/main.ts`, i18n, styles, index.html).
- [x] T4 LAN HTTPS (`scripts/lan-cert.mjs`, `vite.config.ts`, package script).
- [x] T5 Docs (README) + verification evidence.

## Progress
- 2026-09-25: doc created; Chromium API primitives verified (2.4 GB OPFS blob
  stream download, composed-file slice past 2 GiB, `keepExistingData`+`seek`
  resume, `move()`), 21/28 Nostr relays reachable from the sandbox.
- 2026-09-25: implemented and verified end to end (evidence below).

## Verification evidence
Environment: Chromium 153 (Playwright headless shell), macOS 16 GB RAM, app
served by `vite preview` on `http://127.0.0.1:4173` (secure context); insecure
path checked on `http://192.168.1.52:4173`. Harness:
`/private/var/folders/v_/wzy03chd70g_5x1drb7jqh900000gn/T/opencode/lt-largefile-test`
(`e2e.mjs`, `debug-slices.mjs`, `probe-slices.mjs`, `smoke-insecure.mjs`).

- Small file (2 MiB + 12345 B): exact size and first/last MiB SHA-256 match.
- 3 GiB FSA path (picker stubbed to an OPFS-backed handle): 3,221,237,817 B
  received, first/last MiB hashes match, receiver JS heap max 20.5 MB,
  row reads "Saved to disk · 3.0 GB".
- 5 GiB run (`BIG_BYTES=5368715930`): 5,368,715,930 B, hashes match, heap max
  23.1 MB, 3m46s end to end (~24 MB/s).
- Resume: receiver tab killed at 5% of 900 MiB; 12 committed slices
  (50,331,648 B) survived; re-send logged "Resuming “resume.bin” from 5%",
  finished with 226 slices / 943,719,177 B and matching hashes.
- Dedupe: re-sending the stored file completed in 205 ms with one row and no
  bytes on the wire.
- Delete: the per-row Delete action removed the stored slice directory.
- Insecure LAN origin: `isSecureContext` false, no OPFS/picker/wake lock,
  HTTPS hint rendered, rooms still usable for the memory sink.
- HTTPS LAN: `npm run lan` generated a certificate for 127.0.0.1 and
  192.168.1.52 and served `https://192.168.1.52:5173/` (HTTP 200).
- `npm run build` passes (tsc strict + vite 8.3.0, 52 modules).
- Design findings that changed the implementation: `createWritable({keepExistingData})`
  is O(file size) (~1.2 ms/MB), so per-slice files replaced checkpoints; an open
  writable's bytes live in a `.crswap` file that dies with the tab, so slices are
  committed individually; rAF is paused in hidden tabs, so progress flushes on a
  250 ms watchdog as well.
