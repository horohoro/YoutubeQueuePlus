/**
 * YoutubeQueuePlus - Milestone M2 FeedDecorator Empirical Stress Test Suite
 * Zero-dependency empirical test harness using Node.js v24 native test runner.
 *
 * Requirements & Objectives:
 * 1. High-density feed scaling: 1,000 feed cards in DOM. Benchmark decoration latency (< 30ms).
 * 2. Rapid mode toggling: switching between badge_and_dim, hide, and badge_only 50 times in rapid sequence.
 *    Verify zero orphaned badges, zero stuck display styles, and 100% attribute consistency.
 * 3. Rapid add/remove cycles: adding and removing 50 video IDs rapidly. Verify all cards cleanly transition
 *    between decorated and un-decorated states.
 * 4. Infinite scroll simulation: appending 10 batches of 20 cards. Verify all appended cards matching
 *    queued IDs are automatically decorated.
 * 5. Adversarial edge cases: Polymer recycled DOM elements, malformed card hierarchies, invalid inputs,
 *    and clean destroy lifecycle.
 *
 * Executable via: node test/m2_feed_decorator_stress.test.js
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { performance } = require('node:perf_hooks');

// =============================================================================
// High-Performance Mock DOM & MutationObserver Environment
// =============================================================================

function matchSimpleSelector(el, sel) {
  if (!sel || !el || el.nodeType !== 1) return false;
  let s = sel.trim();

  // Tag match
  const tagMatch = s.match(/^([a-zA-Z0-9_-]+)/);
  if (tagMatch) {
    if (el.tagName !== tagMatch[1].toUpperCase()) return false;
    s = s.slice(tagMatch[1].length);
  }

  // Token loop (#id, .class, [attr...])
  while (s.length > 0) {
    if (s.startsWith('#')) {
      const m = s.match(/^#([a-zA-Z0-9_-]+)/);
      if (!m) return false;
      if (el.getAttribute('id') !== m[1]) return false;
      s = s.slice(m[0].length);
    } else if (s.startsWith('.')) {
      const m = s.match(/^\.([a-zA-Z0-9_-]+)/);
      if (!m) return false;
      if (!el.classList.contains(m[1])) return false;
      s = s.slice(m[0].length);
    } else if (s.startsWith('[')) {
      const closeIdx = s.indexOf(']');
      if (closeIdx === -1) return false;
      const inner = s.slice(1, closeIdx);
      s = s.slice(closeIdx + 1);

      if (inner.includes('*=')) {
        const [attr, rawVal] = inner.split('*=');
        const cleanVal = rawVal.replace(/^["']|["']$/g, '');
        const actual = el.getAttribute(attr.trim());
        if (!actual || !actual.includes(cleanVal)) return false;
      } else if (inner.includes('=')) {
        const [attr, rawVal] = inner.split('=');
        const cleanVal = rawVal.replace(/^["']|["']$/g, '');
        const actual = el.getAttribute(attr.trim());
        if (actual !== cleanVal) return false;
      } else {
        if (!el.hasAttribute(inner.trim())) return false;
      }
    } else {
      break;
    }
  }
  return s.length === 0;
}

class MockMutationRecord {
  constructor({ type, target, addedNodes = [], removedNodes = [], attributeName = null, oldValue = null }) {
    this.type = type;
    this.target = target;
    this.addedNodes = addedNodes;
    this.removedNodes = removedNodes;
    this.attributeName = attributeName;
    this.oldValue = oldValue;
  }
}

class MockMutationObserver {
  static _activeObservers = new Set();

  constructor(callback) {
    this.callback = callback;
    this.targets = new Map();
    this._queue = [];
    MockMutationObserver._activeObservers.add(this);
  }

  observe(target, options = {}) {
    if (!target) return;
    this.targets.set(target, {
      childList: Boolean(options.childList),
      attributes: Boolean(options.attributes),
      subtree: Boolean(options.subtree),
      attributeFilter: Array.isArray(options.attributeFilter) ? options.attributeFilter : null
    });
  }

  disconnect() {
    this.targets.clear();
    this._queue = [];
    MockMutationObserver._activeObservers.delete(this);
  }

  takeRecords() {
    const records = [...this._queue];
    this._queue = [];
    return records;
  }

  _enqueue(record) {
    this._queue.push(record);
    if (this._queue.length === 1) {
      queueMicrotask(() => {
        if (this._queue.length > 0) {
          const records = this.takeRecords();
          this.callback(records, this);
        }
      });
    }
  }

  static _notify(record) {
    for (const obs of MockMutationObserver._activeObservers) {
      for (const [target, options] of obs.targets.entries()) {
        const isTarget = (record.target === target);
        const isSubtree = options.subtree && (target.contains ? target.contains(record.target) : false);

        if (!isTarget && !isSubtree) continue;

        if (record.type === 'childList' && options.childList) {
          obs._enqueue(record);
          break;
        } else if (record.type === 'attributes' && options.attributes) {
          if (!options.attributeFilter || options.attributeFilter.includes(record.attributeName)) {
            obs._enqueue(record);
            break;
          }
        }
      }
    }
  }

  static flush() {
    for (const obs of MockMutationObserver._activeObservers) {
      if (obs._queue.length > 0) {
        const records = obs.takeRecords();
        obs.callback(records, obs);
      }
    }
  }
}

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
        }
        self._classList.add(token);
        return true;
      }
    };
    this.style = {};
    this.textContent = '';
  }

  get parentElement() {
    return this.parentNode;
  }

  get dataset() {
    const dataObj = {};
    for (const [attr, val] of this.attributes.entries()) {
      if (attr.startsWith('data-')) {
        const key = attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        dataObj[key] = val;
      }
    }
    return dataObj;
  }

  get id() {
    return this.getAttribute('id') || '';
  }
  set id(val) {
    this.setAttribute('id', val);
  }

  get className() {
    return this.getAttribute('class') || '';
  }
  set className(val) {
    this.setAttribute('class', val);
  }

  get href() {
    return this.getAttribute('href') || '';
  }
  set href(val) {
    this.setAttribute('href', val);
  }

  setAttribute(name, value) {
    const oldValue = this.getAttribute(name);
    this.attributes.set(name, String(value));
    if (name === 'class') {
      this._classList.clear();
      String(value).split(/\s+/).filter(Boolean).forEach(c => this._classList.add(c));
    }
    MockMutationObserver._notify(new MockMutationRecord({
      type: 'attributes',
      target: this,
      attributeName: name,
      oldValue
    }));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    if (this.attributes.has(name)) {
      const oldValue = this.getAttribute(name);
      this.attributes.delete(name);
      if (name === 'class') {
        this._classList.clear();
      }
      MockMutationObserver._notify(new MockMutationRecord({
        type: 'attributes',
        target: this,
        attributeName: name,
        oldValue
      }));
    }
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    MockMutationObserver._notify(new MockMutationRecord({
      type: 'childList',
      target: this,
      addedNodes: [child],
      removedNodes: []
    }));
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
      MockMutationObserver._notify(new MockMutationRecord({
        type: 'childList',
        target: this,
        addedNodes: [],
        removedNodes: [child]
      }));
      return child;
    }
    return null;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  contains(node) {
    let curr = node;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentNode;
    }
    return false;
  }

  matches(selector) {
    if (!selector) return false;
    const s = selector.trim();
    if (s.includes(',')) {
      return s.split(',').some(sub => this.matches(sub.trim()));
    }
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      return matchSimpleSelector(this, parts[0]);
    }
    // Compound descendant selector: e.g. "div #items"
    if (!matchSimpleSelector(this, parts[parts.length - 1])) {
      return false;
    }
    let curr = this.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      const required = parts[i];
      let found = false;
      while (curr && (curr.nodeType === 1 || curr.tagName)) {
        if (matchSimpleSelector(curr, required)) {
          found = true;
          curr = curr.parentNode;
          break;
        }
        curr = curr.parentNode;
      }
      if (!found) return false;
    }
    return true;
  }

  closest(selector) {
    let curr = this;
    while (curr && curr.nodeType === 1) {
      if (curr.matches && curr.matches(selector)) return curr;
      curr = curr.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    if (selector.includes(',')) {
      for (const sub of selector.split(',')) {
        const found = this.querySelector(sub.trim());
        if (found) return found;
      }
      return null;
    }
    const parts = selector.split(/\s+/).filter(Boolean);
    return this._queryDescendants(parts);
  }

  _queryDescendants(parts) {
    if (parts.length === 0) return null;
    const first = parts[0];
    const rest = parts.slice(1);
    for (const child of this.children) {
      if (child.matches && child.matches(first)) {
        if (rest.length === 0) return child;
        const sub = child._queryDescendants(rest);
        if (sub) return sub;
      }
      const deeper = child._queryDescendants(parts);
      if (deeper) return deeper;
    }
    return null;
  }

  querySelectorAll(selector) {
    if (selector.includes(',')) {
      const subs = selector.split(',').map(s => s.trim());
      const seen = new Set();
      const results = [];
      for (const sub of subs) {
        for (const el of this.querySelectorAll(sub)) {
          if (!seen.has(el)) {
            seen.add(el);
            results.push(el);
          }
        }
      }
      return results;
    }
    const results = [];
    const traverse = (node) => {
      for (const child of node.children) {
        if (child.matches && child.matches(selector)) {
          results.push(child);
        }
        if (child.children) traverse(child);
      }
    };
    traverse(this);
    return results;
  }
}

// Global DOM Setup
let documentRoot = new MockElement('html');
let documentBody = new MockElement('body');
documentRoot.appendChild(documentBody);

globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {}
};

globalThis.document = {
  documentElement: documentRoot,
  body: documentBody,
  createElement: (tag) => new MockElement(tag),
  createTextNode: (text) => ({ textContent: String(text), nodeType: 3 }),
  querySelector: (sel) => documentBody.querySelector(sel) || (documentBody.matches(sel) ? documentBody : null),
  querySelectorAll: (sel) => documentBody.querySelectorAll(sel),
  addEventListener: () => {},
  removeEventListener: () => {}
};
globalThis.MutationObserver = MockMutationObserver;

async function flushMutations(delayMs = 15) {
  MockMutationObserver.flush();
  await new Promise(r => setTimeout(r, delayMs));
}

function resetDOM() {
  documentBody = new MockElement('body');
  documentRoot = new MockElement('html');
  documentRoot.appendChild(documentBody);
  globalThis.document.body = documentBody;
  globalThis.document.documentElement = documentRoot;
}

// Subject Modules Import
const PROJECT_ROOT = path.resolve(__dirname, '..');
const Constants = require(path.join(PROJECT_ROOT, 'src/shared/constants.js'));
const FeedDecorator = require(path.join(PROJECT_ROOT, 'src/modules/feed_decorator.js'));

// Helper for generating valid 11-char YouTube video IDs
function makeVidId(num) {
  return 'vid_' + String(num).padStart(7, '0');
}

/**
 * Creates a YouTube-style feed card element.
 * Supports realistic variety of tag names and thumbnail structures.
 */
