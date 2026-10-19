'use strict';
// Actual frozen devkit closure supplied by the engineering/test owner; never a copied wizard.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const H = require('./helpers/fixture');
const DEVKIT = process.env.U1_DEVKIT_FIXTURE_ROOT;
assert.ok(DEVKIT && path.isAbsolute(DEVKIT), 'supply the frozen devkit fixture package');
const FILES = ['package.json', 'lib/setup.js', 'lib/install-state.js',
  'bin/aigentry-devkit.js', 'config/installer-manifest.json', 'config/setup-capabilities.json'];
const CHOICES = ['--non-interactive', '--profile', 'core', '--runtime', 'defer', '--configure-only'];

const WINDOWS = process.platform === 'win32';
// Intentionally not a digest: Windows cannot authorize persistence here.
const UNAPPROVED = 'synthetic-unapproved-storage-refusal';
function storageRefusal(fx, r, code = 1) {
  assert.equal(r.code, code, diagnostic(r));
  assert.match(r.err, /setup: setup persistence unavailable: native private storage proof required\n/, diagnostic(r));
  assert.ok(require.cache[path.join(fx.pkg, 'lib/setup.js')], 'actual devkit module reached');
  assert.doesNotMatch(r.out + r.err, /Configure-only preview|--accept-plan [a-f0-9]{64}|Preference saved:/);
  assert.deepEqual(r.procs, []);
}

