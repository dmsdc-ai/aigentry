'use strict';

// Command layer: argv → verb/component route, all derived from lib/registry.js.
// `status` and `doctor` are read-only (fs reads + bounded loopback HTTP): they run no
// component CLI, no `ps`, no `schtasks`, mint no config and write nothing. `status` sends no
// token (health only); `doctor` may call the authenticated loopback endpoints.

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('./registry');
const { COMPONENTS, DEFAULT_SERVICE, EXIT, getComponent, findVerb, lifecycleComponents, platformSupported } = registry;
const resolve = require('./resolve');
const { detectAgentContext } = require('./context');
const telepty = require('./telepty');
const orchestrator = require('./orchestrator');

const NODE_FLOOR = [20, 11, 0];
const FAIL_STATES = new Set(['missing', 'broken']);
const DEFAULT_BUDGET_MS = 10000; // doctor --timeout default: one global budget for every probe
const MAX_BUDGET_MS = 60000;
const PASSTHROUGH_SIGNALS = ['SIGINT', 'SIGQUIT'];

/**
 * @typedef {{id:string, state:string, required:boolean, detail:string, remedy:string|null}} Check
 */

/** The injectable runtime every lib function takes. */
function createRuntime(overrides = {}) {
  const rt = {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    homedir: os.homedir(),
    cwd: process.cwd(),
    execPath: process.execPath,
    pid: process.pid,
    ppid: process.ppid,
    argv: process.argv,
    nodeVersion: process.versions.node,
    metaRoot: path.resolve(__dirname, '..'),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    stdinIsTTY: process.stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    http: telepty.httpGetJson,
    spawnSync: childProcess.spawnSync,
    spawn: childProcess.spawn,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    prompt: promptLine,
    getuid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
    onSignal: (sig, fn) => process.on(sig, fn),
    offSignal: (sig, fn) => process.off(sig, fn)
  };
  return Object.assign(rt, overrides);
}

function promptLine(question) {
  return new Promise((done) => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let answered = false;
    rl.on('close', () => { if (!answered) done(''); });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      done(answer);
    });
  });
}

function ownVersion() {
  return require('../package.json').version;
}

/** This package's own dependency range for a component, or null (not a dependency). */
function declaredRange(c) {
  const deps = require('../package.json').dependencies || {};
  return Object.prototype.hasOwnProperty.call(deps, c.pkg) ? deps[c.pkg] : null;
}

/** resolveBin, refusing a copy whose version is outside this package's declared range. */
function resolveCompatibleBin(c, binName, rt) {
  const r = resolve.resolveBin(c, binName, rt);
  const range = declaredRange(c);
  if (!r.ok || !range) return r;
  const fits = resolve.satisfiesRange(r.bin.version, range);
  if (fits === true) return r;
  return {
    ok: false,
    code: 'INCOMPATIBLE',
    detail: `${r.bin.file} is ${c.pkg} ${fits === null ? `with an unparseable version '${r.bin.version}'` : `v${r.bin.version}`}, `
      + `outside this package's supported range ${range}${r.bin.source === 'path' ? ' (the PATH copy wins over the bundled one)' : ''}; not running it`,
    shadowedBy: r.shadowedBy
  };
}

// ── argv ────────────────────────────────────────────────────────────────────

const VERB_FLAGS = {
  status: ['json', 'port', 'workspace'],
  doctor: ['json', 'timeout', 'port', 'workspace'],
  start: ['port', 'workspace'],
  restart: ['port', 'workspace', 'yes'],
  version: [],
  help: []
};
const VALUE_FLAGS = new Set(['timeout', 'port', 'workspace']);

