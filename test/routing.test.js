'use strict';
// Area 1: routing, help, default start, explicit restart, empty passthrough, exit forwarding, exact argv.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers/fixture');

const realPkg = JSON.parse(fs.readFileSync(path.join(H.REPO, 'package.json'), 'utf8'));

function noProcs(h) {
  assert.deepEqual(h.rec.procs.map((c) => `${c.cmd} ${c.args.join(' ')}`), [], 'no subprocess may be started');
}

// Passthrough fake: records the single child and answers with a chosen exit.
function passthroughProcs(result) {
  return H.makeProcs(() => result);
}

describe('help / version / unknown command', () => {
  for (const argv of [['help'], ['-h'], ['--help']]) {
    it(`${argv[0]} prints the verbs and executes nothing`, async (t) => {
      const fx = H.makeFixture(t);
      const h = H.makeRt(fx);
      const code = await h.run(argv);
      assert.equal(code, 0);
      for (const word of ['status', 'doctor', 'start', 'restart']) assert.match(h.stdout(), new RegExp(`\\b${word}\\b`));
      noProcs(h);
      assert.equal(h.rec.http.length, 0, 'help must not probe the daemon');
    });
  }

  for (const topic of ['start', 'restart', 'telepty', 'orchestrator', 'deliberation']) {
    it(`help ${topic} is a pure topic page`, async (t) => {
      const fx = H.makeFixture(t);
      const h = H.makeRt(fx);
      assert.equal(await h.run(['help', topic]), 0);
      assert.ok(h.stdout().trim().length > 0, 'topic help must print something');
      noProcs(h);
      assert.equal(h.rec.http.length, 0);
    });
  }

  for (const argv of [['version'], ['-v'], ['--version']]) {
    it(`${argv[0]} prints exactly the package version`, async (t) => {
      const fx = H.makeFixture(t);
      const h = H.makeRt(fx);
      assert.equal(await h.run(argv), 0);
      assert.equal(h.stdout().trim(), realPkg.version);
      noProcs(h);
    });
  }

  it('unknown command exits 1 with the compat message and runs nothing', async (t) => {
    const fx = H.makeFixture(t);
    const h = H.makeRt(fx);
    assert.equal(await h.run(['frobnicate']), 1);
    assert.match(h.stderr(), /Unknown command: frobnicate/);
    noProcs(h);
  });

  it('a shell-metacharacter "command" is just an unknown word', async (t) => {
    const fx = H.makeFixture(t);
    const h = H.makeRt(fx);
    const evil = `$(touch ${path.join(fx.root, 'pwned')}); rm -rf ~`;
    assert.equal(await h.run([evil]), 1);
    assert.equal(fs.existsSync(path.join(fx.root, 'pwned')), false);
    noProcs(h);
  });

  it('removed / never-added verbs do not act (stop, repair, start --all)', async (t) => {
    const fx = H.makeFixture(t);
    for (const argv of [['stop', 'telepty'], ['repair'], ['start', '--all'], ['restart', '--all']]) {
      const h = H.makeRt(fx, { http: H.fakeDaemon({ health: H.P.refused() }) });
      const code = await h.run(argv);
      assert.notEqual(code, 0, `${argv.join(' ')} must not succeed`);
      noProcs(h);
    }
    const h = H.makeRt(fx);
    assert.equal(await h.run(['start', '--all']), 2, 'unknown --all is a usage error');
  });
});

