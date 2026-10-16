'use strict';

// The one registry (DECISIONS R8): help text, routes, lifecycle verbs and doctor checks
// are all derived from these two tables. Nothing here touches the system.

/**
 * @typedef {Object} Component
 * @property {string} name            CLI-facing name (`aigentry <name> …`)
 * @property {string} pkg             npm package name
 * @property {string|null} bin        primary executable, or null when it is not a human CLI
 * @property {Object<string,string>} sub  `aigentry <name> <sub> …` → package bin name
 * @property {string} role
 * @property {boolean} bundled        a dependency of this meta package
 * @property {boolean} required       missing/broken fails `doctor`
 * @property {string[]} lifecycle     verbs other than passthrough (`start`, `restart`)
 * @property {{os:string,cpu:(string|null)}[]|null} platforms  null = every platform
 * @property {string[]|null} lifecyclePlatforms  null = every platform
 * @property {Object<string,string>} [platformNotes]  platform → support label shown by status/doctor (SPEC I5)
 * @property {string|null} note
 */

/** @type {Component[]} — order is the status table order. */
const COMPONENTS = [
  {
    name: 'aterm', pkg: '@dmsdc-ai/aterm', bin: 'aterm', sub: {},
    role: 'Terminal launcher (GUI app)', bundled: true, required: false,
    lifecycle: [], platforms: [{ os: 'darwin', cpu: 'arm64' }], lifecyclePlatforms: null,
    note: 'launches the native app; macOS arm64 only'
  },
  {
    name: 'telepty', pkg: '@dmsdc-ai/aigentry-telepty', bin: 'telepty', sub: {},
    role: 'Session transport + IPC daemon', bundled: true, required: true,
    lifecycle: ['start', 'restart'], platforms: null, lifecyclePlatforms: null,
    platformNotes: { win32: 'beta' },
    note: null
  },
  {
    name: 'devkit', pkg: '@dmsdc-ai/aigentry-devkit', bin: 'aigentry-devkit', sub: {},
    role: 'Installer + scaffold', bundled: true, required: true,
    lifecycle: [], platforms: null, lifecyclePlatforms: null,
    platformNotes: { win32: 'unmeasured' },
    note: 'devkit with no arguments runs setup; pass a subcommand explicitly'
  },
  {
    name: 'brain', pkg: '@dmsdc-ai/aigentry-brain', bin: 'aigentry-brain', sub: {},
    role: 'Memory persistence (MCP)', bundled: true, required: true,
    lifecycle: [], platforms: null, lifecyclePlatforms: null,
    platformNotes: { win32: 'known-defect' },
    note: 'brain commands may check for and install its own updates'
  },
  {
    name: 'deliberation', pkg: '@dmsdc-ai/aigentry-deliberation', bin: null,
    sub: { doctor: 'deliberation-doctor', install: 'deliberation-install' },
    role: 'Multi-AI debate (MCP)', bundled: true, required: true,
    lifecycle: [], platforms: null, lifecyclePlatforms: null,
    platformNotes: { win32: 'unmeasured' },
    note: 'the server itself is started by your AI client over stdio'
  },
  {
    name: 'orchestrator', pkg: '@dmsdc-ai/aigentry-orchestrator', bin: 'aigentry-orchestrator', sub: {},
    role: 'Control tower (optional, installed separately)', bundled: false, required: false,
    lifecycle: ['start', 'restart'], platforms: null, lifecyclePlatforms: ['darwin', 'linux'],
    note: 'install with: npm i -g @dmsdc-ai/aigentry-orchestrator && aigentry-orchestrator init'
  },
  {
    name: 'logger', pkg: '@dmsdc-ai/aigentry-logger', bin: 'aigentry-logger', sub: {},
    role: 'Telemetry logger (optional, installed separately)', bundled: false, required: false,
    lifecycle: [], platforms: null, lifecyclePlatforms: null,
    note: 'used when aigentry-logger is on PATH; not a dependency of this package'
  }
];

/** The single default service of `aigentry start`. */
const DEFAULT_SERVICE = 'telepty';

const VERBS = [
  { name: 'setup', aliases: ['install'], usage: 'aigentry setup|install [setup options]',
    summary: 'Select setup preferences through devkit; preview and explicit consent required' },
  { name: 'status', aliases: ['s'], usage: 'aigentry [status] [--json] [--port N] [--workspace PATH]',
    summary: 'Show components and service state (read-only, always exit 0)' },
  { name: 'doctor', aliases: [], usage: 'aigentry doctor [--json] [--timeout MS] [--port N] [--workspace PATH]',
    summary: 'Read-only health checks (exit 0 ok, 1 failed, 7 inconclusive)' },
  { name: 'start', aliases: [], usage: 'aigentry start [telepty|orchestrator] [--port N] [--workspace PATH]',
    summary: `Start a service (default: ${DEFAULT_SERVICE})` },
  { name: 'restart', aliases: [], usage: 'aigentry restart <telepty|orchestrator> [--port N] [--yes] [--workspace PATH]',
    summary: 'Restart a named service (asks for confirmation)' },
  { name: 'version', aliases: ['-v', '--version'], usage: 'aigentry version', summary: 'Show version' },
  { name: 'help', aliases: ['-h', '--help'], usage: 'aigentry help [verb|component]', summary: 'Show this help' }
];