/** → {verb, component, rest, flags} | {error, exit} */
function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  if (!args.length) return { verb: 'status', component: null, rest: [], flags: {} };
  const first = args[0];
  let verb;
  let rest;
  const v = findVerb(first);
  if (v) {
    verb = v.name;
    rest = args.slice(1);
  } else if (getComponent(first)) {
    return { verb: 'passthrough', component: first, rest: args.slice(1), flags: {} };
  } else if (first.startsWith('-')) {
    verb = 'status';
    rest = args;
  } else {
    return { error: `  Unknown command: ${first}\n  Run: aigentry help\n`, exit: EXIT.FAILED };
  }

  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('-') || a === '-') { positionals.push(a); continue; }
    let name;
    let value;
    if (a === '-y') name = 'yes';
    else {
      const m = a.match(/^--([a-z]+)(?:=(.*))?$/);
      if (!m) return usageError(verb, `unknown option ${a}`);
      name = m[1];
      value = m[2];
    }
    if (!VERB_FLAGS[verb].includes(name)) return usageError(verb, `unknown option ${a}`);
    if (VALUE_FLAGS.has(name)) {
      if (value === undefined) {
        value = rest[i + 1];
        i++;
      }
      if (value === undefined || value === '') return usageError(verb, `--${name} needs a value`);
      flags[name] = value;
    } else {
      if (value !== undefined) return usageError(verb, `--${name} takes no value`);
      flags[name] = true;
    }
  }
  const maxPositionals = verb === 'start' || verb === 'restart' || verb === 'help' ? 1 : 0;
  if (positionals.length > maxPositionals) return usageError(verb, `unexpected argument ${positionals[maxPositionals]}`);
  return { verb, component: positionals[0] || null, rest: [], flags };
}

function usageError(verb, message) {
  const v = findVerb(verb);
  return { error: `aigentry ${verb}: ${message}\n  Usage: ${v ? v.usage : 'aigentry help'}\n`, exit: EXIT.USAGE };
}

// ── facts and checks (read-only) ────────────────────────────────────────────

function versionAtLeast(version, floor) {
  const parts = String(version).split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < floor.length; i++) {
    const p = Number.isFinite(parts[i]) ? parts[i] : 0;
    if (p !== floor[i]) return p > floor[i];
  }
  return true;
}

function check(id, state, required, detail, remedy = null) {
  return { id, state, required, detail, remedy };
}

function componentCheck(c, info, supported, rt) {
  const id = `component.${c.name}.install`;
  const note = registry.platformNote(c, rt.platform);
  const label = note ? `; ${rt.platform} support: ${note}` : '';
  if (!supported) {
    return check(id, 'unsupported-os', c.required,
      `${c.name} supports ${registry.describePlatforms(c.platforms)}; this is ${rt.platform}-${rt.arch}${info.installed ? ` (v${info.version} installed)` : ''}`);
  }
  if (info.broken.length) return check(id, 'broken', c.required, info.broken.join('; ') + label, `Reinstall: npm i -g ${c.bundled ? '@dmsdc-ai/aigentry' : c.pkg}`);
  if (!info.installed) {
    return c.required
      ? check(id, 'missing', true, `${c.pkg} is not installed`, 'Run: npm i -g @dmsdc-ai/aigentry')
      : check(id, 'unavailable', false, `${c.pkg} is not installed (optional)`, c.note);
  }
  if (c.name === 'aterm') {
    // The launcher's own precondition (npm/aterm/bin/aterm.js): the native app bundle.
    const exe = path.join(info.root, 'dist', 'aterm.app', 'Contents', 'MacOS', 'aterm');
    if (!fs.existsSync(exe)) return check(id, 'broken', c.required, `v${info.version}: native app bundle missing at ${exe}`, 'Reinstall: npm i -g @dmsdc-ai/aigentry');
  }
  return check(id, 'ok', c.required, `v${info.version} (${info.source}${info.onPath ? ', on PATH' : ''}) at ${info.root}${label}`);
}

/**
 * `component.<name>.version`: the copy that runs (PATH first) against this package's own
 * dependency range. Outside the range → broken; unparseable → unknown; a PATH copy whose version
 * differs from the bundled one while in range → skew (advisory, never a failure).
 */