describe('start / restart routing', () => {
  it('bare `start` targets telepty on the default port and is idempotent when running', async (t) => {
    const fx = H.makeFixture(t);
    H.installAllBundled(fx);
    const h = H.makeRt(fx, { http: H.fakeDaemon({ health: H.healthy() }) });
    assert.equal(await h.run(['start']), 0);
    assert.ok(h.rec.http.length >= 1);
    for (const c of h.rec.http) {
      assert.equal(c.port, H.DEFAULT_PORT);
      assert.ok(c.host === undefined || c.host === '127.0.0.1', 'only loopback');
    }
    assert.equal(h.rec.http[0].path, '/api/health');
    noProcs(h);
  });

  it('port precedence: --port > TELEPTY_PORT > 3848; TELEPTY_HOST is ignored', async (t) => {
    const fx = H.makeFixture(t);
    H.installAllBundled(fx);
    const env = { TELEPTY_PORT: '5555', TELEPTY_HOST: '203.0.113.9' };
    const h1 = H.makeRt(fx, { env, http: H.fakeDaemon({ health: H.healthy() }) });
    assert.equal(await h1.run(['start', 'telepty']), 0);
    assert.ok(h1.rec.http.every((c) => c.port === 5555 && (c.host === undefined || c.host === '127.0.0.1')));
    const h2 = H.makeRt(fx, { env, http: H.fakeDaemon({ health: H.healthy() }) });
    assert.equal(await h2.run(['start', 'telepty', '--port', '6001']), 0);
    assert.ok(h2.rec.http.every((c) => c.port === 6001));
  });

  for (const bad of ['abc', '0', '65536', '-1', '12.5', '']) {
    it(`start --port ${JSON.stringify(bad)} is a usage error before any probe`, async (t) => {
      const fx = H.makeFixture(t);
      H.installAllBundled(fx);
      const h = H.makeRt(fx);
      assert.equal(await h.run(['start', 'telepty', '--port', bad]), 2);
      assert.equal(h.rec.http.length, 0);
      noProcs(h);
    });
  }

  for (const argv of [['restart'], ['restart', 'devkit'], ['start', 'devkit'], ['start', 'aterm'], ['start', 'brain'], ['restart', 'nosuch'], ['start', 'nosuch']]) {
    it(`${argv.join(' ')} → exit 2 without probing or executing`, async (t) => {
      const fx = H.makeFixture(t);
      H.installAllBundled(fx);
      const h = H.makeRt(fx);
      assert.equal(await h.run(argv), 2);
      assert.equal(h.rec.http.length, 0);
      noProcs(h);
    });
  }

  it('explicit `restart telepty` routes to the telepty restart path (stopped → start path)', async (t) => {
    const fx = H.makeFixture(t);
    H.installAllBundled(fx);
    let up = false;
    const h = H.makeRt(fx, {
      http: H.fakeDaemon({ health: () => (up ? H.healthy() : H.P.refused()) }),
      procs: H.makeProcs((call) => {
        if (call.cmd === H.FAKE_NODE && call.args.slice(-2).join(' ') === 'daemon start') { up = true; return { status: 0 }; }
        if (H.base(call.cmd) === 'ps') return { status: 0, stdout: '  PID  PPID COMMAND\n 4242  4241 node aigentry\n 4241     1 -bash\n' };
        throw new Error(`unexpected ${call.cmd} ${call.args.join(' ')}`);
      }),
    });
    assert.equal(await h.run(['restart', 'telepty', '--yes']), 0);
    const starts = h.rec.procs.filter((c) => c.cmd === H.FAKE_NODE);
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].args.slice(-2), ['daemon', 'start']);
  });
});