function createFeedCard(index, tagType = 'rich') {
  const tagName = tagType === 'rich'
    ? 'ytd-rich-item-renderer'
    : (tagType === 'video' ? 'ytd-video-renderer' : 'ytd-compact-video-renderer');

  const card = document.createElement(tagName);
  const vidId = makeVidId(index);

  const thumbContainer = document.createElement('div');
  thumbContainer.setAttribute('id', 'thumbnail');
  thumbContainer.className = 'ytd-thumbnail';

  const anchor = document.createElement('a');
  anchor.setAttribute('id', 'thumbnail');
  anchor.setAttribute('href', `/watch?v=${vidId}`);

  thumbContainer.appendChild(anchor);
  card.appendChild(thumbContainer);

  return { card, vidId };
}

// =============================================================================
// Challenge 1: High-Density Feed Scaling (1,000 Cards)
// =============================================================================
describe('Challenge 1: High-Density Feed Scaling (1,000 Cards & Latency Benchmark)', () => {
  beforeEach(() => resetDOM());

  test('Benchmark decoration latency on 1,000 DOM cards under varied queue loads (< 30ms)', () => {
    const feedContainer = document.createElement('div');
    feedContainer.setAttribute('id', 'contents');
    documentBody.appendChild(feedContainer);

    // Build 1,000 feed cards with realistic YouTube distribution
    const TOTAL_CARDS = 1000;
    const cards = [];
    const allVidIds = [];

    for (let i = 0; i < TOTAL_CARDS; i++) {
      const tagType = i % 10 === 0 ? 'compact' : (i % 3 === 0 ? 'video' : 'rich');
      const { card, vidId } = createFeedCard(i, tagType);
      feedContainer.appendChild(card);
      cards.push(card);
      allVidIds.push(vidId);
    }

    assert.strictEqual(feedContainer.children.length, 1000);

    const decorator = new FeedDecorator({
      mode: 'badge_and_dim',
      autoObserve: false // Test synchronous core scan latency directly
    });

    // --- Scenario 1.1: 0 -> 100 queued cards ---
    const ids100 = allVidIds.slice(0, 100);
    const t0 = performance.now();
    decorator.updateQueue(ids100);
    const latency100 = performance.now() - t0;

    const queuedCards100 = documentBody.querySelectorAll('[data-yqp-status="queued"]');
    assert.strictEqual(queuedCards100.length, 100, 'Exactly 100 cards marked queued');
    for (let i = 0; i < 100; i++) {
      assert.strictEqual(cards[i].getAttribute('data-yqp-status'), 'queued');
      assert.strictEqual(cards[i].style.opacity, '0.4');
      assert.ok(cards[i].querySelector('.yqp-queue-badge') !== null);
    }
    // Verify untagged card
    assert.strictEqual(cards[100].getAttribute('data-yqp-status'), null);
    assert.strictEqual(cards[100].querySelector('.yqp-queue-badge'), null);

    // --- Scenario 1.2: 100 -> 500 queued cards ---
    const ids500 = allVidIds.slice(0, 500);
    const t1 = performance.now();
    decorator.updateQueue(ids500);
    const latency500 = performance.now() - t1;

    const queuedCards500 = documentBody.querySelectorAll('[data-yqp-status="queued"]');
    assert.strictEqual(queuedCards500.length, 500, 'Exactly 500 cards marked queued');

    // --- Scenario 1.3: 500 -> 1,000 queued cards (100% density) ---
    const t2 = performance.now();
    decorator.updateQueue(allVidIds);
    const latency1000 = performance.now() - t2;

    const queuedCards1000 = documentBody.querySelectorAll('[data-yqp-status="queued"]');
    assert.strictEqual(queuedCards1000.length, 1000, 'All 1,000 cards marked queued');

    // --- Scenario 1.4: 1,000 -> 0 queued cards (Complete queue clear) ---
    const t3 = performance.now();
    decorator.updateQueue([]);
    const latencyClear = performance.now() - t3;

    const queuedCardsCleared = documentBody.querySelectorAll('[data-yqp-status="queued"]');
    assert.strictEqual(queuedCardsCleared.length, 0, 'Zero cards marked queued after clear');

    // Check all badges removed and styles restored
    const remainingBadges = documentBody.querySelectorAll('.yqp-queue-badge');
    assert.strictEqual(remainingBadges.length, 0, 'Zero orphaned badges after clear');

    // Multi-iteration latency benchmark (p95 & average across 10 full cycles)
    const benchmarkTimes = [];
    for (let iter = 0; iter < 10; iter++) {
      const subset = allVidIds.slice(0, 250);
      const start = performance.now();
      decorator.updateQueue(subset);
      benchmarkTimes.push(performance.now() - start);

      const clearStart = performance.now();
      decorator.updateQueue([]);
      benchmarkTimes.push(performance.now() - clearStart);
    }

    benchmarkTimes.sort((a, b) => a - b);
    const avgLatency = benchmarkTimes.reduce((acc, v) => acc + v, 0) / benchmarkTimes.length;
    const p95Latency = benchmarkTimes[Math.floor(benchmarkTimes.length * 0.95)];

    console.log(`    [BENCHMARK 1,000 Cards] 100 queued: ${latency100.toFixed(2)}ms`);
    console.log(`    [BENCHMARK 1,000 Cards] 500 queued: ${latency500.toFixed(2)}ms`);
    console.log(`    [BENCHMARK 1,000 Cards] 1,000 queued: ${latency1000.toFixed(2)}ms`);
    console.log(`    [BENCHMARK 1,000 Cards] Queue clear (1,000->0): ${latencyClear.toFixed(2)}ms`);
    console.log(`    [BENCHMARK 1,000 Cards] Average latency (20 runs): ${avgLatency.toFixed(2)}ms`);
    console.log(`    [BENCHMARK 1,000 Cards] P95 latency (20 runs): ${p95Latency.toFixed(2)}ms`);

    // Assert dispatch SLA: decoration latency < 30ms
    assert.ok(avgLatency < 30, `Average latency (${avgLatency.toFixed(2)}ms) must be < 30ms`);
    assert.ok(p95Latency < 30, `P95 latency (${p95Latency.toFixed(2)}ms) must be < 30ms`);
    assert.ok(latency100 < 30, `Initial 100-card latency (${latency100.toFixed(2)}ms) must be < 30ms`);
    assert.ok(latency500 < 30, `500-card latency (${latency500.toFixed(2)}ms) must be < 30ms`);
    assert.ok(latency1000 < 30, `1,000-card latency (${latency1000.toFixed(2)}ms) must be < 30ms`);
    assert.ok(latencyClear < 30, `Clear latency (${latencyClear.toFixed(2)}ms) must be < 30ms`);

    decorator.destroy();
  });
});

