'use strict';
// Shared hermetic fixtures for the aigentry CLI contract tests (task 1211).
// Nothing here executes a component, contacts a real daemon or touches the user home:
// every process/HTTP/fs seam goes through the injected runtime (API.md `rt`).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');

const REPO = path.resolve(__dirname, '..', '..');
const LIB = path.join(REPO, 'lib');
const BIN = path.join(REPO, 'bin', 'aigentry.js');
const HOST_IS_WIN = process.platform === 'win32';
const TOKEN = 'tok-FIXTURE-SECRET-7f3a9c51';
const ENV_SENTINEL = 'env-FIXTURE-SENTINEL-41b2d0';
const FAKE_NODE = '/opt/fake node/bin/node';
const DEFAULT_PORT = 3848;

const COMPONENTS = {
  telepty: { pkg: '@dmsdc-ai/aigentry-telepty', version: '0.8.5', bin: { telepty: 'cli.js' } },
  devkit: { pkg: '@dmsdc-ai/aigentry-devkit', version: '0.1.14', bin: { 'aigentry-devkit': 'bin/cli.js' } },
  brain: { pkg: '@dmsdc-ai/aigentry-brain', version: '0.3.1', bin: { 'aigentry-brain': 'dist/cli.js' } },
  deliberation: {
    pkg: '@dmsdc-ai/aigentry-deliberation',
    version: '0.0.47',
    bin: {
      'aigentry-deliberation': 'index.js',
      'mcp-deliberation': 'index.js',
      'deliberation-doctor': 'doctor.js',
      'deliberation-install': 'install.js',
    },
  },
  aterm: { pkg: '@dmsdc-ai/aterm', version: '0.2.14', bin: { aterm: 'bin/aterm.js' } },
  orchestrator: {
    pkg: '@dmsdc-ai/aigentry-orchestrator',
    version: '0.1.0',
    bin: { 'aigentry-orchestrator': 'bin/aigentry-orchestrator' },
  },
  // R2 (CONTROLLER-R2 S2): optional registry row, PATH only, not a meta dependency.
  logger: { pkg: '@dmsdc-ai/aigentry-logger', version: '0.1.0', bin: { 'aigentry-logger': 'bin/aigentry-logger' } },
};
const BUNDLED = ['telepty', 'devkit', 'brain', 'deliberation', 'aterm'];
// R2 (REVIEW B8): schema ids follow SPEC §3 / README.
const STATUS_SCHEMA = 'aigentry.status/v1';
const DOCTOR_SCHEMA = 'aigentry.doctor/v1';
const WIN_SYSTEMROOT = 'C:\\Windows';

// R2 (REVIEW B7): system tools are spawned only from trusted absolute locations, never by bare name,
// cwd or relative PATH, and never as .cmd/.bat.
const TRUSTED_TOOLS = {
  ps: ['/bin/ps', '/usr/bin/ps'],
  launchctl: ['/bin/launchctl'],
  systemctl: ['/usr/bin/systemctl', '/bin/systemctl'],
};
function isTrustedTool(cmd) {
  const s = String(cmd);
  const b = path.basename(s.replace(/\\/g, '/'));
  if (/^schtasks\.exe$/i.test(b)) return /^[A-Za-z]:\\(?:[^\\]+\\)*System32\\schtasks\.exe$/i.test(s) && !/\.\.|\\\\/.test(s.slice(2));
  const allowed = TRUSTED_TOOLS[b];
  return Boolean(allowed && allowed.includes(s));
}

// A fixture bin that would fail loudly if anything ever executed it for real.
const NODE_BIN_SRC = "#!/usr/bin/env node\n'use strict';\nthrow new Error('fixture bin must never be executed');\n";

function write(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== undefined) fs.chmodSync(file, mode);
  return file;
}

