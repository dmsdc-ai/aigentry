'use strict';
// Area 5: human orchestrator start/restart runs the unchanged boot in the foreground (fake spawner only):
// validated workspace (flag > env > default, never cwd), inherited stdio, no signal forwarding, no
// current-agent restart, unknown is not absent, Windows unsupported explicitly.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers/fixture');

const POSIX_ONLY = H.HOST_IS_WIN ? 'POSIX PATH layout (orchestrator verbs are POSIX-only; win32 → 6 is covered below)' : false;
// R2 (CONTROLLER-R2 S6): no-op SIGINT/SIGQUIT only; SIGTERM/SIGHUP are not handled; nothing is forwarded.
const SIGS = ['SIGINT', 'SIGQUIT'];
const UNHANDLED = ['SIGTERM', 'SIGHUP'];
const PS_CLEAN = '  PID  PPID COMMAND\n    1     0 /sbin/launchd\n 4241     1 -zsh\n 4242  4241 node /x/aigentry start orchestrator\n';

function setup(t, { orchestratorOnPath = true, bash = true, token = true } = {}) {
  const fx = H.makeFixture(t);
  H.installAllBundled(fx);
  if (token) H.writeTeleptyConfig(fx);
  const dirs = [];
  if (orchestratorOnPath) dirs.push(...H.installOnPathDirect(fx, 'orchestrator').binDirs);
  if (bash) H.write(path.join(fx.pathDir, 'bash'), '#!/bin/sh\nexit 99\n', 0o755);
  dirs.push(fx.pathDir);
  fx.PATH = dirs.join(path.delimiter);
  fx.ws = H.makeWorkspace(path.join(fx.root, 'control ws'));
  fx.boot = path.join(fx.ws, 'bin', 'orchestrator-boot.sh');
  return fx;
}

function rt(fx, o = {}) {
  const sessions = o.sessions !== undefined ? o.sessions : H.P.ok([]);
  const result = o.result || { status: 7 };
  return H.makeRt(fx, Object.assign({
    tty: true,
    env: Object.assign({ PATH: fx.PATH }, o.env),
    http: H.fakeDaemon({ health: o.health || H.healthy(), meta: H.P.ok({ version: '0.8.5', pid: 100, port: H.DEFAULT_PORT }), sessions }),
    procs: H.makeProcs((call) => {
      if (H.base(call.cmd) === 'ps') return { status: 0, stdout: o.ps || PS_CLEAN };
      if (H.base(call.cmd) === 'bash') return typeof result === 'function' ? result(call) : result;
      throw new Error(`unexpected process ${call.cmd} ${call.args.join(' ')}`);
    }),
  }, o.rt));
}

const launches = (h) => h.rec.procs.filter((c) => H.base(c.cmd) === 'bash');

function assertLaunch(h, fx, ws = fx.ws) {
  const l = launches(h);
  assert.equal(l.length, 1, 'boot launched exactly once');
  const [c] = l;
  assert.equal(c.kind, 'spawn', 'foreground child via spawn');
  assert.ok(path.isAbsolute(c.cmd), 'bash resolved to an absolute path');
  assert.equal(fs.realpathSync(c.cmd), fs.realpathSync(path.join(fx.pathDir, 'bash')));
  assert.deepEqual(c.args.map((a) => path.resolve(a)), [path.join(ws, 'bin', 'orchestrator-boot.sh')], 'argv is exactly the boot script');
  assert.equal(path.resolve(c.opts.cwd), ws);
  assert.equal(c.opts.stdio, 'inherit');
  assert.equal(c.opts.shell, false);
  assert.ok(!c.opts.detached, 'never detached');
  assert.equal(h.rec.kills.length, 0);
  assert.equal(h.rec.unrefs.length, 0, 'no hidden background child');
  return c;
}

function noLaunch(h) {
  assert.deepEqual(launches(h), [], 'boot must not run');
}

