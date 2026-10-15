'use strict';
// Area 3: required missing vs optional unsupported vs policy gate-closed; doctor 0/1/7, status 0;
// version compatibility against package declarations; an old telepty is reported as what it is.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers/fixture');

const STABLE_IDS = [
  'node.engine', 'meta.path',
  ...['aterm', 'telepty', 'devkit', 'brain', 'deliberation', 'orchestrator', 'logger'].map((n) => `component.${n}.install`),
  'telepty.daemon', 'telepty.auth', 'telepty.supervisor', 'telepty.client-restart',
  'orchestrator.workspace', 'orchestrator.session', 'lifecycle.agent-context',
];
// R2: 'incompatible' is the advisory version state proposed by REVIEW-R1 B5.
const STATES = new Set(['ok', 'missing', 'broken', 'unavailable', 'unsupported-os', 'gate-closed', 'stopped', 'shadowed', 'skipped', 'unknown', 'incompatible']);

function world(t, { versions = {}, skip = [], token = true, selfOnPath = true } = {}) {
  const fx = H.makeFixture(t);
  for (const n of H.BUNDLED) {
    if (skip.includes(n)) continue;
    H.installBundled(fx, n, versions[n] ? { spec: { version: versions[n] } } : {});
  }
  if (token) H.writeTeleptyConfig(fx);
  if (selfOnPath && !H.HOST_IS_WIN) fs.symlinkSync(path.join(fx.meta, 'bin', 'aigentry.js'), path.join(fx.pathDir, 'aigentry'));
  return fx;
}

const routes = (over = {}) => H.fakeDaemon(Object.assign({
  health: H.healthy(),
  meta: H.P.ok({ name: 'telepty', version: '0.8.5', pid: 100, port: H.DEFAULT_PORT }),
  sessions: H.P.ok([]),
}, over));

async function doctor(fx, opts = {}) {
  const h = H.makeRt(fx, Object.assign({ http: routes() }, opts));
  const code = await h.run(['doctor', '--json']);
  const doc = H.parseOneJson(h.stdout());
  assert.equal(doc.exitCode, code, 'document exitCode equals process exit');
  assert.equal(code, h.lib.commands.doctorExitCode(doc.checks), 'exit derives from the checks');
  assert.deepEqual(h.rec.procs, [], 'doctor runs no subprocess');
  return { h, code, doc };
}

describe('doctorExitCode (pure)', () => {
  const { commands } = H.loadLib();
  const c = (state, required = true) => ({ id: `x.${state}.${required}`, state, required, detail: '', remedy: '' });
  const cases = [
    ['all ok', [c('ok'), c('ok', false)], 0],
    ['required missing', [c('ok'), c('missing')], 1],
    ['required broken', [c('broken')], 1],
    ['required unknown', [c('ok'), c('unknown')], 7],
    ['missing beats unknown', [c('unknown'), c('missing')], 1],
    ['optional missing', [c('missing', false)], 0],
    ['optional broken', [c('broken', false)], 0],
    ['optional unknown', [c('unknown', false)], 0],
    ['required gate-closed is not a failure', [c('gate-closed')], 0],
    ['required unsupported-os is not a failure', [c('unsupported-os')], 0],
    ['required unavailable/stopped/skipped/shadowed are not failures', [c('unavailable'), c('stopped'), c('skipped'), c('shadowed')], 0],
    ['empty', [], 0],
  ];
  for (const [label, checks, exit] of cases) {
    it(label, () => assert.equal(commands.doctorExitCode(checks), exit));
  }
});

