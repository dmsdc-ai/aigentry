'use strict';
// Area 6: telepty supervisor and exact-port separation, idempotent start, unknown health refuses,
// session preview and --yes, restart lease (conflict / stale / own-cleanup) and PID-change confirmation.
// Everything goes through injected http/fs/runtime: no live daemon, no service manager, no user home.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers/fixture');

const PS_CLEAN = '  PID  PPID COMMAND\n    1     0 /sbin/launchd\n 4241     1 -zsh\n 4242  4241 node /x/aigentry restart telepty\n';
const POSIX_ONLY = H.HOST_IS_WIN ? 'needs POSIX file modes' : false;
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

function plist(port) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.aigentry.telepty</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>/usr/local/lib/node_modules/@dmsdc-ai/aigentry-telepty/daemon.js</string></array>
<key>EnvironmentVariables</key><dict><key>TELEPTY_PORT</key><string>${port}</string></dict>
<key>KeepAlive</key><true/><key>RunAtLoad</key><true/>
</dict></plist>
`;
}

function unit(port) {
  return `[Unit]\nDescription=telepty daemon\n\n[Service]\nExecStart=/usr/bin/node /usr/lib/node_modules/@dmsdc-ai/aigentry-telepty/daemon.js\nEnvironment=TELEPTY_PORT=${port}\nRestart=always\n\n[Install]\nWantedBy=default.target\n`;
}

function setup(t, { token = true, launchd, systemdUser } = {}) {
  const fx = H.makeFixture(t);
  H.installAllBundled(fx);
  if (token) H.writeTeleptyConfig(fx);
  if (launchd) H.write(path.join(fx.home, 'Library', 'LaunchAgents', 'com.aigentry.telepty.plist'), plist(launchd));
  if (systemdUser) H.write(path.join(fx.home, '.config', 'systemd', 'user', 'telepty.service'), unit(systemdUser));
  fx.cli = path.join(H.pkgDir(fx.meta, H.COMPONENTS.telepty.pkg), 'cli.js');
  fx.lease = path.join(fx.home, '.telepty', 'restart.lease');
  fx.log = path.join(fx.home, '.telepty', 'logs', 'daemon-restart.log');
  return fx;
}

// A stateful fake daemon + process table. `onAction(call, state)` may override what an action does.
function world(fx, o = {}) {
  const state = { up: o.up ?? false, pid: 100, healthOverride: o.health, metaOverride: null, sessions: o.sessions ?? H.P.ok([]), actions: [], tools: [] };
  const http = H.fakeDaemon({
    health: () => state.healthOverride || (state.up ? H.healthy() : H.P.refused()),
    meta: () => state.metaOverride || (state.up ? H.P.ok({ name: 'telepty', version: '0.8.5', pid: state.pid, port: o.port || H.DEFAULT_PORT }) : H.P.refused()),
    sessions: () => state.sessions,
  });
  const procs = H.makeProcs((call) => {
    const b = H.base(call.cmd);
    if (call.cmd !== H.FAKE_NODE) state.tools.push(call);
    if (b === 'ps') return { status: 0, stdout: o.ps || PS_CLEAN };
    state.actions.push(call);
    if (o.onAction) {
      const r = o.onAction(call, state);
      if (r) return r;
    }
    const a = call.args.join(' ');
    if (call.cmd === H.FAKE_NODE && a === `${fx.cli} daemon start`) { state.up = true; return { status: 0 }; }
    if (call.cmd === H.FAKE_NODE && a === `${fx.cli} daemon restart`) { state.up = true; state.pid = 200; return { status: 0 }; }
    if (call.cmd === H.FAKE_NODE && a === `${fx.cli} daemon stop`) { state.up = false; return { status: 0 }; }
    if (b === 'launchctl' && call.args[0] === 'kickstart') {
      if (call.args[1] === '-k') state.pid = 200;
      state.up = true;
      return { status: 0 };
    }
    if (b === 'systemctl') {
      if (call.args.includes('restart')) state.pid = 200;
      state.up = true;
      return { status: 0 };
    }
    throw new Error(`unexpected process ${call.cmd} ${a}`);
  });
  // R2 (REVIEW B7): win32 runs carry a drive-absolute SystemRoot, as a real Windows env does.
  const env = Object.assign(o.platform === 'win32' ? { SystemRoot: H.WIN_SYSTEMROOT } : {}, o.env);
  const h = H.makeRt(fx, Object.assign({ http, procs, platform: o.platform || 'darwin', arch: 'arm64', env, tty: o.tty, prompt: o.prompt }, o.rt));
  h.state = state;
  return h;
}

const actions = (h) => h.state.actions.map((c) => `${H.base(c.cmd) === H.base(H.FAKE_NODE) ? 'node' : H.base(c.cmd)} ${c.args.map((a) => (a.endsWith('cli.js') ? '<cli>' : a)).join(' ')}`);
const totalSleep = (h) => h.rec.sleeps.reduce((a, b) => a + b, 0);

function assertLifecycleChild(c, port) {
  assert.equal(c.opts.shell, false);
  assert.ok(!c.opts.detached, 'never detached');
  if (c.cmd === H.FAKE_NODE) {
    assert.equal(c.opts.env.TELEPTY_PORT, String(port));
    assert.ok(!('TELEPTY_HOST' in c.opts.env), 'TELEPTY_HOST removed');
  }
}

describe('start telepty', () => {
  it('running → 0 without any process, twice (idempotent)', async (t) => {
    const fx = setup(t);
    for (let i = 0; i < 2; i++) {
      const h = world(fx, { up: true });
      assert.equal(await h.run(['start', 'telepty']), 0);
      assert.deepEqual(actions(h), []);
    }
  });

  it('start telepty is allowed inside an agent context', async (t) => {
    const fx = setup(t);
    const h = world(fx, { env: { TELEPTY_SESSION_ID: 'sess-1' } });
    assert.equal(await h.run(['start', 'telepty']), 0);
    assert.deepEqual(actions(h), ['node <cli> daemon start']);
  });

  const unknowns = { timeout: H.P.timeout(), malformed: H.P.malformed(), 'answered 500': H.P.answered(500), 'answered 401': H.P.answered(401), 'error ECONNRESET': H.P.error(), 'foreign 200': H.P.ok({ server: 'nginx' }) };
  for (const [label, probe] of Object.entries(unknowns)) {
    it(`health ${label} → 1 and nothing is started`, async (t) => {
      const fx = setup(t, { launchd: 3848 });
      const h = world(fx, { health: probe });
      assert.equal(await h.run(['start', 'telepty']), 1);
      assert.deepEqual(actions(h), []);
    });
  }

  for (const platform of ['darwin', 'linux']) {
    it(`${platform}: stopped and unsupervised → telepty daemon start with TELEPTY_PORT, then health poll`, async (t) => {
      const fx = setup(t);
      const h = world(fx, { platform, env: { TELEPTY_HOST: '0.0.0.0' } });
      assert.equal(await h.run(['start']), 0);
      assert.deepEqual(actions(h), ['node <cli> daemon start']);
      assertLifecycleChild(h.state.actions[0], 3848);
      const after = h.rec.http.slice(h.rec.http.findIndex((c) => c.path === '/api/health') + 1);
      assert.ok(after.some((c) => c.path === '/api/health'), 'health polled after the start');
    });
  }

  it('--port reaches the child env and every probe', async (t) => {
    const fx = setup(t);
    const h = world(fx, { port: 4000 });
    assert.equal(await h.run(['start', 'telepty', '--port', '4000']), 0);
    assertLifecycleChild(h.state.actions[0], 4000);
    assert.ok(h.rec.http.every((c) => c.port === 4000));
  });

  it('daemon never answers → 1 within the ~8 s poll budget', async (t) => {
    const fx = setup(t);
    const h = world(fx, { onAction: () => ({ status: 0 }) });
    assert.equal(await h.run(['start', 'telepty']), 1);
    assert.ok(totalSleep(h) > 0 && totalSleep(h) <= 10000, `slept ${totalSleep(h)} ms`);
  });

  it('launchd agent for this port → kickstart, never daemon start', async (t) => {
    const fx = setup(t, { launchd: 3848 });
    const h = world(fx);
    assert.equal(await h.run(['start', 'telepty']), 0);
    assert.deepEqual(actions(h), ['launchctl kickstart gui/501/com.aigentry.telepty']);
    assertLifecycleChild(h.state.actions[0], 3848);
  });

  it('exact-port separation: a launchd agent for 3848 does not serve --port 4000', async (t) => {
    const fx = setup(t, { launchd: 3848 });
    const h = world(fx, { port: 4000 });
    assert.equal(await h.run(['start', 'telepty', '--port', '4000']), 0);
    assert.deepEqual(actions(h), ['node <cli> daemon start']);
    assertLifecycleChild(h.state.actions[0], 4000);
  });

  it('exact-port separation: a launchd agent for 4000 does not serve the default port', async (t) => {
    const fx = setup(t, { launchd: 4000 });
    const h = world(fx);
    assert.equal(await h.run(['start', 'telepty']), 0);
    assert.deepEqual(actions(h), ['node <cli> daemon start']);
  });

  it('systemd --user unit for this port → systemctl --user start telepty', async (t) => {
    const fx = setup(t, { systemdUser: 3848 });
    const h = world(fx, { platform: 'linux' });
    assert.equal(await h.run(['start', 'telepty']), 0);
    assert.deepEqual(actions(h), ['systemctl --user start telepty']);
  });

  it('a failing supervisor command → 1 with no fallback daemon start (no orphan race)', async (t) => {
    const fx = setup(t, { launchd: 3848 });
    const h = world(fx, { onAction: (c) => (H.base(c.cmd) === 'launchctl' ? { status: 1, stderr: 'Could not find service' } : null) });
    assert.equal(await h.run(['start', 'telepty']), 1);
    assert.deepEqual(actions(h), ['launchctl kickstart gui/501/com.aigentry.telepty']);
  });

  describe('win32 (simulated; native run is the Windows CI job)', () => {
    const SCHTASKS_FOUND = 'Folder: \\\r\nHostName:      PC\r\nTaskName:      \\telepty-daemon\r\nNext Run Time: N/A\r\nStatus:        Ready\r\n';
    it('scheduled task present → schtasks /run /tn telepty-daemon', async (t) => {
      const fx = setup(t);
      const h = world(fx, {
        platform: 'win32',
        onAction: (c, s) => {
          if (H.base(c.cmd) !== 'schtasks') return null;
          if (c.args.includes('/query')) return { status: 0, stdout: SCHTASKS_FOUND };
          if (c.args.includes('/run')) { s.up = true; return { status: 0 }; }
          return null;
        },
      });
      assert.equal(await h.run(['start', 'telepty']), 0);
      const run = h.state.actions.find((c) => H.base(c.cmd) === 'schtasks' && c.args.includes('/run'));
      assert.ok(run, `actions: ${actions(h).join(' | ')}`);
      assert.deepEqual(run.args.slice(run.args.indexOf('/run')), ['/run', '/tn', 'telepty-daemon']);
      assert.ok(!actions(h).includes('node <cli> daemon start'));
      for (const c of h.state.actions) assertLifecycleChild(c, 3848);
    });

    it('no scheduled task → telepty daemon start', async (t) => {
      const fx = setup(t);
      const h = world(fx, {
        platform: 'win32',
        onAction: (c) => (H.base(c.cmd) === 'schtasks' ? { status: 1, stderr: 'ERROR: The system cannot find the file specified.' } : null),
      });
      assert.equal(await h.run(['start', 'telepty']), 0);
      assert.ok(actions(h).includes('node <cli> daemon start'));
    });
  });
});

describe('restart telepty', () => {
  const at = (h) => h.all();
  const atRisk = () => H.P.ok([
    { id: 'orchestrator', type: 'wrapped', healthStatus: 'CONNECTED', ownerPid: 31337 },
    { id: 's-spawned-1', type: 'spawned', healthStatus: 'CONNECTED', ownerPid: 31338 },
    { id: 's-untyped-2', healthStatus: 'CONNECTED' },
  ]);
  let leaseSample = null;
  const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

  function foreignLease(fx, h, ageMs) {
    const sample = leaseSample || { startedAt: new Date(0).toISOString() };
    const startedAt = typeof sample.startedAt === 'number' ? h.clock - ageMs : new Date(h.clock - ageMs).toISOString();
    const body = JSON.stringify({ pid: 999999, ppid: 999998, port: 3848, verdict: 'aigentry-explicit', startedAt });
    H.write(fx.lease, body);
    return body;
  }

  it('--yes: lease held during the action, one log line, telepty daemon restart, pid change → 0', async (t) => {
    const fx = setup(t);
    let seen = null;
    const h = world(fx, {
      up: true,
      sessions: atRisk(),
      onAction: (c) => {
        seen = { lease: fs.existsSync(fx.lease) ? readJson(fx.lease) : null, log: fs.existsSync(fx.log) ? fs.readFileSync(fx.log, 'utf8') : '' };
        return null;
      },
    });
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 0);
    assert.deepEqual(actions(h), ['node <cli> daemon restart']);
    assertLifecycleChild(h.state.actions[0], 3848);
    assert.ok(seen.lease, 'lease present while the action runs');
    assert.equal(seen.lease.pid, 4242);
    assert.equal(seen.lease.ppid, 4241);
    assert.equal(Number(seen.lease.port), 3848);
    assert.equal(seen.lease.verdict, 'aigentry-explicit');
    assert.ok(seen.lease.startedAt !== undefined);
    leaseSample = seen.lease;
    const lines = seen.log.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'exactly one log line before the action');
    assert.match(lines[0], /stop-initiated/);
    assert.match(lines[0], /aigentry-explicit/);
    assert.match(lines[0], /3848/);
    assert.equal(fs.existsSync(fx.lease), false, 'own lease released');
    assert.ok(!fs.readFileSync(fx.log, 'utf8').includes(H.TOKEN));
    assert.ok(!at(h).includes(H.TOKEN));
  });

  it('isLeaseFresh: a young lease is held, an old one is stale', async (t) => {
    const fx = setup(t);
    const h = world(fx);
    assert.ok(leaseSample, 'needs the lease captured by the --yes test');
    const fresh = Object.assign({}, leaseSample, { startedAt: typeof leaseSample.startedAt === 'number' ? h.clock - 5000 : new Date(h.clock - 5000).toISOString() });
    const stale = Object.assign({}, leaseSample, { startedAt: typeof leaseSample.startedAt === 'number' ? h.clock - 120000 : new Date(h.clock - 120000).toISOString() });
    assert.equal(h.lib.telepty.isLeaseFresh(fresh, h.clock), true);
    assert.equal(h.lib.telepty.isLeaseFresh(stale, h.clock), false);
  });

  it('spawned sessions + non-TTY + no --yes → 4, preview names them, nothing taken or run', async (t) => {
    const fx = setup(t);
    const h = world(fx, { up: true, sessions: atRisk() });
    assert.equal(await h.run(['restart', 'telepty']), 4);
    assert.match(at(h), /s-spawned-1/);
    assert.match(at(h), /s-untyped-2/, 'a row without a type is spawned (at risk)');
    assert.deepEqual(actions(h), []);
    assert.equal(fs.existsSync(fx.lease), false);
    assert.equal(fs.existsSync(fx.log), false);
  });

  for (const [label, sessions] of [['401', H.P.answered(401)], ['timeout', H.P.timeout()], ['malformed', H.P.malformed()]]) {
    it(`sessions ${label} is treated as at risk: non-TTY without --yes → 4`, async (t) => {
      const fx = setup(t);
      const h = world(fx, { up: true, sessions });
      assert.equal(await h.run(['restart', 'telepty']), 4);
      assert.deepEqual(actions(h), []);
      assert.equal(fs.existsSync(fx.lease), false);
    });
  }

  it('TTY answer "n" → 4 and nothing runs; "y" → proceeds', async (t) => {
    const fx = setup(t);
    const no = world(fx, { up: true, sessions: atRisk(), tty: true, prompt: 'n' });
    assert.equal(await no.run(['restart', 'telepty']), 4);
    assert.equal(no.rec.prompts.length, 1);
    assert.deepEqual(actions(no), []);
    assert.equal(fs.existsSync(fx.lease), false);
    const yes = world(fx, { up: true, sessions: atRisk(), tty: true, prompt: 'y' });
    assert.equal(await yes.run(['restart', 'telepty']), 0);
    assert.deepEqual(actions(yes), ['node <cli> daemon restart']);
  });

  it('pid unchanged → 1 (UNCONFIRMED) within the poll budget and the lease is still released', async (t) => {
    const fx = setup(t);
    const h = world(fx, { up: true, onAction: () => ({ status: 0 }) });
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 1);
    assert.ok(totalSleep(h) <= 15000, `slept ${totalSleep(h)} ms`);
    assert.equal(fs.existsSync(fx.lease), false);
  });

  it('the restart action failing → 1 and the lease is released', async (t) => {
    const fx = setup(t);
    const h = world(fx, { up: true, onAction: () => ({ status: 1, stderr: 'boom' }) });
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 1);
    assert.equal(fs.existsSync(fx.lease), false);
  });

  it('launchd-supervised → kickstart -k only', async (t) => {
    const fx = setup(t, { launchd: 3848 });
    const h = world(fx, { up: true });
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 0);
    assert.deepEqual(actions(h), ['launchctl kickstart -k gui/501/com.aigentry.telepty']);
  });

  it('systemd --user supervised → systemctl --user restart telepty only', async (t) => {
    const fx = setup(t, { systemdUser: 3848 });
    const h = world(fx, { up: true, platform: 'linux' });
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 0);
    assert.deepEqual(actions(h), ['systemctl --user restart telepty']);
  });

  it('supervisor for another port → unsupervised daemon restart on the addressed port', async (t) => {
    const fx = setup(t, { launchd: 4000 });
    const h = world(fx, { up: true });
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 0);
    assert.deepEqual(actions(h), ['node <cli> daemon restart']);
  });

  it('a fresh foreign lease → 1; lease untouched; no log, no action', async (t) => {
    const fx = setup(t);
    const h = world(fx, { up: true });
    const body = foreignLease(fx, h, 5000);
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 1);
    assert.equal(fs.readFileSync(fx.lease, 'utf8'), body);
    assert.match(at(h), /999999/);
    assert.equal(fs.existsSync(fx.log), false);
    assert.deepEqual(actions(h), []);
  });

  it('a stale foreign lease is replaced by ours and released afterwards', async (t) => {
    const fx = setup(t);
    let during = null;
    const h = world(fx, { up: true, onAction: () => { during = readJson(fx.lease); return null; } });
    foreignLease(fx, h, 120000);
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 0);
    assert.equal(during.pid, 4242);
    assert.equal(fs.existsSync(fx.lease), false);
  });

  it('only our own lease is released (a lease taken over meanwhile survives)', async (t) => {
    const fx = setup(t);
    let theirs = null;
    const h = world(fx, {
      up: true,
      onAction: () => {
        theirs = JSON.stringify(Object.assign(readJson(fx.lease), { pid: 777777, ppid: 777776 }));
        fs.writeFileSync(fx.lease, theirs);
        return null;
      },
    });
    await h.run(['restart', 'telepty', '--yes']);
    assert.equal(fs.readFileSync(fx.lease, 'utf8'), theirs);
  });

  it('a lease cleanup failure is not reported as success', { skip: POSIX_ONLY || (IS_ROOT && 'root ignores file modes') }, async (t) => {
    const fx = setup(t);
    const dir = path.dirname(fx.lease);
    const h = world(fx, { up: true, onAction: () => { fs.chmodSync(dir, 0o555); return null; } });
    let code;
    try {
      code = await h.run(['restart', 'telepty', '--yes']);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    assert.equal(fs.existsSync(fx.lease), true, 'precondition: the lease could not be removed');
    assert.notEqual(code, 0);
  });

  it('a lease that cannot be taken (I/O error) blocks the restart: unknown is not free', { skip: POSIX_ONLY || (IS_ROOT && 'root ignores file modes') }, async (t) => {
    const fx = setup(t);
    const dir = path.dirname(fx.lease);
    const h = world(fx, { up: true });
    fs.chmodSync(dir, 0o555);
    let code;
    try {
      code = await h.run(['restart', 'telepty', '--yes']);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    assert.equal(fs.existsSync(fx.lease), false, 'precondition: no lease could be created');
    assert.notEqual(code, 0);
    assert.deepEqual(actions(h), [], 'no restart without the lease');
  });

  for (const [label, env, ps] of [
    ['TELEPTY_SESSION_ID', { TELEPTY_SESSION_ID: 'sess-1' }, undefined],
    ['AIGENTRY_WORKER_SESSION', { AIGENTRY_WORKER_SESSION: '1' }, undefined],
    ['telepty allow ancestor', {}, '  PID  PPID COMMAND\n  900     1 node /usr/local/bin/telepty allow --id worker-3 codex\n 4241   900 bash\n 4242  4241 node /x/aigentry restart telepty\n'],
  ]) {
    it(`inside an agent (${label}) → 4, no lease, nothing run`, async (t) => {
      const fx = setup(t);
      const h = world(fx, { up: true, env, ps });
      assert.equal(await h.run(['restart', 'telepty', '--yes']), 4);
      assert.deepEqual(actions(h), []);
      assert.equal(fs.existsSync(fx.lease), false);
    });
  }

  for (const [label, probe] of [['timeout', H.P.timeout()], ['foreign 200', H.P.ok({ server: 'nginx' })], ['malformed', H.P.malformed()], ['answered 401', H.P.answered(401)]]) {
    it(`health ${label} → 1, no lease, nothing run`, async (t) => {
      const fx = setup(t);
      const h = world(fx, { up: true, health: probe });
      assert.equal(await h.run(['restart', 'telepty', '--yes']), 1);
      assert.deepEqual(actions(h), []);
      assert.equal(fs.existsSync(fx.lease), false);
    });
  }
});

// ── R2 regressions (REVIEW-R1 B1–B5, B7, S3, S8; SECURITY-R1 SNYK-3/4; CONTROLLER-R2) ──────────
// Each case fails on the R1 candidate's behaviour and pins the controller-decided fail-closed contract.

const TTL_MS = 60000; // telepty restart lease TTL (DECISIONS F7)
const logText = (fx) => (fs.existsSync(fx.log) ? fs.readFileSync(fx.log, 'utf8') : '');
const leaseStartMs = (fx) => {
  const l = JSON.parse(fs.readFileSync(fx.lease, 'utf8'));
  return typeof l.startedAt === 'number' ? l.startedAt : Date.parse(l.startedAt);
};

describe('R2: the restart lease fails closed', () => {
  it('restart.lease is a directory → 1, nothing run, no stop-initiated line (B1)', async (t) => {
    const fx = setup(t);
    fs.mkdirSync(fx.lease, { recursive: true });
    const h = world(fx, { up: true });
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 1);
    assert.deepEqual(actions(h), []);
    assert.doesNotMatch(logText(fx), /stop-initiated/);
    assert.ok(fs.statSync(fx.lease).isDirectory());
  });

  it('an unreadable (mode 000) lease → 1, bytes kept, nothing run (B1)', { skip: POSIX_ONLY || (IS_ROOT && 'root ignores file modes') }, async (t) => {
    const fx = setup(t);
    const h = world(fx, { up: true });
    const body = JSON.stringify({ pid: 999999, ppid: 1, port: 3848, verdict: 'aigentry-explicit', startedAt: new Date(h.clock - 1000).toISOString() });
    H.write(fx.lease, body);
    fs.chmodSync(fx.lease, 0o000);
    let code;
    try {
      code = await h.run(['restart', 'telepty', '--yes']);
    } finally {
      fs.chmodSync(fx.lease, 0o600);
    }
    assert.equal(code, 1);
    assert.equal(fs.readFileSync(fx.lease, 'utf8'), body);
    assert.deepEqual(actions(h), []);
    assert.doesNotMatch(logText(fx), /stop-initiated/);
  });

  const undatable = {
    'no startedAt': () => '{"pid":1}',
    'non-date startedAt': () => '{"pid":1,"startedAt":"x"}',
    'numeric epoch startedAt (now)': (h) => `{"pid":1,"startedAt":${h.clock}}`,
    'JSON null': () => 'null',
    'JSON scalar': () => '5',
    'truncated JSON': () => '{"pid":',
  };
  for (const [label, make] of Object.entries(undatable)) {
    it(`a fresh lease with ${label} is held, never judged expired (B2)`, async (t) => {
      const fx = setup(t);
      const h = world(fx, { up: true });
      const body = make(h);
      H.write(fx.lease, body);
      assert.equal(await h.run(['restart', 'telepty', '--yes']), 1);
      assert.equal(fs.readFileSync(fx.lease, 'utf8'), body, 'lease bytes unchanged');
      assert.deepEqual(actions(h), []);
    });
  }

  it('the same undatable lease with a file mtime older than the TTL is replaced (B2)', async (t) => {
    const fx = setup(t);
    let during = null;
    const h = world(fx, { up: true, onAction: () => { during = JSON.parse(fs.readFileSync(fx.lease, 'utf8')); return null; } });
    H.write(fx.lease, '{"pid":1,"startedAt":"x"}');
    const old = new Date(h.clock - 2 * TTL_MS);
    fs.utimesSync(fx.lease, old, old);
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 0);
    assert.equal(during && during.pid, 4242, 'our lease replaced the stale one');
    assert.equal(fs.existsSync(fx.lease), false);
  });

  it('an oversized lease is held without being trusted, even if its startedAt says stale (S8)', async (t) => {
    const fx = setup(t);
    const h = world(fx, { up: true });
    const body = JSON.stringify({ pid: 1, startedAt: new Date(h.clock - 10 * TTL_MS).toISOString(), pad: 'x'.repeat(2 * 1024 * 1024) });
    H.write(fx.lease, body);
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 1);
    assert.equal(fs.statSync(fx.lease).size, Buffer.byteLength(body));
    assert.deepEqual(actions(h), []);
  });
});

describe('R2: one restart deadline strictly under the lease TTL (B3)', () => {
  it('the restart child timeout and the confirmation poll end before the lease could expire', async (t) => {
    const fx = setup(t);
    let start = null;
    let call = null;
    let callAt = null;
    const h = world(fx, { up: true, onAction: (c) => { start = leaseStartMs(fx); call = c; callAt = h.clock; return { status: 0 }; } });
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 1, 'pid never changes → UNCONFIRMED');
    assert.ok(call, 'the restart action ran');
    assert.ok(Number.isFinite(call.opts.timeout) && call.opts.timeout > 0, `child timeout ${call.opts.timeout}`);
    assert.ok(callAt + call.opts.timeout < start + TTL_MS, `child may run ${callAt + call.opts.timeout - start} ms past lease start`);
    assert.ok(h.clock < start + TTL_MS, `verification ran ${h.clock - start} ms after the lease was taken`);
    assert.equal(fs.existsSync(fx.lease), false);
  });

  it('a hung restart child is cut at the deadline: exit 1, lease released, never past the TTL', async (t) => {
    const fx = setup(t);
    let start = null;
    const h = world(fx, {
      up: true,
      onAction: (c) => {
        start = leaseStartMs(fx);
        const limit = c.opts.timeout;
        if (!(limit > 0) || limit >= 70000) { h.advance(70000); return { status: 0 }; }
        h.advance(limit); // the child would have been killed by spawnSync's own timeout
        return { error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
      },
    });
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 1);
    assert.ok(h.clock - start < TTL_MS, `finished ${h.clock - start} ms after lease start`);
    assert.equal(fs.existsSync(fx.lease), false);
  });
});

describe('R2: replacement is confirmed only by authenticated same-port /api/meta pids (B4)', () => {
  it('meta 100 before, meta 401 after, daemon-state.json pid 200 → 1', async (t) => {
    const fx = setup(t);
    H.writeDaemonState(fx, { pid: 200, port: 3848 });
    const h = world(fx, { up: true, onAction: (c, s) => { s.metaOverride = H.P.answered(401); return { status: 0 }; } });
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 1);
    assert.equal(fs.existsSync(fx.lease), false);
  });

  it('no token: a daemon-state.json pid change is diagnostic only, never success', async (t) => {
    const fx = setup(t, { token: false });
    H.writeDaemonState(fx, { pid: 200, port: 3848 });
    const h = world(fx, { up: true, onAction: (c, s) => { H.writeDaemonState(fx, { pid: 201, port: 3848 }); s.pid = 201; return { status: 0 }; } });
    assert.notEqual(await h.run(['restart', 'telepty', '--yes']), 0);
  });

  it('no token: a port-less daemon-state.json is never taken as this daemon', async (t) => {
    const fx = setup(t, { token: false });
    H.writeDaemonState(fx, { pid: 200 });
    const h = world(fx, { up: true, onAction: (c, s) => { H.writeDaemonState(fx, { pid: 201 }); s.pid = 201; return { status: 0 }; } });
    assert.notEqual(await h.run(['restart', 'telepty', '--yes']), 0);
  });
});

describe('R2: supervisor port authority fails closed (S3; SECURITY SNYK-3/4)', () => {
  for (const verb of ['start', 'restart']) {
    it(`${verb}: an unreadable launchd descriptor is not assumed to serve 3848 → 1, nothing run`, { skip: POSIX_ONLY || (IS_ROOT && 'root ignores file modes') }, async (t) => {
      const fx = setup(t, { launchd: 3848 });
      const file = path.join(fx.home, 'Library', 'LaunchAgents', 'com.aigentry.telepty.plist');
      fs.chmodSync(file, 0o000);
      let code;
      let h;
      try {
        h = world(fx, { up: verb === 'restart' });
        code = await h.run(verb === 'start' ? ['start', 'telepty'] : ['restart', 'telepty', '--yes']);
      } finally {
        fs.chmodSync(file, 0o644);
      }
      assert.equal(code, 1);
      assert.deepEqual(actions(h), []);
      assert.equal(fs.existsSync(fx.lease), false);
    });
  }

  it('supervisedPort never reads a path carried in the human `detail` field', (t) => {
    const fx = setup(t);
    const decoy = H.write(path.join(fx.root, 'decoy.plist'), plist(4000));
    const { telepty } = H.loadLib();
    const touched = [];
    const names = ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'realpathSync'];
    const saved = names.map((n) => [n, fs[n]]);
    for (const [n, orig] of saved) {
      fs[n] = function spy(p, ...rest) {
        if (String(p) === decoy) touched.push(n);
        return orig.call(this, p, ...rest);
      };
    }
    let r;
    try {
      r = telepty.supervisedPort({ present: true, kind: 'launchd', detail: decoy });
    } finally {
      for (const [n, orig] of saved) fs[n] = orig;
    }
    assert.deepEqual(touched, [], 'detail is message-only');
    assert.ok(r !== 4000 && !(r && r.port === 4000));
  });
});

describe('R2: system tools only from trusted absolute paths (B7)', () => {
  const stubTools = (fx) => {
    for (const n of ['ps', 'launchctl', 'systemctl']) {
      H.write(path.join(fx.root, n), '#!/bin/sh\ntouch "$0.ran"\n', 0o755);
      H.write(path.join(fx.pathDir, n), '#!/bin/sh\ntouch "$0.ran"\n', 0o755);
    }
  };
  const scenarios = [
    ['darwin start via launchd', { launchd: 3848 }, { platform: 'darwin' }, ['start', 'telepty']],
    ['darwin restart via launchd', { launchd: 3848 }, { platform: 'darwin', up: true }, ['restart', 'telepty', '--yes']],
    ['linux start via systemd --user', { systemdUser: 3848 }, { platform: 'linux' }, ['start', 'telepty']],
    ['linux restart via systemd --user', { systemdUser: 3848 }, { platform: 'linux', up: true }, ['restart', 'telepty', '--yes']],
    ['darwin unsupervised restart (ps only)', {}, { platform: 'darwin', up: true }, ['restart', 'telepty', '--yes']],
  ];
  for (const [label, s, w, argv] of scenarios) {
    it(`${label}: cwd and relative PATH entries are never used`, async (t) => {
      const fx = setup(t, s);
      stubTools(fx);
      const h = world(fx, Object.assign({ env: { PATH: `:.:${fx.pathDir}` }, rt: { cwd: fx.root } }, w));
      await h.run(argv);
      assert.ok(h.state.tools.length > 0, 'a system tool was needed');
      for (const c of h.state.tools) assert.ok(H.isTrustedTool(c.cmd), `untrusted system tool: ${c.cmd}`);
    });
  }

  it('win32: schtasks is <SystemRoot>\\System32\\schtasks.exe, never a cwd/PATH/.cmd hit', async (t) => {
    const fx = setup(t);
    const h = world(fx, {
      platform: 'win32',
      env: { PATH: `.;${fx.pathDir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      onAction: (c) => (H.base(c.cmd) === 'schtasks' ? { status: 1 } : null),
    });
    await h.run(['start', 'telepty']);
    const sch = h.state.tools.filter((c) => H.base(c.cmd) === 'schtasks');
    assert.ok(sch.length > 0, 'schtasks was queried');
    for (const c of sch) assert.equal(String(c.cmd).toLowerCase(), 'c:\\windows\\system32\\schtasks.exe');
  });

  for (const bad of ['Windows', '.\\Windows', 'C:Windows', '\\\\evil\\share', '']) {
    it(`win32: SystemRoot ${JSON.stringify(bad)} never yields an untrusted schtasks`, async (t) => {
      const fx = setup(t);
      const h = world(fx, {
        platform: 'win32',
        env: { SystemRoot: bad, PATH: `.;${fx.pathDir}` },
        onAction: (c) => (H.base(c.cmd) === 'schtasks' ? { status: 1 } : null),
      });
      const code = await h.run(['start', 'telepty']);
      const sch = h.state.tools.filter((c) => H.base(c.cmd) === 'schtasks');
      for (const c of sch) {
        assert.ok(H.isTrustedTool(c.cmd), `untrusted schtasks: ${c.cmd}`);
        assert.ok(!/evil/i.test(c.cmd));
      }
      if (sch.length === 0) assert.notEqual(code, 0, 'no trusted schtasks → refuse, never guess');
    });
  }
});

