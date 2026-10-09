'use strict';

// telepty probes and lifecycle (DECISIONS R3/R4, controller overrides).
//
// Probes are loopback-only, bounded, and read-only: `/api/health` (no auth), plus `/api/meta`
// and `/api/sessions` only for doctor and lifecycle, and only when a token exists (status sends
// no token). The token is resolved the way telepty does it
// (TELEPTY_AUTH_TOKEN, else `authToken` in ~/.telepty/config.json, read as a file — telepty's
// getConfig() would mint one) and is sent only in the `x-telepty-token` header. It is never
// printed, logged or put in a URL.
//
// Lifecycle follows telepty's own supervisor semantics: the supervisor (launchd / systemd /
// schtasks) owns a supervised daemon, and only when the job it manages serves the ADDRESSED
// port (telepty #902 scoping). Otherwise telepty's own `daemon start|restart` does the work,
// with TELEPTY_PORT pinned to the addressed port. A restart takes telepty's restart lease and
// writes one attribution line in telepty's restart log format. This module never signals a
// process and never kills anything by pid. System tools (launchctl, systemctl, schtasks) are run
// from fixed absolute paths, never looked up through the cwd or PATH.

const fs = require('fs');
const http = require('http');
const path = require('path');

const { EXIT } = require('./registry');

const DEFAULT_PORT = 3848;
const LAUNCHD_LABEL = 'com.aigentry.telepty';
const LAUNCHD_PLIST_NAME = 'com.aigentry.telepty.plist';
const SYSTEMD_SERVICE_NAME = 'telepty';
const SYSTEMD_UNIT_PATH = '/etc/systemd/system/telepty.service';
const SYSTEMD_USER_UNIT_NAME = 'telepty.service';
const WINDOWS_TASK_NAME = 'telepty-daemon';
const RESTART_LEASE_TTL_MS = 60 * 1000;
// Everything done under the lease (children + confirmation) ends this long before the TTL, so no
// other client can judge our lease stale while we still act (no lease renewal: telepty has none).
const RESTART_LEASE_MARGIN_MS = 10 * 1000;
const MAX_LEASE_BYTES = 64 * 1024;
const RESTART_VERDICT = 'aigentry-explicit';
const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const START_WAIT_MS = 8000;
const RESTART_WAIT_MS = 10000;
const POLL_MS = 300;
const CHILD_TIMEOUT_MS = 120000;
const MAX_CONFIG_BYTES = 1024 * 1024;
// Absolute locations tried in order (B7): no cwd or relative-PATH lookup, no .cmd/.bat.
const POSIX_TOOLS = { launchctl: ['/bin/launchctl'], systemctl: ['/usr/bin/systemctl', '/bin/systemctl'] };

/**
 * @typedef {{kind:'ok',status:number,body:any}|{kind:'answered',status:number}|{kind:'malformed',status:number,detail:string}
 *   |{kind:'refused'}|{kind:'timeout'}|{kind:'error',code:string}} Probe
 */

// ── port and token ──────────────────────────────────────────────────────────

function parsePort(value) {
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

/** --port, else TELEPTY_PORT, else 3848. An invalid value is an error, never a guess. */
function resolvePort(flag, env) {
  if (flag != null) {
    const port = parsePort(flag);
    return port ? { ok: true, port, source: '--port' } : { ok: false, error: `invalid --port '${flag}' (expected 1-65535)` };
  }
  if (env && env.TELEPTY_PORT) {
    const port = parsePort(env.TELEPTY_PORT);
    return port ? { ok: true, port, source: 'TELEPTY_PORT' } : { ok: false, error: 'invalid TELEPTY_PORT (expected 1-65535)' };
  }
  return { ok: true, port: DEFAULT_PORT, source: 'default' };
}

function teleptyDir(rt) {
  return path.join(rt.homedir, '.telepty');
}

/** → { token:string|null, source:'env'|'config'|null, reason:string|null }. The value is never shown. */
function readToken(rt) {
  if (rt.env && rt.env.TELEPTY_AUTH_TOKEN) return { token: rt.env.TELEPTY_AUTH_TOKEN, source: 'env', reason: null };
  const file = path.join(teleptyDir(rt), 'config.json');
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return { token: null, source: null, reason: 'config-unreadable' };
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { token: null, source: null, reason: error.code === 'ENOENT' ? 'no-config' : 'config-unreadable' };
  }
  let cfg;
  try { cfg = JSON.parse(text); } catch { return { token: null, source: null, reason: 'config-malformed' }; }
  if (cfg && typeof cfg.authToken === 'string' && cfg.authToken) return { token: cfg.authToken, source: 'config', reason: null };
  return { token: null, source: null, reason: 'no-authToken' };
}