describe('doctor checks', () => {
  it('every stable id is present exactly once with a well-formed check', async (t) => {
    const fx = world(t);
    const { doc } = await doctor(fx);
    const ids = doc.checks.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, 'ids unique');
    for (const id of STABLE_IDS) assert.ok(ids.includes(id), `missing check ${id}`);
    for (const ch of doc.checks) {
      assert.ok(STATES.has(ch.state), `${ch.id}: state ${ch.state}`);
      assert.equal(typeof ch.required, 'boolean', `${ch.id}.required`);
      assert.ok('detail' in ch && 'remedy' in ch, `${ch.id}: detail/remedy keys`);
    }
  });

  it('healthy darwin-arm64 world → 0', async (t) => {
    const fx = world(t);
    const { code, doc } = await doctor(fx, { platform: 'darwin', arch: 'arm64' });
    assert.equal(code, 0, JSON.stringify(doc.checks.filter((x) => x.state !== 'ok'), null, 1));
    assert.equal(H.checkById(doc, 'telepty.daemon').state, 'ok');
  });

  for (const name of ['telepty', 'devkit', 'brain', 'deliberation']) {
    it(`required component ${name} absent → missing, exit 1`, async (t) => {
      const fx = world(t, { skip: [name] });
      const { code, doc } = await doctor(fx);
      const ch = H.checkById(doc, `component.${name}.install`);
      assert.equal(ch.state, 'missing');
      assert.equal(ch.required, true);
      assert.equal(code, 1);
    });
  }

  it('required component with a bin outside its package → broken, exit 1', async (t) => {
    const fx = world(t, { skip: ['devkit'] });
    H.installBundled(fx, 'devkit', { packageJson: { bin: { 'aigentry-devkit': '../../../escape.js' } } });
    H.write(path.join(fx.meta, 'escape.js'), H.NODE_BIN_SRC);
    const { code, doc } = await doctor(fx);
    assert.equal(H.checkById(doc, 'component.devkit.install').state, 'broken');
    assert.equal(code, 1);
  });

  it('aterm off darwin-arm64 is unsupported-os and does not fail doctor', async (t) => {
    const fx = world(t);
    const { code, doc } = await doctor(fx, { platform: 'linux', arch: 'x64' });
    const ch = H.checkById(doc, 'component.aterm.install');
    assert.equal(ch.state, 'unsupported-os');
    assert.equal(code, 0, JSON.stringify(doc.checks.filter((x) => x.state !== 'ok'), null, 1));
  });

  it('aterm is optional (SPEC §5 "aterm opt"): a broken aterm on darwin-arm64 does not fail doctor', async (t) => {
    const fx = world(t, { skip: ['aterm'] });
    H.installBundled(fx, 'aterm', { noNativeApp: true });
    const { code, doc } = await doctor(fx, { platform: 'darwin', arch: 'arm64' });
    const ch = H.checkById(doc, 'component.aterm.install');
    assert.equal(ch.required, false, 'aterm install check is optional');
    assert.equal(code, 0);
  });

  it('orchestrator not on PATH is optional and does not fail doctor', async (t) => {
    const fx = world(t);
    const { code, doc } = await doctor(fx);
    const ch = H.checkById(doc, 'component.orchestrator.install');
    assert.equal(ch.required, false);
    assert.notEqual(ch.state, 'ok');
    assert.notEqual(H.checkById(doc, 'orchestrator.workspace').required, true);
    assert.equal(code, 0);
  });

  it('a required check that cannot be decided (auth probe timed out) → 7', async (t) => {
    const fx = world(t);
    const { code, doc } = await doctor(fx, { http: routes({ meta: H.P.timeout(), sessions: H.P.timeout() }) });
    const auth = H.checkById(doc, 'telepty.auth');
    assert.equal(auth.state, 'unknown');
    assert.equal(auth.required, true, 'auth is required while the daemon runs');
    assert.equal(code, 7);
  });

  it('human doctor output uses the same exit code as --json', async (t) => {
    const fx = world(t, { skip: ['brain'] });
    const h = H.makeRt(fx, { http: routes() });
    assert.equal(await h.run(['doctor']), 1);
    assert.ok(h.stdout().length > 0);
  });

  it('status stays 0 where doctor says 1', async (t) => {
    const fx = world(t, { skip: ['telepty', 'devkit'] });
    const h = H.makeRt(fx, { http: routes() });
    assert.equal(await h.run(['status']), 0);
  });

  it('agent context is reported from env only (no ps) and never fails doctor', async (t) => {
    const fx = world(t);
    const { doc } = await doctor(fx, { env: { TELEPTY_SESSION_ID: 'sess-x' } });
    const ch = H.checkById(doc, 'lifecycle.agent-context');
    assert.equal(ch.required, false);
  });
});