describe('R2: lifecycle never executes an incompatible telepty (B5)', () => {
  it('bundled telepty 0.6.6 against the declared range: start → nonzero, nothing run', async (t) => {
    const fx = setup(t);
    H.installBundled(fx, 'telepty', { spec: { version: '0.6.6' } });
    const h = world(fx);
    assert.notEqual(await h.run(['start', 'telepty']), 0);
    assert.deepEqual(actions(h), []);
  });

  it('bundled telepty 0.6.6: restart → nonzero, no lease, nothing run', async (t) => {
    const fx = setup(t);
    H.installBundled(fx, 'telepty', { spec: { version: '0.6.6' } });
    const h = world(fx, { up: true });
    assert.notEqual(await h.run(['restart', 'telepty', '--yes']), 0);
    assert.deepEqual(actions(h), []);
    assert.equal(fs.existsSync(fx.lease), false);
  });

  it('a PATH telepty 0.7.1 shadowing bundled 0.8.5 is never executed by start', { skip: POSIX_ONLY }, async (t) => {
    const fx = setup(t);
    const p = H.installOnPathDirect(fx, 'telepty', { spec: { version: '0.7.1', bin: { telepty: 'bin/telepty' } } });
    const h = world(fx, { env: { PATH: p.binDirs.join(path.delimiter) } });
    await h.run(['start', 'telepty']);
    for (const c of h.state.actions) {
      assert.ok(!c.args.some((a) => String(a).startsWith(p.dir)), `incompatible PATH telepty executed: ${c.args.join(' ')}`);
    }
  });
});

