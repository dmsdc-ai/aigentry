'use strict';
// Area 7 + hermetic CLI children: require-safe imports, static invariants of bin/ and lib/, no hidden
// background process; `aigentry --help` and `aigentry status --json` as real children with a hermetic
// env, a fixture HOME and an in-process loopback fake daemon (the only HTTP seam a child can use).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const H = require('./helpers/fixture');

const TRAP = path.join(__dirname, 'helpers', 'trap-preload.js');

function listJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(f));
    else if (/\.(c|m)?js$/.test(e.name)) out.push(f);
  }
  return out;
}

// Removes // and /* */ comments while keeping string and template literal contents.
function stripComments(src) {
  let out = '';
  let i = 0;
  let q = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === q) q = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    out += c;
    i++;
  }
  return out;
}

// Runs a child we own with stdin closed, collecting output; reaped on timeout.
function runChild(args, { env, cwd = H.REPO, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

function hermeticEnv(fx, extra = {}) {
  const env = { HOME: fx.home, USERPROFILE: fx.home, PATH: path.join(fx.root, 'empty path'), FIXTURE_SECRET_ENV: H.ENV_SENTINEL };
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir']) if (process.env[k]) env[k] = process.env[k];
  return Object.assign(env, extra);
}

describe('static invariants of bin/ and lib/', () => {
  const files = [...listJs(path.join(H.REPO, 'bin')), ...listJs(H.LIB)];
  it('lib/ and bin/ exist', () => {
    assert.ok(files.some((f) => f.startsWith(H.LIB)), 'lib/ has modules');
  });
  const rules = [
    ['detached', /\bdetached\b/],
    ['shell: true', /\bshell\s*:\s*true\b/],
    ['.kill(', /\.kill\s*\(/],
    ['execSync', /\bexecSync\b/],
    // R2 (REVIEW-R1 B7): no system tool spawned by a bare-name string literal (cwd / relative PATH search).
    ['spawn of a bare-name literal', /\bspawn(?:Sync)?\s*\(\s*(['"`])(?![/A-Za-z]:?[\\/])[^'"`\\/]+\1/],
  ];
  for (const [label, re] of rules) {
    it(`no \`${label}\` in code`, () => {
      const hits = [];
      for (const f of files) {
        stripComments(fs.readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
          if (re.test(line)) hits.push(`${path.relative(H.REPO, f)}:${i + 1}: ${line.trim()}`);
        });
      }
      assert.deepEqual(hits, []);
    });
  }
});

describe('require-safe imports', () => {
  it('requiring every module runs nothing, prints nothing, keeps no handle open', async (t) => {
    const fx = H.makeFixture(t);
    const mods = Object.values(H.libModules());
    const script = `
      const mods = ${JSON.stringify(mods)};
      const got = mods.map((m) => require(m));
      const bin = got[mods.indexOf(${JSON.stringify(H.BIN)})];
      const commands = got[mods.indexOf(${JSON.stringify(path.join(H.LIB, 'commands.js'))})];
      process.stdout.write(JSON.stringify({ exitCode: process.exitCode === undefined ? null : process.exitCode, main: typeof bin.main, createRuntime: typeof commands.createRuntime, run: typeof commands.run }));
    `;
    const r = await runChild(['--require', TRAP, '-e', script], { env: hermeticEnv(fx), timeoutMs: 15000 });
    assert.equal(r.signal, null, 'child did not exit on its own (a hidden handle keeps it alive)');
    assert.doesNotMatch(r.stderr, /TRAP-VIOLATION/);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { exitCode: null, main: 'function', createRuntime: 'function', run: 'function' });
  });

  it('bin exports main(argv, rt) that returns the exit code without exiting the process', async (t) => {
    const fx = H.makeFixture(t);
    const h = H.makeRt(fx);
    const code = await h.lib.bin.main(['version'], h.rt);
    assert.equal(code, 0);
    assert.equal(h.stdout().trim(), JSON.parse(fs.readFileSync(path.join(H.REPO, 'package.json'), 'utf8')).version);
  });
});

describe('hermetic CLI children (help/status only)', () => {
  it('aigentry --help: exit 0, no subprocess, no write', async (t) => {
    const fx = H.makeFixture(t);
    const before = H.snapshotTree(fx.root);
    const r = await runChild(['--require', TRAP, H.BIN, '--help'], { env: hermeticEnv(fx) });
    assert.doesNotMatch(r.stderr, /TRAP-VIOLATION/);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /restart/);
    assert.deepEqual(H.snapshotTree(fx.root), before);
  });

  it('aigentry status --json against an in-process fake daemon: one document, no secret, no write', async (t) => {
    const fx = H.makeFixture(t);
    const seen = [];
    const srv = http.createServer((req, res) => {
      seen.push({ url: req.url, token: req.headers['x-telepty-token'] });
      const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.url === '/api/health') return send(200, { status: 'ok', version: '0.8.5' });
      if (req.headers['x-telepty-token'] !== H.TOKEN) return send(401, { error: 'unauthorized' });
      if (req.url === '/api/meta') return send(200, { name: 'telepty', version: '0.8.5', pid: 4321, port: srv.address().port, capabilities: [] });
      if (req.url === '/api/sessions') return send(200, []);
      return send(404, {});
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }));
    const port = srv.address().port;
    const before = H.snapshotTree(fx.root);
    const env = hermeticEnv(fx, { TELEPTY_PORT: String(port), TELEPTY_AUTH_TOKEN: H.TOKEN });
    const r = await runChild(['--require', TRAP, H.BIN, 'status', '--json'], { env });
    assert.doesNotMatch(r.stderr, /TRAP-VIOLATION/);
    assert.equal(r.code, 0, r.stderr);
    const doc = H.parseOneJson(r.stdout);
    assert.equal(doc.schema, H.STATUS_SCHEMA);
    assert.equal(doc.port, port);
    assert.equal(H.checkById(doc, 'telepty.daemon').state, 'ok');
    assert.ok(!(r.stdout + r.stderr).includes(H.TOKEN), 'token leaked');
    assert.ok(!(r.stdout + r.stderr).includes(H.ENV_SENTINEL), 'env value leaked');
    // R2 (SEC-A): status is health-only; the token never leaves the process, even to loopback.
    assert.ok(seen.length > 0 && seen.every((s) => s.url === '/api/health'), JSON.stringify(seen));
    assert.ok(seen.every((s) => s.token === undefined), 'status sent the token');
    assert.deepEqual(H.snapshotTree(fx.root), before);
  });
});
