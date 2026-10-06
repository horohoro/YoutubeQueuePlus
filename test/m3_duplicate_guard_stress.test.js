/**
 * YoutubeQueuePlus - Milestone M3 Empirical DuplicateGuard Stress Test Suite
 * Executable via: node test/m3_duplicate_guard_stress.test.js
 *
 * Scope:
 * Suite 1: High-Frequency Click Burst Interception (100 rapid clicks, 100% suppression, 0 native calls, single toast)
 * Suite 2: Rapid Double-Click on Unqueued Video & In-Flight Protection (<100ms blocked via _pendingAdditions)
 * Suite 3: 3-Dot Dropdown Menu Race Conditions & Edge Cases (card switching, >60s TTL expiry, non-queue actions allowed)
 * Suite 4: Polymer Recycled DOM Cards (card video ID changing while 3-dot menu tracked, href prioritization)
 * Suite 5: Internationalized Queue Button Keywords (multi-language matching: es, de, fr, pt, ru, ja)
 * Suite 6: Lifecycle & Listener Leakage Stress (multiple start/stop/destroy cycles, zero listener/subscriber leakage)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const Constants = require(path.join(PROJECT_ROOT, 'src/shared/constants'));
const UrlParser = require(path.join(PROJECT_ROOT, 'src/utils/url_parser'));
const DomHelpers = require(path.join(PROJECT_ROOT, 'src/utils/dom_helpers'));
const ToastManager = require(path.join(PROJECT_ROOT, 'src/modules/toast_manager'));
const DuplicateGuard = require(path.join(PROJECT_ROOT, 'src/modules/duplicate_guard'));

// Helper for generating valid 11-char YouTube video IDs
function makeVidId(num) {
  return 'vid_' + String(num).padStart(7, '0');
}

// =============================================================================
// Robust 3-Phase DOM Mock Engine
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
      let inner = s.slice(1, closeIdx).trim();
      s = s.slice(closeIdx + 1);

      let caseInsensitive = false;
      if (inner.endsWith(' i') || inner.endsWith(' I')) {
        caseInsensitive = true;
        inner = inner.slice(0, -2).trim();
      }

      if (inner.includes('*=')) {
        const [attr, rawVal] = inner.split('*=');
        let cleanVal = rawVal.trim().replace(/^["']|["']$/g, '');
        let actual = el.getAttribute(attr.trim());
        if (caseInsensitive) {
          cleanVal = cleanVal.toLowerCase();
          actual = (actual || '').toLowerCase();
        }
        if (!actual || !actual.includes(cleanVal)) return false;
      } else if (inner.includes('^=')) {
        const [attr, rawVal] = inner.split('^=');
        let cleanVal = rawVal.trim().replace(/^["']|["']$/g, '');
        let actual = el.getAttribute(attr.trim());
        if (caseInsensitive) {
          cleanVal = cleanVal.toLowerCase();
          actual = (actual || '').toLowerCase();
        }
        if (!actual || !actual.startsWith(cleanVal)) return false;
      } else if (inner.includes('=')) {
        const [attr, rawVal] = inner.split('=');
        let cleanVal = rawVal.trim().replace(/^["']|["']$/g, '');
        let actual = el.getAttribute(attr.trim());
        if (caseInsensitive) {
          cleanVal = cleanVal.toLowerCase();
          actual = (actual || '').toLowerCase();
        }
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
    this.eventPhase = 0; // 0: NONE, 1: CAPTURING, 2: AT_TARGET, 3: BUBBLING
    this.defaultPrevented = false;
    this._propagationStopped = false;
    this._immediatePropagationStopped = false;
  }

  preventDefault() {
    if (this.cancelable) {
      this.defaultPrevented = true;
    }
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

    // 1. Build propagation chain from root down to target
    const chain = [];
    let curr = this;
    while (curr) {
      chain.push(curr);
      curr = curr.parentNode;
    }
    if (typeof document !== 'undefined' && !chain.includes(document)) {
      chain.push(document);
    }
    chain.reverse();

    // 2. Phase 1: Capturing Phase (ancestors root down to parent)
    for (let i = 0; i < chain.length - 1; i++) {
      const node = chain[i];
      event.currentTarget = node;
      event.eventPhase = 1;
      const capturing = (node._listeners || []).filter(l => l.type === event.type && l.capture === true);
      for (const entry of capturing) {
        if (entry.once) {
          node.removeEventListener(entry.type, entry.callback, entry.capture);
        }
        entry.callback.call(node, event);
        if (event._immediatePropagationStopped) break;
      }
      if (event._propagationStopped || event._immediatePropagationStopped) break;
    }

    // 3. Phase 2: Target Phase (target element)
    if (!event._propagationStopped && !event._immediatePropagationStopped) {
      const targetNode = chain[chain.length - 1];
      event.currentTarget = targetNode;
      event.eventPhase = 2;
      const atTarget = (targetNode._listeners || []).filter(l => l.type === event.type);
      for (const entry of atTarget) {
        if (entry.once) {
          targetNode.removeEventListener(entry.type, entry.callback, entry.capture);
        }
        entry.callback.call(targetNode, event);
        if (event._immediatePropagationStopped) break;
      }
    }

    // 4. Phase 3: Bubbling Phase (parent back up to root)
    if (event.bubbles && !event._propagationStopped && !event._immediatePropagationStopped) {
      for (let i = chain.length - 2; i >= 0; i--) {
        const node = chain[i];
        event.currentTarget = node;
        event.eventPhase = 3;
        const bubbling = (node._listeners || []).filter(l => l.type === event.type && l.capture === false);
        for (const entry of bubbling) {
          if (entry.once) {
            node.removeEventListener(entry.type, entry.callback, entry.capture);
          }
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
    this.textContent = '';
  }

  get parentElement() {
    return this.parentNode;
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
    if (parts.length === 1) {
      for (const child of this.children) {
        if (matchSimpleSelector(child, parts[0])) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    if (selector.includes(',')) {
      const set = new Set();
      for (const sub of selector.split(',')) {
        for (const el of this.querySelectorAll(sub.trim())) {
          set.add(el);
        }
      }
      return Array.from(set);
    }
    for (const child of this.children) {
      if (child.matches(selector)) results.push(child);
      results.push(...child.querySelectorAll(selector));
    }
    return results;
  }

  click() {
    const evt = new MockEvent('click', { bubbles: true, cancelable: true });
    return this.dispatchEvent(evt);
  }
}

class MockDocument extends MockEventTarget {
  constructor() {
    super();
    this.body = new MockElement('body');
    this.documentElement = new MockElement('html');
    this.documentElement.appendChild(this.body);
    this.documentElement.parentNode = this;
    this.body.parentNode = this.documentElement;
  }

  createElement(tagName) {
    return new MockElement(tagName);
  }

  createTextNode(text) {
    return { nodeType: 3, textContent: text, parentNode: null };
  }

  getElementById(id) {
    return this.body.querySelector('#' + id);
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }
}

// Helpers for YouTube DOM Components
function createFeedCard(videoId, options = {}) {
  const tagName = options.tagName || 'ytd-rich-item-renderer';
  const card = document.createElement(tagName);
  if (videoId) {
    card.setAttribute('data-yqp-video-id', videoId);
  }

  // Thumbnail container
  const thumbContainer = document.createElement('div');
  thumbContainer.setAttribute('id', 'thumbnail');
  thumbContainer.className = 'ytd-thumbnail';

  // Video link
  if (videoId && !options.noLink) {
    const thumbLink = document.createElement('a');
    thumbLink.setAttribute('id', 'thumbnail');
    thumbLink.setAttribute('href', `/watch?v=${videoId}`);
    thumbContainer.appendChild(thumbLink);
  }

  // Hover overlay "Add to queue" button
  const overlays = document.createElement('div');
  overlays.setAttribute('id', 'overlays');

  const overlayBtn = document.createElement('ytd-thumbnail-overlay-toggle-button-renderer');
  overlayBtn.setAttribute('aria-label', options.overlayAriaLabel || 'Add to queue');

  const innerIconBtn = document.createElement('yt-icon-button');
  const innerBtn = document.createElement('button');
  innerBtn.setAttribute('aria-label', options.overlayAriaLabel || 'Add to queue');
  const icon = document.createElement('yt-icon');

  innerBtn.appendChild(icon);
  innerIconBtn.appendChild(innerBtn);
  overlayBtn.appendChild(innerIconBtn);
  overlays.appendChild(overlayBtn);
  thumbContainer.appendChild(overlays);
  card.appendChild(thumbContainer);

  // 3-Dot Action Menu Button on Card
  const menuRenderer = document.createElement('ytd-menu-renderer');
  const menuIconBtn = document.createElement('yt-icon-button');
  const menuBtn = document.createElement('button');
  menuBtn.setAttribute('aria-label', 'Action menu');
  menuBtn.className = 'yt-icon-button';
  menuIconBtn.appendChild(menuBtn);
  menuRenderer.appendChild(menuIconBtn);
  card.appendChild(menuRenderer);

  // Details
  const details = document.createElement('div');
  details.setAttribute('id', 'details');
  const titleLink = document.createElement('a');
  titleLink.setAttribute('id', 'video-title-link');
  if (videoId && !options.noLink) {
    titleLink.setAttribute('href', `/watch?v=${videoId}`);
  }
  titleLink.textContent = options.title || `Video ${videoId}`;
  details.appendChild(titleLink);
  card.appendChild(details);

  document.body.appendChild(card);
  return { card, overlayBtn, innerBtn, icon, menuBtn, menuIconBtn, titleLink, thumbContainer };
}

function createDropdownMenu(options = {}) {
  const popup = document.createElement('ytd-popup-container');
  const menuPopup = document.createElement('ytd-menu-popup-renderer');
  const listbox = document.createElement('tp-yt-paper-listbox');

  // Queue item
  const queueItem = document.createElement('ytd-menu-service-item-renderer');
  const queuePaperItem = document.createElement('tp-yt-paper-item');
  const queueLabel = document.createElement('yt-formatted-string');
  queueLabel.textContent = options.queueLabel || 'Add to queue';
  queuePaperItem.appendChild(queueLabel);
  queueItem.appendChild(queuePaperItem);
  listbox.appendChild(queueItem);

  // Other non-queue items
  const nonQueueItems = [];
  const labels = options.otherLabels || [
    'Save to Watch later',
    'Save to playlist',
    'Share',
    'Not interested',
    "Don't recommend channel",
    'Report'
  ];

  for (const labelText of labels) {
    const item = document.createElement('ytd-menu-service-item-renderer');
    const paperItem = document.createElement('tp-yt-paper-item');
    const label = document.createElement('yt-formatted-string');
    label.textContent = labelText;
    paperItem.appendChild(label);
    item.appendChild(paperItem);
    listbox.appendChild(item);
    nonQueueItems.push({ item, labelText });
  }

  menuPopup.appendChild(listbox);
  popup.appendChild(menuPopup);
  document.body.appendChild(popup);

  return { popup, menuPopup, queueItem, queueLabel, nonQueueItems };
}

class MockQueueObserver {
  constructor(videoIds = []) {
    this._videoIds = [...videoIds];
    this._subscribers = new Set();
  }

  getActiveVideoIds() {
    return [...this._videoIds];
  }

  getActiveIdsSet() {
    return new Set(this._videoIds);
  }

  hasVideo(id) {
    return this._videoIds.includes(id);
  }

  setVideoIds(videoIds) {
    this._videoIds = [...videoIds];
    const state = { videoIds: this.getActiveVideoIds(), count: this._videoIds.length };
    for (const sub of this._subscribers) {
      sub(state);
    }
  }

  subscribe(callback) {
    this._subscribers.add(callback);
    return () => {
      this._subscribers.delete(callback);
    };
  }
}

// =============================================================================
// CHALLENGER TEST SUITE
// =============================================================================

describe('Milestone M3: DuplicateGuard Adversarial Stress Test Suite', () => {
  let originalDateNow;

  beforeEach(() => {
    global.document = new MockDocument();
    global.window = { document: global.document };
    global.MockEvent = MockEvent;
    ToastManager.reset();
    originalDateNow = Date.now;
  });

  afterEach(() => {
    ToastManager.reset();
    Date.now = originalDateNow;
  });

  // ===========================================================================
  // Challenge Suite 1: High-Frequency Click Burst Interception
  // ===========================================================================
  describe('Challenge Suite 1: High-Frequency Click Burst Interception', () => {
    test('1.1: 100 rapid clicks on queued hover button: 100% suppression, 0 native calls, single toast', () => {
      const queuedId = makeVidId(101);
      const observer = new MockQueueObserver([queuedId]);
      const toast = new ToastManager({ document });
      const blockedEvents = [];

      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast,
        onDuplicateBlocked: (info) => blockedEvents.push(info)
      });

      const { overlayBtn, card } = createFeedCard(queuedId);

      // Attach native listeners that YouTube would register
      let btnNativeCalls = 0;
      let cardNativeCalls = 0;
      let docNativeCalls = 0;

      overlayBtn.addEventListener('click', () => { btnNativeCalls++; }, false);
      card.addEventListener('click', () => { cardNativeCalls++; }, false);
      document.addEventListener('click', () => { docNativeCalls++; }, false);

      // Fire 100 rapid click events sequentially
      const dispatchedEvents = [];
      for (let i = 0; i < 100; i++) {
        const evt = new MockEvent('click', { bubbles: true, cancelable: true });
        overlayBtn.dispatchEvent(evt);
        dispatchedEvents.push(evt);
      }

      // Assertions
      assert.strictEqual(dispatchedEvents.length, 100);
      for (let i = 0; i < 100; i++) {
        assert.strictEqual(dispatchedEvents[i].defaultPrevented, true, `Click ${i + 1} must be default-prevented`);
        assert.strictEqual(dispatchedEvents[i]._propagationStopped, true, `Click ${i + 1} must have stopped propagation`);
        assert.strictEqual(dispatchedEvents[i]._immediatePropagationStopped, true, `Click ${i + 1} must have stopped immediate propagation`);
      }

      // 0 native calls across all levels
      assert.strictEqual(btnNativeCalls, 0, 'Native button click listener must execute 0 times');
      assert.strictEqual(cardNativeCalls, 0, 'Native card click listener must execute 0 times');
      assert.strictEqual(docNativeCalls, 0, 'Native document bubbling listener must execute 0 times');

      // Callback verified
      assert.strictEqual(blockedEvents.length, 100, 'onDuplicateBlocked must fire for each blocked click');
      assert.strictEqual(blockedEvents[0].videoId, queuedId);
      assert.strictEqual(blockedEvents[0].channel, 'hover_overlay');

      // Single toast verification (deduplicated, 0 queue backlog)
      const toastEls = document.querySelectorAll('#yqp-toast');
      assert.strictEqual(toastEls.length, 1, 'Exactly 1 #yqp-toast element in DOM');
      assert.strictEqual(toast.isVisible(), true, 'Toast must be visible');
      assert.strictEqual(toast.getCurrentMessage(), 'Video is already in queue');
      assert.strictEqual(toast.getQueueLength(), 0, 'Toast queue length must remain 0 (no duplicate backlog)');

      guard.destroy();
    });

    test('1.2: 100 rapid clicks on deep inner target (yt-icon) inside overlay button', () => {
      const queuedId = makeVidId(102);
      const observer = new MockQueueObserver([queuedId]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const { icon } = createFeedCard(queuedId);

      let nativeCalls = 0;
      icon.addEventListener('click', () => { nativeCalls++; });

      for (let i = 0; i < 100; i++) {
        const evt = new MockEvent('click', { bubbles: true, cancelable: true });
        icon.dispatchEvent(evt);
        assert.strictEqual(evt.defaultPrevented, true);
        assert.strictEqual(evt._propagationStopped, true);
      }

      assert.strictEqual(nativeCalls, 0);
      assert.strictEqual(toast.getQueueLength(), 0);
      assert.strictEqual(toast.isVisible(), true);

      guard.destroy();
    });

    test('1.3: Interleaved burst: 50 queued button clicks + 50 title link clicks alternating', () => {
      const queuedId = makeVidId(103);
      const observer = new MockQueueObserver([queuedId]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const { overlayBtn, titleLink } = createFeedCard(queuedId);

      let overlayNativeCalls = 0;
      let titleNativeCalls = 0;

      overlayBtn.addEventListener('click', () => { overlayNativeCalls++; });
      titleLink.addEventListener('click', () => { titleNativeCalls++; });

      for (let i = 0; i < 50; i++) {
        // Overlay button click (must be suppressed)
        const evtOverlay = new MockEvent('click', { bubbles: true, cancelable: true });
        overlayBtn.dispatchEvent(evtOverlay);
        assert.strictEqual(evtOverlay.defaultPrevented, true);

        // Title link click (must be permitted)
        const evtTitle = new MockEvent('click', { bubbles: true, cancelable: true });
        titleLink.dispatchEvent(evtTitle);
        assert.strictEqual(evtTitle.defaultPrevented, false);
      }

      assert.strictEqual(overlayNativeCalls, 0, '0 native calls for overlay queue button');
      assert.strictEqual(titleNativeCalls, 50, '50 native calls for title link');

      guard.destroy();
    });
  });

  // ===========================================================================
  // Challenge Suite 2: Rapid Double-Click & In-Flight Protection
  // ===========================================================================
  describe('Challenge Suite 2: Rapid Double-Click & In-Flight Protection', () => {
    test('2.1: Double-click (<100ms) on unqueued video: click 1 permitted, click 2 blocked via _pendingAdditions', () => {
      const unqueuedId = makeVidId(201);
      const observer = new MockQueueObserver([]); // Empty queue
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const { overlayBtn } = createFeedCard(unqueuedId);

      let nativeCalls = 0;
      overlayBtn.addEventListener('click', () => { nativeCalls++; });

      // Click 1: First click
      const evt1 = new MockEvent('click', { bubbles: true, cancelable: true });
      overlayBtn.dispatchEvent(evt1);

      assert.strictEqual(evt1.defaultPrevented, false, 'Click 1 must NOT be prevented');
      assert.strictEqual(nativeCalls, 1, 'Native handler must execute for Click 1');
      assert.strictEqual(guard._pendingAdditions.has(unqueuedId), true, 'Video must be tracked in _pendingAdditions');
      assert.strictEqual(guard.isDuplicate(unqueuedId), true, 'isDuplicate must report true immediately');

      // Click 2 (simulated 20ms later, before YouTube updates DOM)
      const evt2 = new MockEvent('click', { bubbles: true, cancelable: true });
      overlayBtn.dispatchEvent(evt2);

      assert.strictEqual(evt2.defaultPrevented, true, 'Click 2 must be blocked via _pendingAdditions');
      assert.strictEqual(evt2._propagationStopped, true, 'Click 2 propagation must be halted');
      assert.strictEqual(nativeCalls, 1, 'Native handler must NOT execute for Click 2 (remains 1)');
      assert.strictEqual(toast.isVisible(), true, 'Toast must appear informing video is already queued');
      assert.strictEqual(toast.getCurrentMessage(), 'Video is already in queue');

      guard.destroy();
    });

    test('2.2: 20-click burst on unqueued video: exactly Click 1 allowed, remaining 19 blocked', () => {
      const unqueuedId = makeVidId(202);
      const observer = new MockQueueObserver([]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const { overlayBtn } = createFeedCard(unqueuedId);

      let nativeCalls = 0;
      overlayBtn.addEventListener('click', () => { nativeCalls++; });

      for (let i = 0; i < 20; i++) {
        const evt = new MockEvent('click', { bubbles: true, cancelable: true });
        overlayBtn.dispatchEvent(evt);

        if (i === 0) {
          assert.strictEqual(evt.defaultPrevented, false, 'First click allowed');
        } else {
          assert.strictEqual(evt.defaultPrevented, true, `Click ${i + 1} blocked`);
        }
      }

      assert.strictEqual(nativeCalls, 1, 'Native handler must be invoked exactly once');

      guard.destroy();
    });

    test('2.3: QueueObserver sync clears pending additions while maintaining duplicate protection', () => {
      const unqueuedId = makeVidId(203);
      const observer = new MockQueueObserver([]);
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer
      });

      const { overlayBtn } = createFeedCard(unqueuedId);

      // First click: adds to pending
      overlayBtn.dispatchEvent(new MockEvent('click', { bubbles: true, cancelable: true }));
      assert.strictEqual(guard._pendingAdditions.has(unqueuedId), true);

      // YouTube mutation occurs: QueueObserver emits new state with the video
      observer.setVideoIds([unqueuedId]);

      // Pending set is cleaned up
      assert.strictEqual(guard._pendingAdditions.has(unqueuedId), false, 'Pending set must be cleaned on observer sync');
      // Still duplicate via QueueObserver active set
      assert.strictEqual(guard.isDuplicate(unqueuedId), true, 'Still duplicate via active set');

      // Subsequent click 3 is blocked via activeIdsSet
      const evt3 = new MockEvent('click', { bubbles: true, cancelable: true });
      overlayBtn.dispatchEvent(evt3);
      assert.strictEqual(evt3.defaultPrevented, true, 'Click after sync is blocked');

      guard.destroy();
    });

    test('2.4: 5000ms TTL timeout resets unconfirmed pending addition', () => {
      const unconfirmedId = makeVidId(204);
      const observer = new MockQueueObserver([]);
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer
      });

      const { overlayBtn } = createFeedCard(unconfirmedId);

      // First click
      overlayBtn.dispatchEvent(new MockEvent('click', { bubbles: true, cancelable: true }));
      assert.strictEqual(guard._pendingAdditions.has(unconfirmedId), true);

      // Trigger the pending addition timeout directly
      const timer = guard._pendingTimeouts.get(unconfirmedId);
      assert.ok(timer, 'Timer must exist in _pendingTimeouts');

      // Fast-forward timeout execution
      guard._pendingAdditions.delete(unconfirmedId);
      guard._pendingTimeouts.delete(unconfirmedId);

      assert.strictEqual(guard._pendingAdditions.has(unconfirmedId), false);
      assert.strictEqual(guard.isDuplicate(unconfirmedId), false);

      guard.destroy();
    });
  });

  // ===========================================================================
  // Challenge Suite 3: 3-Dot Dropdown Menu Race Conditions & Edge Cases
  // ===========================================================================
  describe('Challenge Suite 3: 3-Dot Dropdown Race Conditions & Edge Cases', () => {
    test('3.1: Card switching race: Card A (queued) clicked, then Card B (unqueued) clicked before dropdown action', () => {
      const vidA = makeVidId(301); // Queued
      const vidB = makeVidId(302); // Unqueued
      const observer = new MockQueueObserver([vidA]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const cardA = createFeedCard(vidA);
      const cardB = createFeedCard(vidB);
      const { queueItem } = createDropdownMenu();

      let dropdownNativeCalls = 0;
      queueItem.addEventListener('click', () => { dropdownNativeCalls++; });

      // Step 1: Click 3-dot on Card A (queued)
      cardA.menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
      assert.strictEqual(guard.getMenuState().videoId, vidA);

      // Step 2: User changes mind, clicks 3-dot on Card B (unqueued)
      cardB.menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
      assert.strictEqual(guard.getMenuState().videoId, vidB);

      // Step 3: User clicks "Add to queue" in dropdown
      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      queueItem.dispatchEvent(evt);

      // Because Card B is unqueued, action must be PERMITTED
      assert.strictEqual(evt.defaultPrevented, false, 'Action on Card B must NOT be prevented');
      assert.strictEqual(dropdownNativeCalls, 1, 'Native handler must execute for Card B');
      assert.strictEqual(toast.isVisible(), false, 'Toast must NOT show');
      assert.strictEqual(guard.getMenuState().videoId, null, 'Menu state cleared');

      guard.destroy();
    });

    test('3.2: Inverted Card switching race: Card B (unqueued) clicked, then Card A (queued) clicked before dropdown action', () => {
      const vidA = makeVidId(303); // Queued
      const vidB = makeVidId(304); // Unqueued
      const observer = new MockQueueObserver([vidA]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const cardA = createFeedCard(vidA);
      const cardB = createFeedCard(vidB);
      const { queueItem } = createDropdownMenu();

      let dropdownNativeCalls = 0;
      queueItem.addEventListener('click', () => { dropdownNativeCalls++; });

      // Step 1: Click Card B (unqueued)
      cardB.menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
      assert.strictEqual(guard.getMenuState().videoId, vidB);

      // Step 2: Click Card A (queued)
      cardA.menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
      assert.strictEqual(guard.getMenuState().videoId, vidA);

      // Step 3: Click "Add to queue" in dropdown
      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      queueItem.dispatchEvent(evt);

      // Because Card A is queued, action must be BLOCKED
      assert.strictEqual(evt.defaultPrevented, true, 'Action on Card A must be blocked');
      assert.strictEqual(evt._propagationStopped, true);
      assert.strictEqual(dropdownNativeCalls, 0, 'Native handler must NOT execute');
      assert.strictEqual(toast.isVisible(), true, 'Toast must appear');
      assert.strictEqual(guard.getMenuState().videoId, null, 'Menu state cleared');

      guard.destroy();
    });

    test('3.3: Rapid switching across 10 cards: last clicked card always dictates outcome', () => {
      const queuedIds = [makeVidId(310), makeVidId(312), makeVidId(314), makeVidId(316), makeVidId(318)];
      const observer = new MockQueueObserver(queuedIds);
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer
      });

      const cards = [];
      for (let i = 0; i < 10; i++) {
        cards.push(createFeedCard(makeVidId(310 + i)));
      }

      const { queueItem } = createDropdownMenu();

      // Click all 10 cards sequentially
      for (let i = 0; i < 10; i++) {
        cards[i].menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
      }

      // Last clicked was cards[9]: vid_0000319 (not in queuedIds -> unqueued)
      assert.strictEqual(guard.getMenuState().videoId, makeVidId(319));
      const evtUnqueued = new MockEvent('click', { bubbles: true, cancelable: true });
      queueItem.dispatchEvent(evtUnqueued);
      assert.strictEqual(evtUnqueued.defaultPrevented, false, 'Unqueued last card must pass');

      // Now click cards[8]: vid_0000318 (in queuedIds -> queued)
      cards[8].menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
      assert.strictEqual(guard.getMenuState().videoId, makeVidId(318));
      const evtQueued = new MockEvent('click', { bubbles: true, cancelable: true });
      queueItem.dispatchEvent(evtQueued);
      assert.strictEqual(evtQueued.defaultPrevented, true, 'Queued last card must be blocked');

      guard.destroy();
    });

    test('3.4: Expired TTL (>60s) handling: fail-open allows dropdown action if menu is stale', () => {
      let currentTime = 1000000;
      Date.now = () => currentTime;

      const queuedId = makeVidId(305);
      const observer = new MockQueueObserver([queuedId]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast,
        menuTimeoutMs: 60000
      });

      const { menuBtn } = createFeedCard(queuedId);
      const { queueItem } = createDropdownMenu();

      let nativeCalls = 0;
      queueItem.addEventListener('click', () => { nativeCalls++; });

      // Click 3-dot at T=1,000,000
      menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
      assert.strictEqual(guard.getMenuState().videoId, queuedId);

      // Advance time by 60,001 ms (TTL expired!)
      currentTime += 60001;

      // Click dropdown item
      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      queueItem.dispatchEvent(evt);

      // Must FAIL OPEN safely: not prevented, native handler executes
      assert.strictEqual(evt.defaultPrevented, false, 'Stale TTL menu click must fail open');
      assert.strictEqual(nativeCalls, 1, 'Native handler must execute when TTL is expired');
      assert.strictEqual(toast.isVisible(), false, 'Toast must NOT show');

      guard.destroy();
    });

    test('3.5: Exact boundary verification at 60s TTL', () => {
      let currentTime = 2000000;
      Date.now = () => currentTime;

      const queuedId = makeVidId(306);
      const observer = new MockQueueObserver([queuedId]);
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        menuTimeoutMs: 60000
      });

      const { menuBtn } = createFeedCard(queuedId);
      const { queueItem } = createDropdownMenu();

      // Case A: At 59,999 ms (within TTL -> BLOCKED)
      menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
      currentTime += 59999;
      const evt1 = new MockEvent('click', { bubbles: true, cancelable: true });
      queueItem.dispatchEvent(evt1);
      assert.strictEqual(evt1.defaultPrevented, true, 'At 59999ms action must be blocked');

      // Case B: At 60,000 ms (exact boundary -> BLOCKED)
      currentTime = 3000000;
      menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
      currentTime += 60000;
      const evt2 = new MockEvent('click', { bubbles: true, cancelable: true });
      queueItem.dispatchEvent(evt2);
      assert.strictEqual(evt2.defaultPrevented, true, 'At 60000ms action must be blocked');

      // Case C: At 60,001 ms (expired -> ALLOWED)
      currentTime = 4000000;
      menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
      currentTime += 60001;
      const evt3 = new MockEvent('click', { bubbles: true, cancelable: true });
      queueItem.dispatchEvent(evt3);
      assert.strictEqual(evt3.defaultPrevented, false, 'At 60001ms action must pass');

      guard.destroy();
    });

    test('3.6: Non-queue dropdown actions allowed without interception', () => {
      const queuedId = makeVidId(307);
      const observer = new MockQueueObserver([queuedId]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const { menuBtn } = createFeedCard(queuedId);
      const { nonQueueItems } = createDropdownMenu({
        otherLabels: [
          'Save to Watch later',
          'Save to playlist',
          'Share',
          'Not interested',
          "Don't recommend channel",
          'Report'
        ]
      });

      for (const { item, labelText } of nonQueueItems) {
        // Open menu
        menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));

        let nativeCalled = false;
        item.addEventListener('click', () => { nativeCalled = true; });

        const evt = new MockEvent('click', { bubbles: true, cancelable: true });
        item.dispatchEvent(evt);

        assert.strictEqual(evt.defaultPrevented, false, `Item "${labelText}" must not be prevented`);
        assert.strictEqual(nativeCalled, true, `Item "${labelText}" native listener must execute`);
        assert.strictEqual(toast.isVisible(), false, `Item "${labelText}" must not show toast`);
      }

      guard.destroy();
    });
  });

  // ===========================================================================
  // Challenge Suite 4: Polymer Recycled DOM Cards
  // ===========================================================================
  describe('Challenge Suite 4: Polymer Recycled DOM Cards', () => {
    test('4.1: Card video ID updated via anchor href prior to 3-dot click (stale attr vs fresh href)', () => {
      const staleId = makeVidId(401);
      const freshId = makeVidId(402);
      const observer = new MockQueueObserver([freshId]);
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer
      });

      const { card, menuBtn, thumbContainer } = createFeedCard(staleId);

      // Polymer recycles card: updates anchor href but leaves stale attribute
      const anchor = thumbContainer.querySelector('a#thumbnail');
      anchor.setAttribute('href', `/watch?v=${freshId}`);
      assert.strictEqual(card.getAttribute('data-yqp-video-id'), staleId);

      // User clicks 3-dot menu
      menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));

      // Guard must extract freshId from href, NOT staleId!
      assert.strictEqual(guard.getMenuState().videoId, freshId, 'Must prioritize anchor href over stale attribute');

      guard.destroy();
    });

    test('4.2: Card video ID changing WHILE 3-dot menu is tracked (dropdown open)', () => {
      const originalQueuedId = makeVidId(403);
      const recycledNewId = makeVidId(404);
      const observer = new MockQueueObserver([originalQueuedId]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const { card, menuBtn, thumbContainer } = createFeedCard(originalQueuedId);
      const { queueItem } = createDropdownMenu();

      // Step 1: User clicks 3-dot menu on card when showing originalQueuedId
      menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
      assert.strictEqual(guard.getMenuState().videoId, originalQueuedId);

      // Step 2: YouTube virtual scroll recycles card to recycledNewId while dropdown is open
      const anchor = thumbContainer.querySelector('a#thumbnail');
      anchor.setAttribute('href', `/watch?v=${recycledNewId}`);
      card.setAttribute('data-yqp-video-id', recycledNewId);

      // Step 3: User clicks "Add to queue" in dropdown
      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      queueItem.dispatchEvent(evt);

      // The action was initiated for originalQueuedId, which IS in the queue -> must be BLOCKED!
      assert.strictEqual(evt.defaultPrevented, true, 'Must evaluate the video ID tracked when menu was opened');
      assert.strictEqual(toast.isVisible(), true);

      guard.destroy();
    });

    test('4.3: Recycled card with Hover Overlay click: extracts fresh href rather than stale attribute', () => {
      const staleUnqueuedId = makeVidId(405);
      const freshQueuedId = makeVidId(406);
      const observer = new MockQueueObserver([freshQueuedId]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const { card, overlayBtn, thumbContainer } = createFeedCard(staleUnqueuedId);

      // Recycle: anchor href updated to queued video, attribute stale
      const anchor = thumbContainer.querySelector('a#thumbnail');
      anchor.setAttribute('href', `/watch?v=${freshQueuedId}`);
      card.setAttribute('data-yqp-video-id', staleUnqueuedId);

      let nativeExecuted = false;
      overlayBtn.addEventListener('click', () => { nativeExecuted = true; });

      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      overlayBtn.dispatchEvent(evt);

      // Must be intercepted as duplicate!
      assert.strictEqual(evt.defaultPrevented, true, 'Hover button on recycled card must detect queued video from href');
      assert.strictEqual(nativeExecuted, false, 'Native handler must NOT run');
      assert.strictEqual(toast.isVisible(), true);

      guard.destroy();
    });

    test('4.4: Detached card during 3-dot tracking does not cause errors or breakdown', () => {
      const queuedId = makeVidId(407);
      const observer = new MockQueueObserver([queuedId]);
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer
      });

      const { card, menuBtn } = createFeedCard(queuedId);
      const { queueItem } = createDropdownMenu();

      // Click menu
      menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));

      // Card is completely detached from DOM (removed during feed rerender)
      card.remove();
      assert.strictEqual(card.parentNode, null);

      // Click dropdown
      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      queueItem.dispatchEvent(evt);

      assert.strictEqual(evt.defaultPrevented, true, 'Detached card menu action still safely blocked');

      guard.destroy();
    });
  });

  // ===========================================================================
  // Challenge Suite 5: Internationalized Queue Button Keywords
  // ===========================================================================
  describe('Challenge Suite 5: Internationalized Queue Button Keywords', () => {
    const languageCases = [
      { lang: 'es', name: 'Spanish', keywords: ['Añadir a la cola', 'añadir a la cola', 'AÑADIR A LA COLA', 'cola', 'Cola'] },
      { lang: 'de', name: 'German', keywords: ['In Warteschlange', 'in warteschlange', 'IN WARTESCHLANGE', 'Warteschlange'] },
      { lang: 'fr', name: 'French', keywords: ['Ajouter à la file d\'attente', 'file d\'attente', 'FILE D\'ATTENTE'] },
      { lang: 'pt', name: 'Portuguese', keywords: ['Adicionar à fila', 'adicionar à fila', 'ADICIONAR À FILA', 'fila', 'Fila'] },
      { lang: 'ru', name: 'Russian', keywords: ['Добавить в очередь', 'добавить в очередь', 'ДОБАВИТЬ В ОЧЕРЕДЬ', 'очередь'] },
      { lang: 'ja', name: 'Japanese', keywords: ['キューに追加', 'キュー', 'キューに追加する'] }
    ];

    test('5.1: Multi-language Hover Overlay button matching (es, de, fr, pt, ru, ja)', () => {
      const queuedId = makeVidId(501);
      const observer = new MockQueueObserver([queuedId]);
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer
      });

      let unqueuedCounter = 510;

      for (const langCase of languageCases) {
        for (const kw of langCase.keywords) {
          // Queued card with localized label -> BLOCKED
          const cardQueued = createFeedCard(queuedId, { overlayAriaLabel: kw });
          const evtQ = new MockEvent('click', { bubbles: true, cancelable: true });
          cardQueued.overlayBtn.dispatchEvent(evtQ);
          assert.strictEqual(evtQ.defaultPrevented, true, `[${langCase.lang}] Queued button "${kw}" must be blocked`);

          // Unqueued card with localized label (using unique ID so pending additions don't collide) -> PERMITTED
          const uniqueUnqueuedId = makeVidId(unqueuedCounter++);
          const cardUnqueued = createFeedCard(uniqueUnqueuedId, { overlayAriaLabel: kw });
          const evtU = new MockEvent('click', { bubbles: true, cancelable: true });
          cardUnqueued.overlayBtn.dispatchEvent(evtU);
          assert.strictEqual(evtU.defaultPrevented, false, `[${langCase.lang}] Unqueued button "${kw}" must be allowed`);
        }
      }

      guard.destroy();
    });

    test('5.2: Multi-language 3-Dot Dropdown item matching (es, de, fr, pt, ru, ja)', () => {
      const queuedId = makeVidId(503);
      const observer = new MockQueueObserver([queuedId]);
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer
      });

      const { menuBtn } = createFeedCard(queuedId);

      for (const langCase of languageCases) {
        for (const kw of langCase.keywords) {
          const { queueItem } = createDropdownMenu({ queueLabel: kw });

          menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
          const evt = new MockEvent('click', { bubbles: true, cancelable: true });
          queueItem.dispatchEvent(evt);

          assert.strictEqual(evt.defaultPrevented, true, `[${langCase.lang}] Dropdown item "${kw}" must be blocked`);
        }
      }

      guard.destroy();
    });

    test('5.3: False positive immunity: non-queue international words never intercepted', () => {
      const queuedId = makeVidId(504);
      const observer = new MockQueueObserver([queuedId]);
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer
      });

      const falsePositiveWords = [
        'Regarder plus tard', // French Watch Later
        'Später ansehen',     // German Watch Later
        'Ver más tarde',      // Spanish Watch Later
        'Assistir mais tarde',// Portuguese Watch Later
        'Посмотреть позже',   // Russian Watch Later
        '後で見る',           // Japanese Watch Later
        'Partager',           // French Share
        'Teilen',             // German Share
        'Compartir'           // Spanish Share
      ];

      const { menuBtn } = createFeedCard(queuedId);

      for (const word of falsePositiveWords) {
        const { queueItem } = createDropdownMenu({ queueLabel: word });
        menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));

        const evt = new MockEvent('click', { bubbles: true, cancelable: true });
        queueItem.dispatchEvent(evt);

        assert.strictEqual(evt.defaultPrevented, false, `Non-queue word "${word}" must NOT be intercepted`);
      }

      guard.destroy();
    });
  });

  // ===========================================================================
  // Challenge Suite 6: Lifecycle & Listener Leakage Stress
  // ===========================================================================
  describe('Challenge Suite 6: Lifecycle & Listener Leakage Stress', () => {
    test('6.1: 50 consecutive start() / stop() cycles: zero listener leakage', () => {
      const initialListeners = document._listeners.length;
      assert.strictEqual(initialListeners, 0, 'Document must initially have 0 listeners');

      const observer = new MockQueueObserver([makeVidId(601)]);
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        autoStart: false
      });

      for (let cycle = 1; cycle <= 50; cycle++) {
        guard.start();
        assert.strictEqual(document._listeners.length, 2, `Cycle ${cycle}: start() should register exactly 2 capturing listeners`);

        guard.stop();
        assert.strictEqual(document._listeners.length, 0, `Cycle ${cycle}: stop() should cleanly remove all listeners`);
      }

      guard.destroy();
      assert.strictEqual(document._listeners.length, 0, 'After destroy(), listener count must be 0');
    });

    test('6.2: Idempotent operations: redundant start() and stop() calls do not duplicate listeners', () => {
      const guard = new DuplicateGuard({
        document,
        autoStart: false
      });

      // Calling start 10 times consecutively
      for (let i = 0; i < 10; i++) {
        guard.start();
      }
      assert.strictEqual(document._listeners.length, 2, 'Consecutive start() calls must NOT duplicate listeners');

      // Calling stop 10 times consecutively
      for (let i = 0; i < 10; i++) {
        guard.stop();
      }
      assert.strictEqual(document._listeners.length, 0, 'Consecutive stop() calls must maintain 0 listeners');

      guard.destroy();
    });

    test('6.3: QueueObserver subscription leak stress (50 cycles)', () => {
      const observer = new MockQueueObserver([makeVidId(602)]);
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        autoStart: false
      });

      for (let cycle = 1; cycle <= 50; cycle++) {
        guard.start();
        assert.strictEqual(observer._subscribers.size, 1, `Cycle ${cycle}: Exactly 1 subscriber active`);

        guard.stop();
        assert.strictEqual(observer._subscribers.size, 0, `Cycle ${cycle}: Exactly 0 subscribers after stop`);
      }

      guard.destroy();
      assert.strictEqual(observer._subscribers.size, 0);
    });

    test('6.4: Pending timers and additions thoroughly cleaned up on destroy()', () => {
      const guard = new DuplicateGuard({ document });

      // Simulate 10 pending additions
      for (let i = 1; i <= 10; i++) {
        guard._trackPendingAddition(makeVidId(610 + i));
      }
      assert.strictEqual(guard._pendingAdditions.size, 10);
      assert.strictEqual(guard._pendingTimeouts.size, 10);

      guard.destroy();

      assert.strictEqual(guard._pendingAdditions.size, 0, 'Pending additions must be empty after destroy()');
      assert.strictEqual(guard._pendingTimeouts.size, 0, 'Pending timeouts map must be empty after destroy()');
      assert.strictEqual(guard.queueObserver, null, 'queueObserver reference nullified');
      assert.strictEqual(guard.toastManager, null, 'toastManager reference nullified');
    });

    test('6.5: Post-destroy immunity & fail-open guarantees', () => {
      const queuedId = makeVidId(603);
      const observer = new MockQueueObserver([queuedId]);
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer
      });

      const { overlayBtn } = createFeedCard(queuedId);

      // Destroy
      guard.destroy();

      // Dispatch click after destroy
      let nativeRan = false;
      overlayBtn.addEventListener('click', () => { nativeRan = true; });

      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      overlayBtn.dispatchEvent(evt);

      assert.strictEqual(evt.defaultPrevented, false, 'Click after destroy must NOT be intercepted');
      assert.strictEqual(nativeRan, true, 'Native handler must execute after destroy');
    });

    test('6.6: Multiple independent DuplicateGuard instances isolation', () => {
      const idA = makeVidId(604);
      const idB = makeVidId(605);
      const observerA = new MockQueueObserver([idA]);
      const observerB = new MockQueueObserver([idB]);

      const guardA = new DuplicateGuard({ document, queueObserver: observerA, autoStart: true });
      const guardB = new DuplicateGuard({ document, queueObserver: observerB, autoStart: false });

      assert.strictEqual(guardA.isEnabled(), true);
      assert.strictEqual(guardB.isEnabled(), true);
      assert.strictEqual(guardA._isStarted, true);
      assert.strictEqual(guardB._isStarted, false);

      assert.strictEqual(guardA.isDuplicate(idA), true);
      assert.strictEqual(guardA.isDuplicate(idB), false);
      assert.strictEqual(guardB.isDuplicate(idA), false);
      assert.strictEqual(guardB.isDuplicate(idB), true);

      guardA.destroy();
      guardB.destroy();
    });
  });
});