describe('version compatibility against package declarations', () => {
  const declared = JSON.parse(fs.readFileSync(path.join(H.REPO, 'package.json'), 'utf8'));

  for (const [ver, ok] of [['20.10.0', false], ['18.19.1', false], ['20.11.0', true], ['22.11.0', true]]) {
    it(`node ${ver} against engines ${declared.engines && declared.engines.node} → ${ok ? 'ok' : 'fail'}`, async (t) => {
      const fx = world(t);
      const { code, doc } = await doctor(fx, { nodeVersion: ver });
      const ch = H.checkById(doc, 'node.engine');
      assert.equal(ch.required, true);
      if (ok) assert.equal(ch.state, 'ok');
      else { assert.notEqual(ch.state, 'ok'); assert.equal(code, 1); }
    });
  }

  it('an old bundled telepty is reported with its real version, not the declared range', async (t) => {
    const fx = world(t, { versions: { telepty: '0.6.6' } });
    const h = H.makeRt(fx, { http: routes({ health: H.healthy('0.6.6') }) });
    assert.equal(await h.run(['status', '--json']), 0);
    const doc = H.parseOneJson(h.stdout());
    const row = doc.components.find((c) => c.name === 'telepty');
    assert.equal(row.version, '0.6.6');
    assert.equal(row.installed, true);
    const d = await doctor(fx, { http: routes({ health: H.healthy('0.6.6') }) });
    const inst = H.checkById(d.doc, 'component.telepty.install');
    assert.notEqual(inst.state, 'missing');
    assert.match(JSON.stringify(inst), /0\.6\.6/);
    const daemon = H.checkById(d.doc, 'telepty.daemon');
    assert.notEqual(daemon.state, 'stopped');
    assert.match(JSON.stringify(daemon), /0\.6\.6/, 'the running daemon version is reported');
  });

  it('every component row carries the installed package version', async (t) => {
    const fx = world(t, { versions: { devkit: '0.1.99', brain: '0.3.7' } });
    const h = H.makeRt(fx, { http: routes() });
    await h.run(['status', '--json']);
    const doc = H.parseOneJson(h.stdout());
    const by = Object.fromEntries(doc.components.map((c) => [c.name, c]));
    assert.equal(by.devkit.version, '0.1.99');
    assert.equal(by.brain.version, '0.3.7');
    assert.equal(by.deliberation.version, '0.0.47');
  });
});

// ── R2 regressions (REVIEW-R1 B5, B6, B10, S2, S7; CONTROLLER-R2) ──────────────────────────────
const POSIX_ONLY = H.HOST_IS_WIN ? 'POSIX PATH layout; exercised natively on the Linux/macOS runners' : false;
const componentChecks = (doc, name) => doc.checks.filter((c) => c.id.startsWith(`component.${name}.`));
const rangeOf = (name) => JSON.parse(fs.readFileSync(path.join(H.REPO, 'package.json'), 'utf8')).dependencies[H.COMPONENTS[name].pkg];