function versionCheck(c, info, rt) {
  const id = `component.${c.name}.version`;
  const range = declaredRange(c);
  if (!info.installed) return check(id, 'skipped', c.required, 'not installed');
  const bundled = info.source === 'path' ? resolve.findInstalledPackage(c.pkg, rt) : null;
  const bundledVersion = bundled ? String(bundled.pkg.version || '') : null;
  const seen = `v${info.version} (${info.source})${bundledVersion ? `, bundled v${bundledVersion}` : ''}; supported ${range}`;
  const fits = resolve.satisfiesRange(info.version, range);
  if (fits === null) return check(id, 'unknown', c.required, `version not parseable: ${seen}`, 'Reinstall: npm i -g @dmsdc-ai/aigentry');
  if (!fits) {
    return check(id, 'broken', c.required, `incompatible: ${seen}`, info.source === 'path'
      ? `Update the PATH copy (npm i -g ${c.pkg}@${range}) or remove it so the bundled copy is used`
      : 'Reinstall: npm i -g @dmsdc-ai/aigentry');
  }
  if (bundledVersion && bundledVersion !== info.version) {
    return check(id, 'skew', c.required, `PATH copy differs from the bundled copy: ${seen}`, 'Advisory: the PATH copy is the one that runs');
  }
  return check(id, 'ok', c.required, seen);
}

/**
 * Every read-only fact status/doctor need. → {port, portError, components, checks}
 * `opts.authenticated` (doctor) allows the token-bearing probes; `opts.budgetMs` is one global
 * deadline for every probe, each probe getting min(1500 ms, what is left).
 */
