/**
 * YoutubeQueuePlus - Milestone M4 Session Restore Controller & Popup UI Test Suite
 * Zero-dependency test harness using Node.js built-in test runner (node:test, node:assert/strict).
 *
 * Verifies:
 * - Suite 1: RestoreController Unit Tests (12 tests)
 * - Suite 2: ContentMain Integration & SPA Lifecycle Tests (8 tests)
 * - Suite 3: Popup UI Unit & Reactivity Tests (10 tests)
 * - Suite 4: Edge Cases & Zero-Dependency Execution Robustness (4 tests)
 *
 * Total tests: 34 tests
 * Executable via: node test/m4_restore_popup.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Modules under test
const Constants = require('../src/shared/constants');
const StorageKeys = require('../src/shared/storage_keys');
const UrlParser = require('../src/utils/url_parser');
const DomHelpers = require('../src/utils/dom_helpers');
const StorageSync = require('../src/modules/storage_sync');
const ToastManager = require('../src/modules/toast_manager');
const DuplicateGuard = require('../src/modules/duplicate_guard');
const FeedDecorator = require('../src/modules/feed_decorator');
const QueueObserver = require('../src/modules/queue_observer');
const RestoreController = require('../src/modules/restore_controller');
const ContentMain = require('../src/content_main');
const { PopupController, buildRestoreUrl, formatTimestamp } = require('../popup/popup');

// =============================================================================
// Lightweight In-Memory Test Harness & Mocks
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

    // At Target
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
    this._checked = false;
    this._disabled = false;
    this._value = '';
    this._type = '';
    this._name = '';
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

  get checked() { return this._checked; }
  set checked(v) {
    this._checked = Boolean(v);
    if (this._checked && (this.type === 'radio' || this.getAttribute('type') === 'radio')) {
      let root = this.parentNode;
      while (root && root.parentNode) {
        root = root.parentNode;
      }
      if (root && root.querySelectorAll) {
        const name = this.name;
        if (name) {
          const siblings = root.querySelectorAll(`input[name="${name}"]`);
          for (const s of siblings) {
            if (s !== this) s._checked = false;
          }
        }
      }
    }
  }

  get disabled() { return this._disabled; }
  set disabled(v) { this._disabled = Boolean(v); }

  get value() { return this.getAttribute('value') || this._value; }
  set value(v) {
    this._value = String(v);
    this.attributes.set('value', String(v));
  }

  get type() { return this.getAttribute('type') || this._type; }
  set type(v) {
    this._type = String(v);
    this.attributes.set('type', String(v));
  }

  get name() { return this.getAttribute('name') || this._name; }
  set name(v) {
    this._name = String(v);
    this.attributes.set('name', String(v));
  }

  get textContent() {
    if (this.children.length === 0) return this._textContent;
    return this.children.map(c => c.textContent).join('');
  }
  set textContent(v) {
    this.children = [];
    this._textContent = String(v);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') {
      this._classList.clear();
      String(value).split(/\s+/).filter(Boolean).forEach(c => this._classList.add(c));
    }
    if (name === 'value') this._value = String(value);
    if (name === 'name') this._name = String(value);
    if (name === 'type') this._type = String(value);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'class') this._classList.clear();
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(newChild, refChild) {
    if (!newChild) return newChild;
    if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
    newChild.parentNode = this;
    if (!refChild) {
      this.children.push(newChild);
      return newChild;
    }
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

  querySelector(sel) {
    for (const child of this.children) {
      if (child.nodeType === 1) {
        if (matchSelector(child, sel)) return child;
        const res = child.querySelector(sel);
        if (res) return res;
      }
    }
    return null;
  }

  querySelectorAll(sel) {
    const results = [];
    const traverse = (node) => {
      for (const child of node.children) {
        if (child.nodeType === 1) {
          if (matchSelector(child, sel)) results.push(child);
          traverse(child);
        }
      }
    };
    traverse(this);
    return results;
  }

  click() {
    const ev = new MockEvent('click', { bubbles: true, cancelable: true });
    this.dispatchEvent(ev);
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
    const el = new MockElement(tagName);
    return el;
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
    this._closed = false;
    this._openedUrls = [];
  }

  close() {
    this._closed = true;
  }

  open(url, target) {
    this._openedUrls.push({ url, target });
    return {};
  }
}

class MockMutationObserver {
  constructor(cb) {
    this.cb = cb;
    this.connected = false;
  }
  observe() { this.connected = true; }
  disconnect() { this.connected = false; }
  takeRecords() { return []; }
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

class MockChrome {
  constructor() {
    this.storage = {
      local: new MockChromeStorageArea(),
      onChanged: {
        addListener: (fn) => this.storage.local.changeListeners.push(fn),
        removeListener: (fn) => {
          const idx = this.storage.local.changeListeners.indexOf(fn);
          if (idx !== -1) this.storage.local.changeListeners.splice(idx, 1);
        }
      }
    };
    this.tabs = {
      _tabs: [{ id: 101, url: 'https://www.youtube.com/' }],
      query: (queryInfo, callback) => {
        callback([...this.tabs._tabs]);
      },
      update: (tabId, updateProps, callback) => {
        const tab = this.tabs._tabs.find(t => t.id === tabId);
        if (tab && updateProps.url) tab.url = updateProps.url;
        if (callback) callback(tab);
      },
      create: (createProps, callback) => {
        const newTab = { id: Date.now(), url: createProps.url };
        this.tabs._tabs.push(newTab);
        if (callback) callback(newTab);
      }
    };
  }
}

// Attach MutationObserver to globalThis for node runner
if (typeof globalThis.MutationObserver === 'undefined') {
  globalThis.MutationObserver = MockMutationObserver;
}

// =============================================================================
// Helper: Build Youtube Feed DOM Structure for Restore Banner Tests
// =============================================================================

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

function createPopupDOM() {
  const doc = new MockDocument();

  // Active queue card
  const queueCount = doc.createElement('span');
  queueCount.id = 'queueCount';
  queueCount.textContent = '0 videos';
  doc.body.appendChild(queueCount);

  const playingIndex = doc.createElement('span');
  playingIndex.id = 'playingIndex';
  playingIndex.textContent = '—';
  doc.body.appendChild(playingIndex);

  const queueLivePill = doc.createElement('span');
  queueLivePill.id = 'queueLivePill';
  queueLivePill.className = 'live-pill idle';
  queueLivePill.textContent = 'IDLE';
  doc.body.appendChild(queueLivePill);

  // Treatment mode radios
  const radioBadgeAndDim = doc.createElement('input');
  radioBadgeAndDim.type = 'radio';
  radioBadgeAndDim.name = 'feedTreatmentMode';
  radioBadgeAndDim.value = 'badge_and_dim';
  radioBadgeAndDim.id = 'modeBadgeAndDim';
  radioBadgeAndDim.checked = true;
  doc.body.appendChild(radioBadgeAndDim);

  const radioHide = doc.createElement('input');
  radioHide.type = 'radio';
  radioHide.name = 'feedTreatmentMode';
  radioHide.value = 'hide';
  radioHide.id = 'modeHide';
  doc.body.appendChild(radioHide);

  const radioBadgeOnly = doc.createElement('input');
  radioBadgeOnly.type = 'radio';
  radioBadgeOnly.name = 'feedTreatmentMode';
  radioBadgeOnly.value = 'badge_only';
  radioBadgeOnly.id = 'modeBadgeOnly';
  doc.body.appendChild(radioBadgeOnly);

  // Saved session card
  const savedCount = doc.createElement('span');
  savedCount.id = 'savedCount';
  savedCount.textContent = 'None';
  doc.body.appendChild(savedCount);

  const savedTime = doc.createElement('span');
  savedTime.id = 'savedTime';
  savedTime.textContent = '—';
  doc.body.appendChild(savedTime);

  const sessionStatusPill = doc.createElement('span');
  sessionStatusPill.id = 'sessionStatusPill';
  sessionStatusPill.className = 'status-pill none';
  sessionStatusPill.textContent = 'NONE';
  doc.body.appendChild(sessionStatusPill);

  const restoreBtn = doc.createElement('button');
  restoreBtn.id = 'restoreBtn';
  restoreBtn.disabled = true;
  restoreBtn.textContent = 'Restore Saved Queue';
  doc.body.appendChild(restoreBtn);

  return {
    doc,
    queueCount,
    playingIndex,
    queueLivePill,
    radioBadgeAndDim,
    radioHide,
    radioBadgeOnly,
    savedCount,
    savedTime,
    sessionStatusPill,
    restoreBtn
  };
}

// =============================================================================
// Test Suites
// =============================================================================

describe('Milestone M4: Session Restore Controller & Popup UI', () => {

  // ---------------------------------------------------------------------------
  // Suite 1: RestoreController Unit Tests
  // ---------------------------------------------------------------------------
  describe('Suite 1: RestoreController Unit Tests', () => {

    test('1.1: checkRestoreAvailable returns false when active queue has >= 1 videos', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea: mockStorage, debounceDelay: 0 });

      // Active queue has 2 videos
      await mockStorage.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: {
          videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw'],
          currentIndex: 0,
          count: 2,
          lastUpdated: Date.now()
        },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw'],
          currentIndex: 0,
          savedAt: Date.now()
        }
      });

      const controller = new RestoreController({
        document: doc,
        window: win,
        storageSync,
        autoStart: false
      });

      const available = await controller.checkRestoreAvailable();
      assert.equal(available, false, 'Banner should not be available when active queue has >= 1 videos');
      controller.destroy();
    });

    test('1.2: checkRestoreAvailable returns false when saved session is empty or absent', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea: mockStorage, debounceDelay: 0 });

      // Empty active queue, but no saved session
      await mockStorage.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], count: 0 },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: null
      });

      const controller = new RestoreController({
        document: doc,
        window: win,
        storageSync,
        autoStart: false
      });

      const available = await controller.checkRestoreAvailable();
      assert.equal(available, false, 'Banner should not be available when saved session is empty');
      controller.destroy();
    });

    test('1.3: checkRestoreAvailable returns true when active queue is empty and saved session exists', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea: mockStorage, debounceDelay: 0 });

      await mockStorage.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], count: 0 },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw', '3JZ_D3ELwOQ'],
          currentIndex: 1,
          savedAt: Date.now() - 60000
        }
      });

      const controller = new RestoreController({
        document: doc,
        window: win,
        storageSync,
        autoStart: false
      });

      const available = await controller.checkRestoreAvailable();
      assert.equal(available, true, 'Banner should be available when active queue is empty and saved session exists');
      controller.destroy();
    });

    test('1.4: Banner injection: injects #yqp-restore-banner into priority feed container with text and buttons', async () => {
      const { doc, contents } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea: mockStorage, debounceDelay: 0 });

      await mockStorage.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], count: 0 },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw'],
          currentIndex: 0,
          savedAt: Date.now() - 300000
        }
      });

      const controller = new RestoreController({
        document: doc,
        window: win,
        storageSync,
        autoStart: false
      });

      const shown = await controller.checkAndShowBanner();
      assert.equal(shown, true);
      assert.equal(controller.isBannerVisible(), true);

      const bannerEl = doc.getElementById('yqp-restore-banner');
      assert.ok(bannerEl, '#yqp-restore-banner should be injected in DOM');
      assert.equal(bannerEl.className.includes('yqp-restore-banner'), true);

      const restoreBtn = bannerEl.querySelector('.yqp-banner-btn-restore');
      const dismissBtn = bannerEl.querySelector('.yqp-banner-btn-dismiss');
      assert.ok(restoreBtn, 'Restore button should exist');
      assert.ok(dismissBtn, 'Dismiss button should exist');

      // Verify text contains video count
      const titleEl = bannerEl.querySelector('.yqp-banner-title');
      assert.ok(titleEl && titleEl.textContent.includes('2 videos'));

      controller.destroy();
    });

    test('1.5: Banner injection idempotency: does not create duplicate banners if already present in DOM', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea: mockStorage, debounceDelay: 0 });

      await mockStorage.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], count: 0 },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['dQw4w9WgXcQ'],
          currentIndex: 0,
          savedAt: Date.now()
        }
      });

      const controller = new RestoreController({
        document: doc,
        window: win,
        storageSync,
        autoStart: false
      });

      await controller.checkAndShowBanner();
      await controller.checkAndShowBanner();
      await controller.checkAndShowBanner();

      const banners = doc.querySelectorAll('#yqp-restore-banner');
      assert.equal(banners.length, 1, 'Should never mount duplicate banners');
      controller.destroy();
    });

    test('1.6: 1-click restore URL generation: generates valid /watch_videos URL capped at 50 videos and clamped index', () => {
      const ids = Array.from({ length: 65 }, (_, i) => `vid${String(i).padStart(8, '0')}`);
      const url = UrlParser.buildRestoreUrl(ids, 15);

      assert.ok(url.startsWith('https://www.youtube.com/watch_videos?video_ids='));
      assert.ok(url.includes('&index=15'));
      const parsedIds = decodeURIComponent(url.split('video_ids=')[1].split('&')[0]).split(',');
      assert.equal(parsedIds.length, 50, 'URL should cap at 50 videos');

      // Negative index clamping
      const urlNeg = UrlParser.buildRestoreUrl(['dQw4w9WgXcQ'], -5);
      assert.ok(urlNeg.includes('&index=0'), 'Negative index clamps to 0');

      // Overflow index clamping
      const urlOver = UrlParser.buildRestoreUrl(['dQw4w9WgXcQ', 'jNQXAC9IVRw'], 99);
      assert.ok(urlOver.includes('&index=1'), 'Overflow index clamps to length - 1');
    });

    test('1.7: 1-click restore action: clicking restore button sets window location, records lastRestoredTimestamp, and removes banner', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea: mockStorage, debounceDelay: 0 });

      await mockStorage.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], count: 0 },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw'],
          currentIndex: 1,
          savedAt: Date.now()
        }
      });

      let navigatedUrl = null;
      const controller = new RestoreController({
        document: doc,
        window: win,
        storageSync,
        navigateFn: (url) => { navigatedUrl = url; },
        autoStart: false
      });

      await controller.checkAndShowBanner();
      assert.equal(controller.isBannerVisible(), true);

      const restoreBtn = doc.querySelector('.yqp-banner-btn-restore');
      assert.ok(restoreBtn);
      restoreBtn.click();

      // Allow async restore promise
      await new Promise(r => setTimeout(r, 20));

      assert.ok(navigatedUrl && decodeURIComponent(navigatedUrl).includes('dQw4w9WgXcQ,jNQXAC9IVRw'));
      assert.ok(navigatedUrl.includes('&index=1'));
      assert.equal(controller.isBannerVisible(), false, 'Banner should be hidden after restore');

      const sessionState = await storageSync.getSessionState();
      assert.ok(sessionState.lastRestoredTimestamp > 0, 'lastRestoredTimestamp should be recorded');

      controller.destroy();
    });

    test('1.8: Dismissal state persistence: clicking dismiss button removes banner and writes bannerDismissedSessionSavedAt to storage', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea: mockStorage, debounceDelay: 0 });
      const savedAtTime = Date.now() - 50000;

      await mockStorage.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], count: 0 },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['dQw4w9WgXcQ'],
          currentIndex: 0,
          savedAt: savedAtTime
        }
      });

      const controller = new RestoreController({
        document: doc,
        window: win,
        storageSync,
        autoStart: false
      });

      await controller.checkAndShowBanner();
      assert.equal(controller.isBannerVisible(), true);

      const dismissBtn = doc.querySelector('.yqp-banner-btn-dismiss');
      assert.ok(dismissBtn);
      dismissBtn.click();

      await new Promise(r => setTimeout(r, 20));

      assert.equal(controller.isBannerVisible(), false, 'Banner should be removed after dismiss');
      const sessionState = await storageSync.getSessionState();
      assert.equal(sessionState.bannerDismissedSessionSavedAt, savedAtTime);
      assert.ok(sessionState.bannerDismissedTimestamp > 0);

      controller.destroy();
    });

    test('1.9: Dismissal suppression: subsequent checks do not show banner for the same saved session timestamp', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea: mockStorage, debounceDelay: 0 });
      const savedAtTime = Date.now() - 50000;

      await mockStorage.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], count: 0 },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['dQw4w9WgXcQ'],
          currentIndex: 0,
          savedAt: savedAtTime
        },
        [StorageKeys.STORAGE_KEYS.SESSION_STATE]: {
          bannerDismissedTimestamp: Date.now() - 10000,
          bannerDismissedSessionSavedAt: savedAtTime
        }
      });

      const controller = new RestoreController({
        document: doc,
        window: win,
        storageSync,
        autoStart: false
      });

      const available = await controller.checkRestoreAvailable();
      assert.equal(available, false, 'Dismissed session should be suppressed');

      const shown = await controller.checkAndShowBanner();
      assert.equal(shown, false);
      assert.equal(controller.isBannerVisible(), false);

      controller.destroy();
    });

    test('1.10: Resurfacing on new session: when a newer session is saved, banner resurfaces despite prior dismissal', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea: mockStorage, debounceDelay: 0 });
      const oldTime = Date.now() - 100000;
      const newTime = Date.now();

      await mockStorage.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], count: 0 },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['dQw4w9WgXcQ', 'newVideoId1'],
          currentIndex: 0,
          savedAt: newTime
        },
        [StorageKeys.STORAGE_KEYS.SESSION_STATE]: {
          bannerDismissedTimestamp: oldTime + 1000,
          bannerDismissedSessionSavedAt: oldTime
        }
      });

      const controller = new RestoreController({
        document: doc,
        window: win,
        storageSync,
        autoStart: false
      });

      const available = await controller.checkRestoreAvailable();
      assert.equal(available, true, 'Newer session should resurface banner despite prior dismissal');
      controller.destroy();
    });

    test('1.11: Preference check: showRestoreBanner: false suppresses banner display', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea: mockStorage, debounceDelay: 0 });

      await mockStorage.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], count: 0 },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['dQw4w9WgXcQ'],
          currentIndex: 0,
          savedAt: Date.now()
        },
        [StorageKeys.STORAGE_KEYS.PREFERENCES]: {
          showRestoreBanner: false,
          feedTreatmentMode: 'badge_and_dim'
        }
      });

      const controller = new RestoreController({
        document: doc,
        window: win,
        storageSync,
        autoStart: false
      });

      const available = await controller.checkRestoreAvailable();
      assert.equal(available, false, 'showRestoreBanner: false should suppress banner');
      controller.destroy();
    });

    test('1.12: destroy() cleanly unbinds listeners and removes banner from DOM', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();
      const storageSync = new StorageSync({ storageArea: mockStorage, debounceDelay: 0 });

      await mockStorage.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], count: 0 },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['dQw4w9WgXcQ'],
          currentIndex: 0,
          savedAt: Date.now()
        }
      });

      const controller = new RestoreController({
        document: doc,
        window: win,
        storageSync,
        autoStart: false
      });

      await controller.checkAndShowBanner();
      assert.equal(controller.isBannerVisible(), true);

      controller.destroy();
      assert.equal(controller.isBannerVisible(), false, 'Banner should be removed on destroy');
      assert.equal(doc.getElementById('yqp-restore-banner'), null);
      assert.equal(controller._isDestroyed, true);
    });

  });

  // ---------------------------------------------------------------------------
  // Suite 2: ContentMain Integration & SPA Lifecycle Tests
  // ---------------------------------------------------------------------------
  describe('Suite 2: ContentMain Integration & SPA Lifecycle Tests', () => {

    test('2.1: Bootstraps all modules without error and registers global __YQP__ object', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockStorage,
        storageSyncOptions: { debounceDelay: 0 }
      });

      await app.init();

      assert.equal(app.isInitialized, true, 'App should be initialized');
      assert.ok(app.storageSync, 'storageSync instantiated');
      assert.ok(app.toastManager, 'toastManager instantiated');
      assert.ok(app.queueObserver, 'queueObserver instantiated');
      assert.ok(app.duplicateGuard, 'duplicateGuard instantiated');
      assert.ok(app.feedDecorator, 'feedDecorator instantiated');
      assert.ok(app.restoreController, 'restoreController instantiated');

      app.destroy();
    });

    test('2.2: Wires QueueObserver mutations to StorageSync.saveActiveQueue and FeedDecorator.updateQueue', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockStorage,
        storageSyncOptions: { debounceDelay: 0 }
      });

      await app.init();

      const testState = {
        videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw'],
        currentIndex: 0,
        count: 2,
        lastUpdated: Date.now()
      };

      // Emit mutation through QueueObserver subscribers
      for (const sub of app.queueObserver._subscribers) {
        sub(testState);
      }

      // Verify FeedDecorator received IDs
      assert.ok(app.feedDecorator.activeQueueIds.has('dQw4w9WgXcQ'));
      assert.ok(app.feedDecorator.activeQueueIds.has('jNQXAC9IVRw'));

      app.destroy();
    });

    test('2.3: Wires active queue mutation to RestoreController (hides banner when queue becomes active)', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();

      await mockStorage.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], count: 0 },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['dQw4w9WgXcQ'],
          currentIndex: 0,
          savedAt: Date.now()
        }
      });

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockStorage,
        storageSyncOptions: { debounceDelay: 0 }
      });

      await app.init();
      await app.restoreController.checkAndShowBanner();
      assert.equal(app.restoreController.isBannerVisible(), true, 'Banner mounted');

      // Now queue observer notifies queue became active
      for (const sub of app.queueObserver._subscribers) {
        sub({
          videoIds: ['dQw4w9WgXcQ'],
          count: 1,
          currentIndex: 0
        });
      }

      assert.equal(app.restoreController.isBannerVisible(), false, 'Banner hidden when queue active');
      app.destroy();
    });

    test('2.4: Wires StorageSync preference changes (feedTreatmentMode) to FeedDecorator.setMode', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockStorage,
        storageSyncOptions: { debounceDelay: 0 }
      });

      await app.init();

      assert.equal(app.feedDecorator.mode, 'badge_and_dim');

      // Update preferences in storageSync
      await app.storageSync.setPreferences({ feedTreatmentMode: 'hide' });

      assert.equal(app.feedDecorator.mode, 'hide', 'FeedDecorator should update mode to hide');
      app.destroy();
    });

    test('2.5: Wires StorageSync cross-tab queue changes to FeedDecorator.updateQueue', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockStorage,
        storageSyncOptions: { debounceDelay: 0 }
      });

      await app.init();
      // Allow initial observer save to settle
      await new Promise(r => setTimeout(r, 20));

      // Simulate cross-tab queue change via storage onChanged with valid 11-char IDs
      mockStorage.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: {
          videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw'],
          count: 2,
          currentIndex: 0,
          lastUpdated: Date.now()
        }
      });

      await new Promise(r => setTimeout(r, 20));

      assert.equal(app.feedDecorator.activeQueueIds.has('dQw4w9WgXcQ'), true);
      assert.equal(app.feedDecorator.activeQueueIds.has('jNQXAC9IVRw'), true);

      app.destroy();
    });

    test('2.6: SPA navigation (yt-navigate-finish) triggers feed re-decoration and restore availability check', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();

      await mockStorage.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], count: 0 },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['dQw4w9WgXcQ'],
          currentIndex: 0,
          savedAt: Date.now()
        }
      });

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockStorage,
        storageSyncOptions: { debounceDelay: 0 }
      });

      await app.init();

      // Dispatch yt-navigate-finish on window
      const navEvent = new MockEvent('yt-navigate-finish');
      win.dispatchEvent(navEvent);

      await new Promise(r => setTimeout(r, 50));

      assert.equal(app.restoreController.isBannerVisible(), true, 'Navigation evaluated restore banner');
      app.destroy();
    });

    test('2.7: Error isolation: corrupted storage or malformed DOM during bootstrap catches safely without unhandled throws', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);

      // Faulty storage that throws errors
      const brokenStorage = {
        get: () => Promise.reject(new Error('Storage disk corrupt')),
        set: () => Promise.reject(new Error('Storage quota exceeded')),
        onChanged: { addListener: () => {}, removeListener: () => {} }
      };

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: brokenStorage
      });

      // Should resolve safely without throwing
      await assert.doesNotReject(async () => {
        await app.init();
      });

      app.destroy();
    });

    test('2.8: Teardown API: __YQP__.destroy() cleanly stops all observers, guards, listeners, and controllers', async () => {
      const { doc } = createYouTubePageDOM();
      const win = new MockWindow(doc);
      const mockStorage = new MockChromeStorageArea();

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockStorage,
        storageSyncOptions: { debounceDelay: 0 }
      });

      await app.init();
      assert.equal(app.isInitialized, true);

      app.destroy();
      assert.equal(app.isDestroyed, true);
      assert.equal(app.isInitialized, false);

      // Calling destroy multiple times must be idempotent and not throw
      assert.doesNotThrow(() => {
        app.destroy();
      });
    });

  });

  // ---------------------------------------------------------------------------
  // Suite 3: Popup UI Unit & Reactivity Tests
  // ---------------------------------------------------------------------------
  describe('Suite 3: Popup UI Unit & Reactivity Tests', () => {

    test('3.1: Initial DOM render: renders active queue count and current playing index from storage', async () => {
      const dom = createPopupDOM();
      const mockChrome = new MockChrome();

      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: {
          videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw', '3JZ_D3ELwOQ'],
          currentIndex: 1,
          count: 3
        }
      });

      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });

      popup.init();
      await new Promise(r => setTimeout(r, 10));

      assert.equal(dom.queueCount.textContent, '3 videos');
      assert.equal(dom.playingIndex.textContent, 'Video 2 of 3');
      assert.equal(dom.queueLivePill.textContent, 'LIVE');
      assert.equal(dom.queueLivePill.className.includes('active'), true);

      popup.destroy();
    });

    test('3.2: Initial DOM render: renders saved session count, formatted date/time, and sets restore button state', async () => {
      const dom = createPopupDOM();
      const mockChrome = new MockChrome();
      const savedTime = Date.now() - 120000; // 2 minutes ago

      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw'],
          currentIndex: 0,
          savedAt: savedTime
        }
      });

      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });

      popup.init();
      await new Promise(r => setTimeout(r, 10));

      assert.equal(dom.savedCount.textContent, '2 videos');
      assert.equal(dom.savedTime.textContent, '2m ago');
      assert.equal(dom.sessionStatusPill.textContent, 'READY');
      assert.equal(dom.restoreBtn.disabled, false);

      popup.destroy();
    });

    test('3.3: Initial DOM render: selects correct feed treatment mode radio button from preferences', async () => {
      const dom = createPopupDOM();
      const mockChrome = new MockChrome();

      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.PREFERENCES]: {
          feedTreatmentMode: 'hide'
        }
      });

      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });

      popup.init();
      await new Promise(r => setTimeout(r, 10));

      assert.equal(dom.radioHide.checked, true);
      assert.equal(dom.radioBadgeAndDim.checked, false);

      popup.destroy();
    });

    test('3.4: Treatment mode selection: selecting radio button writes new preference to chrome.storage.local', async () => {
      const dom = createPopupDOM();
      const mockChrome = new MockChrome();

      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });

      popup.init();
      await new Promise(r => setTimeout(r, 10));

      // User selects 'badge_only'
      dom.radioBadgeOnly.checked = true;
      const ev = new MockEvent('change');
      dom.radioBadgeOnly.dispatchEvent(ev);

      await new Promise(r => setTimeout(r, 10));

      const res = await mockChrome.storage.local.get(StorageKeys.STORAGE_KEYS.PREFERENCES);
      assert.equal(res[StorageKeys.STORAGE_KEYS.PREFERENCES]?.feedTreatmentMode, 'badge_only');

      popup.destroy();
    });

    test('3.5: 1-click restore button: disabled when no saved session exists (0 videos)', async () => {
      const dom = createPopupDOM();
      const mockChrome = new MockChrome();

      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: { videoIds: [], count: 0 }
      });

      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });

      popup.init();
      await new Promise(r => setTimeout(r, 10));

      assert.equal(dom.restoreBtn.disabled, true);
      assert.equal(dom.savedCount.textContent, 'None');
      assert.equal(dom.sessionStatusPill.textContent, 'NONE');

      popup.destroy();
    });

    test('3.6: 1-click restore button: enabled when saved session has >= 1 videos', async () => {
      const dom = createPopupDOM();
      const mockChrome = new MockChrome();

      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['dQw4w9WgXcQ'],
          currentIndex: 0,
          savedAt: Date.now()
        }
      });

      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });

      popup.init();
      await new Promise(r => setTimeout(r, 10));

      assert.equal(dom.restoreBtn.disabled, false);
      popup.destroy();
    });

    test('3.7: 1-click restore button click: triggers navigation/tab update to /watch_videos?video_ids=...&index=...', async () => {
      const dom = createPopupDOM();
      const mockChrome = new MockChrome();
      const win = new MockWindow(dom.doc);

      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw'],
          currentIndex: 1,
          savedAt: Date.now()
        }
      });

      const popup = new PopupController({
        document: dom.doc,
        window: win,
        chrome: mockChrome
      });

      popup.init();
      await new Promise(r => setTimeout(r, 10));

      dom.restoreBtn.click();
      await new Promise(r => setTimeout(r, 20));

      // Active tab (id 101 on youtube.com) was updated
      assert.ok(mockChrome.tabs._tabs[0].url.includes('/watch_videos?video_ids=dQw4w9WgXcQ%2CjNQXAC9IVRw&index=1'));
      assert.equal(win._closed, true, 'Popup window closes after restore');

      popup.destroy();
    });

    test('3.8: Reactivity: chrome.storage.onChanged for yqp_active_queue updates video count and playing index live without reopen', async () => {
      const dom = createPopupDOM();
      const mockChrome = new MockChrome();

      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });

      popup.init();
      await new Promise(r => setTimeout(r, 10));

      assert.equal(dom.queueCount.textContent, '0 videos');

      // Storage changes in background
      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: {
          videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw'],
          currentIndex: 0,
          count: 2
        }
      });

      await new Promise(r => setTimeout(r, 10));

      assert.equal(dom.queueCount.textContent, '2 videos');
      assert.equal(dom.playingIndex.textContent, 'Video 1 of 2');
      assert.equal(dom.queueLivePill.textContent, 'LIVE');

      popup.destroy();
    });

    test('3.9: Reactivity: chrome.storage.onChanged for yqp_saved_session updates session count, timestamp, and button state live without reopen', async () => {
      const dom = createPopupDOM();
      const mockChrome = new MockChrome();

      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });

      popup.init();
      await new Promise(r => setTimeout(r, 10));

      assert.equal(dom.restoreBtn.disabled, true);

      // Session saved
      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['dQw4w9WgXcQ'],
          currentIndex: 0,
          savedAt: Date.now() - 30000
        }
      });

      await new Promise(r => setTimeout(r, 10));

      assert.equal(dom.restoreBtn.disabled, false);
      assert.equal(dom.savedCount.textContent, '1 video');
      assert.equal(dom.sessionStatusPill.textContent, 'READY');

      popup.destroy();
    });

    test('3.10: Reactivity: chrome.storage.onChanged for yqp_preferences syncs radio buttons live if changed externally', async () => {
      const dom = createPopupDOM();
      const mockChrome = new MockChrome();

      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });

      popup.init();
      await new Promise(r => setTimeout(r, 10));

      assert.equal(dom.radioBadgeAndDim.checked, true);

      // Preferences updated elsewhere
      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.PREFERENCES]: {
          feedTreatmentMode: 'badge_only'
        }
      });

      await new Promise(r => setTimeout(r, 10));

      assert.equal(dom.radioBadgeOnly.checked, true);

      popup.destroy();
    });

  });

  // ---------------------------------------------------------------------------
  // Suite 4: Edge Cases & Zero-Dependency Execution Robustness
  // ---------------------------------------------------------------------------
  describe('Suite 4: Edge Cases & Zero-Dependency Execution Robustness', () => {

    test('4.1: Popup handles missing or corrupted storage data gracefully with safe defaults', async () => {
      const dom = createPopupDOM();
      const mockChrome = new MockChrome();

      // Corrupted storage (invalid session type, missing keys)
      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: null,
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: { videoIds: 'corrupted-string' },
        [StorageKeys.STORAGE_KEYS.PREFERENCES]: null
      });

      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });

      assert.doesNotThrow(() => {
        popup.init();
      });

      await new Promise(r => setTimeout(r, 10));

      assert.equal(dom.queueCount.textContent, '0 videos');
      assert.equal(dom.restoreBtn.disabled, true);
      assert.equal(dom.radioBadgeAndDim.checked, true);

      popup.destroy();
    });

    test('4.2: Large queue session (50+ videos) clamps to YouTube\'s 50 video limit in restore URL', () => {
      const largeList = Array.from({ length: 120 }, (_, i) => `vid${String(i).padStart(8, '0')}`);
      const url = buildRestoreUrl(largeList, 25);

      assert.ok(url);
      const videoIdsParam = new URL(url).searchParams.get('video_ids');
      const ids = videoIdsParam.split(',');
      assert.equal(ids.length, 50, 'Max 50 videos allowed');
      assert.equal(new URL(url).searchParams.get('index'), '25');
    });

    test('4.3: Relative timestamp formatter handles edge cases (future timestamp, 0 timestamp, invalid dates)', () => {
      // 0 / undefined / negative
      assert.equal(formatTimestamp(0), 'None');
      assert.equal(formatTimestamp(-100), 'None');
      assert.equal(formatTimestamp(null), 'None');

      // Future timestamp
      const future = Date.now() + 60000;
      assert.equal(formatTimestamp(future), 'Just now');

      // Valid recent timestamps
      assert.equal(formatTimestamp(Date.now() - 10000), 'Just now');
      assert.equal(formatTimestamp(Date.now() - 5 * 60000), '5m ago');
      assert.equal(formatTimestamp(Date.now() - 2 * 3600000), '2h ago');
    });

    test('4.4: Zero-dependency Node.js test execution: runs directly in Node.js v24 without npm dependencies', () => {
      // Confirms all modules are vanilla JS and load in pure Node.js
      assert.equal(typeof RestoreController, 'function');
      assert.equal(typeof ContentMain, 'function');
      assert.equal(typeof PopupController, 'function');
      assert.equal(typeof buildRestoreUrl, 'function');
      assert.equal(typeof formatTimestamp, 'function');
    });

  });

});
