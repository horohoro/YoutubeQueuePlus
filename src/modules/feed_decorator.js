/**
 * YoutubeQueuePlus - Feed Card Decorator Module
 * Dynamically decorates feed video cards (ytd-rich-item-renderer, ytd-video-renderer,
 * ytd-compact-video-renderer) with custom queue status attributes and badges.
 * Supports badge_and_dim, hide, and badge_only modes with dynamic updates and
 * infinite scroll observation.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const Constants = typeof require === 'function' ? require('../shared/constants') : null;
    const StorageKeys = typeof require === 'function' ? require('../shared/storage_keys') : null;
    const DomHelpers = typeof require === 'function' ? require('../utils/dom_helpers') : null;
    const UrlParser = typeof require === 'function' ? require('../utils/url_parser') : null;
    const FeedDecoratorClass = factory(Constants, StorageKeys, DomHelpers, UrlParser);
    module.exports = FeedDecoratorClass;
    module.exports.FeedDecorator = FeedDecoratorClass;
    module.exports.default = FeedDecoratorClass;
  } else {
    root.__YQP__ = root.__YQP__ || {};
    root.__YQP__.FeedDecorator = factory(
      root.__YQP__.Constants,
      root.__YQP__.StorageKeys,
      root.__YQP__.DomHelpers,
      root.__YQP__.UrlParser
    );
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ConstantsModule, StorageKeysModule, DomHelpersModule, UrlParserModule) {
  'use strict';

  // Fallback defaults in case dependencies are loaded asynchronously
  const SELECTORS = ConstantsModule?.SELECTORS || {
    FEED_CARDS_ALL: 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer',
    CARD_THUMBNAIL_CONTAINER: '#thumbnail, ytd-thumbnail, .ytd-thumbnail'
  };

  const ATTRIBUTES = ConstantsModule?.ATTRIBUTES || {
    STATUS: 'data-yqp-status',
    MODE: 'data-yqp-mode',
    VIDEO_ID: 'data-yqp-video-id'
  };

  const CLASSES = ConstantsModule?.CLASSES || {
    BADGE: 'yqp-queue-badge'
  };

  const FEED_MODES = ConstantsModule?.FEED_MODES || {
    BADGE_AND_DIM: 'badge_and_dim',
    HIDE: 'hide',
    BADGE_ONLY: 'badge_only'
  };

  const VALID_MODES = new Set([
    FEED_MODES.BADGE_AND_DIM,
    FEED_MODES.HIDE,
    FEED_MODES.BADGE_ONLY
  ]);

  const UI_LABELS = ConstantsModule?.UI_LABELS || {
    BADGE_TEXT: 'QUEUED'
  };

  const DomHelpers = DomHelpersModule || {
    safeQuery: (sel, ctx) => (ctx || document)?.querySelector?.(sel) || null,
    safeQueryAll: (sel, ctx) => Array.from((ctx || document)?.querySelectorAll?.(sel) || []),
    setDataset: (el, k, v) => el?.setAttribute?.(`data-yqp-${k}`, String(v)),
    getDataset: (el, k) => el?.getAttribute?.(`data-yqp-${k}`) || null,
    removeDataset: (el, k) => el?.removeAttribute?.(`data-yqp-${k}`),
    debounce: (fn, ms) => {
      let t = null;
      const d = (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
      };
      d.cancel = () => clearTimeout(t);
      return d;
    }
  };

  const UrlParser = UrlParserModule || {
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

  class FeedDecorator {
    /**
     * @param {Object} [options]
     * @param {string} [options.mode='badge_and_dim'] - Feed treatment mode.
     * @param {string[]|Set<string>} [options.videoIds=[]] - Initial queued video IDs.
     * @param {Element|Document} [options.root=document] - Root DOM node to query/observe.
     * @param {boolean} [options.autoObserve=true] - Whether to automatically start MutationObserver.
     * @param {number} [options.debounceMs=0] - Debounce delay in ms for DOM mutation scans.
     * @param {number} [options.debounceDelay] - Alias for debounceMs.
     */
    constructor(options = {}) {
      this.mode = VALID_MODES.has(options.mode) ? options.mode : FEED_MODES.BADGE_AND_DIM;
      this.activeQueueIds = new Set();
      this.root = options.root || (typeof document !== 'undefined' ? document : null);
      this.observer = null;
      this.isObserving = false;
      this.boundHandleNavigation = this._handleNavigation.bind(this);

      this.debounceMs = typeof options.debounceDelay === 'number'
        ? options.debounceDelay
        : (typeof options.debounceMs === 'number' ? options.debounceMs : 0);

      // Debounced scanner for DOM mutations to prevent layout thrashing
      this.debouncedScan = DomHelpers.debounce(this.scanAndDecorate.bind(this), this.debounceMs);

      if (options.videoIds) {
        this._setVideoIdsInternal(options.videoIds);
      }

      if (options.autoObserve !== false && typeof window !== 'undefined') {
        this.startObserving();
      }

      // Initial scan if root document is available
      this.scanAndDecorate();
    }

    /**
     * Internal helper to normalize and populate active queue set.
     * @param {string[]|Set<string>} videoIds
     * @private
     */
    _setVideoIdsInternal(videoIds) {
      this.activeQueueIds.clear();
      if (videoIds && typeof videoIds[Symbol.iterator] === 'function') {
        for (const id of videoIds) {
          if (UrlParser.isValidVideoId(id)) {
            this.activeQueueIds.add(id);
          }
        }
      }
    }

    /**
     * Updates active queue and synchronizes feed card decorations across the DOM.
     * Uses diffing to only modify cards that have changed state.
     * @param {string[]|Set<string>} videoIds - Active queued video IDs.
     */
    updateQueue(videoIds) {
      const nextIds = new Set();
      if (videoIds && typeof videoIds[Symbol.iterator] === 'function') {
        for (const id of videoIds) {
          if (UrlParser.isValidVideoId(id)) {
            nextIds.add(id);
          }
        }
      }

      this.activeQueueIds = nextIds;
      this.scanAndDecorate();
    }

    /**
     * Sets the feed treatment mode and immediately updates all currently queued cards.
     * @param {string} mode - 'badge_and_dim' | 'hide' | 'badge_only'
     */
    setMode(mode) {
      const cleanMode = VALID_MODES.has(mode) ? mode : FEED_MODES.BADGE_AND_DIM;
      if (this.mode === cleanMode) return;

      this.mode = cleanMode;

      // Immediately update mode attribute and inline styles on all currently queued cards
      const targetRoot = this._getTargetRoot();
      if (!targetRoot || typeof targetRoot.querySelectorAll !== 'function') return;

      const queuedCards = targetRoot.querySelectorAll(`[${ATTRIBUTES.STATUS}="queued"]`);
      for (const card of queuedCards) {
        card.setAttribute(ATTRIBUTES.MODE, this.mode);
        this._applyModeStyles(card);
      }
    }

    /**
     * Returns the active feed treatment mode.
     * @returns {string}
     */
    getMode() {
      return this.mode;
    }

    /**
     * Returns a copy of the active queued video IDs set.
     * @returns {Set<string>}
     */
    getActiveQueueIds() {
      return new Set(this.activeQueueIds);
    }

    _getTargetRoot() {
      if (this.root && this.root.body) return this.root.body;
      if (this.root) return this.root;
      if (typeof document !== 'undefined') return document.body || document;
      return null;
    }

    /**
     * Scans all video cards in the DOM and applies/clears decorations according to active queue.
     */
    scanAndDecorate() {
      const targetRoot = this._getTargetRoot();
      if (!targetRoot || typeof targetRoot.querySelectorAll !== 'function') return;

      // 1. Check all cards currently marked as queued: un-decorate any that were removed
      const decoratedCards = targetRoot.querySelectorAll(`[${ATTRIBUTES.STATUS}="queued"]`);
      for (const card of decoratedCards) {
        const videoId = this.getVideoId(card);
        if (!videoId || !this.activeQueueIds.has(videoId)) {
          this.undecorateCard(card);
        } else {
          // If still queued, ensure mode attribute and styling matches current mode
          if (card.getAttribute(ATTRIBUTES.MODE) !== this.mode) {
            card.setAttribute(ATTRIBUTES.MODE, this.mode);
          }
          this._applyModeStyles(card);
        }
      }

      // If active queue is empty, all queued cards are now cleared; exit early
      if (this.activeQueueIds.size === 0) return;

      // 2. Query all feed card renderers in the DOM
      const cards = targetRoot.querySelectorAll(SELECTORS.FEED_CARDS_ALL);
      for (const card of cards) {
        const videoId = this.getVideoId(card);
        if (videoId && this.activeQueueIds.has(videoId)) {
          this.decorateCard(card, videoId);
        }
      }
    }

    /**
     * Extracts and validates the 11-char video ID from a card element.
     * Resilient to Polymer recycled DOM nodes where anchor href changes.
     * @param {Element} card
     * @returns {string|null}
     */
    getVideoId(card) {
      if (!card) return null;

      // In recycled elements, check child anchor href first to verify current ID
      const anchor = card.querySelector?.('a#thumbnail[href], a#video-title-link[href], a#video-title[href], a[href*="v="]');
      if (anchor && typeof anchor.getAttribute === 'function') {
        const href = anchor.getAttribute('href');
        const extracted = UrlParser.extractVideoId ? UrlParser.extractVideoId(href) : null;
        if (extracted) {
          if (card.getAttribute(ATTRIBUTES.VIDEO_ID) !== extracted) {
            card.setAttribute(ATTRIBUTES.VIDEO_ID, extracted);
          }
          return extracted;
        }
      }

      // Fallback: check cached data attribute
      const cached = card.getAttribute?.(ATTRIBUTES.VIDEO_ID);
      if (cached && UrlParser.isValidVideoId(cached)) {
        return cached;
      }

      // Fallback: extractVideoIdFromElement
      const parsed = UrlParser.extractVideoIdFromElement ? UrlParser.extractVideoIdFromElement(card) : null;
      if (parsed) {
        card.setAttribute(ATTRIBUTES.VIDEO_ID, parsed);
        return parsed;
      }

      return null;
    }

    /**
     * Decorates a single feed card with queue status, mode, and badge.
     * @param {Element} card - Feed card element
     * @param {string} videoId - 11-char video ID
     */
    decorateCard(card, videoId) {
      if (!card) return;

      // Set host attributes
      card.setAttribute(ATTRIBUTES.STATUS, 'queued');
      card.setAttribute(ATTRIBUTES.MODE, this.mode);
      if (videoId) {
        card.setAttribute(ATTRIBUTES.VIDEO_ID, videoId);
      }

      // Apply mode-specific presentation
      this._applyModeStyles(card);

      // Locate thumbnail container
      let thumbContainer = null;
      if (typeof card.querySelector === 'function') {
        thumbContainer = card.querySelector(SELECTORS.CARD_THUMBNAIL_CONTAINER) ||
                         card.querySelector('#thumbnail') ||
                         card.querySelector('ytd-thumbnail') ||
                         card.querySelector('.ytd-thumbnail') ||
                         card.querySelector('a#thumbnail');
      }

      const targetParent = thumbContainer || card;

      // Inject badge if not already present
      let badge = null;
      if (typeof card.querySelector === 'function') {
        badge = card.querySelector(`.${CLASSES.BADGE}`);
      }

      if (!badge) {
        badge = this._createBadgeElement();
        targetParent.appendChild(badge);
      }
    }

    /**
     * Applies inline styles corresponding to current feed treatment mode.
     * @param {Element} card
     * @private
     */
    _applyModeStyles(card) {
      if (!card || !card.style) return;

      if (this.mode === FEED_MODES.BADGE_AND_DIM) {
        card.style.opacity = '0.4';
        if (card.style.display === 'none') {
          card.style.display = '';
        }
      } else if (this.mode === FEED_MODES.HIDE) {
        card.style.display = 'none';
        if (card.style.opacity === '0.4') {
          card.style.opacity = '';
        }
      } else if (this.mode === FEED_MODES.BADGE_ONLY) {
        if (card.style.opacity === '0.4') {
          card.style.opacity = '';
        }
        if (card.style.display === 'none') {
          card.style.display = '';
        }
      }
    }

    /**
     * Removes queue decorations, styling, and badge from a single card.
     * @param {Element} card
     */
    undecorateCard(card) {
      if (!card) return;

      card.removeAttribute(ATTRIBUTES.STATUS);
      card.removeAttribute(ATTRIBUTES.MODE);

      // Restore inline styles
      if (card.style) {
        if (card.style.opacity === '0.4') {
          card.style.opacity = '';
        }
        if (card.style.display === 'none') {
          card.style.display = '';
        }
      }

      // Locate and remove existing badge
      if (typeof card.querySelector === 'function') {
        const badge = card.querySelector(`.${CLASSES.BADGE}`);
        if (badge) {
          if (typeof badge.remove === 'function') {
            badge.remove();
          } else if (badge.parentNode) {
            badge.parentNode.removeChild(badge);
          }
        }
      }
    }

    /**
     * Creates a high-fidelity .yqp-queue-badge element.
     * @returns {Element}
     * @private
     */
    _createBadgeElement() {
      const doc = this.root?.ownerDocument || (typeof document !== 'undefined' ? document : null);
      if (!doc || typeof doc.createElement !== 'function') {
        return { tagName: 'DIV', className: CLASSES.BADGE, textContent: UI_LABELS.BADGE_TEXT };
      }

      const badge = doc.createElement('div');
      badge.className = CLASSES.BADGE;
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = UI_LABELS.BADGE_TEXT;

      return badge;
    }

    /**
     * Alias for startObserving.
     */
    start() {
      this.startObserving();
    }

    /**
     * Starts observing the DOM for dynamic additions (infinite scroll).
     */
    startObserving() {
      if (this.isObserving) return;

      const targetRoot = this._getTargetRoot();
      const ObserverClass = typeof MutationObserver !== 'undefined' ? MutationObserver : globalThis?.MutationObserver;

      if (ObserverClass && targetRoot) {
        this.observer = new ObserverClass((mutations) => {
          let hasRelevantMutations = false;
          for (const mutation of mutations) {
            if (mutation.addedNodes && mutation.addedNodes.length > 0) {
              for (const node of mutation.addedNodes) {
                if (node.nodeType === 1) { // ELEMENT_NODE
                  hasRelevantMutations = true;
                  break;
                }
              }
            }
            if (hasRelevantMutations) break;
          }

          if (hasRelevantMutations) {
            this.debouncedScan();
          }
        });

        try {
          this.observer.observe(targetRoot, { childList: true, subtree: true });
          this.isObserving = true;
        } catch (_) {}
      }

      // Listen for YouTube SPA page transitions
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('yt-navigate-finish', this.boundHandleNavigation);
      }
    }

    /**
     * Alias for stopObserving.
     */
    stop() {
      this.stopObserving();
    }

    /**
     * Stops the MutationObserver and unbinds event listeners.
     */
    stopObserving() {
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
      this.isObserving = false;

      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('yt-navigate-finish', this.boundHandleNavigation);
      }

      if (this.debouncedScan && typeof this.debouncedScan.cancel === 'function') {
        this.debouncedScan.cancel();
      }
    }

    /**
     * Handler invoked upon YouTube SPA navigation.
     * @private
     */
    _handleNavigation() {
      this.debouncedScan();
    }

    /**
     * Completely destroys the decorator instance.
     * Stops observing and cleans up resources.
     */
    destroy() {
      this.stopObserving();
      this.activeQueueIds.clear();

      // Clean up decorations on all currently decorated cards
      const targetRoot = this._getTargetRoot();
      if (targetRoot && typeof targetRoot.querySelectorAll === 'function') {
        const decorated = targetRoot.querySelectorAll(`[${ATTRIBUTES.STATUS}="queued"]`);
        for (const card of decorated) {
          this.undecorateCard(card);
        }
      }
    }
  }

  return FeedDecorator;
});