async function gather(rt, opts = {}) {
  const budgetEnd = rt.now() + (opts.budgetMs || DEFAULT_BUDGET_MS);
  const probeMs = () => Math.min(telepty.DEFAULT_PROBE_TIMEOUT_MS, budgetEnd - rt.now());
  const EXHAUSTED = { state: 'unknown', detail: 'the time budget (--timeout) was used up before this probe' };
  const portRes = telepty.resolvePort(opts.port, rt.env);
  const port = portRes.ok ? portRes.port : null;
  const checks = [];

  checks.push(versionAtLeast(rt.nodeVersion, NODE_FLOOR)
    ? check('node.engine', 'ok', true, `node ${rt.nodeVersion}`)
    : check('node.engine', 'broken', true, `node ${rt.nodeVersion} is older than ${NODE_FLOOR.join('.')}`, 'Install Node.js 20.11.0 or newer'));

  const self = resolve.inspectSelfOnPath(rt);
  if (self.state === 'self') checks.push(check('meta.path', 'ok', false, `aigentry on PATH is this package (${self.file})`));
  else if (self.state === 'foreign') {
    checks.push(check('meta.path', 'shadowed', false,
      `the first 'aigentry' on PATH (${self.file}) is not ${resolve.META_PACKAGE} (for example the Python aigentry-registry CLI)`,
      'Put the npm global bin directory earlier on PATH, or call this CLI by its full path'));
  } else checks.push(check('meta.path', 'unavailable', false, "no 'aigentry' on PATH (running from a path or npx)"));

  const components = [];
  for (const c of COMPONENTS) {
    const info = resolve.inspectComponent(c, rt);
    const supported = platformSupported(c.platforms, rt.platform, rt.arch);
    components.push({ c, info, supported });
    checks.push(componentCheck(c, info, supported, rt));
    if (declaredRange(c)) checks.push(versionCheck(c, info, rt));
  }

  // telepty daemon and credential
  let health = null;
  if (!portRes.ok) {
    checks.push(check('telepty.daemon', 'unknown', true, portRes.error, 'Fix --port / TELEPTY_PORT'));
    checks.push(check('telepty.auth', 'skipped', true, 'no valid port'));
  } else {
    health = probeMs() >= 1 ? await telepty.probeHealth(rt, port, probeMs()) : EXHAUSTED;
    if (health.state === 'running') {
      checks.push(check('telepty.daemon', 'ok', true, `running${health.version ? ` v${health.version}` : ''} on 127.0.0.1:${port}`));
    } else if (health.state === 'stopped') {
      checks.push(check('telepty.daemon', 'stopped', true, `nothing listens on 127.0.0.1:${port}`, 'Run: aigentry start'));
    } else {
      checks.push(check('telepty.daemon', 'unknown', true, `127.0.0.1:${port}: ${health.detail}`, 'Retry with a larger --timeout; do not assume it is down'));
    }
    if (health.state !== 'running') {
      checks.push(check('telepty.auth', 'skipped', true, 'daemon not confirmed running'));
    } else if (!opts.authenticated) {
      checks.push(check('telepty.auth', 'skipped', true, 'not measured: status sends no token', 'Run: aigentry doctor'));
    } else {
      const meta = probeMs() >= 1 ? await telepty.probeMeta(rt, port, probeMs()) : EXHAUSTED;
      if (meta.state === 'ok') {
        checks.push(check('telepty.auth', 'ok', true, `token accepted; daemon v${meta.meta.version}${meta.meta.pid ? ` pid ${meta.meta.pid}` : ''}`));
      } else if (meta.state === 'refused') {
        checks.push(check('telepty.auth', 'broken', true, `daemon refused this token (HTTP ${meta.status}): credential mismatch`,
          'Set TELEPTY_AUTH_TOKEN identically for the daemon and clients, or unset it everywhere'));
      } else if (meta.state === 'no-token' && (meta.reason === 'no-config' || meta.reason === 'no-authToken')) {
        // Known alive, and definitely no token here: authenticated calls cannot work.
        checks.push(check('telepty.auth', 'broken', true, `the daemon is running but no telepty token is available (${meta.reason})`,
          'Set TELEPTY_AUTH_TOKEN, or use the authToken in the daemon\'s ~/.telepty/config.json'));
      } else if (meta.state === 'no-token') {
        checks.push(check('telepty.auth', 'unknown', true, `telepty token could not be read (${meta.reason})`, 'Check ~/.telepty/config.json'));
      } else {
        checks.push(check('telepty.auth', 'unknown', true, meta.detail));
      }
    }
    const tinfo = components.find((x) => x.c.name === 'telepty').info;
    if (health.state !== 'running') {
      checks.push(check('telepty.daemon.version', 'skipped', false, 'daemon not confirmed running'));
    } else if (!health.version) {
      checks.push(check('telepty.daemon.version', 'unknown', false, '/api/health reported no version'));
    } else if (!tinfo.installed) {
      checks.push(check('telepty.daemon.version', 'skipped', false, `daemon v${health.version}; no telepty CLI resolved to compare`));
    } else if (health.version === tinfo.version) {
      checks.push(check('telepty.daemon.version', 'ok', false, `daemon v${health.version} = CLI v${tinfo.version} (${tinfo.source})`));
    } else {
      checks.push(check('telepty.daemon.version', 'skew', false, `daemon v${health.version} differs from the CLI v${tinfo.version} (${tinfo.source}); supported ${declaredRange(getComponent('telepty'))}`,
        'Advisory: after upgrading, run: aigentry restart telepty'));
    }
  }

  const sup = telepty.detectSupervisor(rt, { allowExec: false });
  if (sup.present === null) checks.push(check('telepty.supervisor', 'unknown', false, sup.detail));
  else if (!sup.present) checks.push(check('telepty.supervisor', 'unavailable', false, sup.detail === 'disabled-by-env' ? 'supervisor deferral disabled (TELEPTY_NO_SUPERVISOR_DEFER=1)' : 'no service supervisor installed; start uses telepty daemon start'));
  else {
    const where = `${sup.kind} (${sup.unitFile || sup.detail})`;
    const scoped = port ? telepty.supervisorFor(sup, port) : null;
    if (!scoped) checks.push(check('telepty.supervisor', 'unknown', false, `${where} is installed; no valid port to compare`));
    else if (scoped.present === null) checks.push(check('telepty.supervisor', 'unknown', false, scoped.detail));
    else {
      checks.push(check('telepty.supervisor', 'ok', false, scoped.present
        ? `${where} serves port ${scoped.servedPort}`
        : `${where} serves port ${scoped.servedPort}; port ${port} is unsupervised`));
    }
  }

  checks.push(telepty.clientRestartMode(rt) === 'off'
    ? check('telepty.client-restart', 'gate-closed', false, 'TELEPTY_CLIENT_RESTART=off: telepty clients never restart the daemon on their own (explicit aigentry start/restart still act)')
    : check('telepty.client-restart', 'ok', false, 'auto'));

  // orchestrator (optional)
  const orch = components.find((x) => x.c.name === 'orchestrator');
  if (rt.platform === 'win32') {
    checks.push(check('orchestrator.workspace', 'unsupported-os', false, 'orchestrator start/restart is not supported on native Windows in this version', 'Use Git Bash: bash bin/orchestrator-boot.sh'));
    checks.push(check('orchestrator.session', 'skipped', false, 'unsupported OS'));
  } else if (!orch.info.installed) {
    checks.push(check('orchestrator.workspace', 'unavailable', false, 'aigentry-orchestrator is not installed (optional)', orch.c.note));
    checks.push(check('orchestrator.session', 'skipped', false, 'orchestrator not installed'));
  } else {
    const ws = orchestrator.resolveWorkspace(rt, opts.workspace);
    if (ws.ok) checks.push(check('orchestrator.workspace', 'ok', false, `${ws.path} (${ws.source})`));
    else if (ws.state === 'unavailable') checks.push(check('orchestrator.workspace', 'unavailable', false, `${ws.detail} (${ws.source})`, 'Run: aigentry-orchestrator init'));
    else checks.push(check('orchestrator.workspace', 'broken', false, `${ws.detail} (${ws.source})`, 'Pass --workspace PATH, or re-run: aigentry-orchestrator init --upgrade'));
    if (!opts.authenticated) checks.push(check('orchestrator.session', 'skipped', false, 'not measured: status sends no token', 'Run: aigentry doctor'));
    else if (!portRes.ok) checks.push(check('orchestrator.session', 'unknown', false, portRes.error));
    else {
      const live = probeMs() >= 1
        ? await orchestrator.liveState(rt, { port, sid: orchestrator.sidOf(rt), allowSnapshot: false, timeoutMs: probeMs(), health })
        : EXHAUSTED;
      const state = live.state === 'running' ? 'ok' : live.state === 'not-running' ? 'stopped' : 'unknown';
      checks.push(check('orchestrator.session', state, false, live.detail, state === 'stopped' ? 'Run: aigentry start orchestrator' : null));
    }
  }

  const ctx = detectAgentContext(rt, { envOnly: true });
  checks.push(ctx.agent
    ? check('lifecycle.agent-context', 'gate-closed', false, `${ctx.reasons.join('; ')}: restart telepty and start/restart orchestrator are refused here (advisory)`)
    : check('lifecycle.agent-context', 'ok', false, 'no agent-session env markers'));

  return { port, portError: portRes.ok ? null : portRes.error, components, checks };
}