// Fixture root: AIGENTRY_TEST_FIXTURE_ROOT (the controller sets ROOT/output/fixtures) or the OS temp dir in CI.
// The directory name contains a space so every derived path exercises quoting.
function makeFixture(t) {
  const base = process.env.AIGENTRY_TEST_FIXTURE_ROOT || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, 'aigentry t-')));
  if (t && typeof t.after === 'function') {
    t.after(() => {
      restoreModes(root);
      fs.rmSync(root, { recursive: true, force: true });
    });
  }
  const fx = {
    root,
    home: path.join(root, 'home dir'),
    meta: path.join(root, 'meta root'),
    pathDir: path.join(root, 'path bin'),
    global: path.join(root, 'global prefix'),
  };
  for (const d of [fx.home, fx.meta, fx.pathDir, fx.global]) fs.mkdirSync(d, { recursive: true });
  // The meta package itself, declaring exactly what the repo under test declares.
  const realPkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  write(path.join(fx.meta, 'package.json'), JSON.stringify(realPkg, null, 2));
  write(path.join(fx.meta, 'bin', 'aigentry.js'), NODE_BIN_SRC, 0o755);
  return fx;
}

function restoreModes(dir) {
  try {
    fs.chmodSync(dir, 0o755);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) restoreModes(path.join(dir, e.name));
    }
  } catch { /* best effort before rm */ }
}

function writePackage(dir, spec, overrides = {}) {
  const pj = Object.assign({ name: spec.pkg, version: spec.version, bin: spec.bin }, overrides.packageJson);
  write(path.join(dir, 'package.json'), JSON.stringify(pj, null, 2));
  for (const rel of new Set(Object.values(spec.bin))) {
    write(path.join(dir, rel), overrides.binSource ?? NODE_BIN_SRC, 0o755);
  }
  return dir;
}

function pkgDir(base, pkg) {
  return path.join(base, 'node_modules', ...pkg.split('/'));
}

// Bundled copy: <metaRoot>/node_modules/<pkg>.
function installBundled(fx, name, overrides = {}) {
  const spec = Object.assign({}, COMPONENTS[name], overrides.spec);
  const dir = writePackage(pkgDir(fx.meta, spec.pkg), spec, overrides);
  // The aterm launcher needs its native app bundle (npm/aterm/bin/aterm.js precondition).
  if (name === 'aterm' && !overrides.noNativeApp) write(path.join(dir, 'dist', 'aterm.app', 'Contents', 'MacOS', 'aterm'), 'fixture native binary', 0o755);
  return dir;
}

function installAllBundled(fx, versions = {}) {
  for (const n of BUNDLED) installBundled(fx, n, versions[n] ? { spec: { version: versions[n] } } : {});
}

// PATH copy without symlinks: the PATH entry is the package's own bin directory, so realpath →
// nearest package.json is the owning package on every host.
function installOnPathDirect(fx, name, overrides = {}) {
  const spec = Object.assign({}, COMPONENTS[name], overrides.spec);
  const dir = writePackage(pkgDir(path.join(fx.global, 'lib'), spec.pkg), spec, overrides);
  const binDirs = [...new Set(Object.values(spec.bin).map((rel) => path.dirname(path.join(dir, rel))))];
  return { dir, binDirs, file: (bin) => path.join(dir, spec.bin[bin]) };
}

// Realistic npm POSIX global layout: <prefix>/bin/<bin> -> ../lib/node_modules/<pkg>/<rel>.
function linkOnPath(fx, name, overrides = {}) {
  const spec = Object.assign({}, COMPONENTS[name], overrides.spec);
  const dir = writePackage(pkgDir(path.join(fx.global, 'lib'), spec.pkg), spec, overrides);
  for (const [bin, rel] of Object.entries(spec.bin)) {
    fs.symlinkSync(path.join(dir, rel), path.join(fx.pathDir, bin));
  }
  return { dir, file: (bin) => path.join(dir, spec.bin[bin]) };
}

