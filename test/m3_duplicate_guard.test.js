/**
 * YoutubeQueuePlus - Milestone M3 Duplicate Guard & Toast Notification Test Suite
 * Zero-dependency test harness using Node.js v24 native test runner.
 *
 * Verifies:
 * - Mock DOM 3-Phase Event Engine (Capturing -> Target -> Bubbling)
 * - ToastManager unit tests (DOM injection, deduplication, auto-dismiss, queueing, accessibility)
 * - Channel A: Hover overlay queue addition interception
 * - Channel B: 3-Dot dropdown menu stateful tracking and interception
 * - Rapid double-click protection via optimistic pending additions Set
 * - Graceful fallback on non-video elements and defensive robustness
 * - Lifecycle management (start, stop, destroy, enable, disable)
 *
 * Executable via: node test/m3_duplicate_guard.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Require SUT modules
const Constants = require('../src/shared/constants');
const UrlParser = require('../src/utils/url_parser');
const DomHelpers = require('../src/utils/dom_helpers');
const ToastManager = require('../src/modules/toast_manager');
const DuplicateGuard = require('../src/modules/duplicate_guard');

// =============================================================================
// 1. Lightweight 3-Phase DOM Mock Engine
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
    this.eventPhase = 0; // 0: NONE, 1: CAPTURING_PHASE, 2: AT_TARGET, 3: BUBBLING_PHASE
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

    // 1. Construct propagation chain from root down to target
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

    // 2. Phase 1: Capturing Phase (ancestors from root down to parent)
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

// =============================================================================
// 2. YouTube DOM Component Hierarchy Helpers
// =============================================================================

function createMockFeedCard(videoId, options = {}) {
  const tagName = options.tagName || 'ytd-rich-item-renderer';
  const card = document.createElement(tagName);
  if (videoId) {
    card.setAttribute('data-yqp-video-id', videoId);
  }

  // Thumbnail container
  const thumbContainer = document.createElement('div');
  thumbContainer.setAttribute('id', 'thumbnail');
  thumbContainer.className = 'ytd-thumbnail';

  // Video Link
  if (videoId && !options.noLink) {
    const thumbLink = document.createElement('a');
    thumbLink.setAttribute('id', 'thumbnail');
    thumbLink.setAttribute('href', `/watch?v=${videoId}`);
    thumbContainer.appendChild(thumbLink);
  }

  // Hover Overlay "Add to queue" button
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

  // Details & Title
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

  return { card, overlayBtn, innerBtn, icon, menuBtn, menuIconBtn, titleLink };
}

function createMockDropdownMenu(options = {}) {
  const popup = document.createElement('ytd-popup-container');
  const menuPopup = document.createElement('ytd-menu-popup-renderer');
  const listbox = document.createElement('tp-yt-paper-listbox');

  // "Add to queue" service item
  const queueItem = document.createElement('ytd-menu-service-item-renderer');
  const queuePaperItem = document.createElement('tp-yt-paper-item');
  const queueLabel = document.createElement('yt-formatted-string');
  queueLabel.textContent = options.queueLabel || 'Add to queue';
  queuePaperItem.appendChild(queueLabel);
  queueItem.appendChild(queuePaperItem);
  listbox.appendChild(queueItem);

  // Secondary non-queue service item (e.g. Watch later)
  const watchLaterItem = document.createElement('ytd-menu-service-item-renderer');
  const wlPaperItem = document.createElement('tp-yt-paper-item');
  const wlLabel = document.createElement('yt-formatted-string');
  wlLabel.textContent = 'Save to Watch later';
  wlPaperItem.appendChild(wlLabel);
  watchLaterItem.appendChild(wlPaperItem);
  listbox.appendChild(watchLaterItem);

  menuPopup.appendChild(listbox);
  popup.appendChild(menuPopup);
  document.body.appendChild(popup);

  return { popup, menuPopup, queueItem, queueLabel, watchLaterItem };
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

// Helper to sleep for timer tests
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// =============================================================================
// Test Suites (7 Suites, 28 Test Cases)
// =============================================================================

describe('Milestone M3: Duplicate Guard & Toast Notification Suite', () => {
  beforeEach(() => {
    // Reset global environment
    global.document = new MockDocument();
    global.window = { document: global.document };
    global.MockEvent = MockEvent;
    ToastManager.reset();
  });

  afterEach(() => {
    ToastManager.reset();
  });

  // ===========================================================================
  // Suite 1: Mock DOM 3-Phase Event Engine (5 Test Cases)
  // ===========================================================================
  describe('Suite 1: Mock DOM 3-Phase Event Engine', () => {
    test('1.1 Capturing vs bubbling execution order', () => {
      const executionLog = [];
      const parent = document.createElement('div');
      const child = document.createElement('button');
      parent.appendChild(child);
      document.body.appendChild(parent);

      document.addEventListener('click', () => executionLog.push('doc-capture'), true);
      document.addEventListener('click', () => executionLog.push('doc-bubble'), false);
      parent.addEventListener('click', () => executionLog.push('parent-capture'), true);
      parent.addEventListener('click', () => executionLog.push('parent-bubble'), false);
      child.addEventListener('click', () => executionLog.push('child-target'));

      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      child.dispatchEvent(evt);

      assert.deepEqual(executionLog, [
        'doc-capture',
        'parent-capture',
        'child-target',
        'parent-bubble',
        'doc-bubble'
      ]);
    });

    test('1.2 3-Phase propagation phase identifiers', () => {
      const phasesObserved = [];
      const parent = document.createElement('div');
      const target = document.createElement('span');
      parent.appendChild(target);
      document.body.appendChild(parent);

      document.addEventListener('click', (e) => phasesObserved.push(e.eventPhase), true);
      target.addEventListener('click', (e) => phasesObserved.push(e.eventPhase));
      document.addEventListener('click', (e) => phasesObserved.push(e.eventPhase), false);

      const evt = new MockEvent('click', { bubbles: true });
      target.dispatchEvent(evt);

      assert.deepEqual(phasesObserved, [1, 2, 3]); // CAPTURING=1, TARGET=2, BUBBLING=3
    });

    test('1.3 stopPropagation halts subsequent propagation', () => {
      const parent = document.createElement('div');
      const child = document.createElement('button');
      parent.appendChild(child);
      document.body.appendChild(parent);

      let childReached = false;
      document.addEventListener('click', (e) => {
        e.stopPropagation();
      }, true);

      child.addEventListener('click', () => {
        childReached = true;
      });

      const evt = new MockEvent('click', { bubbles: true });
      child.dispatchEvent(evt);

      assert.equal(childReached, false);
      assert.equal(evt._propagationStopped, true);
    });

    test('1.4 stopImmediatePropagation halts sibling listeners on same node', () => {
      const btn = document.createElement('button');
      document.body.appendChild(btn);

      let listener1Ran = false;
      let listener2Ran = false;

      btn.addEventListener('click', (e) => {
        listener1Ran = true;
        e.stopImmediatePropagation();
      });

      btn.addEventListener('click', () => {
        listener2Ran = true;
      });

      const evt = new MockEvent('click');
      btn.dispatchEvent(evt);

      assert.equal(listener1Ran, true);
      assert.equal(listener2Ran, false);
      assert.equal(evt._immediatePropagationStopped, true);
    });

    test('1.5 preventDefault sets defaultPrevented and dispatchEvent returns false', () => {
      const link = document.createElement('a');
      document.body.appendChild(link);

      link.addEventListener('click', (e) => {
        e.preventDefault();
      });

      const evt = new MockEvent('click', { cancelable: true });
      const returnValue = link.dispatchEvent(evt);

      assert.equal(evt.defaultPrevented, true);
      assert.equal(returnValue, false);
    });
  });

  // ===========================================================================
  // Suite 2: ToastManager Unit Tests (6 Test Cases)
  // ===========================================================================
  describe('Suite 2: ToastManager Unit Tests', () => {
    test('2.1 DOM injection: creates #yqp-toast with accessibility attributes', () => {
      const toast = new ToastManager({ document });
      toast.show('Test Notice');

      const el = document.getElementById('yqp-toast');
      assert.ok(el, 'Toast element should be injected into DOM');
      assert.equal(el.getAttribute('role'), 'status');
      assert.equal(el.getAttribute('aria-live'), 'polite');
      assert.equal(el.getAttribute('aria-atomic'), 'true');
      assert.ok(el.classList.contains('yqp-toast-visible'));
      assert.ok(toast.isVisible());

      // Idempotency: multiple show calls reuse the same element
      toast.show('Second Notice');
      const allToasts = document.querySelectorAll('#yqp-toast');
      assert.equal(allToasts.length, 1);
    });

    test('2.2 Message display: defaults to duplicate message and renders text correctly', () => {
      const toast = new ToastManager({ document });
      toast.show(); // No arguments -> default
      assert.equal(toast.getCurrentMessage(), 'Video is already in queue');

      toast.show('Custom Notification Message', { replace: true });
      assert.equal(toast.getCurrentMessage(), 'Custom Notification Message');
    });

    test('2.3 Auto-dismiss timeout: toast hides after duration and calls onDismiss', async () => {
      let dismissed = false;
      const toast = new ToastManager({
        document,
        duration: 30,
        fadeDuration: 15
      });

      toast.show('Expiring Message', {
        onDismiss: () => {
          dismissed = true;
        }
      });

      assert.equal(toast.isVisible(), true);
      await sleep(65);

      assert.equal(toast.isVisible(), false);
      assert.equal(dismissed, true);
    });

    test('2.4 Deduplication & timer refresh: consecutive rapid calls refresh timer and pulse', () => {
      const toast = new ToastManager({ document, duration: 5000 });
      const res1 = toast.show('Duplicate Notice');
      assert.equal(res1.status, 'shown');

      const res2 = toast.show('Duplicate Notice');
      assert.equal(res2.status, 'refreshed');
      assert.equal(toast.getQueueLength(), 0);

      const el = document.getElementById('yqp-toast');
      assert.ok(el.classList.contains('yqp-toast-pulse'));
    });

    test('2.5 In-place replacement and sequential FIFO queueing', async () => {
      const toast = new ToastManager({ document, duration: 40, fadeDuration: 15 });

      // Immediate show
      toast.show('First Message');
      assert.equal(toast.getCurrentMessage(), 'First Message');

      // In-place replacement
      toast.show('Replaced Message', { replace: true });
      assert.equal(toast.getCurrentMessage(), 'Replaced Message');

      // Sequential enqueueing
      const queueRes = toast.show('Queued Second Message');
      assert.equal(queueRes.status, 'queued');
      assert.equal(toast.getQueueLength(), 1);

      // Wait for first toast to dismiss and second to display
      await sleep(75);
      assert.equal(toast.getCurrentMessage(), 'Queued Second Message');
      assert.equal(toast.getQueueLength(), 0);
    });

    test('2.6 Manual hide / dismiss & destroy teardown', () => {
      const toast = new ToastManager({ document });
      toast.show('Active Toast');
      assert.equal(toast.isVisible(), true);

      toast.hide(true);
      assert.equal(toast.isVisible(), false);

      toast.destroy();
      const el = document.getElementById('yqp-toast');
      assert.equal(el, null, '#yqp-toast should be removed from DOM after destroy()');
    });
  });

  // ===========================================================================
  // Suite 3: Hover Overlay Interception (Channel A) (4 Test Cases)
  // ===========================================================================
  describe('Suite 3: Hover Overlay Interception (Channel A)', () => {
    test('3.1 Queued video intercepted: default prevented, propagation stopped, toast shown, YouTube suppressed', () => {
      const queuedId = 'dQw4w9WgXcQ';
      const observer = new MockQueueObserver([queuedId]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const { overlayBtn } = createMockFeedCard(queuedId);

      // Attach YouTube native listener
      let ytHandlerExecuted = false;
      overlayBtn.addEventListener('click', () => {
        ytHandlerExecuted = true;
      });

      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      overlayBtn.dispatchEvent(evt);

      assert.equal(evt.defaultPrevented, true, 'Duplicate click should be default-prevented');
      assert.equal(evt._propagationStopped, true, 'Propagation should be stopped');
      assert.equal(ytHandlerExecuted, false, 'YouTube click listener must NOT execute');
      assert.equal(toast.getCurrentMessage(), 'Video is already in queue');

      guard.destroy();
    });

    test('3.2 Unqueued video allowed: passes through without interception or toast', () => {
      const queuedId = 'dQw4w9WgXcQ';
      const unqueuedId = 'unq_vid_123';
      const observer = new MockQueueObserver([queuedId]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const { overlayBtn } = createMockFeedCard(unqueuedId);

      let ytHandlerExecuted = false;
      overlayBtn.addEventListener('click', () => {
        ytHandlerExecuted = true;
      });

      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      overlayBtn.dispatchEvent(evt);

      assert.equal(evt.defaultPrevented, false, 'Unqueued click must NOT be prevented');
      assert.equal(ytHandlerExecuted, true, 'YouTube handler should execute normally');
      assert.equal(toast.isVisible(), false, 'Toast must not show for unqueued video');

      guard.destroy();
    });

    test('3.3 Deep child click targets: clicking inner icon in overlay still intercepts', () => {
      const queuedId = 'dQw4w9WgXcQ';
      const observer = new MockQueueObserver([queuedId]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const { icon } = createMockFeedCard(queuedId);

      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      icon.dispatchEvent(evt);

      assert.equal(evt.defaultPrevented, true);
      assert.equal(toast.getCurrentMessage(), 'Video is already in queue');

      guard.destroy();
    });

    test('3.4 Recycled Polymer card resilience: extracts video ID from thumbnail href fallback', () => {
      const queuedId = 'recycled_01';
      const observer = new MockQueueObserver([queuedId]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      // Card with no data-yqp-video-id attribute, but with anchor href
      const { card, overlayBtn } = createMockFeedCard(null);
      const thumbLink = document.createElement('a');
      thumbLink.setAttribute('id', 'thumbnail');
      thumbLink.setAttribute('href', `/watch?v=${queuedId}`);
      card.querySelector('#thumbnail').appendChild(thumbLink);

      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      overlayBtn.dispatchEvent(evt);

      assert.equal(evt.defaultPrevented, true);
      assert.equal(toast.getCurrentMessage(), 'Video is already in queue');

      guard.destroy();
    });
  });

  // ===========================================================================
  // Suite 4: 3-Dot Dropdown Menu Interception (Channel B) (5 Test Cases)
  // ===========================================================================
  describe('Suite 4: 3-Dot Dropdown Menu Interception (Channel B)', () => {
    test('4.1 3-dot button click on card records lastMenuVideoId without blocking event', () => {
      const videoId = 'dQw4w9WgXcQ';
      const observer = new MockQueueObserver([videoId]);
      const guard = new DuplicateGuard({ document, queueObserver: observer });

      const { menuBtn } = createMockFeedCard(videoId);

      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      menuBtn.dispatchEvent(evt);

      assert.equal(evt.defaultPrevented, false, '3-dot button click must NOT be prevented');
      assert.equal(guard.getMenuState().videoId, videoId);

      guard.destroy();
    });

    test('4.2 Intercepting dropdown Add to queue for queued video', () => {
      const queuedId = 'dQw4w9WgXcQ';
      const observer = new MockQueueObserver([queuedId]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const { menuBtn } = createMockFeedCard(queuedId);
      const { queueItem } = createMockDropdownMenu();

      // Step 1: User clicks 3-dot menu button on card
      menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
      assert.equal(guard.getMenuState().videoId, queuedId);

      // Step 2: User clicks "Add to queue" in detached dropdown
      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      queueItem.dispatchEvent(evt);

      assert.equal(evt.defaultPrevented, true, 'Duplicate dropdown addition must be prevented');
      assert.equal(evt._propagationStopped, true);
      assert.equal(toast.getCurrentMessage(), 'Video is already in queue');
      assert.equal(guard.getMenuState().videoId, null, 'Menu state should be cleared after interception');

      guard.destroy();
    });

    test('4.3 Allowing dropdown Add to queue for unqueued video', () => {
      const queuedId = 'dQw4w9WgXcQ';
      const unqueuedId = 'unq_vid_999';
      const observer = new MockQueueObserver([queuedId]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const { menuBtn } = createMockFeedCard(unqueuedId);
      const { queueItem } = createMockDropdownMenu();

      // Step 1: Click 3-dot button on unqueued card
      menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
      assert.equal(guard.getMenuState().videoId, unqueuedId);

      // Step 2: Click "Add to queue" in dropdown
      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      queueItem.dispatchEvent(evt);

      assert.equal(evt.defaultPrevented, false, 'Unqueued dropdown addition must NOT be prevented');
      assert.equal(toast.isVisible(), false);
      assert.equal(guard.getMenuState().videoId, null);

      guard.destroy();
    });

    test('4.4 Non-queue items allowed in dropdown menu', () => {
      const queuedId = 'dQw4w9WgXcQ';
      const observer = new MockQueueObserver([queuedId]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const { menuBtn } = createMockFeedCard(queuedId);
      const { watchLaterItem } = createMockDropdownMenu();

      // Click 3-dot button
      menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));

      // Click "Save to Watch later" item
      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      watchLaterItem.dispatchEvent(evt);

      assert.equal(evt.defaultPrevented, false, 'Watch later item click must NOT be prevented');
      assert.equal(toast.isVisible(), false);

      guard.destroy();
    });

    test('4.5 Internationalized queue button keywords', () => {
      const queuedId = 'intl_vid_01';
      const observer = new MockQueueObserver([queuedId]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const testKeywords = [
        'キューに追加',
        'Añadir a la cola',
        'In Warteschlange',
        'Ajouter à la file d\'attente'
      ];

      for (const kw of testKeywords) {
        const { menuBtn } = createMockFeedCard(queuedId);
        const { queueItem } = createMockDropdownMenu({ queueLabel: kw });

        menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true }));
        const evt = new MockEvent('click', { bubbles: true, cancelable: true });
        queueItem.dispatchEvent(evt);

        assert.equal(evt.defaultPrevented, true, `Should intercept localized keyword: "${kw}"`);
      }

      guard.destroy();
    });
  });

  // ===========================================================================
  // Suite 5: Rapid Double-Click & In-Flight Guard (2 Test Cases)
  // ===========================================================================
  describe('Suite 5: Rapid Double-Click & In-Flight Guard', () => {
    test('5.1 Rapid double-click on unqueued video: click 1 passes, click 2 blocked', () => {
      const newVideoId = 'rapid_dbl01';
      const observer = new MockQueueObserver([]); // Queue is empty
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const { overlayBtn } = createMockFeedCard(newVideoId);

      // Click 1: First click should be allowed through
      const evt1 = new MockEvent('click', { bubbles: true, cancelable: true });
      overlayBtn.dispatchEvent(evt1);
      assert.equal(evt1.defaultPrevented, false, 'First click on unqueued video must pass');
      assert.equal(guard.isDuplicate(newVideoId), true, 'Video must now be in optimistic pending set');

      // Click 2 (50ms later, before YouTube updates DOM): Should be blocked as duplicate!
      const evt2 = new MockEvent('click', { bubbles: true, cancelable: true });
      overlayBtn.dispatchEvent(evt2);
      assert.equal(evt2.defaultPrevented, true, 'Rapid second click must be intercepted');
      assert.equal(toast.getCurrentMessage(), 'Video is already in queue');

      guard.destroy();
    });

    test('5.2 Safe cleanup of pending additions after queue sync or timeout', () => {
      const newVideoId = 'sync_vid002';
      const observer = new MockQueueObserver([]);
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer
      });

      const { overlayBtn } = createMockFeedCard(newVideoId);

      // First click adds to pending
      overlayBtn.dispatchEvent(new MockEvent('click', { bubbles: true, cancelable: true }));
      assert.equal(guard.isDuplicate(newVideoId), true);

      // QueueObserver syncs with new state
      observer.setVideoIds([newVideoId]);
      assert.equal(guard._pendingAdditions.has(newVideoId), false, 'Pending set should be cleared after sync');
      assert.equal(guard.isDuplicate(newVideoId), true, 'Still duplicate via activeIdsSet');

      guard.destroy();
    });
  });

  // ===========================================================================
  // Suite 6: Graceful Fallback & Defensive Robustness (4 Test Cases)
  // ===========================================================================
  describe('Suite 6: Graceful Fallback & Defensive Robustness', () => {
    test('6.1 Arbitrary non-video clicks pass through unhindered', () => {
      const observer = new MockQueueObserver(['dQw4w9WgXcQ']);
      const guard = new DuplicateGuard({ document, queueObserver: observer });

      const { titleLink } = createMockFeedCard('dQw4w9WgXcQ');

      // Click video title link
      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      titleLink.dispatchEvent(evt);
      assert.equal(evt.defaultPrevented, false, 'Title click must not be prevented');

      // Click arbitrary page element
      const randomDiv = document.createElement('div');
      document.body.appendChild(randomDiv);
      const evt2 = new MockEvent('click', { bubbles: true, cancelable: true });
      randomDiv.dispatchEvent(evt2);
      assert.equal(evt2.defaultPrevented, false, 'Random page click must not be prevented');

      guard.destroy();
    });

    test('6.2 Malformed cards fail open without throwing errors', () => {
      const observer = new MockQueueObserver(['dQw4w9WgXcQ']);
      const guard = new DuplicateGuard({ document, queueObserver: observer });

      // Malformed card without video ID and without links
      const { overlayBtn } = createMockFeedCard(null, { noLink: true });

      assert.doesNotThrow(() => {
        const evt = new MockEvent('click', { bubbles: true, cancelable: true });
        overlayBtn.dispatchEvent(evt);
        assert.equal(evt.defaultPrevented, false, 'Malformed card must fail open');
      });

      guard.destroy();
    });

    test('6.3 Detached or stale dropdown clicks fail open', () => {
      const observer = new MockQueueObserver(['dQw4w9WgXcQ']);
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        menuTimeoutMs: 50 // Short TTL
      });

      const { queueItem } = createMockDropdownMenu();

      // Case A: Click dropdown with NO preceding 3-dot click
      const evtA = new MockEvent('click', { bubbles: true, cancelable: true });
      queueItem.dispatchEvent(evtA);
      assert.equal(evtA.defaultPrevented, false, 'Dropdown click with no tracked menu must fail open');

      guard.destroy();
    });

    test('6.4 Empty queue handling: all addition attempts pass through', () => {
      const observer = new MockQueueObserver([]); // 0 items
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const { overlayBtn } = createMockFeedCard('video_abc12');
      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      overlayBtn.dispatchEvent(evt);

      assert.equal(evt.defaultPrevented, false);
      assert.equal(toast.isVisible(), false);

      guard.destroy();
    });
  });

  // ===========================================================================
  // Suite 7: Lifecycle Management (2 Test Cases)
  // ===========================================================================
  describe('Suite 7: Lifecycle Management', () => {
    test('7.1 destroy() cleanly removes listeners, timers, and state', () => {
      const queuedId = 'dQw4w9WgXcQ';
      const observer = new MockQueueObserver([queuedId]);
      const toast = new ToastManager({ document });
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer,
        toastManager: toast
      });

      const { overlayBtn } = createMockFeedCard(queuedId);

      // Verify active interception
      const evt1 = new MockEvent('click', { bubbles: true, cancelable: true });
      overlayBtn.dispatchEvent(evt1);
      assert.equal(evt1.defaultPrevented, true);

      // Destroy guard
      guard.destroy();

      // Subsequent click should pass through unhindered
      const evt2 = new MockEvent('click', { bubbles: true, cancelable: true });
      overlayBtn.dispatchEvent(evt2);
      assert.equal(evt2.defaultPrevented, false, 'After destroy(), click should not be intercepted');
    });

    test('7.2 enable() and disable() toggling', () => {
      const queuedId = 'dQw4w9WgXcQ';
      const observer = new MockQueueObserver([queuedId]);
      const guard = new DuplicateGuard({
        document,
        queueObserver: observer
      });

      const { overlayBtn } = createMockFeedCard(queuedId);

      // Disable guard
      guard.disable();
      assert.equal(guard.isEnabled(), false);

      const evt1 = new MockEvent('click', { bubbles: true, cancelable: true });
      overlayBtn.dispatchEvent(evt1);
      assert.equal(evt1.defaultPrevented, false, 'Disabled guard must not intercept');

      // Re-enable guard
      guard.enable();
      assert.equal(guard.isEnabled(), true);

      const evt2 = new MockEvent('click', { bubbles: true, cancelable: true });
      overlayBtn.dispatchEvent(evt2);
      assert.equal(evt2.defaultPrevented, true, 'Enabled guard must intercept');

      guard.destroy();
    });
  });
});
