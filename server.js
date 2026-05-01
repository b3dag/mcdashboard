/* =========================================================
   server.js — fastify app entrypoint.
   ---------------------------------------------------------
   Listens on 127.0.0.1 only. Cloudflare Tunnel forwards to it.
   Includes:
     - cookie auth + session
     - api routes for auth / servers / users
     - optional proxy to a local ttyd at 127.0.0.1:7681 (super-only)
     - static dashboard pages from /public
     - background auto-stop loop for idle Minecraft servers
   ========================================================= */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as netRequest } from 'node:http';

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import httpProxy from '@fastify/http-proxy';

import { loadUserFromCookie } from './auth.js';

import authRoutes from './routes/auth.js';
import serverRoutes from './routes/servers.js';
import userRoutes from './routes/users.js';

import { startAutoStop } from './auto-stop.js';

/* load .env */
function loadEnv() {
  try {
    const txt = readFileSync('.env', 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
      }
    }
  } catch { /* no .env, fine */ }
}
loadEnv();

if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is required (see .env.example)');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  trustProxy: process.env.TRUST_PROXY === 'true',
});

await app.register(cookie, {
  secret: process.env.SESSION_SECRET,
  parseOptions: {},
});

/* populate req.user on every request */
app.addHook('preHandler', async (req) => {
  await loadUserFromCookie(req);
});

/* ---------- API routes ---------- */
await app.register(authRoutes);
await app.register(serverRoutes);
await app.register(userRoutes);

/* ---------- terminal proxy (super-operator only) ---------- */
/* Only registered if TERMINAL_ENABLED=true. ttyd must be running
   on 127.0.0.1:7681 with --writable. */
if (process.env.TERMINAL_ENABLED === 'true') {
  await app.register(httpProxy, {
    upstream: 'http://127.0.0.1:7681',
    prefix: '/terminal',
    rewritePrefix: '',
    websocket: true,
    preHandler: async (req, reply) => {
      if (!req.user)          return reply.code(401).send({ error: 'not logged in' });
      if (!req.user.is_super) return reply.code(403).send({ error: 'super-operator only' });
    },
  });
  app.log.info('terminal proxy enabled at /terminal');
}

/* ---------- static files ---------- */
await app.register(staticFiles, {
  root:   resolve(__dirname, 'public'),
  prefix: '/',
});

/* SPA-ish fallback: any non-API GET that isn't a file → /login.html if not logged in,
   otherwise /index.html. */
app.setNotFoundHandler(async (req, reply) => {
  if (req.method !== 'GET' || req.url.startsWith('/api/')) {
    return reply.code(404).send({ error: 'not found' });
  }
  const target = req.user ? '/index.html' : '/login.html';
  return reply.redirect(target);
});

const host = process.env.HOST || '127.0.0.1';
const port = parseInt(process.env.PORT || '8080', 10);

try {
  await app.listen({ host, port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

/* ---------- background jobs ---------- */
startAutoStop(app.log);
