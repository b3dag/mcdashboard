#!/usr/bin/env node
/* =========================================================
   scripts/add-server.js
   Add a new Minecraft server to the dashboard.

   CLI mode (interactive):
     node scripts/add-server.js

   GUI mode (called from routes/servers.js with arguments):
     node scripts/add-server.js <name> <display> <type> <version> <port> <rconPort> <ramMax> <ramMin>

   Note: rconPort arg is ignored — it's always derived as `port + 1000`.
   Pass 0 for port to auto-pick the lowest free MC port.

   In GUI mode, progress is written to:
     /tmp/mcsetup-<name>.json
   so the frontend can poll GET /api/servers/create/status?name=<name>
   ========================================================= */

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import readline from 'node:readline/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const DASHBOARD   = '/srv/dashboard';
const MCSERV_ROOT = '/srv/mcserv';

if (process.getuid && process.getuid() === 0) {
  console.error('Do not run as root.');
  process.exit(1);
}

/* ---- progress reporting ---- */
const args       = process.argv.slice(2);
const isGui      = args.length >= 8;
const statusName = isGui ? args[0] : null;
const statusFile = statusName ? `/tmp/mcsetup-${statusName}.json` : null;

// Use a dynamic import-compatible approach for sync fs
import { writeFileSync } from 'node:fs';

function progress(step, message) {
  if (isGui) {
    writeFileSync(statusFile, JSON.stringify({ step, message, done: false, error: null, ts: Date.now() }));
  }
  console.log(`\x1b[34m==>\x1b[0m [${step}] ${message}`);
}

function finish(name) {
  if (isGui) {
    writeFileSync(statusFile, JSON.stringify({ step: 'done', message: `${name} is ready`, done: true, error: null, ts: Date.now() }));
  }
  console.log(`\x1b[32m✓\x1b[0m Setup complete for ${name}`);
}

function abort(message) {
  if (isGui && statusFile) {
    writeFileSync(statusFile, JSON.stringify({ step: 'error', message, done: true, error: message, ts: Date.now() }));
  }
  console.error(`\x1b[31m✗\x1b[0m ${message}`);
  process.exit(1);
}

/* ---- helpers ---- */
const rl = isGui ? null : readline.createInterface({ input: process.stdin, output: process.stdout });

async function ask(question, defaultVal = '') {
  const promptText = `\x1b[33m?\x1b[0m ${question} ${defaultVal ? `[${defaultVal}] ` : ''}`;
  const answer = await rl.question(promptText);
  return answer.trim() || defaultVal;
}

function warn(msg) { console.log(`\x1b[33m!\x1b[0m ${msg}`); }

