/* routes/servers.js — actions on a Minecraft server */

import {
  listServers, getServer,
  startServer, stopServer, restartServer, getServerStatus,
  rconCommand,
  listFiles, readServerFile, writeServerFile,
  getServerLogs, streamServerLogs,
  getAutoStopMinutes, setAutoStopMinutes,
} from '../servers.js';
import { audit } from '../audit.js';
import { requireAuth, requireRole } from '../roles.js';

const MC_USERNAME = /^[a-zA-Z0-9_]{3,16}$/;
const ALLOWED_AUTO_STOP = [0, 5, 15, 30, 60, 120];

function visibleServers(user) {
  const all = listServers();
  if (user.is_super) return all;
  return all.filter(s => user.permissions[s.name]);
}

export default async function (app) {

  app.get('/api/servers', { preHandler: requireAuth }, async (req) => {
    const servers = visibleServers(req.user);
    const out = [];
    for (const s of servers) {
      const status = await getServerStatus(s.name).catch(() => ({ running: false }));
      const role   = req.user.is_super ? 'operator' : req.user.permissions[s.name];
      out.push({ ...s, ...status, role });
    }
    return { servers: out };
  });

  app.get('/api/servers/:name/status', { preHandler: requireRole('starter') }, async (req) => {
    return getServerStatus(req.params.name);
  });

  app.post('/api/servers/:name/start', { preHandler: requireRole('starter') }, async (req, reply) => {
    const r = await startServer(req.params.name);
    audit(req, 'server.start', req.params.name, { code: r.code });
    if (r.code !== 0) return reply.code(500).send({ error: 'systemctl failed', detail: r.stderr });
    return { ok: true };
  });

  app.post('/api/servers/:name/stop', { preHandler: requireRole('operator') }, async (req, reply) => {
    const r = await stopServer(req.params.name);
    audit(req, 'server.stop', req.params.name, { code: r.code });
    if (r.code !== 0) return reply.code(500).send({ error: 'systemctl failed', detail: r.stderr });
    return { ok: true };
  });

  app.post('/api/servers/:name/restart', { preHandler: requireRole('operator') }, async (req, reply) => {
    const r = await restartServer(req.params.name);
    audit(req, 'server.restart', req.params.name, { code: r.code });
    if (r.code !== 0) return reply.code(500).send({ error: 'systemctl failed', detail: r.stderr });
    return { ok: true };
  });

  app.post('/api/servers/:name/whitelist/add', { preHandler: requireRole('operator') }, async (req, reply) => {
    const username = (req.body?.username || '').trim();
    if (!MC_USERNAME.test(username)) return reply.code(400).send({ error: 'invalid minecraft username' });
    const result = await rconCommand(req.params.name, `whitelist add ${username}`);
    audit(req, 'whitelist.add', req.params.name, { username, result });
    return { ok: true, result };
  });

  app.post('/api/servers/:name/whitelist/remove', { preHandler: requireRole('operator') }, async (req, reply) => {
    const username = (req.body?.username || '').trim();
    if (!MC_USERNAME.test(username)) return reply.code(400).send({ error: 'invalid minecraft username' });
    const result = await rconCommand(req.params.name, `whitelist remove ${username}`);
    audit(req, 'whitelist.remove', req.params.name, { username, result });
    return { ok: true, result };
  });

  app.get('/api/servers/:name/whitelist', { preHandler: requireRole('operator') }, async (req) => {
    const result = await rconCommand(req.params.name, 'whitelist list');
    return { result };
  });

  app.post('/api/servers/:name/console', { preHandler: requireRole('operator') }, async (req, reply) => {
    const command = (req.body?.command || '').trim();
    if (!command || command.length > 1000) return reply.code(400).send({ error: 'invalid command' });
    const result = await rconCommand(req.params.name, command);
    audit(req, 'console.command', req.params.name, { command, result_preview: result.slice(0, 200) });
    return { result };
  });

  /* recent log lines for the server's systemd unit */
  app.get('/api/servers/:name/logs', { preHandler: requireRole('operator') }, async (req, reply) => {
    const lines = Math.min(parseInt(req.query.lines, 10) || 200, 2000);
    try {
      const text = await getServerLogs(req.params.name, lines);
      return { lines, text };
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  /* download the full log as a text file */
  app.get('/api/servers/:name/logs/download', { preHandler: requireRole('operator') }, async (req, reply) => {
    const name = req.params.name;
    if (!getServer(name)) return reply.code(404).send({ error: 'unknown server' });

    audit(req, 'logs.download', name);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${name}-${stamp}.log"`);

    const stream = streamServerLogs(name);
    return reply.send(stream);
  });

  /* auto-stop config */
  app.get('/api/servers/:name/auto-stop', { preHandler: requireRole('operator') }, async (req, reply) => {
    if (!getServer(req.params.name)) return reply.code(404).send({ error: 'unknown server' });
    return { minutes: getAutoStopMinutes(req.params.name) };
  });

  app.put('/api/servers/:name/auto-stop', { preHandler: requireRole('operator') }, async (req, reply) => {
    const minutes = parseInt(req.body?.minutes, 10);
    if (!ALLOWED_AUTO_STOP.includes(minutes)) {
      return reply.code(400).send({ error: 'minutes must be one of: ' + ALLOWED_AUTO_STOP.join(', ') });
    }
    try {
      setAutoStopMinutes(req.params.name, minutes);
      audit(req, 'auto-stop.set', req.params.name, { minutes });
      return { ok: true, minutes };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.get('/api/servers/:name/files', { preHandler: requireRole('operator') }, async (req, reply) => {
    const path = req.query.path || '.';
    try {
      const items = await listFiles(req.params.name, path);
      return { path, items };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.get('/api/servers/:name/file', { preHandler: requireRole('operator') }, async (req, reply) => {
    const path = req.query.path;
    if (!path) return reply.code(400).send({ error: 'path required' });
    try {
      const content = await readServerFile(req.params.name, path);
      return { path, content };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.put('/api/servers/:name/file', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { path, content } = req.body || {};
    if (!path || typeof content !== 'string') return reply.code(400).send({ error: 'path and content required' });
    try {
      await writeServerFile(req.params.name, path, content);
      audit(req, 'file.write', req.params.name, { path, bytes: Buffer.byteLength(content) });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });
}