// ── R3 regressions (controller R3 contracts after tester finding F-A) ─────────────────────────────
// 1. Only a canonical `Date#toISOString()` startedAt is authoritative; every other value is undatable
//    and falls back to the file mtime. 2. restart needs a known authenticated same-port /api/meta pid
//    BEFORE any action or stop-initiated line. 3. A systemd unit with an unhandled port source
//    (EnvironmentFile=, a drop-in) never silently defaults to 3848.

describe('R3: only a canonical toISOString startedAt dates a lease; anything else uses the mtime (F-A)', () => {
  const STALE_MS = 2 * TTL_MS;
  // Each value would say "stale" if it were trusted; the file itself is written now (fresh mtime).
  const undatable = {
    'numeric epoch-seconds': (h) => Math.floor(h.clock / 1000),
    'numeric 0': () => 0,
    'numeric epoch-ms (stale)': (h) => h.clock - STALE_MS,
    'lenient string "5"': () => '5',
    'lenient string "garbage 12"': () => 'garbage 12',
    'non-canonical ISO without milliseconds (stale)': (h) => new Date(h.clock - STALE_MS).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    'non-canonical ISO with +00:00 offset (stale)': (h) => new Date(h.clock - STALE_MS).toISOString().replace(/Z$/, '+00:00'),
    'date-only string (stale)': (h) => new Date(h.clock - STALE_MS).toISOString().slice(0, 10),
    'Date#toString form (stale)': (h) => new Date(h.clock - STALE_MS).toString(),
    'ISO shape that does not round-trip (Feb 31)': () => '2020-02-31T00:00:00.000Z',
  };
  const bodyWith = (startedAt) => JSON.stringify({ pid: 999999, ppid: 999998, port: 3848, verdict: 'aigentry-explicit', startedAt });

  for (const [label, make] of Object.entries(undatable)) {
    it(`fresh foreign lease with ${label} startedAt is held: 1, bytes preserved, no stop-initiated, nothing run`, async (t) => {
      const fx = setup(t);
      const h = world(fx, { up: true });
      const body = bodyWith(make(h));
      H.write(fx.lease, body);
      assert.equal(await h.run(['restart', 'telepty', '--yes']), 1);
      assert.equal(fs.readFileSync(fx.lease, 'utf8'), body, 'fresh foreign lease bytes preserved');
      assert.doesNotMatch(logText(fx), /stop-initiated/);
      assert.deepEqual(actions(h), []);
    });
  }

  for (const label of ['numeric epoch-seconds', 'lenient string "5"', 'numeric epoch-ms (stale)']) {
    it(`the same ${label} lease with a genuinely stale mtime is reclaimed`, async (t) => {
      const fx = setup(t);
      let during = null;
      const h = world(fx, { up: true, onAction: () => { during = JSON.parse(fs.readFileSync(fx.lease, 'utf8')); return null; } });
      H.write(fx.lease, bodyWith(undatable[label](h)));
      const old = new Date(h.clock - STALE_MS);
      fs.utimesSync(fx.lease, old, old);
      assert.equal(await h.run(['restart', 'telepty', '--yes']), 0);
      assert.equal(during && during.pid, 4242, 'our lease replaced the stale one');
      assert.equal(fs.existsSync(fx.lease), false);
    });
  }

  it('a canonical ISO startedAt stays authoritative: stale ISO with a fresh mtime is reclaimed', async (t) => {
    const fx = setup(t);
    const h = world(fx, { up: true });
    H.write(fx.lease, bodyWith(new Date(h.clock - STALE_MS).toISOString()));
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 0);
    assert.equal(fs.existsSync(fx.lease), false);
  });

  it('a canonical ISO startedAt stays authoritative: future ISO is held even with a stale mtime', async (t) => {
    const fx = setup(t);
    const h = world(fx, { up: true });
    const body = bodyWith(new Date(h.clock + 365 * 24 * 3600 * 1000).toISOString());
    H.write(fx.lease, body);
    const old = new Date(h.clock - STALE_MS);
    fs.utimesSync(fx.lease, old, old);
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 1);
    assert.equal(fs.readFileSync(fx.lease, 'utf8'), body);
    assert.deepEqual(actions(h), []);
  });
});

