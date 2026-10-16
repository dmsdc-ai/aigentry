'use strict';

// Executable provenance (DECISIONS R9): a component command is resolved to the Node bin
// file of the package that declares it — PATH copy first, bundled copy second — and is run
// as `process.execPath <binFile> …`. fs only: no shell string, no `command -v`, no `where`,
// and a Windows `.cmd` shim is never executed (its package's bin file is run instead).

const fs = require('fs');
const path = require('path');

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const META_PACKAGE = '@dmsdc-ai/aigentry';

/**
 * @typedef {Object} ResolvedBin
 * @property {string} file      absolute bin file inside the package
 * @property {string} root      package root
 * @property {string} version
 * @property {'path'|'bundled'|'node_modules'} source
 * @property {string|null} via  the PATH entry it was found through (path source only)
 */

/** Read at most `max` bytes of a regular file; null when it is absent, not a file or too big. */
function readSmallFile(file, max) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readPackageJson(root) {
  const text = readSmallFile(path.join(root, 'package.json'), MAX_PACKAGE_JSON_BYTES);
  if (text == null) return null;
  try {
    const pkg = JSON.parse(text);
    return pkg && typeof pkg === 'object' && !Array.isArray(pkg) ? pkg : null;
  } catch {
    return null;
  }
}

/** `bin` as an object map; a string `bin` is keyed by the unscoped package name (npm rule). */
function binMap(pkg) {
  if (!pkg || !pkg.bin) return {};
  if (typeof pkg.bin === 'string') return { [String(pkg.name || '').split('/').pop()]: pkg.bin };
  return typeof pkg.bin === 'object' ? pkg.bin : {};
}

function isInside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Node can run it directly: a .js/.mjs/.cjs file or a `#!…node` script. */
function isNodeScript(file) {
  if (/\.(c|m)?js$/i.test(file)) return true;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString('utf8').split('\n')[0];
    return first.startsWith('#!') && /\bnode\b/.test(first);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Bin file of `binName` inside the package at `root`, if the package declares it. */
function binFileIn(root, pkg, binName) {
  const rel = binMap(pkg)[binName];
  if (typeof rel !== 'string' || !rel) return { file: null, reason: 'not-declared' };
  const file = path.resolve(root, rel);
  if (!isInside(root, file)) return { file: null, reason: 'outside-package' };
  try {
    if (!fs.statSync(file).isFile()) return { file, reason: 'not-a-file' };
  } catch {
    return { file, reason: 'missing-file' };
  }
  if (!isNodeScript(file)) return { file, reason: 'not-node-script' };
  return { file, reason: null };
}

function pathDirs(rt) {
  const env = rt.env || {};
  const key = rt.platform === 'win32'
    ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'
    : 'PATH';
  const raw = env[key] || '';
  const sep = rt.platform === 'win32' ? ';' : ':';
  return raw.split(sep).filter((d) => d && path.isAbsolute(d.replace(/^"|"$/g, ''))).map((d) => d.replace(/^"|"$/g, ''));
}

/** Every executable named `name` on PATH, in PATH order. */
function findOnPath(name, rt) {
  const hits = [];
  const exts = rt.platform === 'win32'
    ? String((rt.env && (rt.env.PATHEXT || rt.env.Pathext)) || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of pathDirs(rt)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext.toLowerCase());
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) continue;
        if (rt.platform !== 'win32' && (st.mode & 0o111) === 0) continue;
        hits.push({ file, dir });
      } catch { /* not here */ }
    }
  }
  return hits;
}