// =============================================================================
// Challenge 2: Rapid Mode Toggling (50+ Cycles)
// =============================================================================
describe('Challenge 2: Rapid Mode Toggling (Zero Orphaned Badges, Clean Display, Attribute Consistency)', () => {
  beforeEach(() => resetDOM());

  test('50 rapid sequence mode switches verify zero orphaned badges, zero stuck display styles, and 100% attribute consistency', () => {
    const feedContainer = document.createElement('div');
    documentBody.appendChild(feedContainer);

    const TOTAL_CARDS = 1000;
    const QUEUED_COUNT = 200;
    const cards = [];
    const queuedIds = [];

    for (let i = 0; i < TOTAL_CARDS; i++) {
      const { card, vidId } = createFeedCard(i);
      feedContainer.appendChild(card);
      cards.push(card);
      if (i < QUEUED_COUNT) {
        queuedIds.push(vidId);
      }
    }

    const decorator = new FeedDecorator({
      mode: 'badge_and_dim',
      autoObserve: false
    });
    decorator.updateQueue(queuedIds);

    const modes = ['badge_and_dim', 'hide', 'badge_only'];
    const CYCLES = 50;

    for (let cycle = 0; cycle < CYCLES; cycle++) {
      for (const targetMode of modes) {
        decorator.setMode(targetMode);

        // Verify active mode matches
        assert.strictEqual(decorator.getMode(), targetMode);

        // Sample check mid-loop on boundary items
        const sampleQueued = cards[0];
        const sampleUnqueued = cards[QUEUED_COUNT];

        assert.strictEqual(sampleQueued.getAttribute('data-yqp-mode'), targetMode);
        assert.strictEqual(sampleUnqueued.getAttribute('data-yqp-mode'), null);

        if (targetMode === 'hide') {
          assert.strictEqual(sampleQueued.style.display, 'none');
          assert.notStrictEqual(sampleQueued.style.opacity, '0.4');
        } else if (targetMode === 'badge_and_dim') {
          assert.notStrictEqual(sampleQueued.style.display, 'none');
          assert.strictEqual(sampleQueued.style.opacity, '0.4');
        } else if (targetMode === 'badge_only') {
          assert.notStrictEqual(sampleQueued.style.display, 'none');
          assert.notStrictEqual(sampleQueued.style.opacity, '0.4');
        }
      }
    }

    // Exhaustive post-test verification across ALL 1,000 cards
    const finalMode = decorator.getMode(); // 'badge_only'
    const totalBadges = documentBody.querySelectorAll('.yqp-queue-badge');
    assert.strictEqual(totalBadges.length, QUEUED_COUNT, 'Total badges must strictly equal queued count (zero orphaned)');

    for (let i = 0; i < TOTAL_CARDS; i++) {
      const card = cards[i];
      const isQueued = i < QUEUED_COUNT;

      if (isQueued) {
        assert.strictEqual(card.getAttribute('data-yqp-status'), 'queued');
        assert.strictEqual(card.getAttribute('data-yqp-mode'), finalMode);
        assert.ok(card.querySelector('.yqp-queue-badge') !== null, 'Queued card must have badge');
        assert.notStrictEqual(card.style.display, 'none', 'Final mode badge_only must not be hidden');
        assert.notStrictEqual(card.style.opacity, '0.4', 'Final mode badge_only must not be dimmed');
      } else {
        assert.strictEqual(card.getAttribute('data-yqp-status'), null);
        assert.strictEqual(card.getAttribute('data-yqp-mode'), null);
        assert.strictEqual(card.querySelector('.yqp-queue-badge'), null, 'Unqueued card must never have badge');
        assert.notStrictEqual(card.style.display, 'none', 'Unqueued card must never be hidden');
        assert.notStrictEqual(card.style.opacity, '0.4', 'Unqueued card must never be dimmed');
      }
    }

    // Test switching to 'hide' as final step to verify display: none across all 200 items
    decorator.setMode('hide');
    for (let i = 0; i < TOTAL_CARDS; i++) {
      const card = cards[i];
      if (i < QUEUED_COUNT) {
        assert.strictEqual(card.style.display, 'none');
      } else {
        assert.notStrictEqual(card.style.display, 'none');
      }
    }

    // Test invalid mode fallback safely defaults to badge_and_dim without throwing
    decorator.setMode('invalid_mode_xyz');
    assert.strictEqual(decorator.getMode(), 'badge_and_dim');
    assert.strictEqual(cards[0].style.opacity, '0.4');
    assert.notStrictEqual(cards[0].style.display, 'none');

    decorator.destroy();
  });
});