async function collectChecks(rt, opts) {
  return (await gather(rt, opts)).checks;
}

function doctorExitCode(checks) {
  if (checks.some((c) => c.required && FAIL_STATES.has(c.state))) return EXIT.FAILED;
  if (checks.some((c) => c.required && c.state === 'unknown')) return EXIT.INCONCLUSIVE;
  return EXIT.OK;
}

// ── verbs ───────────────────────────────────────────────────────────────────

const ICON = { ok: '✓', missing: '✗', broken: '✗', unknown: '?', stopped: '–', skipped: '–', unavailable: '–', 'unsupported-os': '–', 'gate-closed': '■', shadowed: '!', skew: '!' };

/**
 * The `CLI command` column (1211): a bundled copy runs without anything on PATH, so the cell
 * names where the command resolves from instead of reporting "on PATH or absent".
 * Resolution origin only. An unsupported OS is handled at the row (R2), not here: `—` already
 * means "declares no primary bin", so it cannot double as "this OS refuses the command".
 */
const CLI_CELL = {
  path: '✓ PATH', bundled: '✓ bundled', node_modules: '✓ node_modules',
  broken: '✗ broken', missing: '✗ missing', none: '—'
};

/**
 * Installed-module counts, kept apart because they answer different questions: the bundled
 * modules come with this package (a gap means a damaged install), the optional ones are
 * installed separately (absent is normal). Reported with their denominators, never merged.
 */
function moduleCounts(components) {
  const of = (bundled) => components.filter((x) => x.c.bundled === bundled);
  const optional = of(false);
  return {
    bundled: { installed: of(true).filter((x) => x.info.installed).length, total: of(true).length },
    optional: {
      installed: optional.filter((x) => x.info.installed).length,
      total: optional.length,
      missing: optional.filter((x) => !x.info.installed).map((x) => x.c.name)
    }
  };
}

