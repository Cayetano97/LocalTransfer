import fs from 'node:fs';
import {defineConfig} from 'vite';

// LAN sharing is enabled via the `lan` script (certificate + `vite --host`).
// When `.certs/` exists we serve HTTPS: large-file receiving needs OPFS / File
// System Access, which browsers only expose in secure contexts. Localhost
// development keeps working over plain HTTP with `npm run dev`.
const keyPath = '.certs/key.pem';
const certPath = '.certs/cert.pem';
const https =
  fs.existsSync(keyPath) && fs.existsSync(certPath)
    ? {key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath)}
    : undefined;

export default defineConfig({
  server: {
    port: 5173,
    https
  },
  preview: {
    port: 4173,
    https
  }
});