describe('R3: restart needs a known authenticated same-port /api/meta pid before any action', () => {
  const noAction = (h, fx) => {
    assert.deepEqual(actions(h), [], 'no restart action without a known daemon identity');
    assert.doesNotMatch(logText(fx), /stop-initiated/);
    assert.equal(fs.existsSync(fx.lease), false, 'no lease left behind');
  };
  const metaCases = [
    ['/api/meta 401', H.P.answered(401)],
    ['/api/meta 403', H.P.answered(403)],
    ['/api/meta timeout', H.P.timeout()],
    ['/api/meta malformed', H.P.malformed()],
    ['/api/meta error ECONNRESET', H.P.error()],
    ['/api/meta without a version', H.P.ok({ name: 'telepty', pid: 100, port: 3848 })],
    ['/api/meta for another port', H.P.ok({ name: 'telepty', version: '0.8.5', pid: 100, port: 4000 })],
    ['/api/meta without a pid', H.P.ok({ name: 'telepty', version: '0.8.5', port: 3848 })],
    ['/api/meta with pid null', H.P.ok({ name: 'telepty', version: '0.8.5', pid: null, port: 3848 })],
    ['/api/meta with a non-integer pid', H.P.ok({ name: 'telepty', version: '0.8.5', pid: '100', port: 3848 })],
  ];
  for (const [label, probe] of metaCases) {
    it(`${label} → nonzero, nothing run, no stop-initiated (--yes does not override unknown identity)`, async (t) => {
      const fx = setup(t);
      const h = world(fx, { up: true });
      h.state.metaOverride = probe;
      assert.notEqual(await h.run(['restart', 'telepty', '--yes']), 0);
      noAction(h, fx);
    });
  }

  for (const [label, cfg] of [['no ~/.telepty/config.json', null], ['config without authToken', {}]]) {
    it(`missing token (${label}) → nonzero, nothing run, no stop-initiated`, async (t) => {
      const fx = setup(t, { token: false });
      if (cfg) H.writeTeleptyConfig(fx, cfg);
      H.writeDaemonState(fx, { pid: 100, port: 3848 });
      const h = world(fx, { up: true });
      assert.notEqual(await h.run(['restart', 'telepty', '--yes']), 0);
      noAction(h, fx);
    });
  }

  it('a supervised (launchd) restart also needs the identity first', async (t) => {
    const fx = setup(t, { launchd: 3848 });
    const h = world(fx, { up: true });
    h.state.metaOverride = H.P.timeout();
    assert.notEqual(await h.run(['restart', 'telepty', '--yes']), 0);
    noAction(h, fx);
  });

  it('an interactive "y" does not override an unknown identity', async (t) => {
    const fx = setup(t);
    const h = world(fx, { up: true, tty: true, prompt: 'y' });
    h.state.metaOverride = H.P.answered(401);
    assert.notEqual(await h.run(['restart', 'telepty']), 0);
    noAction(h, fx);
  });

  it('a session listing (even with owner pids) never supplies the identity', async (t) => {
    const fx = setup(t);
    const h = world(fx, { up: true, sessions: H.P.ok([{ id: 's-1', type: 'spawned', healthStatus: 'CONNECTED', ownerPid: 100 }]) });
    h.state.metaOverride = H.P.answered(401);
    assert.notEqual(await h.run(['restart', 'telepty', '--yes']), 0);
    noAction(h, fx);
  });

  it('known identity + failing session listing: warns that sessions end, --yes proceeds → 0', async (t) => {
    const fx = setup(t);
    const h = world(fx, { up: true, sessions: H.P.timeout() });
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 0);
    assert.match(h.all(), /END/);
    assert.deepEqual(actions(h), ['node <cli> daemon restart']);
  });
});

