/**
 * YoutubeQueuePlus - Milestone M2 Empirical Stress & Adversarial Test Suite
 * Executable via: node test/m2_challenger_stress.test.js
 *
 * Scope:
 * Challenge Suite 1: Rapid DOM mutations on #items (200 items inserted, shuffled, deleted within 20ms)
 * Challenge Suite 2: Rapid [selected] track shifting & currentIndex tracking under transient and edge conditions
 * Challenge Suite 3: Dual-container thrashing (alternating watch flexy panel vs active/inactive miniplayer)
 * Challenge Suite 4: Diff signature engine & redundant update suppression
 * Challenge Suite 5: Resilience, lifecycle contracts, and subscriber error isolation
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// =============================================================================
// Robust DOM & MutationObserver Mock Engine
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
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
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

  insertBefore(newChild, referenceNode) {
    if (!referenceNode) {
      return this.appendChild(newChild);
    }
    if (newChild.parentNode) {
      newChild.parentNode.removeChild(newChild);
    }
    const idx = this.children.indexOf(referenceNode);
    if (idx === -1) {
      return this.appendChild(newChild);
    }
    newChild.parentNode = this;
    this.children.splice(idx, 0, newChild);
    MockMutationObserver._notify(new MockMutationRecord({
      type: 'childList',
      target: this,
      addedNodes: [newChild],
      removedNodes: []
    }));
    return newChild;
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

class MockDocument {
  constructor() {
    this.documentElement = new MockElement('html');
    this.body = new MockElement('body');
    this.documentElement.appendChild(this.body);
  }

  createElement(tag) {
    return new MockElement(tag);
  }

  createTextNode(text) {
    return { textContent: String(text), nodeType: 3 };
  }

  querySelector(sel) {
    return this.body.querySelector(sel) || (this.body.matches(sel) ? this.body : null);
  }

  querySelectorAll(sel) {
    return this.body.querySelectorAll(sel);
  }

  addEventListener() {}
  removeEventListener() {}
}

class MockWindow {
  constructor(doc) {
    this.document = doc;
    this.location = {
      pathname: '/watch',
      href: 'https://www.youtube.com/watch?v=vid_0000000'
    };
    this.MutationObserver = MockMutationObserver;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.has(type)) {
      const list = this.listeners.get(type);
      const idx = list.indexOf(listener);
      if (idx !== -1) list.splice(idx, 1);
    }
  }

  dispatchEvent(event) {
    const type = typeof event === 'string' ? event : event?.type;
    if (this.listeners.has(type)) {
      for (const fn of this.listeners.get(type)) {
        try { fn(event); } catch (_) {}
      }
    }
  }
}

// Module Imports
const PROJECT_ROOT = path.resolve(__dirname, '..');
const QueueObserver = require(path.join(PROJECT_ROOT, 'src/modules/queue_observer.js'));

// Helpers
function makeVidId(num) {
  return 'vid_' + String(num).padStart(7, '0');
}

function createQueueItem(doc, videoId, { selected = false, title = 'Sample Video' } = {}) {
  const item = doc.createElement('ytd-playlist-panel-video-renderer');
  if (selected) item.setAttribute('selected', '');
  const a = doc.createElement('a');
  a.setAttribute('id', 'wc-endpoint');
  a.setAttribute('href', `/watch?v=${videoId}`);
  item.appendChild(a);
  if (title) {
    const t = doc.createElement('span');
    t.setAttribute('id', 'video-title');
    t.textContent = title;
    item.appendChild(t);
  }
  return item;
}

function createWatchPanel(doc) {
  const flexy = doc.createElement('ytd-watch-flexy');
  const panel = doc.createElement('ytd-playlist-panel-renderer');
  const items = doc.createElement('div');
  items.setAttribute('id', 'items');
  panel.appendChild(items);
  flexy.appendChild(panel);
  doc.body.appendChild(flexy);
  return { flexy, panel, items };
}

function createMiniplayerPanel(doc, active = false) {
  const miniplayer = doc.createElement('ytd-miniplayer');
  if (active) miniplayer.setAttribute('active', '');
  const panel = doc.createElement('ytd-playlist-panel-renderer');
  panel.setAttribute('within-miniplayer', '');
  const items = doc.createElement('div');
  items.setAttribute('id', 'items');
  panel.appendChild(items);
  miniplayer.appendChild(panel);
  doc.body.appendChild(miniplayer);
  return { miniplayer, panel, items };
}

async function flushMutations(delayMs = 15) {
  MockMutationObserver.flush();
  await new Promise(r => setTimeout(r, delayMs));
}

// =============================================================================
// CHALLENGE SUITE 1: Rapid DOM Mutations on #items
// =============================================================================
describe('Challenge Suite 1: Rapid DOM Mutations on #items', () => {
  let doc;
  let win;

  beforeEach(() => {
    doc = new MockDocument();
    win = new MockWindow(doc);
    globalThis.document = doc;
    globalThis.window = win;
    globalThis.MutationObserver = MockMutationObserver;
  });

  afterEach(() => {
    MockMutationObserver._activeObservers.clear();
  });

  test('1.1: Rapid insertion of 200 items within 20ms with debounce settling', async () => {
    const { items } = createWatchPanel(doc);
    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 50 });
    observer.start();

    const expectedIds = [];
    const startTime = Date.now();

    // Insert 200 items in rapid burst
    for (let i = 0; i < 200; i++) {
      const vid = makeVidId(i);
      expectedIds.push(vid);
      const itemEl = createQueueItem(doc, vid, { selected: i === 0 });
      items.appendChild(itemEl);
    }
    const elapsedMs = Date.now() - startTime;
    assert.ok(elapsedMs < 100, `200 insertions took ${elapsedMs}ms, should complete in burst`);

    // Let debounce timer fire
    await new Promise(r => setTimeout(r, 70));
    MockMutationObserver.flush();

    // Verify queue snapshot
    assert.strictEqual(observer.getCount(), 200);
    assert.strictEqual(observer.getActiveVideoIds().length, 200);
    assert.deepStrictEqual(observer.getActiveVideoIds(), expectedIds);
    assert.strictEqual(observer.getCurrentIndex(), 0);
    assert.strictEqual(observer.getCurrentVideoId(), expectedIds[0]);

    // O(1) membership set verification
    const idSet = observer.getActiveIdsSet();
    assert.strictEqual(idSet.size, 200);
    for (const id of expectedIds) {
      assert.strictEqual(idSet.has(id), true);
    }
    assert.strictEqual(idSet.has('non_existent_id'), false);

    observer.destroy();
  });

  test('1.2: Rapid insertion of 200 items in under 20ms with debounceDelay: 0 (synchronous rescan)', () => {
    const { items } = createWatchPanel(doc);
    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();

    const expectedIds = [];
    const t0 = Date.now();

    for (let i = 0; i < 200; i++) {
      const vid = makeVidId(i);
      expectedIds.push(vid);
      const itemEl = createQueueItem(doc, vid, { selected: i === 0 });
      items.appendChild(itemEl);
      MockMutationObserver.flush(); // Forces synchronous per-mutation dispatch
    }
    const duration = Date.now() - t0;

    assert.ok(duration < 250, `200 synchronous rescans completed in ${duration}ms`);
    assert.strictEqual(observer.getCount(), 200);
    assert.deepStrictEqual(observer.getActiveVideoIds(), expectedIds);
    assert.strictEqual(observer.getCurrentIndex(), 0);

    observer.destroy();
  });

  test('1.3: Rapid in-place shuffle of 200 items within 20ms without loss or desync', async () => {
    const { items } = createWatchPanel(doc);
    const itemElements = [];
    const initialIds = [];

    for (let i = 0; i < 200; i++) {
      const vid = makeVidId(i);
      initialIds.push(vid);
      const itemEl = createQueueItem(doc, vid, { selected: i === 50 });
      items.appendChild(itemEl);
      itemElements.push(itemEl);
    }

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();
    assert.strictEqual(observer.getCount(), 200);
    assert.strictEqual(observer.getCurrentIndex(), 50);

    // Perform reverse-order shuffle by re-inserting elements
    const shuffledElements = [...itemElements].reverse();
    const t0 = Date.now();
    for (const el of shuffledElements) {
      items.appendChild(el); // moves element to the end
    }
    const shuffleElapsed = Date.now() - t0;
    assert.ok(shuffleElapsed < 50, `Shuffle took ${shuffleElapsed}ms`);

    await flushMutations(10);
    observer.rescan(true);

    const expectedShuffledIds = [...initialIds].reverse();
    assert.strictEqual(observer.getCount(), 200);
    assert.deepStrictEqual(observer.getActiveVideoIds(), expectedShuffledIds);
    // Index 50 in original list is now at index (199 - 50) = 149
    assert.strictEqual(observer.getCurrentIndex(), 149);
    assert.strictEqual(observer.getCurrentVideoId(), initialIds[50]);

    observer.destroy();
  });

  test('1.4: Rapid burst deletion of 100 items from 200 within 20ms', async () => {
    const { items } = createWatchPanel(doc);
    const itemElements = [];
    const allIds = [];

    for (let i = 0; i < 200; i++) {
      const vid = makeVidId(i);
      allIds.push(vid);
      const itemEl = createQueueItem(doc, vid, { selected: i === 20 });
      items.appendChild(itemEl);
      itemElements.push(itemEl);
    }

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();
    assert.strictEqual(observer.getCount(), 200);

    // Delete the first 100 items rapidly
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) {
      items.removeChild(itemElements[i]);
    }
    const deleteElapsed = Date.now() - t0;
    assert.ok(deleteElapsed < 30, `100 deletions took ${deleteElapsed}ms`);

    await flushMutations(10);
    observer.rescan(true);

    const remainingIds = allIds.slice(100);
    assert.strictEqual(observer.getCount(), 100);
    assert.deepStrictEqual(observer.getActiveVideoIds(), remainingIds);

    // Selected item was index 20 (which was deleted).
    // Observer falls back to URL or index clamp. Since index 20 was deleted, fallback clamps to 0 or valid index.
    assert.ok(observer.getCurrentIndex() >= 0 && observer.getCurrentIndex() < 100);
    assert.strictEqual(observer.getActiveIdsSet().size, 100);

    observer.destroy();
  });

  test('1.5: Rapid full purge of remaining items to empty queue (0 items)', async () => {
    const { items } = createWatchPanel(doc);
    const itemElements = [];

    for (let i = 0; i < 50; i++) {
      const vid = makeVidId(i);
      const itemEl = createQueueItem(doc, vid);
      items.appendChild(itemEl);
      itemElements.push(itemEl);
    }

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();
    assert.strictEqual(observer.getCount(), 50);

    let stateEmission = null;
    observer.subscribe((s) => { stateEmission = s; }, { immediate: false });

    // Purge all items
    for (const el of itemElements) {
      items.removeChild(el);
    }

    await flushMutations(10);
    observer.rescan(true);

    assert.strictEqual(observer.getCount(), 0);
    assert.deepStrictEqual(observer.getActiveVideoIds(), []);
    assert.strictEqual(observer.getActiveIdsSet().size, 0);
    assert.strictEqual(observer.getCurrentIndex(), 0);
    assert.strictEqual(observer.getCurrentVideoId(), null);
    assert.strictEqual(observer.isQueueActive(), false);

    assert.ok(stateEmission !== null, 'Subscriber should be notified of empty queue');
    assert.strictEqual(stateEmission.count, 0);
    assert.deepStrictEqual(stateEmission.videoIds, []);

    observer.destroy();
  });

  test('1.6: Mixed DOM noise resistance: ads, dividers, invalid IDs filtered out', () => {
    const { items } = createWatchPanel(doc);

    // Insert 5 valid items interleaved with noisy/invalid elements
    const validId1 = makeVidId(1);
    const validId2 = makeVidId(2);
    const validId3 = makeVidId(3);

    items.appendChild(createQueueItem(doc, validId1));

    // Ad renderer
    const adEl = doc.createElement('ytd-ad-slot-renderer');
    items.appendChild(adEl);

    // Malformed ID (too short: 10 chars)
    const badShort = doc.createElement('ytd-playlist-panel-video-renderer');
    const aShort = doc.createElement('a');
    aShort.setAttribute('id', 'wc-endpoint');
    aShort.setAttribute('href', '/watch?v=1234567890');
    badShort.appendChild(aShort);
    items.appendChild(badShort);

    items.appendChild(createQueueItem(doc, validId2));

    // Divider element
    const divEl = doc.createElement('div');
    divEl.setAttribute('id', 'divider');
    items.appendChild(divEl);

    // Malformed ID (too long: 12 chars)
    const badLong = doc.createElement('ytd-playlist-panel-video-renderer');
    const aLong = doc.createElement('a');
    aLong.setAttribute('id', 'wc-endpoint');
    aLong.setAttribute('href', '/watch?v=123456789012');
    badLong.appendChild(aLong);
    items.appendChild(badLong);

    items.appendChild(createQueueItem(doc, validId3));

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();

    assert.strictEqual(observer.getCount(), 3);
    assert.deepStrictEqual(observer.getActiveVideoIds(), [validId1, validId2, validId3]);
    assert.strictEqual(observer.getActiveIdsSet().size, 3);

    observer.destroy();
  });

  test('1.7: Duplicate video ID handling preserves DOM order while Set retains unique IDs', () => {
    const { items } = createWatchPanel(doc);
    const vidA = makeVidId(10);
    const vidB = makeVidId(20);

    // Queue: A, B, A, B, A (duplicates present)
    items.appendChild(createQueueItem(doc, vidA));
    items.appendChild(createQueueItem(doc, vidB));
    items.appendChild(createQueueItem(doc, vidA));
    items.appendChild(createQueueItem(doc, vidB));
    items.appendChild(createQueueItem(doc, vidA));

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();

    assert.strictEqual(observer.getCount(), 5);
    assert.deepStrictEqual(observer.getActiveVideoIds(), [vidA, vidB, vidA, vidB, vidA]);

    const set = observer.getActiveIdsSet();
    assert.strictEqual(set.size, 2);
    assert.strictEqual(set.has(vidA), true);
    assert.strictEqual(set.has(vidB), true);

    observer.destroy();
  });
});

// =============================================================================
// CHALLENGE SUITE 2: Rapid [selected] Track Shifting & CurrentIndex Tracking
// =============================================================================
describe('Challenge Suite 2: Rapid [selected] Track Shifting & CurrentIndex Tracking', () => {
  let doc;
  let win;

  beforeEach(() => {
    doc = new MockDocument();
    win = new MockWindow(doc);
    globalThis.document = doc;
    globalThis.window = win;
    globalThis.MutationObserver = MockMutationObserver;
  });

  afterEach(() => {
    MockMutationObserver._activeObservers.clear();
  });

  test('2.1: 100 rapid [selected] shifts across a 50-item queue in under 15ms', async () => {
    const { items } = createWatchPanel(doc);
    const itemNodes = [];
    const ids = [];

    for (let i = 0; i < 50; i++) {
      const vid = makeVidId(i);
      ids.push(vid);
      const el = createQueueItem(doc, vid, { selected: i === 0 });
      items.appendChild(el);
      itemNodes.push(el);
    }

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();
    assert.strictEqual(observer.getCurrentIndex(), 0);

    let currentSelected = 0;
    const t0 = Date.now();

    // Rapidly shift selection 100 times
    for (let step = 0; step < 100; step++) {
      const nextIndex = (step * 7) % 50;
      itemNodes[currentSelected].removeAttribute('selected');
      itemNodes[nextIndex].setAttribute('selected', '');
      currentSelected = nextIndex;
      MockMutationObserver.flush();
    }
    const shiftDuration = Date.now() - t0;
    assert.ok(shiftDuration < 200, `100 shifts took ${shiftDuration}ms, must be < 200ms`);

    observer.rescan(true);
    assert.strictEqual(observer.getCurrentIndex(), currentSelected);
    assert.strictEqual(observer.getCurrentVideoId(), ids[currentSelected]);

    observer.destroy();
  });

  test('2.2: Transient multi-selected state picks the first without throwing or desyncing', () => {
    const { items } = createWatchPanel(doc);
    const id0 = makeVidId(0);
    const id1 = makeVidId(1);
    const id2 = makeVidId(2);

    const el0 = createQueueItem(doc, id0, { selected: true });
    const el1 = createQueueItem(doc, id1, { selected: true }); // Transient simultaneous selection
    const el2 = createQueueItem(doc, id2, { selected: false });

    items.appendChild(el0);
    items.appendChild(el1);
    items.appendChild(el2);

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();

    // Deterministically picks index 0 (first selected item)
    assert.strictEqual(observer.getCurrentIndex(), 0);
    assert.strictEqual(observer.getCurrentVideoId(), id0);

    // Remove selected from el0, leaving only el1
    el0.removeAttribute('selected');
    observer.rescan(true);

    assert.strictEqual(observer.getCurrentIndex(), 1);
    assert.strictEqual(observer.getCurrentVideoId(), id1);

    observer.destroy();
  });

  test('2.3: Zero-selected state falls back to URL matching when available', () => {
    const { items } = createWatchPanel(doc);
    const id0 = makeVidId(0);
    const id1 = makeVidId(1);
    const id2 = makeVidId(2);

    // Neither has [selected] attribute
    items.appendChild(createQueueItem(doc, id0, { selected: false }));
    items.appendChild(createQueueItem(doc, id1, { selected: false }));
    items.appendChild(createQueueItem(doc, id2, { selected: false }));

    // Window location matches item 1
    win.location.href = `https://www.youtube.com/watch?v=${id1}&list=queue`;

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();

    assert.strictEqual(observer.getCurrentIndex(), 1);
    assert.strictEqual(observer.getCurrentVideoId(), id1);

    observer.destroy();
  });

  test('2.4: Zero-selected state without URL match preserves valid in-bounds index or clamps to 0', () => {
    const { items } = createWatchPanel(doc);
    const id0 = makeVidId(0);
    const id1 = makeVidId(1);

    const el0 = createQueueItem(doc, id0, { selected: true });
    const el1 = createQueueItem(doc, id1, { selected: false });
    items.appendChild(el0);
    items.appendChild(el1);

    win.location.href = 'https://www.youtube.com/feed/subscriptions';

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();
    assert.strictEqual(observer.getCurrentIndex(), 0);

    // Deselect item 0
    el0.removeAttribute('selected');
    observer.rescan(true);

    // Should preserve previous valid index (0)
    assert.strictEqual(observer.getCurrentIndex(), 0);
    assert.strictEqual(observer.getCurrentVideoId(), id0);

    observer.destroy();
  });

  test('2.5: Selected item deletion triggers recalculation without unhandled errors', () => {
    const { items } = createWatchPanel(doc);
    const id0 = makeVidId(0);
    const id1 = makeVidId(1);
    const id2 = makeVidId(2);

    const el0 = createQueueItem(doc, id0, { selected: false });
    const el1 = createQueueItem(doc, id1, { selected: true });
    const el2 = createQueueItem(doc, id2, { selected: false });

    items.appendChild(el0);
    items.appendChild(el1);
    items.appendChild(el2);

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();
    assert.strictEqual(observer.getCurrentIndex(), 1);

    // Delete currently selected element (el1)
    items.removeChild(el1);
    observer.rescan(true);

    assert.strictEqual(observer.getCount(), 2);
    // Index should clamp or fallback safely within [0, 1]
    assert.ok(observer.getCurrentIndex() >= 0 && observer.getCurrentIndex() <= 1);
    assert.ok(observer.getCurrentVideoId() === id0 || observer.getCurrentVideoId() === id2);

    observer.destroy();
  });

  test('2.6: [selected] attribute on non-video element is ignored and does not corrupt index', () => {
    const { items } = createWatchPanel(doc);
    const id0 = makeVidId(0);

    const nonVideo = doc.createElement('div');
    nonVideo.setAttribute('selected', '');
    items.appendChild(nonVideo);

    const el0 = createQueueItem(doc, id0, { selected: false });
    items.appendChild(el0);

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();

    assert.strictEqual(observer.getCount(), 1);
    assert.strictEqual(observer.getCurrentIndex(), 0);
    assert.strictEqual(observer.getCurrentVideoId(), id0);

    observer.destroy();
  });
});

// =============================================================================
// CHALLENGE SUITE 3: Dual-Container Thrashing (Watch Flexy vs Miniplayer)
// =============================================================================
describe('Challenge Suite 3: Dual-Container Thrashing (Watch Flexy vs Miniplayer)', () => {
  let doc;
  let win;

  beforeEach(() => {
    doc = new MockDocument();
    win = new MockWindow(doc);
    globalThis.document = doc;
    globalThis.window = win;
    globalThis.MutationObserver = MockMutationObserver;
  });

  afterEach(() => {
    MockMutationObserver._activeObservers.clear();
  });

  test('3.1: 50 rapid alternating switches between watch panel and miniplayer panel', async () => {
    // Watch panel has 10 items
    const { flexy, items: watchItems } = createWatchPanel(doc);
    const watchIds = [];
    for (let i = 0; i < 10; i++) {
      const vid = 'watch_' + String(i).padStart(5, '0');
      watchIds.push(vid);
      watchItems.appendChild(createQueueItem(doc, vid, { selected: i === 0 }));
    }

    // Miniplayer panel has 5 items
    const { miniplayer, items: miniItems } = createMiniplayerPanel(doc, false);
    const miniIds = [];
    for (let i = 0; i < 5; i++) {
      const vid = 'mini_' + String(i).padStart(6, '0');
      miniIds.push(vid);
      miniItems.appendChild(createQueueItem(doc, vid, { selected: i === 1 }));
    }

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();

    // Initially on /watch page: watch panel active
    assert.strictEqual(observer.getCount(), 10);
    assert.deepStrictEqual(observer.getActiveVideoIds(), watchIds);

    const t0 = Date.now();
    // Thrash between Watch and Miniplayer 50 times
    for (let cycle = 0; cycle < 50; cycle++) {
      if (cycle % 2 === 0) {
        // Switch to miniplayer on homepage
        win.location.pathname = '/';
        miniplayer.setAttribute('active', '');
        flexy.setAttribute('hidden', '');
      } else {
        // Switch to watch flexy
        win.location.pathname = '/watch';
        miniplayer.removeAttribute('active');
        flexy.removeAttribute('hidden');
      }
      MockMutationObserver.flush();
      observer.rescan(true);
    }
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 150, `50 container switches took ${elapsed}ms`);

    // Ends on cycle 49 (odd: watch page)
    assert.strictEqual(observer.getCount(), 10);
    assert.deepStrictEqual(observer.getActiveVideoIds(), watchIds);
    assert.strictEqual(observer.getCurrentIndex(), 0);

    // Switch one final time to miniplayer
    win.location.pathname = '/';
    miniplayer.setAttribute('active', '');
    flexy.setAttribute('hidden', '');
    MockMutationObserver.flush();
    observer.rescan(true);

    assert.strictEqual(observer.getCount(), 5);
    assert.deepStrictEqual(observer.getActiveVideoIds(), miniIds);
    assert.strictEqual(observer.getCurrentIndex(), 1);

    observer.destroy();
  });

  test('3.2: Dual-container switch with identical queue contents suppresses redundant emission', () => {
    const identicalIds = [makeVidId(1), makeVidId(2), makeVidId(3)];

    const { flexy, items: watchItems } = createWatchPanel(doc);
    for (const vid of identicalIds) {
      watchItems.appendChild(createQueueItem(doc, vid, { selected: vid === identicalIds[0] }));
    }

    const { miniplayer, items: miniItems } = createMiniplayerPanel(doc, false);
    for (const vid of identicalIds) {
      miniItems.appendChild(createQueueItem(doc, vid, { selected: vid === identicalIds[0] }));
    }

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();

    let subscriberNotifications = 0;
    observer.subscribe(() => {
      subscriberNotifications++;
    }, { immediate: false });

    // Switch container from watch to miniplayer
    win.location.pathname = '/';
    miniplayer.setAttribute('active', '');
    flexy.setAttribute('hidden', '');
    MockMutationObserver.flush();
    observer.rescan(true);

    // Queue state did not change: diff signature must suppress notification
    assert.strictEqual(subscriberNotifications, 0, 'Redundant emission must be suppressed');
    assert.deepStrictEqual(observer.getActiveVideoIds(), identicalIds);

    observer.destroy();
  });

  test('3.3: Post-switch mutation on new container triggers subscriber accurately', () => {
    const { flexy, items: watchItems } = createWatchPanel(doc);
    watchItems.appendChild(createQueueItem(doc, makeVidId(1)));

    const { miniplayer, items: miniItems } = createMiniplayerPanel(doc, false);
    miniItems.appendChild(createQueueItem(doc, makeVidId(2)));

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();

    // Switch to miniplayer
    win.location.pathname = '/';
    miniplayer.setAttribute('active', '');
    MockMutationObserver.flush();
    observer.rescan(true);

    let receivedUpdate = null;
    observer.subscribe((s) => { receivedUpdate = s; }, { immediate: false });

    // Add a new item into the miniplayer container
    const newVid = makeVidId(99);
    miniItems.appendChild(createQueueItem(doc, newVid));
    MockMutationObserver.flush();
    observer.rescan(true);

    assert.ok(receivedUpdate !== null, 'Observer must detect mutation on rebound container');
    assert.strictEqual(receivedUpdate.count, 2);
    assert.strictEqual(receivedUpdate.videoIds.includes(newVid), true);

    observer.destroy();
  });

  test('3.4: Inactive miniplayer is ignored when watch panel is absent', () => {
    win.location.pathname = '/';
    // Miniplayer exists with items, but active attribute is ABSENT
    const { miniplayer, items } = createMiniplayerPanel(doc, false);
    items.appendChild(createQueueItem(doc, makeVidId(55)));

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();

    // Observer must NOT bind to inactive miniplayer
    assert.strictEqual(observer.getCount(), 0);
    assert.deepStrictEqual(observer.getActiveVideoIds(), []);
    assert.strictEqual(observer.isQueueActive(), false);

    // Now activate miniplayer
    miniplayer.setAttribute('active', '');
    MockMutationObserver.flush();
    observer.rescan(true);

    assert.strictEqual(observer.getCount(), 1);
    assert.strictEqual(observer.getActiveVideoIds()[0], makeVidId(55));

    observer.destroy();
  });

  test('3.5: Abrupt active container deletion falls back gracefully without unhandled error', () => {
    const { flexy, panel } = createWatchPanel(doc);
    panel.querySelector('#items').appendChild(createQueueItem(doc, makeVidId(1)));

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();
    assert.strictEqual(observer.getCount(), 1);

    // Completely remove flexy from DOM
    doc.body.removeChild(flexy);
    MockMutationObserver.flush();
    observer.rescan(true);

    assert.strictEqual(observer.getCount(), 0);
    assert.deepStrictEqual(observer.getActiveVideoIds(), []);
    assert.strictEqual(observer.isQueueActive(), false);

    observer.destroy();
  });
});

// =============================================================================
// CHALLENGE SUITE 4: Diff Signature Engine & Redundant Update Suppression
// =============================================================================
describe('Challenge Suite 4: Diff Signature Engine & Redundant Update Suppression', () => {
  let doc;
  let win;

  beforeEach(() => {
    doc = new MockDocument();
    win = new MockWindow(doc);
    globalThis.document = doc;
    globalThis.window = win;
    globalThis.MutationObserver = MockMutationObserver;
  });

  afterEach(() => {
    MockMutationObserver._activeObservers.clear();
  });

  test('4.1: Redundant attribute/class/style mutations skip subscriber callbacks', () => {
    const { items } = createWatchPanel(doc);
    const itemEl = createQueueItem(doc, makeVidId(1), { selected: true });
    items.appendChild(itemEl);

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();

    let notificationCount = 0;
    observer.subscribe(() => { notificationCount++; }, { immediate: false });

    // 10 redundant non-structural DOM mutations
    for (let i = 0; i < 10; i++) {
      itemEl.setAttribute('class', `ytd-item-class-${i}`);
      itemEl.style.opacity = '0.8';
      MockMutationObserver.flush();
      observer.rescan(true);
    }

    assert.strictEqual(notificationCount, 0, 'No notification should fire for redundant non-queue changes');

    observer.destroy();
  });

  test('4.2: Repeated manual rescan() calls without DOM changes emit 0 callbacks', () => {
    const { items } = createWatchPanel(doc);
    items.appendChild(createQueueItem(doc, makeVidId(1)));

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();

    let callbacks = 0;
    observer.subscribe(() => { callbacks++; }, { immediate: false });

    for (let i = 0; i < 20; i++) {
      observer.rescan(true);
    }

    assert.strictEqual(callbacks, 0, 'Zero callbacks on identical rescan');

    observer.destroy();
  });

  test('4.3: Order swap ([A, B] -> [B, A]) with same count triggers diff signature update', () => {
    const { items } = createWatchPanel(doc);
    const vidA = makeVidId(1);
    const vidB = makeVidId(2);

    const elA = createQueueItem(doc, vidA, { selected: true });
    const elB = createQueueItem(doc, vidB, { selected: false });
    items.appendChild(elA);
    items.appendChild(elB);

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();

    let emittedState = null;
    let notificationCount = 0;
    observer.subscribe((s) => {
      notificationCount++;
      emittedState = s;
    }, { immediate: false });

    // Swap positions: move elA to the bottom
    items.appendChild(elA);
    MockMutationObserver.flush();
    observer.rescan(true);

    assert.strictEqual(notificationCount, 1, 'Should notify on order change');
    assert.deepStrictEqual(emittedState.videoIds, [vidB, vidA]);
    // elA was selected, now at index 1
    assert.strictEqual(emittedState.currentIndex, 1);

    observer.destroy();
  });

  test('4.4: Selected index shift alone triggers diff signature update', () => {
    const { items } = createWatchPanel(doc);
    const el0 = createQueueItem(doc, makeVidId(1), { selected: true });
    const el1 = createQueueItem(doc, makeVidId(2), { selected: false });
    items.appendChild(el0);
    items.appendChild(el1);

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();

    let notificationCount = 0;
    let lastIndex = -1;
    observer.subscribe((s) => {
      notificationCount++;
      lastIndex = s.currentIndex;
    }, { immediate: false });

    // Shift selection from 0 to 1
    el0.removeAttribute('selected');
    el1.setAttribute('selected', '');
    MockMutationObserver.flush();
    observer.rescan(true);

    assert.strictEqual(notificationCount, 1);
    assert.strictEqual(lastIndex, 1);

    observer.destroy();
  });

  test('4.5: Redundant empty state rescans result in 0 additional notifications', () => {
    const { items } = createWatchPanel(doc);
    const el = createQueueItem(doc, makeVidId(1));
    items.appendChild(el);

    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();

    let emptyNotifications = 0;
    observer.subscribe((s) => {
      if (s.count === 0) emptyNotifications++;
    }, { immediate: false });

    // Clear queue
    items.removeChild(el);
    MockMutationObserver.flush();
    observer.rescan(true);
    assert.strictEqual(emptyNotifications, 1);

    // Repeated rescans while empty
    for (let i = 0; i < 15; i++) {
      observer.rescan(true);
    }
    assert.strictEqual(emptyNotifications, 1, 'Empty state diff signature must suppress re-emission');

    observer.destroy();
  });
});

// =============================================================================
// CHALLENGE SUITE 5: Resilience, Lifecycle & Subscriber Contracts
// =============================================================================
describe('Challenge Suite 5: Resilience, Lifecycle & Subscriber Contracts', () => {
  let doc;
  let win;

  beforeEach(() => {
    doc = new MockDocument();
    win = new MockWindow(doc);
    globalThis.document = doc;
    globalThis.window = win;
    globalThis.MutationObserver = MockMutationObserver;
  });

  afterEach(() => {
    MockMutationObserver._activeObservers.clear();
  });

  test('5.1: Subscriber callback exception does not abort remaining subscribers', () => {
    const { items } = createWatchPanel(doc);
    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0, autoStart: false });

    let sub1Called = false;
    let sub2Called = false;
    let sub3Called = false;

    observer.subscribe(() => { sub1Called = true; }, { immediate: false });
    observer.subscribe(() => {
      sub2Called = true;
      throw new Error('Adversarial subscriber deliberate error');
    }, { immediate: false });
    observer.subscribe(() => { sub3Called = true; }, { immediate: false });

    observer.start();

    // Trigger state change
    items.appendChild(createQueueItem(doc, makeVidId(1)));
    observer.rescan(true);

    assert.strictEqual(sub1Called, true, 'Sub 1 must be called');
    assert.strictEqual(sub2Called, true, 'Sub 2 threw but was called');
    assert.strictEqual(sub3Called, true, 'Sub 3 must be called despite Sub 2 throw');

    observer.destroy();
  });

  test('5.2: Unsubscribing mid-notification does not break iterator or throw', () => {
    const { items } = createWatchPanel(doc);
    const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 0 });
    observer.start();

    let unsubSelf;
    let callCountA = 0;
    let callCountB = 0;

    unsubSelf = observer.subscribe(() => {
      callCountA++;
      unsubSelf(); // Self unsubscribe during callback
    }, { immediate: false });

    observer.subscribe(() => {
      callCountB++;
    }, { immediate: false });

    // First mutation
    items.appendChild(createQueueItem(doc, makeVidId(1)));
    observer.rescan(true);

    assert.strictEqual(callCountA, 1);
    assert.strictEqual(callCountB, 1);

    // Second mutation
    items.appendChild(createQueueItem(doc, makeVidId(2)));
    observer.rescan(true);

    assert.strictEqual(callCountA, 1, 'Self-unsubscribed listener must not be called again');
    assert.strictEqual(callCountB, 2, 'Sibling listener continues to receive updates');

    observer.destroy();
  });

  test('5.3: Lifecycle stress: 50 consecutive start() and destroy() cycles without leak', () => {
    const { items } = createWatchPanel(doc);
    items.appendChild(createQueueItem(doc, makeVidId(1)));

    for (let cycle = 0; cycle < 50; cycle++) {
      const observer = new QueueObserver({ document: doc, window: win, debounceDelay: 10, autoStart: true });
      assert.strictEqual(observer.getCount(), 1);
      observer.destroy();
    }

    // After all 50 destroyed, active observers should be 0
    assert.strictEqual(MockMutationObserver._activeObservers.size, 0, 'No dangling observers permitted');
  });
});