// Metadata only; mirrors frozen f4 setupIdentity/inspectSetupStorage order.
// Classification is not the product error and does not inspect journal contents.
function storageMetadata(fx) {
  const dir = path.join(fx.config, 'aigentry-devkit');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const rows = [];
  let firstFailure = null;
  const fail = (file, predicate) => { if (!firstFailure) firstFailure = { path: file, predicate }; };
  if (!['darwin', 'linux'].includes(process.platform) || uid === null) fail(dir, 'native private storage proof required');
  if (!path.isAbsolute(dir) || path.normalize(dir) !== dir) fail(dir, 'unsafe setup destination');
  const parts = dir.slice(path.parse(dir).root.length).split(path.sep).filter(Boolean);
  if (parts.length > 60) fail(dir, 'diagnostic ancestor bound exceeded; admission unmeasured');
  const inspect = (file, directory, privateMode, lock = false) => {
    const row = { path: file };
    try {
      const st = fs.lstatSync(file);
      Object.assign(row, { presence: true, type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
        symlink: st.isSymbolicLink(), uid: st.uid, mode: '0' + (st.mode & 0o7777).toString(8), nlink: st.nlink, size: st.size });
      if (lock) fail(file, 'setup journal locked; owner recovery required');
      else if (st.isSymbolicLink()) fail(file, 'symlink');
      else if (directory ? !st.isDirectory() : !st.isFile()) fail(file, 'type');
      else if (st.uid !== uid && !(directory && !privateMode && st.uid === 0)) fail(file, 'uid');
      else if (privateMode ? (st.mode & 0o777) !== (directory ? 0o700 : 0o600) : (st.mode & 0o022) !== 0) fail(file, 'mode');
      else if (!directory && st.nlink !== 1) fail(file, 'nlink');
      else if (!directory && st.size > 1024 * 1024) fail(file, 'size');
    } catch (err) {
      row.presence = err.code === 'ENOENT' ? false : 'unknown';
      row.error = err.code || 'unknown';
      if (err.code !== 'ENOENT') fail(file, 'setup destination unreadable');
    }
    rows.push(row);
  };
  let cursor = path.parse(dir).root;
  for (const part of parts.slice(0, 60)) {
    cursor = path.join(cursor, part);
    inspect(cursor, true, cursor === dir);
  }
  inspect(path.join(dir, 'install-journal.json'), false, true);
  inspect(path.join(dir, 'install-state.json'), false, true);
  inspect(path.join(dir, 'install-journal.lock'), false, true, true);
  return { canonicalStatePath: dir, uid, classification: firstFailure,
    scope: 'metadata only; journal/state contents and history unmeasured', rows };
}
function metadataDiagnostic(metadata) {
  const text = JSON.stringify(metadata).replace(/[\u007f-\u009f\u2028\u2029]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return text.length <= 32768 ? text : text.slice(0, 32700) + '...[metadata truncated]';
}

function diagnostic(r) {
  const quote = s => JSON.stringify(s.slice(0, 2048) + (s.length > 2048 ? '...[truncated]' : ''))
    .replace(/[\u007f-\u009f\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return `code=${r.code} stdout=${quote(r.out)} stderr=${quote(r.err)}`;
}
function fixture(actual = true) {
  // Retained for exact emitted-byte review; the enclosing test runner owns cleanup.
  const fx = H.makeFixture();
  fx.pkg = H.installBundled(fx, 'devkit');
  if (actual) for (const rel of FILES) {
    H.write(path.join(fx.pkg, rel), fs.readFileSync(path.join(DEVKIT, rel)));
  }
  fx.config = path.join(fx.home, '.config');
  fs.mkdirSync(fx.config, { mode: 0o700 });
  if (process.env.AIGENTRY_TEST_FIXTURE_ROOT && ['darwin', 'linux'].includes(process.platform)) {
    const metadata = storageMetadata(fx);
    assert.equal(metadata.classification, null, 'setup fixture admission failed: ' + metadataDiagnostic(metadata));
  }
  // Metadata-only detection may see these files, but must never execute them.
  for (const name of ['docker', 'podman', 'orb', 'claude', 'npm']) {
    H.write(path.join(fx.pathDir, name), '#!/bin/sh\nexit 99\n', 0o700);
  }
  return fx;
}

async function invoke(fx, argv, { input, writes = false, procs } = {}) {
  const oldEnv = process.env;
  process.env = { HOME: fx.home, USERPROFILE: fx.home, XDG_CONFIG_HOME: fx.config,
    TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP, PATH: fx.pathDir };
  const stdin = Readable.from(input === undefined ? [] : input);
  stdin.isTTY = input !== undefined;
  const before = H.snapshotTree(fx.root);
  const saved = [];
  const effects = [];
  const patch = (obj, key) => {
    const original = obj[key];
    saved.push(() => { obj[key] = original; });
    obj[key] = () => { effects.push(key); throw Error('forbidden effect: ' + key); };
  };
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) patch(require('node:child_process'), key);
  for (const mod of ['node:http', 'node:https']) for (const key of ['request', 'get']) patch(require(mod), key);
  for (const key of ['connect', 'createConnection']) patch(require('node:net'), key);
  patch(require('node:net').Socket.prototype, 'connect');
  patch(require('node:tls'), 'connect');
  patch(globalThis, 'fetch');
  let h, result;
  try {
    const call = async () => {
      h = H.makeRt(fx, { platform: process.platform, arch: process.arch, procs });
      h.rt.stdin = stdin;
      return h.run(argv);
    };
    if (writes) result = await call();
    else {
      const trapped = await H.withSideEffectTrap(call);
      result = trapped.result;
      assert.deepEqual(trapped.violations, [], 'no writes or real children before consent');
    }
    assert.deepEqual(effects, [], 'no process/network access');
    assert.deepEqual(h.rec.http, [], 'setup must not call doctor/status probes');
    if (!writes) assert.deepEqual(H.snapshotTree(fx.root), before, 'complete fixture unchanged');
    return { code: result, out: h.stdout(), err: h.stderr(), procs: h.rec.procs };
  } finally {
    for (const restore of saved.reverse()) restore();
    const record = { argv, env: { ...process.env }, platform: process.platform, arch: process.arch,
      status: result, signal: null, stdout: h ? h.stdout() : '', stderr: h ? h.stderr() : '',
      effects, procs: h ? h.rec.procs : [] };
    process.env = oldEnv;
    stdin.destroy();
    fs.appendFileSync(path.join(fx.root, 'calls.jsonl'), JSON.stringify(record) + '\n');
  }
}

test('canonical setup reaches the actual inert devkit preview without a child', async t => {
  const fx = fixture();
  t.diagnostic('setup storage metadata classification: ' + metadataDiagnostic(storageMetadata(fx)));
  const r = await invoke(fx, ['setup', ...CHOICES, '--dry-run']);
  if (WINDOWS) storageRefusal(fx, r);
  else {
    assert.equal(r.code, 0, diagnostic(r));
    assert.match(r.out, /Configure-only preview/);
  }
  assert.deepEqual(r.procs, []);
});

test('old exact devkit setup refuses without launching the legacy installer', async () => {
  const fx = fixture(false);
  const r = await invoke(fx, ['devkit', 'setup'], { procs: H.makeProcs(() => ({ status: 0 })) });
  assert.deepEqual(r.procs, [], 'legacy installer must never be launched');
  assert.equal(r.code, 1);
  assert.match(r.err, /SETUP_INCOMPATIBLE/);
});

const ROUTES = [['setup'], ['install'], ['devkit', 'setup'], ['devkit', 'install']];
function consent(text, detail = '') {
  const match = text.match(/--accept-plan ([a-f0-9]{64})/);
  assert.ok(match, 'actual devkit emits a consent digest ' + detail);
  return match[1];
}
for (const route of ROUTES) {
  test(route.join(' ') + ' calls actual module; missing and stale consent stay read-only', async () => {
    const fx = fixture();
    const preview = await invoke(fx, [...route, ...CHOICES, '--dry-run']);
    if (WINDOWS) storageRefusal(fx, preview);
    else {
      assert.equal(preview.code, 0, diagnostic(preview));
      assert.match(preview.out, /not runtime-verified/);
    }
    assert.deepEqual(preview.procs, []);
    for (const args of [CHOICES, [...CHOICES, '--accept-plan', '0'.repeat(64)]]) {
      const refused = await invoke(fx, [...route, ...args]);
      assert.equal(refused.code, 1);
      if (WINDOWS) storageRefusal(fx, refused);
      else assert.match(refused.err, /missing or stale/);
      assert.deepEqual(refused.procs, []);
    }
    if (!WINDOWS) assert.ok(consent(preview.out));
  });
}
test('all four aliases produce the same real plan and stream output', async () => {
  const fx = fixture();
  const outputs = [];
  for (const route of ROUTES) outputs.push(await invoke(fx, [...route, ...CHOICES, '--dry-run']));
  for (const r of outputs) {
    if (WINDOWS) storageRefusal(fx, r);
    else assert.equal(r.code, 0, diagnostic(r));
    assert.equal(r.out, outputs[0].out);
    if (WINDOWS) assert.equal(r.err, outputs[0].err);
    else assert.equal(r.err, '');
  }
});
for (const [label, input, code, pattern] of [
  ['cancel', ['cancel\n'], 1, /cancelled/],
  ['EOF', [], 1, /cancelled/],
  ['unsaved defer', ['core\ndefer\nskip\n'], 0, /Configure-only preview/],
  ['interactive preview', ['core\ndefer\n'], 0, /Configure-only preview/]
]) {
  test(label + ' has no child, network or write effects', async () => {
    const fx = fixture();
    const args = label === 'interactive preview' ? ['--dry-run'] : [];
    const r = await invoke(fx, ['setup', ...args], { input });
    if (WINDOWS && (label === 'unsaved defer' || label === 'interactive preview')) {
      storageRefusal(fx, r, label === 'unsaved defer' ? 0 : 1);
      if (label === 'unsaved defer') assert.match(r.out, /Skipped without saving\./);
      else assert.match(r.err, /cancelled/);
    } else {
      assert.equal(r.code, code, diagnostic(r));
      assert.match(r.out + r.err, pattern, diagnostic(r));
    }
    assert.deepEqual(r.procs, []);
  });
}
test('configure-only saves the actual approved local journal; revisit requires fresh consent', async () => {
  const fx = fixture();
  const preview = await invoke(fx, ['setup', ...CHOICES, '--dry-run']);
  if (WINDOWS) {
    // Unsupported storage coverage, not approved-save/revisit consent coverage.
    storageRefusal(fx, preview);
    const saved = await invoke(fx, ['devkit', 'install', ...CHOICES, '--accept-plan', UNAPPROVED]);
    storageRefusal(fx, saved);
    const revisit = await invoke(fx, ['install', ...CHOICES, '--revisit']);
    storageRefusal(fx, revisit);
    assert.equal(fs.existsSync(path.join(fx.config, 'aigentry-devkit')), false);
  } else {
    assert.equal(preview.code, 0, diagnostic(preview));
    const saved = await invoke(fx, ['devkit', 'install', ...CHOICES, '--accept-plan', consent(preview.out)], { writes: true });
    assert.equal(saved.code, 0, diagnostic(saved));
    assert.match(saved.out, /Preference saved: deferred, not runtime-verified/);
    assert.deepEqual(saved.procs, []);
    const stateDir = path.join(fx.config, 'aigentry-devkit');
    const file = path.join(stateDir, 'install-journal.json');
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(journal.setup.plan_digest, consent(preview.out));
    assert.equal(journal.setup.verification, 'not-verified');
    assert.equal(journal.attempts.length, 1);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(stateDir), ['install-journal.json']);
    const revisit = await invoke(fx, ['install', ...CHOICES, '--revisit']);
    assert.equal(revisit.code, 1);
    assert.match(revisit.out, /Saved suggestion only/);
    assert.match(revisit.err, /missing or stale/);
  }
});
test('package source identity change invalidates previously approved plan', async () => {
  const fx = fixture();
  const preview = await invoke(fx, ['setup', ...CHOICES, '--dry-run']);
  const pkgFile = path.join(fx.pkg, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.description += ' fixture identity change';
  fs.writeFileSync(pkgFile, JSON.stringify(pkg));
  // Windows has no approved digest: retain mutation/apply as storage-refusal coverage.
  if (WINDOWS) storageRefusal(fx, preview);
  const r = await invoke(fx, ['setup', ...CHOICES, '--accept-plan', WINDOWS ? UNAPPROVED : consent(preview.out, diagnostic(preview))]);
  assert.equal(r.code, 1);
  if (WINDOWS) storageRefusal(fx, r);
  else assert.match(r.err, /missing or stale/);
});
for (const [label, mutate] of [
  ['same-version missing module', fx => fs.unlinkSync(path.join(fx.pkg, 'lib/setup.js'))],
  ['wrong package', fx => {
    const f = path.join(fx.pkg, 'package.json'), pkg = JSON.parse(fs.readFileSync(f));
    pkg.name = 'wrong-package'; fs.writeFileSync(f, JSON.stringify(pkg));
  }],
  ['old version', fx => {
    const f = path.join(fx.pkg, 'package.json'), pkg = JSON.parse(fs.readFileSync(f));
    pkg.version = '0.1.13'; fs.writeFileSync(f, JSON.stringify(pkg));
  }],
  ['unsupported version', fx => {
    const f = path.join(fx.pkg, 'package.json'), pkg = JSON.parse(fs.readFileSync(f));
    pkg.version = '0.2.0'; fs.writeFileSync(f, JSON.stringify(pkg));
  }],
  ['malformed version', fx => {
    const f = path.join(fx.pkg, 'package.json'), pkg = JSON.parse(fs.readFileSync(f));
    pkg.version = 'unknown'; fs.writeFileSync(f, JSON.stringify(pkg));
  }],
  ['old contract', fx => fs.writeFileSync(path.join(fx.pkg, 'lib/setup.js'), 'module.exports = { contractMajor: 0, run: async () => 0 };\n')],
  ['missing run', fx => fs.writeFileSync(path.join(fx.pkg, 'lib/setup.js'), 'module.exports = { contractMajor: 1 };\n')],
  ['broken load', fx => fs.writeFileSync(path.join(fx.pkg, 'lib/setup.js'), "throw Error('PRIVATE_MODULE_ERROR');\n")],
  ['module symlink escape', fx => {
    const outside = H.write(path.join(fx.root, 'outside.js'), "throw Error('ESCAPED_MODULE_EXECUTED');\n");
    fs.unlinkSync(path.join(fx.pkg, 'lib/setup.js'));
    fs.symlinkSync(outside, path.join(fx.pkg, 'lib/setup.js'));
  }],
  ['bin symlink escape', fx => {
    const pkg = JSON.parse(fs.readFileSync(path.join(fx.pkg, 'package.json')));
    const bin = path.join(fx.pkg, pkg.bin['aigentry-devkit']);
    const outside = H.write(path.join(fx.root, 'outside-bin.js'), H.NODE_BIN_SRC);
    fs.unlinkSync(bin); fs.symlinkSync(outside, bin);
  }],
  ['PATH shadow', fx => H.write(path.join(fx.pathDir, WINDOWS ? 'aigentry-devkit.cmd' : 'aigentry-devkit'),
    WINDOWS ? '@rem inert shadow; never execute\r\n' : H.NODE_BIN_SRC, 0o700)]
]) {
  test(label + ' refuses without fallback or effects', async () => {
    const fx = fixture();
    mutate(fx);
    const r = await invoke(fx, ['install', ...CHOICES, '--dry-run']);
    assert.equal(r.code, 1);
    assert.match(r.err, /^SETUP_INCOMPATIBLE:/, diagnostic(r));
    assert.ok(!r.err.includes('PRIVATE_MODULE_ERROR'));
    assert.ok(!r.err.includes('ESCAPED_MODULE_EXECUTED'));
    assert.deepEqual(r.procs, []);
  });
}
test('absent devkit preserves missing-package exit 3', async () => {
  const fx = fixture();
  fs.rmSync(fx.pkg, { recursive: true });
  const r = await invoke(fx, ['setup']);
  assert.equal(r.code, 3);
  assert.match(r.err, /NOT_INSTALLED/);
  assert.deepEqual(r.procs, []);
});
test('supported newer version with contract1 remains supported', async () => {
  const fx = fixture();
  const file = path.join(fx.pkg, 'package.json'), pkg = JSON.parse(fs.readFileSync(file));
  pkg.version = '0.1.50'; fs.writeFileSync(file, JSON.stringify(pkg));
  const r = await invoke(fx, ['setup', ...CHOICES, '--dry-run']);
  if (WINDOWS) storageRefusal(fx, r);
  else {
    assert.equal(r.code, 0, diagnostic(r));
    assert.match(r.out, /0.1.50/);
  }
});
test('a valid contract numeric return and custom streams pass through unchanged', async () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.pkg, 'lib/setup.js'),
    "module.exports = { contractMajor: 1, run: async (args, io) => { io.stdout.write(JSON.stringify(args)); io.stderr.write('fixture stderr'); return 42; } };\n");
  const args = ['--unknown', 'two words', '$(id)', ''];
  const r = await invoke(fx, ['setup', ...args]);
  assert.equal(r.code, 42);
  assert.equal(r.out, JSON.stringify(args));
  assert.equal(r.err, 'fixture stderr');
});