/** `clientRestart` gate, read the way telepty reads it (env wins; file read directly). */
function clientRestartMode(rt) {
  let value = rt.env && rt.env.TELEPTY_CLIENT_RESTART;
  if (!value) {
    try {
      const file = path.join(teleptyDir(rt), 'config.json');
      if (fs.statSync(file).size <= MAX_CONFIG_BYTES) value = JSON.parse(fs.readFileSync(file, 'utf8')).clientRestart;
    } catch { /* no or unreadable config → default */ }
  }
  return String(value || '').trim().toLowerCase() === 'off' ? 'off' : 'auto';
}

// ── loopback HTTP ───────────────────────────────────────────────────────────

function classifyError(error) {
  for (let e = error, depth = 0; e && depth < 4; e = e.cause, depth++) {
    if (e.code === 'ECONNREFUSED') return { kind: 'refused' };
  }
  return { kind: 'error', code: (error && error.code) || 'ERROR' };
}

/**
 * GET http://127.0.0.1:<port><path>, bounded by `timeoutMs` and `maxBytes`. Loopback only.
 * @returns {Promise<Probe>}
 */
function httpGetJson(opts) {
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS;
  const maxBytes = opts.maxBytes > 0 ? opts.maxBytes : 1024 * 1024;
  return new Promise((resolve) => {
    let req = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (req) req.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    const headers = { accept: 'application/json' };
    if (opts.token) headers['x-telepty-token'] = opts.token;
    try {
      req = http.request({ host: '127.0.0.1', port: opts.port, path: opts.path, method: 'GET', headers, agent: false }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) finish({ kind: 'malformed', status: res.statusCode, detail: 'response too large' });
          else chunks.push(chunk);
        });
        res.on('error', (error) => finish(classifyError(error)));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode > 299) return finish({ kind: 'answered', status: res.statusCode });
          try {
            finish({ kind: 'ok', status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch {
            finish({ kind: 'malformed', status: res.statusCode, detail: 'not JSON' });
          }
        });
      });
      req.on('error', (error) => finish(classifyError(error)));
      req.end();
    } catch (error) {
      finish(classifyError(error));
    }
  });
}

function probeDetail(p) {
  if (p.kind === 'timeout') return 'no answer before the timeout';
  if (p.kind === 'answered') return `answered HTTP ${p.status}`;
  if (p.kind === 'malformed') return `answered HTTP ${p.status} with ${p.detail}`;
  if (p.kind === 'error') return `connection error ${p.code}`;
  return p.kind;
}

/** → {state:'running',version} | {state:'stopped'} | {state:'unknown',detail}. Only a refused connect is absence. */
async function probeHealth(rt, port, timeoutMs) {
  const p = await rt.http({ port, path: '/api/health', timeoutMs, maxBytes: 64 * 1024 });
  if (p.kind === 'refused') return { state: 'stopped' };
  if (p.kind === 'ok' && p.body && p.body.status === 'ok') {
    return { state: 'running', version: typeof p.body.version === 'string' ? p.body.version : null };
  }
  // An answer that is not telepty's health document: something else may own the port.
  if (p.kind === 'ok') return { state: 'unknown', foreign: true, detail: 'port answered, but not as telepty /api/health' };
  return { state: 'unknown', foreign: p.kind === 'answered', detail: probeDetail(p) };
}

/** → {state:'ok',meta:{version,pid,port}} | {state:'refused',status} | {state:'no-token',reason} | {state:'unknown',detail} */
async function probeMeta(rt, port, timeoutMs) {
  const tok = readToken(rt);
  if (!tok.token) return { state: 'no-token', reason: tok.reason };
  const p = await rt.http({ port, path: '/api/meta', token: tok.token, timeoutMs, maxBytes: 64 * 1024 });
  if (p.kind === 'ok' && p.body && typeof p.body.version === 'string') {
    const pid = Number.isInteger(p.body.pid) ? p.body.pid : null;
    const mport = Number.isInteger(p.body.port) ? p.body.port : null;
    return { state: 'ok', meta: { version: p.body.version, pid, port: mport } };
  }
  if (p.kind === 'answered' && (p.status === 401 || p.status === 403)) return { state: 'refused', status: p.status };
  if (p.kind === 'ok') return { state: 'unknown', detail: '/api/meta answered without a version' };
  return { state: 'unknown', detail: probeDetail(p) };
}

/** → {state:'ok',rows:[{id,type,healthStatus,ownerPid}]} | {state:'refused',status} | {state:'no-token',reason} | {state:'unknown',detail} */
async function listSessions(rt, port, timeoutMs) {
  const tok = readToken(rt);
  if (!tok.token) return { state: 'no-token', reason: tok.reason };
  const p = await rt.http({ port, path: '/api/sessions', token: tok.token, timeoutMs, maxBytes: 8 * 1024 * 1024 });
  if (p.kind === 'ok' && Array.isArray(p.body)) {
    const rows = [];
    for (const r of p.body) {
      if (!r || typeof r !== 'object' || typeof r.id !== 'string') return { state: 'unknown', detail: '/api/sessions row without an id' };
      rows.push({
        id: r.id,
        type: typeof r.type === 'string' ? r.type : 'spawned',
        healthStatus: typeof r.healthStatus === 'string' ? r.healthStatus : null,
        ownerPid: Number.isInteger(r.ownerPid) ? r.ownerPid : null
      });
    }
    return { state: 'ok', rows };
  }
  if (p.kind === 'answered' && (p.status === 401 || p.status === 403)) return { state: 'refused', status: p.status };
  if (p.kind === 'ok') return { state: 'unknown', detail: '/api/sessions did not return a list' };
  return { state: 'unknown', detail: probeDetail(p) };
}

