/**
 * YoutubeQueuePlus - Milestone M2 Feed Decoration Verification Test Suite
 * Zero-dependency test harness using Node.js v24 native test runner.
 *
 * Verifies:
 * - Mock DOM environment with YouTube web components and MockMutationObserver
 * - QueueObserver ordered ID extraction, active index tracking, miniplayer fallback
 * - FeedDecorator badging, dimming (0.4), hiding (display: none), badge-only mode
 * - Dynamic queue additions, removals, mode switching, and infinite scroll observation
 * - End-to-end integration between QueueObserver, StorageSync, and FeedDecorator
 *
 * Executable via: node test/m2_feed_decoration.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// =============================================================================
// Lightweight DOM & MutationObserver Mock Engine
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

class MockChromeStorageArea {
  constructor() {
    this.store = new Map();
    this.changeListeners = [];
  }
  async get(keys) {
    if (keys === null || keys === undefined) {
      const all = {};
      for (const [k, v] of this.store.entries()) all[k] = JSON.parse(JSON.stringify(v));
      return all;
    }
    if (typeof keys === 'string') {
      return { [keys]: this.store.has(keys) ? JSON.parse(JSON.stringify(this.store.get(keys))) : undefined };
    }
    if (Array.isArray(keys)) {
      const res = {};
      for (const k of keys) res[k] = this.store.has(k) ? JSON.parse(JSON.stringify(this.store.get(k))) : undefined;
      return res;
    }
    if (typeof keys === 'object') {
      const res = {};
      for (const [k, def] of Object.entries(keys)) res[k] = this.store.has(k) ? JSON.parse(JSON.stringify(this.store.get(k))) : def;
      return res;
    }
    return {};
  }
  async set(items) {
    const changes = {};
    for (const [k, v] of Object.entries(items)) {
      const oldVal = this.store.has(k) ? JSON.parse(JSON.stringify(this.store.get(k))) : undefined;
      const newVal = JSON.parse(JSON.stringify(v));
      this.store.set(k, newVal);
      changes[k] = { oldValue: oldVal, newValue: newVal };
    }
    for (const fn of this.changeListeners) {
      try { fn(changes, 'local'); } catch (_) {}
    }
  }
  onChanged = {
    addListener: (fn) => this.changeListeners.push(fn),
    removeListener: (fn) => {
      const i = this.changeListeners.indexOf(fn);
      if (i !== -1) this.changeListeners.splice(i, 1);
    }
  };
}

// Setup Global DOM environment
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

// Helper: Flush async mutations
async function flushMutations(delayMs = 10) {
  MockMutationObserver.flush();
  await new Promise(r => setTimeout(r, delayMs));
}

// =============================================================================
// Subject Modules Import
// =============================================================================
const PROJECT_ROOT = path.resolve(__dirname, '..');
const Constants = require(path.join(PROJECT_ROOT, 'src/shared/constants.js'));
const StorageKeysModule = require(path.join(PROJECT_ROOT, 'src/shared/storage_keys.js'));
const DomHelpers = require(path.join(PROJECT_ROOT, 'src/utils/dom_helpers.js'));
const UrlParser = require(path.join(PROJECT_ROOT, 'src/utils/url_parser.js'));
const StorageSync = require(path.join(PROJECT_ROOT, 'src/modules/storage_sync.js'));
const QueueObserver = require(path.join(PROJECT_ROOT, 'src/modules/queue_observer.js'));
const FeedDecorator = require(path.join(PROJECT_ROOT, 'src/modules/feed_decorator.js'));

// Reset DOM body before each test
function resetDOM() {
  documentBody = new MockElement('body');
  documentRoot = new MockElement('html');
  documentRoot.appendChild(documentBody);
  globalThis.document.body = documentBody;
  globalThis.document.documentElement = documentRoot;
}

// =============================================================================
// Suite 1: Mock DOM & MutationObserver Verification
// =============================================================================
describe('Suite 1: Mock DOM & MutationObserver Environment', () => {
  beforeEach(() => resetDOM());

  test('MockElement supports YouTube custom elements, styles, classList, and attributes', () => {
    const el = document.createElement('ytd-rich-item-renderer');
    el.setAttribute('data-yqp-status', 'queued');
    el.classList.add('yqp-item');
    el.style.opacity = '0.4';

    assert.strictEqual(el.tagName, 'YTD-RICH-ITEM-RENDERER');
    assert.strictEqual(el.getAttribute('data-yqp-status'), 'queued');
    assert.strictEqual(el.classList.contains('yqp-item'), true);
    assert.strictEqual(el.style.opacity, '0.4');
  });

  test('Compound selector matching handles tags, IDs, classes, and attribute brackets', () => {
    const card = document.createElement('ytd-rich-item-renderer');
    const thumb = document.createElement('div');
    thumb.setAttribute('id', 'thumbnail');
    const anchor = document.createElement('a');
    anchor.setAttribute('id', 'thumbnail');
    anchor.setAttribute('href', '/watch?v=dQw4w9WgXcQ');
    thumb.appendChild(anchor);
    card.appendChild(thumb);
    documentBody.appendChild(card);

    assert.strictEqual(anchor.matches('a#thumbnail[href*="/watch?v="]'), true);
    assert.strictEqual(card.matches('ytd-rich-item-renderer'), true);
    assert.strictEqual(document.querySelector('ytd-rich-item-renderer a#thumbnail[href*="/watch?v="]'), anchor);
  });

  test('MockMutationObserver triggers on childList additions and attribute mutations', async () => {
    const container = document.createElement('div');
    documentBody.appendChild(container);

    let observedRecords = [];
    const observer = new MockMutationObserver((records) => {
      observedRecords.push(...records);
    });
    observer.observe(container, { childList: true, attributes: true });

    const child = document.createElement('span');
    container.appendChild(child);
    container.setAttribute('data-test', '123');

    await flushMutations();

    assert.strictEqual(observedRecords.length, 2);
    assert.strictEqual(observedRecords[0].type, 'childList');
    assert.strictEqual(observedRecords[0].addedNodes[0], child);
    assert.strictEqual(observedRecords[1].type, 'attributes');
    assert.strictEqual(observedRecords[1].attributeName, 'data-test');
    observer.disconnect();
  });
});

// =============================================================================
// Suite 2: QueueObserver Extraction & Index Tracking (Dispatch Tests 1 - 3)
// =============================================================================
describe('Suite 2: QueueObserver Extraction & Index Tracking', () => {
  beforeEach(() => resetDOM());

  test('Test 1: QueueObserver extracts ordered IDs from mock ytd-playlist-panel-renderer', () => {
    // Build Watch Page Queue Panel
    const panel = document.createElement('ytd-playlist-panel-renderer');
    const itemsContainer = document.createElement('div');
    itemsContainer.setAttribute('id', 'items');

    const vids = ['dQw4w9WgXcQ', '9bZkp7q19f0', 'oHg5SJYRHA0'];
    vids.forEach((id, idx) => {
      const item = document.createElement('ytd-playlist-panel-video-renderer');
      if (idx === 0) item.setAttribute('selected', '');
      const endpoint = document.createElement('a');
      endpoint.setAttribute('id', 'wc-endpoint');
      endpoint.setAttribute('href', `/watch?v=${id}&list=WL&index=${idx + 1}`);
      item.appendChild(endpoint);
      itemsContainer.appendChild(item);
    });
    panel.appendChild(itemsContainer);
    documentBody.appendChild(panel);

    const observer = new QueueObserver({ debounceDelay: 0 });
    observer.start();

    assert.deepStrictEqual(observer.getActiveVideoIds(), ['dQw4w9WgXcQ', '9bZkp7q19f0', 'oHg5SJYRHA0']);
    assert.strictEqual(observer.getCurrentIndex(), 0);

    const idSet = observer.getActiveIdsSet();
    assert.strictEqual(idSet.size, 3);
    assert.strictEqual(idSet.has('dQw4w9WgXcQ'), true);
    assert.strictEqual(idSet.has('9bZkp7q19f0'), true);
    assert.strictEqual(idSet.has('oHg5SJYRHA0'), true);
    assert.strictEqual(idSet.has('nonexistent1'), false);
    observer.destroy();
  });

  test('Test 2: QueueObserver tracks currentIndex when selected item moves', async () => {
    const panel = document.createElement('ytd-playlist-panel-renderer');
    const itemsContainer = document.createElement('div');
    itemsContainer.setAttribute('id', 'items');

    const itemNodes = ['dQw4w9WgXcQ', '9bZkp7q19f0', 'oHg5SJYRHA0'].map((id, idx) => {
      const item = document.createElement('ytd-playlist-panel-video-renderer');
      if (idx === 0) item.setAttribute('selected', '');
      const endpoint = document.createElement('a');
      endpoint.setAttribute('id', 'wc-endpoint');
      endpoint.setAttribute('href', `/watch?v=${id}`);
      item.appendChild(endpoint);
      itemsContainer.appendChild(item);
      return item;
    });
    panel.appendChild(itemsContainer);
    documentBody.appendChild(panel);

    const observer = new QueueObserver({ debounceDelay: 0 });
    observer.start();
    assert.strictEqual(observer.getCurrentIndex(), 0);

    // Move selected to item 1
    itemNodes[0].removeAttribute('selected');
    itemNodes[1].setAttribute('selected', '');
    await flushMutations();
    observer.rescan();

    assert.strictEqual(observer.getCurrentIndex(), 1);

    // Move selected to item 2
    itemNodes[1].removeAttribute('selected');
    itemNodes[2].setAttribute('selected', '');
    await flushMutations();
    observer.rescan();

    assert.strictEqual(observer.getCurrentIndex(), 2);
    observer.destroy();
  });

  test('Test 3: QueueObserver detects miniplayer queue when watch panel is absent', () => {
    // Floating miniplayer container
    const miniplayer = document.createElement('ytd-miniplayer');
    miniplayer.setAttribute('active', '');

    const panel = document.createElement('ytd-playlist-panel-renderer');
    panel.setAttribute('within-miniplayer', '');
    const itemsContainer = document.createElement('div');
    itemsContainer.setAttribute('id', 'items');

    const item1 = document.createElement('ytd-playlist-panel-video-renderer');
    const a1 = document.createElement('a');
    a1.setAttribute('id', 'thumbnail');
    a1.setAttribute('href', '/watch?v=kffacxfA7G4');
    item1.appendChild(a1);

    const item2 = document.createElement('ytd-playlist-panel-video-renderer');
    item2.setAttribute('selected', '');
    const a2 = document.createElement('a');
    a2.setAttribute('id', 'thumbnail');
    a2.setAttribute('href', '/watch?v=fJ9rUzIMcZQ');
    item2.appendChild(a2);

    itemsContainer.appendChild(item1);
    itemsContainer.appendChild(item2);
    panel.appendChild(itemsContainer);
    miniplayer.appendChild(panel);
    documentBody.appendChild(miniplayer);

    const observer = new QueueObserver({ debounceDelay: 0 });
    observer.start();

    assert.deepStrictEqual(observer.getActiveVideoIds(), ['kffacxfA7G4', 'fJ9rUzIMcZQ']);
    assert.strictEqual(observer.getCurrentIndex(), 1);
    assert.strictEqual(observer.getActiveIdsSet().has('fJ9rUzIMcZQ'), true);

    // Miniplayer closed -> active attribute removed
    miniplayer.removeAttribute('active');
    observer.rescan();

    assert.deepStrictEqual(observer.getActiveVideoIds(), []);
    assert.strictEqual(observer.getCurrentIndex(), 0);
    assert.strictEqual(observer.getActiveIdsSet().size, 0);
    observer.destroy();
  });

  test('QueueObserver subscription contract delivers state updates', () => {
    const panel = document.createElement('ytd-playlist-panel-renderer');
    const items = document.createElement('div');
    items.setAttribute('id', 'items');
    panel.appendChild(items);
    documentBody.appendChild(panel);

    const observer = new QueueObserver({ debounceDelay: 0 });
    let emitted = null;
    const unsub = observer.subscribe((state) => {
      emitted = state;
    });

    assert.ok(emitted !== null);
    assert.deepStrictEqual(emitted.videoIds, []);
    assert.strictEqual(emitted.count, 0);

    unsub();
    observer.destroy();
  });
});

// =============================================================================
// Suite 3: FeedDecorator Badging, Modes & Dynamic Updates (Dispatch Tests 4 - 10)
// =============================================================================
describe('Suite 3: FeedDecorator Badging, Modes & Dynamic Updates', () => {
  let cardA, cardB, cardC;

  beforeEach(() => {
    resetDOM();
    const contents = document.createElement('div');
    contents.setAttribute('id', 'contents');

    // Card A: dQw4w9WgXcQ (rich item)
    cardA = document.createElement('ytd-rich-item-renderer');
    const thumbA = document.createElement('div');
    thumbA.setAttribute('id', 'thumbnail');
    const aA = document.createElement('a');
    aA.setAttribute('id', 'thumbnail');
    aA.setAttribute('href', '/watch?v=dQw4w9WgXcQ');
    thumbA.appendChild(aA);
    cardA.appendChild(thumbA);
    contents.appendChild(cardA);

    // Card B: 9bZkp7q19f0 (rich item)
    cardB = document.createElement('ytd-rich-item-renderer');
    const thumbB = document.createElement('div');
    thumbB.setAttribute('id', 'thumbnail');
    const aB = document.createElement('a');
    aB.setAttribute('id', 'thumbnail');
    aB.setAttribute('href', '/watch?v=9bZkp7q19f0');
    thumbB.appendChild(aB);
    cardB.appendChild(thumbB);
    contents.appendChild(cardB);

    // Card C: oHg5SJYRHA0 (video renderer)
    cardC = document.createElement('ytd-video-renderer');
    const thumbC = document.createElement('div');
    thumbC.setAttribute('id', 'thumbnail');
    const aC = document.createElement('a');
    aC.setAttribute('id', 'thumbnail');
    aC.setAttribute('href', '/watch?v=oHg5SJYRHA0');
    thumbC.appendChild(aC);
    cardC.appendChild(thumbC);
    contents.appendChild(cardC);

    documentBody.appendChild(contents);
  });

  test('Test 4: FeedDecorator applies badge and dimmed opacity (0.4) in badge_and_dim mode', () => {
    const decorator = new FeedDecorator({ mode: 'badge_and_dim' });
    decorator.updateQueue(['9bZkp7q19f0']);

    // Card B should be badged and dimmed
    assert.strictEqual(cardB.getAttribute('data-yqp-status'), 'queued');
    assert.strictEqual(cardB.getAttribute('data-yqp-mode'), 'badge_and_dim');
    assert.strictEqual(cardB.getAttribute('data-yqp-video-id'), '9bZkp7q19f0');
    assert.strictEqual(cardB.style.opacity, '0.4');
    assert.notStrictEqual(cardB.style.display, 'none');

    const badge = cardB.querySelector('.yqp-queue-badge');
    assert.ok(badge !== null, 'Card B must contain .yqp-queue-badge element');
    assert.strictEqual(badge.textContent, 'QUEUED');

    // Cards A and C should remain untagged
    assert.strictEqual(cardA.getAttribute('data-yqp-status'), null);
    assert.strictEqual(cardA.querySelector('.yqp-queue-badge'), null);
    assert.notStrictEqual(cardA.style.opacity, '0.4');

    assert.strictEqual(cardC.getAttribute('data-yqp-status'), null);
    assert.strictEqual(cardC.querySelector('.yqp-queue-badge'), null);
    decorator.destroy();
  });

  test('Test 5: FeedDecorator applies display: none in hide mode', () => {
    const decorator = new FeedDecorator({ mode: 'hide' });
    decorator.updateQueue(['9bZkp7q19f0']);

    // Card B should be hidden
    assert.strictEqual(cardB.getAttribute('data-yqp-status'), 'queued');
    assert.strictEqual(cardB.getAttribute('data-yqp-mode'), 'hide');
    assert.strictEqual(cardB.style.display, 'none');

    // Cards A and C remain visible
    assert.notStrictEqual(cardA.style.display, 'none');
    assert.notStrictEqual(cardC.style.display, 'none');
    decorator.destroy();
  });

  test('Test 6: FeedDecorator applies badge with full opacity in badge_only mode', () => {
    const decorator = new FeedDecorator({ mode: 'badge_only' });
    decorator.updateQueue(['9bZkp7q19f0']);

    // Card B badged with full opacity
    assert.strictEqual(cardB.getAttribute('data-yqp-status'), 'queued');
    assert.strictEqual(cardB.getAttribute('data-yqp-mode'), 'badge_only');
    assert.ok(cardB.querySelector('.yqp-queue-badge') !== null);
    assert.notStrictEqual(cardB.style.opacity, '0.4');
    assert.notStrictEqual(cardB.style.display, 'none');
    decorator.destroy();
  });

  test('Test 7: Dynamic queue update decorates newly added card without reload', () => {
    const decorator = new FeedDecorator({ mode: 'badge_and_dim' });
    decorator.updateQueue(['dQw4w9WgXcQ']);

    assert.ok(cardA.querySelector('.yqp-queue-badge') !== null);
    assert.strictEqual(cardC.querySelector('.yqp-queue-badge'), null);

    // New item added to queue
    decorator.updateQueue(['dQw4w9WgXcQ', 'oHg5SJYRHA0']);

    assert.ok(cardA.querySelector('.yqp-queue-badge') !== null);
    assert.ok(cardC.querySelector('.yqp-queue-badge') !== null);
    assert.strictEqual(cardC.getAttribute('data-yqp-status'), 'queued');
    assert.strictEqual(cardC.style.opacity, '0.4');
    assert.strictEqual(cardB.querySelector('.yqp-queue-badge'), null);
    decorator.destroy();
  });

  test('Test 8: Dynamic queue update removes badge and restores opacity when item is removed', () => {
    const decorator = new FeedDecorator({ mode: 'badge_and_dim' });
    decorator.updateQueue(['dQw4w9WgXcQ', 'oHg5SJYRHA0']);

    assert.ok(cardA.querySelector('.yqp-queue-badge') !== null);
    assert.ok(cardC.querySelector('.yqp-queue-badge') !== null);

    // Remove Card C from queue
    decorator.updateQueue(['dQw4w9WgXcQ']);

    assert.ok(cardA.querySelector('.yqp-queue-badge') !== null);
    assert.strictEqual(cardC.querySelector('.yqp-queue-badge'), null, 'Badge must be removed');
    assert.strictEqual(cardC.getAttribute('data-yqp-status'), null, 'data-yqp-status must be removed');
    assert.strictEqual(cardC.getAttribute('data-yqp-mode'), null, 'data-yqp-mode must be removed');
    assert.notStrictEqual(cardC.style.opacity, '0.4', 'Opacity must be restored');
    assert.notStrictEqual(cardC.style.display, 'none', 'Display must be visible');
    decorator.destroy();
  });

  test('Test 9: Mode change updates all existing card attributes dynamically', () => {
    const decorator = new FeedDecorator({ mode: 'badge_and_dim' });
    decorator.updateQueue(['dQw4w9WgXcQ', '9bZkp7q19f0']);

    assert.strictEqual(cardA.getAttribute('data-yqp-mode'), 'badge_and_dim');
    assert.strictEqual(cardA.style.opacity, '0.4');

    // Switch to hide
    decorator.setMode('hide');
    assert.strictEqual(cardA.getAttribute('data-yqp-mode'), 'hide');
    assert.strictEqual(cardB.getAttribute('data-yqp-mode'), 'hide');
    assert.strictEqual(cardA.style.display, 'none');
    assert.strictEqual(cardB.style.display, 'none');

    // Switch to badge_only
    decorator.setMode('badge_only');
    assert.strictEqual(cardA.getAttribute('data-yqp-mode'), 'badge_only');
    assert.strictEqual(cardB.getAttribute('data-yqp-mode'), 'badge_only');
    assert.notStrictEqual(cardA.style.display, 'none');
    assert.notStrictEqual(cardA.style.opacity, '0.4');
    assert.ok(cardA.querySelector('.yqp-queue-badge') !== null);

    // Switch back to badge_and_dim
    decorator.setMode('badge_and_dim');
    assert.strictEqual(cardA.getAttribute('data-yqp-mode'), 'badge_and_dim');
    assert.strictEqual(cardA.style.opacity, '0.4');
    decorator.destroy();
  });

  test('Test 10: Infinite scroll simulation: newly appended cards are automatically decorated', async () => {
    const decorator = new FeedDecorator({ mode: 'badge_and_dim' });
    decorator.updateQueue(['kffacxfA7G4']);
    decorator.start(); // Starts observing #contents / documentBody

    const contents = document.querySelector('#contents');
    const newCard = document.createElement('ytd-rich-item-renderer');
    const thumbNew = document.createElement('div');
    thumbNew.setAttribute('id', 'thumbnail');
    const aNew = document.createElement('a');
    aNew.setAttribute('id', 'thumbnail');
    aNew.setAttribute('href', '/watch?v=kffacxfA7G4');
    thumbNew.appendChild(aNew);
    newCard.appendChild(thumbNew);

    // Infinite scroll appends new card
    contents.appendChild(newCard);
    await flushMutations();

    assert.strictEqual(newCard.getAttribute('data-yqp-status'), 'queued');
    assert.ok(newCard.querySelector('.yqp-queue-badge') !== null);
    assert.strictEqual(newCard.style.opacity, '0.4');
    decorator.destroy();
  });
});

// =============================================================================
// Suite 4: End-to-End Reactive Integration Architecture (Tests 11 - 13)
// =============================================================================
describe('Suite 4: End-to-End Reactive Integration Architecture', () => {
  beforeEach(() => resetDOM());

  test('Test 11: Local Reactive Pipeline (QueueObserver -> StorageSync -> FeedDecorator)', async () => {
    const storageArea = new MockChromeStorageArea();
    const storageSync = new StorageSync({ debounceDelay: 50, storageArea });

    const queueObserver = new QueueObserver({ debounceDelay: 0 });
    const feedDecorator = new FeedDecorator({ mode: 'badge_and_dim' });

    // Setup feed card
    const contents = document.createElement('div');
    contents.setAttribute('id', 'contents');
    const card = document.createElement('ytd-rich-item-renderer');
    const thumb = document.createElement('div');
    thumb.setAttribute('id', 'thumbnail');
    const a = document.createElement('a');
    a.setAttribute('id', 'thumbnail');
    a.setAttribute('href', '/watch?v=dQw4w9WgXcQ');
    thumb.appendChild(a);
    card.appendChild(thumb);
    contents.appendChild(card);
    documentBody.appendChild(contents);

    // Wire local reactive pipeline
    queueObserver.subscribe((state) => {
      storageSync.saveActiveQueue(state);
      feedDecorator.updateQueue(state.videoIds);
    });

    // Mount Watch Panel and insert video item
    const panel = document.createElement('ytd-playlist-panel-renderer');
    const items = document.createElement('div');
    items.setAttribute('id', 'items');
    const qItem = document.createElement('ytd-playlist-panel-video-renderer');
    const qAnchor = document.createElement('a');
    qAnchor.setAttribute('id', 'wc-endpoint');
    qAnchor.setAttribute('href', '/watch?v=dQw4w9WgXcQ');
    qItem.appendChild(qAnchor);
    items.appendChild(qItem);
    panel.appendChild(items);
    documentBody.appendChild(panel);

    queueObserver.start();
    await storageSync.flush();

    // Verify FeedDecorator decorated the card
    assert.strictEqual(card.getAttribute('data-yqp-status'), 'queued');
    assert.ok(card.querySelector('.yqp-queue-badge') !== null);

    // Verify StorageSync persisted active queue snapshot
    const saved = await storageArea.get(StorageKeysModule.STORAGE_KEYS.ACTIVE_QUEUE);
    assert.deepStrictEqual(saved[StorageKeysModule.STORAGE_KEYS.ACTIVE_QUEUE].videoIds, ['dQw4w9WgXcQ']);

    queueObserver.destroy();
    feedDecorator.destroy();
  });

  test('Test 12: Cross-Tab Storage Pipeline (StorageSync -> FeedDecorator)', async () => {
    const storageArea = new MockChromeStorageArea();
    const storageSync = new StorageSync({ storageArea, storageOnChanged: storageArea.onChanged });
    const feedDecorator = new FeedDecorator({ mode: 'badge_and_dim' });

    // Feed card in Tab 1
    const card = document.createElement('ytd-rich-item-renderer');
    const thumb = document.createElement('div');
    thumb.setAttribute('id', 'thumbnail');
    const a = document.createElement('a');
    a.setAttribute('id', 'thumbnail');
    a.setAttribute('href', '/watch?v=9bZkp7q19f0');
    thumb.appendChild(a);
    card.appendChild(thumb);
    documentBody.appendChild(card);

    // StorageSync cross-tab subscriber
    storageSync.subscribe('queue', (queueState) => {
      feedDecorator.updateQueue(queueState.videoIds);
    });

    // Simulate Tab 2 updating queue in chrome.storage.local
    await storageArea.set({
      [StorageKeysModule.STORAGE_KEYS.ACTIVE_QUEUE]: {
        videoIds: ['9bZkp7q19f0'],
        currentIndex: 0,
        count: 1,
        lastUpdated: Date.now()
      }
    });

    // FeedDecorator in Tab 1 should now be badged
    assert.strictEqual(card.getAttribute('data-yqp-status'), 'queued');
    assert.ok(card.querySelector('.yqp-queue-badge') !== null);
    feedDecorator.destroy();
  });

  test('Test 13: Popup Preference Sync Pipeline (StorageSync -> FeedDecorator)', async () => {
    const storageArea = new MockChromeStorageArea();
    const storageSync = new StorageSync({ storageArea, storageOnChanged: storageArea.onChanged });
    const feedDecorator = new FeedDecorator({ mode: 'badge_and_dim' });
    feedDecorator.updateQueue(['dQw4w9WgXcQ']);

    const card = document.createElement('ytd-rich-item-renderer');
    const thumb = document.createElement('div');
    thumb.setAttribute('id', 'thumbnail');
    const a = document.createElement('a');
    a.setAttribute('id', 'thumbnail');
    a.setAttribute('href', '/watch?v=dQw4w9WgXcQ');
    thumb.appendChild(a);
    card.appendChild(thumb);
    documentBody.appendChild(card);
    feedDecorator.updateQueue(['dQw4w9WgXcQ']);

    assert.strictEqual(card.getAttribute('data-yqp-mode'), 'badge_and_dim');

    // Subscribe to preferences
    storageSync.subscribe('preferences', (prefs) => {
      feedDecorator.setMode(prefs.feedTreatmentMode);
    });

    // Simulate popup changing mode to 'hide'
    await storageArea.set({
      [StorageKeysModule.STORAGE_KEYS.PREFERENCES]: {
        feedTreatmentMode: 'hide',
        duplicateGuardEnabled: true,
        showRestoreBanner: true
      }
    });

    assert.strictEqual(card.getAttribute('data-yqp-mode'), 'hide');
    assert.strictEqual(card.style.display, 'none');
    feedDecorator.destroy();
  });
});