describe('R3: an unhandled systemd port source never defaults to 3848', () => {
  const userUnit = (fx) => path.join(fx.home, '.config', 'systemd', 'user', 'telepty.service');
  const envFileUnit = (line) => `[Unit]\nDescription=telepty daemon\n\n[Service]\nExecStart=/usr/bin/node /usr/lib/node_modules/@dmsdc-ai/aigentry-telepty/daemon.js\n${line}\nRestart=always\n\n[Install]\nWantedBy=default.target\n`;
  const scenarios = (fx) => [
    ['start', world(fx, { platform: 'linux' }), ['start', 'telepty']],
    ['restart', world(fx, { platform: 'linux', up: true }), ['restart', 'telepty', '--yes']],
  ];

  for (const line of ['EnvironmentFile=%h/.config/telepty/env', 'EnvironmentFile=-/etc/default/telepty']) {
    it(`systemd --user unit with "${line}" and no port line: start and restart → 1, nothing run`, async (t) => {
      const fx = setup(t);
      H.write(userUnit(fx), envFileUnit(line));
      for (const [verb, h, argv] of scenarios(fx)) {
        assert.equal(await h.run(argv), 1, `${verb}: port source unknown`);
        assert.deepEqual(actions(h), [], `${verb}: nothing run`);
        assert.equal(fs.existsSync(fx.lease), false);
      }
    });
  }

  // Controller R3 tightening: systemd applies EnvironmentFile= after Environment=, so ANY EnvironmentFile is unknown.
  it('EnvironmentFile= together with an explicit Environment=TELEPTY_PORT=3848: start and restart → 1, nothing run', async (t) => {
    const fx = setup(t);
    H.write(userUnit(fx), envFileUnit('Environment=TELEPTY_PORT=3848\nEnvironmentFile=%h/.config/telepty/env'));
    for (const [verb, h, argv] of scenarios(fx)) {
      assert.equal(await h.run(argv), 1, `${verb}: the EnvironmentFile may override the port`);
      assert.deepEqual(actions(h), [], `${verb}: nothing run`);
      assert.equal(fs.existsSync(fx.lease), false);
    }
  });

  it('doctor does not report an EnvironmentFile unit as serving 3848', async (t) => {
    const fx = setup(t);
    H.write(userUnit(fx), envFileUnit('EnvironmentFile=%h/.config/telepty/env'));
    const h = world(fx, { platform: 'linux', up: true });
    await h.run(['doctor', '--json']);
    const ch = H.checkById(H.parseOneJson(h.stdout()), 'telepty.supervisor');
    assert.notEqual(ch.state, 'ok', JSON.stringify(ch));
    assert.doesNotMatch(String(ch.detail), /serves port 3848/);
  });

  // Proposed bounded drop-in rule: <unitFile>.d nonempty or unreadable → port unknown; absent/empty → as before.
  it('a nonempty drop-in directory <unitFile>.d → start and restart 1, nothing run', async (t) => {
    const fx = setup(t, { systemdUser: 3848 });
    H.write(path.join(`${userUnit(fx)}.d`, 'override.conf'), '[Service]\nEnvironment=TELEPTY_PORT=4000\n');
    for (const [verb, h, argv] of scenarios(fx)) {
      assert.equal(await h.run(argv), 1, `${verb}: drop-in not parsed`);
      assert.deepEqual(actions(h), [], `${verb}: nothing run`);
    }
  });

  it('an unreadable drop-in directory <unitFile>.d → start and restart 1, nothing run', { skip: POSIX_ONLY || (IS_ROOT && 'root ignores file modes') }, async (t) => {
    const fx = setup(t, { systemdUser: 3848 });
    const dropIn = `${userUnit(fx)}.d`;
    H.write(path.join(dropIn, 'override.conf'), '[Service]\nEnvironment=TELEPTY_PORT=4000\n');
    fs.chmodSync(dropIn, 0o000);
    try {
      for (const [verb, h, argv] of scenarios(fx)) {
        assert.equal(await h.run(argv), 1, `${verb}: drop-in unreadable`);
        assert.deepEqual(actions(h), [], `${verb}: nothing run`);
      }
    } finally {
      fs.chmodSync(dropIn, 0o755);
    }
  });

  it('an empty drop-in directory keeps the unit\'s own port (guard): systemctl --user start telepty', async (t) => {
    const fx = setup(t, { systemdUser: 3848 });
    fs.mkdirSync(`${userUnit(fx)}.d`, { recursive: true });
    const h = world(fx, { platform: 'linux' });
    assert.equal(await h.run(['start', 'telepty']), 0);
    assert.deepEqual(actions(h), ['systemctl --user start telepty']);
  });
});