describe('R2: version compatibility uses the meta package ranges with 0.x caret semantics (B5)', () => {
  const incompatible = [
    ['telepty', '0.6.6'], ['telepty', '0.9.0'], ['devkit', '0.2.0'], ['brain', '1.0.0'], ['deliberation', '0.0.48'],
  ];
  for (const [name, ver] of incompatible) {
    it(`required ${name} ${ver} outside ${rangeOf(name)} → broken, exit 1, detail names version and range`, async (t) => {
      const fx = world(t, { versions: { [name]: ver } });
      const { code, doc } = await doctor(fx);
      const bad = componentChecks(doc, name).filter((c) => c.required && c.state === 'broken');
      assert.ok(bad.length > 0, JSON.stringify(componentChecks(doc, name)));
      assert.ok(bad.some((c) => JSON.stringify(c).includes(ver) && JSON.stringify(c).includes(rangeOf(name))), JSON.stringify(bad));
      assert.equal(code, 1);
    });
  }

  for (const [name, ver] of [['devkit', '0.1.99'], ['telepty', '0.8.9'], ['brain', '0.3.7']]) {
    it(`${name} ${ver} inside ${rangeOf(name)} → no failing version check, exit 0`, async (t) => {
      const fx = world(t, { versions: { [name]: ver } });
      const { code, doc } = await doctor(fx);
      assert.equal(code, 0, JSON.stringify(doc.checks.filter((c) => c.state !== 'ok'), null, 1));
    });
  }

  it('a malformed required version is unknown → 7, never ok', async (t) => {
    const fx = world(t, { versions: { telepty: 'banana' } });
    const { code, doc } = await doctor(fx);
    assert.ok(componentChecks(doc, 'telepty').some((c) => c.required && c.state === 'unknown'), JSON.stringify(componentChecks(doc, 'telepty')));
    assert.equal(code, 7);
  });

  it('an optional component outside its range is advisory only (aterm 0.3.0) → exit 0', async (t) => {
    const fx = world(t, { versions: { aterm: '0.3.0' } });
    const { code, doc } = await doctor(fx, { platform: 'darwin', arch: 'arm64' });
    assert.ok(componentChecks(doc, 'aterm').every((c) => !c.required));
    assert.equal(code, 0);
  });

  it('PATH telepty 0.7.1 shadowing bundled 0.8.5 → broken exit 1, both versions visible', { skip: POSIX_ONLY }, async (t) => {
    const fx = world(t, { selfOnPath: false });
    const p = H.installOnPathDirect(fx, 'telepty', { spec: { version: '0.7.1', bin: { telepty: 'bin/telepty' } } });
    const { code, doc } = await doctor(fx, { env: { PATH: p.binDirs.join(path.delimiter) } });
    const text = JSON.stringify(componentChecks(doc, 'telepty'));
    assert.match(text, /0\.7\.1/);
    assert.match(text, /0\.8\.5/, 'the shadowed bundled version is visible');
    assert.equal(code, 1);
  });

  it('skew alone is advisory: PATH 0.8.9 + bundled 0.8.5 → exit 0, both visible', { skip: POSIX_ONLY }, async (t) => {
    const fx = world(t, { selfOnPath: false });
    const p = H.installOnPathDirect(fx, 'telepty', { spec: { version: '0.8.9', bin: { telepty: 'bin/telepty' } } });
    const { code, doc } = await doctor(fx, { env: { PATH: p.binDirs.join(path.delimiter) } });
    const text = JSON.stringify(componentChecks(doc, 'telepty'));
    assert.match(text, /0\.8\.9/);
    assert.match(text, /0\.8\.5/);
    assert.equal(code, 0);
  });

  for (const daemonVer of ['0.8.4', '0.8.9']) {
    it(`daemon v${daemonVer} vs CLI 0.8.5 is visible and advisory → exit 0`, async (t) => {
      const fx = world(t);
      const { code, doc } = await doctor(fx, { http: routes({ health: H.healthy(daemonVer), meta: H.P.ok({ version: daemonVer, pid: 100, port: H.DEFAULT_PORT }) }) });
      assert.match(JSON.stringify(doc.checks.filter((c) => c.id.startsWith('telepty.'))), new RegExp(daemonVer.replace(/\./g, '\\.')));
      assert.equal(code, 0);
    });
  }
});

