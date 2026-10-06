/**
 * YoutubeQueuePlus - Milestone M1 Foundation Verification Test Suite
 * Zero-dependency test harness using Node.js v24 native test runner.
 * Executable via: node test/m1_foundation.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// =============================================================================
// Lightweight In-Memory Mocks for Node.js Execution
// =============================================================================

/**
 * Mock Chrome Storage Local Area
 */
class MockChromeStorageArea {
  constructor() {
    this.store = new Map();
    this.changeListeners = [];
    this._failNextError = null;
  }

  _failNext(err) {
    this._failNextError = err;
  }

  async get(keys) {
    if (this._failNextError) {
      const err = this._failNextError;
      this._failNextError = null;
      throw err;
    }
    if (keys === null || keys === undefined) {
      const all = {};
      for (const [k, v] of this.store.entries()) {
        all[k] = JSON.parse(JSON.stringify(v));
      }
      return all;
    }
    if (typeof keys === 'string') {
      const val = this.store.has(keys) ? JSON.parse(JSON.stringify(this.store.get(keys))) : undefined;
      return { [keys]: val };
    }
    if (Array.isArray(keys)) {
      const res = {};
      for (const k of keys) {
        res[k] = this.store.has(k) ? JSON.parse(JSON.stringify(this.store.get(k))) : undefined;
      }
      return res;
    }
    if (typeof keys === 'object') {
      const res = {};
      for (const [k, defVal] of Object.entries(keys)) {
        res[k] = this.store.has(k) ? JSON.parse(JSON.stringify(this.store.get(k))) : defVal;
      }
      return res;
    }
    return {};
  }

  async set(items) {
    if (this._failNextError) {
      const err = this._failNextError;
      this._failNextError = null;
      throw err;
    }
    const changes = {};
    for (const [k, v] of Object.entries(items)) {
      const oldVal = this.store.has(k) ? JSON.parse(JSON.stringify(this.store.get(k))) : undefined;
      const newVal = JSON.parse(JSON.stringify(v));
      this.store.set(k, newVal);
      changes[k] = { oldValue: oldVal, newValue: newVal };
    }
    for (const listener of this.changeListeners) {
      try {
        listener(changes, 'local');
      } catch (_) {}
    }
  }

  async remove(keys) {
    const arr = Array.isArray(keys) ? keys : [keys];
    const changes = {};
    for (const k of arr) {
      if (this.store.has(k)) {
        const oldVal = JSON.parse(JSON.stringify(this.store.get(k)));
        this.store.delete(k);
        changes[k] = { oldValue: oldVal, newValue: undefined };
      }
    }
    for (const listener of this.changeListeners) {
      try {
        listener(changes, 'local');
      } catch (_) {}
    }
  }

  async clear() {
    const changes = {};
    for (const [k, v] of this.store.entries()) {
      changes[k] = { oldValue: JSON.parse(JSON.stringify(v)), newValue: undefined };
    }
    this.store.clear();
    for (const listener of this.changeListeners) {
      try {
        listener(changes, 'local');
      } catch (_) {}
    }
  }

  onChanged = {
    addListener: (fn) => {
      this.changeListeners.push(fn);
    },
    removeListener: (fn) => {
      const idx = this.changeListeners.indexOf(fn);
      if (idx !== -1) this.changeListeners.splice(idx, 1);
    }
  };
}

