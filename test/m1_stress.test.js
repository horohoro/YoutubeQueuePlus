/**
 * YoutubeQueuePlus - Milestone M1 Challenger Empirical Stress Test Suite
 * Stress-testing UrlParser and DomHelpers under high load, boundary cases,
 * extreme values, rapid fire, and ReDoS attacks.
 *
 * Executable via: node test/m1_stress.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { performance } = require('perf_hooks');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const UrlParser = require(path.join(PROJECT_ROOT, 'src/utils/url_parser.js'));
const DomHelpers = require(path.join(PROJECT_ROOT, 'src/utils/dom_helpers.js'));

// =============================================================================
// Lightweight DOM Mock for DomHelpers & Element Extraction Stress Testing
// =============================================================================
class MockElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this._classList = new Set();
    const self = this;
    this.classList = {
      add: (...tokens) => tokens.forEach(t => self._classList.add(t)),
      remove: (...tokens) => tokens.forEach(t => self._classList.delete(t)),
      contains: (token) => self._classList.has(token),
      toggle: (token) => {
        if (self._classList.has(token)) {
          self._classList.delete(token);
          return false;
        } else {
          self._classList.add(token);
          return true;
        }
      }
    };
    this.style = {};
    this.textContent = '';
  }

  get parentElement() {
    return this.parentNode;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') {
      this._classList.clear();
      String(value).split(/\s+/).filter(Boolean).forEach(c => this._classList.add(c));
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'class') {
      this._classList.clear();
    }
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
      return child;
    }
    return null;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  matches(sel) {
    if (!sel || typeof sel !== 'string') return false;
    const parts = sel.split(/[\s,]+/);
    const target = parts[parts.length - 1];
    if (target.startsWith('#')) return this.getAttribute('id') === target.slice(1);
    if (target.startsWith('.')) return this._classList.has(target.slice(1));
    if (target.includes('[') && target.includes(']')) {
      const match = target.match(/\[([a-zA-Z0-9_-]+)(?:([*^$]?=)"?([^"\]]*)"?)?\]/);
      if (match) {
        const [, attr, op, val] = match;
        const attrVal = this.getAttribute(attr);
        if (!op) return this.hasAttribute(attr);
        if (attrVal === null) return false;
        if (op === '=') return attrVal === val;
        if (op === '*=') return attrVal.includes(val);
        if (op === '^=') return attrVal.startsWith(val);
        if (op === '$=') return attrVal.endsWith(val);
      }
    }
    return this.tagName.toLowerCase() === target.toLowerCase();
  }

  querySelector(sel) {
    for (const child of this.children) {
      if (child.matches && child.matches(sel)) return child;
      if (child.querySelector) {
        const found = child.querySelector(sel);
        if (found) return found;
      }
    }
    return null;
  }

  querySelectorAll(sel) {
    const results = [];
    const traverse = (el) => {
      for (const child of el.children) {
        if (child.matches && child.matches(sel)) results.push(child);
        if (child.children) traverse(child);
      }
    };
    traverse(this);
    return results;
  }
}

globalThis.document = {
  createElement: (tag) => new MockElement(tag),
  createTextNode: (text) => ({ textContent: String(text), nodeType: 3 }),
  querySelector: () => null,
  querySelectorAll: () => []
};

// =============================================================================
// Helper: Synthetic URL & Data Generator
// =============================================================================
const VALID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function generateRandomVideoId(len = 11) {
  let id = '';
  for (let i = 0; i < len; i++) {
    id += VALID_CHARS.charAt(Math.floor(Math.random() * VALID_CHARS.length));
  }
  return id;
}

// =============================================================================
// Stress Suite 1: UrlParser Empirical Stress & Boundary Harness
// =============================================================================
describe('Challenger M1 Stress: UrlParser', () => {

  test('1. 10,000 Synthetic URLs high-load parsing & throughput (< 50ms)', () => {
    const urls = [];
    const expectedIds = [];

    // 2,000 watch URLs
    for (let i = 0; i < 2000; i++) {
      const id = generateRandomVideoId(11);
      urls.push(`https://www.youtube.com/watch?v=${id}&feature=feed&t=${i}s`);
      expectedIds.push(id);
    }
    // 2,000 shorts URLs
    for (let i = 0; i < 2000; i++) {
      const id = generateRandomVideoId(11);
      urls.push(`https://www.youtube.com/shorts/${id}?feature=share`);
      expectedIds.push(id);
    }
    // 2,000 embed URLs
    for (let i = 0; i < 2000; i++) {
      const id = generateRandomVideoId(11);
      urls.push(`https://www.youtube.com/embed/${id}`);
      expectedIds.push(id);
    }
    // 2,000 youtu.be shortlinks
    for (let i = 0; i < 2000; i++) {
      const id = generateRandomVideoId(11);
      urls.push(`https://youtu.be/${id}?si=abcdef1234`);
      expectedIds.push(id);
    }
    // 1,000 live streams
    for (let i = 0; i < 1000; i++) {
      const id = generateRandomVideoId(11);
      urls.push(`https://www.youtube.com/live/${id}`);
      expectedIds.push(id);
    }
    // 1,000 adversarial / negative URLs
    for (let i = 0; i < 1000; i++) {
      const type = i % 5;
      if (type === 0) urls.push(`https://www.youtube.com/channel/UC${generateRandomVideoId(16)}`);
      else if (type === 1) urls.push(`https://www.example.com/watch?x=${generateRandomVideoId(11)}`);
      else if (type === 2) urls.push(`javascript:alert("XSS")`);
      else if (type === 3) urls.push(`/feed/subscriptions`);
      else urls.push(`https://www.youtube.com/watch?v=too_short`);
      expectedIds.push(null);
    }

    assert.strictEqual(urls.length, 10000);

    const startTime = performance.now();
    let matchCount = 0;

    for (let i = 0; i < urls.length; i++) {
      const extracted = UrlParser.extractVideoId(urls[i]);
      if (extracted === expectedIds[i]) {
        matchCount++;
      }
    }
    const durationMs = performance.now() - startTime;

    assert.strictEqual(matchCount, 10000, 'All 10,000 synthetic URLs must parse exactly as expected');
    console.log(`    [BENCHMARK] UrlParser 10,000 URLs parsed in ${durationMs.toFixed(2)}ms (Average ${(durationMs / 10).toFixed(4)}µs/url)`);
    assert.ok(durationMs < 50, `10,000 URL parsing took ${durationMs.toFixed(2)}ms, must be < 50ms`);
  });

  test('2. Boundary video ID lengths (10 chars, 12 chars, empty, extreme lengths)', () => {
    // 10 chars (too short)
    for (let i = 0; i < 50; i++) {
      const id10 = generateRandomVideoId(10);
      assert.strictEqual(UrlParser.isValidVideoId(id10), false, `10-char ID "${id10}" must be invalid`);
      assert.strictEqual(UrlParser.extractVideoId(id10), null, `10-char ID must not extract`);
      assert.strictEqual(UrlParser.extractVideoId(`https://www.youtube.com/watch?v=${id10}`), null);
      assert.strictEqual(UrlParser.extractVideoId(`https://www.youtube.com/shorts/${id10}`), null);
    }

    // 12 chars (too long)
    for (let i = 0; i < 50; i++) {
      const id12 = generateRandomVideoId(12);
      assert.strictEqual(UrlParser.isValidVideoId(id12), false, `12-char ID "${id12}" must be invalid`);
      assert.strictEqual(UrlParser.extractVideoId(id12), null, `12-char ID must not extract`);
      assert.strictEqual(UrlParser.extractVideoId(`https://www.youtube.com/watch?v=${id12}`), null);
      assert.strictEqual(UrlParser.extractVideoId(`https://www.youtube.com/shorts/${id12}`), null);
    }

    // Exact 11 chars (valid)
    for (let i = 0; i < 50; i++) {
      const id11 = generateRandomVideoId(11);
      assert.strictEqual(UrlParser.isValidVideoId(id11), true, `11-char ID "${id11}" must be valid`);
      assert.strictEqual(UrlParser.extractVideoId(id11), id11);
    }

    // Empty and whitespace inputs
    assert.strictEqual(UrlParser.isValidVideoId(''), false);
    assert.strictEqual(UrlParser.isValidVideoId('           '), false);
    assert.strictEqual(UrlParser.isValidVideoId('\t\r\n'), false);
    assert.strictEqual(UrlParser.extractVideoId(''), null);
    assert.strictEqual(UrlParser.extractVideoId('   '), null);
    assert.strictEqual(UrlParser.extractVideoId('\n\t'), null);

    // Extreme string length (100,000 characters)
    const longGarbage = 'a'.repeat(100000);
    const startReDos = performance.now();
    assert.strictEqual(UrlParser.isValidVideoId(longGarbage), false);
    assert.strictEqual(UrlParser.extractVideoId(longGarbage), null);
    assert.strictEqual(UrlParser.extractVideoId(`https://www.youtube.com/watch?v=${longGarbage}`), null);
    const reDosTime = performance.now() - startReDos;
    assert.ok(reDosTime < 10, `ReDoS / 100k length check must be instantaneous (< 10ms), took ${reDosTime.toFixed(2)}ms`);
  });

  test('3. Adversarial / Non-string / Boundary inputs to UrlParser', () => {
    const invalidInputs = [
      null,
      undefined,
      12345678901,
      true,
      false,
      {},
      [],
      [1, 2, 3],
      NaN,
      Infinity,
      -Infinity,
      Symbol('test'),
      () => 'dQw4w9WgXcQ',
      { toString: () => 'dQw4w9WgXcQ' }
    ];

    for (const input of invalidInputs) {
      assert.strictEqual(UrlParser.isValidVideoId(input), false, `isValidVideoId must reject ${String(input)}`);
      assert.strictEqual(UrlParser.extractVideoId(input), null, `extractVideoId must return null for ${String(input)}`);
    }

    // Special characters within 11-char candidates
    const invalidCharCandidates = [
      'dQw4w9WgXc!',
      'dQw4w9WgXc@',
      'dQw4w9WgXc#',
      'dQw4w9WgXc$',
      'dQw4w9WgXc%',
      'dQw4w9WgXc^',
      'dQw4w9WgXc&',
      'dQw4w9WgXc*',
      'dQw4w9WgXc(',
      'dQw4w9WgXc)',
      'dQw4w9WgXc+',
      'dQw4w9WgXc=',
      'dQw4w9WgXc{',
      'dQw4w9WgXc}',
      'dQw4w9WgXc[',
      'dQw4w9WgXc]',
      'dQw4w9WgXc|',
      'dQw4w9WgXc\\',
      'dQw4w9WgXc:',
      'dQw4w9WgXc;',
      'dQw4w9WgXc"',
      'dQw4w9WgXc\'',
      'dQw4w9WgXc<',
      'dQw4w9WgXc>',
      'dQw4w9WgXc,',
      'dQw4w9WgXc.',
      'dQw4w9WgXc?',
      'dQw4w9WgXc/',
      'dQw4w9WgXc ',
      'dQw4w9WgXc\0'
    ];

    for (const candidate of invalidCharCandidates) {
      assert.strictEqual(UrlParser.isValidVideoId(candidate), false, `Candidate "${candidate}" must be invalid`);
      assert.strictEqual(UrlParser.extractVideoId(candidate), null, `Candidate "${candidate}" must not extract`);
    }
  });

  test('4. buildRestoreUrl extreme indices (-500, 0, 50, 1000, NaN, Infinity, -Infinity, strings, floats)', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `vid_${String(i).padStart(7, '0')}`);

    // Extreme negative indices
    const urlNeg500 = UrlParser.buildRestoreUrl(ids, -500);
    assert.strictEqual(UrlParser.parseWatchVideosUrl(urlNeg500).currentIndex, 0, 'Index -500 must clamp to 0');

    const urlNeg1 = UrlParser.buildRestoreUrl(ids, -1);
    assert.strictEqual(UrlParser.parseWatchVideosUrl(urlNeg1).currentIndex, 0, 'Index -1 must clamp to 0');

    const urlNegInf = UrlParser.buildRestoreUrl(ids, -Infinity);
    assert.strictEqual(UrlParser.parseWatchVideosUrl(urlNegInf).currentIndex, 0, 'Index -Infinity must clamp to 0');

    // Boundary indices
    const url0 = UrlParser.buildRestoreUrl(ids, 0);
    assert.strictEqual(UrlParser.parseWatchVideosUrl(url0).currentIndex, 0, 'Index 0 must remain 0');

    const url49 = UrlParser.buildRestoreUrl(ids, 49);
    assert.strictEqual(UrlParser.parseWatchVideosUrl(url49).currentIndex, 49, 'Index 49 must remain 49');

    // Index 50 on 50 items (0-indexed max is 49)
    const url50 = UrlParser.buildRestoreUrl(ids, 50);
    assert.strictEqual(UrlParser.parseWatchVideosUrl(url50).currentIndex, 49, 'Index 50 on 50-item list must clamp to 49');

    // Extreme positive indices
    const url1000 = UrlParser.buildRestoreUrl(ids, 1000);
    assert.strictEqual(UrlParser.parseWatchVideosUrl(url1000).currentIndex, 49, 'Index 1000 must clamp to 49');

    const urlInf = UrlParser.buildRestoreUrl(ids, Infinity);
    assert.strictEqual(UrlParser.parseWatchVideosUrl(urlInf).currentIndex, 49, 'Index Infinity must clamp to 49');

    const urlLarge = UrlParser.buildRestoreUrl(ids, 1e12);
    assert.strictEqual(UrlParser.parseWatchVideosUrl(urlLarge).currentIndex, 49, 'Index 1e12 must clamp to 49');

    // Non-number / degenerate indices
    const urlNaN = UrlParser.buildRestoreUrl(ids, NaN);
    assert.strictEqual(UrlParser.parseWatchVideosUrl(urlNaN).currentIndex, 0, 'Index NaN must default to 0');

    const urlNull = UrlParser.buildRestoreUrl(ids, null);
    assert.strictEqual(UrlParser.parseWatchVideosUrl(urlNull).currentIndex, 0, 'Index null must default to 0');

    const urlUndefined = UrlParser.buildRestoreUrl(ids, undefined);
    assert.strictEqual(UrlParser.parseWatchVideosUrl(urlUndefined).currentIndex, 0, 'Index undefined must default to 0');

    const urlStr = UrlParser.buildRestoreUrl(ids, 'not_a_number');
    assert.strictEqual(UrlParser.parseWatchVideosUrl(urlStr).currentIndex, 0, 'Index string must default to 0');

    // Float indices
    const urlFloat = UrlParser.buildRestoreUrl(ids, 23.99);
    assert.strictEqual(UrlParser.parseWatchVideosUrl(urlFloat).currentIndex, 23, 'Index 23.99 must floor to 23');
  });

  test('5. buildRestoreUrl extreme arrays (1,000 video IDs, empty arrays, invalid arrays)', () => {
    // 1,000 valid video IDs input
    const thousandIds = Array.from({ length: 1000 }, (_, i) => `vid_${String(i).padStart(7, '0')}`);
    const startSingle1000 = performance.now();
    const url1000 = UrlParser.buildRestoreUrl(thousandIds, 750);
    const durationSingle1000 = performance.now() - startSingle1000;
    console.log(`    [BENCHMARK] Single buildRestoreUrl(1,000 IDs) took ${durationSingle1000.toFixed(4)}ms`);
    assert.ok(durationSingle1000 < 5, 'Single buildRestoreUrl on 1,000 items must execute in < 5ms');

    assert.ok(url1000.startsWith('https://www.youtube.com/watch_videos?video_ids='));
    const parsed1000 = UrlParser.parseWatchVideosUrl(url1000);
    assert.strictEqual(parsed1000.videoIds.length, 50, 'Must strictly cap at 50 IDs');
    assert.strictEqual(parsed1000.currentIndex, 49, 'Index must clamp to 49 for 50-capped list');
    assert.strictEqual(parsed1000.videoIds[0], thousandIds[0]);
    assert.strictEqual(parsed1000.videoIds[49], thousandIds[49]);

    // 1,000 invalid IDs
    const invalidIds = Array.from({ length: 1000 }, () => 'invalid_id_format');
    assert.strictEqual(UrlParser.buildRestoreUrl(invalidIds), null, '1,000 invalid IDs must return null');

    // 500 valid + 500 invalid interleaved IDs
    const interleaved = [];
    for (let i = 0; i < 500; i++) {
      interleaved.push('too_short');
      interleaved.push(`vid_${String(i).padStart(7, '0')}`);
    }
    const urlInterleaved = UrlParser.buildRestoreUrl(interleaved, 10);
    const parsedInterleaved = UrlParser.parseWatchVideosUrl(urlInterleaved);
    assert.strictEqual(parsedInterleaved.videoIds.length, 50);
    assert.strictEqual(parsedInterleaved.currentIndex, 10);
    assert.strictEqual(parsedInterleaved.videoIds[0], 'vid_0000000');

    // Empty and degenerate array inputs
    assert.strictEqual(UrlParser.buildRestoreUrl([]), null);
    assert.strictEqual(UrlParser.buildRestoreUrl(new Array(100)), null);
    assert.strictEqual(UrlParser.buildRestoreUrl([null, undefined, 123, {}]), null);
    assert.strictEqual(UrlParser.buildRestoreUrl(null), null);
    assert.strictEqual(UrlParser.buildRestoreUrl(undefined), null);
    assert.strictEqual(UrlParser.buildRestoreUrl('dQw4w9WgXcQ'), null);
    assert.strictEqual(UrlParser.buildRestoreUrl(12345), null);

    // High load performance: 2,000 buildRestoreUrl calls on realistic 50-item queues
    const testList = thousandIds.slice(0, 50);
    const startBuild = performance.now();
    for (let i = 0; i < 2000; i++) {
      UrlParser.buildRestoreUrl(testList, i % 50);
    }
    const buildTime = performance.now() - startBuild;
    console.log(`    [BENCHMARK] UrlParser 2,000 buildRestoreUrl calls completed in ${buildTime.toFixed(2)}ms (Average ${(buildTime / 2).toFixed(4)}µs/call)`);
    assert.ok(buildTime < 50, `2,000 buildRestoreUrl calls took ${buildTime.toFixed(2)}ms, must be < 50ms`);
  });

  test('6. extractVideoIdFromElement DOM traversal robustness', () => {
    // Null safety
    assert.strictEqual(UrlParser.extractVideoIdFromElement(null), null);
    assert.strictEqual(UrlParser.extractVideoIdFromElement({}), null);

    // Card with data-yqp-video-id
    const card1 = new MockElement('ytd-rich-item-renderer');
    card1.setAttribute('data-yqp-video-id', 'dQw4w9WgXcQ');
    assert.strictEqual(UrlParser.extractVideoIdFromElement(card1), 'dQw4w9WgXcQ');

    // Card with anchor child
    const card2 = new MockElement('ytd-video-renderer');
    const anchor = new MockElement('a');
    anchor.setAttribute('id', 'thumbnail');
    anchor.setAttribute('href', '/watch?v=9bZkp7q19f0');
    card2.appendChild(anchor);
    assert.strictEqual(UrlParser.extractVideoIdFromElement(card2), '9bZkp7q19f0');

    // Card with shorts anchor
    const card3 = new MockElement('ytd-rich-item-renderer');
    const shortsAnchor = new MockElement('a');
    shortsAnchor.setAttribute('href', '/shorts/9bZkp7q19f0?feature=share');
    card3.appendChild(shortsAnchor);
    assert.strictEqual(UrlParser.extractVideoIdFromElement(card3), '9bZkp7q19f0');

    // Element itself is an anchor
    const standaloneAnchor = new MockElement('a');
    standaloneAnchor.setAttribute('href', 'https://youtu.be/dQw4w9WgXcQ');
    assert.strictEqual(UrlParser.extractVideoIdFromElement(standaloneAnchor), 'dQw4w9WgXcQ');
  });
});

// =============================================================================
// Stress Suite 2: DomHelpers Empirical Stress & Concurrency Harness
// =============================================================================
describe('Challenger M1 Stress: DomHelpers', () => {

  test('1. Debounce rapid fire (1,000 invocations in 10ms) trailing semantics', async () => {
    let callCount = 0;
    let receivedArgs = [];

    const debounced = DomHelpers.debounce((arg) => {
      callCount++;
      receivedArgs.push(arg);
    }, 40, false);

    const startRapid = performance.now();
    for (let i = 0; i < 1000; i++) {
      debounced(i);
    }
    const rapidDuration = performance.now() - startRapid;
    console.log(`    [BENCHMARK] Debounce 1,000 rapid calls dispatched in ${rapidDuration.toFixed(2)}ms`);

    assert.strictEqual(debounced.isPending(), true, 'Must be pending execution');
    assert.strictEqual(callCount, 0, 'Trailing debounce must not execute synchronously');

    // Wait for timer to fire
    await new Promise(r => setTimeout(r, 60));

    assert.strictEqual(debounced.isPending(), false, 'Must no longer be pending after wait');
    assert.strictEqual(callCount, 1, 'Must execute exactly ONCE after 1,000 rapid calls');
    assert.deepStrictEqual(receivedArgs, [999], 'Must execute with the 1,000th call argument (999)');
  });

  test('2. Debounce rapid fire (1,000 invocations) immediate leading semantics', async () => {
    let callCount = 0;
    let receivedArgs = [];

    const debouncedLeading = DomHelpers.debounce((arg) => {
      callCount++;
      receivedArgs.push(arg);
    }, 40, { immediate: true });

    for (let i = 0; i < 1000; i++) {
      debouncedLeading(i);
    }

    // Call 1 executed immediately, remaining 999 suppressed
    assert.strictEqual(callCount, 1, 'Must execute leading edge immediately upon 1st call');
    assert.deepStrictEqual(receivedArgs, [0], 'Must execute with 1st call argument');
    assert.strictEqual(debouncedLeading.isPending(), true, 'Must remain pending cool-down window');

    await new Promise(r => setTimeout(r, 60));

    assert.strictEqual(debouncedLeading.isPending(), false, 'Cool-down complete');
    assert.strictEqual(callCount, 1, 'Must NOT execute trailing edge in leading-only mode');

    // New invocation after cool-down executes again
    debouncedLeading('next_batch');
    assert.strictEqual(callCount, 2, 'New call after cool-down must execute immediately');
    assert.strictEqual(receivedArgs[1], 'next_batch');
  });

  test('3. Debounce cancel and flush under rapid fire', async () => {
    let callCount = 0;
    let lastArg = null;

    const debounced = DomHelpers.debounce((arg) => {
      callCount++;
      lastArg = arg;
    }, 40);

    // Cancel test after 1,000 rapid calls
    for (let i = 0; i < 1000; i++) {
      debounced(i);
    }
    assert.strictEqual(debounced.isPending(), true);
    debounced.cancel();
    assert.strictEqual(debounced.isPending(), false);

    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(callCount, 0, 'Cancelled rapid-fire must never execute');

    // Flush test after 1,000 rapid calls
    for (let i = 0; i < 1000; i++) {
      debounced(i * 2);
    }
    assert.strictEqual(debounced.isPending(), true);
    const flushResult = debounced.flush();
    assert.strictEqual(debounced.isPending(), false);
    assert.strictEqual(callCount, 1, 'Flush must execute synchronously');
    assert.strictEqual(lastArg, 1998, 'Flush must deliver latest argument');

    // Second flush while idle must be a no-op
    debounced.flush();
    assert.strictEqual(callCount, 1, 'Redundant flush must be no-op');

    // Await natural timer to ensure no second execution
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(callCount, 1, 'Natural timer must not fire after flush');
  });

  test('4. Throttle rapid fire (1,000 invocations in 10ms) leading + trailing semantics and cancel', async () => {
    let callCount = 0;
    let executedArgs = [];

    const throttled = DomHelpers.throttle((arg) => {
      callCount++;
      executedArgs.push(arg);
    }, 40);

    const startThrottle = performance.now();
    for (let i = 0; i < 1000; i++) {
      throttled(i);
    }
    const throttleRapidDuration = performance.now() - startThrottle;
    console.log(`    [BENCHMARK] Throttle 1,000 rapid calls dispatched in ${throttleRapidDuration.toFixed(2)}ms`);

    // Leading edge must fire immediately on call 0
    assert.strictEqual(callCount, 1, 'Throttle must fire leading call immediately');
    assert.strictEqual(executedArgs[0], 0, 'Leading call must receive 1st argument (0)');

    // Wait for trailing edge to fire
    await new Promise(r => setTimeout(r, 60));

    // Trailing edge must fire with latest argument (999)
    assert.strictEqual(callCount, 2, 'Throttle must fire exactly twice (1 leading + 1 trailing)');
    assert.strictEqual(executedArgs[1], 999, 'Trailing call must receive 1,000th argument (999)');

    // Wait until full throttle window has expired past trailing edge
    await new Promise(r => setTimeout(r, 50));

    // Verify leading call fires after interval
    throttled(1001);
    assert.strictEqual(callCount, 3, 'Leading call fires after window');
    assert.strictEqual(executedArgs[2], 1001);

    // Rapidly queue 100 calls (scheduling trailing)
    for (let i = 0; i < 100; i++) {
      throttled(2000 + i);
    }

    // Cancel pending trailing call
    throttled.cancel();

    // Await trailing window and confirm no further invocation fired
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(callCount, 3, 'Cancelled throttle trailing call must not execute');

    // Verify cancel resets lastCallTime to 0, enabling immediate leading invocation
    throttled(3000);
    assert.strictEqual(callCount, 4, 'Throttle call following cancel fires immediately as leading edge');
    assert.strictEqual(executedArgs[3], 3000);
  });

  test('5. toKebabCase and formatYqpAttributeName stress testing (20,000 operations < 50ms)', () => {
    const testCases = [
      ['videoId', 'video-id'],
      ['video-id', 'video-id'],
      ['activeQueueState', 'active-queue-state'],
      ['feedTreatmentMode', 'feed-treatment-mode'],
      ['PascalCaseTest', 'pascal-case-test'],
      ['already-kebab-case', 'already-kebab-case'],
      ['simple', 'simple'],
      ['with123Numbers', 'with123-numbers'],
      ['step1Done', 'step1-done'],
      ['data-yqp-status', 'data-yqp-status'],
      ['', ''],
      [null, ''],
      [undefined, ''],
      [123, '']
    ];

    for (const [input, expected] of testCases) {
      assert.strictEqual(DomHelpers.toKebabCase(input), expected, `toKebabCase(${input}) must match ${expected}`);
    }

    const attrCases = [
      ['status', 'data-yqp-status'],
      ['mode', 'data-yqp-mode'],
      ['videoId', 'data-yqp-video-id'],
      ['video-id', 'data-yqp-video-id'],
      ['yqp-status', 'data-yqp-status'],
      ['data-yqp-status', 'data-yqp-status'],
      ['data-yqp-video-id', 'data-yqp-video-id'],
      ['dataYqpStatus', 'data-yqp-status']
    ];

    for (const [key, expected] of attrCases) {
      assert.strictEqual(DomHelpers.formatYqpAttributeName(key), expected);
      // Idempotence test
      assert.strictEqual(DomHelpers.formatYqpAttributeName(expected), expected);
    }

    // Benchmark 20,000 casing transformations (< 50ms)
    const startCase = performance.now();
    for (let i = 0; i < 10000; i++) {
      DomHelpers.toKebabCase('veryLongCamelCasePropertyNameThatNeedsKebabTransformation');
      DomHelpers.formatYqpAttributeName('activeVideoIdentifierCard');
    }
    const caseTime = performance.now() - startCase;
    console.log(`    [BENCHMARK] DomHelpers 20,000 casing operations completed in ${caseTime.toFixed(2)}ms`);
    assert.ok(caseTime < 50, `20,000 casing operations took ${caseTime.toFixed(2)}ms, must be < 50ms`);
  });

  test('6. safeQuery, safeQueryAll, and matches error safety', () => {
    // Malformed CSS selectors must not throw
    assert.strictEqual(DomHelpers.safeQuery(':::invalid', null), null);
    assert.deepStrictEqual(DomHelpers.safeQueryAll(':::invalid', null), []);
    assert.strictEqual(DomHelpers.matches(null, 'div'), false);
    assert.strictEqual(DomHelpers.matches({}, 'div'), false);
    assert.strictEqual(DomHelpers.closest(null, 'div'), null);
  });
});