async function status(rt, flags) {
  const g = await gather(rt, { port: flags.port, workspace: flags.workspace });
  const version = ownVersion();
  if (flags.json) {
    rt.out(JSON.stringify({
      schema: 'aigentry.status/v1', version, platform: rt.platform, arch: rt.arch, port: g.port,
      modules: moduleCounts(g.components),
      // `cli` is resolution-origin provenance — where a copy was found — never a runnability
      // verdict: read it together with `supported`, because `aigentry <name> …` refuses on an
      // unsupported OS before resolving anything. `onPath` keeps its PATH-only meaning.
      components: g.components.map(({ c, info, supported }) => ({
        name: c.name, package: c.pkg, required: c.required, bundled: c.bundled, installed: info.installed, version: info.version,
        source: info.source, cli: info.cli, onPath: info.onPath, supported, range: declaredRange(c), platformNote: registry.platformNote(c, rt.platform)
      })),
      checks: g.checks
    }, null, 2) + '\n');
    return EXIT.OK;
  }
  const lines = [`\n  aigentry v${version} — Sovereign Brain OS for AI Agents\n`,
    '  Module           Version     CLI command',
    '  ───────────────  ──────────  ───────────────'];
  for (const { c, info, supported } of g.components) {
    const verStr = info.installed ? `v${info.version}` : c.required ? '✗ missing' : '– optional';
    // R2: `aigentry <name> …` refuses on an unsupported OS before resolving anything, so the cell
    // names no source as runnable there; `cli` keeps its resolution-origin meaning for --json.
    const cliStr = !supported ? '– unsupported' : CLI_CELL[info.cli] || CLI_CELL.missing;
    // R1: a component's own precondition (aterm's native app) is checked in componentCheck, which
    // writes into g.checks, not into info.broken — so the row reads the same install check doctor
    // prints. One broken verdict per component, never an affirmative row beside a doctor reinstall.
    const ick = g.checks.find((x) => x.id === `component.${c.name}.install`);
    const brokenInstall = info.broken.length > 0 || Boolean(ick && ick.state === 'broken');
    const icon = !supported ? '–' : info.installed && !brokenInstall ? '✓' : c.required ? '✗' : '–';
    const vck = g.checks.find((x) => x.id === `component.${c.name}.version`);
    const note = registry.platformNote(c, rt.platform);
    const tail = (!supported ? '  (unsupported on this OS)' : brokenInstall ? '  (broken install)'
      : vck && vck.state === 'broken' ? `  (incompatible: needs ${declaredRange(c)})`
        : vck && vck.state === 'unknown' ? '  (version not parseable)' : '')
      + (note ? `  (${rt.platform}: ${note})` : '');
    lines.push(`  ${icon} ${c.name.padEnd(15)}  ${verStr.padEnd(10)}  ${cliStr.padEnd(14)}${tail}`.trimEnd());
  }
  const m = moduleCounts(g.components);
  lines.push(`\n  ${m.bundled.installed}/${m.bundled.total} bundled modules installed`);
  // R3: the row word `optional` means "not required"; this line counts modules that are not
  // bundled. One sense each, so the two cannot be read against each other on one screen.
  lines.push(`  ${m.optional.installed}/${m.optional.total} separately installed modules`
    + `${m.optional.missing.length ? ` (not installed: ${m.optional.missing.join(', ')})` : ''}\n`);
  for (const id of ['telepty.daemon', 'orchestrator.session']) {
    const ck = g.checks.find((x) => x.id === id);
    lines.push(`  ${ICON[ck.state] || '?'} ${(id === 'telepty.daemon' ? 'telepty daemon' : 'orchestrator').padEnd(15)}  ${ck.state}: ${ck.detail}${ck.state === 'skipped' && ck.remedy ? ` (${ck.remedy})` : ''}`);
  }
  lines.push('');
  if (m.bundled.installed < m.bundled.total) lines.push('  Run: npm i -g @dmsdc-ai/aigentry  (to reinstall missing)\n');
  rt.out(lines.join('\n') + '\n');
  return EXIT.OK;
}