// npm Windows shim layouts: `<dir>/<bin>.cmd` beside `<dir>/node_modules/<pkg>` (global prefix) or
// `<dir>/../<pkg>` (node_modules/.bin). The .cmd content is never meant to be executed.
function winShim(fx, name, layout = 'prefix') {
  const spec = COMPONENTS[name];
  const shimDir = layout === 'prefix' ? path.join(fx.root, 'npm prefix') : path.join(fx.root, 'proj', 'node_modules', '.bin');
  const dir = layout === 'prefix' ? pkgDir(shimDir, spec.pkg) : path.join(shimDir, '..', ...spec.pkg.split('/'));
  writePackage(dir, spec);
  for (const bin of Object.keys(spec.bin)) {
    write(path.join(shimDir, `${bin}.cmd`), `@ECHO off\r\nREM fixture shim, never executed\r\nEXIT /b 99\r\n`);
  }
  return { shimDir, dir: path.resolve(dir), file: (bin) => path.resolve(dir, spec.bin[bin]) };
}

function writeTeleptyConfig(fx, body = { authToken: TOKEN }) {
  return write(path.join(fx.home, '.telepty', 'config.json'), JSON.stringify(body), 0o600);
}

function writeDaemonState(fx, body) {
  return write(path.join(fx.home, '.telepty', 'daemon-state.json'), JSON.stringify(body));
}

function makeWorkspace(dir, kind = 'init') {
  write(path.join(dir, 'bin', 'orchestrator-boot.sh'), '#!/bin/sh\necho fixture boot must never run >&2\nexit 99\n', 0o755);
  if (kind === 'init') write(path.join(dir, '.aigentry-init.json'), JSON.stringify({ workspace: 'fixture' }));
  if (kind === 'checkout') write(path.join(dir, 'package.json'), JSON.stringify({ name: '@dmsdc-ai/aigentry-orchestrator' }));
  return dir;
}

// ---------- recorders ----------

function makeProcs(handler) {
  return { handler };
}

function exitInfo(r) {
  return { status: r && r.status !== undefined ? r.status : 0, signal: (r && r.signal) || null };
}