describe('orchestrator launch (POSIX)', { skip: POSIX_ONLY }, () => {
  for (const verb of ['start', 'restart']) {
    it(`${verb} orchestrator runs the unchanged boot in the foreground and forwards its exit`, async (t) => {
      const fx = setup(t);
      const h = rt(fx);
      assert.equal(await h.run([verb, 'orchestrator', '--workspace', fx.ws]), 7);
      const c = assertLaunch(h, fx);
      assert.ok(c.opts.env === undefined || JSON.stringify(c.opts.env) === JSON.stringify(h.rt.env), 'env unchanged without --port');
    });
  }

  it('--port sets only TELEPTY_PORT in the boot env', async (t) => {
    const fx = setup(t);
    const h = rt(fx, { env: { TELEPTY_PORT: '5555' } });
    await h.run(['start', 'orchestrator', '--workspace', fx.ws, '--port', '4100']);
    const c = assertLaunch(h, fx);
    assert.equal(c.opts.env.TELEPTY_PORT, '4100');
    assert.deepEqual(Object.assign({}, c.opts.env, { TELEPTY_PORT: '5555' }), h.rt.env);
  });

  it('TELEPTY_PORT from the environment is left untouched without --port', async (t) => {
    const fx = setup(t);
    const h = rt(fx, { env: { TELEPTY_PORT: '5555' } });
    await h.run(['start', 'orchestrator', '--workspace', fx.ws]);
    const c = assertLaunch(h, fx);
    assert.ok(c.opts.env === undefined || c.opts.env.TELEPTY_PORT === '5555');
  });

  it('SIGINT/SIGQUIT are no-ops while the boot runs, never forwarded, and handlers are removed afterwards', async (t) => {
    const fx = setup(t);
    let finish;
    const done = new Promise((r) => { finish = r; });
    const h = rt(fx, { result: { waitFor: done, signal: 'SIGTERM', status: null } });
    const pending = h.run(['start', 'orchestrator', '--workspace', fx.ws]);
    let early = null;
    pending.then((code) => { early = code; });
    for (let i = 0; i < 1000 && launches(h).length === 0 && early === null; i++) await new Promise((r) => setImmediate(r));
    assert.equal(launches(h).length, 1, `boot was not launched (run settled with ${early})`);
    const c = launches(h)[0];
    const registered = h.rec.signalsOn.map((s) => s.sig);
    for (const s of SIGS) assert.ok(registered.includes(s), `${s} handled while boot runs`);
    for (const s of UNHANDLED) assert.ok(!registered.includes(s), `${s} must not be ignored`);
    assert.ok(c.signalsAtCall >= SIGS.length, 'handlers installed before the child starts');
    for (const { sig, fn } of h.rec.signalsOn) fn(sig);
    assert.equal(h.rec.kills.length, 0, 'no signal forwarded to the boot');
    let settled = false;
    pending.then(() => { settled = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false, 'aigentry keeps waiting for the boot after a signal');
    finish();
    assert.equal(await pending, 128 + 15);
    for (const { sig, fn } of h.rec.signalsOn) {
      assert.ok(h.rec.signalsOff.some((o) => o.sig === sig && o.fn === fn), `${sig} handler removed`);
    }
  });

  it('a boot that cannot be spawned yields a nonzero exit and still removes handlers', async (t) => {
    const fx = setup(t);
    const h = rt(fx, { result: { error: Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' }) } });
    const code = await h.run(['start', 'orchestrator', '--workspace', fx.ws]);
    assert.notEqual(code, 0);
    for (const { sig, fn } of h.rec.signalsOn) assert.ok(h.rec.signalsOff.some((o) => o.sig === sig && o.fn === fn));
  });
});

describe('workspace resolution (POSIX)', { skip: POSIX_ONLY }, () => {
  it('flag > AIGENTRY_CONTROL_WORKSPACE > ~/aigentry/_orchestrator', async (t) => {
    const fx = setup(t);
    const envWs = H.makeWorkspace(path.join(fx.root, 'env ws'));
    const defWs = H.makeWorkspace(path.join(fx.home, 'aigentry', '_orchestrator'));
    const h1 = rt(fx, { env: { AIGENTRY_CONTROL_WORKSPACE: envWs } });
    await h1.run(['start', 'orchestrator', '--workspace', fx.ws]);
    assertLaunch(h1, fx, fx.ws);
    const h2 = rt(fx, { env: { AIGENTRY_CONTROL_WORKSPACE: envWs } });
    await h2.run(['start', 'orchestrator']);
    assertLaunch(h2, fx, envWs);
    const h3 = rt(fx);
    await h3.run(['start', 'orchestrator']);
    assertLaunch(h3, fx, defWs);
  });

  it('the cwd is never used to guess the workspace', async (t) => {
    const fx = setup(t);
    const h = rt(fx, { rt: { cwd: fx.ws } });
    assert.equal(await h.run(['start', 'orchestrator']), 3);
    noLaunch(h);
    const r = h.lib.orchestrator.resolveWorkspace(h.rt, undefined);
    assert.equal(r.ok, false);
    assert.equal(r.state, 'unavailable');
  });

  it('a source checkout (package.json name) is a valid workspace', async (t) => {
    const fx = setup(t);
    const ws = H.makeWorkspace(path.join(fx.root, 'checkout ws'), 'checkout');
    const h = rt(fx);
    await h.run(['start', 'orchestrator', '--workspace', ws]);
    assertLaunch(h, fx, ws);
  });

  const invalid = {
    'boot script missing → 3 or 1': [(ws) => fs.rmSync(path.join(ws, 'bin', 'orchestrator-boot.sh')), null],
    'init json is not an object → 1': [(ws) => fs.writeFileSync(path.join(ws, '.aigentry-init.json'), '[1,2]'), 1],
    'init json is garbage → 1': [(ws) => fs.writeFileSync(path.join(ws, '.aigentry-init.json'), '{oops'), 1],
    'neither init json nor orchestrator package.json → 3 or 1': [(ws) => fs.rmSync(path.join(ws, '.aigentry-init.json')), null],
    'boot script is a directory → nonzero': [(ws) => { fs.rmSync(path.join(ws, 'bin', 'orchestrator-boot.sh')); fs.mkdirSync(path.join(ws, 'bin', 'orchestrator-boot.sh')); }, null],
    'workspace flag points at a file → nonzero': [null, null],
  };
  for (const [label, [mutate, exit]] of Object.entries(invalid)) {
    it(`invalid workspace: ${label}`, async (t) => {
      const fx = setup(t);
      let ws = fx.ws;
      if (mutate) mutate(ws); else ws = fx.boot;
      const h = rt(fx);
      const code = await h.run(['start', 'orchestrator', '--workspace', ws]);
      if (exit !== null) assert.equal(code, exit); else assert.ok(code === 1 || code === 3, `got ${code}`);
      noLaunch(h);
    });
  }
});

describe('refusals execute nothing', () => {
  it('win32 → 6 with Git Bash guidance, before any other check', async (t) => {
    const fx = H.makeFixture(t);
    for (const verb of ['start', 'restart']) {
      const h = H.makeRt(fx, { platform: 'win32', arch: 'x64', tty: true, env: { TELEPTY_SESSION_ID: 'sess-1' } });
      assert.equal(await h.run([verb, 'orchestrator']), 6);
      assert.match(h.all(), /bash/i);
      assert.deepEqual(h.rec.procs, []);
    }
  });

  for (const [label, env] of [['TELEPTY_SESSION_ID', { TELEPTY_SESSION_ID: 'sess-1' }], ['AIGENTRY_WORKER_SESSION', { AIGENTRY_WORKER_SESSION: '1' }]]) {
    for (const verb of ['start', 'restart']) {
      it(`${verb} orchestrator inside an agent (${label}) → 4`, { skip: POSIX_ONLY }, async (t) => {
        const fx = setup(t);
        const h = rt(fx, { env });
        assert.equal(await h.run([verb, 'orchestrator', '--workspace', fx.ws]), 4);
        noLaunch(h);
      });
    }
  }

  it('restart orchestrator from inside the bridge (telepty allow ancestor) → 4', { skip: POSIX_ONLY }, async (t) => {
    const fx = setup(t);
    const ps = '  PID  PPID COMMAND\n    1     0 /sbin/launchd\n  900     1 node /usr/local/bin/telepty allow --id orchestrator claude\n 4241   900 /bin/zsh\n 4242  4241 node /x/aigentry restart orchestrator\n';
    const h = rt(fx, { ps });
    assert.equal(await h.run(['restart', 'orchestrator', '--workspace', fx.ws]), 4);
    noLaunch(h);
  });

  it('a non-ancestor `telepty allow` or a grep for it does not make this an agent', { skip: POSIX_ONLY }, async (t) => {
    const fx = setup(t);
    const ps = PS_CLEAN + '  900     1 node /usr/local/bin/telepty allow --id other\n 5000  4241 grep telepty allow\n';
    const h = rt(fx, { ps, sessions: H.P.ok([]) });
    assert.equal(await h.run(['restart', 'orchestrator', '--workspace', fx.ws]), 7);
    assertLaunch(h, fx);
  });

  for (const [label, o] of [['stdin', { stdinIsTTY: false }], ['stderr', { stderrIsTTY: false }]]) {
    it(`non-TTY ${label} → 4`, { skip: POSIX_ONLY }, async (t) => {
      const fx = setup(t);
      const h = rt(fx, { rt: o });
      assert.equal(await h.run(['start', 'orchestrator', '--workspace', fx.ws]), 4);
      noLaunch(h);
    });
  }

  it('aigentry-orchestrator not on PATH → 3', { skip: POSIX_ONLY }, async (t) => {
    const fx = setup(t, { orchestratorOnPath: false });
    H.installBundled(fx, 'orchestrator');
    const h = rt(fx);
    assert.equal(await h.run(['start', 'orchestrator', '--workspace', fx.ws]), 3);
    noLaunch(h);
  });

  it('bash missing → 3', { skip: POSIX_ONLY }, async (t) => {
    const fx = setup(t, { bash: false });
    const h = rt(fx);
    assert.equal(await h.run(['start', 'orchestrator', '--workspace', fx.ws]), 3);
    assert.deepEqual(h.rec.procs.filter((c) => H.base(c.cmd) !== 'ps'), []);
  });
});

describe('live session state (POSIX)', { skip: POSIX_ONLY }, () => {
  const row = (id, healthStatus, type = 'wrapped') => ({ id, type, healthStatus, ownerPid: 31337 });

  for (const hs of ['CONNECTED', 'UPSTREAM_STALLED']) {
    it(`a ${hs} orchestrator row: start → 1 (use restart), restart → launches`, async (t) => {
      const fx = setup(t);
      const sessions = H.P.ok([row('orchestrator', hs), row('worker-1', 'CONNECTED', 'spawned')]);
      const h1 = rt(fx, { sessions });
      assert.equal(await h1.run(['start', 'orchestrator', '--workspace', fx.ws]), 1);
      assert.match(h1.all(), /restart/);
      noLaunch(h1);
      const h2 = rt(fx, { sessions });
      assert.equal(await h2.run(['restart', 'orchestrator', '--workspace', fx.ws]), 7);
      assertLaunch(h2, fx);
    });
  }

  it('ORCHESTRATOR_SID scopes the live check', async (t) => {
    const fx = setup(t);
    const sessions = H.P.ok([row('orchestrator', 'CONNECTED')]);
    const h1 = rt(fx, { env: { ORCHESTRATOR_SID: 'orch-b' }, sessions });
    assert.equal(await h1.run(['start', 'orchestrator', '--workspace', fx.ws]), 7, 'another sid is not our bridge');
    assertLaunch(h1, fx);
    const h2 = rt(fx, { env: { ORCHESTRATOR_SID: 'orch-b' }, sessions: H.P.ok([row('orch-b', 'CONNECTED')]) });
    assert.equal(await h2.run(['start', 'orchestrator', '--workspace', fx.ws]), 1);
    noLaunch(h2);
  });

  const unknowns = {
    'sessions timeout': { sessions: H.P.timeout() },
    'sessions 401': { sessions: H.P.answered(401) },
    'sessions malformed': { sessions: H.P.malformed() },
    'sessions ok but not a list': { sessions: H.P.ok({ rows: 'x' }) },
    'daemon health timeout': { health: H.P.timeout(), sessions: H.P.timeout() },
  };
  for (const [label, o] of Object.entries(unknowns)) {
    it(`${label}: liveness is unknown, start refuses with 1 and launches nothing`, async (t) => {
      const fx = setup(t);
      const h = rt(fx, o);
      const ls = await h.lib.orchestrator.liveState(h.rt, { port: H.DEFAULT_PORT, sid: 'orchestrator', allowSnapshot: false });
      assert.equal(ls.state, 'unknown', `${label} must not read as not-running`);
      const h2 = rt(fx, o);
      assert.equal(await h2.run(['start', 'orchestrator', '--workspace', fx.ws]), 1);
      noLaunch(h2);
    });
  }

  it('an authoritative empty session list is not-running', async (t) => {
    const fx = setup(t);
    const h = rt(fx, { sessions: H.P.ok([row('worker-1', 'CONNECTED', 'spawned')]) });
    const ls = await h.lib.orchestrator.liveState(h.rt, { port: H.DEFAULT_PORT, sid: 'orchestrator', allowSnapshot: false });
    assert.equal(ls.state, 'not-running');
  });
});

// ── R2 regressions (REVIEW-R1 B7, B9, S9; CONTROLLER-R2) ────────────────────────────────────
describe('R2: orchestrator verbs need a known daemon, auth and session state (B9)', { skip: POSIX_ONLY }, () => {
  const cases = {
    'daemon stopped (ECONNREFUSED)': { health: H.P.refused(), sessions: H.P.refused() },
    'daemon health timeout': { health: H.P.timeout(), sessions: H.P.timeout() },
    'daemon health 401': { health: H.P.answered(401), sessions: H.P.answered(401) },
    'sessions 401 (auth refused)': { sessions: H.P.answered(401) },
    'sessions timeout': { sessions: H.P.timeout() },
    'sessions malformed': { sessions: H.P.malformed() },
  };
  for (const verb of ['start', 'restart']) {
    for (const [label, o] of Object.entries(cases)) {
      it(`${verb} orchestrator with ${label} → 1, boot never runs`, async (t) => {
        const fx = setup(t);
        const h = rt(fx, o);
        assert.equal(await h.run([verb, 'orchestrator', '--workspace', fx.ws]), 1);
        noLaunch(h);
      });
    }
    it(`${verb} orchestrator with no token (auth unknown) → nonzero, boot never runs`, async (t) => {
      const fx = setup(t, { token: false });
      const h = rt(fx);
      assert.notEqual(await h.run([verb, 'orchestrator', '--workspace', fx.ws]), 0);
      noLaunch(h);
    });
  }

  it('restart over a live bridge names the session it will replace before the boot asks YES', async (t) => {
    const fx = setup(t);
    const h = rt(fx, { sessions: H.P.ok([{ id: 'orchestrator', type: 'wrapped', healthStatus: 'CONNECTED', ownerPid: 31337 }]) });
    assert.equal(await h.run(['restart', 'orchestrator', '--workspace', fx.ws]), 7);
    assert.match(h.all(), /replace/i);
    assertLaunch(h, fx);
  });
});

describe('R2: orchestrator PATH provenance and trusted ps (S9, B7)', { skip: POSIX_ONLY }, () => {
  it('a foreign aigentry-orchestrator on PATH (not the package) → 3, boot never runs', async (t) => {
    const fx = setup(t, { orchestratorOnPath: false });
    H.write(path.join(fx.pathDir, 'aigentry-orchestrator'), '#!/bin/sh\necho impostor\n', 0o755);
    const h = rt(fx);
    assert.equal(await h.run(['start', 'orchestrator', '--workspace', fx.ws]), 3);
    noLaunch(h);
  });

  it('the ancestor snapshot uses an absolute ps even when PATH has relative entries', async (t) => {
    const fx = setup(t);
    H.write(path.join(fx.root, 'ps'), '#!/bin/sh\ntouch "$0.ran"\n', 0o755);
    const h = rt(fx, { env: { PATH: `:.:${fx.PATH}` }, rt: { cwd: fx.root } });
    await h.run(['restart', 'orchestrator', '--workspace', fx.ws]);
    const ps = h.rec.procs.filter((c) => H.base(c.cmd) === 'ps');
    assert.ok(ps.length > 0, 'ancestor check ran');
    for (const c of ps) assert.ok(H.isTrustedTool(c.cmd), `untrusted ps: ${c.cmd}`);
  });
});