for (const route of ROUTES) {
  for (const fallback of ['bundled', 'later PATH']) {
    for (const broken of [true, false]) {
      test('preferred PATH presence: ' + route.join(' ') + ' / ' + fallback + ' / ' + (broken ? 'dangling' : 'absent'), async () => {
        const fx = fixture();
        const preferred = fx.pathDir;
        if (fallback === 'later PATH') {
          const later = path.join(fx.root, 'later bin');
          fs.mkdirSync(later);
          const pkg = JSON.parse(fs.readFileSync(path.join(fx.pkg, 'package.json')));
          if (WINDOWS) {
            const moved = path.join(later, 'node_modules', '@dmsdc-ai', 'aigentry-devkit');
            fs.mkdirSync(path.dirname(moved), { recursive: true });
            fs.renameSync(fx.pkg, moved);
            H.write(path.join(later, 'aigentry-devkit.cmd'), '@rem inert npm-style marker; never execute\r\n');
            fx.pkg = moved;
          } else {
            fs.symlinkSync(path.join(fx.pkg, pkg.bin['aigentry-devkit']), path.join(later, 'aigentry-devkit'));
            const moved = path.join(fx.global, 'devkit');
            fs.renameSync(fx.pkg, moved);
            fs.unlinkSync(path.join(later, 'aigentry-devkit'));
            fs.symlinkSync(path.join(moved, pkg.bin['aigentry-devkit']), path.join(later, 'aigentry-devkit'));
            fs.chmodSync(path.join(moved, pkg.bin['aigentry-devkit']), 0o700);
            fx.pkg = moved;
          }
          fx.pathDir = preferred + path.delimiter + later;
        }
        if (broken) {
          if (WINDOWS) {
            const dangling = path.join(preferred, 'aigentry-devkit.cmd');
            fs.symlinkSync(path.join(fx.root, 'missing.js'), dangling, 'file');
            assert.ok(fs.lstatSync(dangling).isSymbolicLink());
            assert.throws(() => fs.statSync(dangling), { code: 'ENOENT' });
            assert.throws(() => fs.realpathSync(dangling), { code: 'ENOENT' });
          } else fs.symlinkSync(path.join(fx.root, 'missing.js'), path.join(preferred, 'aigentry-devkit'));
        }
        const moduleFile = path.join(fx.pkg, 'lib/setup.js');
        assert.equal(require.cache[moduleFile], undefined);
        const r = await invoke(fx, [...route, ...CHOICES, '--dry-run']);
        assert.deepEqual(r.procs, []);
        if (broken) {
          assert.equal(r.code, 1, diagnostic(r));
          assert.equal(r.out, '', diagnostic(r));
          assert.equal(r.err, 'SETUP_INCOMPATIBLE: trusted devkit setup contract 1 is required within the supported package range. Ask the package owner to repair/update the selected devkit package and remove PATH shadows; legacy installation was not run.\n');
          assert.equal(require.cache[moduleFile], undefined, 'fallback module must not be imported');
        } else {
          if (WINDOWS) storageRefusal(fx, r);
          else {
            assert.equal(r.code, 0, diagnostic(r));
            assert.match(r.out, /Configure-only preview/);
            assert.equal(r.err, '');
          }
          assert.ok(require.cache[moduleFile], 'genuinely absent preferred entry allows valid fallback');
        }
      });
    }
  }
  test('preferred PATH presence: ' + route.join(' ') + ' / all absent', async () => {
    const fx = fixture();
    fs.rmSync(fx.pkg, { recursive: true });
    const r = await invoke(fx, [...route, ...CHOICES, '--dry-run']);
    assert.equal(r.code, 3);
    assert.equal(r.out, '');
    assert.equal(r.err, 'NOT_INSTALLED: @dmsdc-ai/aigentry-devkit was not found. Install the supported aigentry package through your package owner.\n');
    assert.deepEqual(r.procs, []);
  });
}