async function download(url, dest) {
  progress('download', `fetching ${path.basename(dest)}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const fileStream = createWriteStream(dest);
  await pipeline(res.body, fileStream);

  // verify it's a real jar
  const { size } = await stat(dest);
  if (size < 100000) throw new Error(`downloaded file too small (${size} bytes) — probably an error page`);
}

/* helper to find lowest free port starting from `from`,
   skipping any in `taken` AND any actually bound on the OS */
function isPortBoundOnOS(port) {
  try {
    // ss is faster and lighter than lsof
    const out = execSync(`ss -ltn 'sport = :${port}'`, { encoding: 'utf8' });
    // ss prints a header line; if there's a second line, port is bound
    return out.trim().split('\n').length > 1;
  } catch {
    return false;
  }
}

function pickFreePort(taken, from) {
  let p = from;
  while (taken.has(p) || isPortBoundOnOS(p)) p++;
  return p;
}

async function run() {
  let serversCfg;
  try {
    serversCfg = JSON.parse(await readFile(path.join(DASHBOARD, 'servers.json'), 'utf8'));
  } catch {
    abort(`${DASHBOARD}/servers.json not found. Is the dashboard installed?`);
  }

  /* gather ports already in use */
  const usedPorts = new Set(
    serversCfg.servers.flatMap(s => [s.port, s.rcon?.port].filter(Boolean))
  );

  let name, displayName, typeChoice, mcVersion, port, rconPort, ramMax, ramMin;

  if (isGui) {
    /* ---- GUI mode: args passed from the API ---- */
    [name, displayName, typeChoice, mcVersion, port, rconPort, ramMax, ramMin] = args;
    port = parseInt(port, 10);

    // 0 means "auto-pick" — pick lowest available MC port (RCON = port + 1000)
    if (!port || port === 0) {
      port = pickFreePort(usedPorts, 25565);
      // make sure port + 1000 is also free; if not, jump higher
      while (usedPorts.has(port + 1000) || isPortBoundOnOS(port + 1000)) {
        port = pickFreePort(usedPorts, port + 1);
      }
    }
    rconPort = port + 1000;

    if (serversCfg.servers.some(s => s.name === name)) abort(`A server named '${name}' already exists.`);
    progress('init', `starting setup for ${name} (port ${port}, rcon ${rconPort})`);

  } else {
    /* ---- CLI mode: interactive prompts ---- */
    console.clear();
    console.log('\x1b[34m================================================\x1b[0m');
    console.log('\x1b[34m  add a minecraft server                        \x1b[0m');
    console.log('\x1b[34m================================================\x1b[0m\n');

    while (true) {
      name = await ask('server name (lowercase, a-z 0-9 -, e.g. creative01)');
      if (/^[a-z0-9-]+$/.test(name)) {
        if (serversCfg.servers.some(s => s.name === name)) {
          warn(`A server named '${name}' already exists. Pick another.`);
        } else break;
      } else {
        warn('Invalid name. Lowercase letters, digits, hyphens only.');
      }
    }

    displayName = await ask('display name (shown in UI)', name);

    console.log('\nserver type:');
    console.log('  1) vanilla   — official Mojang server');
    console.log('  2) fabric    — Fabric mod loader');
    console.log('  3) paper     — Paper (performance fork of Spigot)');
    typeChoice = await ask('choice (1/2/3)', '1');
    mcVersion  = await ask('minecraft version', '1.21.1');

    // auto-pick MC port; RCON is always port + 1000
    port = pickFreePort(usedPorts, 25565);
    while (usedPorts.has(port + 1000) || isPortBoundOnOS(port + 1000)) {
      port = pickFreePort(usedPorts, port + 1);
    }
    rconPort = port + 1000;

    ramMax = await ask('max RAM (e.g. 4G, 8G)', '4G');
    ramMin = await ask('min RAM', '2G');
    rl.close();

    console.log(`\nports auto-selected: minecraft ${port}, rcon ${rconPort} (=port+1000)`);
    console.log('\n\x1b[32mgot it. running setup...\x1b[0m\n');
  }

  /* ---- pre-flight checks (after we know name and ports) ---- */
  const folder = path.join(MCSERV_ROOT, name);
  const unitPath = path.join(process.env.HOME, '.config/systemd/user', `mc-${name}.service`);

  // folder must not already exist with content
  if (existsSync(folder)) {
    try {
      const fs = await import('node:fs');
      const items = fs.readdirSync(folder);
      if (items.length > 0) {
        abort(`Folder ${folder} already exists and is not empty. Pick a different name or delete the folder first.`);
      }
    } catch (e) {
      abort(`Could not check folder ${folder}: ${e.message}`);
    }
  }

  // systemd unit must not already exist
  if (existsSync(unitPath)) {
    abort(`Systemd unit ${unitPath} already exists. Pick a different name or remove the old unit.`);
  }

  // double-check ports aren't bound on the OS right now
  if (isPortBoundOnOS(port))     abort(`Port ${port} is already in use by something on this server.`);
  if (isPortBoundOnOS(rconPort)) abort(`RCON port ${rconPort} is already in use by something on this server.`);

  /* ---- setup ---- */
  const rconPw = crypto.randomBytes(16).toString('hex');

  progress('folder', `creating ${folder}`);
  await mkdir(folder, { recursive: true });

  /* ---- download jar ---- */
  progress('download', 'fetching server jar...');
  let launchJar = 'server.jar';

  try {
    if (typeChoice === '1') {
      const manifest = await (await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json')).json();
      const versionMeta = manifest.versions.find(v => v.id === mcVersion);
      if (!versionMeta) abort(`Minecraft version '${mcVersion}' not found.`);
      const pkg = await (await fetch(versionMeta.url)).json();
      await download(pkg.downloads.server.url, path.join(folder, 'server.jar'));
      launchJar = 'server.jar';

    } else if (typeChoice === '2') {
      const loaders     = await (await fetch('https://meta.fabricmc.net/v2/versions/loader')).json();
      const installers  = await (await fetch('https://meta.fabricmc.net/v2/versions/installer')).json();
      const loaderVer   = loaders[0].version;
      const installerVer = installers[0].version;
      const url = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVer}/${installerVer}/server/jar`;
      await download(url, path.join(folder, 'fabric-server-launch.jar'));
      launchJar = 'fabric-server-launch.jar';

    } else if (typeChoice === '3') {
      const buildsRes = await fetch(`https://api.papermc.io/v2/projects/paper/versions/${mcVersion}/builds`);
      if (!buildsRes.ok) abort(`Version '${mcVersion}' not supported by Paper.`);
      const buildsData  = await buildsRes.json();
      const latestBuild = buildsData.builds[buildsData.builds.length - 1];
      const url = `https://api.papermc.io/v2/projects/paper/versions/${mcVersion}/builds/${latestBuild.build}/downloads/${latestBuild.downloads.application.name}`;
      await download(url, path.join(folder, 'server.jar'));
      launchJar = 'server.jar';

    } else {
      abort('Invalid server type. Must be 1, 2, or 3.');
    }
  } catch (err) {
    abort(`Download failed: ${err.message}`);
  }

  /* ---- EULA ---- */
  await writeFile(path.join(folder, 'eula.txt'), 'eula=true\n');

  /* ---- first run to generate server.properties ---- */
  progress('firstrun', 'running server once to generate config files (this downloads libraries for Fabric/Paper — may take a few minutes)...');

  await new Promise((resolve) => {
    const mc = spawn('java', [`-Xmx${ramMax}`, '-jar', launchJar, 'nogui'], {
      cwd: folder,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // log output to file so we can show it on failure
    const logStream = createWriteStream(`/tmp/mcfirstrun-${name}.log`);
    mc.stdout.pipe(logStream);
    mc.stderr.pipe(logStream);

    // watch for server.properties to appear
    const check = setInterval(async () => {
      try {
        const st = await stat(path.join(folder, 'server.properties'));
        if (st.size > 0) {
          clearInterval(check);
          clearTimeout(timeout);
          await new Promise(r => setTimeout(r, 3000)); // let it finish writing
          mc.kill('SIGKILL');
          resolve();
        }
      } catch { /* not there yet */ }
    }, 2000);

    // 5 minute max timeout
    const timeout = setTimeout(() => {
      clearInterval(check);
      mc.kill('SIGKILL');
      resolve();
    }, 300000);

    mc.on('exit', () => {
      clearInterval(check);
      clearTimeout(timeout);
      resolve();
    });
  });

  if (!existsSync(path.join(folder, 'server.properties'))) {
    abort(`server.properties not generated. check /tmp/mcfirstrun-${name}.log for details.`);
  }

  /* ---- patch server.properties ---- */
  progress('config', 'configuring server.properties...');
  let props = await readFile(path.join(folder, 'server.properties'), 'utf8');
  const setProp = (k, v) => {
    const re = new RegExp(`^${k}=.*`, 'm');
    props = re.test(props) ? props.replace(re, `${k}=${v}`) : props + `\n${k}=${v}`;
  };
  setProp('enable-rcon',  'true');
  setProp('rcon.port',     rconPort);
  setProp('rcon.password', rconPw);
  setProp('white-list',   'true');
  setProp('server-port',   port);
  setProp('query.port',    port);
  await writeFile(path.join(folder, 'server.properties'), props);

  /* ---- systemd unit ---- */
  progress('systemd', 'creating systemd unit...');
  const systemdDir = path.join(process.env.HOME, '.config/systemd/user');
  await mkdir(systemdDir, { recursive: true });
  const unitFile    = `mc-${name}.service`;
  const unitContent = [
    '[Unit]',
    `Description=Minecraft: ${displayName}`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${folder}`,
    `ExecStart=/usr/bin/java -Xms${ramMin} -Xmx${ramMax} -jar ${launchJar} nogui`,
    'Restart=on-failure',
    'RestartSec=10',
    'SuccessExitStatus=0 143',
    '',
    '[Install]',
    'WantedBy=default.target',
  ].join('\n') + '\n';

  await writeFile(path.join(systemdDir, unitFile), unitContent);
  execSync('systemctl --user daemon-reload');
  execSync(`systemctl --user enable mc-${name}`);

  /* ---- .env ---- */
  progress('env', 'writing RCON password to .env...');
  const envName = `RCON_PASSWORD_${name.toUpperCase().replace(/-/g, '_')}`;
  let envData = await readFile(path.join(DASHBOARD, '.env'), 'utf8');
  // replace if already exists, otherwise append
  const envRe = new RegExp(`^${envName}=.*`, 'm');
  envData = envRe.test(envData)
    ? envData.replace(envRe, `${envName}=${rconPw}`)
    : envData + `\n${envName}=${rconPw}\n`;
  await writeFile(path.join(DASHBOARD, '.env'), envData);

  /* ---- servers.json ---- */
  progress('register', 'registering server in servers.json...');

  // reload in case it changed while we were running
  serversCfg = JSON.parse(await readFile(path.join(DASHBOARD, 'servers.json'), 'utf8'));

  if (serversCfg.servers.some(s => s.name === name)) {
    abort(`A server named '${name}' already exists in servers.json (added by another process?).`);
  }

  serversCfg.servers.push({
    name,
    display_name: displayName,
    folder,
    port,
    systemd_unit: unitFile,
    rcon: { host: '127.0.0.1', port: rconPort, password_env: envName },
  });

  const newJson = JSON.stringify(serversCfg, null, 2);
  // validate before writing
  JSON.parse(newJson);
  await writeFile(path.join(DASHBOARD, 'servers.json'), newJson);

  /* ---- restart dashboard ---- */
  progress('restart', 'restarting dashboard...');
  try {
    execSync('systemctl --user restart dashboard');
  } catch (e) {
    warn(`dashboard restart failed: ${e.message}`);
  }

  finish(displayName);
}

run().catch(err => abort(err.message));
