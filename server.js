#!/usr/bin/env node
'use strict';

/**
 * server.js — runs on the GitHub Actions runner.
 *
 * Connects OUTBOUND to the Render relay, spawns a real PTY shell
 * (bash/zsh), and handles local port-forward dials requested by the client.
 *
 * Env / flags:
 *   RELAY_URL   / --relay   wss://your-app.onrender.com/ws
 *   RELAY_TOKEN / --token   shared secret
 *   SESSION     / --session session name (default: default)
 *   SHELL       / --shell   shell binary (default: bash)
 *   COLS/ROWS               initial PTY size
 */

const os = require('os');
const net = require('net');
const path = require('path');
const pty = require('node-pty');
const WebSocket = require('ws');
const {
  T,
  decode,
  send,
  b64,
  fromB64,
  parseArgs,
} = require('./lib/protocol');

const args = parseArgs(process.argv.slice(2));

const RELAY_URL =
  args.flags.relay ||
  process.env.RELAY_URL ||
  process.env.WS_URL ||
  '';
const TOKEN =
  args.flags.token ||
  process.env.RELAY_TOKEN ||
  process.env.TOKEN ||
  '';
const SESSION =
  args.flags.session ||
  process.env.SESSION ||
  process.env.SESSION_ID ||
  'default';
