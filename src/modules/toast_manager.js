/**
 * YoutubeQueuePlus - Toast Notification Manager
 * Universal Module Definition (UMD) wrapping with __YQP__.ToastManager.
 *
 * Features:
 * - Material-styled dark semi-transparent pill / snackbar container (#yqp-toast)
 * - Accessible: role="status", aria-live="polite", aria-atomic="true"
 * - API: ToastManager.show(message, options), duration (default 3200ms), action callback, dismiss(), hide(), isVisible(), clearQueue()
 * - Deduplication & Refresh: rapid identical calls refresh timer rather than overlapping banners
 * - In-place replacement: options.replace flag smoothly updates content in-place
 * - Clean Sequential Queueing: FIFO queue for distinct messages with smooth transition spacing
 * - Interactive action button support with callback execution and auto-dismissal
 * - Safe UMD export pattern supporting Node.js testing and browser global contexts
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    let Constants = null;
    let DomHelpers = null;
    try {
      Constants = typeof require === 'function' ? require('../shared/constants') : null;
    } catch (_) {
      try { Constants = require('../../src/shared/constants'); } catch (__) {}
    }
    try {
      DomHelpers = typeof require === 'function' ? require('../utils/dom_helpers') : null;
    } catch (_) {
      try { DomHelpers = require('../../src/utils/dom_helpers'); } catch (__) {}
    }
    const ToastManagerClass = factory(Constants, DomHelpers);
    module.exports = ToastManagerClass;
    module.exports.ToastManager = ToastManagerClass;
    module.exports.default = ToastManagerClass;
  } else {
    root.__YQP__ = root.__YQP__ || {};
    root.__YQP__.ToastManager = factory(root.__YQP__.Constants, root.__YQP__.DomHelpers);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ConstantsModule, DomHelpersModule) {
  'use strict';

  // Fallback constants in case modules are loaded out of order or tested in isolation
  const Constants = ConstantsModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.Constants) || {
    IDS: { TOAST: 'yqp-toast' },
    CLASSES: {
      TOAST_CONTAINER: 'yqp-toast-container',
      TOAST_VISIBLE: 'yqp-toast-visible',
      TOAST_ICON: 'yqp-toast-icon'
    },
    TIMING: {
      TOAST_DISPLAY_MS: 3200,
      TOAST_FADE_MS: 250
    },
    UI_LABELS: {
      TOAST_DUPLICATE_MESSAGE: 'Video is already in queue'
    }
  };

  const DomHelpers = DomHelpersModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.DomHelpers) || {
    createElement: (tag, props, children) => {
      const el = document.createElement(tag);
      if (props) {
        for (const [k, v] of Object.entries(props)) {
          if (k === 'className' || k === 'class') {
            el.className = v;
          } else if (k === 'textContent') {
            el.textContent = v;
          } else if (k === 'innerHTML') {
            el.innerHTML = v;
          } else if (k === 'style' && typeof v === 'object') {
            Object.assign(el.style, v);
          } else if (v !== null && v !== undefined) {
            el.setAttribute(k, String(v));
          }
        }
      }
      if (Array.isArray(children)) {
        for (const c of children) {
          if (typeof c === 'string') el.appendChild(document.createTextNode(c));
          else if (c) el.appendChild(c);
        }
      }
      return el;
    },
    safeQuery: (sel, ctx) => {
      try {
        return (ctx || document).querySelector(sel);
      } catch (_) {
        return null;
      }
    },
    removeElement: (el) => {
      if (el && el.parentNode) {
        el.parentNode.removeChild(el);
        return true;
      }
      return false;
    }
  };

  const DEFAULT_DURATION_MS = 3200; // As specified in M3 requirement
  const DEFAULT_FADE_MS = Constants.TIMING?.TOAST_FADE_MS || 250;
  const DEFAULT_TOAST_ID = Constants.IDS?.TOAST || 'yqp-toast';
  const DEFAULT_CONTAINER_CLASS = Constants.CLASSES?.TOAST_CONTAINER || 'yqp-toast-container';
  const DEFAULT_VISIBLE_CLASS = Constants.CLASSES?.TOAST_VISIBLE || 'yqp-toast-visible';
  const DEFAULT_ICON_CLASS = Constants.CLASSES?.TOAST_ICON || 'yqp-toast-icon';
  const DEFAULT_PULSE_CLASS = 'yqp-toast-pulse';
  const DEFAULT_DUPLICATE_MESSAGE = Constants.UI_LABELS?.TOAST_DUPLICATE_MESSAGE || 'Video is already in queue';

  // Standard YouTube Queue SVG Path
  const QUEUE_ICON_SVG_PATH = 'M21 16H3v-2h18v2zm0-5H3V9h18v2zm0-5H3V4h18v2z';

  /**
   * ToastManager
   * Manages on-screen YouTube Material snackbar notifications with automatic
   * deduplication, timer refresh, clean FIFO queueing, and accessible markup.
   */
  class ToastManager {
    /**
     * @param {Object} [options]
     * @param {string} [options.containerId='yqp-toast'] - Target element ID
     * @param {number} [options.duration=3200] - Default display duration in ms
     * @param {number} [options.fadeDuration=250] - CSS transition duration in ms
     * @param {Document} [options.document] - Document context for testing
     */
    constructor(options = {}) {
      this.containerId = options.containerId || DEFAULT_TOAST_ID;
      this.containerClass = options.containerClass || DEFAULT_CONTAINER_CLASS;
      this.visibleClass = options.visibleClass || DEFAULT_VISIBLE_CLASS;
      this.pulseClass = options.pulseClass || DEFAULT_PULSE_CLASS;
      this.defaultDuration = typeof options.duration === 'number' ? options.duration : DEFAULT_DURATION_MS;
      this.fadeDuration = typeof options.fadeDuration === 'number' ? options.fadeDuration : DEFAULT_FADE_MS;
      this._doc = options.document || (typeof document !== 'undefined' ? document : null);

      // DOM node references
      this._containerEl = null;
      this._iconContainerEl = null;
      this._messageEl = null;
      this._actionBtnEl = null;

      // State tracking
      this._state = 'idle'; // 'idle' | 'visible' | 'dismissing'
      this._currentToast = null;
      this._dismissTimer = null;
      this._transitionTimer = null;
      this._queue = [];

      // Bound listeners for cleanup
      this._onActionClick = this._handleActionClick.bind(this);
    }

    /**
     * Retrieves or creates the #yqp-toast container in the DOM.
     * Guarantees role="status", aria-live="polite", and aria-atomic="true".
     * @returns {Element|null}
     * @private
     */
    _ensureContainer() {
      const doc = this._doc || (typeof document !== 'undefined' ? document : null);
      if (!doc || !doc.body) return null;

      let container = doc.getElementById ? doc.getElementById(this.containerId) : null;
      if (!container && doc.querySelector) {
        container = doc.querySelector('#' + this.containerId);
      }

      if (!container) {
        // Create root container
        container = doc.createElement('div');
        container.setAttribute('id', this.containerId);
        container.setAttribute('class', this.containerClass);
        container.setAttribute('role', 'status');
        container.setAttribute('aria-live', 'polite');
        container.setAttribute('aria-atomic', 'true');

        // Build internal structure
        // 1. Icon wrapper
        const iconWrap = doc.createElement('span');
        iconWrap.className = 'yqp-toast-icon-wrap';
        iconWrap.setAttribute('aria-hidden', 'true');
        iconWrap.innerHTML = `<svg class="${DEFAULT_ICON_CLASS}" viewBox="0 0 24 24" width="20" height="20" fill="#3ea6ff" focusable="false" aria-hidden="true"><path d="${QUEUE_ICON_SVG_PATH}"/></svg>`;

        // 2. Message span
        const msgSpan = doc.createElement('span');
        msgSpan.className = 'yqp-toast-message';
        msgSpan.id = 'yqp-toast-message';

        // 3. Action button (hidden by default)
        const actionBtn = doc.createElement('button');
        actionBtn.setAttribute('type', 'button');
        actionBtn.className = 'yqp-toast-action-btn';
        actionBtn.style.display = 'none';

        container.appendChild(iconWrap);
        container.appendChild(msgSpan);
        container.appendChild(actionBtn);

        doc.body.appendChild(container);
      } else {
        // Enforce required accessibility attributes on existing container
        if (!container.hasAttribute('role')) container.setAttribute('role', 'status');
        if (!container.hasAttribute('aria-live')) container.setAttribute('aria-live', 'polite');
        if (!container.hasAttribute('aria-atomic')) container.setAttribute('aria-atomic', 'true');
        if (container.classList && !container.classList.contains(this.containerClass)) {
          container.classList.add(this.containerClass);
        }
      }

      this._containerEl = container;
      this._iconContainerEl = container.querySelector ? container.querySelector('.yqp-toast-icon-wrap') : null;
      this._messageEl = container.querySelector
        ? (container.querySelector('.yqp-toast-message') || container.querySelector('#yqp-toast-message'))
        : null;
      this._actionBtnEl = container.querySelector ? container.querySelector('.yqp-toast-action-btn') : null;

      // Bind action click handler if action button exists
      if (this._actionBtnEl && !this._actionBtnEl._yqpBound && typeof this._actionBtnEl.addEventListener === 'function') {
        this._actionBtnEl.addEventListener('click', this._onActionClick);
        this._actionBtnEl._yqpBound = true;
      }

      return container;
    }

    /**
     * Handles action button click events.
     * @param {Event} e
     * @private
     */
    _handleActionClick(e) {
      if (e) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
      }

      // Guard: ignore clicks while dismissing or idle
      if (this._state === 'dismissing' || this._state === 'idle') return;

      if (this._actionBtnEl) {
        this._actionBtnEl.disabled = true;
      }

      if (this._currentToast && typeof this._currentToast.actionCallback === 'function') {
        const cb = this._currentToast.actionCallback;
        this._currentToast.actionCallback = null;
        try {
          const result = cb(this);
          // If callback explicitly returns false, keep toast visible; otherwise dismiss
          if (result !== false) {
            this.dismiss();
          } else if (this._actionBtnEl) {
            this._actionBtnEl.disabled = false;
            if (this._currentToast) {
              this._currentToast.actionCallback = cb;
            }
          }
        } catch (err) {
          console.error('[YoutubeQueuePlus ToastManager] Action callback error:', err);
          this.dismiss();
        }
      } else {
        this.dismiss();
      }
    }

    /**
     * Displays a notification toast.
     * Handles deduplication, timer refresh, in-place replacement, and sequential queueing.
     *
     * @param {string} [message] - Notification text (defaults to 'Video is already in queue')
     * @param {Object} [options] - Configuration options
     * @param {number} [options.duration=3200] - Duration in ms before auto-dismiss
     * @param {Object|Function} [options.action] - Action button configuration { text/label, onClick } or callback
     * @param {string} [options.actionText] - Action button label if action is a function
     * @param {Function} [options.onAction] - Action callback if actionText is provided
     * @param {boolean} [options.replace=false] - If true, replaces current toast text immediately
     * @param {boolean} [options.icon=true] - Whether to show the icon
     * @param {Function} [options.onDismiss] - Callback invoked when toast dismisses
     * @returns {Object} Result metadata { status: 'shown'|'refreshed'|'replaced'|'queued', message }
     */
    show(message, options = {}) {
      const msg = (message !== undefined && message !== null)
        ? String(message).trim()
        : DEFAULT_DUPLICATE_MESSAGE;

      const duration = typeof options.duration === 'number' && options.duration > 0
        ? options.duration
        : this.defaultDuration;

      // Normalize action options
      let actionConfig = null;
      if (options.action) {
        if (typeof options.action === 'function') {
          actionConfig = {
            label: options.actionText || 'Action',
            callback: options.action
          };
        } else if (typeof options.action === 'object') {
          actionConfig = {
            label: options.action.label || options.action.text || 'Action',
            callback: options.action.onClick || options.action.callback || null
          };
        }
      } else if (options.actionText && typeof options.onAction === 'function') {
        actionConfig = {
          label: options.actionText,
          callback: options.onAction
        };
      }

      const toastData = {
        message: msg,
        duration,
        action: actionConfig,
        replace: Boolean(options.replace),
        icon: options.icon !== false,
        onDismiss: typeof options.onDismiss === 'function' ? options.onDismiss : null
      };

      // State handling
      if (this._state === 'visible') {
        // Check for duplicate message
        if (this._currentToast && this._currentToast.message === msg) {
          // Rapid duplicate: refresh auto-dismiss timer rather than creating duplicate banner
          this._refreshTimer(duration);
          this._triggerPulse();
          return { status: 'refreshed', message: msg };
        }

        // Distinct message arriving while currently visible
        if (toastData.replace) {
          // In-place replacement
          this._currentToast = toastData;
          this._applyToastData(toastData);
          this._refreshTimer(duration);
          return { status: 'replaced', message: msg };
        }

        // Sequential queueing: deduplicate within queue to prevent unbounded growth
        const existingQueueIdx = this._queue.findIndex(item => item.message === msg);
        if (existingQueueIdx !== -1) {
          // Refresh queued item's duration
          this._queue[existingQueueIdx] = toastData;
          return { status: 'queued', message: msg, queueLength: this._queue.length, updated: true };
        }

        this._queue.push(toastData);
        return { status: 'queued', message: msg, queueLength: this._queue.length };
      }

      if (this._state === 'dismissing') {
        // If the same message arrives during dismissal transition, cancel dismissal and restore
        if (this._currentToast && this._currentToast.message === msg) {
          this._cancelDismissal();
          this._refreshTimer(duration);
          return { status: 'refreshed', message: msg };
        }

        // Otherwise enqueue for immediate presentation once dismissal completes
        this._queue.push(toastData);
        return { status: 'queued', message: msg, queueLength: this._queue.length };
      }

      // State is 'idle': display immediately
      this._present(toastData);
      return { status: 'shown', message: msg };
    }

    /**
     * Renders toast DOM, applies visible CSS class, and starts auto-dismiss timer.
     * @param {Object} toastData
     * @private
     */
    _present(toastData) {
      const container = this._ensureContainer();
      if (!container) return;

      this._currentToast = toastData;
      this._state = 'visible';

      // Apply content
      this._applyToastData(toastData);

      // Trigger visibility transition
      if (container.classList) {
        container.classList.remove(this.pulseClass);
        container.classList.add(this.visibleClass);
      }

      // Start auto-dismiss timer
      this._startDismissTimer(toastData.duration);
    }

    /**
     * Updates inner DOM elements with toast message, action, and icon settings.
     * @param {Object} toastData
     * @private
     */
    _applyToastData(toastData) {
      if (this._messageEl) {
        this._messageEl.textContent = toastData.message;
      }

      if (this._iconContainerEl && this._iconContainerEl.style) {
        this._iconContainerEl.style.display = toastData.icon ? '' : 'none';
      }

      if (this._actionBtnEl) {
        this._actionBtnEl.disabled = false;
        if (toastData.action && toastData.action.label && typeof toastData.action.callback === 'function') {
          this._actionBtnEl.textContent = toastData.action.label;
          if (this._actionBtnEl.style) this._actionBtnEl.style.display = '';
          this._currentToast.actionCallback = toastData.action.callback;
        } else {
          this._actionBtnEl.textContent = '';
          if (this._actionBtnEl.style) this._actionBtnEl.style.display = 'none';
          if (this._currentToast) {
            this._currentToast.actionCallback = null;
          }
        }
      }
    }

    /**
     * Starts the auto-dismiss timer.
     * @param {number} duration
     * @private
     */
    _startDismissTimer(duration) {
      this._clearDismissTimer();
      this._dismissTimer = setTimeout(() => {
        this._dismissTimer = null;
        this.dismiss();
      }, duration);
    }

    /**
     * Clears the active auto-dismiss timer.
     * @private
     */
    _clearDismissTimer() {
      if (this._dismissTimer) {
        clearTimeout(this._dismissTimer);
        this._dismissTimer = null;
      }
    }

    /**
     * Refreshes the display duration timer for rapid duplicate notices.
     * @param {number} duration
     * @private
     */
    _refreshTimer(duration) {
      this._startDismissTimer(duration);
    }

    /**
     * Triggers a subtle visual pulse animation on repeated duplicate clicks.
     * @private
     */
    _triggerPulse() {
      if (!this._containerEl || !this._containerEl.classList) return;
      this._containerEl.classList.remove(this.pulseClass);
      // Force reflow in browser environment if offsetHeight is available
      if (typeof this._containerEl.offsetHeight === 'number') {
        void this._containerEl.offsetHeight;
      }
      this._containerEl.classList.add(this.pulseClass);
    }

    /**
     * Cancels an active dismissal transition and restores visible state.
     * @private
     */
    _cancelDismissal() {
      if (this._transitionTimer) {
        clearTimeout(this._transitionTimer);
        this._transitionTimer = null;
      }
      this._state = 'visible';
      if (this._containerEl && this._containerEl.classList) {
        this._containerEl.classList.add(this.visibleClass);
      }
    }

    /**
     * Dismisses the current toast with a smooth fade-out / slide-down transition.
     * If sequential messages are queued, seamlessly displays the next message.
     *
     * @param {boolean} [immediate=false] - If true, skips transition animation
     */
    dismiss(immediate = false) {
      if (this._state === 'idle') return;

      this._clearDismissTimer();

      const prevToast = this._currentToast;

      if (immediate) {
        if (this._transitionTimer) {
          clearTimeout(this._transitionTimer);
          this._transitionTimer = null;
        }
        if (this._containerEl && this._containerEl.classList) {
          this._containerEl.classList.remove(this.visibleClass);
          this._containerEl.classList.remove(this.pulseClass);
        }
        this._state = 'idle';
        this._currentToast = null;

        if (prevToast && typeof prevToast.onDismiss === 'function') {
          try {
            prevToast.onDismiss();
          } catch (err) {
            console.error('[YoutubeQueuePlus ToastManager] onDismiss error:', err);
          }
        }

        this._processNextInQueue();
        return;
      }

      if (this._state === 'dismissing') return;

      this._state = 'dismissing';
      if (this._containerEl && this._containerEl.classList) {
        this._containerEl.classList.remove(this.visibleClass);
        this._containerEl.classList.remove(this.pulseClass);
      }

      if (prevToast && typeof prevToast.onDismiss === 'function') {
        try {
          prevToast.onDismiss();
        } catch (err) {
          console.error('[YoutubeQueuePlus ToastManager] onDismiss error:', err);
        }
      }

      this._transitionTimer = setTimeout(() => {
        this._transitionTimer = null;
        this._state = 'idle';
        this._currentToast = null;
        this._processNextInQueue();
      }, this.fadeDuration);
    }

    /**
     * Alias for dismiss().
     * @param {boolean} [immediate=false]
     */
    hide(immediate = false) {
      return this.dismiss(immediate);
    }

    /**
     * Processes the next queued toast if one is pending.
     * @private
     */
    _processNextInQueue() {
      if (this._queue.length > 0) {
        const nextToast = this._queue.shift();
        this._present(nextToast);
      }
    }

    /**
     * Clears all pending queued messages without affecting the currently visible toast.
     */
    clearQueue() {
      this._queue = [];
    }

    /**
     * Checks if a toast is currently visible on screen.
     * @returns {boolean}
     */
    isVisible() {
      return this._state === 'visible';
    }

    /**
     * Retrieves the current notification message text.
     * @returns {string|null}
     */
    getCurrentMessage() {
      return this._currentToast ? this._currentToast.message : null;
    }

    /**
     * Retrieves the number of pending toasts in the sequential queue.
     * @returns {number}
     */
    getQueueLength() {
      return this._queue.length;
    }

    /**
     * Completely cleans up timers, removes DOM elements, and resets state.
     */
    destroy() {
      this._clearDismissTimer();
      if (this._transitionTimer) {
        clearTimeout(this._transitionTimer);
        this._transitionTimer = null;
      }
      this._queue = [];
      this._state = 'idle';
      this._currentToast = null;

      if (this._actionBtnEl) {
        if (typeof this._actionBtnEl.removeEventListener === 'function') {
          this._actionBtnEl.removeEventListener('click', this._onActionClick);
        }
        this._actionBtnEl._yqpBound = false;
      }

      if (this._containerEl) {
        if (typeof DomHelpers.removeElement === 'function') {
          DomHelpers.removeElement(this._containerEl);
        } else if (this._containerEl.parentNode) {
          this._containerEl.parentNode.removeChild(this._containerEl);
        }
        this._containerEl = null;
        this._messageEl = null;
        this._actionBtnEl = null;
        this._iconContainerEl = null;
      }
    }

    // =========================================================================
    // Static Convenience Facade & Singleton Support
    // =========================================================================

    /**
     * Default singleton instance.
     * @type {ToastManager|null}
     * @private
     */
    static _instance = null;

    /**
     * Retrieves or creates the default singleton ToastManager instance.
     * @param {Object} [options]
     * @returns {ToastManager}
     */
    static getInstance(options) {
      if (!ToastManager._instance) {
        ToastManager._instance = new ToastManager(options);
      }
      return ToastManager._instance;
    }

    /**
     * Convenience static method to display a toast using the singleton instance.
     * @param {string} [message]
     * @param {Object} [options]
     * @returns {Object}
     */
    static show(message, options) {
      return ToastManager.getInstance().show(message, options);
    }

    /**
     * Convenience static method to dismiss the active toast.
     * @param {boolean} [immediate=false]
     */
    static dismiss(immediate) {
      if (ToastManager._instance) {
        ToastManager._instance.dismiss(immediate);
      }
    }

    /**
     * Convenience static method to hide the active toast (alias for dismiss).
     * @param {boolean} [immediate=false]
     */
    static hide(immediate) {
      if (ToastManager._instance) {
        ToastManager._instance.hide(immediate);
      }
    }

    /**
     * Convenience static method to clear the toast queue.
     */
    static clearQueue() {
      if (ToastManager._instance) {
        ToastManager._instance.clearQueue();
      }
    }

    /**
     * Convenience static method to check visibility.
     * @returns {boolean}
     */
    static isVisible() {
      return ToastManager._instance ? ToastManager._instance.isVisible() : false;
    }

    /**
     * Resets the singleton instance (primarily for test teardown).
     */
    static reset() {
      if (ToastManager._instance) {
        ToastManager._instance.destroy();
        ToastManager._instance = null;
      }
    }
  }

  return ToastManager;
});
