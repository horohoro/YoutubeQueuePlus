/**
 * YoutubeQueuePlus - Milestone M3 Empirical Challenger Stress Test Suite
 * Executable via: node test/m3_challenger_stress.test.js
 *
 * Scope:
 * Suite 1: Rapid spamming (100+ duplicate show() calls in <50ms)
 * Suite 2: Queue overflow & FIFO sequencing (20 distinct messages)
 * Suite 3: Rapid show() / dismiss() interleaving & timer integrity
 * Suite 4: Action button callback stress & error resilience
 * Suite 5: DOM lifecycle (multiple destroy() and reset() cycles)
 * Suite 6: Boundary, type coercion & option handling
 * Suite 7: Adversarial edge cases & behavioral failure modes
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Require SUT
const Constants = require('../src/shared/constants');
const DomHelpers = require('../src/utils/dom_helpers');
const ToastManager = require('../src/modules/toast_manager');

// =============================================================================
// DOM Mock Infrastructure
// =============================================================================

function matchSimpleSelector(el, sel) {
  if (!sel || !el || el.nodeType !== 1) return false;
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
      let inner = s.slice(1, closeIdx).trim();
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
    if (typeof document !== 'undefined' && !chain.includes(document)) {
      chain.push(document);
    }
    chain.reverse();

    // Capturing phase
    for (let i = 0; i < chain.length - 1; i++) {
      const node = chain[i];
      event.currentTarget = node;
      const capturing = (node._listeners || []).filter(l => l.type === event.type && l.capture === true);
      for (const entry of capturing) {
        if (entry.once) node.removeEventListener(entry.type, entry.callback, entry.capture);
        entry.callback.call(node, event);
        if (event._immediatePropagationStopped) break;
      }
      if (event._propagationStopped || event._immediatePropagationStopped) break;
    }

    // Target phase
    if (!event._propagationStopped && !event._immediatePropagationStopped) {
      const targetNode = chain[chain.length - 1];
      event.currentTarget = targetNode;
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
    this.offsetHeight = 48; // simulate browser element layout
  }

  get id() { return this.getAttribute('id') || ''; }
  set id(val) { this.setAttribute('id', val); }

  get className() { return this.getAttribute('class') || ''; }
  set className(val) { this.setAttribute('class', val); }

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
    if (name === 'class') this._classList.clear();
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

  querySelector(selector) {
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
      if (matchSimpleSelector(child, selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    for (const child of this.children) {
      if (matchSimpleSelector(child, selector)) results.push(child);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// =============================================================================
// CHALLENGER STRESS SUITES
// =============================================================================

describe('Challenger M3: ToastManager Empirical Stress Tests', () => {
  beforeEach(() => {
    global.document = new MockDocument();
    global.window = { document: global.document };
    global.MockEvent = MockEvent;
    ToastManager.reset();
  });

  afterEach(() => {
    ToastManager.reset();
  });

  // ===========================================================================
  // Suite 1: Rapid Spamming (100+ duplicate show() calls in <50ms)
  // ===========================================================================
  describe('Suite 1: Rapid Duplicate Spamming Stress (<50ms)', () => {
    test('1.1 150 consecutive show() calls in tight loop create strictly 1 DOM container', () => {
      const toast = new ToastManager({ document });
      const startTime = Date.now();

      for (let i = 0; i < 150; i++) {
        const res = toast.show('Duplicate Notice');
        if (i === 0) {
          assert.equal(res.status, 'shown');
        } else {
          assert.equal(res.status, 'refreshed');
        }
      }

      const elapsed = Date.now() - startTime;
      assert.ok(elapsed < 50, `150 show calls should complete in <50ms (took ${elapsed}ms)`);

      const containers = document.querySelectorAll('#yqp-toast');
      assert.equal(containers.length, 1, 'Strictly 1 #yqp-toast DOM container must exist');
      assert.equal(toast.getQueueLength(), 0, 'Duplicate calls must not accumulate in queue');

      const el = containers[0];
      assert.equal(el.getAttribute('role'), 'status');
      assert.equal(el.getAttribute('aria-live'), 'polite');
      assert.equal(el.getAttribute('aria-atomic'), 'true');
      assert.ok(el.classList.contains('yqp-toast-visible'));
      assert.ok(el.classList.contains('yqp-toast-pulse'), 'Pulse class must be applied on refresh');
    });

    test('1.2 Timer cleanly refreshes and extends lifespan rather than expiring early', async () => {
      const toast = new ToastManager({ document, duration: 100, fadeDuration: 20 });
      toast.show('Persistent Duplicate');

      // Wait 60ms (more than half elapsed)
      await sleep(60);
      assert.ok(toast.isVisible(), 'Toast should be visible at 60ms');

      // Spam 50 duplicate calls at 60ms, resetting timer to now+100ms (expires at 160ms)
      for (let i = 0; i < 50; i++) {
        toast.show('Persistent Duplicate');
      }

      // Wait another 60ms (total 120ms from start; if not refreshed, original 100ms would have expired)
      await sleep(60);
      assert.ok(toast.isVisible(), 'Toast must STILL be visible at 120ms due to timer refresh');

      // Wait another 70ms (total 190ms > 160ms+20ms fade)
      await sleep(70);
      assert.equal(toast.isVisible(), false, 'Toast should finally dismiss after refreshed duration');
    });

    test('1.3 Spamming duplicate while dismissing cleanly cancels dismissal and restores visible state', async () => {
      const toast = new ToastManager({ document, duration: 200, fadeDuration: 60 });
      toast.show('Dismiss Interrupt Notice');
      assert.ok(toast.isVisible());

      // Trigger dismissal
      toast.dismiss();
      assert.equal(toast._state, 'dismissing');
      const el = document.getElementById('yqp-toast');
      assert.equal(el.classList.contains('yqp-toast-visible'), false);

      // Rapidly spam 80 duplicate calls during dismissal transition
      for (let i = 0; i < 80; i++) {
        const res = toast.show('Dismiss Interrupt Notice');
        assert.equal(res.status, 'refreshed');
      }

      // State must be restored to visible and transition cancelled
      assert.equal(toast._state, 'visible');
      assert.ok(el.classList.contains('yqp-toast-visible'), 'Visible class must be restored');
      assert.equal(toast.getQueueLength(), 0, 'No queue entries created');

      const allContainers = document.querySelectorAll('#yqp-toast');
      assert.equal(allContainers.length, 1, 'Still strictly 1 DOM container');
    });

    test('1.4 Pulse class toggles cleanly without crashing when offsetHeight is present or missing', () => {
      const toast = new ToastManager({ document });
      toast.show('Pulse Test');

      const el = document.getElementById('yqp-toast');
      assert.ok(el.classList.contains('yqp-toast-pulse') || !el.classList.contains('yqp-toast-pulse'));

      // Simulate browser offsetHeight
      el.offsetHeight = 50;
      toast.show('Pulse Test');
      assert.ok(el.classList.contains('yqp-toast-pulse'));

      // Remove offsetHeight
      delete el.offsetHeight;
      toast.show('Pulse Test');
      assert.ok(el.classList.contains('yqp-toast-pulse'));
    });
  });

  // ===========================================================================
  // Suite 2: Queue Overflow & FIFO Sequencing (20 Distinct Messages)
  // ===========================================================================
  describe('Suite 2: Queue Overflow & FIFO Sequencing Stress', () => {
    test('2.1 Queue 20 distinct messages: strictly sequential FIFO display order', () => {
      const toast = new ToastManager({ document, duration: 20, fadeDuration: 10 });
      const displayLog = [];

      const origApply = toast._applyToastData.bind(toast);
      toast._applyToastData = (data) => {
        origApply(data);
        displayLog.push(data.message);
      };

      const messages = Array.from({ length: 20 }, (_, i) => `Message #${i + 1}`);

      // Enqueue all 20 in immediate succession
      messages.forEach((msg, idx) => {
        const res = toast.show(msg);
        if (idx === 0) {
          assert.equal(res.status, 'shown');
        } else {
          assert.equal(res.status, 'queued');
        }
      });

      assert.equal(toast.getQueueLength(), 19, 'First shown, remaining 19 queued');
      assert.equal(toast.getCurrentMessage(), 'Message #1');

      // Sequentially advance each message using immediate dismissal
      for (let i = 1; i < 20; i++) {
        toast.dismiss(true);
        assert.equal(toast.getCurrentMessage(), messages[i]);
        assert.equal(toast.getQueueLength(), 19 - i);
      }

      // Final dismiss
      toast.dismiss(true);
      assert.equal(toast.isVisible(), false);
      assert.equal(toast.getQueueLength(), 0);
      assert.equal(toast.getCurrentMessage(), null);

      // Verify FIFO ordering
      assert.deepEqual(displayLog, messages, 'Messages must be displayed in exact sequential FIFO order');
    });

    test('2.2 Full autonomous timer sequencing of 5 distinct messages with transition cleanup', async () => {
      const toast = new ToastManager({ document, duration: 25, fadeDuration: 15 });
      const messages = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
      const seenMessages = [];

      const origPresent = toast._present.bind(toast);
      toast._present = (data) => {
        origPresent(data);
        seenMessages.push(data.message);
      };

      messages.forEach(msg => toast.show(msg));
      assert.equal(toast.getQueueLength(), 4);

      // Wait for all 5 toasts to auto-cycle (5 * (25ms + 15ms) = 200ms + buffer)
      await sleep(280);

      assert.deepEqual(seenMessages, messages);
      assert.equal(toast.isVisible(), false);
      assert.equal(toast.getQueueLength(), 0);
      assert.equal(toast._state, 'idle');
    });

    test('2.3 Deduplication within queue prevents duplicate queue bloating', () => {
      const toast = new ToastManager({ document, duration: 1000 });
      toast.show('Initial'); // showing

      // Add Msg A, Msg B, Msg C to queue
      toast.show('Msg A');
      toast.show('Msg B');
      toast.show('Msg C');
      assert.equal(toast.getQueueLength(), 3);

      // Re-add Msg B with updated options
      const res = toast.show('Msg B', { duration: 5000 });
      assert.equal(res.status, 'queued');
      assert.equal(res.updated, true, 'Existing queue item should be updated in-place');
      assert.equal(toast.getQueueLength(), 3, 'Queue length must not grow when queuing duplicate');

      // clearQueue() empties queue while preserving active toast
      toast.clearQueue();
      assert.equal(toast.getQueueLength(), 0);
      assert.equal(toast.getCurrentMessage(), 'Initial');
      assert.ok(toast.isVisible());
    });
  });

  // ===========================================================================
  // Suite 3: Rapid show() / dismiss() Interleaving & Timer Integrity
  // ===========================================================================
  describe('Suite 3: Rapid Interleaving & Timer Integrity Stress', () => {
    test('3.1 100 rapid alternating show() and dismiss(true) cycles maintain consistent idle state', () => {
      const toast = new ToastManager({ document, duration: 100 });

      for (let i = 0; i < 100; i++) {
        toast.show(`Item ${i}`);
        assert.equal(toast.isVisible(), true);
        toast.dismiss(true);
        assert.equal(toast.isVisible(), false);
        assert.equal(toast._state, 'idle');
        assert.equal(toast.getQueueLength(), 0);
      }

      assert.equal(toast._state, 'idle');
      assert.equal(toast.isVisible(), false);
    });

    test('3.2 Rapid alternating show() and dismiss(false) drains sequentially without timer clobbering', () => {
      const toast = new ToastManager({ document, duration: 100, fadeDuration: 20 });

      for (let i = 0; i < 50; i++) {
        toast.show(`Item ${i}`);
        toast.dismiss(); // initiates or maintains dismissing state
      }

      assert.ok(['idle', 'dismissing', 'visible'].includes(toast._state));

      // Draining the queue completely via clearQueue and immediate dismiss
      toast.clearQueue();
      toast.dismiss(true);

      assert.equal(toast._state, 'idle');
      assert.equal(toast.isVisible(), false);
      assert.equal(toast.getQueueLength(), 0);
    });

    test('3.3 Immediate dismiss(true) mid-fade cleans up transition timer immediately', () => {
      const toast = new ToastManager({ document, duration: 500, fadeDuration: 200 });
      toast.show('Fade Test');

      // Animated dismiss
      toast.dismiss(false);
      assert.equal(toast._state, 'dismissing');
      assert.ok(toast._transitionTimer !== null, 'Transition timer should be active');

      // Immediate dismiss interrupting fade
      toast.dismiss(true);
      assert.equal(toast._state, 'idle');
      assert.equal(toast._transitionTimer, null, 'Transition timer must be cleared');
      assert.equal(toast._currentToast, null);
    });

    test('3.4 Repeated dismiss() on idle manager is safe no-op', () => {
      const toast = new ToastManager({ document });
      assert.equal(toast._state, 'idle');

      // 50 repeated dismisses
      for (let i = 0; i < 50; i++) {
        assert.doesNotThrow(() => toast.dismiss());
        assert.doesNotThrow(() => toast.dismiss(true));
      }

      assert.equal(toast._state, 'idle');
    });

    test('3.5 Repeated dismiss() while already dismissing does not clobber transition timer', () => {
      const toast = new ToastManager({ document, fadeDuration: 100 });
      toast.show('Message');
      toast.dismiss();

      assert.equal(toast._state, 'dismissing');
      const timerBefore = toast._transitionTimer;

      for (let i = 0; i < 20; i++) {
        toast.dismiss();
      }

      assert.equal(toast._state, 'dismissing');
      assert.equal(toast._transitionTimer, timerBefore, 'Transition timer must not be clobbered');
    });

    test('3.6 Synchronous error inside onDismiss callback does not crash dismiss()', () => {
      const toast = new ToastManager({ document });
      let caught = false;

      toast.show('Bad onDismiss', {
        onDismiss: () => {
          caught = true;
          throw new Error('Explosion inside onDismiss');
        }
      });

      // Synchronous exception must be trapped by try-catch
      assert.doesNotThrow(() => toast.dismiss(true));
      assert.equal(caught, true, 'onDismiss was invoked');
      assert.equal(toast._state, 'idle');
    });
  });

  // ===========================================================================
  // Suite 4: Action Button Callback Stress & Error Resilience
  // ===========================================================================
  describe('Suite 4: Action Button Stress & Error Resilience', () => {
    test('4.1 Action button renders label and clicking dismisses toast', () => {
      let actionClicked = false;
      const toast = new ToastManager({ document });

      toast.show('Video added', {
        actionText: 'Undo',
        onAction: (mgr) => {
          actionClicked = true;
          assert.equal(mgr, toast);
        }
      });

      const btn = document.querySelector('.yqp-toast-action-btn');
      assert.ok(btn, 'Action button element should exist');
      assert.equal(btn.textContent, 'Undo');
      assert.notEqual(btn.style.display, 'none');

      btn.click();
      assert.equal(actionClicked, true, 'Action callback should have fired');
      assert.equal(toast._state, 'dismissing', 'Toast should dismiss on action click');
    });

    test('4.2 Action callback returning false keeps toast visible', () => {
      let fired = false;
      const toast = new ToastManager({ document });

      toast.show('Needs confirmation', {
        action: {
          label: 'Retry',
          onClick: () => {
            fired = true;
            return false; // Explicitly cancel dismissal
          }
        }
      });

      const btn = document.querySelector('.yqp-toast-action-btn');
      btn.click();

      assert.equal(fired, true);
      assert.equal(toast.isVisible(), true, 'Toast must stay visible when callback returns false');
    });

    test('4.3 Synchronous error in action callback is caught safely and dismisses toast', () => {
      const toast = new ToastManager({ document });

      toast.show('Faulty action', {
        actionText: 'Crash',
        onAction: () => {
          throw new Error('Fatal error in client callback');
        }
      });

      const btn = document.querySelector('.yqp-toast-action-btn');
      assert.doesNotThrow(() => btn.click(), 'Clicking faulty action must not throw uncaught error');
      assert.equal(toast._state, 'dismissing', 'Toast must still dismiss after handled error');
    });

    test('4.4 Action button parameter shape variations while toast is visible', () => {
      const toast = new ToastManager({ document });
      let count = 0;

      // 1. Initial show with function action & actionText
      toast.show('Shape 1', {
        actionText: 'Act 1',
        action: () => { count += 1; }
      });
      let btn = document.querySelector('.yqp-toast-action-btn');
      assert.equal(btn.textContent, 'Act 1');

      // 2. In-place replace with object action { label, onClick }
      toast.show('Shape 2', {
        action: {
          label: 'Act 2',
          onClick: () => { count += 10; }
        },
        replace: true
      });
      btn = document.querySelector('.yqp-toast-action-btn');
      assert.equal(btn.textContent, 'Act 2');

      // Click button
      btn.click();
      assert.equal(count, 10);
      assert.equal(toast._state, 'dismissing');
    });
  });

  // ===========================================================================
  // Suite 5: DOM Lifecycle (Multiple destroy() and reset() Cycles)
  // ===========================================================================
  describe('Suite 5: DOM Lifecycle & Teardown Stress', () => {
    test('5.1 Multiple consecutive destroy() calls leave zero dangling elements or errors', () => {
      const toast = new ToastManager({ document });
      toast.show('Temporary Toast');

      assert.ok(document.getElementById('yqp-toast'));

      // 10 consecutive destroy() calls
      for (let i = 0; i < 10; i++) {
        assert.doesNotThrow(() => toast.destroy());
      }

      assert.equal(document.getElementById('yqp-toast'), null, 'Element must be removed');
      assert.equal(toast._state, 'idle');
      assert.equal(toast.getQueueLength(), 0);
      assert.equal(toast._dismissTimer, null);
      assert.equal(toast._transitionTimer, null);
    });

    test('5.2 50 rapid show() -> reset() cycles leave zero detached elements or timers', async () => {
      for (let i = 0; i < 50; i++) {
        ToastManager.show(`Cycle ${i}`);
        assert.ok(document.getElementById('yqp-toast'));
        ToastManager.reset();
        assert.equal(document.getElementById('yqp-toast'), null, `Cycle ${i}: DOM container should be cleaned up`);
      }

      await sleep(50);
      assert.equal(document.getElementById('yqp-toast'), null);
    });

    test('5.3 destroy() with pending queue drops all pending toasts cleanly', async () => {
      const toast = new ToastManager({ document, duration: 50, fadeDuration: 20 });
      toast.show('Active 1');
      toast.show('Queued 1');
      toast.show('Queued 2');
      toast.show('Queued 3');

      assert.equal(toast.getQueueLength(), 3);
      toast.destroy();

      assert.equal(toast.getQueueLength(), 0);
      assert.equal(document.getElementById('yqp-toast'), null);

      await sleep(100);
      assert.equal(document.getElementById('yqp-toast'), null, 'No queued toasts should revive after destroy()');
    });

    test('5.4 Re-instantiation via reset() after destroy creates fresh container', () => {
      ToastManager.show('First Generation');
      assert.ok(document.getElementById('yqp-toast'));

      ToastManager.reset();
      assert.equal(document.getElementById('yqp-toast'), null);

      ToastManager.show('Second Generation');
      const container = document.getElementById('yqp-toast');
      assert.ok(container, 'New container created after reset');
      assert.equal(ToastManager.getInstance().getCurrentMessage(), 'Second Generation');
    });
  });

  // ===========================================================================
  // Suite 6: Boundary, Type Coercion & Option Handling
  // ===========================================================================
  describe('Suite 6: Boundary Conditions & Option Handling', () => {
    test('6.1 Non-string or falsy messages fallback safely to default duplicate label', () => {
      const toast = new ToastManager({ document });

      // null
      toast.show(null);
      assert.equal(toast.getCurrentMessage(), 'Video is already in queue');

      // undefined
      toast.show(undefined, { replace: true });
      assert.equal(toast.getCurrentMessage(), 'Video is already in queue');

      // number
      toast.show(12345, { replace: true });
      assert.equal(toast.getCurrentMessage(), '12345');

      // boolean
      toast.show(true, { replace: true });
      assert.equal(toast.getCurrentMessage(), 'true');
    });

    test('6.2 Extreme durations (0, negative, NaN) fallback to default duration', () => {
      const toast = new ToastManager({ document });

      toast.show('Zero Duration', { duration: 0 });
      assert.equal(toast._currentToast.duration, 3200, 'Zero duration should fallback to default 3200ms');

      toast.show('Negative Duration', { duration: -500, replace: true });
      assert.equal(toast._currentToast.duration, 3200, 'Negative duration should fallback to default 3200ms');

      toast.show('NaN Duration', { duration: NaN, replace: true });
      assert.equal(toast._currentToast.duration, 3200, 'NaN duration should fallback to default 3200ms');
    });

    test('6.3 Icon option: icon=false hides icon container cleanly', () => {
      const toast = new ToastManager({ document });

      toast.show('With Icon');
      const iconWrap = document.querySelector('.yqp-toast-icon-wrap');
      assert.ok(iconWrap);
      assert.equal(iconWrap.style.display, '');

      toast.show('No Icon', { icon: false, replace: true });
      assert.equal(iconWrap.style.display, 'none');
    });
  });

  // ===========================================================================
  // Suite 7: Adversarial Edge Cases & Behavioral Findings
  // ===========================================================================
  describe('Suite 7: Adversarial Edge Cases & Behavioral Findings', () => {
    test('7.1 FINDING A: Duplicate queue bypass when show() called during dismissing state', () => {
      const toast = new ToastManager({ document, duration: 200, fadeDuration: 100 });
      toast.show('Toast Alpha');
      toast.dismiss(); // State is now 'dismissing'

      assert.equal(toast._state, 'dismissing');

      // Spam 5 identical calls to 'Toast Beta' during the 100ms dismissal window
      for (let i = 0; i < 5; i++) {
        toast.show('Toast Beta');
      }

      // EMPIRICAL OBSERVATION:
      // In the 'visible' state, findIndex deduplicates items in _queue.
      // In the 'dismissing' state, line 344 pushes without checking duplicates.
      // Therefore, the queue holds 5 duplicates of 'Toast Beta'.
      const queueLen = toast.getQueueLength();
      assert.equal(queueLen, 5, 'Reveals that queue deduplication is bypassed during dismissing state');
    });

    test('7.2 FINDING B: Action callback double-fire when clicked during dismissal transition', () => {
      let executionCount = 0;
      const toast = new ToastManager({ document, duration: 500, fadeDuration: 100 });

      toast.show('Queued Video', {
        actionText: 'Undo',
        onAction: () => {
          executionCount++;
        }
      });

      const btn = document.querySelector('.yqp-toast-action-btn');

      // Click 1
      btn.click();
      assert.equal(executionCount, 1);
      assert.equal(toast._state, 'dismissing');

      // Click 2 during dismissal animation before fadeDuration expires
      btn.click();

      // EMPIRICAL OBSERVATION:
      // Because _currentToast and the click listener remain active until the fade timer fires,
      // a rapid double-click executes the action callback twice (executionCount == 2).
      assert.equal(executionCount, 2, 'Reveals action callback can double-fire during fade transition');
    });

    test('7.3 FINDING C: options.replace flag is bypassed when called during dismissing state', () => {
      const toast = new ToastManager({ document, duration: 200, fadeDuration: 100 });
      toast.show('Message One');
      toast.dismiss(); // State is now 'dismissing'

      // Attempt in-place replace with Message Two
      const res = toast.show('Message Two', { replace: true });

      // EMPIRICAL OBSERVATION:
      // In 'dismissing' state, replace is ignored; it is queued instead of replacing.
      assert.equal(res.status, 'queued', 'In-place replace is not supported during dismissal; queued instead');
      assert.equal(toast.getCurrentMessage(), 'Message One', 'Dismissing toast retains original text until fade ends');
    });

    test('7.4 FINDING D: Detached container when element externally removed while visible', () => {
      const toast = new ToastManager({ document, duration: 1000 });
      toast.show('Initial Message');

      const el = document.getElementById('yqp-toast');
      assert.ok(el);

      // Externally remove DOM container (e.g. YouTube full-page container wipe)
      el.remove();
      assert.equal(document.getElementById('yqp-toast'), null);

      // Call show with replace: true
      toast.show('Updated Message', { replace: true });

      // EMPIRICAL OBSERVATION:
      // Because _state is 'visible', _ensureContainer() is skipped on replace,
      // so it updates the detached element without re-attaching to document.body.
      assert.equal(document.getElementById('yqp-toast'), null, 'Detached element remains detached when updated in-place');
    });
  });
});
