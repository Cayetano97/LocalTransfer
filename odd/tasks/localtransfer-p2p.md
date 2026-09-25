# LocalTransfer P2P — Feature Document

## Objective
Web LAN P2P: enter URL, discover peers in same room/network, open channel to send/download files. Responsive + dark/light.

## Problem
Sharing files in same local network without USB, email, or central upload server.

## Why
Fast, simple, no backend storage; files go direct peer-to-peer via WebRTC DataChannel.

## Scope
- Vite + TypeScript vanilla + Trystero (Nostr strategy default, works on LANs with internet)
- Presence: joinRoom, onPeerJoin/Leave, getPeers, display names
- File channel: makeAction binary with metadata, progress, Blob download
- LAN hosting: preview --host + printed LAN IP + QR join link
- UI responsive + dark/light toggle, copy EN + ES with language switch (user explicitly requested Spanish artifacts)
- Single-viewport layout: no vertical page scroll; internal panels scroll
- Deps at latest majors (vite 8.x, typescript 7.x where compatible); unused files removed
- Out of scope: strict offline-no-internet relay, TURN, auth, persistence, >8 peer mesh optimization

## Constraints
- P2P pure: no file bytes through server; signaling only via Trystero public strategy
- Max mesh ~6-8 peers; chunks handled by Trystero actions
- No framework; minimal deps: trystero, qrcode

## Tasks
- [x] T1 Scaffold Vite TS app, dark/light + responsive shell, join/create room via hash (route: delegated direct, writer trigger)
- [x] T2 Presence: joinRoom appId localtransfer, name action, peer list, copy/QR invite (route: delegated direct)
- [x] T3 File channel: file action send/receive, progress, download, drag&drop + file picker (route: delegated direct)
- [x] T4 LAN run: host script, QR, docs, build verify (route: delegated direct)
- [x] T5 i18n EN/ES: central dict + toggle + persisted, all ~35 strings (route: delegated direct, writer trigger)
- [x] T6 Single viewport: 100dvh app shell, page overflow hidden, internal panel scroll, 360px→desktop (route: delegated direct)
- [x] T7 Upgrade deps to latest majors: vite 8.x, typescript 7.x, trystero/qrcode latest, fix breaking changes (route: delegated direct)
- [x] T8 Cleanup: delete unused files (dist output, tsbuildinfo cache, unreferenced vite-env if safe), verify build (route: delegated direct)

## Authorized scope
/Users/cayetano/Documents/Webs/LocalTransfer — T5–T8 may edit src/index.html/css/ts + configs; deletions allowed ONLY for: dist/ output, tsconfig.tsbuildinfo cache, and files proven unreferenced (no import, not a build input). Never delete .git, node_modules, odd/ docs.

## Acceptance criteria
- Two browsers (same LAN or two tabs) joining same room URL see each other
- A sends file, B sees progress and downloads identical bytes
- Toggle dark/light persists; layout usable 360px → desktop
- EN/ES toggle switches 100% of UI copy and persists
- Page never scrolls vertically at 360px→desktop widths; overflow content scrolls inside panels only
- `npm run build` passes on latest majors; no unreferenced/dead files remain
- `npm run build` passes; `npm run dev -- --host` prints LAN URL

## Applicable checks
- `npm run build`
- Manual 2-client flow: join same room, send .txt, verify download

## TDD
- Mode: off (no test runner configured in empty greenfield; ordinary functional checks only). Source: project default.

## Progress
- 2026-09-21: doc created, awaiting writer delegation.
- 2026-09-21: T1–T4 done and verified. New scope T5–T8 (i18n, single-viewport, upgrade, cleanup).