async function doctor(rt, flags) {
  let budgetMs = DEFAULT_BUDGET_MS;
  if (flags.timeout != null) {
    budgetMs = /^\d+$/.test(flags.timeout) ? Number(flags.timeout) : NaN;
    if (!(budgetMs >= 1 && budgetMs <= MAX_BUDGET_MS)) {
      rt.err('aigentry doctor: --timeout must be 1-60000 (ms)\n');
      return EXIT.USAGE;
    }
  }
  const g = await gather(rt, { port: flags.port, workspace: flags.workspace, budgetMs, authenticated: true });
  const exitCode = doctorExitCode(g.checks);
  if (flags.json) {
    rt.out(JSON.stringify({
      schema: 'aigentry.doctor/v1', version: ownVersion(), platform: rt.platform, arch: rt.arch, port: g.port, exitCode, checks: g.checks
    }, null, 2) + '\n');
    return exitCode;
  }
  const lines = [`\n  aigentry doctor v${ownVersion()}\n`];
  for (const ck of g.checks) {
    lines.push(`  ${ICON[ck.state] || '?'} ${ck.id.padEnd(30)} ${ck.state}${ck.required ? '' : ' (optional)'}: ${ck.detail}`);
    if (ck.remedy && ck.state !== 'ok') lines.push(`      → ${ck.remedy}`);
  }
  const verdict = exitCode === EXIT.OK ? 'OK' : exitCode === EXIT.FAILED ? 'FAILED' : 'INCONCLUSIVE';
  lines.push('', `  ${verdict} (exit ${exitCode})`, '');
  rt.out(lines.join('\n') + '\n');
  return exitCode;
}

function resolveLifecycle(rt, verb, parsed) {
  const name = parsed.component || (verb === 'start' ? DEFAULT_SERVICE : null);
  const allowed = lifecycleComponents(verb);
  if (!name) {
    rt.err(`aigentry restart: name a component (${allowed.join('|')}); there is no --all\n`);
    return { exit: EXIT.USAGE };
  }
  if (!allowed.includes(name)) {
    rt.err(`aigentry ${verb}: '${name}' has no ${verb} (supported: ${allowed.join(', ')})\n`);
    return { exit: EXIT.USAGE };
  }
  if (name !== 'orchestrator' && parsed.flags.workspace != null) {
    rt.err(`aigentry ${verb}: --workspace applies to orchestrator only\n`);
    return { exit: EXIT.USAGE };
  }
  if (name === 'orchestrator' && parsed.flags.yes) {
    rt.err(`aigentry ${verb}: --yes applies to telepty only; the orchestrator boot asks for its own confirmation\n`);
    return { exit: EXIT.USAGE };
  }
  const port = telepty.resolvePort(parsed.flags.port, rt.env);
  if (!port.ok) {
    rt.err(`aigentry ${verb}: ${port.error}\n`);
    return { exit: EXIT.USAGE };
  }
  return { name, port: port.port };
}

async function lifecycle(rt, verb, parsed) {
  const target = resolveLifecycle(rt, verb, parsed);
  if (target.exit != null) return target.exit;
  if (target.name === 'orchestrator') {
    const opts = { workspaceFlag: parsed.flags.workspace, port: target.port, portExplicit: parsed.flags.port != null };
    return verb === 'start' ? orchestrator.start(rt, opts) : orchestrator.restart(rt, opts);
  }
  // Lifecycle never runs a telepty CLI outside this package's supported range (B5).
  const resolveTelepty = () => resolveCompatibleBin(getComponent('telepty'), 'telepty', rt);
  if (verb === 'start') return telepty.start(rt, { port: target.port, resolveTelepty });
  const ctx = detectAgentContext(rt);
  if (ctx.agent) {
    rt.err(`Refusing 'restart telepty' from an agent context (${ctx.reasons.join('; ')}): it would end spawned sessions this agent may depend on.\n`
      + '  Run it from your own terminal. (Advisory check, not a security boundary.)\n');
    return EXIT.REFUSED;
  }
  if (ctx.note) rt.err(`note: ancestor check skipped (${ctx.note}).\n`);
  return telepty.restart(rt, { port: target.port, yes: parsed.flags.yes === true, resolveTelepty });
}

