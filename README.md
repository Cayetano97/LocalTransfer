<p align="center">
  <img src="./public/icon.svg" width="96" height="96" alt="LocalTransfer icon" />
</p>

<h1 align="center">LocalTransfer</h1>

<p align="center">
  Peer-to-peer file sharing for your local network.<br />
  No uploads, no server storage — files go directly between browsers.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/platform-Web-888888" alt="Web" />
  <img src="https://img.shields.io/badge/license-MIT-yellow.svg" alt="License" />
</p>

---

Open a room on one device, share the link or QR, and drop files. Everyone in the same room receives them over WebRTC DataChannels.

## Features

- **Rooms** — same link, same room; peers discover each other automatically
- **P2P transfers** — browser-to-browser, nothing stored on any server
- **Large files** — streamed in 4 MiB slices with bounded memory, resume support, and direct-to-disk save where available
- **Flexible targets** — send to everyone or to a single peer
- **Invite QR** — join from your phone on the same Wi-Fi in one scan

## Quick start

Requires [Node.js](https://nodejs.org) 20+.

```sh
npm install
npm run lan
```

Open the printed `https://192.168.x.x:5173/` URL on both devices and accept the self-signed certificate warning once per device. Then join the same room.

| Command | Purpose |
| --- | --- |
| `npm run dev -- --host` | Dev server (plain HTTP; fine for small files) |
| `npm run lan` | Dev server over HTTPS for the LAN (recommended) |
| `npm run build` | Type-check and build to `dist/` |
| `npm run preview -- --host` | Serve the production build |

> **Why HTTPS?** Browsers only expose disk APIs (OPFS, File System Access, Wake Lock) in a secure context. On plain HTTP, incoming files above 256 MB are refused with a hint to switch to `npm run lan`.

## Usage

1. Enter a nickname, then **Create** a room or **Join** one with a code.
2. Share the invite link or QR with the other device.
3. Drop files and choose **Everyone** or a single peer as target.
4. Files up to 512 MB start automatically; larger ones wait for **Accept**. Keep both tabs open until the transfer finishes (screen sleep is held off automatically).

Received files persist in the browser across reloads; each entry has a **Delete** action, and only the 50 newest are kept.

## Limitations

- Peer discovery uses Trystero's public Nostr relays, so devices need internet access to find each other. File bytes stay peer-to-peer, usually on the LAN. Without internet, rooms stay empty.
- Practical mesh size is ~6–8 peers. Storage quota depends on browser and free disk; saving to a user-picked file (Chrome/Edge) bypasses the quota.

## Stack

Vite + TypeScript (strict) + vanilla DOM. [`trystero`](https://github.com/dmotz/trystero) for signaling/P2P, [`qrcode`](https://github.com/soldair/node-qrcode) for the invite QR.

## License

MIT — © 2026 [Cayetano97](https://github.com/Cayetano97).
