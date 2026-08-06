'use strict';

/**
 * Shared wire protocol for relay <-> server <-> client.
 *
 * Control frames are JSON text messages:
 *   { t: <type>, ...fields }
 *
 * Bulk payloads (terminal I/O, tunnel bytes) use base64 in field `d`
 * so they survive JSON safely (binary-clean for nano/top/vim).
 */

const T = {
  AUTH: 'auth',
  AUTH_OK: 'auth_ok',
  AUTH_FAIL: 'auth_fail',
  READY: 'ready',
  PEER_LEFT: 'peer_left',
  STDIN: 'stdin',
  STDOUT: 'stdout',
  RESIZE: 'resize',
  EXIT: 'exit',
  ERROR: 'error',
  PING: 'ping',
  PONG: 'pong',
  // Local port forward: client listens, server dials host:port on GHA network
  TUNNEL_OPEN: 'tunnel_open',
  TUNNEL_OPENED: 'tunnel_opened',
  TUNNEL_DATA: 'tunnel_data',
  TUNNEL_CLOSE: 'tunnel_close',
  TUNNEL_ERROR: 'tunnel_error',
  // Info / status
  INFO: 'info',
};

function encode(obj) {
  return JSON.stringify(obj);
}

function decode(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  return JSON.parse(text);
}

function b64(buf) {
  if (Buffer.isBuffer(buf)) return buf.toString('base64');
  return Buffer.from(buf).toString('base64');
}

function fromB64(str) {
  return Buffer.from(str, 'base64');
}

function send(ws, obj) {
  if (ws && ws.readyState === 1 /* OPEN */) {
    ws.send(encode(obj));
    return true;
  }
  return false;
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        out.flags[key] = next;
        i++;
      } else {
        out.flags[key] = true;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        out.flags[key] = next;
        i++;
      } else {
        out.flags[key] = true;
      }
    } else if (a.startsWith('-L') && a.length > 2) {
      // -L8080:host:80 style
      if (!out.flags.L) out.flags.L = [];
      if (!Array.isArray(out.flags.L)) out.flags.L = [out.flags.L];
      out.flags.L.push(a.slice(2));
    } else if (a === '-L') {
      const next = argv[++i];
      if (!out.flags.L) out.flags.L = [];
      if (!Array.isArray(out.flags.L)) out.flags.L = [out.flags.L];
      out.flags.L.push(next);
    } else {
      out._.push(a);
    }
  }
  // Normalize repeated -L collected as single string into array
  if (out.flags.L && !Array.isArray(out.flags.L)) {
    out.flags.L = [out.flags.L];
  }
  return out;
}

/**
 * Parse SSH-style -L spec: [bind_addr:]local_port:remote_host:remote_port
 * Examples:
 *   8080:localhost:80
 *   127.0.0.1:3000:127.0.0.1:3000
 *   *:9000:0.0.0.0:9000
 */
function parseForwardSpec(spec) {
  const parts = String(spec).split(':');
  if (parts.length === 3) {
    return {
      bindHost: '127.0.0.1',
      localPort: Number(parts[0]),
      remoteHost: parts[1],
      remotePort: Number(parts[2]),
    };
  }
  if (parts.length === 4) {
    return {
      bindHost: parts[0] === '*' ? '0.0.0.0' : parts[0],
      localPort: Number(parts[1]),
      remoteHost: parts[2],
      remotePort: Number(parts[3]),
    };
  }
  throw new Error(
    `Invalid -L spec "${spec}". Use localPort:remoteHost:remotePort ` +
      `or bindAddr:localPort:remoteHost:remotePort`
  );
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) {
    // still do a compare to avoid trivial timing leak on length
    const dummy = Buffer.alloc(ba.length);
    require('crypto').timingSafeEqual(ba, dummy);
    return false;
  }
  return require('crypto').timingSafeEqual(ba, bb);
}

module.exports = {
  T,
  encode,
  decode,
  b64,
  fromB64,
  send,
  parseArgs,
  parseForwardSpec,
  safeEqual,
};
