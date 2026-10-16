'use strict';
// Area 4: PATH vs bundled provenance, Windows npm .cmd resolution without execution, paths with spaces,
// malicious argv literal, Python `aigentry` collision and foreign bin rejection.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers/fixture');

const POSIX_ONLY = H.HOST_IS_WIN ? 'POSIX PATH layout; exercised natively on the Linux/macOS runners' : false;
const real = (p) => fs.realpathSync(p);

function recordOne(fx, opts) {
  return H.makeRt(fx, Object.assign({ procs: H.makeProcs(() => ({ status: 0 })) }, opts));
}

async function statusDoc(fx, opts) {
  const h = H.makeRt(fx, Object.assign({ http: H.fakeDaemon({ health: H.P.refused() }) }, opts));
  assert.equal(await h.run(['status', '--json']), 0);
  assert.deepEqual(h.rec.procs, []);
  return H.parseOneJson(h.stdout());
}

describe('PATH copy before bundled copy (POSIX)', { skip: POSIX_ONLY }, () => {
  it('a PATH copy owned by the component package wins and is run through execPath', async (t) => {
    const fx = H.makeFixture(t);
    H.installAllBundled(fx);
    const onPath = H.installOnPathDirect(fx, 'telepty', { spec: { version: '0.8.9', bin: { telepty: 'bin/telepty' } } });
    const env = { PATH: onPath.binDirs.join(path.delimiter) };
    const h = recordOne(fx, { env });
    assert.equal(await h.run(['telepty', 'list', '--json']), 0);
    assert.equal(h.rec.procs.length, 1);
    const [c] = h.rec.procs;
    assert.equal(c.cmd, H.FAKE_NODE);
    assert.equal(real(c.args[0]), real(onPath.file('telepty')));
    assert.ok(c.args[0].includes(' '), 'fixture path with spaces is passed as one argv element');
    assert.deepEqual(c.args.slice(1), ['list', '--json']);
    const doc = await statusDoc(fx, { env });
    const row = doc.components.find((x) => x.name === 'telepty');
    assert.equal(row.source, 'path');
    assert.equal(row.version, '0.8.9');
    assert.equal(row.onPath, true);
  });

  it('npm global symlink layout resolves through realpath to the owning package', async (t) => {
    const fx = H.makeFixture(t);
    H.installAllBundled(fx);
    const g = H.linkOnPath(fx, 'devkit', { spec: { version: '0.1.50' } });
    const h = recordOne(fx);
    assert.equal(await h.run(['devkit', 'doctor']), 0);
    assert.equal(real(h.rec.procs[0].args[0]), real(g.file('aigentry-devkit')));
    const row = (await statusDoc(fx)).components.find((x) => x.name === 'devkit');
    assert.equal(row.source, 'path');
    assert.equal(row.version, '0.1.50');
  });

  it('a foreign `telepty` on PATH (no owning package) is never executed; bundled is used', async (t) => {
    const fx = H.makeFixture(t);
    H.installAllBundled(fx);
    H.write(path.join(fx.pathDir, 'telepty'), '#!/bin/sh\necho foreign\n', 0o755);
    const h = recordOne(fx);
    assert.equal(await h.run(['telepty', '--version']), 0);
    assert.equal(h.rec.procs.length, 1);
    assert.equal(h.rec.procs[0].args[0], path.join(H.pkgDir(fx.meta, H.COMPONENTS.telepty.pkg), 'cli.js'));
    assert.equal((await statusDoc(fx)).components.find((x) => x.name === 'telepty').source, 'bundled');
  });

  it('a Node `telepty` on PATH owned by a different package is rejected', async (t) => {
    const fx = H.makeFixture(t);
    H.installAllBundled(fx);
    const evil = path.join(fx.root, 'evil pkg');
    H.write(path.join(evil, 'package.json'), JSON.stringify({ name: 'telepty-typosquat', version: '9.9.9', bin: { telepty: 'telepty' } }));
    H.write(path.join(evil, 'telepty'), H.NODE_BIN_SRC, 0o755);
    const h = recordOne(fx, { env: { PATH: evil } });
    assert.equal(await h.run(['telepty', 'list']), 0);
    assert.ok(!real(h.rec.procs[0].args[0]).startsWith(real(evil)), 'foreign package never executed');
  });

  it('a non-Node bundled bin is not executed', async (t) => {
    const fx = H.makeFixture(t);
    H.installAllBundled(fx);
    H.installBundled(fx, 'brain', { spec: { bin: { 'aigentry-brain': 'bin/aigentry-brain' } }, binSource: '#!/bin/sh\nexit 0\n' });
    const h = H.makeRt(fx);
    assert.notEqual(await h.run(['brain', 'status']), 0);
    assert.deepEqual(h.rec.procs, []);
  });
});

describe('self on PATH vs the Python registry `aigentry` (POSIX)', { skip: POSIX_ONLY }, () => {
  it('a Python console script named aigentry is foreign and never run', async (t) => {
    const fx = H.makeFixture(t);
    H.installAllBundled(fx);
    const py = H.write(path.join(fx.pathDir, 'aigentry'), '#!/usr/bin/python3\n# -*- coding: utf-8 -*-\nimport sys\nfrom aigentry.cli import main\nsys.exit(main())\n', 0o755);
    const h = H.makeRt(fx, { http: H.fakeDaemon({ health: H.P.refused() }) });
    const self = h.lib.resolve.inspectSelfOnPath(h.rt);
    assert.equal(self.state, 'foreign');
    assert.equal(real(self.file), real(py));
    assert.equal(await h.run(['doctor', '--json']), h.lib.commands.doctorExitCode(H.parseOneJson(h.stdout()).checks));
    assert.notEqual(H.checkById(H.parseOneJson(h.stdout()), 'meta.path').state, 'ok');
    assert.deepEqual(h.rec.procs, []);
  });

  it('our own bin on PATH is self; nothing on PATH is absent', async (t) => {
    const fx = H.makeFixture(t);
    const h0 = H.makeRt(fx);
    assert.equal(h0.lib.resolve.inspectSelfOnPath(h0.rt).state, 'absent');
    fs.symlinkSync(path.join(fx.meta, 'bin', 'aigentry.js'), path.join(fx.pathDir, 'aigentry'));
    const h1 = H.makeRt(fx);
    assert.equal(h1.lib.resolve.inspectSelfOnPath(h1.rt).state, 'self');
  });
});