function makeRt(fx, o = {}) {
  const lib = loadLib();
  const out = [];
  const err = [];
  const rec = { http: [], procs: [], kills: [], unrefs: [], signalsOn: [], signalsOff: [], prompts: [], sleeps: [] };
  let clock = o.startMs ?? Date.now();
  const env = Object.assign(
    { HOME: fx.home, USERPROFILE: fx.home, PATH: fx.pathDir, FIXTURE_SECRET_ENV: ENV_SENTINEL },
    o.env,
  );
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const tty = o.tty ?? false;

  const handle = (kind, cmd, args, opts) => {
    const call = { kind, cmd, args: [...(args || [])], opts: Object.assign({}, opts), signalsAtCall: rec.signalsOn.length };
    rec.procs.push(call);
    if (!o.procs) throw new Error(`forbidden ${kind}: ${cmd} ${(args || []).join(' ')}`);
    return o.procs.handler(call, rec) || {};
  };

  const overrides = {
    env,
    platform: o.platform ?? 'darwin',
    arch: o.arch ?? 'arm64',
    homedir: fx.home,
    cwd: o.cwd ?? fx.root,
    execPath: o.execPath ?? FAKE_NODE,
    pid: 4242,
    ppid: 4241,
    argv: [o.execPath ?? FAKE_NODE, path.join(fx.meta, 'bin', 'aigentry.js')],
    nodeVersion: o.nodeVersion ?? '22.11.0',
    metaRoot: fx.meta,
    out: (s) => { out.push(String(s)); },
    err: (s) => { err.push(String(s)); },
    stdinIsTTY: o.stdinIsTTY ?? tty,
    stderrIsTTY: o.stderrIsTTY ?? tty,
    stdoutIsTTY: o.stdoutIsTTY ?? tty,
    http: async (opts) => {
      rec.http.push(Object.assign({}, opts));
      if (!o.http) throw new Error(`forbidden http ${opts && opts.path}`);
      return o.http(opts, rec);
    },
    spawnSync: (cmd, args, opts) => {
      const r = handle('spawnSync', cmd, args, opts);
      if (r.error) return { pid: 0, status: null, signal: null, stdout: '', stderr: '', output: [null, '', ''], error: r.error };
      const { status, signal } = exitInfo(r);
      return { pid: 7000, status, signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', output: [null, r.stdout ?? '', r.stderr ?? ''] };
    },
    spawn: (cmd, args, opts) => {
      const r = handle('spawn', cmd, args, opts);
      const child = new EventEmitter();
      child.pid = 7001;
      child.stdin = null;
      child.stdout = null;
      child.stderr = null;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = (sig) => { rec.kills.push(sig); throw new Error('kill is forbidden for the meta CLI'); };
      child.unref = () => { rec.unrefs.push(cmd); };
      child.ref = () => {};
      setImmediate(() => {
        // Mirrors Node for a failed spawn (e.g. ENOENT): 'error', then 'close' with a negative errno.
        if (r.error) { child.emit('error', r.error); child.emit('close', -2, null); return; }
        child.emit('spawn');
        const finish = () => {
          const { status, signal } = exitInfo(r);
          child.exitCode = signal ? null : status;
          child.signalCode = signal;
          child.emit('exit', signal ? null : status, signal);
          child.emit('close', signal ? null : status, signal);
        };
        if (r.waitFor) r.waitFor.then(finish); else finish();
      });
      return child;
    },
    sleep: async (ms) => { rec.sleeps.push(ms); clock += Number(ms) || 0; },
    now: () => clock,
    prompt: async (q) => {
      rec.prompts.push(q);
      if (o.prompt === undefined) throw new Error('unexpected prompt');
      return o.prompt;
    },
    getuid: () => 501,
    onSignal: (sig, fn) => { rec.signalsOn.push({ sig, fn }); },
    offSignal: (sig, fn) => { rec.signalsOff.push({ sig, fn }); },
  };
  const rt = lib.commands.createRuntime(overrides);
  return {
    rt,
    rec,
    lib,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    all: () => out.join('') + err.join(''),
    advance: (ms) => { clock += ms; },
    get clock() { return clock; },
    run: (argv) => lib.commands.run(argv, rt),
  };
}

// ---------- fake daemon (injected rt.http) ----------

const P = {
  ok: (body, status = 200) => ({ kind: 'ok', status, body }),
  answered: (status) => ({ kind: 'answered', status }),
  malformed: (status = 200) => ({ kind: 'malformed', status, detail: 'fixture: not JSON' }),
  refused: () => ({ kind: 'refused' }),
  timeout: () => ({ kind: 'timeout' }),
  error: (code = 'ECONNRESET') => ({ kind: 'error', code }),
};

// routes: { health, meta, sessions } each a Probe or (opts, rec) => Probe. Unknown paths are a test failure.
function fakeDaemon(routes) {
  return (opts, rec) => {
    const p = String(opts.path || '');
    const key = p === '/api/health' ? 'health' : p === '/api/meta' ? 'meta' : p === '/api/sessions' ? 'sessions' : null;
    if (!key) throw new Error(`unexpected http path ${p}`);
    const r = routes[key];
    if (r === undefined) throw new Error(`fixture has no route for ${p}`);
    return typeof r === 'function' ? r(opts, rec) : r;
  };
}

const healthy = (version = '0.8.5') => P.ok({ status: 'ok', version });

// ---------- module loading / traps ----------

function libModules() {
  return {
    commands: path.join(LIB, 'commands.js'),
    registry: path.join(LIB, 'registry.js'),
    resolve: path.join(LIB, 'resolve.js'),
    context: path.join(LIB, 'context.js'),
    telepty: path.join(LIB, 'telepty.js'),
    orchestrator: path.join(LIB, 'orchestrator.js'),
    bin: BIN,
  };
}

function loadLib() {
  const m = libModules();
  const out = {};
  for (const [k, f] of Object.entries(m)) out[k] = require(f);
  return out;
}

function clearLibCache() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(LIB + path.sep) || k === BIN) delete require.cache[k];
  }
}