const SHELL =
  args.flags.shell ||
  process.env.SHELL_BIN ||
  (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
const RECONNECT_MS = Number(process.env.RECONNECT_MS || 3000);
const MAX_RECONNECT = Number(process.env.MAX_RECONNECT || 100);

if (!RELAY_URL) {
  console.error('Missing RELAY_URL (e.g. wss://my-app.onrender.com/ws)');
  process.exit(1);
}

/** @type {Map<string, net.Socket>} */
const tunnels = new Map();

let ptyProcess = null;
let ws = null;
let reconnectCount = 0;
let intentionalExit = false;
let clientReady = false;
let cols = Number(process.env.COLS || args.flags.cols || 120);
let rows = Number(process.env.ROWS || args.flags.rows || 40);

function log(...a) {
  console.error(`[server]`, ...a);
}

function spawnPty() {
  if (ptyProcess) return ptyProcess;

  const env = {
    ...process.env,
    TERM: process.env.TERM || 'xterm-256color',
    COLORTERM: process.env.COLORTERM || 'truecolor',
    // Helpful context inside the job
    GHA_TUNNEL: '1',
  };

  // Prefer login-ish interactive shell
  const shellArgs =
    os.platform() === 'win32'
      ? []
      : ['-i']; // interactive bash

  ptyProcess = pty.spawn(SHELL, shellArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
    env,
  });

  log(`PTY spawned pid=${ptyProcess.pid} shell=${SHELL} ${cols}x${rows}`);

  ptyProcess.onData((data) => {
    if (ws && clientReady) {
      send(ws, { t: T.STDOUT, d: b64(data) });
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    log(`PTY exited code=${exitCode} signal=${signal}`);
    ptyProcess = null;
    if (ws) {
      send(ws, { t: T.EXIT, code: exitCode ?? null, signal: signal ?? null });
    }
    // Keep WS alive so client can see exit; job can end
    if (!intentionalExit) {
      // Respawn shell so session stays usable until job timeout
      setTimeout(() => {
        if (!intentionalExit) {
          log('respawning PTY…');
          spawnPty();
        }
      }, 500);
    }
  });

  return ptyProcess;
}

function closeAllTunnels() {
  for (const [id, sock] of tunnels) {
    try {
      sock.destroy();
    } catch {
      /* ignore */
    }
    tunnels.delete(id);
  }
}

function openTunnel(id, host, port) {
  if (tunnels.has(id)) {
    send(ws, { t: T.TUNNEL_ERROR, id, error: 'id already open' });
    return;
  }

  const sock = net.connect({ host, port }, () => {
    log(`tunnel ${id} connected -> ${host}:${port}`);
    send(ws, { t: T.TUNNEL_OPENED, id, host, port });
  });

  sock.on('data', (chunk) => {
    send(ws, { t: T.TUNNEL_DATA, id, d: b64(chunk) });
  });

  sock.on('close', () => {
    tunnels.delete(id);
    send(ws, { t: T.TUNNEL_CLOSE, id });
  });

  sock.on('error', (err) => {
    log(`tunnel ${id} error:`, err.message);
    tunnels.delete(id);
    send(ws, { t: T.TUNNEL_ERROR, id, error: err.message });
    try {
      sock.destroy();
    } catch {
      /* ignore */
    }
  });

  tunnels.set(id, sock);
}

function handleMessage(raw) {
  let msg;
  try {
    msg = decode(raw);
  } catch {
    return;
  }

  switch (msg.t) {
    case T.AUTH_OK:
      log(`auth ok session=${msg.session} peer=${msg.peerConnected}`);
      break;

    case T.AUTH_FAIL:
      log(`auth failed: ${msg.error}`);
      intentionalExit = true;
      process.exit(1);
      break;

    case T.READY:
      clientReady = true;
      log('client paired — terminal live');
      spawnPty();
      // Push a tiny banner
      if (ptyProcess) {
        // Don't inject into PTY; client will see natural prompt
      }
      send(ws, {
        t: T.INFO,
        message: `GHA shell ready on ${os.hostname()} (${os.platform()} ${os.arch()}) cwd=${process.cwd()}`,
      });
      break;

    case T.PEER_LEFT:
      clientReady = false;
      log('client disconnected — waiting for reconnect');
      // Keep PTY alive so state (cwd, env) survives brief disconnects
      break;

    case T.INFO:
      log(`info: ${msg.message || ''}`);
      break;

    case T.STDIN: {
      if (!ptyProcess) spawnPty();
      if (ptyProcess && msg.d) {
        ptyProcess.write(fromB64(msg.d));
      }
      break;
    }

    case T.RESIZE: {
      const c = Number(msg.cols) || cols;
      const r = Number(msg.rows) || rows;
      cols = c;
      rows = r;
      if (ptyProcess) {
        try {
          ptyProcess.resize(c, r);
        } catch (e) {
          log('resize failed:', e.message);
        }
      }
      break;
    }

    case T.TUNNEL_OPEN: {
      const id = msg.id;
      const host = msg.host || '127.0.0.1';
      const port = Number(msg.port);
      if (!id || !port) {
        send(ws, { t: T.TUNNEL_ERROR, id, error: 'id and port required' });
        break;
      }
      log(`tunnel_open ${id} -> ${host}:${port}`);
      openTunnel(id, host, port);
      break;
    }

    case T.TUNNEL_DATA: {
      const sock = tunnels.get(msg.id);
      if (sock && msg.d) {
        sock.write(fromB64(msg.d));
      }
      break;
    }

    case T.TUNNEL_CLOSE: {
      const sock = tunnels.get(msg.id);
      if (sock) {
        sock.end();
        tunnels.delete(msg.id);
      }
      break;
    }

    case T.PING:
      send(ws, { t: T.PONG, ts: msg.ts || Date.now() });
      break;

    case T.PONG:
      break;

    case T.EXIT:
      // client requested hangup
      intentionalExit = true;
      closeAllTunnels();
      if (ptyProcess) {
        try {
          ptyProcess.kill();
        } catch {
          /* ignore */
        }
      }
      if (ws) ws.close();
      process.exit(0);
      break;

    default:
      // ignore unknown
      break;
  }
}

function connect() {
  if (intentionalExit) return;

  log(`connecting to ${RELAY_URL} session=${SESSION} (try #${reconnectCount + 1})`);

  ws = new WebSocket(RELAY_URL, {
    handshakeTimeout: 15_000,
    // Render may need this behind proxies
    headers: { 'User-Agent': 'gha-terminal-server/1.0' },
  });

  ws.on('open', () => {
    reconnectCount = 0;
    log('WS open — sending auth');
    send(ws, {
      t: T.AUTH,
      role: 'server',
      token: TOKEN,
      session: SESSION,
      meta: {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        runner: process.env.RUNNER_NAME || null,
        repo: process.env.GITHUB_REPOSITORY || null,
        job: process.env.GITHUB_JOB || null,
        runId: process.env.GITHUB_RUN_ID || null,
        workspace: process.env.GITHUB_WORKSPACE || process.cwd(),
      },
    });
  });

  ws.on('message', (raw) => handleMessage(raw));

  ws.on('close', (code, reason) => {
    log(`WS closed code=${code} reason=${reason || ''}`);
    clientReady = false;
    ws = null;
    closeAllTunnels();
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    log('WS error:', err.message);
  });
}

function scheduleReconnect() {
  if (intentionalExit) return;
  if (reconnectCount >= MAX_RECONNECT) {
    log('max reconnects reached — exiting');
    process.exit(1);
  }
  reconnectCount++;
  const wait = Math.min(RECONNECT_MS * reconnectCount, 30_000);
  log(`reconnect in ${wait}ms…`);
  setTimeout(connect, wait);
}

// Keepalive app-level ping (in addition to ws protocol ping from relay)
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    send(ws, { t: T.PING, ts: Date.now() });
  }
}, 20_000).unref();

process.on('SIGTERM', () => {
  log('SIGTERM');
  intentionalExit = true;
  closeAllTunnels();
  if (ptyProcess) ptyProcess.kill();
  if (ws) ws.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  intentionalExit = true;
  closeAllTunnels();
  if (ptyProcess) ptyProcess.kill();
  if (ws) ws.close();
  process.exit(0);
});

connect();