// =============================================================================
// Challenge 3: Rapid Add/Remove Cycles (50 Video IDs)
// =============================================================================
describe('Challenge 3: Rapid Add/Remove Cycles (State Transitions & Clean Undecoration)', () => {
  beforeEach(() => resetDOM());

  test('50 rapid individual add and remove cycles cleanly transition cards between decorated and un-decorated states', () => {
    const feedContainer = document.createElement('div');
    documentBody.appendChild(feedContainer);

    const TOTAL_CARDS = 500;
    const cards = [];
    const allVidIds = [];

    for (let i = 0; i < TOTAL_CARDS; i++) {
      const { card, vidId } = createFeedCard(i);
      feedContainer.appendChild(card);
      cards.push(card);
      allVidIds.push(vidId);
    }

    const decorator = new FeedDecorator({
      mode: 'badge_and_dim',
      autoObserve: false
    });

    const TEST_IDS_COUNT = 50;
    const currentQueue = [];

    // Phase 1: Rapid individual additions (0 -> 50)
    for (let i = 0; i < TEST_IDS_COUNT; i++) {
      currentQueue.push(allVidIds[i]);
      decorator.updateQueue([...currentQueue]);

      // Check current card became decorated
      const card = cards[i];
      assert.strictEqual(card.getAttribute('data-yqp-status'), 'queued');
      assert.strictEqual(card.getAttribute('data-yqp-mode'), 'badge_and_dim');
      assert.strictEqual(card.style.opacity, '0.4');
      assert.ok(card.querySelector('.yqp-queue-badge') !== null);

      // Check next unqueued card is untouched
      assert.strictEqual(cards[i + 1].getAttribute('data-yqp-status'), null);
      assert.strictEqual(cards[i + 1].querySelector('.yqp-queue-badge'), null);
    }

    assert.strictEqual(documentBody.querySelectorAll('.yqp-queue-badge').length, 50);

    // Phase 2: Rapid individual removals (50 -> 0)
    for (let i = TEST_IDS_COUNT - 1; i >= 0; i--) {
      currentQueue.pop();
      decorator.updateQueue([...currentQueue]);

      // Check removed card was cleanly un-decorated
      const card = cards[i];
      assert.strictEqual(card.getAttribute('data-yqp-status'), null, `Card ${i} data-yqp-status must be removed`);
      assert.strictEqual(card.getAttribute('data-yqp-mode'), null, `Card ${i} data-yqp-mode must be removed`);
      assert.strictEqual(card.querySelector('.yqp-queue-badge'), null, `Card ${i} badge must be removed`);
      assert.notStrictEqual(card.style.opacity, '0.4', `Card ${i} opacity must be restored`);
      assert.notStrictEqual(card.style.display, 'none', `Card ${i} display must be restored`);

      // Verify remaining queued count
      const activeBadges = documentBody.querySelectorAll('.yqp-queue-badge');
      assert.strictEqual(activeBadges.length, i, `Active badges must equal remaining items (${i})`);
    }

    assert.strictEqual(documentBody.querySelectorAll('.yqp-queue-badge').length, 0);

    // Phase 3: Disjoint set thrashing (Set A vs Set B) 50 times in rapid succession
    const setA = allVidIds.slice(0, 25);
    const setB = allVidIds.slice(25, 50);

    for (let cycle = 0; cycle < 50; cycle++) {
      const activeSet = cycle % 2 === 0 ? setA : setB;
      decorator.updateQueue(activeSet);

      const badges = documentBody.querySelectorAll('.yqp-queue-badge');
      assert.strictEqual(badges.length, 25, `Cycle ${cycle} must have exactly 25 badges`);
    }

    decorator.destroy();
  });
});