const EXIT = Object.freeze({
  OK: 0, FAILED: 1, USAGE: 2, NOT_INSTALLED: 3, REFUSED: 4, OWNER_ACTION: 5, UNSUPPORTED_OS: 6, INCONCLUSIVE: 7
});

function getComponent(name) {
  return COMPONENTS.find((c) => c.name === name) || null;
}

function findVerb(word) {
  return VERBS.find((v) => v.name === word || v.aliases.includes(word)) || null;
}

/** Components that support `verb` (`start` / `restart`). */
function lifecycleComponents(verb) {
  return COMPONENTS.filter((c) => c.lifecycle.includes(verb)).map((c) => c.name);
}

function platformSupported(platforms, platform, arch) {
  if (!platforms) return true;
  return platforms.some((p) => p.os === platform && (!p.cpu || p.cpu === arch));
}

/** Support label for `platform` (e.g. win32 → 'beta'), or null when none is recorded. */
function platformNote(c, platform) {
  return (c.platformNotes && c.platformNotes[platform]) || null;
}

function describePlatforms(platforms) {
  if (!platforms) return 'all platforms';
  return platforms.map((p) => (p.cpu ? `${p.os}-${p.cpu}` : p.os)).join(', ');
}

/** `aigentry <name> …` forms for one component, as help lines. */
function passthroughForms(c) {
  const forms = [];
  if (c.bin) forms.push({ form: `aigentry ${c.name} <args…>`, runs: `${c.bin} <args…>` });
  for (const [sub, bin] of Object.entries(c.sub)) {
    forms.push({ form: `aigentry ${c.name} ${sub} <args…>`, runs: `${bin} <args…>` });
  }
  return forms;
}

function helpText() {
  const lines = ['', '  aigentry — Sovereign Brain OS for AI Agents', '', '  Usage:'];
  lines.push('    aigentry                       Show ecosystem status');
  for (const v of VERBS) lines.push(`    ${v.usage}`, `        ${v.summary}`);
  lines.push('    aigentry <component> [args…]', '        Run a component CLI; arguments and exit code pass through unchanged');
  lines.push('', '  Components:');
  for (const c of COMPONENTS) {
    lines.push(`    ${c.name.padEnd(14)} ${c.role}`);
    for (const f of passthroughForms(c)) lines.push(`      ${f.form}  → ${f.runs}`);
    for (const verb of c.lifecycle) lines.push(`      aigentry ${verb} ${c.name}`);
    if (c.platforms) lines.push(`      platforms: ${describePlatforms(c.platforms)}`);
    if (c.lifecyclePlatforms && c.lifecycle.length) {
      lines.push(`      ${c.lifecycle.join('/')} platforms: ${describePlatforms(c.lifecyclePlatforms.map((os) => ({ os, cpu: null })))}`);
    }
    if (c.note) lines.push(`      note: ${c.note}`);
  }
  lines.push('', '  Not available in this version: stop, repair, --all.');
  lines.push('', '  Exit codes: 0 ok · 1 failed · 2 usage · 3 not installed · 4 refused · 5 owner action',
    '              6 unsupported OS · 7 inconclusive (doctor) · passthrough = the component\'s code');
  lines.push('', '  Install everything:', '    npm i -g @dmsdc-ai/aigentry', '');
  return lines.join('\n') + '\n';
}

function topicHelp(topic) {
  const verb = findVerb(topic);
  if (verb) return `\n  ${verb.usage}\n      ${verb.summary}\n\n`;
  const c = getComponent(topic);
  if (!c) return null;
  const lines = ['', `  ${c.name} — ${c.role}`, `  package: ${c.pkg}${c.bundled ? '' : ' (not bundled)'}`];
  const forms = passthroughForms(c);
  if (!forms.length) lines.push('  no passthrough command');
  for (const f of forms) lines.push(`  ${f.form}  → ${f.runs}`);
  for (const verb of c.lifecycle) lines.push(`  aigentry ${verb} ${c.name}`);
  if (c.platforms) lines.push(`  platforms: ${describePlatforms(c.platforms)}`);
  if (c.note) lines.push(`  note: ${c.note}`);
  return lines.join('\n') + '\n\n';
}

module.exports = {
  COMPONENTS,
  DEFAULT_SERVICE,
  EXIT,
  VERBS,
  describePlatforms,
  findVerb,
  getComponent,
  helpText,
  lifecycleComponents,
  passthroughForms,
  platformNote,
  platformSupported,
  topicHelp
};