// ── supervisor (detection mirrors telepty src/supervisor.js) ────────────────

/**
 * `<SystemRoot>\System32\schtasks.exe`, with SystemRoot validated as a drive-absolute path.
 * → {file} | {error} (actionable; never a cwd/PATH search).
 */
function schtasksPath(rt) {
  const env = rt.env || {};
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'SYSTEMROOT');
  const root = key ? String(env[key]) : '';
  if (!/^[A-Za-z]:\\[^\0"<>|?*]*$/.test(root.replace(/\//g, '\\')) || root.split(/[\\/]/).includes('..')) {
    return { error: 'SystemRoot is unset or not a drive-absolute path (for example C:\\Windows), so schtasks.exe cannot be located safely. Set SystemRoot and retry.' };
  }
  return { file: path.win32.join(root, 'System32', 'schtasks.exe') };
}

/**
 * → {present:true,kind,detail,unitFile} | {present:false,kind:null,detail} | {present:null,kind:null,detail} (unknown).
 * `unitFile` is the only path ever read for the served port; it is set only from the fixed
 * descriptor locations below. `detail` is human text and is never used as a path.
 * `allowExec` permits the one probe that needs a process (win32 `schtasks /query`); read-only
 * callers (status/doctor) pass false and get "unknown" on win32.
 */
function detectSupervisor(rt, options = {}) {
  const env = rt.env || {};
  if (env.TELEPTY_NO_SUPERVISOR_DEFER === '1') return { present: false, kind: null, detail: 'disabled-by-env' };
  if (rt.platform === 'darwin') {
    const plist = path.join(rt.homedir, 'Library', 'LaunchAgents', LAUNCHD_PLIST_NAME);
    return fs.existsSync(plist) ? { present: true, kind: 'launchd', detail: plist, unitFile: plist } : { present: false, kind: null, detail: null };
  }
  if (rt.platform === 'win32') {
    if (!options.allowExec) return { present: null, kind: null, detail: 'schtasks is not queried by read-only commands' };
    const tool = schtasksPath(rt);
    if (tool.error) return { present: null, kind: null, detail: tool.error };
    let r;
    try {
      r = rt.spawnSync(tool.file, ['/query', '/tn', WINDOWS_TASK_NAME, '/fo', 'LIST'], {
        stdio: ['ignore', 'ignore', 'ignore'], timeout: 10000, shell: false, windowsHide: true
      });
    } catch (error) {
      return { present: null, kind: null, detail: `schtasks query failed: ${error.code || 'ERROR'}` };
    }
    if (r.error && r.error.code === 'ENOENT') return { present: null, kind: null, detail: `schtasks.exe not found at ${tool.file}; check SystemRoot` };
    if (r.error) return { present: null, kind: null, detail: `schtasks query failed: ${r.error.code || 'ERROR'}` };
    return r.status === 0 ? { present: true, kind: 'schtasks', detail: WINDOWS_TASK_NAME } : { present: false, kind: null, detail: null };
  }
  if (fs.existsSync(SYSTEMD_UNIT_PATH)) return { present: true, kind: 'systemd', detail: SYSTEMD_UNIT_PATH, unitFile: SYSTEMD_UNIT_PATH };
  const userUnit = path.join(rt.homedir, '.config', 'systemd', 'user', SYSTEMD_USER_UNIT_NAME);
  return fs.existsSync(userUnit) ? { present: true, kind: 'systemd-user', detail: userUnit, unitFile: userUnit } : { present: false, kind: null, detail: null };
}