// =============================================================================
// Challenge 4: Infinite Scroll Simulation (10 Batches of 20 Cards)
// =============================================================================
describe('Challenge 4: Infinite Scroll Simulation (10 Batches of 20 Cards)', () => {
  beforeEach(() => resetDOM());

  test('Appending 10 batches of 20 cards automatically decorates queued cards via MutationObserver without manual update', async () => {
    const feedContainer = document.createElement('div');
    feedContainer.setAttribute('id', 'contents');
    documentBody.appendChild(feedContainer);

    // Pre-populate queue with 50 video IDs that will appear in future scroll batches
    // Specifically, cards with index ending in 5 or 0 will be queued (e.g., 5, 10, 15...)
    const queuedIds = [];
    for (let i = 0; i < 200; i++) {
      if (i % 5 === 0) {
        queuedIds.push(makeVidId(i));
      }
    }
    assert.strictEqual(queuedIds.length, 40, '40 predetermined IDs are queued');

    const decorator = new FeedDecorator({
      mode: 'badge_and_dim',
      videoIds: queuedIds,
      autoObserve: true,
      debounceMs: 0
    });

    const BATCHES = 10;
    const CARDS_PER_BATCH = 20;
    let expectedTotalDecorated = 0;

    for (let batch = 0; batch < BATCHES; batch++) {
      const startIndex = batch * CARDS_PER_BATCH;
      let batchExpectedDecorated = 0;

      for (let i = 0; i < CARDS_PER_BATCH; i++) {
        const cardIndex = startIndex + i;
        const { card, vidId } = createFeedCard(cardIndex);
        feedContainer.appendChild(card);

        if (cardIndex % 5 === 0) {
          batchExpectedDecorated++;
        }
      }

      expectedTotalDecorated += batchExpectedDecorated;

      // Allow MutationObserver to process additions
      await flushMutations(20);

      // Verify cumulative decorated count
      const decoratedCards = documentBody.querySelectorAll('[data-yqp-status="queued"]');
      assert.strictEqual(
        decoratedCards.length,
        expectedTotalDecorated,
        `Batch ${batch + 1}: Expected ${expectedTotalDecorated} decorated cards in DOM, got ${decoratedCards.length}`
      );

      const badges = documentBody.querySelectorAll('.yqp-queue-badge');
      assert.strictEqual(
        badges.length,
        expectedTotalDecorated,
        `Batch ${batch + 1}: Expected ${expectedTotalDecorated} badges in DOM, got ${badges.length}`
      );
    }

    assert.strictEqual(expectedTotalDecorated, 40, 'After 10 batches, exactly 40 matching cards appended');

    // Verify all 40 queued cards have correct attributes and opacity
    const finalDecorated = documentBody.querySelectorAll('[data-yqp-status="queued"]');
    assert.strictEqual(finalDecorated.length, 40);
    for (const card of finalDecorated) {
      assert.strictEqual(card.getAttribute('data-yqp-status'), 'queued');
      assert.strictEqual(card.getAttribute('data-yqp-mode'), 'badge_and_dim');
      assert.strictEqual(card.style.opacity, '0.4');
      assert.ok(card.querySelector('.yqp-queue-badge') !== null);
    }

    // Verify unqueued cards in the feed remain completely untouched
    const allCards = documentBody.querySelectorAll('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer');
    assert.strictEqual(allCards.length, 200);
    let unqueuedCount = 0;
    for (const card of allCards) {
      if (card.getAttribute('data-yqp-status') !== 'queued') {
        unqueuedCount++;
        assert.strictEqual(card.getAttribute('data-yqp-mode'), null);
        assert.strictEqual(card.querySelector('.yqp-queue-badge'), null);
        assert.notStrictEqual(card.style.opacity, '0.4');
      }
    }
    assert.strictEqual(unqueuedCount, 160);

    decorator.destroy();
  });
});

