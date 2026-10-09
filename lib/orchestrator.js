'use strict';

// Orchestrator lifecycle (DECISIONS R1/R2, controller overrides).
//
// `start`/`restart orchestrator` run the control workspace's UNCHANGED boot helper
// (`<ws>/bin/orchestrator-boot.sh`, empty argv) as an attached foreground child of this
// process, with the human's terminal inherited, so the boot's own wizard, typed YES,
// self/ancestor-safe replacement of the old bridge and automatic handoff all run as designed.
// This process never signals anything: while the boot runs it registers no-op handlers for
// SIGINT/SIGQUIT only (the child gets those from the terminal itself), leaves SIGTERM/SIGHUP at
// their defaults, and forwards no signal — a SIGTERM to the bridge cascades a session DELETE.
// It then exits with the child's status.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { EXIT, getComponent } = require('./registry');
const { detectAgentContext, isTeleptyAllowArgv, processSnapshot } = require('./context');
const { findOnPath, resolveBin } = require('./resolve');
const telepty = require('./telepty');

const ORCHESTRATOR_PKG = '@dmsdc-ai/aigentry-orchestrator';
const BOOT_REL = path.join('bin', 'orchestrator-boot.sh');
const LIVE_HEALTH = new Set(['CONNECTED', 'UPSTREAM_STALLED']);
const IGNORED_SIGNALS = ['SIGINT', 'SIGQUIT'];

function sidOf(rt) {
  return (rt.env && rt.env.ORCHESTRATOR_SID) || 'orchestrator';
}

/**
 * --workspace PATH, else AIGENTRY_CONTROL_WORKSPACE (the variable `aigentry-orchestrator init`
 * reads), else the documented default ~/aigentry/_orchestrator. Never the current directory.
 */
function resolveWorkspace(rt, flag) {
  let raw = flag;
  let source = '--workspace';
  if (raw == null || raw === '') {
    raw = rt.env && rt.env.AIGENTRY_CONTROL_WORKSPACE;
    source = 'AIGENTRY_CONTROL_WORKSPACE';
  }
  if (raw == null || raw === '') {
    raw = path.join(rt.homedir, 'aigentry', '_orchestrator');
    source = 'default';
  }
  raw = String(raw).replace(/^~(?=$|[\\/])/, rt.homedir);
  const ws = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(rt.cwd, raw);
  const fail = (state, detail) => ({ ok: false, state, path: ws, source, detail });

  let st;
  try {
    st = fs.statSync(ws);
  } catch {
    // The default not existing just means "not initialised"; a named one missing is an error.
    return fail(source === 'default' ? 'unavailable' : 'broken', `${ws} does not exist`);
  }
  if (!st.isDirectory()) return fail('broken', `${ws} is not a directory`);
  const boot = path.join(ws, BOOT_REL);
  try {
    if (!fs.statSync(boot).isFile()) return fail('broken', `${boot} is not a regular file`);
  } catch {
    return fail('broken', `${boot} is missing`);
  }
  if (!isControlWorkspace(ws)) {
    return fail('broken', `${ws} has no valid .aigentry-init.json and is not an aigentry-orchestrator checkout`);
  }
  return { ok: true, path: ws, source, bootScript: boot };
}

function readJsonObject(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 1024 * 1024) return null;
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function isControlWorkspace(ws) {
  if (readJsonObject(path.join(ws, '.aigentry-init.json'))) return true;
  const pkg = readJsonObject(path.join(ws, 'package.json'));
  return Boolean(pkg && pkg.name === ORCHESTRATOR_PKG);
}

/**
 * Is an orchestrator bridge for `sid` live? From the authenticated session listing, and —
 * only when `allowSnapshot` — one bounded `ps` snapshot. Anything not measured is `unknown`.
 * `opts.health` reuses a health probe the caller already made.
 * → { state:'running'|'not-running'|'unknown', detail }
 */
