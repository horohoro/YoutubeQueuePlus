/**
 * YoutubeQueuePlus - Milestone M4 Empirical Challenger 2 Stress Test Suite
 * Executable via: node test/m4_challenger_2_stress.test.js
 *
 * Mandate Scope:
 * Suite 1: High-frequency storage events (100+ rapid chrome.storage.onChanged updates,
 *          interleaved queue, session, and preference changes; strict DOM coherence)
 * Suite 2: Rapid radio mode switching (rapid UI changes, async storage writes, persistence)
 * Suite 3: Rapid SPA navigation burst (50 rapid yt-navigate-finish & popstate events,
 *          debouncing, zero duplicate observers or memory leaks)
 * Suite 4: Corrupted storage resilience in popup (missing fields, corrupted data types, safe defaults)
 * Suite 5: Lifecycle teardown & idempotency (multiple __YQP__.destroy() calls, clean teardown)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Modules under test
const Constants = require('../src/shared/constants');
const StorageKeysModule = require('../src/shared/storage_keys');
const StorageKeys = StorageKeysModule.STORAGE_KEYS;
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
// DOM & Chrome Mock Infrastructure
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

    // Capturing phase
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

    // At Target phase
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

    // Bubbling phase
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
    if (idx !== -1) {
      this.children.splice(idx, 0, newChild);
    } else {
      this.children.push(newChild);
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
  static instances = [];
  constructor(cb) {
    this.cb = cb;
    this.connected = false;
    MockMutationObserver.instances.push(this);
  }
  observe() { this.connected = true; }
  disconnect() { this.connected = false; }
  takeRecords() { return []; }
}

class MockChromeStorageArea {
  constructor() {
    this.store = new Map();
    this.changeListeners = [];
    this.asyncLatencyMs = 0; // Configurable delay to test async concurrency
  }

  get(keys, callback) {
    const run = () => {
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
      }
    };

    if (this.asyncLatencyMs > 0) {
      setTimeout(run, this.asyncLatencyMs);
    } else {
      run();
    }
  }

  set(items, callback) {
    const run = () => {
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
      }
    };

    if (this.asyncLatencyMs > 0) {
      setTimeout(run, this.asyncLatencyMs);
    } else {
      run();
    }
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
    if (typeof callback === 'function') callback();
  }

  clear(callback) {
    this.store.clear();
    if (typeof callback === 'function') callback();
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

if (typeof globalThis.MutationObserver === 'undefined') {
  globalThis.MutationObserver = MockMutationObserver;
}

// =============================================================================
// DOM Setup Helpers
// =============================================================================

function setupPopupDOM() {
  const doc = new MockDocument();

  // Active Queue Elements
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

  // Radio Options
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

  // Saved Session Elements
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

function setupYouTubeContentDOM() {
  const doc = new MockDocument();
  const win = new MockWindow(doc);

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

  // Add sample video cards
  for (let i = 0; i < 5; i++) {
    const card = doc.createElement('ytd-rich-item-renderer');
    const thumb = doc.createElement('div');
    thumb.className = 'ytd-thumbnail';
    const link = doc.createElement('a');
    link.id = 'thumbnail';
    link.setAttribute('href', `/watch?v=vidtest0000${i}`);
    thumb.appendChild(link);
    card.appendChild(thumb);
    contents.appendChild(card);
  }

  return { doc, win, masthead, pageManager, richGrid, contents };
}

// =============================================================================
// TEST SUITES
// =============================================================================

describe('Milestone M4 Challenger 2 Empirical Stress Test Suite', () => {

  // ---------------------------------------------------------------------------
  // Suite 1: High-Frequency Storage Events Stress
  // ---------------------------------------------------------------------------
  describe('Suite 1: High-Frequency Storage Events Stress', () => {
    test('1.1: Burst of 120 rapid storage.onChanged updates maintains strict DOM coherence', () => {
      const dom = setupPopupDOM();
      const mockChrome = new MockChrome();
      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });
      popup.init();

      // Fire 120 interleaved storage updates in rapid succession
      for (let i = 0; i < 120; i++) {
        const changes = {};

        // Alternating payload types
        if (i % 3 === 0) {
          const count = i % 25;
          changes[StorageKeys.ACTIVE_QUEUE] = {
            newValue: {
              videoIds: Array.from({ length: count }, (_, idx) => `vid_${i}_${idx}`),
              count,
              currentIndex: count > 0 ? (i % count) : 0
            }
          };
        } else if (i % 3 === 1) {
          const sessionCount = (i % 10);
          changes[StorageKeys.SAVED_SESSION] = {
            newValue: sessionCount > 0 ? {
              videoIds: Array.from({ length: sessionCount }, (_, idx) => `saved_${i}_${idx}`),
              count: sessionCount,
              savedAt: Date.now() - (i * 60000),
              currentIndex: 0
            } : null
          };
        } else {
          const modes = ['badge_and_dim', 'hide', 'badge_only'];
          changes[StorageKeys.PREFERENCES] = {
            newValue: {
              feedTreatmentMode: modes[i % modes.length],
              duplicateGuardEnabled: true
            }
          };
        }

        mockChrome.storage.local.changeListeners.forEach(listener => {
          listener(changes, 'local');
        });
      }

      // Final canonical state update
      const finalActiveQueue = {
        videoIds: ['dQw4w9WgXcQ', 'abc12345678', 'xyz98765432'],
        currentIndex: 1,
        count: 3
      };
      const finalSavedSession = {
        videoIds: ['sess0000001', 'sess0000002', 'sess0000003', 'sess0000004'],
        currentIndex: 0,
        count: 4,
        savedAt: Date.now() - 300000 // 5 minutes ago
      };
      const finalPreferences = {
        feedTreatmentMode: 'hide',
        duplicateGuardEnabled: true
      };

      mockChrome.storage.local.changeListeners.forEach(listener => {
        listener({
          [StorageKeys.ACTIVE_QUEUE]: { newValue: finalActiveQueue },
          [StorageKeys.SAVED_SESSION]: { newValue: finalSavedSession },
          [StorageKeys.PREFERENCES]: { newValue: finalPreferences }
        }, 'local');
      });

      // Strict DOM state assertions
      assert.equal(dom.queueCount.textContent, '3 videos', 'Queue count matches final payload');
      assert.equal(dom.playingIndex.textContent, 'Video 2 of 3', 'Playing index matches 1-based display');
      assert.equal(dom.queueLivePill.textContent, 'LIVE', 'Pill text reflects live queue');
      assert.equal(dom.queueLivePill.className, 'live-pill active', 'Pill class is active');

      assert.equal(dom.savedCount.textContent, '4 videos', 'Saved count matches final payload');
      assert.equal(dom.savedTime.textContent, '5m ago', 'Relative time correctly formatted');
      assert.equal(dom.sessionStatusPill.textContent, 'READY', 'Session status pill is READY');
      assert.equal(dom.sessionStatusPill.className, 'status-pill ready', 'Session status pill has ready class');
      assert.equal(dom.restoreBtn.disabled, false, 'Restore button is enabled when session has videos');

      assert.equal(dom.radioHide.checked, true, 'Hide radio button is checked');
      assert.equal(dom.radioBadgeAndDim.checked, false, 'Badge and dim radio is unchecked');
      assert.equal(dom.radioBadgeOnly.checked, false, 'Badge only radio is unchecked');

      popup.destroy();
    });

    test('1.2: Rapid active/idle and ready/none transitions smoothly settle without stuck state', () => {
      const dom = setupPopupDOM();
      const mockChrome = new MockChrome();
      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });
      popup.init();

      // Rapidly toggle active queue between 0 and 10 items 50 times
      for (let i = 0; i < 50; i++) {
        const isEmpty = (i % 2 === 0);
        mockChrome.storage.local.changeListeners.forEach(listener => {
          listener({
            [StorageKeys.ACTIVE_QUEUE]: {
              newValue: isEmpty ? { videoIds: [], count: 0, currentIndex: 0 } : { videoIds: ['vid1'], count: 1, currentIndex: 0 }
            },
            [StorageKeys.SAVED_SESSION]: {
              newValue: isEmpty ? null : { videoIds: ['vid1'], count: 1, savedAt: Date.now() }
            }
          }, 'local');
        });
      }

      // Settled to empty
      mockChrome.storage.local.changeListeners.forEach(listener => {
        listener({
          [StorageKeys.ACTIVE_QUEUE]: { newValue: { videoIds: [], count: 0, currentIndex: 0 } },
          [StorageKeys.SAVED_SESSION]: { newValue: null }
        }, 'local');
      });

      assert.equal(dom.queueCount.textContent, '0 videos');
      assert.equal(dom.playingIndex.textContent, '—');
      assert.equal(dom.queueLivePill.textContent, 'IDLE');
      assert.equal(dom.queueLivePill.className, 'live-pill idle');
      assert.equal(dom.savedCount.textContent, 'None');
      assert.equal(dom.savedTime.textContent, '—');
      assert.equal(dom.sessionStatusPill.textContent, 'NONE');
      assert.equal(dom.restoreBtn.disabled, true);

      popup.destroy();
    });

    test('1.3: ContentMain reacts safely to 100+ rapid cross-tab storage sync events', async () => {
      const { doc, win } = setupYouTubeContentDOM();
      const mockChrome = new MockChrome();

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockChrome.storage.local,
        storageOnChanged: mockChrome.storage.onChanged
      });
      await app.init();

      // Trigger 100 rapid preference and queue updates to ContentMain
      for (let i = 0; i < 100; i++) {
        const mode = i % 2 === 0 ? 'hide' : 'badge_only';
        await mockChrome.storage.local.set({
          [StorageKeys.PREFERENCES]: { feedTreatmentMode: mode, duplicateGuardEnabled: true },
          [StorageKeys.ACTIVE_QUEUE]: { videoIds: [`vidtest00000`], currentIndex: 0, count: 1 }
        });
      }

      // Final mode: badge_and_dim
      await mockChrome.storage.local.set({
        [StorageKeys.PREFERENCES]: { feedTreatmentMode: 'badge_and_dim', duplicateGuardEnabled: true },
        [StorageKeys.ACTIVE_QUEUE]: { videoIds: ['vidtest00000'], currentIndex: 0, count: 1 }
      });

      // Verify FeedDecorator received the final mode
      assert.equal(app.feedDecorator.getMode(), 'badge_and_dim');

      app.destroy();
    });

    test('1.4: Non-local storage changes (sync/managed) are ignored by PopupController', () => {
      const dom = setupPopupDOM();
      const mockChrome = new MockChrome();
      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });
      popup.init();

      // Dispatch changes with areaName='sync'
      mockChrome.storage.local.changeListeners.forEach(listener => {
        listener({
          [StorageKeys.ACTIVE_QUEUE]: {
            newValue: { videoIds: ['syncVid00001'], count: 1, currentIndex: 0 }
          }
        }, 'sync');
      });

      // DOM must remain at initial state
      assert.equal(dom.queueCount.textContent, '0 videos');
      assert.equal(dom.queueLivePill.textContent, 'IDLE');

      popup.destroy();
    });

    test('1.5: Out-of-bounds currentIndex (> count) clamps gracefully to count', () => {
      const dom = setupPopupDOM();
      const mockChrome = new MockChrome();
      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });
      popup.init();

      mockChrome.storage.local.changeListeners.forEach(listener => {
        listener({
          [StorageKeys.ACTIVE_QUEUE]: {
            newValue: {
              videoIds: ['vid00000001', 'vid00000002', 'vid00000003'],
              count: 3,
              currentIndex: 99
            }
          }
        }, 'local');
      });

      // displayIndex = Math.min(currentIndex + 1, count) = Math.min(100, 3) = 3
      assert.equal(dom.queueCount.textContent, '3 videos');
      assert.equal(dom.playingIndex.textContent, 'Video 3 of 3');

      popup.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 2: Rapid Radio Mode Switching
  // ---------------------------------------------------------------------------
  describe('Suite 2: Rapid Radio Mode Switching', () => {
    test('2.1: 60 rapid radio switches in tight loop write correct sequence to storage', async () => {
      const dom = setupPopupDOM();
      const mockChrome = new MockChrome();
      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });
      popup.init();

      // Preset other preferences to verify they are preserved
      await mockChrome.storage.local.set({
        [StorageKeys.PREFERENCES]: {
          feedTreatmentMode: 'badge_and_dim',
          duplicateGuardEnabled: true,
          showRestoreBanner: true
        }
      });

      const modes = ['hide', 'badge_only', 'badge_and_dim'];
      for (let i = 0; i < 60; i++) {
        const targetMode = modes[i % modes.length];
        const radio = dom.doc.querySelector(`input[name="feedTreatmentMode"][value="${targetMode}"]`);
        radio.checked = true;
        const changeEvent = new MockEvent('change', { bubbles: true });
        radio.dispatchEvent(changeEvent);
      }

      // Mode after 60 changes (index 59: 59 % 3 = 2 => 'badge_and_dim')
      // Let's do one explicit final change to 'hide'
      dom.radioHide.checked = true;
      dom.radioHide.dispatchEvent(new MockEvent('change', { bubbles: true }));

      // Verify chrome.storage.local has final mode and preserved flags
      const stored = await new Promise(res => mockChrome.storage.local.get(StorageKeys.PREFERENCES, res));
      const prefs = stored[StorageKeys.PREFERENCES];
      assert.equal(prefs.feedTreatmentMode, 'hide');
      assert.equal(prefs.duplicateGuardEnabled, true, 'Preserved duplicateGuardEnabled');
      assert.equal(prefs.showRestoreBanner, true, 'Preserved showRestoreBanner');

      popup.destroy();
    });

    test('2.2: Mode switches survive simulated async storage read/write latency', async () => {
      const dom = setupPopupDOM();
      const mockChrome = new MockChrome();
      mockChrome.storage.local.asyncLatencyMs = 2; // 2ms latency

      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });
      popup.init();

      // Rapidly switch 3 times within 1ms
      dom.radioHide.checked = true;
      dom.radioHide.dispatchEvent(new MockEvent('change', { bubbles: true }));

      dom.radioBadgeOnly.checked = true;
      dom.radioBadgeOnly.dispatchEvent(new MockEvent('change', { bubbles: true }));

      dom.radioBadgeAndDim.checked = true;
      dom.radioBadgeAndDim.dispatchEvent(new MockEvent('change', { bubbles: true }));

      // Wait 30ms for all async sets to resolve
      await new Promise(r => setTimeout(r, 30));

      const stored = await new Promise(res => mockChrome.storage.local.get(StorageKeys.PREFERENCES, res));
      const prefs = stored[StorageKeys.PREFERENCES];
      assert.ok(prefs, 'Preferences exist in storage');
      assert.ok(['badge_and_dim', 'badge_only', 'hide'].includes(prefs.feedTreatmentMode));

      popup.destroy();
    });

    test('2.3: Redundant clicks on already checked radio do not corrupt state', async () => {
      const dom = setupPopupDOM();
      const mockChrome = new MockChrome();
      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });
      popup.init();

      // Click badge_and_dim 10 times consecutively
      for (let i = 0; i < 10; i++) {
        dom.radioBadgeAndDim.checked = true;
        dom.radioBadgeAndDim.dispatchEvent(new MockEvent('change', { bubbles: true }));
      }

      const stored = await new Promise(res => mockChrome.storage.local.get(StorageKeys.PREFERENCES, res));
      assert.equal(stored[StorageKeys.PREFERENCES].feedTreatmentMode, 'badge_and_dim');

      popup.destroy();
    });

    test('2.4: handleModeChange safely initializes preferences when storage is initially empty', async () => {
      const dom = setupPopupDOM();
      const mockChrome = new MockChrome();
      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });
      popup.init();

      // Storage has no preferences initially
      dom.radioBadgeOnly.checked = true;
      dom.radioBadgeOnly.dispatchEvent(new MockEvent('change', { bubbles: true }));

      const stored = await new Promise(res => mockChrome.storage.local.get(StorageKeys.PREFERENCES, res));
      assert.ok(stored[StorageKeys.PREFERENCES]);
      assert.equal(stored[StorageKeys.PREFERENCES].feedTreatmentMode, 'badge_only');

      popup.destroy();
    });

    test('2.5: Concurrent mode change while storage.onChanged fires externally retains user selection', async () => {
      const dom = setupPopupDOM();
      const mockChrome = new MockChrome();
      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });
      popup.init();

      // Set initial
      await mockChrome.storage.local.set({
        [StorageKeys.PREFERENCES]: { feedTreatmentMode: 'badge_and_dim' }
      });

      // User selects 'hide'
      dom.radioHide.checked = true;
      dom.radioHide.dispatchEvent(new MockEvent('change', { bubbles: true }));

      // External storage.onChanged event fires for unrelated key
      mockChrome.storage.local.changeListeners.forEach(listener => {
        listener({
          [StorageKeys.ACTIVE_QUEUE]: { newValue: { videoIds: ['newVid00000'], count: 1 } }
        }, 'local');
      });

      const stored = await new Promise(res => mockChrome.storage.local.get(StorageKeys.PREFERENCES, res));
      assert.equal(stored[StorageKeys.PREFERENCES].feedTreatmentMode, 'hide');

      popup.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 3: Rapid SPA Navigation Burst
  // ---------------------------------------------------------------------------
  describe('Suite 3: Rapid SPA Navigation Burst', () => {
    test('3.1: 50 rapid SPA navigation events debounces deferred pass and creates zero duplicate observers', async () => {
      const { doc, win } = setupYouTubeContentDOM();
      const mockChrome = new MockChrome();

      // Seed saved session so banner could potentially mount
      await mockChrome.storage.local.set({
        [StorageKeys.SAVED_SESSION]: {
          videoIds: ['sessVid0001', 'sessVid0002'],
          count: 2,
          savedAt: Date.now() - 60000,
          currentIndex: 0
        },
        [StorageKeys.ACTIVE_QUEUE]: { videoIds: [], count: 0, currentIndex: 0 }
      });

      const initialObserverCount = MockMutationObserver.instances.length;

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockChrome.storage.local,
        storageOnChanged: mockChrome.storage.onChanged
      });
      await app.init();

      const baseObserverCount = MockMutationObserver.instances.length;

      // Fire burst of 50 navigation events in rapid loop
      const eventNames = ['yt-navigate-finish', 'yt-page-data-updated', 'popstate'];
      for (let i = 0; i < 50; i++) {
        const evName = eventNames[i % eventNames.length];
        win.dispatchEvent(new MockEvent(evName));
      }

      // Immediate check: zero duplicate banners in DOM
      const bannersImmediate = doc.querySelectorAll('#yqp-restore-banner');
      assert.ok(bannersImmediate.length <= 1, `Expected at most 1 banner during burst, got ${bannersImmediate.length}`);

      // Wait 250ms for the 200ms debounced deferred timer to fire exactly once
      await new Promise(r => setTimeout(r, 250));

      // After debounce timer fires:
      const bannersAfter = doc.querySelectorAll('#yqp-restore-banner');
      assert.equal(bannersAfter.length, 1, 'Exactly one restore banner mounted');

      // Observers count must NOT have exploded (zero duplicate observers created during 50 events)
      const finalObserverCount = MockMutationObserver.instances.length;
      assert.equal(finalObserverCount, baseObserverCount, 'No duplicate MutationObservers spawned during navigation burst');

      app.destroy();
    });

    test('3.2: SPA navigation burst during active queue never surfaces restore banner', async () => {
      const { doc, win } = setupYouTubeContentDOM();
      const mockChrome = new MockChrome();

      // Seed active queue AND saved session
      await mockChrome.storage.local.set({
        [StorageKeys.ACTIVE_QUEUE]: { videoIds: ['activeVid01'], count: 1, currentIndex: 0 },
        [StorageKeys.SAVED_SESSION]: { videoIds: ['savedVid01'], count: 1, savedAt: Date.now() }
      });

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockChrome.storage.local,
        storageOnChanged: mockChrome.storage.onChanged
      });
      await app.init();

      // Fire 30 rapid navigation events
      for (let i = 0; i < 30; i++) {
        win.dispatchEvent(new MockEvent('yt-navigate-finish'));
      }

      await new Promise(r => setTimeout(r, 250));

      const banner = doc.querySelector('#yqp-restore-banner');
      assert.equal(banner, null, 'Banner must remain completely absent when active queue is populated');

      app.destroy();
    });

    test('3.3: Mid-burst destroy() cleanly halts pending debounce timer and unbinds listeners', async () => {
      const { doc, win } = setupYouTubeContentDOM();
      const mockChrome = new MockChrome();

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockChrome.storage.local,
        storageOnChanged: mockChrome.storage.onChanged
      });
      await app.init();

      // Fire 20 events
      for (let i = 0; i < 20; i++) {
        win.dispatchEvent(new MockEvent('yt-navigate-finish'));
      }

      // Destroy immediately while debounce timer is active
      app.destroy();
      assert.equal(app._navDeferredTimer, null, 'Pending timer is cleared on destroy()');

      // Fire 20 more events after destroy
      for (let i = 0; i < 20; i++) {
        assert.doesNotThrow(() => {
          win.dispatchEvent(new MockEvent('yt-navigate-finish'));
        });
      }

      // Wait 250ms to ensure no deferred pass runs
      await new Promise(r => setTimeout(r, 250));

      const banner = doc.querySelector('#yqp-restore-banner');
      assert.equal(banner, null, 'No banner injected after destroy');
    });

    test('3.4: Submodule exceptions during navigation evaluation are isolated and do not throw', async () => {
      const { doc, win } = setupYouTubeContentDOM();
      const mockChrome = new MockChrome();

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockChrome.storage.local,
        storageOnChanged: mockChrome.storage.onChanged
      });
      await app.init();

      // Corrupt feedDecorator scanAndDecorate to throw
      app.feedDecorator.scanAndDecorate = () => {
        throw new Error('Hostile DOM mutation fault');
      };

      // Dispatched navigation must not throw despite feedDecorator throwing
      assert.doesNotThrow(() => {
        win.dispatchEvent(new MockEvent('yt-navigate-finish'));
      });

      // Internal _runNavigationEvaluation isolates faults across all submodules
      app.queueObserver.rescan = () => {
        throw new Error('Panel query fault');
      };
      app.restoreController.checkRestoreAvailable = () => {
        throw new Error('Restore evaluation fault');
      };
      assert.doesNotThrow(() => {
        app._runNavigationEvaluation();
      });

      // Wait 250ms for deferred timer to also execute safely without throwing
      await new Promise(r => setTimeout(r, 250));

      app.destroy();
    });

    test('3.5: 100 rapid SPA navigation events across mixed route types settle cleanly', async () => {
      const { doc, win } = setupYouTubeContentDOM();
      const mockChrome = new MockChrome();

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockChrome.storage.local,
        storageOnChanged: mockChrome.storage.onChanged
      });
      await app.init();

      const routeEvents = ['yt-navigate-finish', 'yt-page-data-updated', 'popstate'];
      for (let i = 0; i < 100; i++) {
        const ev = routeEvents[i % routeEvents.length];
        win.dispatchEvent(new MockEvent(ev));
      }

      await new Promise(r => setTimeout(r, 250));

      assert.equal(app.isDestroyed, false);
      assert.equal(app.isInitialized, true);

      app.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 4: Corrupted Storage Resilience in Popup
  // ---------------------------------------------------------------------------
  describe('Suite 4: Corrupted Storage Resilience in Popup', () => {
    test('4.1: Corrupted yqp_active_queue payloads fall back gracefully without throws', () => {
      const dom = setupPopupDOM();
      const mockChrome = new MockChrome();
      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });
      popup.init();

      const corruptQueuePayloads = [
        null,
        undefined,
        '',
        12345,
        {},
        { videoIds: 'not_an_array', count: 'invalid' },
        { videoIds: null, count: -5 },
        { count: NaN, currentIndex: 'first' },
        { videoIds: [null, undefined, 123, {}], count: 4, currentIndex: 9999 }
      ];

      for (const payload of corruptQueuePayloads) {
        assert.doesNotThrow(() => {
          mockChrome.storage.local.changeListeners.forEach(listener => {
            listener({
              [StorageKeys.ACTIVE_QUEUE]: { newValue: payload }
            }, 'local');
          });
        }, `Must not throw on payload: ${JSON.stringify(payload)}`);
      }

      // Verify settled state after null payload
      mockChrome.storage.local.changeListeners.forEach(listener => {
        listener({ [StorageKeys.ACTIVE_QUEUE]: { newValue: null } }, 'local');
      });

      assert.equal(dom.queueCount.textContent, '0 videos');
      assert.equal(dom.playingIndex.textContent, '—');
      assert.equal(dom.queueLivePill.textContent, 'IDLE');
      assert.equal(dom.queueLivePill.className, 'live-pill idle');

      popup.destroy();
    });

    test('4.2: Corrupted yqp_saved_session payloads fall back gracefully with disabled restore button', () => {
      const dom = setupPopupDOM();
      const mockChrome = new MockChrome();
      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });
      popup.init();

      const corruptSessionPayloads = [
        null,
        undefined,
        'corrupted string',
        [],
        {},
        { videoIds: 'not_an_array' },
        { videoIds: [], savedAt: 'yesterday' },
        { videoIds: null, count: null, savedAt: -100 },
        { videoIds: ['too_short'], count: 1, savedAt: NaN }
      ];

      for (const payload of corruptSessionPayloads) {
        assert.doesNotThrow(() => {
          mockChrome.storage.local.changeListeners.forEach(listener => {
            listener({
              [StorageKeys.SAVED_SESSION]: { newValue: payload }
            }, 'local');
          });
        });
      }

      // Settled to null
      mockChrome.storage.local.changeListeners.forEach(listener => {
        listener({ [StorageKeys.SAVED_SESSION]: { newValue: null } }, 'local');
      });

      assert.equal(dom.savedCount.textContent, 'None');
      assert.equal(dom.savedTime.textContent, '—');
      assert.equal(dom.sessionStatusPill.textContent, 'NONE');
      assert.equal(dom.restoreBtn.disabled, true);

      // Clicking restore button on corrupted session is a safe no-op
      assert.doesNotThrow(() => {
        dom.restoreBtn.click();
      });

      popup.destroy();
    });

    test('4.3: Corrupted yqp_preferences payloads default safely to badge_and_dim', () => {
      const dom = setupPopupDOM();
      const mockChrome = new MockChrome();
      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });
      popup.init();

      const corruptPrefPayloads = [
        null,
        undefined,
        'invalid_string',
        1234,
        {},
        { feedTreatmentMode: null },
        { feedTreatmentMode: 'unknown_mode_xyz' },
        { feedTreatmentMode: '<script>alert(1)</script>' }
      ];

      for (const payload of corruptPrefPayloads) {
        assert.doesNotThrow(() => {
          mockChrome.storage.local.changeListeners.forEach(listener => {
            listener({
              [StorageKeys.PREFERENCES]: { newValue: payload }
            }, 'local');
          });
        });
      }

      // Default radio (badge_and_dim) remains checked or safe
      assert.doesNotThrow(() => {
        popup.updatePreferencesUI({ feedTreatmentMode: 'badge_and_dim' });
      });
      assert.equal(dom.radioBadgeAndDim.checked, true);

      popup.destroy();
    });

    test('4.4: buildRestoreUrl and formatTimestamp handle arbitrary extreme inputs', () => {
      // buildRestoreUrl resilience
      assert.equal(buildRestoreUrl(null), null);
      assert.equal(buildRestoreUrl(undefined), null);
      assert.equal(buildRestoreUrl([]), null);
      assert.equal(buildRestoreUrl('not an array'), null);
      assert.equal(buildRestoreUrl(['invalid_short_id']), null);
      assert.equal(buildRestoreUrl([{ id: 'abc' }]), null);

      const validUrl = buildRestoreUrl(['dQw4w9WgXcQ'], -50);
      assert.ok(validUrl.includes('index=0'), 'Negative index clamps to 0');

      const validUrlHigh = buildRestoreUrl(['dQw4w9WgXcQ'], 9999);
      assert.ok(validUrlHigh.includes('index=0'), 'Out of bounds index clamps to length-1');

      // formatTimestamp resilience
      assert.equal(formatTimestamp(null), 'None');
      assert.equal(formatTimestamp(undefined), 'None');
      assert.equal(formatTimestamp(0), 'None');
      assert.equal(formatTimestamp(-99999), 'None');
      assert.equal(formatTimestamp('yesterday'), 'None');
      assert.equal(formatTimestamp(NaN), 'None');
      assert.equal(formatTimestamp(Infinity), 'Just now', 'Infinite future timestamp safely returns Just now');
      assert.equal(formatTimestamp(Date.now() + 500000), 'Just now');
      assert.equal(formatTimestamp(Date.now() - 5000), 'Just now');
      assert.equal(formatTimestamp(Date.now() - 120000), '2m ago');
      assert.equal(formatTimestamp(Date.now() - 7200000), '2h ago');
    });

    test('4.5: handleRestoreClick fallback ladder: YouTube tab update, non-YouTube tab create, empty tabs, and window.open', async () => {
      const dom = setupPopupDOM();
      const mockChrome = new MockChrome();
      const mockWin = new MockWindow(dom.doc);

      const popup = new PopupController({
        document: dom.doc,
        window: mockWin,
        chrome: mockChrome
      });
      popup.init();

      // Case A: Active tab is YouTube -> updates active tab and closes popup
      mockChrome.tabs._tabs = [{ id: 101, url: 'https://www.youtube.com/feed/subscriptions' }];
      popup.currentSavedSession = { videoIds: ['dQw4w9WgXcQ'], currentIndex: 0, count: 1 };
      popup.handleRestoreClick();
      assert.ok(mockChrome.tabs._tabs[0].url.includes('watch_videos'));
      assert.equal(mockWin._closed, true);

      // Case B: Active tab is Google -> creates new tab and closes popup
      mockWin._closed = false;
      mockChrome.tabs._tabs = [{ id: 102, url: 'https://www.google.com/' }];
      popup.handleRestoreClick();
      assert.equal(mockChrome.tabs._tabs.length, 2);
      assert.ok(mockChrome.tabs._tabs[1].url.includes('watch_videos'));
      assert.equal(mockWin._closed, true);

      // Case C: chrome.tabs is null -> falls back to window.open
      mockWin._closed = false;
      const popupNoTabs = new PopupController({
        document: dom.doc,
        window: mockWin,
        chrome: { storage: mockChrome.storage } // no tabs property
      });
      popupNoTabs.currentSavedSession = { videoIds: ['dQw4w9WgXcQ'], currentIndex: 0, count: 1 };
      popupNoTabs.handleRestoreClick();
      assert.equal(mockWin._openedUrls.length, 1);
      assert.ok(mockWin._openedUrls[0].url.includes('watch_videos'));

      popup.destroy();
      popupNoTabs.destroy();
    });

    test('4.6: Large queue (70 videos) restore URL generation filters invalid IDs and caps at 50', () => {
      const longVideoIds = Array.from({ length: 70 }, (_, i) => {
        // 'vid' (3 chars) + 8 digits = 11 chars
        return i % 10 === 0 ? 'too_short' : `vid${String(i).padStart(8, '0')}`;
      });

      const url = buildRestoreUrl(longVideoIds, 25);
      assert.ok(url, 'Valid URL generated');
      assert.ok(url.startsWith('https://www.youtube.com/watch_videos?video_ids='));

      const match = url.match(/video_ids=([^&]+)/);
      assert.ok(match);
      const parsedIds = decodeURIComponent(match[1]).split(',');
      assert.ok(parsedIds.length <= 50, `Capped at 50, got ${parsedIds.length}`);
      assert.ok(parsedIds.every(id => id.length === 11 && !id.includes('too_short')), 'All IDs are strictly valid 11 chars');
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 5: Lifecycle Teardown & Idempotency
  // ---------------------------------------------------------------------------
  describe('Suite 5: Lifecycle Teardown & Idempotency', () => {
    test('5.1: Multiple __YQP__.destroy() and app.destroy() calls execute idempotently without errors', async () => {
      const { doc, win } = setupYouTubeContentDOM();
      const mockChrome = new MockChrome();

      // Seed globalThis.__YQP__
      globalThis.__YQP__ = globalThis.__YQP__ || {};

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockChrome.storage.local,
        storageOnChanged: mockChrome.storage.onChanged
      });
      await app.init();

      globalThis.__YQP__.instance = app;
      globalThis.__YQP__.destroy = () => app.destroy();

      assert.equal(app.isInitialized, true);
      assert.equal(app.isDestroyed, false);

      // Call destroy 10 times consecutively
      for (let i = 0; i < 10; i++) {
        assert.doesNotThrow(() => {
          globalThis.__YQP__.destroy();
        }, `destroy() call ${i + 1} threw an exception`);
      }

      assert.equal(app.isDestroyed, true);
      assert.equal(app.isInitialized, false);
      assert.equal(globalThis.__YQP__.instance, null);
    });

    test('5.2: Teardown purges all DOM artifacts and unregisters listeners', async () => {
      const { doc, win, contents } = setupYouTubeContentDOM();
      const mockChrome = new MockChrome();

      // Seed active saved session so banner is injected
      await mockChrome.storage.local.set({
        [StorageKeys.SAVED_SESSION]: {
          videoIds: ['sessVid0001'],
          count: 1,
          savedAt: Date.now() - 30000,
          currentIndex: 0
        },
        [StorageKeys.ACTIVE_QUEUE]: { videoIds: [], count: 0, currentIndex: 0 }
      });

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockChrome.storage.local,
        storageOnChanged: mockChrome.storage.onChanged
      });
      await app.init();
      await app.restoreController.checkAndShowBanner();

      // Verify banner is mounted
      assert.ok(doc.querySelector('#yqp-restore-banner'), 'Banner mounted before destroy');

      app.destroy();

      // Verify banner is cleanly removed
      assert.equal(doc.querySelector('#yqp-restore-banner'), null, 'Banner removed after destroy');

      // Verify internal listeners and timer arrays are empty
      assert.equal(app._navigationHandlers.length, 0, 'Navigation handlers cleared');
      assert.equal(app._unsubscribers.length, 0, 'Unsubscribers cleared');
      assert.equal(app._navDeferredTimer, null, 'Deferred timer cleared');
    });

    test('5.3: Dispatched events after destroy do not trigger callbacks or errors', async () => {
      const { doc, win } = setupYouTubeContentDOM();
      const mockChrome = new MockChrome();

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockChrome.storage.local,
        storageOnChanged: mockChrome.storage.onChanged
      });
      await app.init();
      app.destroy();

      // Dispatch navigation events
      assert.doesNotThrow(() => {
        win.dispatchEvent(new MockEvent('yt-navigate-finish'));
        win.dispatchEvent(new MockEvent('popstate'));
        win.dispatchEvent(new MockEvent('yt-page-data-updated'));
      });

      // Dispatch storage changes
      assert.doesNotThrow(() => {
        mockChrome.storage.local.set({
          [StorageKeys.ACTIVE_QUEUE]: { videoIds: ['vid_after_destroy'], count: 1 }
        });
      });
    });

    test('5.4: PopupController destroy() unbinds storage listener and is idempotent', () => {
      const dom = setupPopupDOM();
      const mockChrome = new MockChrome();
      const popup = new PopupController({
        document: dom.doc,
        chrome: mockChrome
      });
      popup.init();

      assert.equal(mockChrome.storage.local.changeListeners.length, 1);

      // Destroy multiple times
      for (let i = 0; i < 5; i++) {
        assert.doesNotThrow(() => {
          popup.destroy();
        });
      }

      assert.equal(mockChrome.storage.local.changeListeners.length, 0, 'Listener cleanly removed');

      // Storage changes after destroy do not update popup DOM
      mockChrome.storage.local.changeListeners.forEach(listener => {
        listener({
          [StorageKeys.ACTIVE_QUEUE]: { newValue: { videoIds: ['test'], count: 1 } }
        }, 'local');
      });

      assert.equal(dom.queueCount.textContent, '0 videos', 'DOM unchanged after destroyed listener');
    });

    test('5.5: ContentMain re-initialization after destruction operates cleanly', async () => {
      const { doc, win } = setupYouTubeContentDOM();
      const mockChrome = new MockChrome();

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockChrome.storage.local,
        storageOnChanged: mockChrome.storage.onChanged
      });

      // Cycle 1
      await app.init();
      assert.equal(app.isInitialized, true);
      app.destroy();
      assert.equal(app.isDestroyed, true);

      // Cycle 2: Re-init
      await app.init();
      assert.equal(app.isInitialized, true);
      assert.equal(app.isDestroyed, false);
      assert.ok(app.feedDecorator, 'Submodules re-instantiated');
      assert.ok(app.restoreController, 'RestoreController re-instantiated');

      app.destroy();
      assert.equal(app.isDestroyed, true);
    });

    test('5.6: 30 consecutive init() and destroy() cycles on ContentMain execute cleanly without leak', async () => {
      const { doc, win } = setupYouTubeContentDOM();
      const mockChrome = new MockChrome();

      const app = new ContentMain({
        document: doc,
        window: win,
        storageArea: mockChrome.storage.local,
        storageOnChanged: mockChrome.storage.onChanged
      });

      for (let cycle = 0; cycle < 30; cycle++) {
        await app.init();
        assert.equal(app.isInitialized, true);
        assert.equal(app.isDestroyed, false);
        app.destroy();
        assert.equal(app.isInitialized, false);
        assert.equal(app.isDestroyed, true);
        assert.equal(app._navigationHandlers.length, 0);
        assert.equal(app._unsubscribers.length, 0);
        assert.equal(app._navDeferredTimer, null);
      }
    });
  });
});