/**
 * Mock DOM Element supporting querySelector, dataset, classList, and hierarchy
 */
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

  matches(selector) {
    if (!selector) return false;
    const s = selector.trim();
    if (s.includes(',')) {
      return s.split(',').some(sub => this.matches(sub.trim()));
    }

    // Compound tag#id or tag.class or tag[attr]
    const tagMatch = s.match(/^([a-zA-Z0-9_-]+)(.*)$/);
    if (tagMatch) {
      const expectedTag = tagMatch[1].toUpperCase();
      const rest = tagMatch[2];
      if (this.tagName !== expectedTag) return false;
      if (!rest) return true;
      return this._matchesRest(rest);
    }
    return this._matchesRest(s);
  }

  _matchesRest(s) {
    if (!s) return true;
    if (s.startsWith('.')) {
      const cls = s.slice(1);
      return this._classList.has(cls) || (this.getAttribute('class') || '').split(/\s+/).includes(cls);
    }
    if (s.startsWith('#')) {
      return this.getAttribute('id') === s.slice(1);
    }
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1);
      if (inner.includes('*=')) {
        const [attr, val] = inner.split('*=');
        const cleanVal = val.replace(/^["']|["']$/g, '');
        const actual = this.getAttribute(attr);
        return actual !== null && actual.includes(cleanVal);
      }
      if (inner.includes('=')) {
        const [attr, val] = inner.split('=');
        const cleanVal = val.replace(/^["']|["']$/g, '');
        return this.getAttribute(attr) === cleanVal;
      }
      return this.hasAttribute(inner);
    }
    return this.tagName.toLowerCase() === s.toLowerCase();
  }

  closest(selector) {
    let curr = this;
    while (curr && (curr.nodeType === 1 || curr.tagName)) {
      if (curr.matches && curr.matches(selector)) return curr;
      curr = curr.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    if (selector.includes(',')) {
      const subSelectors = selector.split(',').map(s => s.trim());
      for (const sub of subSelectors) {
        const found = this.querySelector(sub);
        if (found) return found;
      }
      return null;
    }
    const parts = selector.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      for (const child of this.children) {
        if (child.matches && child.matches(parts[0])) return child;
        if (child.querySelector) {
          const found = child.querySelector(parts[0]);
          if (found) return found;
        }
      }
      return null;
    }
    // Simple 2-level descendant
    const firstMatch = this.querySelector(parts[0]);
    if (firstMatch) {
      return firstMatch.querySelector(parts.slice(1).join(' '));
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    const traverse = (node) => {
      for (const child of node.children) {
        if (child.matches && child.matches(selector)) results.push(child);
        if (child.children) traverse(child);
      }
    };
    traverse(this);
    return results;
  }
}

// Setup mock document environment
globalThis.document = {
  createElement: (tag) => new MockElement(tag),
  createTextNode: (text) => ({ textContent: String(text), nodeType: 3 }),
  querySelector: () => null,
  querySelectorAll: () => []
};

// =============================================================================
// Import Subject Modules
// =============================================================================
const PROJECT_ROOT = path.resolve(__dirname, '..');

const Constants = require(path.join(PROJECT_ROOT, 'src/shared/constants.js'));
const StorageKeysModule = require(path.join(PROJECT_ROOT, 'src/shared/storage_keys.js'));
const DomHelpers = require(path.join(PROJECT_ROOT, 'src/utils/dom_helpers.js'));
const UrlParser = require(path.join(PROJECT_ROOT, 'src/utils/url_parser.js'));
const StorageSyncModule = require(path.join(PROJECT_ROOT, 'src/modules/storage_sync.js'));
const ServiceWorker = require(path.join(PROJECT_ROOT, 'src/background/service_worker.js'));

// =============================================================================
// 1. Manifest V3 & Extension Assets Verification
// =============================================================================
describe('Suite 1: Manifest V3 & Extension Assets', () => {
  const manifestPath = path.join(PROJECT_ROOT, 'manifest.json');

  test('manifest.json exists and is valid JSON', () => {
    assert.strictEqual(fs.existsSync(manifestPath), true, 'manifest.json must exist');
    const content = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(content);

    assert.strictEqual(manifest.manifest_version, 3, 'Must be Manifest V3');
    assert.deepStrictEqual(manifest.permissions, ['storage'], 'Permissions must strictly contain "storage" only');
    assert.deepStrictEqual(manifest.host_permissions, ['*://*.youtube.com/*'], 'Host permissions must target YouTube only');
    assert.strictEqual(manifest.action.default_popup, 'popup/popup.html', 'Action popup must be declared');
    assert.strictEqual(manifest.background.service_worker, 'src/background/service_worker.js', 'Service worker must be declared');
  });

  test('All content scripts listed in manifest exist on disk in order', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(Array.isArray(manifest.content_scripts), 'content_scripts array required');
    const cs = manifest.content_scripts[0];

    assert.deepStrictEqual(cs.matches, ['*://*.youtube.com/*']);
    assert.strictEqual(cs.run_at, 'document_idle');

    for (const file of cs.js) {
      const fullPath = path.join(PROJECT_ROOT, file);
      assert.strictEqual(fs.existsSync(fullPath), true, `Content script must exist on disk: ${file}`);
    }
  });

  test('Extension icon PNGs exist and contain valid 8-byte PNG header', () => {
    const sizes = [16, 32, 48, 128];
    const pngMagic = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    for (const size of sizes) {
      const iconPath = path.join(PROJECT_ROOT, `assets/icons/icon-${size}.png`);
      assert.strictEqual(fs.existsSync(iconPath), true, `icon-${size}.png must exist`);
      const buffer = fs.readFileSync(iconPath);
      assert.ok(buffer.length > 50, `icon-${size}.png must have valid byte length`);
      assert.deepStrictEqual(buffer.subarray(0, 8), pngMagic, `icon-${size}.png must have valid PNG magic signature`);
    }

    const svgPath = path.join(PROJECT_ROOT, 'assets/icons/icon.svg');
    assert.strictEqual(fs.existsSync(svgPath), true, 'icon.svg must exist');
  });
});

// =============================================================================
// 2. Constants & Storage Keys Verification
// =============================================================================
describe('Suite 2: Shared Constants & Storage Keys', () => {
  test('Constants exports frozen SELECTORS, ATTRIBUTES, CLASSES, and LIMITS', () => {
    assert.ok(Constants.SELECTORS, 'SELECTORS must exist');
    assert.strictEqual(Constants.SELECTORS.QUEUE_PANEL, 'ytd-playlist-panel-renderer');
    assert.strictEqual(Constants.SELECTORS.FEED_ITEM_RICH, 'ytd-rich-item-renderer');

    assert.strictEqual(Constants.ATTRIBUTES.STATUS, 'data-yqp-status');
    assert.strictEqual(Constants.ATTRIBUTES.MODE, 'data-yqp-mode');
    assert.strictEqual(Constants.ATTRIBUTES.VIDEO_ID, 'data-yqp-video-id');

    assert.strictEqual(Constants.CLASSES.BADGE, 'yqp-queue-badge');
    assert.strictEqual(Constants.CLASSES.TOAST_CONTAINER, 'yqp-toast-container');
    assert.strictEqual(Constants.CLASSES.RESTORE_BANNER, 'yqp-restore-banner');

    assert.strictEqual(Constants.LIMITS.MAX_RESTORE_VIDEOS, 50);
    assert.strictEqual(Constants.LIMITS.VIDEO_ID_LENGTH, 11);
  });

  test('StorageKeys exports canonical keys and valid default models', () => {
    const { STORAGE_KEYS, DEFAULT_PREFERENCES, DEFAULT_QUEUE_STATE, DEFAULT_SAVED_SESSION } = StorageKeysModule;

    assert.strictEqual(STORAGE_KEYS.ACTIVE_QUEUE, 'yqp_active_queue');
    assert.strictEqual(STORAGE_KEYS.SAVED_SESSION, 'yqp_saved_session');
    assert.strictEqual(STORAGE_KEYS.PREFERENCES, 'yqp_preferences');
    assert.strictEqual(STORAGE_KEYS.SESSION_STATE, 'yqp_session_state');

    assert.strictEqual(DEFAULT_PREFERENCES.feedTreatmentMode, 'badge_and_dim');
    assert.strictEqual(DEFAULT_PREFERENCES.duplicateGuardEnabled, true);
    assert.strictEqual(DEFAULT_PREFERENCES.showRestoreBanner, true);

    assert.deepStrictEqual(DEFAULT_QUEUE_STATE.videoIds, []);
    assert.strictEqual(DEFAULT_QUEUE_STATE.currentIndex, 0);
    assert.strictEqual(DEFAULT_SAVED_SESSION.count, 0);
  });
});

// =============================================================================
// 3. URL Parser Verification
// =============================================================================
describe('Suite 3: URL Parser', () => {
  test('isValidVideoId validates exactly 11-char alphanumeric, hyphen, underscore', () => {
    assert.strictEqual(UrlParser.isValidVideoId('dQw4w9WgXcQ'), true);
    assert.strictEqual(UrlParser.isValidVideoId('9bZkp7q19f0'), true);
    assert.strictEqual(UrlParser.isValidVideoId('aB-_1234567'), true);

    assert.strictEqual(UrlParser.isValidVideoId('short'), false);
    assert.strictEqual(UrlParser.isValidVideoId('too_long_video_id_123'), false);
    assert.strictEqual(UrlParser.isValidVideoId('invalid$char'), false);
    assert.strictEqual(UrlParser.isValidVideoId(''), false);
    assert.strictEqual(UrlParser.isValidVideoId(null), false);
  });

  test('extractVideoId extracts from all standard YouTube URL variations', () => {
    assert.strictEqual(UrlParser.extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.strictEqual(UrlParser.extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=45s'), 'dQw4w9WgXcQ');
    assert.strictEqual(UrlParser.extractVideoId('https://www.youtube.com/watch?feature=shared&v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.strictEqual(UrlParser.extractVideoId('/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');

    assert.strictEqual(UrlParser.extractVideoId('https://www.youtube.com/shorts/9bZkp7q19f0'), '9bZkp7q19f0');
    assert.strictEqual(UrlParser.extractVideoId('/shorts/9bZkp7q19f0?feature=share'), '9bZkp7q19f0');

    assert.strictEqual(UrlParser.extractVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.strictEqual(UrlParser.extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.strictEqual(UrlParser.extractVideoId('https://www.youtube.com/live/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');

    assert.strictEqual(UrlParser.extractVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.strictEqual(UrlParser.extractVideoId('https://www.youtube.com/channel/UC1234567890'), null);
    assert.strictEqual(UrlParser.extractVideoId('javascript:void(0)'), null);
  });

  test('extractVideoIdFromElement extracts from DOM card element or child anchor', () => {
    const card = new MockElement('ytd-rich-item-renderer');
    const thumbAnchor = new MockElement('a');
    thumbAnchor.setAttribute('id', 'thumbnail');
    thumbAnchor.setAttribute('href', '/watch?v=9bZkp7q19f0');
    card.appendChild(thumbAnchor);

    assert.strictEqual(UrlParser.extractVideoIdFromElement(card), '9bZkp7q19f0');

    // Direct attribute priority
    card.setAttribute('data-yqp-video-id', 'dQw4w9WgXcQ');
    assert.strictEqual(UrlParser.extractVideoIdFromElement(card), 'dQw4w9WgXcQ');
  });

  test('buildRestoreUrl handles 50-item cap, 0-indexing, clamping, and URL encoding', () => {
    const ids = ['dQw4w9WgXcQ', '9bZkp7q19f0'];
    const url = UrlParser.buildRestoreUrl(ids, 1);
    assert.strictEqual(url, 'https://www.youtube.com/watch_videos?video_ids=dQw4w9WgXcQ%2C9bZkp7q19f0&index=1');

    // 0-indexing
    const url0 = UrlParser.buildRestoreUrl(ids, 0);
    assert.strictEqual(url0, 'https://www.youtube.com/watch_videos?video_ids=dQw4w9WgXcQ%2C9bZkp7q19f0&index=0');

    // Negative index clamped to 0
    const urlNeg = UrlParser.buildRestoreUrl(ids, -5);
    assert.strictEqual(urlNeg, 'https://www.youtube.com/watch_videos?video_ids=dQw4w9WgXcQ%2C9bZkp7q19f0&index=0');

    // Out of bounds index clamped to length - 1
    const urlOob = UrlParser.buildRestoreUrl(ids, 99);
    assert.strictEqual(urlOob, 'https://www.youtube.com/watch_videos?video_ids=dQw4w9WgXcQ%2C9bZkp7q19f0&index=1');

    // 50-item cap: 70 IDs provided
    const largeList = [];
    for (let i = 0; i < 70; i++) {
      largeList.push(`vid_${String(i).padStart(7, '0')}`);
    }
    const urlCapped = UrlParser.buildRestoreUrl(largeList, 60);
    const parsed = UrlParser.parseWatchVideosUrl(urlCapped);
    assert.strictEqual(parsed.videoIds.length, 50, 'Must cap list at 50 videos');
    assert.strictEqual(parsed.currentIndex, 49, 'Index must clamp to 49 for capped 50-item list');

    // Filters invalid IDs
    const mixed = ['invalid_id', 'dQw4w9WgXcQ', '', '9bZkp7q19f0'];
    const urlFiltered = UrlParser.buildRestoreUrl(mixed, 1);
    const parsedFiltered = UrlParser.parseWatchVideosUrl(urlFiltered);
    assert.deepStrictEqual(parsedFiltered.videoIds, ['dQw4w9WgXcQ', '9bZkp7q19f0']);
  });
});

// =============================================================================
// 4. DOM Helpers Verification
// =============================================================================
describe('Suite 4: DOM Helpers', () => {
  test('safeQuery and safeQueryAll handle safe DOM traversal', () => {
    const parent = new MockElement('div');
    const child1 = new MockElement('span');
    child1.setAttribute('class', 'target');
    const child2 = new MockElement('span');
    child2.setAttribute('class', 'target');
    parent.appendChild(child1);
    parent.appendChild(child2);

    assert.strictEqual(DomHelpers.safeQuery('.target', parent), child1);
    const all = DomHelpers.safeQueryAll('.target', parent);
    assert.strictEqual(all.length, 2);
    assert.ok(Array.isArray(all), 'safeQueryAll must return a true Array');

    // Null safety
    assert.strictEqual(DomHelpers.safeQuery('.missing', null), null);
    assert.deepStrictEqual(DomHelpers.safeQueryAll('.missing', null), []);
  });

  test('setDataset, getDataset, removeDataset, and hasDataset format data-yqp-* attributes', () => {
    const el = new MockElement('div');

    DomHelpers.setDataset(el, 'status', 'queued');
    DomHelpers.setDataset(el, 'mode', 'badge_and_dim');
    DomHelpers.setDataset(el, 'videoId', 'dQw4w9WgXcQ'); // camelCase converts to kebab-case

    assert.strictEqual(DomHelpers.getDataset(el, 'status'), 'queued');
    assert.strictEqual(DomHelpers.getDataset(el, 'mode'), 'badge_and_dim');
    assert.strictEqual(DomHelpers.getDataset(el, 'videoId'), 'dQw4w9WgXcQ');
    assert.strictEqual(DomHelpers.getDataset(el, 'video-id'), 'dQw4w9WgXcQ');
    assert.strictEqual(DomHelpers.hasDataset(el, 'status'), true);

    assert.strictEqual(el.getAttribute('data-yqp-status'), 'queued');
    assert.strictEqual(el.getAttribute('data-yqp-mode'), 'badge_and_dim');
    assert.strictEqual(el.getAttribute('data-yqp-video-id'), 'dQw4w9WgXcQ');

    DomHelpers.removeDataset(el, 'status');
    assert.strictEqual(DomHelpers.hasDataset(el, 'status'), false);
    assert.strictEqual(DomHelpers.getDataset(el, 'status'), null);
  });

  test('closest traverses parent hierarchy to locate matching ancestor', () => {
    const root = new MockElement('ytd-rich-grid-renderer');
    const card = new MockElement('ytd-rich-item-renderer');
    const btn = new MockElement('button');
    root.appendChild(card);
    card.appendChild(btn);

    assert.strictEqual(DomHelpers.closest(btn, 'ytd-rich-item-renderer'), card);
    assert.strictEqual(DomHelpers.closest(btn, 'ytd-rich-grid-renderer'), root);
    assert.strictEqual(DomHelpers.closest(btn, 'ytd-playlist-panel-renderer'), null);
  });

  test('debounce executes trailing invocation and supports cancel and flush', async () => {
    let callCount = 0;
    let lastVal = null;
    const debounced = DomHelpers.debounce((val) => {
      callCount++;
      lastVal = val;
    }, 40);

    debounced('a');
    debounced('b');
    debounced('c');
    assert.strictEqual(debounced.isPending(), true);
    assert.strictEqual(callCount, 0, 'Must not call synchronously in trailing mode');

    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(callCount, 1, 'Must execute exactly once after wait window');
    assert.strictEqual(lastVal, 'c', 'Must receive latest arguments');
    assert.strictEqual(debounced.isPending(), false);

    // Cancel test
    debounced('d');
    assert.strictEqual(debounced.isPending(), true);
    debounced.cancel();
    assert.strictEqual(debounced.isPending(), false);
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(callCount, 1, 'Cancelled call must not execute');

    // Flush test
    debounced('e');
    debounced.flush();
    assert.strictEqual(callCount, 2, 'Flush must execute immediately');
    assert.strictEqual(lastVal, 'e');
  });

  test('throttle restricts invocation frequency within window', async () => {
    let count = 0;
    const throttled = DomHelpers.throttle(() => {
      count++;
    }, 40);

    throttled(); // Executed immediately
    throttled(); // Ignored (scheduled trailing)
    throttled(); // Ignored (scheduled trailing)
    assert.strictEqual(count, 1, 'First throttle invocation is immediate');

    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(count, 2, 'Trailing invocation executes once after interval');
  });

  test('createElement and removeElement safely manipulate elements', () => {
    const el = DomHelpers.createElement('div', {
      className: 'test-class active',
      dataset: { status: 'queued' },
      style: { opacity: '0.4' },
      textContent: 'QUEUED'
    });

    assert.strictEqual(el.classList.contains('test-class'), true);
    assert.strictEqual(el.classList.contains('active'), true);
    assert.strictEqual(el.getAttribute('data-yqp-status'), 'queued');
    assert.strictEqual(el.style.opacity, '0.4');
    assert.strictEqual(el.textContent, 'QUEUED');

    const parent = new MockElement('section');
    parent.appendChild(el);
    assert.strictEqual(parent.children.length, 1);

    const removed = DomHelpers.removeElement(el);
    assert.strictEqual(removed, true);
    assert.strictEqual(parent.children.length, 0);
  });
});

// =============================================================================
// 5. Storage Sync Engine Integration Verification
// =============================================================================
describe('Suite 5: Storage Sync Engine', () => {
  let mockStorage;
  let storageSync;

  beforeEach(() => {
    mockStorage = new MockChromeStorageArea();
    globalThis.chrome = {
      storage: {
        local: mockStorage,
        onChanged: mockStorage.onChanged
      }
    };
    storageSync = new StorageSyncModule.StorageSync();
  });

  afterEach(() => {
    if (storageSync) {
      storageSync.destroy();
    }
    delete globalThis.chrome;
  });

  test('initPreferences writes default preferences when empty', async () => {
    const prefs = await storageSync.initPreferences();
    assert.strictEqual(prefs.feedTreatmentMode, 'badge_and_dim');
    assert.strictEqual(prefs.duplicateGuardEnabled, true);

    const stored = await mockStorage.get('yqp_preferences');
    assert.deepStrictEqual(stored.yqp_preferences, prefs);
  });

  test('saveActiveQueue buffers writes with debounce and diffs snapshots', async () => {
    await storageSync.initPreferences();

    const snapshot1 = {
      videoIds: ['dQw4w9WgXcQ', '9bZkp7q19f0'],
      currentIndex: 0,
      count: 2
    };

    storageSync.saveActiveQueue(snapshot1);
    // Before debounce timer, storage should not have the value yet
    const immediateStore = await mockStorage.get('yqp_active_queue');
    assert.strictEqual(immediateStore.yqp_active_queue, undefined);

    // Wait for debounce (300ms in production; flush() verifies immediate execution)
    await storageSync.flush();

    const stored1 = await mockStorage.get(['yqp_active_queue', 'yqp_saved_session']);
    assert.deepStrictEqual(stored1.yqp_active_queue.videoIds, snapshot1.videoIds);
    assert.deepStrictEqual(stored1.yqp_saved_session.videoIds, snapshot1.videoIds, 'Must dual-write saved session on non-empty queue');

    // Duplicate save with identical state should skip redundant write
    let writesCount = 0;
    const origSet = mockStorage.set.bind(mockStorage);
    mockStorage.set = async (items) => {
      writesCount++;
      return origSet(items);
    };

    storageSync.saveActiveQueue(snapshot1, true); // immediate
    assert.strictEqual(writesCount, 0, 'In-memory diffing must skip identical write');
  });

  test('Cross-tab chrome.storage.onChanged sync notifies subscribers', async () => {
    let notifiedQueue = null;
    storageSync.subscribeToActiveQueue((data) => {
      notifiedQueue = data;
    });

    // Simulate external write from another tab
    await mockStorage.set({
      yqp_active_queue: {
        videoIds: ['ext_vid_001'],
        currentIndex: 0,
        count: 1,
        lastUpdated: Date.now()
      }
    });

    assert.ok(notifiedQueue, 'Subscriber must be notified on external storage change');
    assert.deepStrictEqual(notifiedQueue.videoIds, ['ext_vid_001']);
  });

  test('Safe error recovery when storage quota fails', async () => {
    // Prime the preferences cache so getPreferences() doesn't consume _failNext on a read
    await storageSync.initPreferences();

    mockStorage._failNext(new Error('QUOTA_BYTES_PER_ITEM exceeded'));

    // Should catch gracefully without throwing unhandled rejection
    let caught = null;
    try {
      await storageSync.setPreferences({ feedTreatmentMode: 'hide' });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught !== null, 'Rejection returned to caller safely');
  });
});

// =============================================================================
// 6. Background Service Worker Verification
// =============================================================================
describe('Suite 6: Background Service Worker Contract', () => {
  test('service_worker.js exists and exports event listeners', () => {
    const swPath = path.join(PROJECT_ROOT, 'src/background/service_worker.js');
    assert.strictEqual(fs.existsSync(swPath), true, 'service_worker.js must exist on disk');
    const content = fs.readFileSync(swPath, 'utf8');

    assert.ok(content.includes('chrome.runtime.onInstalled'), 'Service worker must handle onInstalled');
    assert.ok(content.includes('chrome.storage.onChanged'), 'Service worker must handle storage onChanged');
    assert.ok(content.includes('setBadgeText'), 'Service worker must update badge counter text');
  });

  test('updateBadge and initializeDefaults manage badge counter and preferences', async () => {
    let currentBadgeText = null;
    let currentBadgeColor = null;
    const mockStorage = new MockChromeStorageArea();

    globalThis.chrome = {
      action: {
        setBadgeText: async ({ text }) => { currentBadgeText = text; },
        setBadgeBackgroundColor: async ({ color }) => { currentBadgeColor = color; }
      },
      storage: {
        local: mockStorage
      }
    };

    // 1. Initialize defaults
    await ServiceWorker.initializeDefaults();
    const stored = await mockStorage.get('yqp_preferences');
    assert.strictEqual(stored.yqp_preferences.feedTreatmentMode, 'badge_and_dim');
    assert.strictEqual(currentBadgeText, '');

    // 2. Queue with 5 items
    await ServiceWorker.updateBadge({ videoIds: ['a', 'b', 'c', 'd', 'e'], count: 5 });
    assert.strictEqual(currentBadgeText, '5');
    assert.strictEqual(currentBadgeColor, '#CC0000');

    // 3. Queue with 120 items
    await ServiceWorker.updateBadge({ count: 120 });
    assert.strictEqual(currentBadgeText, '99+');

    // 4. Queue cleared
    await ServiceWorker.updateBadge({ videoIds: [], count: 0 });
    assert.strictEqual(currentBadgeText, '');

    delete globalThis.chrome;
  });
});