async function liveState(rt, opts) {
  const sid = opts.sid || sidOf(rt);
  const health = opts.health || await telepty.probeHealth(rt, opts.port, opts.timeoutMs);
  if (health.state === 'stopped') {
    return { state: 'unknown', detail: `telepty daemon is not running on port ${opts.port}, so the session registry cannot be read` };
  }
  if (health.state !== 'running') return { state: 'unknown', detail: `telepty daemon state unknown (${health.detail})` };
  const list = await telepty.listSessions(rt, opts.port, opts.timeoutMs);
  if (list.state === 'no-token') return { state: 'unknown', detail: `no telepty token (${list.reason})` };
  if (list.state === 'refused') return { state: 'unknown', detail: `telepty refused the session listing (HTTP ${list.status})` };
  if (list.state !== 'ok') return { state: 'unknown', detail: `session listing unreadable (${list.detail})` };

  const row = list.rows.find((r) => r.id === sid);
  if (row && row.type === 'wrapped' && LIVE_HEALTH.has(row.healthStatus)) {
    return { state: 'running', detail: `session '${sid}' is ${row.healthStatus}` };
  }
  if (row && row.type !== 'wrapped') {
    return { state: 'unknown', detail: `session '${sid}' exists but is a ${row.type} session, not an orchestrator bridge` };
  }
  if (!opts.allowSnapshot) {
    return row
      ? { state: 'unknown', detail: `session '${sid}' is ${row.healthStatus || 'in an unreported state'}` }
      : { state: 'not-running', detail: `no session '${sid}' registered` };
  }
  const snap = processSnapshot(rt);
  if (!snap.ok) return { state: 'unknown', detail: `session '${sid}' ${row ? `is ${row.healthStatus}` : 'is not registered'}; process snapshot unavailable (${snap.reason})` };
  const bridge = snap.rows.find((r) => isTeleptyAllowArgv(r.argv, sid));
  if (bridge) return { state: 'running', detail: `bridge process pid ${bridge.pid} for '${sid}' exists (session ${row ? row.healthStatus : 'not registered'})` };
  return { state: 'not-running', detail: row ? `session '${sid}' is ${row.healthStatus} and no bridge process exists` : `no session '${sid}' and no bridge process` };
}

/** bash on PATH (absolute), or null. */
function findBash(rt) {
  const hit = findOnPath('bash', rt)[0];
  return hit ? hit.file : null;
}

/** Run the boot helper in the foreground; resolves with the child's exit code. */
function launch(rt, opts) {
  const env = opts.portExplicit ? { ...rt.env, TELEPTY_PORT: String(opts.port) } : rt.env;
  return new Promise((resolve) => {
    const ignore = () => {};
    const signals = rt.platform === 'win32' ? [] : IGNORED_SIGNALS;
    const installed = [];
    for (const sig of signals) {
      try { rt.onSignal(sig, ignore); installed.push(sig); } catch { /* unsupported signal */ }
    }
    const done = (code) => {
      for (const sig of installed) rt.offSignal(sig, ignore);
      resolve(code);
    };
    let child;
    try {
      child = rt.spawn(opts.bash, [opts.workspace.bootScript], { cwd: opts.workspace.path, env, stdio: 'inherit', shell: false });
    } catch (error) {
      rt.err(`orchestrator: could not run the boot helper (${error.code || error.message}).\n`);
      return done(EXIT.FAILED);
    }
    child.on('error', (error) => {
      rt.err(`orchestrator: could not run the boot helper (${error.code || error.message}).\n`);
      done(EXIT.FAILED);
    });
    child.on('exit', (code, signal) => {
      if (code != null) return done(code);
      const signo = (os.constants.signals || {})[signal];
      done(Number.isInteger(signo) ? 128 + signo : EXIT.FAILED);
    });
  });
}

