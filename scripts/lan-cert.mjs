// Generate a self-signed certificate for LAN use.
//
// Large-file receiving depends on secure-context APIs (OPFS, File System
// Access, Wake Lock). Browsers only expose them on HTTPS or localhost, so the
// LAN flow is served over HTTPS with a certificate valid for this machine's
// current IPv4 addresses. The certificate is reused until those addresses
// change, because browsers remember the manual trust exception per origin.
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {networkInterfaces} from 'node:os';
import {join} from 'node:path';

const dir = '.certs';
const keyPath = join(dir, 'key.pem');
const certPath = join(dir, 'cert.pem');
const ipsPath = join(dir, 'ips.json');

function lanIPv4() {
  const addresses = new Set(['127.0.0.1']);
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) addresses.add(info.address);
    }
  }
  return [...addresses].sort();
}

const ips = lanIPv4();
let previous = null;
if (existsSync(ipsPath)) {
  try {
    previous = JSON.parse(readFileSync(ipsPath, 'utf8'));
  } catch {
    previous = null;
  }
}

const reusable =
  existsSync(keyPath) &&
  existsSync(certPath) &&
  Array.isArray(previous) &&
  JSON.stringify(previous) === JSON.stringify(ips);

if (reusable) {
  console.log(`[lan-cert] reusing HTTPS certificate for ${ips.join(', ')}`);
} else {
  mkdirSync(dir, {recursive: true});
  const san = [...ips.map((ip) => `IP:${ip}`), 'DNS:localhost'].join(',');
  execFileSync(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '825',
      '-subj',
      '/CN=LocalTransfer',
      '-addext',
      `subjectAltName=${san}`
    ],
    {stdio: ['ignore', 'ignore', 'inherit']}
  );
  writeFileSync(ipsPath, JSON.stringify(ips));
  console.log(`[lan-cert] generated HTTPS certificate for ${ips.join(', ')}`);
}
