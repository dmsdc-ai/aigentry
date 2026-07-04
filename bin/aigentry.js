#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const path = require('path');

const MODULES = [
  { name: 'aterm',         pkg: '@dmsdc-ai/aterm',                  bin: 'aterm' },
  { name: 'telepty',       pkg: '@dmsdc-ai/aigentry-telepty',       bin: 'telepty' },
  { name: 'devkit',        pkg: '@dmsdc-ai/aigentry-devkit',        bin: 'aigentry-devkit' },
  { name: 'brain',         pkg: '@dmsdc-ai/aigentry-brain',         bin: null },
  { name: 'deliberation',  pkg: '@dmsdc-ai/aigentry-deliberation',  bin: null },
];

function getVersion(pkg) {
  try {
    const pkgJsonPath = require.resolve(pkg + '/package.json');
    return require(pkgJsonPath).version;
  } catch {
    return null;
  }
}

function checkBin(bin) {
  if (!bin) return null;
  try {
    execSync(`command -v ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'status';

  if (cmd === 'status' || cmd === 's') {
    const own = require('../package.json');
    console.log(`\n  aigentry v${own.version} — Sovereign Brain OS for AI Agents\n`);
    console.log('  Module           Version     CLI');
    console.log('  ───────────────  ──────────  ───────');

    for (const m of MODULES) {
      const ver = getVersion(m.pkg);
      const cli = checkBin(m.bin);
      const verStr = ver ? `v${ver}` : '✗ missing';
      const cliStr = m.bin ? (cli ? '✓' : '✗') : '—';
      const icon = ver ? '✓' : '✗';
      console.log(`  ${icon} ${m.name.padEnd(15)}  ${verStr.padEnd(10)}  ${cliStr}`);
    }

    const installed = MODULES.filter(m => getVersion(m.pkg)).length;
    console.log(`\n  ${installed}/${MODULES.length} modules installed\n`);

    if (installed < MODULES.length) {
      console.log('  Run: npm i -g @dmsdc-ai/aigentry  (to reinstall missing)\n');
    }
  } else if (cmd === 'version' || cmd === '-v' || cmd === '--version') {
    const own = require('../package.json');
    console.log(own.version);
  } else if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log(`
  aigentry — Sovereign Brain OS for AI Agents

  Usage:
    aigentry              Show ecosystem status
    aigentry status       Show ecosystem status
    aigentry version      Show version
    aigentry help         Show this help

  Ecosystem modules:
    aterm           Terminal UI for AI agents
    telepty         Session transport + IPC
    devkit          Installer + orchestrator
    brain           Memory persistence (MCP)
    deliberation    Multi-AI debate (MCP)

  Install everything:
    npm i -g @dmsdc-ai/aigentry
`);
  } else {
    console.error(`  Unknown command: ${cmd}\n  Run: aigentry help`);
    process.exit(1);
  }
}

main();