/** Shared gates; → {exit} on refusal, else {workspace, bash}. */
async function prepare(rt, verb, opts) {
  if (rt.platform === 'win32') {
    const ws = resolveWorkspace(rt, opts.workspaceFlag);
    rt.err(`aigentry ${verb} orchestrator is not supported on native Windows in this version (the boot is unmeasured there).\n`
      + '  From Git Bash, run:\n'
      + `    cd "${ws.path}" && bash bin/orchestrator-boot.sh\n`);
    return { exit: EXIT.UNSUPPORTED_OS };
  }
  const ctx = detectAgentContext(rt);
  if (ctx.agent) {
    rt.err(`Refusing '${verb} orchestrator' from an agent context (${ctx.reasons.join('; ')}).\n`
      + '  Run it from your own terminal. (Advisory check, not a security boundary.)\n');
    return { exit: EXIT.REFUSED };
  }
  if (ctx.note) rt.err(`note: ancestor check skipped (${ctx.note}).\n`);
  if (!(rt.stdinIsTTY && rt.stderrIsTTY)) {
    rt.err(`Refusing '${verb} orchestrator' without an interactive terminal: the boot wizard needs a TTY on stdin and stderr.\n`);
    return { exit: EXIT.REFUSED };
  }
  // Package provenance: the PATH hit must belong to the orchestrator package (not just share its name).
  const orch = resolveBin(getComponent('orchestrator'), 'aigentry-orchestrator', rt);
  if (!orch.ok) {
    rt.err(`${orch.code}: aigentry-orchestrator from ${ORCHESTRATOR_PKG} is not usable on PATH (${orch.detail}); the boot helper resolves its implementation through it.\n`
      + '  Install: npm i -g @dmsdc-ai/aigentry-orchestrator && aigentry-orchestrator init\n');
    return { exit: orch.code === 'NOT_INSTALLED' ? EXIT.NOT_INSTALLED : EXIT.FAILED };
  }
  const workspace = resolveWorkspace(rt, opts.workspaceFlag);
  if (!workspace.ok) {
    if (workspace.state === 'unavailable') {
      rt.err(`NOT_INSTALLED: no control workspace at ${workspace.path} (${workspace.source}).\n`
        + '  Create one: aigentry-orchestrator init   (or pass --workspace PATH)\n');
      return { exit: EXIT.NOT_INSTALLED };
    }
    rt.err(`orchestrator: invalid control workspace (${workspace.source}): ${workspace.detail}\n`);
    return { exit: EXIT.FAILED };
  }
  const bash = findBash(rt);
  if (!bash) {
    rt.err('NOT_INSTALLED: bash is not on PATH; the boot helper is a bash script.\n');
    return { exit: EXIT.NOT_INSTALLED };
  }
  return { workspace, bash };
}

/** `aigentry start orchestrator`: refuses unless the orchestrator is measured as not running. */
async function start(rt, opts) {
  const prep = await prepare(rt, 'start', opts);
  if (prep.exit != null) return prep.exit;
  const live = await liveState(rt, { port: opts.port, sid: sidOf(rt), allowSnapshot: true, timeoutMs: telepty.DEFAULT_PROBE_TIMEOUT_MS });
  if (live.state === 'running') {
    rt.err(`orchestrator already running: ${live.detail}. Use: aigentry restart orchestrator\n`);
    return EXIT.FAILED;
  }
  if (live.state !== 'not-running') {
    rt.err(`orchestrator: could not verify that no orchestrator is running (${live.detail}).\n`
      + '  Start telepty first (aigentry start), or run: aigentry restart orchestrator\n'
      + '  (the boot wizard asks for confirmation before replacing any bridge).\n');
    return EXIT.FAILED;
  }
  rt.err(`Booting the orchestrator from ${prep.workspace.path} …\n`);
  return launch(rt, { workspace: prep.workspace, bash: prep.bash, port: opts.port, portExplicit: opts.portExplicit });
}

/**
 * `aigentry restart orchestrator`: needs a running telepty daemon and a KNOWN session state
 * (authenticated listing); the boot itself replaces the old bridge after its typed YES.
 */
async function restart(rt, opts) {
  const prep = await prepare(rt, 'restart', opts);
  if (prep.exit != null) return prep.exit;
  const health = await telepty.probeHealth(rt, opts.port, telepty.DEFAULT_PROBE_TIMEOUT_MS);
  if (health.state !== 'running') {
    rt.err(`orchestrator: the telepty daemon on 127.0.0.1:${opts.port} is ${health.state === 'stopped' ? 'not running' : `not confirmed running (${health.detail})`}; the bridge needs it.\n`
      + '  Run: aigentry start   (nothing was run)\n');
    return EXIT.FAILED;
  }
  const sid = sidOf(rt);
  const live = await liveState(rt, { port: opts.port, sid, allowSnapshot: true, timeoutMs: telepty.DEFAULT_PROBE_TIMEOUT_MS, health });
  if (live.state === 'unknown') {
    rt.err(`orchestrator: could not determine the state of session '${sid}' (${live.detail}); nothing was run.\n`
      + '  Check: aigentry doctor\n');
    return EXIT.FAILED;
  }
  if (live.state === 'running') {
    rt.err(`Rebooting the orchestrator from ${prep.workspace.path}: the boot will replace session '${sid}' (${live.detail}) after you confirm YES …\n`);
  } else {
    rt.err(`No orchestrator session '${sid}' is running (${live.detail}); booting one from ${prep.workspace.path} …\n`);
  }
  return launch(rt, { workspace: prep.workspace, bash: prep.bash, port: opts.port, portExplicit: opts.portExplicit });
}

module.exports = {
  launch,
  liveState,
  resolveWorkspace,
  restart,
  sidOf,
  start
};
