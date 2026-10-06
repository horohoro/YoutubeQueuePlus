/**
 * YoutubeQueuePlus - Duplicate Addition Guard Module
 * Intercepts user actions attempting to add an already-queued video to YouTube's
 * native queue via Hover Overlay buttons or 3-Dot Dropdown Menus.
 *
 * Utilizes capturing-phase event listeners to halt DOM propagation before
 * YouTube's Polymer/Lit click handlers execute, preventing player desync loops.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    let Constants = null;
    let UrlParser = null;
    let DomHelpers = null;
    let ToastManager = null;
    try {
      Constants = typeof require === 'function' ? require('../shared/constants') : null;
    } catch (_) {}
    try {
      UrlParser = typeof require === 'function' ? require('../utils/url_parser') : null;
    } catch (_) {}
    try {
      DomHelpers = typeof require === 'function' ? require('../utils/dom_helpers') : null;
    } catch (_) {}
    try {
      ToastManager = typeof require === 'function' ? require('./toast_manager') : null;
    } catch (_) {}

    const DuplicateGuardClass = factory(Constants, UrlParser, DomHelpers, ToastManager);
    module.exports = DuplicateGuardClass;
    module.exports.DuplicateGuard = DuplicateGuardClass;
    module.exports.default = DuplicateGuardClass;
  } else {
    root.__YQP__ = root.__YQP__ || {};
    root.__YQP__.DuplicateGuard = factory(
      root.__YQP__.Constants,
      root.__YQP__.UrlParser,
      root.__YQP__.DomHelpers,
      root.__YQP__.ToastManager
    );
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ConstantsModule, UrlParserModule, DomHelpersModule, ToastManagerModule) {
  'use strict';

  // Fallback defaults in case modules are loaded out of order
  const Constants = ConstantsModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.Constants) || {
    SELECTORS: {
      OVERLAY_ADD_TO_QUEUE_BTN: 'ytd-thumbnail-overlay-toggle-button-renderer',
      MENU_3DOT_BTN: 'button[aria-label="Action menu"], ytd-menu-renderer yt-icon-button, button.yt-icon-button[aria-label="Action menu"]',
      MENU_SERVICE_ITEM: 'ytd-menu-service-item-renderer',
      MENU_POPUP_CONTAINER: 'ytd-popup-container, ytd-menu-popup-renderer, tp-yt-iron-dropdown',
      FEED_CARDS_ALL: 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer',
      CARD_THUMBNAIL_CONTAINER: '#thumbnail, ytd-thumbnail, .ytd-thumbnail'
    },
    ATTRIBUTES: {
      VIDEO_ID: 'data-yqp-video-id'
    },
    UI_LABELS: {
      TOAST_DUPLICATE_MESSAGE: 'Video is already in queue'
    },
    QUEUE_BUTTON_KEYWORDS: [
      'queue', 'add to queue', 'キュー', 'cola', 'añadir a la cola',
      'warteschlange', 'in warteschlange', 'file d\'attente',
      'ajouter à la file d\'attente', 'fila', 'adicionar à fila',
      'очередь', 'добавить в очередь'
    ]
  };

  const UrlParser = UrlParserModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.UrlParser) || {
    extractVideoId: (url) => {
      if (typeof url !== 'string') return null;
      const match = url.match(/[?&]v=([a-zA-Z0-9_-]{11})(?:[&#]|$)/);
      return match ? match[1] : null;
    },
    extractVideoIdFromElement: (el) => {
      if (!el) return null;
      const direct = el.getAttribute?.('data-yqp-video-id');
      if (direct && /^[a-zA-Z0-9_-]{11}$/.test(direct)) return direct;
      const href = el.getAttribute?.('href') || el.querySelector?.('a')?.getAttribute?.('href');
      return href ? UrlParser.extractVideoId(href) : null;
    },
    isValidVideoId: (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id)
  };

  const DomHelpers = DomHelpersModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.DomHelpers) || {
    safeQuery: (sel, ctx) => (ctx || document)?.querySelector?.(sel) || null,
    safeQueryAll: (sel, ctx) => Array.from((ctx || document)?.querySelectorAll?.(sel) || []),
    matches: (el, sel) => Boolean(el?.matches?.(sel)),
    closest: (el, sel) => {
      if (!el) return null;
      if (typeof el.closest === 'function') return el.closest(sel);
      let curr = el;
      while (curr) {
        if (curr.matches && curr.matches(sel)) return curr;
        curr = curr.parentElement || curr.parentNode;
      }
      return null;
    }
  };

  const ToastManager = ToastManagerModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.ToastManager) || null;

  const SELECTORS = Constants.SELECTORS || {};
  const QUEUE_KEYWORDS = (Constants.QUEUE_BUTTON_KEYWORDS || []).map(k => k.toLowerCase());
  const NEGATIVE_QUEUE_KEYWORDS = Object.freeze(
    (Constants.NEGATIVE_QUEUE_KEYWORDS || [
      'remove', 'quitar', 'supprimer', 'retirer', 'entfernen', 'löschen',
      'remover', '削除', 'удалить', 'очистить', 'delete', 'clear'
    ]).map(k => k.toLowerCase())
  );

  class DuplicateGuard {
    /**
     * @param {Object} [options]
     * @param {Document} [options.document] - Document context
     * @param {Window} [options.window] - Window context
     * @param {Object} [options.queueObserver] - QueueObserver instance or mock
     * @param {Object} [options.toastManager] - ToastManager instance or mock
     * @param {boolean} [options.enabled=true] - Initial enabled state
     * @param {boolean} [options.autoStart=true] - Whether to start intercepting immediately
     * @param {number} [options.menuTimeoutMs=60000] - Freshness TTL for 3-dot tracking in ms
     * @param {Function} [options.onDuplicateBlocked] - Callback fired on duplicate block
     */
    constructor(options = {}) {
      this.doc = options.document || (typeof document !== 'undefined' ? document : null);
      this.win = options.window || (typeof window !== 'undefined' ? window : null);
      this.queueObserver = options.queueObserver || null;
      this.toastManager = options.toastManager || null;
      this.enabled = options.enabled !== false;
      this.menuTimeoutMs = typeof options.menuTimeoutMs === 'number' ? options.menuTimeoutMs : 60000;
      this.onDuplicateBlocked = typeof options.onDuplicateBlocked === 'function' ? options.onDuplicateBlocked : null;

      // Stateful tracking for 3-dot dropdown menu
      this.lastMenuVideoId = null;
      this.lastMenuTimestamp = 0;
      this.lastMenuCard = null;

      // Rapid double-click protection (optimistic additions)
      this._pendingAdditions = new Set();
      this._pendingTimeouts = new Map();

      // Lifecycle and listener management
      this._isStarted = false;
      this._unsubscribeObserver = null;
      this._boundClickHandler = this._handleClick.bind(this);
      this._boundPointerHandler = this._handlePointerDown.bind(this);

      // Auto-start
      if (options.autoStart !== false) {
        this.start();
      }
    }

    // =========================================================================
    // Public API
    // =========================================================================

    /**
     * Starts capturing-phase event listeners on document.
     */
    start() {
      if (this._isStarted) return;
      const doc = this._getDoc();
      if (!doc || typeof doc.addEventListener !== 'function') return;

      doc.addEventListener('click', this._boundClickHandler, true);
      doc.addEventListener('pointerdown', this._boundPointerHandler, true);

      if (this.queueObserver && typeof this.queueObserver.subscribe === 'function') {
        this._unsubscribeObserver = this.queueObserver.subscribe((state) => {
          this._syncPendingAdditions(state?.videoIds || []);
        }, { immediate: false });
      }

      this._isStarted = true;
    }

    /**
     * Alias for start().
     */
    init() {
      this.start();
    }

    /**
     * Stops capturing-phase event listeners.
     */
    stop() {
      if (!this._isStarted) return;
      const doc = this._getDoc();
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('click', this._boundClickHandler, true);
        doc.removeEventListener('pointerdown', this._boundPointerHandler, true);
      }

      if (typeof this._unsubscribeObserver === 'function') {
        this._unsubscribeObserver();
        this._unsubscribeObserver = null;
      }

      this._isStarted = false;
    }

    /**
     * Completely cleans up all listeners, pending timers, and references.
     */
    destroy() {
      this.stop();
      this.clearMenuState();

      for (const timer of this._pendingTimeouts.values()) {
        clearTimeout(timer);
      }
      this._pendingTimeouts.clear();
      this._pendingAdditions.clear();

      this.queueObserver = null;
      this.toastManager = null;
      this.onDuplicateBlocked = null;
    }

    /**
     * Enables or disables duplicate guard.
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
      this.enabled = Boolean(enabled);
    }

    enable() {
      this.setEnabled(true);
    }

    disable() {
      this.setEnabled(false);
    }

    isEnabled() {
      return this.enabled;
    }

    /**
     * Injects or updates QueueObserver dependency.
     * @param {Object} observer
     */
    setQueueObserver(observer) {
      if (this._unsubscribeObserver) {
        this._unsubscribeObserver();
        this._unsubscribeObserver = null;
      }
      this.queueObserver = observer;
      if (this._isStarted && this.queueObserver && typeof this.queueObserver.subscribe === 'function') {
        this._unsubscribeObserver = this.queueObserver.subscribe((state) => {
          this._syncPendingAdditions(state?.videoIds || []);
        }, { immediate: false });
      }
    }

    /**
     * Injects or updates ToastManager dependency.
     * @param {Object} toastManager
     */
    setToastManager(toastManager) {
      this.toastManager = toastManager;
    }

    /**
     * Checks whether video ID is currently in active queue or pending addition.
     * @param {string} videoId
     * @returns {boolean}
     */
    isDuplicate(videoId) {
      if (!videoId || typeof videoId !== 'string') return false;
      const cleanId = videoId.trim();
      if (!UrlParser.isValidVideoId(cleanId)) return false;

      // 1. Check QueueObserver active Set (O(1))
      if (this.queueObserver) {
        if (typeof this.queueObserver.hasVideo === 'function' && this.queueObserver.hasVideo(cleanId)) {
          return true;
        }
        if (typeof this.queueObserver.getActiveIdsSet === 'function') {
          const set = this.queueObserver.getActiveIdsSet();
          if (set && typeof set.has === 'function' && set.has(cleanId)) {
            return true;
          }
        }
        if (this.queueObserver instanceof Set && this.queueObserver.has(cleanId)) {
          return true;
        }
        if (Array.isArray(this.queueObserver) && this.queueObserver.includes(cleanId)) {
          return true;
        }
        if (typeof this.queueObserver.getActiveVideoIds === 'function') {
          const ids = this.queueObserver.getActiveVideoIds();
          if (Array.isArray(ids) && ids.includes(cleanId)) {
            return true;
          }
        }
      }

      // 2. Check optimistic rapid-click additions
      if (this._pendingAdditions.has(cleanId)) {
        return true;
      }

      return false;
    }

    /**
     * Resets 3-dot menu tracking state.
     */
    clearMenuState() {
      this.lastMenuVideoId = null;
      this.lastMenuTimestamp = 0;
      this.lastMenuCard = null;
    }

    /**
     * Returns active 3-dot tracking state.
     * @returns {{ videoId: string|null, timestamp: number }}
     */
    getMenuState() {
      return {
        videoId: this.lastMenuVideoId,
        timestamp: this.lastMenuTimestamp
      };
    }

    // =========================================================================
    // Capturing Event Handlers
    // =========================================================================

    /**
     * Pointerdown capturing handler for tracking 3-dot menu before click.
     * @param {Event} e
     * @private
     */
    _handlePointerDown(e) {
      if (!this.enabled || !e || !e.target) return;
      try {
        const target = this._normalizeTarget(e.target);
        if (!target) return;
        this._checkAndTrackCardMenu(target);
      } catch (err) {
        // Fail-safe: never crash page on pointerdown
      }
    }

    /**
     * Main click capturing handler. Runs before YouTube Polymer handlers.
     * @param {Event} e
     * @private
     */
    _handleClick(e) {
      if (!this.enabled || !e || !e.target) return;

      try {
        const target = this._normalizeTarget(e.target);
        if (!target) return;

        // 1. Channel B (Step 1): Track 3-dot menu button click on a card
        if (this._checkAndTrackCardMenu(target)) {
          // Do NOT block: allow YouTube to open the popup menu
          return;
        }

        // 2. Channel A: Hover overlay "Add to queue" button click
        const card = this._findParentCard(target);
        if (card && this._isHoverQueueButton(target, card)) {
          const videoId = this._getVideoIdFromCard(card);
          if (videoId) {
            this._handleQueueAddAttempt(e, videoId, 'hover_overlay');
          }
          return;
        }

        // 3. Channel B (Step 2): Dropdown menu "Add to queue" item click
        if (this._isDropdownQueueItem(target)) {
          const videoId = this._resolveDropdownVideoId(target);
          if (videoId) {
            this._handleQueueAddAttempt(e, videoId, 'dropdown_menu', target);
          }
          return;
        }
      } catch (err) {
        console.error('[YQP DuplicateGuard] Interception error:', err);
      }
    }

    /**
     * Processes queue addition attempt: duplicate check, suppression, toast.
     * @param {Event} e
     * @param {string} videoId
     * @param {string} channel - 'hover_overlay' | 'dropdown_menu'
     * @param {Element} [menuItem]
     * @private
     */
    _handleQueueAddAttempt(e, videoId, channel, menuItem = null) {
      if (this.isDuplicate(videoId)) {
        // QUADRUPLE SUPPRESSION: prevent default, stop propagation, halt listeners, dismiss menu
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

        if (menuItem) {
          this._closeDropdown(menuItem);
        }

        this.clearMenuState();
        this._showToast(Constants.UI_LABELS?.TOAST_DUPLICATE_MESSAGE || 'Video is already in queue');

        if (typeof this.onDuplicateBlocked === 'function') {
          try {
            this.onDuplicateBlocked({ videoId, channel, event: e });
          } catch (_) {}
        }
      } else {
        // NOT duplicate: record optimistic addition for rapid double-click guard
        this._trackPendingAddition(videoId);
        this.clearMenuState();
      }
    }

    // =========================================================================
    // Channel Resolution & Heuristics
    // =========================================================================

    /**
     * Checks if target is 3-dot menu button on a card and records state.
     * @param {Element} target
     * @returns {boolean}
     * @private
     */
    _checkAndTrackCardMenu(target) {
      const card = this._findParentCard(target);
      if (!card) return false;

      const isMenuBtn = DomHelpers.closest(target, SELECTORS.MENU_3DOT_BTN) ||
        DomHelpers.closest(target, 'button[aria-label*="Action" i], button[aria-label*="More actions" i], yt-icon-button.ytd-menu-renderer, #menu yt-icon-button, ytd-menu-renderer button');

      if (isMenuBtn) {
        const videoId = this._getVideoIdFromCard(card);
        if (videoId) {
          this.lastMenuVideoId = videoId;
          this.lastMenuTimestamp = Date.now();
          this.lastMenuCard = card;
          return true;
        }
      }
      return false;
    }

    /**
     * Checks if target is hover overlay queue button within card.
     * @param {Element} target
     * @param {Element} card
     * @returns {boolean}
     * @private
     */
    _isHoverQueueButton(target, card) {
      if (!card) return false;

      // Direct negative check on click target
      if (this._isNegativeAction(target)) {
        return false;
      }

      // 1. Overlay toggle button renderer
      const toggleRenderer = DomHelpers.closest(target, SELECTORS.OVERLAY_ADD_TO_QUEUE_BTN || 'ytd-thumbnail-overlay-toggle-button-renderer');
      if (toggleRenderer) {
        // Negative check: Watch later button or removal actions
        if (this._isWatchLater(toggleRenderer) || this._isWatchLater(target) ||
            this._isNegativeAction(toggleRenderer) || this._isNegativeAction(target)) {
          return false;
        }
        const innerBtn = toggleRenderer.querySelector?.('button, yt-icon-button, [aria-label], #tooltip');
        if (innerBtn && this._isNegativeAction(innerBtn)) {
          return false;
        }
        if (this._matchesQueueKeywords(toggleRenderer) || this._matchesQueueKeywords(target)) {
          return true;
        }
        if (innerBtn && this._matchesQueueKeywords(innerBtn)) {
          return true;
        }
        const aria = toggleRenderer.getAttribute?.('aria-label') || '';
        if (aria && this._containsQueueKeyword(aria)) {
          return true;
        }
      }

      // 2. Generic button with queue aria-label inside thumbnail container
      const thumb = DomHelpers.closest(target, SELECTORS.CARD_THUMBNAIL_CONTAINER || '#thumbnail, ytd-thumbnail, .ytd-thumbnail');
      if (thumb) {
        const queueBtn = DomHelpers.closest(target, 'button[aria-label*="queue" i], yt-icon-button[aria-label*="queue" i], [data-action="add-to-queue"]');
        if (queueBtn && !this._isWatchLater(queueBtn) && !this._isNegativeAction(queueBtn)) return true;

        const labeled = DomHelpers.closest(target, '[aria-label]');
        if (labeled && this._matchesQueueKeywords(labeled) && !this._isWatchLater(labeled) && !this._isNegativeAction(labeled)) {
          return true;
        }
      }

      // 3. Fallback: Any button or icon within card matching queue keywords
      const anyQueueBtn = DomHelpers.closest(target, 'button, yt-icon-button, [role="button"]');
      if (anyQueueBtn && this._matchesQueueKeywords(anyQueueBtn) && !this._isWatchLater(anyQueueBtn) && !this._isNegativeAction(anyQueueBtn)) {
        return true;
      }

      return false;
    }

    /**
     * Checks if target is dropdown "Add to queue" menu item.
     * @param {Element} target
     * @returns {boolean}
     * @private
     */
    _isDropdownQueueItem(target) {
      const menuItem = DomHelpers.closest(target, SELECTORS.MENU_SERVICE_ITEM || 'ytd-menu-service-item-renderer') ||
        DomHelpers.closest(target, 'tp-yt-paper-item, ytd-menu-navigation-item-renderer, [role="menuitem"]');

      if (!menuItem) return false;

      // Negative check for Watch later or other non-queue actions
      if (this._isWatchLater(menuItem) || this._isWatchLater(target)) {
        return false;
      }

      // Negative check for queue removal/delete/clear actions
      if (this._isNegativeAction(menuItem) || this._isNegativeAction(target)) {
        return false;
      }

      const formatted = menuItem.querySelector?.('yt-formatted-string, span, div');
      if (formatted && this._isNegativeAction(formatted)) {
        return false;
      }

      // Check keywords
      if (this._matchesQueueKeywords(menuItem) || this._matchesQueueKeywords(target)) {
        return true;
      }

      if (formatted && this._matchesQueueKeywords(formatted)) {
        return true;
      }

      return false;
    }

    /**
     * Alias for _isDropdownQueueItem.
     * @param {Element} target
     * @returns {boolean}
     */
    _isQueueMenuAction(target) {
      return this._isDropdownQueueItem(target);
    }

    /**
     * Resolves target video ID for dropdown item from tracked menu state.
     * @param {Element} menuItem
     * @returns {string|null}
     * @private
     */
    _resolveDropdownVideoId(menuItem) {
      // 1. Check lastMenuVideoId with TTL
      if (this.lastMenuVideoId) {
        const elapsed = Date.now() - this.lastMenuTimestamp;
        if (elapsed <= this.menuTimeoutMs) {
          return this.lastMenuVideoId;
        }
      }

      // 2. Fallback: check attribute on menuItem or popup container
      const directAttr = menuItem?.getAttribute?.('data-yqp-video-id') || menuItem?.getAttribute?.('data-video-id');
      if (directAttr && UrlParser.isValidVideoId(directAttr)) {
        return directAttr;
      }

      const popup = DomHelpers.closest(menuItem, SELECTORS.MENU_POPUP_CONTAINER || 'ytd-popup-container, ytd-menu-popup-renderer, tp-yt-iron-dropdown');
      const popupAttr = popup?.getAttribute?.('data-yqp-video-id') || popup?.getAttribute?.('data-video-id');
      if (popupAttr && UrlParser.isValidVideoId(popupAttr)) {
        return popupAttr;
      }

      return null;
    }

    /**
     * Safely closes YouTube's iron-dropdown / popup overlay.
     * @param {Element} menuItem
     * @private
     */
    _closeDropdown(menuItem) {
      try {
        const dropdown = DomHelpers.closest(menuItem, 'tp-yt-iron-dropdown, ytd-menu-popup-renderer, ytd-popup-container');
        if (dropdown && typeof dropdown.close === 'function') {
          dropdown.close();
          return;
        }
        if (dropdown && typeof dropdown.cancel === 'function') {
          dropdown.cancel();
          return;
        }

        // Dispatch Escape key
        const doc = this._getDoc();
        if (doc && typeof doc.dispatchEvent === 'function') {
          let esc = null;
          try {
            esc = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true });
          } catch (_) {}

          if (!esc && typeof doc.createEvent === 'function') {
            try {
              esc = doc.createEvent('Event');
              esc.initEvent('keydown', true, true);
              esc.key = 'Escape';
            } catch (_) {}
          }

          if (esc) {
            (dropdown || menuItem || doc).dispatchEvent(esc);
          }
        }
      } catch (_) {}
    }

    /**
     * Finds parent feed card element.
     * @param {Element} el
     * @returns {Element|null}
     * @private
     */
    _findParentCard(el) {
      if (!el) return null;
      return DomHelpers.closest(el, SELECTORS.FEED_CARDS_ALL) ||
        DomHelpers.closest(el, 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer');
    }

    /**
     * Extracts video ID from feed card. Resilient to Polymer recycling.
     * @param {Element} card
     * @returns {string|null}
     * @private
     */
    _getVideoIdFromCard(card) {
      if (!card) return null;

      // 1. Check child anchor href first (recycled element resilience)
      const anchor = card.querySelector?.('a#thumbnail[href], a#video-title-link[href], a#video-title[href], a[href*="watch?v="], a[href*="v="]');
      if (anchor && typeof anchor.getAttribute === 'function') {
        const href = anchor.getAttribute('href');
        const extracted = UrlParser.extractVideoId ? UrlParser.extractVideoId(href) : null;
        if (extracted && UrlParser.isValidVideoId(extracted)) {
          return extracted;
        }
      }

      // 2. Check cached attribute
      const cached = card.getAttribute?.(Constants.ATTRIBUTES?.VIDEO_ID || 'data-yqp-video-id');
      if (cached && UrlParser.isValidVideoId(cached)) {
        return cached;
      }

      // 3. Fallback extraction
      const parsed = UrlParser.extractVideoIdFromElement ? UrlParser.extractVideoIdFromElement(card) : null;
      if (parsed && UrlParser.isValidVideoId(parsed)) {
        return parsed;
      }

      return null;
    }

    // =========================================================================
    // Heuristics & Keywords
    // =========================================================================

    /**
     * Checks if element text or labels match queue keywords.
     * @param {Element} el
     * @returns {boolean}
     * @private
     */
    _matchesQueueKeywords(el) {
      if (!el) return false;
      const text = (el.textContent || '').trim().toLowerCase();
      const aria = (el.getAttribute?.('aria-label') || '').trim().toLowerCase();
      const title = (el.getAttribute?.('title') || '').trim().toLowerCase();

      return this._containsQueueKeyword(text) ||
             this._containsQueueKeyword(aria) ||
             this._containsQueueKeyword(title);
    }

    _containsQueueKeyword(str) {
      if (!str) return false;
      for (const kw of QUEUE_KEYWORDS) {
        if (str.includes(kw)) return true;
      }
      return false;
    }

    /**
     * Negative check for "Watch later" elements.
     * @param {Element} el
     * @returns {boolean}
     * @private
     */
    _isWatchLater(el) {
      if (!el) return false;
      const text = (el.textContent || '').toLowerCase();
      const aria = (el.getAttribute?.('aria-label') || '').toLowerCase();
      return aria.includes('watch later') || text.includes('watch later') ||
             aria.includes('regarder plus tard') || text.includes('regarder plus tard') ||
             aria.includes('später ansehen') || aria.includes('ver más tarde');
    }

    /**
     * Negative check for removal/clear/delete actions.
     * Prevents removing items from queue being falsely intercepted as addition attempts.
     * @param {Element} el
     * @returns {boolean}
     * @private
     */
    _isNegativeAction(el) {
      if (!el) return false;
      const text = (el.textContent || '').toLowerCase();
      const aria = (el.getAttribute?.('aria-label') || '').toLowerCase();
      const title = (el.getAttribute?.('title') || '').toLowerCase();
      const tooltip = (el.querySelector?.('#tooltip')?.textContent || '').toLowerCase();
      const full = `${text} ${aria} ${title} ${tooltip}`;
      for (const neg of NEGATIVE_QUEUE_KEYWORDS) {
        if (full.includes(neg)) return true;
      }
      return false;
    }

    _isNegativeQueueAction(el) {
      return this._isNegativeAction(el);
    }

    // =========================================================================
    // Rapid Double-Click & Optimistic Tracking
    // =========================================================================

    /**
     * Adds video to pending set with 5000ms TTL.
     * @param {string} videoId
     * @private
     */
    _trackPendingAddition(videoId) {
      if (!videoId) return;
      this._pendingAdditions.add(videoId);

      if (this._pendingTimeouts.has(videoId)) {
        clearTimeout(this._pendingTimeouts.get(videoId));
      }

      const timer = setTimeout(() => {
        this._pendingAdditions.delete(videoId);
        this._pendingTimeouts.delete(videoId);
      }, 5000);

      this._pendingTimeouts.set(videoId, timer);
    }

    /**
     * Clears pending addition when confirmed in active queue.
     * @param {string[]} videoIds
     * @private
     */
    _syncPendingAdditions(videoIds) {
      if (!Array.isArray(videoIds) || this._pendingAdditions.size === 0) return;
      for (const id of videoIds) {
        if (this._pendingAdditions.has(id)) {
          this._pendingAdditions.delete(id);
          if (this._pendingTimeouts.has(id)) {
            clearTimeout(this._pendingTimeouts.get(id));
            this._pendingTimeouts.delete(id);
          }
        }
      }
    }

    // =========================================================================
    // Toast Feedback
    // =========================================================================

    /**
     * Shows feedback toast to user.
     * @param {string} message
     * @private
     */
    _showToast(message) {
      if (this.toastManager && typeof this.toastManager.show === 'function') {
        this.toastManager.show(message);
        return;
      }

      if (ToastManager && typeof ToastManager.show === 'function') {
        ToastManager.show(message);
        return;
      }

      const globalTm = (typeof globalThis !== 'undefined' && globalThis.__YQP__?.ToastManager);
      if (globalTm && typeof globalTm.show === 'function') {
        globalTm.show(message);
        return;
      }

      console.info('[YQP DuplicateGuard]', message);
    }

    _getDoc() {
      return this.doc || (typeof document !== 'undefined' ? document : null);
    }

    _normalizeTarget(target) {
      if (!target) return null;
      if (target.nodeType === 3) return target.parentElement;
      return target;
    }
  }

  return DuplicateGuard;
});