// ── R3 (REVIEW-R2 R2-B1): the win32 scheduled task names no port; it is attributed to 3848 only ──────
// (telepty's documented fallback, an upstream-contract assumption). Any other addressed port → unknown:
// refuse with no lifecycle action and no lease. Simulated win32 only; `schtasks /query` is detection, not action.
describe('R3: the win32 scheduled task is never attributed to a non-default port (R2-B1)', () => {
  const SCHTASKS_FOUND = 'Folder: \\\r\nHostName:      PC\r\nTaskName:      \\telepty-daemon\r\nNext Run Time: N/A\r\nStatus:        Ready\r\n';
  // The task starts its own (default-port) daemon: /run never brings up the addressed 4000 daemon.
  const taskPresent = (c) => {
    if (H.base(c.cmd) !== 'schtasks') return null;
    if (c.args.includes('/query')) return { status: 0, stdout: SCHTASKS_FOUND };
    if (c.args.includes('/run')) return { status: 0 };
    return null;
  };
  const lifecycleActions = (h) => h.state.actions
    .filter((c) => !(H.base(c.cmd) === 'schtasks' && c.args.includes('/query')))
    .map((c) => `${H.base(c.cmd) === H.base(H.FAKE_NODE) ? 'node' : H.base(c.cmd)} ${c.args.map((a) => (a.endsWith('cli.js') ? '<cli>' : a)).join(' ')}`);

  it('task present, nothing on 4000: start telepty --port 4000 → 1, no schtasks /run, no daemon start', async (t) => {
    const fx = setup(t);
    const h = world(fx, { platform: 'win32', port: 4000, onAction: taskPresent });
    assert.equal(await h.run(['start', 'telepty', '--port', '4000']), 1);
    assert.deepEqual(lifecycleActions(h), [], 'only detection ran');
  });

  it('task present, daemon up on 4000: restart telepty --port 4000 --yes → 1, nothing stopped or run, no lease, no stop-initiated', async (t) => {
    const fx = setup(t);
    const h = world(fx, { platform: 'win32', port: 4000, up: true, onAction: taskPresent });
    assert.equal(await h.run(['restart', 'telepty', '--port', '4000', '--yes']), 1);
    assert.deepEqual(lifecycleActions(h), [], 'the 4000 daemon is never stopped');
    assert.equal(fs.existsSync(fx.lease), false);
    assert.doesNotMatch(logText(fx), /stop-initiated/);
  });
});

