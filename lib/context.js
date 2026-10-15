'use strict';

// Advisory agent-context check (DECISIONS R5). It refuses `restart telepty` and
// `start/restart orchestrator` when this CLI looks like it runs inside an agent session,
// so an agent cannot casually restart the session it lives in. It is NOT a security
// boundary: `aigentry telepty daemon restart` and a direct `bash bin/orchestrator-boot.sh`
// stay available, and the real guards stay where they are (boot TTY/YES and self/ancestor
// rule, the telepty token, worker sandboxing).
//
// The only process inspection here is one bounded, read-only `ps` snapshot, run from a fixed
// absolute path (never looked up through the cwd or PATH). No pid is ever signalled, not even
// with signal 0. Known limit (advisory false negative only): `ps` text is split on whitespace,
// so a bridge whose path contains spaces is not recognised.

const path = require('path');

const PS_FILES = ['/bin/ps', '/usr/bin/ps'];
const PS_TIMEOUT_MS = 3000;
const PS_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * @typedef {{pid:number, ppid:number, argv:string[]}} PsRow
 * @typedef {{ok:true, rows:PsRow[]}|{ok:false, reason:string}} PsSnapshot
 */

/** Parse `ps -eo pid,ppid,command` output; non-numeric rows (the header) are dropped. */
function parsePs(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 2 || !/^\d+$/.test(f[0]) || !/^\d+$/.test(f[1])) continue;
    rows.push({ pid: Number(f[0]), ppid: Number(f[1]), argv: f.slice(2) });
  }
  return rows;
}

/** One bounded read-only process snapshot. POSIX only; win32 → unavailable. @returns {PsSnapshot} */
function processSnapshot(rt) {
  if (rt.platform === 'win32') return { ok: false, reason: 'process snapshot not implemented on win32' };
  let r;
  for (const file of PS_FILES) {
    try {
      r = rt.spawnSync(file, ['-eo', 'pid,ppid,command'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER, shell: false
      });
    } catch (error) {
      return { ok: false, reason: `ps failed: ${error.code || error.message}` };
    }
    if (!(r && r.error && r.error.code === 'ENOENT')) break;
  }
  if (!r || r.error || r.status !== 0) {
    return { ok: false, reason: `ps failed: ${r && r.error ? r.error.code || r.error.message : `exit ${r && r.status}`}` };
  }
  const rows = parsePs(r.stdout);
  return rows.length ? { ok: true, rows } : { ok: false, reason: 'ps listed no processes' };
}

/**
 * `[node] …/telepty allow …` — the measured bridge argv shape (orchestrator boot D4).
 * With `sid`, `--id <sid>` must also appear as whole tokens.
 */
function isTeleptyAllowArgv(argv, sid) {
  if (!Array.isArray(argv) || !argv.length) return false;
  let i = 0;
  if (/^node(\d+)?(\.exe)?$/i.test(path.basename(argv[0]))) i = 1;
  const exe = String(argv[i] || '');
  const isTelepty = /^telepty(\.js)?$/i.test(path.basename(exe)) || /aigentry-telepty[\\/]cli\.js$/i.test(exe);
  if (!isTelepty || argv[i + 1] !== 'allow') return false;
  if (sid == null) return true;
  for (let j = i + 2; j < argv.length - 1; j++) {
    if (argv[j] === '--id' && argv[j + 1] === sid) return true;
  }
  return false;
}

/** Ancestors of `pid` (nearest first), bounded by the snapshot and a depth cap. */
function ancestorsOf(pid, rows) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const out = [];
  const seen = new Set();
  let cur = byPid.get(pid);
  for (let depth = 0; cur && depth < 64; depth++) {
    if (seen.has(cur.ppid) || cur.ppid <= 0) break;
    seen.add(cur.ppid);
    const parent = byPid.get(cur.ppid);
    if (!parent) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

/**
 * → { agent:boolean, reasons:string[], ancestors:'checked'|'unavailable', note:string|null }
 * `agent` is true when an env marker is set or an ancestor is a telepty bridge.
 */
function detectAgentContext(rt, options = {}) {
  const env = rt.env || {};
  const reasons = [];
  if (env.AIGENTRY_WORKER_SESSION) reasons.push('AIGENTRY_WORKER_SESSION is set');
  if (env.TELEPTY_SESSION_ID) reasons.push('TELEPTY_SESSION_ID is set');
  if (options.envOnly) return { agent: reasons.length > 0, reasons, ancestors: 'unavailable', note: 'env markers only' };
  const snap = processSnapshot(rt);
  if (!snap.ok) {
    return { agent: reasons.length > 0, reasons, ancestors: 'unavailable', note: snap.reason };
  }
  for (const a of ancestorsOf(rt.pid, snap.rows)) {
    if (isTeleptyAllowArgv(a.argv)) {
      reasons.push(`ancestor pid ${a.pid} is a telepty bridge (telepty allow)`);
      break;
    }
  }
  return { agent: reasons.length > 0, reasons, ancestors: 'checked', note: null };
}

module.exports = {
  ancestorsOf,
  detectAgentContext,
  isTeleptyAllowArgv,
  parsePs,
  processSnapshot
};