/** Value of environment `key` in the plist, or the last systemd `Environment=` assignment of it; else undefined. */
function descriptorValue(kind, text, key) {
  if (kind === 'launchd') {
    const m = text.match(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`));
    return m ? m[1].trim() : undefined;
  }
  let value;
  const re = new RegExp(`^\\s*Environment\\s*=(?:.*?[\\s"])?${key}=([^"\\s]*)`, 'gm');
  for (let m = re.exec(text); m; m = re.exec(text)) value = m[1];
  return value;
}

/**
 * Port the supervised daemon binds, read from its descriptor exactly as telepty's daemon picks
 * it (`TELEPTY_PORT || PORT || 3848`, src/bind-port.js; install.js writes both keys).
 * → {port} | {unknown:reason}. An unreadable descriptor or an invalid value is unknown, never 3848.
 */
function supervisedPort(sup) {
  if (!sup || sup.present !== true || !sup.unitFile || sup.kind === 'schtasks') return { unknown: 'no readable service descriptor' };
  let text;
  try {
    const st = fs.statSync(sup.unitFile);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return { unknown: 'service descriptor is not a small regular file' };
    text = fs.readFileSync(sup.unitFile, 'utf8');
  } catch {
    return { unknown: 'service descriptor is unreadable' };
  }
  const raw = descriptorValue(sup.kind, text, 'TELEPTY_PORT') || descriptorValue(sup.kind, text, 'PORT');
  if (!raw) return { port: DEFAULT_PORT };
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return port >= 1 && port <= 65535 ? { port } : { unknown: 'service descriptor names an invalid port' };
}

/** telepty #902: the supervisor counts only when its job serves the addressed port. */
function supervisorFor(sup, addressedPort) {
  if (!sup || sup.present !== true) return sup;
  if (sup.kind === 'schtasks') return { ...sup, servedPort: DEFAULT_PORT }; // telepty's own fallback: the task names no port
  const served = supervisedPort(sup);
  if (served.unknown) {
    return { present: null, kind: null, detail: `${sup.kind} is installed, but the port it serves is unknown (${served.unknown})`, otherKind: sup.kind };
  }
  if (served.port === addressedPort) return { ...sup, servedPort: served.port };
  return { present: false, kind: null, detail: `${sup.kind} serves port ${served.port}, not ${addressedPort}`, otherKind: sup.kind, servedPort: served.port };
}

function uidOf(rt) {
  return typeof rt.getuid === 'function' ? rt.getuid() : null;
}

/**
 * argv for a supervisor action, or {owner:argvText} when it needs privileges this CLI does not take.
 * argv[0] is the tool NAME (for display); `runTool` maps it to a fixed absolute path.
 */
function supervisorAction(rt, kind, verb) {
  if (kind === 'launchd') {
    const uid = uidOf(rt);
    if (!Number.isInteger(uid) || uid < 0) return { error: 'cannot resolve uid for launchctl' };
    const target = `gui/${uid}/${LAUNCHD_LABEL}`;
    return { argv: verb === 'restart' ? ['launchctl', 'kickstart', '-k', target] : ['launchctl', 'kickstart', target] };
  }
  if (kind === 'systemd-user') return { argv: ['systemctl', '--user', verb === 'restart' ? 'restart' : 'start', SYSTEMD_SERVICE_NAME] };
  if (kind === 'systemd') return { owner: `sudo systemctl ${verb === 'restart' ? 'restart' : 'start'} ${SYSTEMD_SERVICE_NAME}` };
  if (kind === 'schtasks') return { argv: ['schtasks', '/run', '/tn', WINDOWS_TASK_NAME] };
  return { error: `unsupported supervisor kind: ${kind}` };
}

// ── restart lease and attribution log (telepty gh#82 file protocol) ─────────

function leasePath(rt) {
  return path.join(teleptyDir(rt), 'restart.lease');
}

function restartLogPath(rt) {
  return path.join(teleptyDir(rt), 'logs', 'daemon-restart.log');
}

/** One `[ISO] k=v …` line, telepty's format. Best effort. */
function logRestartEvent(rt, fields) {
  try {
    const file = restartLogPath(rt);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = Object.entries(fields).map(([k, v]) => `${k}=${v == null ? 'none' : v}`).join(' ');
    fs.appendFileSync(file, `[${new Date(rt.now()).toISOString()}] ${body}\n`);
  } catch { /* a missing log never breaks a restart (telepty's rule) */ }
}

function logStopInitiated(rt, port) {
  logRestartEvent(rt, {
    event: 'stop-initiated',
    initiator_pid: rt.pid,
    initiator_ppid: rt.ppid,
    initiator_argv: JSON.stringify((rt.argv || []).slice(2).join(' ').slice(0, 200)),
    verdict: RESTART_VERDICT,
    port,
    session: (rt.env && rt.env.TELEPTY_SESSION_ID) || null
  });
}

/**
 * A lease younger than the TTL is held. telepty also treats a lease whose holder pid is dead
 * as free; that needs a pid probe this CLI does not make, so a young lease is always "held"
 * (unknown is not absent) and simply expires after 60 s. Its age comes from an ISO `startedAt`
 * (telepty's format), else a numeric epoch-ms `startedAt`, else the file's mtime; a lease whose
 * age cannot be judged at all is held, never silently expired.
 */
function isLeaseFresh(lease, nowMs, mtimeMs) {
  const s = lease && lease.startedAt;
  let started = typeof s === 'string' ? Date.parse(s) : NaN;
  if (!Number.isFinite(started) && typeof s === 'number' && Number.isFinite(s)) started = s;
  if (!Number.isFinite(started)) started = Number.isFinite(mtimeMs) ? mtimeMs : NaN;
  if (!Number.isFinite(started)) return true;
  return nowMs - started < RESTART_LEASE_TTL_MS;
}

/**
 * Bounded read of the lease: a regular file of at most 64 KiB, opened without following a
 * symlink or blocking on a FIFO. Anything else throws (code ELEASEINVALID), i.e. state unknown.
 */
function readLeaseRaw(file) {
  const c = fs.constants;
  const fd = fs.openSync(file, c.O_RDONLY | (c.O_NOFOLLOW || 0) | (c.O_NONBLOCK || 0));
  try {
    const st = fs.fstatSync(fd);
    const invalid = !st.isFile() || st.size > MAX_LEASE_BYTES;
    const buf = Buffer.alloc(MAX_LEASE_BYTES + 1);
    let n = 0;
    while (!invalid && n < buf.length) {
      const r = fs.readSync(fd, buf, n, buf.length - n, null);
      if (r <= 0) break;
      n += r;
    }
    if (invalid || n > MAX_LEASE_BYTES) {
      throw Object.assign(new Error('restart.lease is not a regular file of at most 64 KiB'), { code: 'ELEASEINVALID' });
    }
    return { raw: buf.toString('utf8', 0, n), mtimeMs: st.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

function readLease(file) {
  const { raw, mtimeMs } = readLeaseRaw(file);
  try {
    const lease = JSON.parse(raw);
    return { raw, mtimeMs, lease: lease && typeof lease === 'object' ? lease : { pid: null, startedAt: null } };
  } catch {
    return { raw, mtimeMs, lease: { pid: null, startedAt: new Date(mtimeMs).toISOString(), partial: true } };
  }
}

/**
 * → {held:true,body,startedMs} | {held:false,holder}. Throws on I/O errors other than contention
 * (the caller treats a throw as "lease state unknown" and does not restart).
 */
function acquireLease(rt, fields) {
  const file = leasePath(rt);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let tries = 0; tries < 3; tries++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let current;
      try {
        current = readLease(file);
      } catch (readError) {
        if (readError.code === 'ENOENT') continue;
        throw readError;
      }
      if (isLeaseFresh(current.lease, rt.now(), current.mtimeMs)) return { held: false, holder: current.lease };
      // Expired: replace it, but only the exact lease we judged (never one written since).
      try {
        if (readLeaseRaw(file).raw === current.raw) fs.unlinkSync(file);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      }
      continue;
    }
    const startedMs = rt.now();
    const body = JSON.stringify({ ...fields, startedAt: new Date(startedMs).toISOString() });
    let writeError = null;
    try { fs.writeSync(fd, body); } catch (error) { writeError = error; }
    fs.closeSync(fd);
    if (writeError) {
      try { fs.unlinkSync(file); } catch { /* best effort */ }
      throw writeError;
    }
    return { held: true, body, startedMs };
  }
  return { held: false, holder: { pid: null } };
}

/**
 * Remove the lease only if it is still ours. → true when no lease of ours remains (removed,
 * already gone, or replaced by another client); false when ours could not be removed.
 */
function releaseLease(rt, body) {
  const file = leasePath(rt);
  try {
    if (readLeaseRaw(file).raw !== body) return true;
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

/** pid recorded in ~/.telepty/daemon-state.json for exactly this port, else null. Diagnostic only. */
function stateFilePid(rt, port) {
  try {
    const file = path.join(teleptyDir(rt), 'daemon-state.json');
    if (fs.statSync(file).size > MAX_CONFIG_BYTES) return null;
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!s || !Number.isInteger(s.pid) || s.pid <= 0) return null;
    if (s.port !== port) return null;
    return s.pid;
  } catch {
    return null;
  }
}

// ── lifecycle ───────────────────────────────────────────────────────────────

function childEnv(rt, port) {
  const env = { ...rt.env, TELEPTY_PORT: String(port) };
  delete env.TELEPTY_HOST; // lifecycle is local: the child must address 127.0.0.1:<port> only
  return env;
}

/** Run one argv (no shell) with output shown to the user. → {ok, status, detail} */
function runChild(rt, file, args, env, timeoutMs = CHILD_TIMEOUT_MS) {
  let r;
  try {
    r = rt.spawnSync(file, args, {
      stdio: ['ignore', 'inherit', 'inherit'], env, shell: false, timeout: timeoutMs, windowsHide: true
    });
  } catch (error) {
    return { ok: false, status: null, detail: error.code || error.message };
  }
  if (r.error) return { ok: false, status: null, detail: r.error.code || r.error.message };
  if (r.status !== 0) return { ok: false, status: r.status, detail: r.signal ? `ended by ${r.signal}` : `exit ${r.status}` };
  return { ok: true, status: 0, detail: null };
}

function runTeleptyCli(rt, teleptyBin, args, port, timeoutMs) {
  return runChild(rt, rt.execPath, [teleptyBin.file, ...args], childEnv(rt, port), timeoutMs);
}

/** Run a supervisor argv: argv[0] (a tool name) is run only from its fixed absolute location(s). */
function runTool(rt, argv, env, timeoutMs) {
  let files;
  if (argv[0] === 'schtasks') {
    const tool = schtasksPath(rt);
    if (tool.error) return { ok: false, status: null, detail: tool.error };
    files = [tool.file];
  } else {
    files = POSIX_TOOLS[argv[0]];
    if (!files) return { ok: false, status: null, detail: `unknown system tool ${argv[0]}` };
  }
  for (const file of files) {
    const r = runChild(rt, file, argv.slice(1), env, timeoutMs);
    if (r.detail !== 'ENOENT') return r;
  }
  return { ok: false, status: null, detail: `${argv[0]} was not found at ${files.join(' or ')}; install it there or run the command yourself` };
}

async function waitForHealth(rt, port, maxMs) {
  const deadline = rt.now() + maxMs;
  let last = null;
  while (rt.now() < deadline) {
    last = await probeHealth(rt, port, DEFAULT_PROBE_TIMEOUT_MS);
    if (last.state === 'running') return last;
    await rt.sleep(POLL_MS);
  }
  return last;
}

function notInstalled(rt, resolved) {
  rt.err(`${resolved.code}: ${resolved.detail}\n  Install: npm i -g @dmsdc-ai/aigentry  (or npm i -g @dmsdc-ai/aigentry-telepty)\n`);
  return resolved.code === 'NOT_INSTALLED' ? EXIT.NOT_INSTALLED : EXIT.FAILED;
}

/**
 * `aigentry start telepty`.
 * @param {object} rt runtime
 * @param {{port:number, resolveTelepty:function():object}} opts
 * @returns {Promise<number>} exit code
 */
async function start(rt, opts) {
  const port = opts.port;
  const health = await probeHealth(rt, port, DEFAULT_PROBE_TIMEOUT_MS);
  if (health.state === 'running') {
    rt.out(`telepty daemon already running${health.version ? ` (v${health.version})` : ''} on 127.0.0.1:${port}\n`);
    return EXIT.OK;
  }
  if (health.state !== 'stopped') {
    rt.err(`telepty: something holds 127.0.0.1:${port} but it is not answering as a healthy telepty daemon (${health.detail}).\n`
      + '  Not starting a second daemon. Run: aigentry doctor\n');
    return EXIT.FAILED;
  }
  return startStopped(rt, opts);
}

/** Start path once /api/health was refused on the addressed port. */
async function startStopped(rt, opts) {
  const port = opts.port;
  const sup = supervisorFor(detectSupervisor(rt, { allowExec: true }), port);
  if (sup.present === null) {
    rt.err(`telepty: could not tell whether a service supervisor owns the daemon (${sup.detail}). Not starting one.\n`);
    return EXIT.FAILED;
  }
  if (sup.present) {
    const action = supervisorAction(rt, sup.kind, 'start');
    if (action.owner) {
      rt.err(`telepty is installed as a system service (${sup.kind}). Starting it needs administrator rights; run:\n  ${action.owner}\n`);
      return EXIT.OWNER_ACTION;
    }
    if (action.error) {
      rt.err(`telepty: ${action.error}\n`);
      return EXIT.FAILED;
    }
    rt.out(`telepty daemon is managed by ${sup.kind}; asking it to start: ${action.argv.join(' ')}\n`);
    const r = runTool(rt, action.argv, rt.env);
    if (!r.ok) {
      const hint = sup.kind === 'launchd' ? `\n  If the job is not loaded: launchctl bootstrap gui/${uidOf(rt)} ${sup.unitFile}` : '';
      rt.err(`telepty: ${action.argv.join(' ')} failed (${r.detail}).${hint}\n`);
      return EXIT.FAILED;
    }
  } else {
    const resolved = opts.resolveTelepty();
    if (!resolved.ok) return notInstalled(rt, resolved);
    const r = runTeleptyCli(rt, resolved.bin, ['daemon', 'start'], port);
    if (!r.ok) {
      rt.err(`telepty: 'telepty daemon start' failed (${r.detail}).\n`);
      return EXIT.FAILED;
    }
  }
  const after = await waitForHealth(rt, port, START_WAIT_MS);
  if (after && after.state === 'running') {
    rt.out(`telepty daemon running${after.version ? ` (v${after.version})` : ''} on 127.0.0.1:${port}\n`);
    return EXIT.OK;
  }
  rt.err(`telepty: start was issued, but 127.0.0.1:${port}/api/health did not answer within ${START_WAIT_MS / 1000}s`
    + `${after && after.detail ? ` (${after.detail})` : ''}. State unknown; check: aigentry doctor\n`);
  return EXIT.FAILED;
}

/**
 * Daemon identity for a replacement check: the pid from authenticated `/api/meta` of the daemon
 * bound to exactly the addressed port. Nothing else (daemon-state.json included) can prove a
 * replacement. → {pid} | {pid:null, reason}
 */
async function daemonIdentity(rt, port, timeoutMs) {
  const meta = await probeMeta(rt, port, timeoutMs);
  if (meta.state !== 'ok') return { pid: null, reason: meta.state === 'no-token' ? `no token (${meta.reason})` : meta.state === 'refused' ? `token refused (HTTP ${meta.status})` : meta.detail };
  if (!meta.meta.pid) return { pid: null, reason: '/api/meta reported no pid' };
  if (meta.meta.port !== port) return { pid: null, reason: `/api/meta reports port ${meta.meta.port}, not ${port}` };
  return { pid: meta.meta.pid };
}

async function confirmSessionLoss(rt, opts, sessions) {
  const port = opts.port;
  if (sessions.state === 'ok') {
    const lost = sessions.rows.filter((r) => r.type !== 'wrapped');
    if (lost.length) {
      rt.err(`Restarting the telepty daemon on port ${port} ENDS these ${lost.length} session(s):\n`);
      for (const r of lost) rt.err(`  - ${r.id} (${r.type})\n`);
    } else {
      rt.err(`No spawned sessions on port ${port}; wrapped sessions (${sessions.rows.length}) reconnect after the restart.\n`);
    }
  } else {
    rt.err(`Could not list sessions on port ${port} (${sessions.detail || sessions.reason || `HTTP ${sessions.status}`}).\n`
      + '  Any spawned session on this daemon will END with the restart.\n');
  }
  if (opts.yes) return true;
  if (!(rt.stdinIsTTY && rt.stderrIsTTY)) {
    rt.err('Refusing to restart without confirmation: re-run with --yes, or from an interactive terminal.\n');
    return false;
  }
  const answer = await rt.prompt(`Restart telepty daemon on port ${port}? [y/N] `);
  return /^y(es)?$/i.test(String(answer || '').trim());
}

/**
 * `aigentry restart telepty`.
 * @param {object} rt runtime
 * @param {{port:number, yes:boolean, resolveTelepty:function():object}} opts
 * @returns {Promise<number>} exit code
 */
async function restart(rt, opts) {
  const port = opts.port;
  const health = await probeHealth(rt, port, DEFAULT_PROBE_TIMEOUT_MS);
  if (health.state === 'stopped') {
    rt.out(`telepty daemon is not running on 127.0.0.1:${port}; starting it.\n`);
    return startStopped(rt, opts);
  }
  if (health.state !== 'running') {
    // Unknown is neither absent nor permission: a timeout, a malformed answer or a foreign server.
    rt.err(`telepty: 127.0.0.1:${port} is not answering as a healthy telepty daemon (${health.detail}); its state is unknown. Not restarting.\n`
      + '  Run: aigentry doctor\n');
    return EXIT.FAILED;
  }
  const sup = supervisorFor(detectSupervisor(rt, { allowExec: true }), port);
  if (sup.present === null) {
    rt.err(`telepty: could not tell whether a service supervisor owns the daemon (${sup.detail}). Not restarting.\n`);
    return EXIT.FAILED;
  }
  let action = null;
  if (sup.present) {
    action = supervisorAction(rt, sup.kind, 'restart');
    if (action.owner) {
      rt.err(`telepty is installed as a system service (${sup.kind}). Restarting it needs administrator rights; run:\n  ${action.owner}\n`);
      return EXIT.OWNER_ACTION;
    }
    if (action.error) {
      rt.err(`telepty: ${action.error}\n`);
      return EXIT.FAILED;
    }
  }
  let teleptyBin = null;
  if (!sup.present || sup.kind === 'schtasks') {
    const resolved = opts.resolveTelepty();
    if (!resolved.ok) return notInstalled(rt, resolved);
    teleptyBin = resolved.bin;
  }

  const sessions = await listSessions(rt, port, DEFAULT_PROBE_TIMEOUT_MS);
  if (!(await confirmSessionLoss(rt, opts, sessions))) {
    rt.err('telepty restart not confirmed; nothing was changed.\n');
    return EXIT.REFUSED;
  }

  let lease;
  try {
    lease = acquireLease(rt, { pid: rt.pid, ppid: rt.ppid, port, verdict: RESTART_VERDICT });
  } catch (error) {
    // Fail closed: an unreadable/unwritable lease cannot exclude a fresh foreign one.
    logRestartEvent(rt, { event: 'lease-unavailable', port, verdict: RESTART_VERDICT, reason: error.code || 'ERROR' });
    rt.err(`telepty: restart lease state unknown (${error.code || 'ERROR'} on ${leasePath(rt)}); not restarting.\n`);
    return EXIT.FAILED;
  }
  if (!lease.held) {
    rt.err(`telepty: another client (pid ${lease.holder.pid || 'unknown'}) holds the restart lease for this host; not restarting. Retry in a minute.\n`);
    return EXIT.FAILED;
  }
  // One deadline for every child and the confirmation, strictly inside the lease TTL.
  const deadline = lease.startedMs + RESTART_LEASE_TTL_MS - RESTART_LEASE_MARGIN_MS;
  let code = EXIT.FAILED;
  let released = false;
  try {
    code = await restartUnderLease(rt, { port, sup, action, teleptyBin, deadline });
  } finally {
    released = releaseLease(rt, lease.body);
  }
  if (!released) {
    rt.err(`telepty: could not remove this restart's lease ${leasePath(rt)}; other restarts are blocked until it expires (60 s). Reporting failure.\n`);
    return EXIT.FAILED;
  }
  return code;
}

async function restartUnderLease(rt, o) {
  const { port, sup, action, teleptyBin, deadline } = o;
  const left = () => deadline - rt.now();
  const before = await daemonIdentity(rt, port, Math.max(1, Math.min(DEFAULT_PROBE_TIMEOUT_MS, left())));
  logStopInitiated(rt, port);
  let r;
  if (!sup.present) {
    r = runTeleptyCli(rt, teleptyBin, ['daemon', 'restart'], port, Math.max(1, left()));
  } else if (sup.kind === 'schtasks') {
    // The scheduled task only starts at logon; it does not stop a running daemon. telepty's
    // own surgical stop (state-file pid + confirmed port owner) runs first, as in telepty.
    r = runTeleptyCli(rt, teleptyBin, ['daemon', 'stop'], port, Math.max(1, left()));
    if (r.ok) r = left() > 0 ? runTool(rt, action.argv, rt.env, left()) : { ok: false, detail: 'ETIMEDOUT' };
  } else {
    rt.out(`telepty daemon is managed by ${sup.kind}; restarting it: ${action.argv.join(' ')}\n`);
    r = runTool(rt, action.argv, rt.env, Math.max(1, left()));
  }
  if (!r.ok && r.detail === 'ETIMEDOUT') {
    rt.err(`telepty: the restart command did not finish before the restart lease deadline: restart UNCONFIRMED. Daemon state unknown; check: aigentry doctor\n`);
    return EXIT.FAILED;
  }
  if (!r.ok) {
    rt.err(`telepty: restart command failed (${r.detail}). Daemon state unknown; check: aigentry doctor\n`);
    return EXIT.FAILED;
  }
  return confirmReplacement(rt, port, before, deadline);
}

/** Success only when authenticated same-port `/api/meta` shows a different pid than before. */
async function confirmReplacement(rt, port, before, leaseDeadline) {
  const deadline = Math.min(rt.now() + RESTART_WAIT_MS, leaseDeadline);
  const probeMs = () => Math.min(DEFAULT_PROBE_TIMEOUT_MS, deadline - rt.now());
  let healthy = null;
  let reason = null;
  while (probeMs() >= 1) {
    const h = await probeHealth(rt, port, probeMs());
    if (h.state === 'running') {
      healthy = h;
      if (!before.pid) break; // nothing to compare against: report below, do not wait it out
      if (probeMs() < 1) break;
      const now = await daemonIdentity(rt, port, probeMs());
      if (now.pid && now.pid !== before.pid) {
        rt.out(`telepty daemon restarted${h.version ? ` (v${h.version})` : ''} on 127.0.0.1:${port}: pid ${before.pid} → ${now.pid} (/api/meta)\n`);
        return EXIT.OK;
      }
      reason = now.pid ? null : now.reason;
    }
    await rt.sleep(POLL_MS);
  }
  const statePid = stateFilePid(rt, port);
  const diag = statePid ? ` (daemon-state.json names pid ${statePid}; diagnostic only, not proof)` : '';
  if (healthy && !before.pid) {
    rt.err(`telepty daemon answers on 127.0.0.1:${port}, but the replacement is UNCONFIRMED: the previous daemon's pid could not be read from authenticated /api/meta (${before.reason})${diag}.\n`);
  } else if (healthy) {
    rt.err(`telepty daemon answers on 127.0.0.1:${port}, but a new pid was not confirmed by /api/meta (was ${before.pid}${reason ? `; now: ${reason}` : ''}) before the deadline: restart UNCONFIRMED${diag}.\n`);
  } else {
    rt.err(`telepty: restart issued, but 127.0.0.1:${port} did not answer /api/health before the deadline. State unknown; check: aigentry doctor\n`);
  }
  return EXIT.FAILED;
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_PROBE_TIMEOUT_MS,
  LAUNCHD_LABEL,
  RESTART_LEASE_MARGIN_MS,
  RESTART_LEASE_TTL_MS,
  RESTART_VERDICT,
  WINDOWS_TASK_NAME,
  acquireLease,
  clientRestartMode,
  detectSupervisor,
  httpGetJson,
  isLeaseFresh,
  leasePath,
  listSessions,
  logRestartEvent,
  probeHealth,
  probeMeta,
  readToken,
  releaseLease,
  resolvePort,
  restart,
  restartLogPath,
  schtasksPath,
  start,
  stateFilePid,
  supervisorAction,
  supervisorFor,
  supervisedPort
};
