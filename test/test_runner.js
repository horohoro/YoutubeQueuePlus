/**
 * YoutubeQueuePlus - Unified Test Runner
 *
 * Discovers and executes unit test suites (M1–M4) and end-to-end
 * opaque-box test suites (Tiers 1–5) with zero external dependencies.
 *
 * Usage:
 *   node test/test_runner.js               # Run all core Unit + E2E suites (default)
 *   node test/test_runner.js --unit        # Run unit test suites (M1–M4)
 *   node test/test_runner.js --e2e         # Run end-to-end test suites (Tiers 1–5)
 *   node test/test_runner.js --tier5       # Run Tier 5 adversarial suites only
 *   node test/test_runner.js --stress      # Run performance and stress test suites
 *   node test/test_runner.js --all         # Run all test suites including stress suites
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const SUITES = {
  unit: [
    'test/m1_foundation.test.js',
    'test/m2_feed_decoration.test.js',
    'test/m3_duplicate_guard.test.js',
    'test/m4_restore_popup.test.js'
  ],
  e2e: [
    'test/e2e/tier1_features.test.js',
    'test/e2e/tier2_boundaries.test.js',
    'test/e2e/tier3_interactions.test.js',
    'test/e2e/tier4_realworld.test.js',
    'test/e2e/tier5_adversarial_1.test.js',
    'test/e2e/tier5_adversarial_2.test.js'
  ],
  tier5: [
    'test/e2e/tier5_adversarial_1.test.js',
    'test/e2e/tier5_adversarial_2.test.js'
  ],
  stress: [
    'test/m1_stress.test.js',
    'test/m1_challenger_stress.test.js',
    'test/m2_stress.test.js',
    'test/m2_feed_decorator_stress.test.js',
    'test/m2_challenger_stress.test.js',
    'test/m3_duplicate_guard_stress.test.js',
    'test/m3_challenger_stress.test.js',
    'test/m4_challenger_stress.test.js',
    'test/m4_challenger_2_stress.test.js'
  ]
};

/**
 * Resolves target test files based on CLI arguments.
 * @param {string[]} args
 * @returns {{ files: string[], mode: string }}
 */
function resolveTestSuites(args = []) {
  if (args.includes('--unit')) {
    return { files: SUITES.unit, mode: 'UNIT ONLY (M1–M4)' };
  }
  if (args.includes('--e2e')) {
    return { files: SUITES.e2e, mode: 'E2E ONLY (Tiers 1–5)' };
  }
  if (args.includes('--tier5') || args.includes('--adversarial')) {
    return { files: SUITES.tier5, mode: 'TIER 5 ADVERSARIAL ONLY' };
  }
  if (args.includes('--stress')) {
    return { files: SUITES.stress, mode: 'STRESS ONLY' };
  }
  if (args.includes('--all')) {
    return {
      files: [...SUITES.unit, ...SUITES.e2e, ...SUITES.stress],
      mode: 'ALL (Unit + E2E + Stress)'
    };
  }

  // Default: Core Unit + E2E suites
  return {
    files: [...SUITES.unit, ...SUITES.e2e],
    mode: 'CORE SUITES (Unit M1–M4 + E2E Tiers 1–5)'
  };
}

/**
 * Executes target test files using Node's built-in test runner.
 * @param {string[]} [cliArgs]
 * @returns {number} Process exit code (0 for pass, non-zero for failure)
 */
function runTests(cliArgs = process.argv.slice(2)) {
  const { files, mode } = resolveTestSuites(cliArgs);

  console.log('='.repeat(78));
  console.log('  YoutubeQueuePlus - Unified Test Runner');
  console.log('='.repeat(78));
  console.log(`  Execution Mode: ${mode}`);
  console.log(`  Total Suites:   ${files.length} files`);
  console.log('  Suites Included:');
  files.forEach(f => console.log(`    - ${f}`));
  console.log('='.repeat(78));
  console.log('');

  const resolvedPaths = files.map(f => path.resolve(PROJECT_ROOT, f));
  const startTime = Date.now();

  const result = spawnSync(
    process.execPath,
    ['--test', ...resolvedPaths],
    {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test' }
    }
  );

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('');
  console.log('='.repeat(78));
  if (result.status === 0) {
    console.log(`  [TEST RUNNER RESULT] ALL TEST SUITES PASSED (${duration}s)`);
  } else {
    console.log(`  [TEST RUNNER RESULT] TESTS FAILED with exit code ${result.status} (${duration}s)`);
  }
  console.log('='.repeat(78));

  return result.status !== null ? result.status : 1;
}

if (require.main === module) {
  const exitCode = runTests();
  process.exit(exitCode);
}

module.exports = { runTests, resolveTestSuites, SUITES };
