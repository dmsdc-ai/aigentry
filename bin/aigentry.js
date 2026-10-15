#!/usr/bin/env node
'use strict';

// Thin dispatch: every verb, route and help line comes from lib/registry.js via lib/commands.js.
// Requiring this file runs nothing; the CLI runs only as the main module.

const { createRuntime, run } = require('../lib/commands');

/** @returns {Promise<number>} exit code */
function main(argv = process.argv.slice(2), rt = createRuntime()) {
  return run(argv, rt);
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`aigentry: ${(error && error.message) || error}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = { main };