/** Nearest ancestor directory of `file` holding a named package.json (bounded walk). */
function packageRootOf(file) {
  let dir = path.dirname(file);
  for (let i = 0; i < 8; i++) {
    const pkg = readPackageJson(dir);
    if (pkg && typeof pkg.name === 'string') return { root: dir, pkg }; // skip `{"type":…}` markers
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Which package a PATH hit belongs to. POSIX: the npm link is a symlink, so follow it.
 * win32: the hit is a `.cmd`/`.ps1` shim; npm keeps the package beside it
 * (`<prefix>/node_modules/<pkg>`, or `<node_modules>/.bin/../<pkg>` for a local install).
 */
function packageOfPathHit(hit, pkgName, rt) {
  const candidates = [];
  if (rt.platform === 'win32') {
    candidates.push(path.join(hit.dir, 'node_modules', ...pkgName.split('/')));
    candidates.push(path.join(hit.dir, '..', ...pkgName.split('/')));
  }
  for (const root of candidates) {
    const pkg = readPackageJson(root);
    if (pkg && pkg.name === pkgName) return { root: path.resolve(root), pkg, real: null };
  }
  let real;
  try { real = fs.realpathSync(hit.file); } catch { return null; }
  const owner = packageRootOf(real);
  if (owner && owner.pkg.name === pkgName) return { root: owner.root, pkg: owner.pkg, real };
  return null;
}

/** `<dir>/node_modules/<pkg>` walking up from the meta package root (Node's lookup, minus `exports`). */
function findInstalledPackage(pkgName, rt) {
  let dir = rt.metaRoot;
  for (let i = 0; i < 32; i++) {
    const root = path.join(dir, 'node_modules', ...pkgName.split('/'));
    const pkg = readPackageJson(root);
    if (pkg && pkg.name === pkgName) {
      return { root, pkg, source: isInside(rt.metaRoot, root) ? 'bundled' : 'node_modules' };
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Resolve `binName` of component `c`.
 * → { ok:true, bin:ResolvedBin, shadowedBy:string[] }
 * | { ok:false, code:'NOT_INSTALLED'|'BROKEN', detail, shadowedBy }
 */
function resolveBin(c, binName, rt) {
  const shadowedBy = [];
  let brokenDetail = null;
  for (const hit of findOnPath(binName, rt)) {
    const owner = packageOfPathHit(hit, c.pkg, rt);
    if (!owner) { shadowedBy.push(hit.file); continue; }
    const target = binFileIn(owner.root, owner.pkg, binName);
    if (target.reason) {
      brokenDetail = brokenDetail || `${hit.file} → ${owner.root}: bin ${binName} ${target.reason}`;
      continue;
    }
    return { ok: true, shadowedBy, bin: { file: target.file, root: owner.root, version: String(owner.pkg.version || ''), source: 'path', via: hit.file } };
  }
  if (c.bundled) {
    const found = findInstalledPackage(c.pkg, rt);
    if (found) {
      const target = binFileIn(found.root, found.pkg, binName);
      if (!target.reason) {
        return { ok: true, shadowedBy, bin: { file: target.file, root: found.root, version: String(found.pkg.version || ''), source: found.source, via: null } };
      }
      brokenDetail = brokenDetail || `${found.root}: bin ${binName} ${target.reason}`;
    }
  }
  if (brokenDetail) return { ok: false, code: 'BROKEN', detail: brokenDetail, shadowedBy };
  return { ok: false, code: 'NOT_INSTALLED', detail: `${binName} (${c.pkg}) was not found on PATH${c.bundled ? ' or in the bundled packages' : ''}`, shadowedBy };
}

/**
 * npm caret semantics for this package's own ranges (`^X.Y.Z` only): ^X.Y.Z (X>0) = >=X.Y.Z <(X+1).0.0;
 * ^0.Y.Z (Y>0) = >=0.Y.Z <0.(Y+1).0; ^0.0.Z = 0.0.Z only. A prerelease never satisfies a range
 * without one (npm rule). → true | false | null (version or range not parseable).
 */
function satisfiesRange(version, range) {
  const v = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version == null ? '' : version).trim());
  const r = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(String(range == null ? '' : range).trim());
  if (!v || !r) return null;
  if (v[4]) return false;
  const [a, b, c] = [v[1], v[2], v[3]].map(Number);
  const [x, y, z] = [r[1], r[2], r[3]].map(Number);
  const cmp = a !== x ? a - x : b !== y ? b - y : c - z;
  if (cmp < 0) return false;
  if (x > 0) return a === x;
  if (y > 0) return a === 0 && b === y;
  return a === 0 && b === 0 && c === z;
}

/**
 * Where `aigentry <name> …` would resolve the component's primary CLI from. A bundled copy is
 * runnable even with nothing on PATH, so presentation must not collapse it into "absent".
 * Resolution origin only, and deliberately platform-blind: `aigentry <name> …` refuses on an
 * unsupported OS before it resolves anything, so a caller must read this together with
 * `supported` rather than as a runnability verdict (1211 R2).
 * → 'path'|'bundled'|'node_modules' (runnable, and from where) | 'broken' (resolved, unrunnable)
 * | 'missing' (no copy) | 'none' (the component declares no primary bin)
 */
function cliSource(c, bins) {
  if (!c.bin) return 'none';
  const b = bins[c.bin];
  if (!b) return 'none';
  if (b.ok) return b.source;
  return b.code === 'BROKEN' ? 'broken' : 'missing';
}

/**
 * Install facts for one component (status/doctor). Never executes anything.
 * → { installed, version, root, source, cli, onPath, bins:{name:{ok,file,code,detail}}, broken:[detail] }
 */
function inspectComponent(c, rt) {
  const names = [c.bin, ...Object.values(c.sub)].filter(Boolean);
  const bins = {};
  let first = null;
  let onPath = false;
  for (const name of names) {
    const r = resolveBin(c, name, rt);
    bins[name] = r.ok ? { ok: true, file: r.bin.file, source: r.bin.source } : { ok: false, code: r.code, detail: r.detail };
    if (r.ok && !first) first = r.bin;
    if (r.ok && name === c.bin && r.bin.source === 'path') onPath = true;
  }
  let pkgOnly = null;
  if (!first) {
    // A package with no runnable bin (or none declared) is still installed; say which.
    pkgOnly = c.bundled ? findInstalledPackage(c.pkg, rt) : null;
  }
  const broken = Object.entries(bins).filter(([, b]) => !b.ok && b.code === 'BROKEN').map(([n, b]) => `${n}: ${b.detail}`);
  if (pkgOnly && names.length) broken.push(`${c.pkg} is present at ${pkgOnly.root} but declares no runnable ${names.join('/')}`);
  const installed = Boolean(first || pkgOnly);
  return {
    installed,
    version: first ? first.version : pkgOnly ? String(pkgOnly.pkg.version || '') : null,
    root: first ? first.root : pkgOnly ? pkgOnly.root : null,
    source: first ? first.source : pkgOnly ? pkgOnly.source : null,
    cli: cliSource(c, bins),
    onPath,
    bins,
    broken
  };
}

/**
 * Is the first `aigentry` on PATH this meta package? The Python registry also installs an
 * `aigentry` console script (DECISIONS F12); it is reported, never run.
 * → { state:'self'|'foreign'|'absent', file }
 */
function inspectSelfOnPath(rt) {
  const hits = findOnPath('aigentry', rt);
  if (!hits.length) return { state: 'absent', file: null };
  const owner = packageOfPathHit(hits[0], META_PACKAGE, rt);
  return { state: owner ? 'self' : 'foreign', file: hits[0].file };
}

module.exports = {
  META_PACKAGE,
  binMap,
  cliSource,
  findInstalledPackage,
  findOnPath,
  inspectComponent,
  inspectSelfOnPath,
  isNodeScript,
  packageOfPathHit,
  readPackageJson,
  readSmallFile,
  resolveBin,
  satisfiesRange
};
