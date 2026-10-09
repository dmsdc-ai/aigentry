'use strict';
// Area 2: status/doctor are write-free and subprocess-free; bounded HTTP states never read as "absent";
// exactly one JSON document; no secret or env value in any output.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers/fixture');

const ALLOWED_PATHS = new Set(['/api/health', '/api/meta', '/api/sessions']);
const POSIX_ONLY = H.HOST_IS_WIN ? 'POSIX PATH layout; exercised natively on the Linux/macOS runners' : false;

function healthyWorld(t, { token = 'config', platform } = {}) {
  const fx = H.makeFixture(t);
  H.installAllBundled(fx);
  if (token === 'config') H.writeTeleptyConfig(fx);
  if (!H.HOST_IS_WIN && platform !== 'win32') fs.symlinkSync(path.join(fx.meta, 'bin', 'aigentry.js'), path.join(fx.pathDir, 'aigentry'));
  return fx;
}

const healthyRoutes = (over = {}) => H.fakeDaemon(Object.assign({
  health: H.healthy(),
  meta: H.P.ok({ name: 'telepty', version: '0.8.5', pid: 100, port: H.DEFAULT_PORT }),
  sessions: H.P.ok([]),
}, over));

async function trapped(fx, opts, argv) {
  const before = H.snapshotTree(fx.root);
  const { result: h, violations } = await H.withSideEffectTrap(async () => {
    const hh = H.makeRt(fx, opts);
    hh.code = await hh.run(argv);
    return hh;
  });
  return { h, code: h.code, violations, before, after: H.snapshotTree(fx.root) };
}

function assertReadOnly(r, label) {
  assert.deepEqual(r.violations, [], `${label}: side-effect trap fired`);
  assert.deepEqual(r.h.rec.procs, [], `${label}: rt.spawn/spawnSync must not be called`);
  assert.deepEqual(r.after, r.before, `${label}: fixture tree (bytes, modes, mtimes) must be unchanged`);
  for (const c of r.h.rec.http) {
    assert.ok(ALLOWED_PATHS.has(c.path), `${label}: unexpected path ${c.path}`);
    assert.ok(c.host === undefined || c.host === '127.0.0.1', `${label}: loopback only`);
    assert.ok(Number.isFinite(c.timeoutMs) && c.timeoutMs > 0, `${label}: http timeout must be bounded`);
    assert.ok(Number.isFinite(c.maxBytes) && c.maxBytes > 0, `${label}: http body must be bounded`);
  }
}

function assertNoSecrets(text, label) {
  assert.ok(!text.includes(H.TOKEN), `${label}: token leaked`);
  assert.ok(!text.includes(H.ENV_SENTINEL), `${label}: env value leaked`);
}

describe('status and doctor are side-effect free', () => {
  const cases = [[], ['status'], ['status', '--json'], ['--json'], ['doctor'], ['doctor', '--json']];
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const argv of cases) {
      it(`${platform}: aigentry ${argv.join(' ') || '(no args)'}`, async (t) => {
        const fx = healthyWorld(t, { platform });
        const r = await trapped(fx, { platform, arch: platform === 'darwin' ? 'arm64' : 'x64', http: healthyRoutes() }, argv);
        assertReadOnly(r, argv.join(' '));
        if (argv[0] !== 'doctor') assert.equal(r.code, 0, 'status always exits 0');
        assertNoSecrets(r.h.all(), argv.join(' '));
        if (argv.includes('--json')) H.parseOneJson(r.h.stdout());
      });
    }
  }

  it('status exits 0 in a fully broken world and still writes nothing', async (t) => {
    const fx = H.makeFixture(t);
    H.write(path.join(fx.home, '.telepty', 'config.json'), '{not json');
    const r = await trapped(fx, {
      http: H.fakeDaemon({ health: H.P.timeout(), meta: H.P.answered(401), sessions: H.P.malformed() }),
    }, ['status', '--json']);
    assertReadOnly(r, 'broken status');
    assert.equal(r.code, 0);
    const doc = H.parseOneJson(r.h.stdout());
    assert.equal(doc.schema, H.STATUS_SCHEMA);
  });

  it('no token anywhere → only /api/health is called and ~/.telepty is not minted', async (t) => {
    const fx = healthyWorld(t, { token: 'none' });
    for (const argv of [['status', '--json'], ['doctor', '--json']]) {
      const r = await trapped(fx, { http: healthyRoutes() }, argv);
      assertReadOnly(r, argv[0]);
      assert.deepEqual([...new Set(r.h.rec.http.map((c) => c.path))], ['/api/health']);
      assert.equal(fs.existsSync(path.join(fx.home, '.telepty')), false);
    }
  });

  it('a bad --port keeps status at 0 with telepty checks unknown and no probe', async (t) => {
    const fx = healthyWorld(t);
    const r = await trapped(fx, { http: healthyRoutes() }, ['status', '--json', '--port', 'nope']);
    assertReadOnly(r, 'bad port');
    assert.equal(r.code, 0);
    assert.equal(r.h.rec.http.length, 0);
    const doc = H.parseOneJson(r.h.stdout());
    assert.equal(H.checkById(doc, 'telepty.daemon').state, 'unknown');
  });

  it('a bad TELEPTY_PORT makes doctor telepty checks unknown, never stopped', async (t) => {
    const fx = healthyWorld(t);
    const r = await trapped(fx, { env: { TELEPTY_PORT: '99999' }, http: healthyRoutes() }, ['doctor', '--json']);
    assertReadOnly(r, 'bad env port');
    assert.equal(r.h.rec.http.length, 0);
    const doc = H.parseOneJson(r.h.stdout());
    assert.equal(H.checkById(doc, 'telepty.daemon').state, 'unknown');
    assert.equal(r.code, r.h.lib.commands.doctorExitCode(doc.checks));
  });

  it('--timeout bounds every probe', async (t) => {
    const fx = healthyWorld(t);
    const r = await trapped(fx, { http: healthyRoutes() }, ['doctor', '--json', '--timeout', '400']);
    assertReadOnly(r, 'timeout');
    assert.ok(r.h.rec.http.length > 0);
    for (const c of r.h.rec.http) assert.ok(c.timeoutMs <= 400, `probe ${c.path} timeout ${c.timeoutMs} > budget`);
  });
});