describe('R2: auth and aterm/logger optionality (S7, B6, S2)', () => {
  it('daemon known alive with no token → telepty.auth broken, exit 1 (S7)', async (t) => {
    const fx = world(t, { token: false });
    const { code, doc } = await doctor(fx);
    const auth = H.checkById(doc, 'telepty.auth');
    assert.equal(auth.state, 'broken');
    assert.equal(auth.required, true);
    assert.equal(code, 1);
  });

  it('aterm absent on darwin-arm64 → unavailable, optional, exit 0 (B6)', async (t) => {
    const fx = world(t, { skip: ['aterm'] });
    const { code, doc } = await doctor(fx, { platform: 'darwin', arch: 'arm64' });
    const ch = H.checkById(doc, 'component.aterm.install');
    assert.equal(ch.state, 'unavailable');
    assert.equal(ch.required, false);
    assert.equal(code, 0);
  });

  it('logger is an optional registry row: absent → not required, exit 0 (S2)', async (t) => {
    const fx = world(t);
    const { code, doc } = await doctor(fx);
    const ch = H.checkById(doc, 'component.logger.install');
    assert.equal(ch.required, false);
    assert.notEqual(ch.state, 'ok');
    assert.equal(code, 0);
  });

  it('logger on PATH (own package) is reported installed and passed through via execPath (S2)', { skip: POSIX_ONLY }, async (t) => {
    const fx = world(t, { selfOnPath: false });
    const p = H.installOnPathDirect(fx, 'logger');
    const env = { PATH: p.binDirs.join(path.delimiter) };
    const { doc } = await doctor(fx, { env });
    assert.equal(H.checkById(doc, 'component.logger.install').state, 'ok');
    const h = H.makeRt(fx, { env, procs: H.makeProcs(() => ({ status: 5 })) });
    assert.equal(await h.run(['logger', 'tail', '--n', '3']), 5);
    assert.equal(h.rec.procs.length, 1);
    assert.equal(h.rec.procs[0].cmd, H.FAKE_NODE);
    assert.equal(fs.realpathSync(h.rec.procs[0].args[0]), fs.realpathSync(p.file('aigentry-logger')));
    assert.deepEqual(h.rec.procs[0].args.slice(1), ['tail', '--n', '3']);
  });
});

describe('R2: one global doctor budget (B10)', () => {
  // Timed-out probes consume their whole timeout on the injected clock, as a real hung daemon would.
  function budgetRoutes(hRef, over) {
    const spend = (opts) => { hRef.h.advance(opts.timeoutMs); return H.P.timeout(); };
    return H.fakeDaemon(Object.assign({ health: H.healthy(), meta: spend, sessions: spend }, over));
  }

  for (const [argv, budget] of [[['doctor', '--json', '--timeout', '2000'], 2000], [['doctor', '--json'], 10000]]) {
    it(`${argv.slice(1).join(' ')}: each probe ≤ 1500 ms, total ≤ ${budget} ms, health probed once, exit 7`, { skip: POSIX_ONLY }, async (t) => {
      const fx = world(t, { selfOnPath: false });
      const orch = H.installOnPathDirect(fx, 'orchestrator');
      const hRef = {};
      const h = H.makeRt(fx, { env: { PATH: orch.binDirs.join(path.delimiter) }, http: budgetRoutes(hRef, {}) });
      hRef.h = h;
      const t0 = h.clock;
      const code = await h.run(argv);
      for (const c of h.rec.http) assert.ok(c.timeoutMs > 0 && c.timeoutMs <= 1500, `${c.path} timeout ${c.timeoutMs}`);
      assert.ok(h.clock - t0 <= budget, `spent ${h.clock - t0} ms of a ${budget} ms budget`);
      assert.equal(h.rec.http.filter((c) => c.path === '/api/health').length, 1, 'health result is reused');
      assert.equal(code, 7);
    });
  }

  it('an exhausted budget leaves required checks unknown (7), never ok or absent', async (t) => {
    const fx = world(t);
    const hRef = {};
    const spendAll = (opts) => { hRef.h.advance(opts.timeoutMs); return H.P.timeout(); };
    const h = H.makeRt(fx, { http: H.fakeDaemon({ health: spendAll, meta: spendAll, sessions: spendAll }) });
    hRef.h = h;
    const code = await h.run(['doctor', '--json', '--timeout', '1000']);
    const doc = H.parseOneJson(h.stdout());
    assert.equal(H.checkById(doc, 'telepty.daemon').state, 'unknown');
    assert.equal(code, 7);
    assert.ok(h.rec.http.every((c) => c.timeoutMs <= 1000));
  });
});
