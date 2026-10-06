/**
 * YoutubeQueuePlus - Test Runner Entrypoint
 *
 * Runs the complete test suite including Unit (M1–M4) and E2E (Tiers 1–5).
 * Zero external dependencies. Uses Node.js built-in test runner.
 *
 * Usage:
 *   node test.js
 *   node test.js --unit
 *   node test.js --e2e
 *   node test.js --tier5
 *   node test.js --stress
 *   node test.js --all
 */

'use strict';

const { runTests } = require('./test/test_runner');

const exitCode = runTests(process.argv.slice(2));
process.exit(exitCode);