const CP_FNS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const FS_WRITE_FNS = [
  'writeFileSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync',
  'copyFileSync', 'symlinkSync', 'linkSync', 'chmodSync', 'chownSync', 'truncateSync', 'utimesSync', 'cpSync',
  'writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'symlink', 'chmod',
  'truncate', 'createWriteStream',
];
const FS_PROMISE_WRITE_FNS = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'symlink', 'chmod', 'truncate'];

function isWriteFlag(flags) {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'number') {
    const c = fs.constants;
    return (flags & (c.O_WRONLY | c.O_RDWR | c.O_CREAT | c.O_APPEND | c.O_TRUNC)) !== 0;
  }
  return /[wa+]/.test(String(flags));
}

// Runs fn with every child_process entry point and every fs write entry point replaced by a
// recording thrower, and with lib/ + bin/ freshly required inside the trap (so destructured
// imports are trapped too). Returns { result, violations }.
async function withSideEffectTrap(fn) {
  const violations = [];
  const saved = [];
  const patch = (obj, name, label) => {
    if (typeof obj[name] !== 'function') return;
    saved.push([obj, name, obj[name]]);
    const orig = obj[name];
    obj[name] = function trapped(...args) {
      if (name === 'openSync' || name === 'open') {
        if (!isWriteFlag(args[1])) return orig.apply(this, args);
      }
      violations.push(`${label}.${name}(${String(args[0]).slice(0, 120)})`);
      throw new Error(`side-effect trap: ${label}.${name}`);
    };
  };
  clearLibCache();
  for (const n of CP_FNS) patch(childProcess, n, 'child_process');
  for (const n of FS_WRITE_FNS.concat(['openSync', 'open'])) patch(fs, n, 'fs');
  for (const n of FS_PROMISE_WRITE_FNS.concat(['open'])) patch(fs.promises, n, 'fs.promises');
  try {
    const result = await fn();
    return { result, violations };
  } finally {
    for (const [obj, name, orig] of saved.reverse()) obj[name] = orig;
    clearLibCache();
  }
}

// ---------- fs snapshots ----------

function snapshotTree(dir) {
  const snap = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      const rel = path.relative(dir, f);
      const st = fs.lstatSync(f);
      if (st.isSymbolicLink()) snap[rel] = { type: 'link', target: fs.readlinkSync(f), mtimeMs: st.mtimeMs };
      else if (st.isDirectory()) { snap[rel] = { type: 'dir', mode: st.mode, mtimeMs: st.mtimeMs }; walk(f); }
      else {
        snap[rel] = {
          type: 'file',
          mode: st.mode,
          size: st.size,
          mtimeMs: st.mtimeMs,
          sha256: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'),
        };
      }
    }
  };
  walk(dir);
  return snap;
}

// ---------- misc ----------

function parseOneJson(text) {
  const trimmed = text.trim();
  return JSON.parse(trimmed); // throws on zero or several documents / any extra text
}

function checkById(doc, id) {
  const c = (doc.checks || []).find((x) => x.id === id);
  if (!c) throw new Error(`check ${id} not present; ids: ${(doc.checks || []).map((x) => x.id).join(',')}`);
  return c;
}

const base = (cmd) => path.basename(String(cmd).replace(/\\/g, '/')).replace(/\.(exe|cmd)$/i, '');

module.exports = {
  REPO, LIB, BIN, HOST_IS_WIN, TOKEN, ENV_SENTINEL, FAKE_NODE, DEFAULT_PORT, COMPONENTS, BUNDLED, NODE_BIN_SRC,
  STATUS_SCHEMA, DOCTOR_SCHEMA, WIN_SYSTEMROOT, TRUSTED_TOOLS, isTrustedTool,
  write, makeFixture, writePackage, pkgDir, installBundled, installAllBundled, installOnPathDirect, linkOnPath, winShim,
  writeTeleptyConfig, writeDaemonState, makeWorkspace, makeProcs, makeRt, P, fakeDaemon, healthy, loadLib, clearLibCache, libModules,
  withSideEffectTrap, snapshotTree, parseOneJson, checkById, base,
};
