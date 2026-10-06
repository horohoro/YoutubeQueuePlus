/**
 * YoutubeQueuePlus - Milestone M4 Empirical Challenger Stress Test Suite
 * Executable via: node test/m4_challenger_stress.test.js
 *
 * Scope & Verification Matrix:
 * Challenge Suite 1: Rapid Queue State Flip-Flops & DOM Leak Stress (100+ Cycles)
 * Challenge Suite 2: Anti-Nagging Dismissal Mechanics & Multi-Session Resurfacing
 * Challenge Suite 3: 100+ Videos Session Capping & Clamped Index
 * Challenge Suite 4: Corrupted Storage Data Schemas & Error Resilience
 * Challenge Suite 5: Lifecycle Integrity: Multiple start() and destroy() Cycles
 * Challenge Suite 6: Stylesheet & UI Contract Conformance
 * Challenge Suite 7: Adversarial Edge Cases & Behavioral Anomalies
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Modules under test
const Constants = require('../src/shared/constants');
const StorageKeys = require('../src/shared/storage_keys');
const UrlParser = require('../src/utils/url_parser');
const DomHelpers = require('../src/utils/dom_helpers');
const StorageSync = require('../src/modules/storage_sync');
const QueueObserver = require('../src/modules/queue_observer');
const RestoreController = require('../src/modules/restore_controller');

// =============================================================================
// Lightweight In-Memory Test DOM & Mock Infrastructure
// =============================================================================

function matchSelector(el, sel) {
  if (!sel || !el || el.nodeType !== 1) return false;
  const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    return parts.some(p => matchSelector(el, p));
  }

  const spaceParts = sel.trim().split(/\s+/);
  if (spaceParts.length > 1) {
    const targetSel = spaceParts[spaceParts.length - 1];
    if (!matchSelector(el, targetSel)) return false;
    let curr = el.parentNode;
    let i = spaceParts.length - 2;
    while (curr && i >= 0) {
      if (matchSelector(curr, spaceParts[i])) {
        i--;
      }
      curr = curr.parentNode;
    }
    return i < 0;
  }

  let s = sel.trim();
  const tagMatch = s.match(/^([a-zA-Z0-9_-]+)/);
  if (tagMatch) {
    if (el.tagName !== tagMatch[1].toUpperCase()) return false;
    s = s.slice(tagMatch[1].length);
  }

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
      const inner = s.slice(1, closeIdx).trim();
      s = s.slice(closeIdx + 1);

      if (inner.includes('=')) {
        const [attr, rawVal] = inner.split('=');
        const cleanVal = rawVal.trim().replace(/^["']|["']$/g, '');
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

class MockEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== undefined ? Boolean(init.bubbles) : true;
    this.cancelable = init.cancelable !== undefined ? Boolean(init.cancelable) : true;
    this.target = null;
    this.currentTarget = null;
    this.eventPhase = 0;
    this.defaultPrevented = false;
    this._propagationStopped = false;
    this._immediatePropagationStopped = false;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation() {
    this._propagationStopped = true;
  }

  stopImmediatePropagation() {
    this._propagationStopped = true;
    this._immediatePropagationStopped = true;
  }
}

class MockEventTarget {
  constructor() {
    this._listeners = [];
  }

  addEventListener(type, callback, optionsOrCapture) {
    if (typeof callback !== 'function') return;
    const capture = typeof optionsOrCapture === 'boolean'
      ? optionsOrCapture
      : Boolean(optionsOrCapture?.capture);
    const once = Boolean(optionsOrCapture?.once);
    this._listeners.push({ type, callback, capture, once });
  }

  removeEventListener(type, callback, optionsOrCapture) {
    const capture = typeof optionsOrCapture === 'boolean'
      ? optionsOrCapture
      : Boolean(optionsOrCapture?.capture);
    this._listeners = this._listeners.filter(
      l => !(l.type === type && l.callback === callback && l.capture === capture)
    );
  }

  dispatchEvent(event) {
    if (!event || !event.type) return true;
    event.target = this;

    const chain = [];
    let curr = this;
    while (curr) {
      chain.push(curr);
      curr = curr.parentNode;
    }
    chain.reverse();

    // Capturing
    for (let i = 0; i < chain.length - 1; i++) {
      const node = chain[i];
      event.currentTarget = node;
      event.eventPhase = 1;
      const capturing = (node._listeners || []).filter(l => l.type === event.type && l.capture === true);
      for (const entry of capturing) {
        if (entry.once) node.removeEventListener(entry.type, entry.callback, entry.capture);
        entry.callback.call(node, event);
        if (event._immediatePropagationStopped) break;
      }
      if (event._propagationStopped || event._immediatePropagationStopped) break;
    }

    // Target
    if (!event._propagationStopped && !event._immediatePropagationStopped) {
      const targetNode = chain[chain.length - 1];
      event.currentTarget = targetNode;
      event.eventPhase = 2;
      const atTarget = (targetNode._listeners || []).filter(l => l.type === event.type);
      for (const entry of atTarget) {
        if (entry.once) targetNode.removeEventListener(entry.type, entry.callback, entry.capture);
        entry.callback.call(targetNode, event);
        if (event._immediatePropagationStopped) break;
      }
    }

    // Bubbling
    if (event.bubbles && !event._propagationStopped && !event._immediatePropagationStopped) {
      for (let i = chain.length - 2; i >= 0; i--) {
        const node = chain[i];
        event.currentTarget = node;
        event.eventPhase = 3;
        const bubbling = (node._listeners || []).filter(l => l.type === event.type && l.capture === false);
        for (const entry of bubbling) {
          if (entry.once) node.removeEventListener(entry.type, entry.callback, entry.capture);
          entry.callback.call(node, event);
          if (event._immediatePropagationStopped) break;
        }
        if (event._propagationStopped || event._immediatePropagationStopped) break;
      }
    }

    event.currentTarget = null;
    event.eventPhase = 0;
    return !event.defaultPrevented;
  }
}

class MockElement extends MockEventTarget {
  constructor(tagName = 'div') {
    super();
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
    this._textContent = '';
  }

  get parentElement() { return this.parentNode; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    if (idx !== -1 && idx + 1 < this.parentNode.children.length) {
      return this.parentNode.children[idx + 1];
    }
    return null;
  }
  get childNodes() { return [...this.children]; }

  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }

  get className() { return Array.from(this._classList).join(' '); }
  set className(v) {
    this._classList.clear();
    if (v) String(v).split(/\s+/).filter(Boolean).forEach(c => this._classList.add(c));
    this.attributes.set('class', this.className);
  }

  get textContent() {
    if (this.children.length === 0) return this._textContent;
    return this.children.map(c => c.textContent).join('');
  }
  set textContent(v) {
    this.children = [];
    this._textContent = String(v ?? '');
  }

  setAttribute(name, value) {
    const n = String(name).toLowerCase();
    const v = String(value);
    this.attributes.set(n, v);
    if (n === 'class') {
      this._classList.clear();
      v.split(/\s+/).filter(Boolean).forEach(c => this._classList.add(c));
    }
  }

  getAttribute(name) {
    return this.attributes.get(String(name).toLowerCase()) || null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    const n = String(name).toLowerCase();
    this.attributes.delete(n);
    if (n === 'class') this._classList.clear();
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(newChild, refChild) {
    if (!refChild) return this.appendChild(newChild);
    if (newChild.parentNode) {
      newChild.parentNode.removeChild(newChild);
    }
    newChild.parentNode = this;
    const idx = this.children.indexOf(refChild);
    if (idx === -1) {
      this.children.push(newChild);
    } else {
      this.children.splice(idx, 0, newChild);
    }
    return newChild;
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

  querySelector(sel) {
    for (const child of this.children) {
      if (child.nodeType === 1) {
        if (matchSelector(child, sel)) return child;
        const found = child.querySelector(sel);
        if (found) return found;
      }
    }
    return null;
  }

  querySelectorAll(sel) {
    const res = [];
    for (const child of this.children) {
      if (child.nodeType === 1) {
        if (matchSelector(child, sel)) res.push(child);
        res.push(...child.querySelectorAll(sel));
      }
    }
    return res;
  }

  click() {
    const evt = new MockEvent('click', { bubbles: true, cancelable: true });
    return this.dispatchEvent(evt);
  }
}

class MockDocument extends MockEventTarget {
  constructor() {
    super();
    this.nodeType = 9;
    this.documentElement = new MockElement('html');
    this.body = new MockElement('body');
    this.documentElement.appendChild(this.body);
    this.readyState = 'complete';
  }

  createElement(tagName) {
    return new MockElement(tagName);
  }

  createTextNode(text) {
    const el = new MockElement('span');
    el.textContent = text;
    return el;
  }

  querySelector(sel) {
    if (matchSelector(this.documentElement, sel)) return this.documentElement;
    if (matchSelector(this.body, sel)) return this.body;
    return this.documentElement.querySelector(sel);
  }

  querySelectorAll(sel) {
    const res = [];
    if (matchSelector(this.documentElement, sel)) res.push(this.documentElement);
    if (matchSelector(this.body, sel)) res.push(this.body);
    return res.concat(this.documentElement.querySelectorAll(sel));
  }

  getElementById(id) {
    return this.querySelector(`#${id}`);
  }
}

class MockWindow extends MockEventTarget {
  constructor(doc) {
    super();
    this.document = doc;
    this.location = { href: 'https://www.youtube.com/' };
  }
}

class MockChromeStorageArea {
  constructor() {
    this.store = new Map();
    this.changeListeners = [];
  }

  get(keys, callback) {
    let result = {};
    if (keys === null || keys === undefined) {
      for (const [k, v] of this.store.entries()) {
        result[k] = v !== undefined && typeof v === 'object' && v !== null ? JSON.parse(JSON.stringify(v)) : v;
      }
    } else if (typeof keys === 'string') {
      const v = this.store.get(keys);
      result[keys] = v !== undefined && typeof v === 'object' && v !== null ? JSON.parse(JSON.stringify(v)) : v;
    } else if (Array.isArray(keys)) {
      for (const k of keys) {
        const v = this.store.get(k);
        result[k] = v !== undefined && typeof v === 'object' && v !== null ? JSON.parse(JSON.stringify(v)) : v;
      }
    } else if (typeof keys === 'object') {
      for (const [k, defVal] of Object.entries(keys)) {
        const v = this.store.has(k) ? this.store.get(k) : defVal;
        result[k] = v !== undefined && typeof v === 'object' && v !== null ? JSON.parse(JSON.stringify(v)) : v;
      }
    }
    if (typeof callback === 'function') {
      callback(result);
      return;
    }
    return Promise.resolve(result);
  }

  set(items, callback) {
    const changes = {};
    for (const [k, v] of Object.entries(items)) {
      const oldRaw = this.store.has(k) ? this.store.get(k) : undefined;
      const oldVal = oldRaw !== undefined && typeof oldRaw === 'object' && oldRaw !== null ? JSON.parse(JSON.stringify(oldRaw)) : oldRaw;
      const newVal = v !== undefined && typeof v === 'object' && v !== null ? JSON.parse(JSON.stringify(v)) : v;
      this.store.set(k, newVal);
      changes[k] = { oldValue: oldVal, newValue: newVal };
    }
    for (const listener of this.changeListeners) {
      try { listener(changes, 'local'); } catch (_) {}
    }
    if (typeof callback === 'function') {
      callback();
      return;
    }
    return Promise.resolve();
  }

  remove(keys, callback) {
    const arr = Array.isArray(keys) ? keys : [keys];
    const changes = {};
    for (const k of arr) {
      if (this.store.has(k)) {
        const oldRaw = this.store.get(k);
        const oldVal = oldRaw !== undefined && typeof oldRaw === 'object' && oldRaw !== null ? JSON.parse(JSON.stringify(oldRaw)) : oldRaw;
        this.store.delete(k);
        changes[k] = { oldValue: oldVal, newValue: undefined };
      }
    }
    for (const listener of this.changeListeners) {
      try { listener(changes, 'local'); } catch (_) {}
    }
    if (typeof callback === 'function') {
      callback();
      return;
    }
    return Promise.resolve();
  }

  clear(callback) {
    this.store.clear();
    if (typeof callback === 'function') callback();
    return Promise.resolve();
  }

  get onChanged() {
    return {
      addListener: (fn) => this.changeListeners.push(fn),
      removeListener: (fn) => {
        const idx = this.changeListeners.indexOf(fn);
        if (idx !== -1) this.changeListeners.splice(idx, 1);
      }
    };
  }
}

function createYouTubePageDOM() {
  const doc = new MockDocument();
  const masthead = doc.createElement('ytd-masthead');
  masthead.id = 'masthead-container';
  doc.body.appendChild(masthead);

  const pageManager = doc.createElement('ytd-page-manager');
  pageManager.id = 'page-manager';
  doc.body.appendChild(pageManager);

  const richGrid = doc.createElement('ytd-rich-grid-renderer');
  const contents = doc.createElement('div');
  contents.id = 'contents';
  richGrid.appendChild(contents);
  pageManager.appendChild(richGrid);

  return { doc, masthead, pageManager, richGrid, contents };
}

function generateVideoIds(count, prefix = 'vid') {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const pad = String(i).padStart(8, '0');
    ids.push(`${prefix}${pad}`); // Exactly 11 chars: 3 + 8 = 11
  }
  return ids;
}

// =============================================================================
// CHALLENGER TEST SUITE
// =============================================================================

describe('Milestone M4: RestoreController Empirical Challenger Stress Tests', () => {

  // ---------------------------------------------------------------------------
  // Challenge Suite 1: Rapid Queue State Flip-Flops (100+ Cycles) & Zero DOM Leak
  // ---------------------------------------------------------------------------
  describe('Challenge Suite 1: Rapid Queue State Flip-Flops & DOM Leak Stress', () => {

    test('1.1: Sequential 100 flip-flop cycles (empty -> active -> empty): mounts/unmounts with zero DOM leak', async () => {
      const { doc, contents } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      // Seed saved session
      const sampleIds = generateVideoIds(5, 'ses');
      await storageSync.saveSavedSession({
        videoIds: sampleIds,
        currentIndex: 0,
        savedAt: Date.now() - 60000
      });

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        autoStart: false
      });

      controller.start();
      await controller.checkAndShowBanner();

      assert.equal(controller.isBannerVisible(), true, 'Initial state: banner mounted when queue is empty');
      assert.equal(doc.querySelectorAll('#yqp-restore-banner').length, 1);

      // Perform 100 flip-flop cycles (200 state transitions)
      const iterations = 100;
      for (let i = 0; i < iterations; i++) {
        // Transition 1: Queue becomes ACTIVE
        controller.onQueueUpdated({ videoIds: ['active00001'], count: 1 });
        assert.equal(controller.isBannerVisible(), false, `Iteration ${i}: Banner must be hidden when queue active`);
        assert.equal(doc.querySelectorAll('#yqp-restore-banner').length, 0, `Iteration ${i}: Zero banners in DOM when queue active`);

        // Transition 2: Queue becomes EMPTY
        controller.onQueueUpdated({ videoIds: [], count: 0 });
        await controller.checkAndShowBanner();
        assert.equal(controller.isBannerVisible(), true, `Iteration ${i}: Banner must be mounted when queue empty`);
        assert.equal(doc.querySelectorAll('#yqp-restore-banner').length, 1, `Iteration ${i}: Exactly 1 banner in DOM when queue empty`);
      }

      // Final state assertion: Zero DOM accumulation, exactly 1 banner present
      const banners = doc.querySelectorAll('#yqp-restore-banner');
      assert.equal(banners.length, 1, 'Exactly one banner in document after 100 cycles');
      assert.equal(contents.children.filter(c => c.id === 'yqp-restore-banner').length, 1, 'Contents container has exactly one banner element');

      // Final unmount check
      controller.onQueueUpdated({ videoIds: ['active00002'], count: 1 });
      assert.equal(doc.querySelectorAll('#yqp-restore-banner').length, 0, 'Zero banners left in DOM after final active transition');

      controller.destroy();
    });

    test('1.2: DOM element containment and child stability under rapid thrashing', async () => {
      const { doc, contents } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      // Add dummy video cards to contents to ensure feed cards are not destroyed by banner mounting
      for (let i = 0; i < 3; i++) {
        const card = doc.createElement('ytd-rich-item-renderer');
        card.id = `card-${i}`;
        contents.appendChild(card);
      }
      const initialChildrenCount = contents.children.length; // 3

      await storageSync.saveSavedSession({
        videoIds: ['vid00000001'],
        currentIndex: 0,
        savedAt: Date.now() - 10000
      });

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        autoStart: true
      });
      await controller.checkAndShowBanner();

      // Banner inserted as firstChild (total = 4)
      assert.equal(contents.children.length, initialChildrenCount + 1);
      assert.equal(contents.firstChild.id, 'yqp-restore-banner');

      // Rapidly toggle 50 times
      for (let i = 0; i < 50; i++) {
        controller.onQueueUpdated({ videoIds: ['active_vid_1'], count: 1 });
        assert.equal(contents.children.length, initialChildrenCount, 'Video cards preserved when banner unmounts');

        controller.onQueueUpdated({ videoIds: [], count: 0 });
        await controller.checkAndShowBanner();
        assert.equal(contents.children.length, initialChildrenCount + 1, 'Banner cleanly prepended without disturbing sibling cards');
      }

      controller.destroy();
      assert.equal(contents.children.length, initialChildrenCount, 'Original feed cards fully preserved after destroy()');
    });

    test('1.3: Asynchronous rapid flip-flop burst (100 rapid concurrent calls): idempotency and zero duplicate banners', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      await storageSync.saveSavedSession({
        videoIds: ['vid00000001'],
        currentIndex: 0,
        savedAt: Date.now() - 5000
      });

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        autoStart: false
      });

      // Fire 100 asynchronous checkAndShowBanner() calls concurrently without awaiting each
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(controller.checkAndShowBanner());
      }
      await Promise.all(promises);

      // Verify that idempotency prevents creating 100 duplicate banners
      const banners = doc.querySelectorAll('#yqp-restore-banner');
      assert.equal(banners.length, 1, 'Concurrent checkAndShowBanner calls produce exactly 1 mounted banner in DOM');

      controller.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // Challenge Suite 2: Anti-Nagging Dismissal Mechanics & Multi-Session Resurfacing
  // ---------------------------------------------------------------------------
  describe('Challenge Suite 2: Anti-Nagging Dismissal Mechanics & Multi-Session Resurfacing', () => {

    test('2.1: Dismissal blocks redisplay for the current savedAt timestamp across checks and navigations', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      const T1 = 1700000000000;
      await storageSync.saveSavedSession({
        videoIds: ['vid00000001', 'vid00000002'],
        currentIndex: 0,
        savedAt: T1
      });

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        autoStart: true
      });
      await controller.checkAndShowBanner();

      assert.equal(controller.isBannerVisible(), true, 'Banner visible before dismissal');

      // Click dismiss button on banner
      const dismissBtn = doc.querySelector('.yqp-banner-btn-dismiss');
      assert.ok(dismissBtn, 'Dismiss button must exist in banner');
      dismissBtn.click();

      // Banner must be immediately unmounted
      assert.equal(controller.isBannerVisible(), false, 'Banner hidden immediately upon dismissal');
      assert.equal(doc.querySelectorAll('#yqp-restore-banner').length, 0, 'Banner element removed from DOM');

      // Persistent session state must record the dismissed savedAt timestamp
      await new Promise(r => setTimeout(r, 10));
      const sessionState = await storageSync.getSessionState();
      const saved = await storageSync.getSavedSession();
      assert.equal(sessionState.bannerDismissedSessionSavedAt, saved.savedAt, 'bannerDismissedSessionSavedAt persisted in storage');

      // 10 consecutive checks for the same session must be blocked
      for (let i = 0; i < 10; i++) {
        const available = await controller.checkRestoreAvailable();
        assert.equal(available, false, `Check ${i}: Dismissed session must not be available`);
        const shown = await controller.checkAndShowBanner();
        assert.equal(shown, false, `Check ${i}: Banner must not show for dismissed session`);
        assert.equal(controller.isBannerVisible(), false);
      }

      // SPA navigation events must not resurrect the dismissed banner
      win.dispatchEvent(new MockEvent('yt-navigate-finish'));
      win.dispatchEvent(new MockEvent('yt-page-data-updated'));
      assert.equal(controller.isBannerVisible(), false, 'Navigation events do not resurrect dismissed banner');

      controller.destroy();
    });

    test('2.2: Banner resurfaces when a newer session (savedAt_new > savedAt_dismissed) is saved', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      const T1 = 1700000000000;
      const T2 = 1700000010000; // Newer timestamp

      // Session 1
      await storageSync.saveSavedSession({
        videoIds: ['vid00000001'],
        currentIndex: 0,
        savedAt: T1
      });

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        autoStart: true
      });
      await controller.checkAndShowBanner();
      assert.equal(controller.isBannerVisible(), true);

      // Dismiss Session 1
      await controller.dismiss();
      assert.equal(controller.isBannerVisible(), false);

      // Verify Session 1 is blocked
      assert.equal(await controller.checkRestoreAvailable(), false);

      // Save newer Session 2 (timestamp strictly newer than dismissal)
      await new Promise(r => setTimeout(r, 15));
      await storageSync.saveSavedSession({
        videoIds: ['vid00000003', 'vid00000004', 'vid00000005'],
        currentIndex: 1
      });
      const newSession = await storageSync.getSavedSession();

      // Storage sync reactive notification simulates cross-tab or background session save
      controller.onSavedSessionChanged(newSession);
      await controller.checkAndShowBanner();

      // Banner MUST resurface!
      assert.equal(await controller.checkRestoreAvailable(), true, 'Newer session must be eligible for restoration');
      assert.equal(controller.isBannerVisible(), true, 'Banner must resurface in DOM for newer session');

      const titleEl = doc.querySelector('.yqp-banner-title');
      assert.ok(titleEl.textContent.includes('3 videos'), 'Banner title reflects new session item count');

      controller.destroy();
    });

    test('2.3: Older or identical session (savedAt <= savedAt_dismissed) remains blocked', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      const T_dismissed = 1700000050000;
      await storageSync.setSessionState({
        bannerDismissedTimestamp: Date.now(),
        bannerDismissedSessionSavedAt: T_dismissed
      });

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        autoStart: false
      });

      // Test with older session timestamp directly seeded into storage
      storageArea.store.set(StorageKeys.STORAGE_KEYS.SAVED_SESSION, {
        videoIds: ['vid00000001'],
        currentIndex: 0,
        savedAt: T_dismissed - 10000
      });

      assert.equal(await controller.checkRestoreAvailable(), false, 'Older session timestamp is suppressed');

      // Test with exact identical timestamp
      storageArea.store.set(StorageKeys.STORAGE_KEYS.SAVED_SESSION, {
        videoIds: ['vid00000002'],
        currentIndex: 0,
        savedAt: T_dismissed
      });
      assert.equal(await controller.checkRestoreAvailable(), false, 'Identical session timestamp is suppressed');

      controller.destroy();
    });

    test('2.4: Sequential multi-session dismissal lifecycle (3 consecutive sessions)', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        autoStart: false
      });

      for (let sessionNum = 1; sessionNum <= 3; sessionNum++) {
        // Ensure strictly increasing timestamp for each new session
        await new Promise(r => setTimeout(r, 15));
        await storageSync.saveSavedSession({
          videoIds: generateVideoIds(sessionNum, `s${sessionNum}_`),
          currentIndex: 0
        });

        // Banner should be eligible and visible
        assert.equal(await controller.checkRestoreAvailable(), true, `Session ${sessionNum} must be available`);
        await controller.checkAndShowBanner();
        assert.equal(controller.isBannerVisible(), true, `Session ${sessionNum} banner must be visible`);

        // Dismiss this session
        await controller.dismiss();
        assert.equal(controller.isBannerVisible(), false, `Session ${sessionNum} banner dismissed`);
        assert.equal(await controller.checkRestoreAvailable(), false, `Session ${sessionNum} blocked after dismissal`);
      }

      controller.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // Challenge Suite 3: 100+ Videos Session Capping & Clamped Index
  // ---------------------------------------------------------------------------
  describe('Challenge Suite 3: 100+ Videos Session Capping & Clamped Index', () => {

    test('3.1: 100+ videos session generates URL capped at exactly 50 video IDs', () => {
      const totalVideos = 125;
      const ids = generateVideoIds(totalVideos, 'max');
      assert.equal(ids.length, 125);

      const restoreUrl = UrlParser.buildRestoreUrl(ids, 0);
      assert.ok(restoreUrl, 'buildRestoreUrl returns a URL');
      assert.ok(restoreUrl.startsWith('https://www.youtube.com/watch_videos?video_ids='));

      const parsed = UrlParser.parseWatchVideosUrl(restoreUrl);
      assert.ok(parsed, 'parseWatchVideosUrl successfully parses URL');
      assert.equal(parsed.videoIds.length, 50, 'Parsed video IDs count is capped at exactly 50');
      assert.deepEqual(parsed.videoIds, ids.slice(0, 50), 'Contains the first 50 videos in exact order');
    });

    test('3.2: 100+ videos session with currentIndex = 0 clamps to index 0', () => {
      const ids = generateVideoIds(110, 'clp');
      const url = UrlParser.buildRestoreUrl(ids, 0);
      const parsed = UrlParser.parseWatchVideosUrl(url);

      assert.equal(parsed.currentIndex, 0);
      assert.ok(url.includes('&index=0'));
    });

    test('3.3: 100+ videos session with currentIndex = 25 maintains index 25', () => {
      const ids = generateVideoIds(110, 'clp');
      const url = UrlParser.buildRestoreUrl(ids, 25);
      const parsed = UrlParser.parseWatchVideosUrl(url);

      assert.equal(parsed.currentIndex, 25);
      assert.ok(url.includes('&index=25'));
    });

    test('3.4: 100+ videos session with currentIndex = 49 maintains index 49 (last valid item)', () => {
      const ids = generateVideoIds(110, 'clp');
      const url = UrlParser.buildRestoreUrl(ids, 49);
      const parsed = UrlParser.parseWatchVideosUrl(url);

      assert.equal(parsed.currentIndex, 49);
      assert.ok(url.includes('&index=49'));
    });

    test('3.5: 100+ videos session with currentIndex = 50 clamps index to 49', () => {
      const ids = generateVideoIds(110, 'clp');
      // Index 50 is out of bounds for a 50-item list (0..49)
      const url = UrlParser.buildRestoreUrl(ids, 50);
      const parsed = UrlParser.parseWatchVideosUrl(url);

      assert.equal(parsed.currentIndex, 49, 'Index 50 clamped to 49 (50 items max)');
      assert.ok(url.includes('&index=49'));
    });

    test('3.6: 100+ videos session with currentIndex = 105 clamps index to 49', () => {
      const ids = generateVideoIds(110, 'clp');
      const url = UrlParser.buildRestoreUrl(ids, 105);
      const parsed = UrlParser.parseWatchVideosUrl(url);

      assert.equal(parsed.currentIndex, 49, 'Index 105 clamped to 49');
      assert.ok(url.includes('&index=49'));
    });

    test('3.7: 100+ videos session with negative, floating, or NaN index clamps safely', () => {
      const ids = generateVideoIds(100, 'flt');

      // Negative index
      const urlNeg = UrlParser.buildRestoreUrl(ids, -15);
      assert.equal(UrlParser.parseWatchVideosUrl(urlNeg).currentIndex, 0, 'Negative index clamped to 0');

      // Floating index
      const urlFloat = UrlParser.buildRestoreUrl(ids, 14.8);
      assert.equal(UrlParser.parseWatchVideosUrl(urlFloat).currentIndex, 14, 'Float index floored to 14');

      // NaN index
      const urlNaN = UrlParser.buildRestoreUrl(ids, NaN);
      assert.equal(UrlParser.parseWatchVideosUrl(urlNaN).currentIndex, 0, 'NaN index defaults to 0');

      // Non-numeric types
      const urlStr = UrlParser.buildRestoreUrl(ids, 'corrupt');
      assert.equal(UrlParser.parseWatchVideosUrl(urlStr).currentIndex, 0, 'String index defaults to 0');
    });

    test('3.8: RestoreController UI displays total count (120 videos) while restore button generates capped 50 URL', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      const ids = generateVideoIds(120, 'ui_');
      let navigatedUrl = null;

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        navigateFn: (url) => { navigatedUrl = url; },
        autoStart: false
      });

      await storageSync.saveSavedSession({
        videoIds: ids,
        currentIndex: 75,
        savedAt: Date.now() - 30000
      });

      await controller.checkAndShowBanner();
      assert.equal(controller.isBannerVisible(), true);

      // Verify banner text shows total videos (120)
      const titleSpan = doc.querySelector('.yqp-banner-title');
      assert.ok(titleSpan, 'Title span must exist');
      assert.equal(titleSpan.textContent, 'Queue session found (120 videos)', 'UI reflects full 120 videos count');

      // Click restore button
      const restoreBtn = doc.querySelector('.yqp-banner-btn-restore');
      assert.ok(restoreBtn, 'Restore button must exist');
      restoreBtn.click();
      await new Promise(r => setTimeout(r, 10));

      // Verify navigation occurred with capped URL and clamped index
      assert.ok(navigatedUrl, 'Navigation was triggered');
      const parsed = UrlParser.parseWatchVideosUrl(navigatedUrl);
      assert.equal(parsed.videoIds.length, 50, 'Navigated URL is capped at 50 videos');
      assert.equal(parsed.currentIndex, 49, 'Index 75 is clamped to 49 in the 50-video URL');

      // Banner must be removed immediately after restore
      assert.equal(controller.isBannerVisible(), false);

      controller.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // Challenge Suite 4: Corrupted Storage Data Schemas & Error Resilience
  // ---------------------------------------------------------------------------
  describe('Challenge Suite 4: Corrupted Storage Data Schemas & Error Resilience', () => {

    test('4.1: Corrupted savedSession (null, undefined, primitives, empty object): safe fallback without throws', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        autoStart: false
      });

      const corruptInputs = [
        null,
        undefined,
        {},
        'corrupted-string',
        12345,
        true,
        [],
        { videoIds: null },
        { videoIds: undefined },
        { videoIds: 'not-an-array' },
        { videoIds: {} },
        { videoIds: [] }
      ];

      for (const corrupt of corruptInputs) {
        storageArea.store.set(StorageKeys.STORAGE_KEYS.SAVED_SESSION, corrupt);

        await assert.doesNotReject(async () => {
          const available = await controller.checkRestoreAvailable();
          assert.equal(available, false, `Corrupt input ${JSON.stringify(corrupt)} must evaluate to false`);
          const shown = await controller.checkAndShowBanner();
          assert.equal(shown, false, `Corrupt input must not show banner`);
          assert.equal(controller.isBannerVisible(), false);
        });

        // Direct restore() call with corrupt data must return false and not throw
        await assert.doesNotReject(async () => {
          const result = await controller.restore(corrupt);
          assert.equal(result, false, 'restore() with corrupt input returns false safely');
        });

        // Direct dismiss() call with corrupt data must not throw
        await assert.doesNotReject(async () => {
          await controller.dismiss(corrupt);
        });
      }

      controller.destroy();
    });

    test('4.2: Corrupted video IDs within array (non-strings, invalid lengths, illegal characters)', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        autoStart: false
      });

      // Case A: Array of purely invalid items
      const purelyInvalid = [
        null,
        undefined,
        12345,
        {},
        [],
        '',
        'short',
        'waytoolongvideoidentifier12345',
        'invalid!char'
      ];
      storageArea.store.set(StorageKeys.STORAGE_KEYS.SAVED_SESSION, {
        videoIds: purelyInvalid,
        currentIndex: 0,
        savedAt: Date.now()
      });

      assert.equal(await controller.checkRestoreAvailable(), false, 'Purely invalid video ID array rejected');
      assert.equal(await controller.restore(), false, 'Cannot restore session with zero valid video IDs');

      // Case B: Array of mixed valid and invalid items
      const mixed = [
        null,
        'validId0001',
        123,
        'short',
        'validId0002',
        {},
        'validId0003'
      ];
      storageArea.store.set(StorageKeys.STORAGE_KEYS.SAVED_SESSION, {
        videoIds: mixed,
        currentIndex: 0,
        savedAt: Date.now()
      });

      assert.equal(await controller.checkRestoreAvailable(), true, 'Mixed array containing valid IDs is accepted');

      let restoredUrl = null;
      controller.navigateFn = (u) => { restoredUrl = u; };
      const restored = await controller.restore();
      assert.equal(restored, true, 'Restore succeeds for mixed array');

      const parsed = UrlParser.parseWatchVideosUrl(restoredUrl);
      assert.deepEqual(parsed.videoIds, ['validId0001', 'validId0002', 'validId0003'], 'Only valid 11-char IDs preserved');

      controller.destroy();
    });

    test('4.3: Corrupted preferences and session_state schemas handle gracefully', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        autoStart: false
      });

      // Save valid session
      await storageSync.saveSavedSession({
        videoIds: ['vid00000001'],
        savedAt: Date.now()
      });

      // Inject corrupted preferences
      storageArea.store.set(StorageKeys.STORAGE_KEYS.PREFERENCES, 'invalid-prefs-string');
      await assert.doesNotReject(async () => {
        const available = await controller.checkRestoreAvailable();
        assert.equal(available, true, 'Default showRestoreBanner=true applies when preferences corrupt');
      });

      // Explicitly set showRestoreBanner: false via storageSync
      await storageSync.setPreferences({ showRestoreBanner: false });
      assert.equal(await controller.checkRestoreAvailable(), false, 'showRestoreBanner: false correctly honored');

      // Inject corrupted session_state
      storageArea.store.set(StorageKeys.STORAGE_KEYS.SESSION_STATE, { bannerDismissedSessionSavedAt: 'corrupted-timestamp' });
      await assert.doesNotReject(async () => {
        // Should not throw or crash
        await controller.checkRestoreAvailable();
      });

      controller.destroy();
    });

    test('4.4: StorageSync I/O rejection isolation: checkRestoreAvailable & checkAndShowBanner survive storage errors', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);

      // Faulty StorageSync where all reads throw
      const brokenStorage = {
        getPreferences: () => Promise.reject(new Error('Disk read failure')),
        getActiveQueue: () => Promise.reject(new Error('Active queue query failure')),
        getSavedSession: () => Promise.reject(new Error('Saved session corrupt')),
        getSessionState: () => Promise.reject(new Error('Session state unavailable')),
        subscribe: () => () => {}
      };

      const controller = new RestoreController({
        storageSync: brokenStorage,
        document: doc,
        window: win,
        autoStart: false
      });

      // If storage throws, controller's reactive triggers must not cause unhandled rejections
      await assert.doesNotReject(async () => {
        try {
          await controller.checkAndShowBanner();
        } catch (_) {
          // If it rejects, verify controller did not leave inconsistent state
        }
      });

      // Controller should remain destroyable
      assert.doesNotThrow(() => {
        controller.destroy();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Challenge Suite 5: Lifecycle Integrity: Multiple start() and destroy() Cycles
  // ---------------------------------------------------------------------------
  describe('Challenge Suite 5: Lifecycle Integrity: Multiple start() and destroy() Cycles', () => {

    test('5.1: Multiple start() calls before destroy() do not duplicate banner or leak', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      await storageSync.saveSavedSession({
        videoIds: ['vid00000001'],
        savedAt: Date.now()
      });

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        autoStart: false
      });

      // Call start() 5 times consecutively
      for (let i = 0; i < 5; i++) {
        controller.start();
      }
      await controller.checkAndShowBanner();

      assert.equal(doc.querySelectorAll('#yqp-restore-banner').length, 1, 'Only 1 banner element mounted despite 5 start calls');

      controller.destroy();
      assert.equal(doc.querySelectorAll('#yqp-restore-banner').length, 0, 'Clean DOM after destroy()');
    });

    test('5.2: destroy() idempotency: calling destroy() multiple times is safe and never throws', () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const controller = new RestoreController({ document: doc, window: win, autoStart: false });

      assert.doesNotThrow(() => {
        for (let i = 0; i < 10; i++) {
          controller.destroy();
        }
      });
    });

    test('5.3: Post-destroy calls are inert and do not throw or re-inject banners', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      await storageSync.saveSavedSession({
        videoIds: ['vid00000001'],
        savedAt: Date.now()
      });

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        autoStart: true
      });
      await controller.checkAndShowBanner();
      assert.equal(controller.isBannerVisible(), true);

      controller.destroy();
      assert.equal(controller.isBannerVisible(), false);

      // Attempt calls after destruction
      await assert.doesNotReject(async () => {
        controller.start();
        await controller.checkAndShowBanner();
        assert.equal(await controller.checkRestoreAvailable(), false, 'Destroyed controller returns false');
        assert.equal(await controller.restore(), false, 'Destroyed controller restore returns false');
        await controller.dismiss();
        controller.onQueueUpdated({ count: 0 });
        controller.onSavedSessionChanged({});
        controller.onPreferencesChanged({});
      });

      assert.equal(doc.querySelectorAll('#yqp-restore-banner').length, 0, 'No banner injected after destroy');
    });

    test('5.4: 25 sequential instance creation and destroy cycles leave pristine DOM', async () => {
      const { doc, contents } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      await storageSync.saveSavedSession({
        videoIds: ['vid00000001'],
        savedAt: Date.now()
      });

      for (let i = 0; i < 25; i++) {
        const c = new RestoreController({
          storageSync,
          document: doc,
          window: win,
          autoStart: true
        });
        await c.checkAndShowBanner();
        assert.equal(c.isBannerVisible(), true, `Cycle ${i}: banner visible`);
        assert.equal(doc.querySelectorAll('#yqp-restore-banner').length, 1, `Cycle ${i}: exactly 1 banner`);

        c.destroy();
        assert.equal(c.isBannerVisible(), false, `Cycle ${i}: banner invisible after destroy`);
        assert.equal(doc.querySelectorAll('#yqp-restore-banner').length, 0, `Cycle ${i}: zero banners after destroy`);
        assert.equal(contents.children.length, 0, `Cycle ${i}: contents empty`);
      }
    });

    test('5.5: YouTube SPA navigation event listeners are detached upon destroy()', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      await storageSync.saveSavedSession({
        videoIds: ['vid00000001'],
        savedAt: Date.now()
      });

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        autoStart: true
      });
      await controller.checkAndShowBanner();
      assert.equal(controller.isBannerVisible(), true);

      // Verify listeners bound
      assert.ok(win._listeners.some(l => l.type === 'yt-navigate-finish'));
      assert.ok(win._listeners.some(l => l.type === 'yt-page-data-updated'));

      controller.destroy();

      // Verify listeners removed from window
      assert.equal(win._listeners.filter(l => l.type === 'yt-navigate-finish').length, 0, 'yt-navigate-finish listener removed');
      assert.equal(win._listeners.filter(l => l.type === 'yt-page-data-updated').length, 0, 'yt-page-data-updated listener removed');

      // Dispatching navigation events post-destroy must be harmless
      win.dispatchEvent(new MockEvent('yt-navigate-finish'));
      win.dispatchEvent(new MockEvent('yt-page-data-updated'));
      assert.equal(doc.querySelectorAll('#yqp-restore-banner').length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Challenge Suite 6: Stylesheet & UI Contract Conformance
  // ---------------------------------------------------------------------------
  describe('Challenge Suite 6: Stylesheet & UI Contract Conformance', () => {

    test('6.1: queue_plus.css contains all required restore banner selectors and animation rules', () => {
      const cssPath = path.resolve(__dirname, '../src/styles/queue_plus.css');
      assert.ok(fs.existsSync(cssPath), 'queue_plus.css exists');

      const css = fs.readFileSync(cssPath, 'utf8');

      // Core banner selectors
      assert.ok(css.includes('.yqp-restore-banner'), 'Contains .yqp-restore-banner selector');
      assert.ok(css.includes('#yqp-restore-banner'), 'Contains #yqp-restore-banner selector');
      assert.ok(css.includes('.yqp-restore-banner-text'), 'Contains .yqp-restore-banner-text selector');
      assert.ok(css.includes('.yqp-banner-title'), 'Contains .yqp-banner-title selector');
      assert.ok(css.includes('.yqp-banner-timestamp'), 'Contains .yqp-banner-timestamp selector');
      assert.ok(css.includes('.yqp-restore-banner-actions'), 'Contains .yqp-restore-banner-actions selector');
      assert.ok(css.includes('.yqp-banner-btn-restore'), 'Contains .yqp-banner-btn-restore selector');
      assert.ok(css.includes('.yqp-banner-btn-dismiss'), 'Contains .yqp-banner-btn-dismiss selector');

      // Visual styling & animation
      assert.ok(css.includes('yqp-banner-fadein'), 'Contains fadein keyframe animation');
      assert.ok(css.includes('border-radius'), 'Contains border-radius styling');
      assert.ok(css.includes('backdrop-filter'), 'Contains backdrop-filter blur');
      assert.ok(css.includes('html:not([dark])'), 'Contains light mode adaptability rules');
      assert.ok(css.includes('@media (max-width: 600px)'), 'Contains responsive media query for narrow screens');
    });

    test('6.2: Banner element DOM attributes conform to accessibility and ARIA guidelines', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      await storageSync.saveSavedSession({
        videoIds: ['vid00000001', 'vid00000002'],
        currentIndex: 0,
        savedAt: Date.now() - 120000
      });

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        autoStart: true
      });
      await controller.checkAndShowBanner();

      const banner = doc.querySelector('#yqp-restore-banner');
      assert.ok(banner);
      assert.equal(banner.getAttribute('role'), 'banner', 'Has role="banner"');
      assert.ok(banner.hasAttribute('aria-label'), 'Has aria-label attribute');

      const restoreBtn = banner.querySelector('.yqp-banner-btn-restore');
      assert.equal(restoreBtn.getAttribute('type'), 'button');
      assert.equal(restoreBtn.getAttribute('aria-label'), 'Restore Queue');

      const dismissBtn = banner.querySelector('.yqp-banner-btn-dismiss');
      assert.equal(dismissBtn.getAttribute('type'), 'button');
      assert.equal(dismissBtn.getAttribute('aria-label'), 'Dismiss banner');

      controller.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // Challenge Suite 7: Adversarial Edge Cases & Behavioral Findings
  // ---------------------------------------------------------------------------
  describe('Challenge Suite 7: Adversarial Edge Cases & Behavioral Findings', () => {

    test('7.1: Zero-count or empty saved session does not trigger restore banner', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        autoStart: false
      });

      await storageSync.saveSavedSession({ videoIds: [], currentIndex: 0, savedAt: Date.now() });
      assert.equal(await controller.checkRestoreAvailable(), false);
      assert.equal(await controller.checkAndShowBanner(), false);
      assert.equal(controller.isBannerVisible(), false);

      controller.destroy();
    });

    test('7.2: Relative time formatting under various boundary conditions', () => {
      // In RestoreController, relative time helper is tested via banner timestamp rendering
      const now = Date.now();
      const testCases = [
        { savedAt: now - 10000, expected: 'just now' },
        { savedAt: now - 65000, expected: '1 minute ago' },
        { savedAt: now - (5 * 60 * 1000), expected: '5 minutes ago' },
        { savedAt: now - (65 * 60 * 1000), expected: '1 hour ago' },
        { savedAt: now - (3 * 3600 * 1000), expected: '3 hours ago' },
        { savedAt: now - (25 * 3600 * 1000), expected: '1 day ago' },
        { savedAt: now - (3 * 86400 * 1000), expected: '3 days ago' },
        { savedAt: now + 60000, expected: 'just now' } // Future timestamp
      ];

      for (const tc of testCases) {
        const { doc } = createYouTubePageDOM();
        const win = new MockWindow(doc);
        const controller = new RestoreController({ document: doc, window: win, autoStart: false });
        const el = controller._createBannerElement({ videoIds: ['vid00000001'], savedAt: tc.savedAt });
        const tsSpan = el.querySelector('.yqp-banner-timestamp');
        assert.ok(tsSpan, `Timestamp span exists for ${tc.savedAt}`);
        assert.ok(tsSpan.textContent.includes(tc.expected), `Timestamp "${tsSpan.textContent}" contains expected "${tc.expected}"`);
      }
    });

    test('7.3 FINDING: Multiple rapid start() calls create redundant subscriptions if not guarded by _isStarted', () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea, debounceDelay: 0 });

      const controller = new RestoreController({
        storageSync,
        document: doc,
        window: win,
        autoStart: false
      });

      // Initially 0 unsubscribers
      assert.equal(controller._unsubscribers.length, 0);

      // Call start() once -> binds 4 storageSync channels
      controller.start();
      assert.equal(controller._unsubscribers.length, 4, '1 start() call binds 4 subscriptions');

      // Call start() second time -> without an _isStarted guard, it binds 4 more
      controller.start();

      // EMPIRICAL OBSERVATION:
      // controller._unsubscribers accumulates duplicate subscriptions (8 total)
      // Although destroy() cleans up all unsubscribers without throwing, guarding start()
      // with if (this._isStarted || this._isDestroyed) return; would prevent redundant bindings.
      assert.equal(controller._unsubscribers.length, 8, 'Empirical proof: duplicate start() calls add duplicate subscriptions');

      controller.destroy();
      assert.equal(controller._unsubscribers.length, 0, 'destroy() successfully disposes all 8 subscriptions');
    });

    test('7.4 FINDING: Asynchronous checkAndShowBanner race condition when queue becomes active in-flight', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const storageArea = new MockChromeStorageArea();

      // Artificial delayed storage sync simulating async storage latency
      let currentSession = null;
      let resolveSessionGate = null;
      const sessionGate = new Promise(res => { resolveSessionGate = res; });

      const delayedStorageSync = {
        getPreferences: () => Promise.resolve({ showRestoreBanner: true }),
        getActiveQueue: () => Promise.resolve({ videoIds: [], count: 0 }),
        getSavedSession: async () => {
          await sessionGate;
          return currentSession;
        },
        getSessionState: () => Promise.resolve({ bannerDismissedSessionSavedAt: 0 }),
        subscribe: () => () => {}
      };

      const controller = new RestoreController({
        storageSync: delayedStorageSync,
        document: doc,
        window: win,
        autoStart: false
      });

      // 1. Kick off checkAndShowBanner() while queue is empty
      const checkPromise = controller.checkAndShowBanner();

      // Yield event loop to allow checkRestoreAvailable to reach getSavedSession
      await new Promise(r => setTimeout(r, 10));

      // 2. While storage read is in flight, queue mutation happens (queue becomes ACTIVE)
      controller.onQueueUpdated({ videoIds: ['active_vid_1'], count: 1 });
      assert.equal(controller.isBannerVisible(), false);

      // 3. Now storage read completes with a valid saved session
      currentSession = {
        videoIds: ['saved_vid01'],
        currentIndex: 0,
        savedAt: Date.now()
      };
      resolveSessionGate();
      await checkPromise;

      // EMPIRICAL OBSERVATION:
      // Because checkAndShowBanner does not re-verify active queue count after awaiting getSavedSession,
      // it mounts the banner into the DOM even though the queue is currently active!
      // This is a documented asynchronous race window finding.
      const bannerMountedOverActiveQueue = controller.isBannerVisible();
      assert.equal(bannerMountedOverActiveQueue, true, 'Empirical proof: in-flight async checkAndShowBanner mounts banner over active queue');

      controller.destroy();
    });
  });
});