// =============================================================================
// Challenge 5: Adversarial Boundary Cases & Polymer Recycled Elements
// =============================================================================
describe('Challenge 5: Adversarial Edge Cases & Polymer Recycled DOM Elements', () => {
  beforeEach(() => resetDOM());

  test('Polymer DOM recycling: card href changing in-place triggers clean re-decoration/undecoration', () => {
    const feedContainer = document.createElement('div');
    documentBody.appendChild(feedContainer);

    const { card, vidId: idQueued } = createFeedCard(1);
    const idNotQueued = makeVidId(999);
    feedContainer.appendChild(card);

    const decorator = new FeedDecorator({
      mode: 'badge_and_dim',
      videoIds: [idQueued],
      autoObserve: false
    });

    // Initial state: Card is queued
    assert.strictEqual(card.getAttribute('data-yqp-status'), 'queued');
    assert.ok(card.querySelector('.yqp-queue-badge') !== null);

    // YouTube recycles the card in-place: anchor href changes to an unqueued video
    const anchor = card.querySelector('a#thumbnail');
    anchor.setAttribute('href', `/watch?v=${idNotQueued}`);

    // Re-scan
    decorator.scanAndDecorate();

    // Verify: Card was cleanly undecorated despite reusing the same DOM element!
    assert.strictEqual(card.getAttribute('data-yqp-status'), null);
    assert.strictEqual(card.getAttribute('data-yqp-mode'), null);
    assert.strictEqual(card.querySelector('.yqp-queue-badge'), null);
    assert.notStrictEqual(card.style.opacity, '0.4');
    assert.strictEqual(card.getAttribute('data-yqp-video-id'), idNotQueued);

    // Reverse recycling: anchor href changes back to queued video
    anchor.setAttribute('href', `/watch?v=${idQueued}`);
    decorator.scanAndDecorate();

    assert.strictEqual(card.getAttribute('data-yqp-status'), 'queued');
    assert.ok(card.querySelector('.yqp-queue-badge') !== null);
    assert.strictEqual(card.style.opacity, '0.4');

    decorator.destroy();
  });

  test('Card without thumbnail container falls back to appending badge to card root safely', () => {
    const bareCard = document.createElement('ytd-rich-item-renderer');
    const anchor = document.createElement('a');
    const targetId = makeVidId(77);
    anchor.setAttribute('id', 'video-title-link');
    anchor.setAttribute('href', `/watch?v=${targetId}`);
    bareCard.appendChild(anchor);
    documentBody.appendChild(bareCard);

    const decorator = new FeedDecorator({
      mode: 'badge_and_dim',
      videoIds: [targetId],
      autoObserve: false
    });

    assert.strictEqual(bareCard.getAttribute('data-yqp-status'), 'queued');
    const badge = bareCard.querySelector('.yqp-queue-badge');
    assert.ok(badge !== null);
    assert.strictEqual(badge.parentNode, bareCard, 'Badge appended directly to bareCard');

    decorator.destroy();
  });

  test('Defensive resilience: malformed inputs, nulls, and clean destroy', () => {
    const decorator = new FeedDecorator({ autoObserve: false });

    // Invalid updateQueue parameters must not throw
    assert.doesNotThrow(() => decorator.updateQueue(null));
    assert.strictEqual(decorator.getActiveQueueIds().size, 0);

    assert.doesNotThrow(() => decorator.updateQueue(undefined));
    assert.doesNotThrow(() => decorator.updateQueue([null, '', 123, 'too_short', {}]));
    assert.strictEqual(decorator.getActiveQueueIds().size, 0);

    // Destroy cleans up and leaves no lingering side effects
    decorator.destroy();
    assert.strictEqual(decorator.isObserving, false);
    assert.strictEqual(decorator.getActiveQueueIds().size, 0);
  });

  test('Idempotency: 100 redundant updateQueue calls with identical IDs do not duplicate badges', () => {
    const feedContainer = document.createElement('div');
    documentBody.appendChild(feedContainer);

    const testId = makeVidId(88);
    const { card } = createFeedCard(88);
    feedContainer.appendChild(card);

    const decorator = new FeedDecorator({
      mode: 'badge_and_dim',
      autoObserve: false
    });

    // Call updateQueue 100 times with identical payload
    for (let i = 0; i < 100; i++) {
      decorator.updateQueue([testId]);
    }

    // Verify exactly ONE badge exists on the card
    const badges = card.querySelectorAll('.yqp-queue-badge');
    assert.strictEqual(badges.length, 1, 'Never duplicate badges on redundant updateQueue');
    assert.strictEqual(card.getAttribute('data-yqp-status'), 'queued');

    decorator.destroy();
  });

  test('Interleaved mode toggling while infinite scroll cards append preserves 100% consistency', async () => {
    const feedContainer = document.createElement('div');
    documentBody.appendChild(feedContainer);

    const queuedId = makeVidId(111);
    const decorator = new FeedDecorator({
      mode: 'badge_and_dim',
      videoIds: [queuedId],
      autoObserve: true,
      debounceMs: 0
    });

    const modes = ['hide', 'badge_only', 'badge_and_dim'];

    for (let step = 0; step < 15; step++) {
      // Toggle mode
      const nextMode = modes[step % 3];
      decorator.setMode(nextMode);

      // Concurrently append a card matching the queue
      const { card } = createFeedCard(111);
      feedContainer.appendChild(card);
      await flushMutations(15);

      // Verify the newly appended card matches current mode immediately
      assert.strictEqual(card.getAttribute('data-yqp-status'), 'queued');
      assert.strictEqual(card.getAttribute('data-yqp-mode'), nextMode);
      assert.ok(card.querySelector('.yqp-queue-badge') !== null);

      if (nextMode === 'hide') {
        assert.strictEqual(card.style.display, 'none');
      } else if (nextMode === 'badge_and_dim') {
        assert.strictEqual(card.style.opacity, '0.4');
      } else if (nextMode === 'badge_only') {
        assert.notStrictEqual(card.style.opacity, '0.4');
        assert.notStrictEqual(card.style.display, 'none');
      }
    }

    decorator.destroy();
  });

  test('YouTube SPA navigation listener triggers scan on yt-navigate-finish', async () => {
    const feedContainer = document.createElement('div');
    documentBody.appendChild(feedContainer);

    let navListener = null;
    globalThis.window.addEventListener = (event, fn) => {
      if (event === 'yt-navigate-finish') navListener = fn;
    };

    const targetId = makeVidId(42);
    const decorator = new FeedDecorator({
      mode: 'badge_and_dim',
      videoIds: [targetId],
      autoObserve: true,
      debounceMs: 0
    });

    assert.ok(typeof navListener === 'function', 'Must attach yt-navigate-finish listener');

    // Add card without notifying MutationObserver
    const { card } = createFeedCard(42);
    card.parentNode = feedContainer;
    feedContainer.children.push(card);

    assert.strictEqual(card.getAttribute('data-yqp-status'), null);

    // Trigger navigation event (debounced scan)
    navListener();
    await new Promise(r => setTimeout(r, 15));

    assert.strictEqual(card.getAttribute('data-yqp-status'), 'queued');
    assert.ok(card.querySelector('.yqp-queue-badge') !== null);

    decorator.destroy();
  });
});