function componentSummary(rt, c) {
  const info = resolve.inspectComponent(c, rt);
  const supported = platformSupported(c.platforms, rt.platform, rt.arch);
  let state = info.installed ? `installed v${info.version} (${info.source})` : 'not installed';
  if (!supported) state += `; unsupported on ${rt.platform}-${rt.arch}`;
  return registry.topicHelp(c.name).replace(/\n\n$/, `\n  state: ${state}\n  Nothing was run: pass arguments to call the component.\n\n`);
}

/** `aigentry <component> [args…]`: the resolved Node bin, argv/env/exit code unchanged. */
function passthrough(rt, name, rest) {
  const c = getComponent(name);
  if (!rest.length) {
    rt.out(componentSummary(rt, c));
    return Promise.resolve(EXIT.OK);
  }
  if (!platformSupported(c.platforms, rt.platform, rt.arch)) {
    rt.err(`${c.name} supports ${registry.describePlatforms(c.platforms)} only; this is ${rt.platform}-${rt.arch}.\n`);
    return Promise.resolve(EXIT.UNSUPPORTED_OS);
  }
  let binName = c.bin;
  let args = rest;
  if (Object.prototype.hasOwnProperty.call(c.sub, rest[0])) {
    binName = c.sub[rest[0]];
    args = rest.slice(1);
  }
  if (!binName) {
    rt.err(`aigentry ${c.name}: use one of: ${Object.keys(c.sub).join(', ')}\n`);
    return Promise.resolve(EXIT.USAGE);
  }
  const r = resolve.resolveBin(c, binName, rt);
  if (!r.ok) {
    rt.err(`${r.code}: ${r.detail}\n  Install: npm i -g ${c.bundled ? '@dmsdc-ai/aigentry' : c.pkg}\n`);
    return Promise.resolve(r.code === 'BROKEN' ? EXIT.FAILED : EXIT.NOT_INSTALLED);
  }
  return new Promise((done) => {
    // Terminal signals reach the child from the terminal itself; this parent only outlives it.
    const ignore = () => {};
    const installed = [];
    for (const sig of rt.platform === 'win32' ? ['SIGINT'] : PASSTHROUGH_SIGNALS) {
      try { rt.onSignal(sig, ignore); installed.push(sig); } catch { /* unsupported signal */ }
    }
    const finish = (code) => {
      for (const sig of installed) rt.offSignal(sig, ignore);
      done(code);
    };
    let child;
    try {
      child = rt.spawn(rt.execPath, [r.bin.file, ...args], { stdio: 'inherit', env: rt.env, shell: false });
    } catch (error) {
      rt.err(`aigentry ${c.name}: could not run ${binName} (${error.code || error.message})\n`);
      return finish(EXIT.FAILED);
    }
    child.on('error', (error) => {
      rt.err(`aigentry ${c.name}: could not run ${binName} (${error.code || error.message})\n`);
      finish(EXIT.FAILED);
    });
    child.on('exit', (code, signal) => {
      if (code != null) return finish(code);
      const signo = (os.constants.signals || {})[signal];
      finish(Number.isInteger(signo) ? 128 + signo : EXIT.FAILED);
    });
  });
}

/** Entry point: argv (without node/script) → exit code. */
async function run(argv, rt) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    rt.err(parsed.error);
    return parsed.exit;
  }
  switch (parsed.verb) {
    case 'status': return status(rt, parsed.flags);
    case 'doctor': return doctor(rt, parsed.flags);
    case 'start':
    case 'restart': return lifecycle(rt, parsed.verb, parsed);
    case 'version':
      rt.out(`${ownVersion()}\n`);
      return EXIT.OK;
    case 'help': {
      if (!parsed.component) {
        rt.out(registry.helpText());
        return EXIT.OK;
      }
      const text = registry.topicHelp(parsed.component);
      if (!text) {
        rt.err(`aigentry help: no topic '${parsed.component}'\n  Run: aigentry help\n`);
        return EXIT.USAGE;
      }
      rt.out(text);
      return EXIT.OK;
    }
    case 'passthrough': return passthrough(rt, parsed.component, parsed.rest);
    default:
      rt.err(`  Unknown command: ${parsed.verb}\n  Run: aigentry help\n`);
      return EXIT.FAILED;
  }
}

module.exports = {
  collectChecks,
  createRuntime,
  doctor,
  doctorExitCode,
  gather,
  parseArgs,
  passthrough,
  run,
  status
};