describe('bounded HTTP states are never "absent"', () => {
  const unknownHealth = {
    timeout: H.P.timeout(),
    malformed: H.P.malformed(),
    'answered 401': H.P.answered(401),
    'answered 500': H.P.answered(500),
    'error ECONNRESET': H.P.error('ECONNRESET'),
    'error EHOSTUNREACH': H.P.error('EHOSTUNREACH'),
    'ok but foreign body': H.P.ok({ hello: 'world' }),
  };
  for (const [label, probe] of Object.entries(unknownHealth)) {
    it(`/api/health ${label} → telepty.daemon unknown in status and doctor`, async (t) => {
      const fx = healthyWorld(t);
      for (const argv of [['status', '--json'], ['doctor', '--json']]) {
        const r = await trapped(fx, { http: healthyRoutes({ health: probe }) }, argv);
        assertReadOnly(r, label);
        const doc = H.parseOneJson(r.h.stdout());
        const c = H.checkById(doc, 'telepty.daemon');
        assert.equal(c.state, 'unknown', `${argv[0]}: ${label} must be unknown, got ${c.state}`);
      }
    });
  }

  it('/api/health ECONNREFUSED (the only absence) → stopped', async (t) => {
    const fx = healthyWorld(t);
    const r = await trapped(fx, { http: healthyRoutes({ health: H.P.refused() }) }, ['status', '--json']);
    assertReadOnly(r, 'refused');
    assert.equal(H.checkById(H.parseOneJson(r.h.stdout()), 'telepty.daemon').state, 'stopped');
  });

  it('/api/meta 401 keeps the daemon alive and fails auth (credential refused, not absent)', async (t) => {
    const fx = healthyWorld(t);
    const r = await trapped(fx, { http: healthyRoutes({ meta: H.P.answered(401), sessions: H.P.answered(401) }) }, ['doctor', '--json']);
    assertReadOnly(r, 'meta 401');
    const doc = H.parseOneJson(r.h.stdout());
    assert.notEqual(H.checkById(doc, 'telepty.daemon').state, 'stopped');
    const auth = H.checkById(doc, 'telepty.auth');
    assert.notEqual(auth.state, 'ok');
    assert.notEqual(auth.state, 'stopped');
    assert.notEqual(r.code, 0);
    assertNoSecrets(r.h.all(), 'meta 401');
  });

  for (const [label, probe] of Object.entries({ timeout: H.P.timeout(), 'answered 401': H.P.answered(401), malformed: H.P.malformed(), 'ok non-array': H.P.ok({ sessions: 'nope' }) })) {
    it(`/api/sessions ${label} → orchestrator.session unknown`, { skip: POSIX_ONLY }, async (t) => {
      const fx = healthyWorld(t);
      const orch = H.installOnPathDirect(fx, 'orchestrator');
      const env = { PATH: [...orch.binDirs, fx.pathDir].join(path.delimiter) };
      const r = await trapped(fx, { env, http: healthyRoutes({ sessions: probe }) }, ['doctor', '--json']);
      assertReadOnly(r, label);
      assert.equal(H.checkById(H.parseOneJson(r.h.stdout()), 'orchestrator.session').state, 'unknown');
    });
  }
});

