'use strict';
// Preloaded (node --require) into CLI children spawned by safety.test.js. Any subprocess or fs write
// attempted by the CLI prints a TRAP-VIOLATION marker on stderr and throws.
const cp = require('node:child_process');
const fs = require('node:fs');

function hit(what) {
  process.stderr.write(`\nTRAP-VIOLATION ${what}\n`);
  throw new Error(`trap: ${what}`);
}

for (const n of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  cp[n] = (...a) => hit(`child_process.${n} ${String(a[0])}`);
}
for (const n of [
  'writeFileSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync',
  'copyFileSync', 'symlinkSync', 'chmodSync', 'truncateSync', 'writeFile', 'appendFile', 'mkdir', 'rename', 'unlink',
  'rm', 'createWriteStream',
]) {
  if (typeof fs[n] === 'function') fs[n] = (...a) => hit(`fs.${n} ${String(a[0])}`);
}
for (const n of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm']) {
  if (typeof fs.promises[n] === 'function') fs.promises[n] = (...a) => hit(`fs.promises.${n} ${String(a[0])}`);
}