describe('Windows npm .cmd shims (simulated platform; native run is the Windows CI job)', () => {
  const PATHEXT = H.HOST_IS_WIN ? '.COM;.EXE;.BAT;.CMD' : '.com;.exe;.bat;.cmd';
  for (const layout of ['prefix', 'dotbin']) {
    it(`${layout} layout: resolves the package's JS bin and never runs the .cmd`, async (t) => {
      const fx = H.makeFixture(t);
      H.installAllBundled(fx);
      const shim = H.winShim(fx, 'telepty', layout);
      const env = { PATH: shim.shimDir, PATHEXT };
      const evil = ['/c', 'calc.exe', '&', 'del', '%USERPROFILE%', '^&', '"quoted arg"', 'a b'];
      const h = recordOne(fx, { platform: 'win32', arch: 'x64', env });
      assert.equal(await h.run(['telepty', ...evil]), 0);
      assert.equal(h.rec.procs.length, 1);
      const [c] = h.rec.procs;
      assert.equal(c.cmd, H.FAKE_NODE, 'runs execPath, never cmd.exe or the shim');
      assert.equal(path.resolve(c.args[0]), shim.file('telepty'));
      assert.ok(!/\.cmd$/i.test(c.args[0]));
      assert.deepEqual(c.args.slice(1), evil);
      assert.equal(c.opts.shell, false);
      const doc = await statusDoc(fx, { platform: 'win32', arch: 'x64', env });
      assert.equal(doc.components.find((x) => x.name === 'telepty').source, 'path');
    });
  }

  it('a .cmd with no owning package beside it is ignored in favour of bundled', async (t) => {
    const fx = H.makeFixture(t);
    H.installAllBundled(fx);
    const dir = path.join(fx.root, 'stray shims');
    H.write(path.join(dir, 'telepty.cmd'), '@ECHO off\r\nEXIT /b 99\r\n');
    const h = recordOne(fx, { platform: 'win32', arch: 'x64', env: { PATH: dir, PATHEXT } });
    assert.equal(await h.run(['telepty', 'list']), 0);
    assert.equal(h.rec.procs[0].args[0], path.join(H.pkgDir(fx.meta, H.COMPONENTS.telepty.pkg), 'cli.js'));
  });
});

describe('bundled resolution (any host)', () => {
  it('bundled copies are found by a node_modules walk from metaRoot with spaces in the path', async (t) => {
    const fx = H.makeFixture(t);
    H.installAllBundled(fx);
    const doc = await statusDoc(fx, { env: { PATH: path.join(fx.root, 'empty') } });
    for (const n of H.BUNDLED) {
      const row = doc.components.find((x) => x.name === n);
      assert.equal(row.installed, true, n);
      assert.equal(row.source, 'bundled', n);
      assert.equal(row.version, H.COMPONENTS[n].version, n);
    }
  });

  it('a bundled package whose bin escapes the package root is not executed', async (t) => {
    const fx = H.makeFixture(t);
    H.installAllBundled(fx);
    H.installBundled(fx, 'devkit', { packageJson: { bin: { 'aigentry-devkit': '../../../escape.js' } } });
    H.write(path.join(fx.meta, 'escape.js'), H.NODE_BIN_SRC);
    const h = H.makeRt(fx);
    assert.notEqual(await h.run(['devkit', 'setup']), 0);
    assert.deepEqual(h.rec.procs, []);
  });
});

describe('setup-specific resolver trust boundary', () => {
  it('a broken preferred PATH package cannot fall back to bundled setup', async (t) => {
    const fx = H.makeFixture(t);
    H.installBundled(fx, 'devkit');
    const preferred = H.installOnPathDirect(fx, 'devkit');
    const f = path.join(preferred.dir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(f));
    pkg.bin['aigentry-devkit'] = 'missing.js';
    fs.writeFileSync(f, JSON.stringify(pkg));
    const h = H.makeRt(fx, { platform: process.platform, arch: process.arch,
      env: { PATH: preferred.binDirs.join(path.delimiter) } });
    assert.equal(await h.run(['setup']), 1);
    assert.match(h.stderr(), /SETUP_INCOMPATIBLE/);
    assert.deepEqual(h.rec.procs, []);
  });
  it('package metadata outside the selected package refuses before module loading', async (t) => {
    const fx = H.makeFixture(t);
    const dir = H.installBundled(fx, 'devkit');
    const f = path.join(dir, 'package.json');
    const outside = H.write(path.join(fx.root, 'foreign-package.json'), fs.readFileSync(f));
    fs.unlinkSync(f);
    fs.symlinkSync(outside, f);
    const h = H.makeRt(fx, { platform: process.platform, arch: process.arch });
    assert.equal(await h.run(['setup']), 1);
    assert.match(h.stderr(), /SETUP_INCOMPATIBLE/);
    assert.deepEqual(h.rec.procs, []);
  });
});