// ── N14 (FINAL-REVIEW-R3): a systemd port assignment the reader cannot prove is unknown, never 3848 ──
// Synthetic --user units only (no systemd). Every run has a known authenticated /api/meta identity on the
// addressed port, so only the supervisor decision can refuse. 3848 must not start/restart a unit that may
// serve 4000; --port 4000 must not bypass a unit that may own 4000 (#738). Refusal = before any action/lease/log.
describe('N14: a systemd port assignment the reader cannot prove never defaults to 3848', () => {
  const userUnit = (fx) => path.join(fx.home, '.config', 'systemd', 'user', 'telepty.service');
  const unitWith = (service) => `[Unit]\nDescription=telepty daemon\n\n[Service]\n${service}\nRestart=always\n\n[Install]\nWantedBy=default.target\n`;
  const EXEC = 'ExecStart=/usr/bin/node /usr/lib/node_modules/@dmsdc-ai/aigentry-telepty/daemon.js';
  const EXEC_ENV_4000 = 'ExecStart=/usr/bin/env TELEPTY_PORT=4000 node d.js';
  const runs = [
    ['start 3848', { platform: 'linux' }, ['start', 'telepty']],
    ['restart 3848', { platform: 'linux', up: true }, ['restart', 'telepty', '--yes']],
    ['start --port 4000', { platform: 'linux', port: 4000 }, ['start', 'telepty', '--port', '4000']],
    ['restart --port 4000', { platform: 'linux', port: 4000, up: true }, ['restart', 'telepty', '--port', '4000', '--yes']],
  ];
  // One fresh fixture per run, so a lease or log line from one run cannot hide another's.
  async function observe(t, service, rtOpts, argv) {
    const fx = setup(t);
    H.write(userUnit(fx), unitWith(service));
    const leaseAtAction = [];
    const h = world(fx, { ...rtOpts, onAction: () => { leaseAtAction.push(fs.existsSync(fx.lease)); return null; } });
    const code = await h.run(argv);
    return { code, actions: actions(h), leaseAtAction, leaseLeft: fs.existsSync(fx.lease), stopInitiated: /stop-initiated/.test(logText(fx)) };
  }
  const REFUSED = { code: 1, actions: [], leaseAtAction: [], leaseLeft: false, stopInitiated: false };

  const unproven = {
    "Environment='TELEPTY_PORT=4000'": `${EXEC}\nEnvironment='TELEPTY_PORT=4000'`,
    "Environment=A=1 'TELEPTY_PORT=4000'": `${EXEC}\nEnvironment=A=1 'TELEPTY_PORT=4000'`,
    "Environment='PORT=4000'": `${EXEC}\nEnvironment='PORT=4000'`,
    'escaped TELEPTY_PORT key': `${EXEC}\nEnvironment=TELEPTY\\x5fPORT=4000`,
    'escaped PORT key': `${EXEC}\nEnvironment=P\\x4fRT=4000`,
    'continued preceding line': `${EXEC}\nDescription=continued\\\nEnvironment=TELEPTY_PORT=4000`,
    'continued preceding line with comment': `${EXEC}\nDescription=continued\\\n# ignored comment\nEnvironment=TELEPTY_PORT=4000`,
    'ExecStart=/usr/bin/env TELEPTY_PORT=4000 node d.js': EXEC_ENV_4000,
    'canonical Environment=PORT=3848 + ExecStart env TELEPTY_PORT=4000': `${EXEC_ENV_4000}\nEnvironment=PORT=3848`,
    "canonical Environment=TELEPTY_PORT=3848 overwritten by Environment='TELEPTY_PORT=4000'": `${EXEC}\nEnvironment=TELEPTY_PORT=3848\nEnvironment='TELEPTY_PORT=4000'`,
  };
  for (const [form, service] of Object.entries(unproven)) {
    it(`${form}: start/restart on 3848 and --port 4000 → 1 before any action, lease or stop-initiated`, async (t) => {
      const seen = {};
      for (const [label, rtOpts, argv] of runs) seen[label] = await observe(t, service, rtOpts, argv);
      assert.deepEqual(seen, Object.fromEntries(runs.map(([label]) => [label, REFUSED])));
    });
  }

  // Guards (green before and after a fix): an unambiguous unit keeps its exact port; comments are not assignments.
  it('guard: canonical Environment=TELEPTY_PORT=4000 → --port 4000 uses systemd, 3848 restarts its own daemon', async (t) => {
    const service = `${EXEC}\nEnvironment=TELEPTY_PORT=4000`;
    assert.deepEqual((await observe(t, service, runs[2][1], runs[2][2])).actions, ['systemctl --user start telepty']);
    assert.deepEqual((await observe(t, service, runs[3][1], runs[3][2])).actions, ['systemctl --user restart telepty']);
    assert.deepEqual((await observe(t, service, runs[1][1], runs[1][2])).actions, ['node <cli> daemon restart']);
  });

  for (const [label, assignment] of [
    ['fully quoted canonical', 'Environment="TELEPTY_PORT=4000"'],
    ['installer two-key form', 'Environment=TELEPTY_PORT=4000 PORT=4000'],
    ['equal duplicate values', 'Environment=TELEPTY_PORT=4000\nEnvironment=TELEPTY_PORT=4000'],
  ]) {
    it(`guard: ${label} keeps exact supervisor port`, async (t) => {
      const service = `${EXEC}\n${assignment}`;
      assert.deepEqual((await observe(t, service, runs[2][1], runs[2][2])).actions, ['systemctl --user start telepty']);
      assert.deepEqual((await observe(t, service, runs[3][1], runs[3][2])).actions, ['systemctl --user restart telepty']);
      assert.deepEqual((await observe(t, service, runs[1][1], runs[1][2])).actions, ['node <cli> daemon restart']);
    });
  }

  it('guard: port text only in comments is no assignment → the unit serves 3848 (systemctl --user start)', async (t) => {
    const service = `${EXEC}\n# Environment='TELEPTY_PORT=4000'\n; Environment=PORT=4000\n#ExecStart=/usr/bin/env TELEPTY_PORT=4000 node d.js`;
    const r = await observe(t, service, runs[0][1], runs[0][2]);
    assert.deepEqual([r.code, r.actions], [0, ['systemctl --user start telepty']]);
  });
});