## Verification evidence
- T1 `feat(p2p): scaffold responsive shell with theme` — fa82ca9 — `npm run build`: pass (vite 6.4.3, 54 modules, dist emitted).
- T2 `feat(p2p): presence room and peers` — c0e4f69 — `npm run build`: pass (71 modules).
- T3 `feat(p2p): file channel send receive` — 1dcdd53 — `npm run build`: pass.
- T4 `chore(p2p): lan run docs` — (this commit) — `npm install`: pass (trystero 0.25.4, qrcode 1.5.4, vite 6.4.3) — `npm run build`: pass — `npm run lan`: prints `Local: http://localhost:5173/` + `Network: http://192.168.1.52:5173/` (observed).
- Size heuristic: respected — per-task commits ~190-230 lines of src each (lockfile excluded); no behavior omitted.
- T6 single viewport — `npm run build`: pass. `html,body{height:100%;overflow:hidden}`, body flex column `100dvh` (100vh fallback), topbar `flex:none`, `.layout{flex:1;min-height:0;overflow:hidden}` (unjoined: `overflow-y:auto` internally); join panel is `<details>` auto-collapsed to one summary bar on join; desktop grid side-by-side with each card `overflow-y:auto`, mobile Peers|Files tab switch (`body[data-panel]`). Verified live: page scrollHeight==clientHeight at 360×640 and 1280×720 unjoined, 360×640 and 1280×800 joined. Fixed two boot bugs found via console: `#peerEmpty` removed by renderPeers before applyI18n (null-safe now), and boot calls ran before `transferStates` const init (TDZ — boot moved to end of file).
- T7 upgrade deps — `npx -y npm-check-updates -u` + `npm install`, then `npm run build`: pass (tsc + vite 8.3.0, 51 modules). Final: vite 8.3.0, typescript 7.0.2, trystero 0.25.4 (+@trystero-p2p 0.25.4), qrcode 1.5.4, @types/node 26.6.2, @types/qrcode 1.5.6. Zero breaking-change fixes needed: minimal vite config API unchanged, TS strict flags clean, Trystero action-object style (`send(data,{target,metadata,onProgress})`, assignable `onPeerJoin/onMessage`) kept as-is. Live smoke of upgraded dist: zero console errors, ES applied, no page scroll.
- T8 cleanup — deleted `dist/` (rebuilt after) and `tsconfig.tsbuildinfo`; added `*.tsbuildinfo` to `.gitignore` (`dist/` already ignored). `src/vite-env.d.ts` KEPT: proven required — build without it fails with TS2882 (missing `*.css` module declaration from `vite/client` types); nothing else references `vite/client` because no code uses `import.meta`. All other src files proven referenced via imports from `index.html`/`main.ts`. Final `npm run build`: pass; `git status` clean of junk.
- Commits (T5–T8, branch `feat/localtransfer-p2p`, all `npm run build`: pass): T5 `feat(p2p): i18n en-es` — 1e1294f; T6 `feat(p2p): single-viewport layout` — 0bf4494; T7 `chore(p2p): upgrade deps to latest majors` — 4e85232; T8 `chore(p2p): remove unused files` — 3855371.
- Live browser verification 2026-09-21 (parent, vite preview dist, Playwright): load with 0 console errors; ES default → EN toggle switches 100% copy + persists `localtransfer-lang`; theme toggle → dark persists; `scrollHeight==clientHeight` in ES/EN, joined/unjoined, 800px viewport; Join sets `#room=` hash; deep-link tab auto-joins room view ("Peers 1" = self), no crash, no page scroll. Cross-tab peer discovery NOT possible in sandbox: Trystero Nostr relay `wss://chorus.pjv.me/` unreachable (WebSocket failed), so 2-client file flow stays pending on a network with internet. Offline degradation is graceful (app fully usable, 0 peers).
- T5 i18n EN/ES — `npm run build`: pass (vite 6.4.3, 72 modules). Central `src/i18n.ts` (`en`/`es` records + `t(key,vars)` + `LANGS`), header EN|ES segmented toggle persisted to `localtransfer-lang` with `navigator.language` default (es→es else en), `documentElement.lang` updated; transfer rows keep structured state (`direction/peerId/phase/progress`) so detail lines re-render via `t()` on switch. ~50 keys, zero hardcoded UI copy in `src/main.ts` (verified by grep); `index.html` keeps EN defaults only as pre-JS fallback, all re-rendered by `applyI18n()`.

## Discovery (vs brief)
- Installed Trystero (0.25.x, `@trystero-p2p/*` packages) uses the **action-object style**: `const f = room.makeAction('file'); f.send(data, {target, metadata, onProgress}); f.onMessage = (data, {peerId, metadata}) => …` — NOT tuple returns, NOT positional `(blob, target, metadata)` args. Presence hooks are **assignable properties** (`room.onPeerJoin = …`), not methods.
- Real byte progress exists on BOTH sides (`send onProgress` + `onReceiveProgress` with metadata), so T3 shows true sender/receiver progress bars instead of the brief's assumed indeterminate state.

## Next step
- Next: 2-client file transfer on a network with internet (join same room URL on 2 devices, send .txt, verify identical bytes). Optional follow-ups: offline LAN relay, delivery/PR per ordinary repo policy.