describe('one JSON document, no secrets', () => {
  it('status --json document shape', async (t) => {
    const fx = healthyWorld(t);
    const r = await trapped(fx, { http: healthyRoutes() }, ['status', '--json']);
    const doc = H.parseOneJson(r.h.stdout());
    assert.equal(doc.schema, H.STATUS_SCHEMA);
    assert.equal(doc.platform, 'darwin');
    assert.equal(doc.arch, 'arm64');
    assert.equal(doc.port, H.DEFAULT_PORT);
    assert.equal(doc.version, JSON.parse(fs.readFileSync(path.join(H.REPO, 'package.json'), 'utf8')).version);
    const names = doc.components.map((c) => c.name);
    for (const n of H.BUNDLED) assert.ok(names.includes(n), `component ${n} listed`);
    for (const c of doc.components) {
      for (const k of ['name', 'package', 'required', 'installed', 'version', 'source', 'onPath', 'supported']) assert.ok(k in c, `${c.name}.${k}`);
    }
    const telepty = doc.components.find((c) => c.name === 'telepty');
    assert.equal(telepty.installed, true);
    assert.equal(telepty.source, 'bundled');
    assert.equal(telepty.version, '0.8.5');
    assert.ok(Array.isArray(doc.checks));
  });

  it('doctor --json document shape and self-consistent exit code', async (t) => {
    const fx = healthyWorld(t);
    const r = await trapped(fx, { http: healthyRoutes() }, ['doctor', '--json']);
    const doc = H.parseOneJson(r.h.stdout());
    assert.equal(doc.schema, H.DOCTOR_SCHEMA);
    assert.equal(doc.exitCode, r.code);
    assert.equal(doc.port, H.DEFAULT_PORT);
    assert.equal(r.code, r.h.lib.commands.doctorExitCode(doc.checks));
  });

  for (const where of ['env', 'config']) {
    it(`token from ${where} is sent only as the token field and never printed`, async (t) => {
      const fx = healthyWorld(t, { token: where === 'config' ? 'config' : 'none' });
      const env = where === 'env' ? { TELEPTY_AUTH_TOKEN: H.TOKEN } : {};
      for (const argv of [['status'], ['status', '--json'], ['doctor'], ['doctor', '--json']]) {
        const r = await trapped(fx, { env, http: healthyRoutes() }, argv);
        assertReadOnly(r, argv.join(' '));
        assertNoSecrets(r.h.all(), argv.join(' '));
        const authed = r.h.rec.http.filter((c) => c.path !== '/api/health');
        if (argv[0] === 'status') {
          // R2 (SEC-A): status is health-only and never sends the token.
          assert.deepEqual(authed, [], 'status calls only /api/health');
          assert.ok(r.h.rec.http.every((c) => !c.token), 'status sends no token');
        } else {
          assert.ok(authed.length > 0, 'doctor uses the authenticated endpoints when a token exists');
        }
        for (const c of authed) assert.equal(c.token, H.TOKEN);
        for (const c of r.h.rec.http) assert.ok(!String(c.path).includes(H.TOKEN), 'token never in the URL');
      }
    });
  }
});

// ── R2 regressions (SECURITY-R1 SEC-A, CONTROLLER-R2: status is health-only) ─────────────────
describe('R2: status never measures auth or sessions; it says so (SEC-A)', () => {
  it('with a token and a running daemon, status sends no token and reports auth/session as unmeasured with a doctor remedy', { skip: POSIX_ONLY }, async (t) => {
    const fx = healthyWorld(t);
    const orch = H.installOnPathDirect(fx, 'orchestrator');
    const env = { PATH: [...orch.binDirs, fx.pathDir].join(path.delimiter), TELEPTY_AUTH_TOKEN: H.TOKEN };
    const sessions = H.P.ok([{ id: 'orchestrator', type: 'wrapped', healthStatus: 'CONNECTED', ownerPid: 1 }]);
    const r = await trapped(fx, { env, http: healthyRoutes({ sessions }) }, ['status', '--json']);
    assertReadOnly(r, 'status');
    assert.equal(r.code, 0);
    assert.deepEqual(r.h.rec.http.map((c) => c.path), ['/api/health']);
    assert.ok(r.h.rec.http.every((c) => !c.token));
    const doc = H.parseOneJson(r.h.stdout());
    for (const id of ['telepty.auth', 'orchestrator.session']) {
      const c = H.checkById(doc, id);
      assert.notEqual(c.state, 'ok', `${id} must not be a fictional pass`);
      assert.match(`${c.detail} ${c.remedy}`, /doctor/, `${id} points at aigentry doctor`);
    }
    assertNoSecrets(r.h.all(), 'status');
  });

  it('doctor probes /api/health exactly once even with the orchestrator installed (health is reused)', { skip: POSIX_ONLY }, async (t) => {
    const fx = healthyWorld(t);
    const orch = H.installOnPathDirect(fx, 'orchestrator');
    const env = { PATH: [...orch.binDirs, fx.pathDir].join(path.delimiter) };
    const r = await trapped(fx, { env, http: healthyRoutes() }, ['doctor', '--json']);
    assertReadOnly(r, 'doctor');
    assert.equal(r.h.rec.http.filter((c) => c.path === '/api/health').length, 1);
  });
});
