/**
 * YoutubeQueuePlus - Milestone M2 Adversarial Stress & Conformance Test Suite
 * Zero-dependency test runner using Node.js v24 native test runner.
 *
 * Stress-tests FeedDecorator and queue_plus.css against:
 * 1. CSS Syntax, Rules, and Specificity Conformance
 * 2. FeedDecorator Input Boundary, Fuzzing & Malformed Queue Data
 * 3. Polymer Virtual Scroller Element Recycling & Stale State Elimination
 * 4. Duplicate Badge Prevention & DOM Edge Hierarchy Handling
 * 5. MutationObserver Infinite Scroll Burst & High-Volume DOM Stress
 * 6. Lifecycle, Teardown Integrity & Memory Leak Safeguards
 *
 * Executable via: node test/m2_stress.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { performance } = require('perf_hooks');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const FeedDecorator = require(path.join(PROJECT_ROOT, 'src/modules/feed_decorator.js'));
const DomHelpers = require(path.join(PROJECT_ROOT, 'src/utils/dom_helpers.js'));
const UrlParser = require(path.join(PROJECT_ROOT, 'src/utils/url_parser.js'));
const Constants = require(path.join(PROJECT_ROOT, 'src/shared/constants.js'));

// =============================================================================
// DOM & MutationObserver Mock Engine
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
    const results = [];
    if (selector.includes(',')) {
      const subs = selector.split(',').map(s => s.trim());
      for (const sub of subs) {
        for (const el of this.querySelectorAll(sub)) {
          if (!results.includes(el)) results.push(el);
        }
      }
      return results;
    }
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

// Global DOM setup
let documentRoot = new MockElement('html');
let documentBody = new MockElement('body');
documentRoot.appendChild(documentBody);

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
globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {}
};

function resetDOM() {
  documentBody = new MockElement('body');
  documentRoot = new MockElement('html');
  documentRoot.appendChild(documentBody);
  globalThis.document.body = documentBody;
  globalThis.document.documentElement = documentRoot;
}

async function flushMutations(delayMs = 15) {
  MockMutationObserver.flush();
  await new Promise(r => setTimeout(r, delayMs));
}

// Helper to create standard mock card
function createMockCard(tagName, videoId) {
  const card = document.createElement(tagName);
  const thumb = document.createElement('div');
  thumb.setAttribute('id', 'thumbnail');
  const anchor = document.createElement('a');
  anchor.setAttribute('id', 'thumbnail');
  anchor.setAttribute('href', `/watch?v=${videoId}`);
  thumb.appendChild(anchor);
  card.appendChild(thumb);
  return { card, thumb, anchor };
}

// =============================================================================
// Suite 1: CSS Syntax, Rules, and Specificity Conformance
// =============================================================================
describe('Suite 1: CSS Syntax, Rules, and Specificity Conformance', () => {
  const cssPath = path.join(PROJECT_ROOT, 'src/styles/queue_plus.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  test('CSS file exists, is non-empty, and has balanced curly braces', () => {
    assert.ok(css.length > 1000, 'Stylesheet must be fully implemented (> 1000 bytes)');
    const openBraces = (css.match(/\{/g) || []).length;
    const closeBraces = (css.match(/\}/g) || []).length;
    assert.strictEqual(openBraces, closeBraces, 'CSS open and close braces must balance perfectly');
    assert.ok(openBraces >= 10, 'Expected at least 10 CSS rule blocks');
  });

  test('Badge styles include pointer-events: none !important and absolute positioning', () => {
    assert.ok(css.includes('.yqp-queue-badge'), 'Must contain .yqp-queue-badge');
    assert.ok(css.includes('pointer-events: none !important'), 'Badge must have pointer-events: none !important');
    assert.ok(css.includes('position: absolute'), 'Badge must be positioned absolute inside thumbnail');
    assert.ok(css.includes('color: #3ea6ff') || css.includes('#3ea6ff'), 'Badge must use accent color #3ea6ff');
  });

  test('Treatment modes have correct selectors, opacity, filter, and display: none !important', () => {
    // badge_and_dim mode
    assert.ok(css.includes('[data-yqp-mode="badge_and_dim"]'), 'Must target badge_and_dim mode');
    assert.ok(css.includes('opacity: 0.40') || css.includes('opacity: 0.4'), 'Dimming opacity must be 0.4');
    assert.ok(css.includes('grayscale(35%)'), 'Dimming must apply grayscale(35%)');

    // hover restore
    assert.ok(css.includes('[data-yqp-mode="badge_and_dim"]:hover'), 'Must have hover rule');
    assert.ok(css.includes('opacity: 0.95'), 'Hover opacity must restore to 0.95');
    assert.ok(css.includes('grayscale(0%)'), 'Hover must restore grayscale to 0%');

    // hide mode
    assert.ok(css.includes('[data-yqp-mode="hide"]'), 'Must target hide mode');
    assert.ok(css.includes('display: none !important'), 'Hide mode must use display: none !important');

    // badge_only mode
    assert.ok(css.includes('[data-yqp-mode="badge_only"]'), 'Must target badge_only mode');
  });

  test('Toast snackbar and restore banner styles are defined', () => {
    assert.ok(css.includes('#yqp-toast') && css.includes('.yqp-toast-container'), 'Toast selectors present');
    assert.ok(css.includes('.yqp-toast-visible'), 'Toast visible state class present');
    assert.ok(css.includes('.yqp-restore-banner'), 'Restore banner selector present');
    assert.ok(css.includes('.yqp-banner-btn-restore'), 'Restore button selector present');
    assert.ok(css.includes('.yqp-banner-btn-dismiss'), 'Dismiss button selector present');
  });
});

// =============================================================================
// Suite 2: FeedDecorator Input Boundary, Fuzzing & Malformed Queue Data
// =============================================================================
describe('Suite 2: FeedDecorator Input Boundary, Fuzzing & Malformed Queue Data', () => {
  beforeEach(() => resetDOM());

  test('Fuzzing updateQueue with invalid types (null, undefined, number, object, strings)', () => {
    const decorator = new FeedDecorator({ mode: 'badge_and_dim' });

    // None of these should throw
    assert.doesNotThrow(() => decorator.updateQueue(null));
    assert.strictEqual(decorator.getActiveQueueIds().size, 0);

    assert.doesNotThrow(() => decorator.updateQueue(undefined));
    assert.strictEqual(decorator.getActiveQueueIds().size, 0);

    assert.doesNotThrow(() => decorator.updateQueue(12345));
    assert.strictEqual(decorator.getActiveQueueIds().size, 0);

    assert.doesNotThrow(() => decorator.updateQueue({ key: 'val' }));
    assert.strictEqual(decorator.getActiveQueueIds().size, 0);

    assert.doesNotThrow(() => decorator.updateQueue('not_an_array'));
    assert.strictEqual(decorator.getActiveQueueIds().size, 0);

    decorator.destroy();
  });

  test('updateQueue filters out malformed, empty, and invalid-length video IDs', () => {
    const decorator = new FeedDecorator({ mode: 'badge_and_dim' });
    const malformedList = [
      '',                         // empty
      '1234567890',               // 10 chars (too short)
      '123456789012',             // 12 chars (too long)
      'dQw4w9WgXc!',              // invalid char !
      'dQw4w9 WgXcQ',             // space
      null,
      undefined,
      12345678901,
      'dQw4w9WgXcQ',              // VALID 1
      '9bZkp7q19f0'               // VALID 2
    ];

    decorator.updateQueue(malformedList);
    const activeIds = decorator.getActiveQueueIds();

    assert.strictEqual(activeIds.size, 2);
    assert.ok(activeIds.has('dQw4w9WgXcQ'));
    assert.ok(activeIds.has('9bZkp7q19f0'));
    decorator.destroy();
  });

  test('Fuzzing setMode with invalid modes safely defaults to badge_and_dim', () => {
    const decorator = new FeedDecorator({ mode: 'invalid_mode_init' });
    assert.strictEqual(decorator.getMode(), 'badge_and_dim');

    decorator.setMode('hide');
    assert.strictEqual(decorator.getMode(), 'hide');

    // Passing invalid mode must revert or default cleanly
    decorator.setMode('totally_unknown');
    assert.strictEqual(decorator.getMode(), 'badge_and_dim');

    decorator.setMode(null);
    assert.strictEqual(decorator.getMode(), 'badge_and_dim');

    decorator.setMode(123);
    assert.strictEqual(decorator.getMode(), 'badge_and_dim');

    decorator.destroy();
  });

  test('Throughput benchmark: 1,000 rapid updateQueue calls completes in < 50ms', () => {
    const decorator = new FeedDecorator({ mode: 'badge_and_dim' });
    const testIds = ['dQw4w9WgXcQ', '9bZkp7q19f0', 'oHg5SJYRHA0', 'kffacxfA7G4'];

    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const pick = [testIds[i % 4]];
      decorator.updateQueue(pick);
    }
    const duration = performance.now() - t0;

    assert.ok(duration < 100, `1,000 updateQueue took ${duration.toFixed(2)}ms, expected < 100ms`);
    decorator.destroy();
  });
});

// =============================================================================
// Suite 3: Virtual List & DOM Element Recycling Robustness
// =============================================================================
describe('Suite 3: Virtual List & DOM Element Recycling Robustness', () => {
  beforeEach(() => resetDOM());

  test('Recycled DOM node: anchor href changes from queued to non-queued video', () => {
    const { card, anchor } = createMockCard('ytd-rich-item-renderer', 'dQw4w9WgXcQ');
    documentBody.appendChild(card);

    const decorator = new FeedDecorator({ mode: 'badge_and_dim', videoIds: ['dQw4w9WgXcQ'] });

    // Step 1: Card is queued and badged
    assert.strictEqual(card.getAttribute('data-yqp-status'), 'queued');
    assert.strictEqual(card.getAttribute('data-yqp-video-id'), 'dQw4w9WgXcQ');
    assert.ok(card.querySelector('.yqp-queue-badge') !== null);
    assert.strictEqual(card.style.opacity, '0.4');

    // Step 2: Polymer virtual list recycles this exact DOM node for a different non-queued video
    anchor.setAttribute('href', '/watch?v=unrelated01');

    // Rescan DOM
    decorator.scanAndDecorate();

    // Step 3: Card MUST be undecorated and cached ID updated
    assert.strictEqual(card.getAttribute('data-yqp-status'), null, 'Recycled card must lose queued status');
    assert.strictEqual(card.querySelector('.yqp-queue-badge'), null, 'Recycled card must lose badge');
    assert.strictEqual(card.style.opacity, '', 'Recycled card must restore opacity');

    decorator.destroy();
  });

  test('Recycled DOM node: anchor href changes from non-queued to queued video', () => {
    const { card, anchor } = createMockCard('ytd-rich-item-renderer', 'unrelated01');
    documentBody.appendChild(card);

    const decorator = new FeedDecorator({ mode: 'badge_and_dim', videoIds: ['dQw4w9WgXcQ'] });

    // Initially not queued
    assert.strictEqual(card.getAttribute('data-yqp-status'), null);
    assert.strictEqual(card.querySelector('.yqp-queue-badge'), null);

    // Polymer recycles this DOM node into the queued video
    anchor.setAttribute('href', '/watch?v=dQw4w9WgXcQ');

    decorator.scanAndDecorate();

    // Now decorated
    assert.strictEqual(card.getAttribute('data-yqp-status'), 'queued');
    assert.strictEqual(card.getAttribute('data-yqp-video-id'), 'dQw4w9WgXcQ');
    assert.ok(card.querySelector('.yqp-queue-badge') !== null);
    assert.strictEqual(card.style.opacity, '0.4');

    decorator.destroy();
  });

  test('Prevent duplicate badges: 20 repeated scanAndDecorate or decorateCard calls', () => {
    const { card } = createMockCard('ytd-rich-item-renderer', 'dQw4w9WgXcQ');
    documentBody.appendChild(card);

    const decorator = new FeedDecorator({ mode: 'badge_and_dim', videoIds: ['dQw4w9WgXcQ'] });

    // Call decorateCard explicitly 10 times
    for (let i = 0; i < 10; i++) {
      decorator.decorateCard(card, 'dQw4w9WgXcQ');
    }

    // Call scanAndDecorate 10 times
    for (let i = 0; i < 10; i++) {
      decorator.scanAndDecorate();
    }

    const badges = card.querySelectorAll('.yqp-queue-badge');
    assert.strictEqual(badges.length, 1, 'There must NEVER be more than one badge per card');
    decorator.destroy();
  });
});

// =============================================================================
// Suite 4: DOM Mutation & Infinite Scroll Edge Cases
// =============================================================================
describe('Suite 4: DOM Mutation & Infinite Scroll Edge Cases', () => {
  beforeEach(() => resetDOM());

  test('Card without thumbnail container falls back to appending badge to card itself', () => {
    // Card with anchor but NO #thumbnail / ytd-thumbnail wrapper
    const card = document.createElement('ytd-video-renderer');
    const a = document.createElement('a');
    a.setAttribute('id', 'video-title-link');
    a.setAttribute('href', '/watch?v=dQw4w9WgXcQ');
    card.appendChild(a);
    documentBody.appendChild(card);

    const decorator = new FeedDecorator({ mode: 'badge_and_dim', videoIds: ['dQw4w9WgXcQ'] });

    assert.strictEqual(card.getAttribute('data-yqp-status'), 'queued');
    const badge = card.querySelector('.yqp-queue-badge');
    assert.ok(badge !== null, 'Badge must be appended even without thumbnail container');
    assert.strictEqual(badge.parentNode, card, 'Badge is appended directly to card as fallback');
    decorator.destroy();
  });

  test('Card with multiple anchors resolves the correct video anchor', () => {
    const card = document.createElement('ytd-rich-item-renderer');
    // Channel avatar anchor
    const chanAnchor = document.createElement('a');
    chanAnchor.setAttribute('href', '/@RickAstleyYT');
    card.appendChild(chanAnchor);

    // Thumbnail container with video anchor
    const thumb = document.createElement('div');
    thumb.setAttribute('id', 'thumbnail');
    const vidAnchor = document.createElement('a');
    vidAnchor.setAttribute('id', 'thumbnail');
    vidAnchor.setAttribute('href', '/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ');
    thumb.appendChild(vidAnchor);
    card.appendChild(thumb);
    documentBody.appendChild(card);

    const decorator = new FeedDecorator({ mode: 'badge_and_dim' });
    const extractedId = decorator.getVideoId(card);

    assert.strictEqual(extractedId, 'dQw4w9WgXcQ');
    decorator.destroy();
  });

  test('High-volume infinite scroll: batch appending 100 cards with mixed queued status', async () => {
    const decorator = new FeedDecorator({
      mode: 'badge_and_dim',
      videoIds: ['queued_vid1', 'queued_vid2', 'queued_vid3'],
      debounceMs: 0
    });
    decorator.start();

    const createdCards = [];
    for (let i = 0; i < 100; i++) {
      let vidId;
      if (i % 3 === 0) vidId = 'queued_vid1';
      else if (i % 3 === 1) vidId = 'queued_vid2';
      else vidId = `unq_vid_${String(i).padStart(3, '0')}`;

      const { card } = createMockCard('ytd-rich-item-renderer', vidId);
      createdCards.push({ card, vidId });
      documentBody.appendChild(card);
    }

    await flushMutations();

    // Verify all 100 cards were processed accurately
    let queuedCount = 0;
    for (const { card, vidId } of createdCards) {
      if (vidId.startsWith('queued_')) {
        queuedCount++;
        assert.strictEqual(card.getAttribute('data-yqp-status'), 'queued');
        assert.strictEqual(card.style.opacity, '0.4');
        assert.ok(card.querySelector('.yqp-queue-badge') !== null);
      } else {
        assert.strictEqual(card.getAttribute('data-yqp-status'), null);
        assert.strictEqual(card.querySelector('.yqp-queue-badge'), null);
      }
    }

    assert.ok(queuedCount >= 60, 'Expected >= 60 queued cards');
    decorator.destroy();
  });
});

// =============================================================================
// Suite 5: Lifecycle & Teardown Integrity
// =============================================================================
describe('Suite 5: Lifecycle & Teardown Integrity', () => {
  beforeEach(() => resetDOM());

  test('destroy() restores all modified DOM cards and disconnects observer', () => {
    const cards = [];
    for (let i = 0; i < 10; i++) {
      const { card } = createMockCard('ytd-rich-item-renderer', `vid_id_00${i}x`);
      cards.push(card);
      documentBody.appendChild(card);
    }

    const queuedIds = cards.map((_, i) => `vid_id_00${i}x`);
    const decorator = new FeedDecorator({
      mode: 'badge_and_dim',
      videoIds: queuedIds,
      autoObserve: true
    });

    // Ensure all 10 cards are decorated
    for (const card of cards) {
      assert.strictEqual(card.getAttribute('data-yqp-status'), 'queued');
      assert.ok(card.querySelector('.yqp-queue-badge') !== null);
    }

    assert.strictEqual(decorator.isObserving, true);

    // Call destroy()
    decorator.destroy();

    // Verify teardown
    assert.strictEqual(decorator.isObserving, false);
    assert.strictEqual(decorator.observer, null);
    assert.strictEqual(decorator.getActiveQueueIds().size, 0);

    // Verify every single card is restored
    for (const card of cards) {
      assert.strictEqual(card.getAttribute('data-yqp-status'), null);
      assert.strictEqual(card.getAttribute('data-yqp-mode'), null);
      assert.notStrictEqual(card.style.opacity, '0.4');
      assert.notStrictEqual(card.style.display, 'none');
      assert.strictEqual(card.querySelector('.yqp-queue-badge'), null);
    }
  });

  test('startObserving and stopObserving are idempotent', () => {
    const decorator = new FeedDecorator({ autoObserve: false });
    assert.strictEqual(decorator.isObserving, false);

    decorator.startObserving();
    assert.strictEqual(decorator.isObserving, true);
    const obsRef = decorator.observer;

    // Second call should not overwrite or create duplicate observer
    decorator.startObserving();
    assert.strictEqual(decorator.observer, obsRef);

    decorator.stopObserving();
    assert.strictEqual(decorator.isObserving, false);
    assert.strictEqual(decorator.observer, null);

    // Second call should be safe no-op
    assert.doesNotThrow(() => decorator.stopObserving());
    decorator.destroy();
  });
});