describe('component passthrough', () => {
  for (const name of ['telepty', 'devkit', 'brain', 'deliberation', 'aterm', 'orchestrator', 'logger']) {
    it(`\`aigentry ${name}\` with no args prints a summary and executes nothing`, async (t) => {
      const fx = H.makeFixture(t);
      H.installAllBundled(fx);
      const h = H.makeRt(fx, { platform: 'darwin', arch: 'arm64' });
      assert.equal(await h.run([name]), 0);
      assert.ok(h.stdout().length > 0, 'summary printed');
      noProcs(h);
      assert.equal(h.rec.http.length, 0);
    });
  }

  it('argv is forwarded verbatim (no parsing of global flags, no shell) and the exit code is forwarded', async (t) => {
    const fx = H.makeFixture(t);
    H.installAllBundled(fx);
    const args = ['doctor', '--json', '--port', '9', '--yes', 'two words', '$(id)', '`id`', "'; rm -rf ~ #", '*', 'a"b', '\nnl', ''];
    const h = H.makeRt(fx, { procs: passthroughProcs({ status: 42 }) });
    assert.equal(await h.run(['devkit', ...args]), 42);
    assert.equal(h.rec.procs.length, 1);
    const [c] = h.rec.procs;
    assert.equal(c.cmd, H.FAKE_NODE, 'runs process.execPath, never the bin through a shell');
    assert.equal(c.args[0], path.join(H.pkgDir(fx.meta, H.COMPONENTS.devkit.pkg), 'bin', 'cli.js'));
    assert.deepEqual(c.args.slice(1), args);
    assert.equal(c.opts.shell, false);
    assert.ok(!c.opts.detached);
    assert.equal(c.opts.stdio, 'inherit');
    assert.ok(c.opts.cwd === undefined || c.opts.cwd === h.rt.cwd, 'cwd unchanged');
    assert.ok(c.opts.env === undefined || JSON.stringify(c.opts.env) === JSON.stringify(h.rt.env), 'env unchanged');
    assert.equal(c.opts.timeout, undefined, 'passthrough has no timeout');
  });

  for (const [status, signal, expected] of [[0, null, 0], [3, null, 3], [255, null, 255], [null, 'SIGTERM', 143], [null, 'SIGINT', 130]]) {
    it(`child exit ${signal || status} → aigentry exits ${expected}`, async (t) => {
      const fx = H.makeFixture(t);
      H.installAllBundled(fx);
      const h = H.makeRt(fx, { procs: passthroughProcs({ status, signal }) });
      assert.equal(await h.run(['telepty', 'list']), expected);
      assert.equal(h.rec.kills.length, 0);
    });
  }

  it('passthrough applies no agent-context refusal', async (t) => {
    const fx = H.makeFixture(t);
    H.installAllBundled(fx);
    const h = H.makeRt(fx, { env: { TELEPTY_SESSION_ID: 'sess-1', AIGENTRY_WORKER_SESSION: '1' }, procs: passthroughProcs({ status: 0 }) });
    assert.equal(await h.run(['telepty', 'daemon', 'status']), 0);
    assert.equal(h.rec.procs.length, 1);
    assert.deepEqual(h.rec.procs[0].args.slice(1), ['daemon', 'status']);
  });

  it('deliberation routes only doctor/install to their sub-bins', async (t) => {
    const fx = H.makeFixture(t);
    H.installAllBundled(fx);
    const dir = H.pkgDir(fx.meta, H.COMPONENTS.deliberation.pkg);
    for (const [sub, file] of [['doctor', 'doctor.js'], ['install', 'install.js']]) {
      const h = H.makeRt(fx, { procs: passthroughProcs({ status: 0 }) });
      assert.equal(await h.run(['deliberation', sub, '--flag']), 0);
      assert.equal(h.rec.procs.length, 1);
      assert.equal(h.rec.procs[0].args[0], path.join(dir, file));
      assert.deepEqual(h.rec.procs[0].args.slice(1), ['--flag'], 'the sub-command word is consumed, the rest forwarded');
    }
    for (const sub of ['serve', 'mcp', '--help-not-a-sub']) {
      const h = H.makeRt(fx);
      assert.equal(await h.run(['deliberation', sub]), 2, `deliberation ${sub}`);
      noProcs(h);
    }
  });

  for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'x64'], ['win32', 'x64']]) {
    it(`aterm on ${platform}-${arch} → exit 6, nothing executed`, async (t) => {
      const fx = H.makeFixture(t);
      H.installAllBundled(fx);
      const h = H.makeRt(fx, { platform, arch });
      assert.equal(await h.run(['aterm', 'list']), 6);
      noProcs(h);
    });
  }

  it('a component that is not installed → exit 3, nothing executed', async (t) => {
    const fx = H.makeFixture(t);
    H.installBundled(fx, 'telepty');
    const h = H.makeRt(fx);
    assert.equal(await h.run(['brain', 'status']), 3);
    noProcs(h);
  });

  it('orchestrator is never taken from the bundled tree (PATH only)', async (t) => {
    const fx = H.makeFixture(t);
    H.installAllBundled(fx);
    H.installBundled(fx, 'orchestrator');
    const h = H.makeRt(fx);
    assert.equal(await h.run(['orchestrator', '--version']), 3);
    noProcs(h);
  });
});
