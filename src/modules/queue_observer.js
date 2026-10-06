/**
 * YoutubeQueuePlus - Native Queue Observer
 * Monitors YouTube's native queue containers (watch page sidebar & floating miniplayer),
 * extracts ordered video IDs, tracks the playing item index, and emits synchronized
 * queue state via Pub/Sub.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const Constants = typeof require === 'function' ? require('../shared/constants') : null;
    const UrlParser = typeof require === 'function' ? require('../utils/url_parser') : null;
    const DomHelpers = typeof require === 'function' ? require('../utils/dom_helpers') : null;
    const QueueObserverClass = factory(Constants, UrlParser, DomHelpers);
    module.exports = QueueObserverClass;
    module.exports.QueueObserver = QueueObserverClass;
    module.exports.default = QueueObserverClass;
  } else {
    root.__YQP__ = root.__YQP__ || {};
    root.__YQP__.QueueObserver = factory(
      root.__YQP__.Constants,
      root.__YQP__.UrlParser,
      root.__YQP__.DomHelpers
    );
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ConstantsModule, UrlParserModule, DomHelpersModule) {
  'use strict';

  // Fallback defaults in case modules are loaded out of order
  const Constants = ConstantsModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.Constants) || {
    SELECTORS: {
      QUEUE_PANEL: 'ytd-playlist-panel-renderer',
      WATCH_PANEL: 'ytd-watch-flexy ytd-playlist-panel-renderer, #secondary ytd-playlist-panel-renderer',
      MINIPLAYER_PANEL: 'ytd-miniplayer[active] ytd-playlist-panel-renderer[within-miniplayer]',
      MINIPLAYER_CONTAINER: 'ytd-miniplayer',
      MINIPLAYER_ACTIVE: 'ytd-miniplayer[active]',
      QUEUE_ITEMS_CONTAINER: 'ytd-playlist-panel-renderer #items, #items.ytd-playlist-panel-renderer',
      QUEUE_ITEM: 'ytd-playlist-panel-video-renderer',
      QUEUE_ITEM_SELECTED: 'ytd-playlist-panel-video-renderer[selected]',
      QUEUE_ITEM_ENDPOINT: 'a#wc-endpoint, a#thumbnail',
      QUEUE_ITEM_TITLE: '#video-title'
    },
    EVENTS: {
      YT_NAVIGATE_FINISH: 'yt-navigate-finish',
      YT_PAGE_DATA_UPDATED: 'yt-page-data-updated'
    },
    TIMING: {
      MUTATION_DEBOUNCE_MS: 100
    }
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
    safeQuery: (sel, ctx) => {
      try { return (ctx || document)?.querySelector?.(sel) || null; } catch (_) { return null; }
    },
    safeQueryAll: (sel, ctx) => {
      try { return Array.from((ctx || document)?.querySelectorAll?.(sel) || []); } catch (_) { return []; }
    },
    matches: (el, sel) => {
      try { return el?.matches?.(sel) || false; } catch (_) { return false; }
    },
    closest: (el, sel) => {
      try { return el?.closest?.(sel) || null; } catch (_) { return null; }
    },
    debounce: (fn, ms) => {
      let t = null;
      const d = (...args) => {
        clearTimeout(t);
        t = setTimeout(() => { t = null; fn(...args); }, ms);
      };
      d.cancel = () => { clearTimeout(t); t = null; };
      d.flush = (...args) => { clearTimeout(t); t = null; fn(...args); };
      return d;
    }
  };

  const SELECTORS = Constants.SELECTORS;
  const DEBOUNCE_MS = Constants.TIMING?.MUTATION_DEBOUNCE_MS || 100;

  class QueueObserver {
    /**
     * @param {Object} [options]
     * @param {Document} [options.document] - Document context for DOM operations
     * @param {Window} [options.window] - Window context for event listeners
     * @param {number} [options.debounceMs] - Debounce delay in ms
     * @param {number} [options.debounceDelay] - Alias for debounceMs
     * @param {boolean} [options.autoStart=true] - Whether to begin observing immediately
     */
    constructor(options = {}) {
      this.doc = options.document || (typeof document !== 'undefined' ? document : null);
      this.win = options.window || (typeof window !== 'undefined' ? window : null);
      this.debounceMs = typeof options.debounceDelay === 'number'
        ? options.debounceDelay
        : (typeof options.debounceMs === 'number' ? options.debounceMs : DEBOUNCE_MS);

      // Queue state model
      this.activeVideoIds = [];
      this.activeIdsSet = new Set();
      this.currentIndex = 0;
      this.currentVideoId = null;
      this.count = 0;
      this.items = [];
      this.lastUpdated = 0;
      this._isStarted = false;

      // Internal caches
      this._lastSignature = null;
      this._subscribers = new Set();
      this._currentPanelEl = null;
      this._currentItemsEl = null;

      // Observers
      this._itemsObserver = null;
      this._containerObserver = null;

      // Debounced rescan
      this._debouncedRescan = DomHelpers.debounce(
        () => this._rescanQueue(),
        this.debounceMs
      );

      // Event listener references
      this._boundOnNavigate = () => this.rescan(true);
      this._boundOnPageData = () => this.rescan(true);

      if (options.autoStart !== false) {
        this.start();
      }
    }

    // =========================================================================
    // Public Query API
    // =========================================================================

    /**
     * Returns ordered array of active video IDs.
     * @returns {string[]}
     */
    getActiveVideoIds() {
      return [...this.activeVideoIds];
    }

    /**
     * Returns Set of active video IDs for O(1) membership check.
     * @returns {Set<string>}
     */
    getActiveIdsSet() {
      return this.activeIdsSet;
    }

    /**
     * Returns 0-based index of currently playing video.
     * @returns {number}
     */
    getCurrentIndex() {
      return this.currentIndex;
    }

    /**
     * Returns video ID of currently playing video.
     * @returns {string|null}
     */
    getCurrentVideoId() {
      return this.currentVideoId;
    }

    /**
     * Returns number of videos in active queue.
     * @returns {number}
     */
    getCount() {
      return this.count;
    }

    /**
     * Returns complete snapshot of queue state.
     * @returns {Object}
     */
    getState() {
      return {
        videoIds: [...this.activeVideoIds],
        currentIndex: this.currentIndex,
        currentVideoId: this.currentVideoId,
        count: this.count,
        items: [...this.items],
        lastUpdated: this.lastUpdated
      };
    }

    /**
     * Returns true if active queue has at least 1 video.
     * @returns {boolean}
     */
    isQueueActive() {
      return this.count > 0;
    }

    // =========================================================================
    // Subscription Pub/Sub API
    // =========================================================================

    /**
     * Subscribes to queue state changes.
     * @param {Function} callback - Called with snapshot state { videoIds, currentIndex, count, ... }
     * @param {Object} [options]
     * @param {boolean} [options.immediate=true] - Whether to invoke immediately with current state
     * @returns {Function} Unsubscribe function
     */
    subscribe(callback, options = {}) {
      if (typeof callback !== 'function') {
        return () => {};
      }

      this._subscribers.add(callback);

      if (options.immediate !== false) {
        try {
          callback(this.getState());
        } catch (err) {
          console.error('[YQP QueueObserver] Immediate subscriber callback error:', err);
        }
      }

      return () => {
        this._subscribers.delete(callback);
      };
    }

    // =========================================================================
    // Lifecycle & Observer Management
    // =========================================================================

    /**
     * Starts observing DOM mutations and SPA navigation events.
     */
    start() {
      if (this._isStarted) {
        this.rescan(true);
        return;
      }
      this._isStarted = true;
      if (!this._getDoc()) return;

      // 1. Initial container binding and rescan
      this._bindObservers();
      this.rescan(true);

      // 2. Attach SPA navigation listeners
      if (this.win && typeof this.win.addEventListener === 'function') {
        this.win.addEventListener(Constants.EVENTS.YT_NAVIGATE_FINISH, this._boundOnNavigate);
        this.win.addEventListener(Constants.EVENTS.YT_PAGE_DATA_UPDATED, this._boundOnPageData);
      }
    }

    /**
     * Forces rescan of the native queue DOM.
     * @param {boolean} [immediate=false]
     */
    rescan(immediate = false) {
      if (immediate || this.debounceMs === 0) {
        if (this._debouncedRescan && typeof this._debouncedRescan.cancel === 'function') {
          this._debouncedRescan.cancel();
        }
        this._rescanQueue();
      } else if (this._debouncedRescan) {
        this._debouncedRescan();
      }
    }

    /**
     * Disconnects observers, event listeners, and pending timers.
     */
    destroy() {
      this._isStarted = false;

      if (this._debouncedRescan && typeof this._debouncedRescan.cancel === 'function') {
        this._debouncedRescan.cancel();
      }

      if (this._itemsObserver) {
        this._itemsObserver.disconnect();
        this._itemsObserver = null;
      }

      if (this._containerObserver) {
        this._containerObserver.disconnect();
        this._containerObserver = null;
      }

      if (this.win && typeof this.win.removeEventListener === 'function') {
        this.win.removeEventListener(Constants.EVENTS.YT_NAVIGATE_FINISH, this._boundOnNavigate);
        this.win.removeEventListener(Constants.EVENTS.YT_PAGE_DATA_UPDATED, this._boundOnPageData);
      }

      this._subscribers.clear();
      this._currentPanelEl = null;
      this._currentItemsEl = null;
    }

    // =========================================================================
    // DOM Container Discovery
    // =========================================================================

    _getDoc() {
      return this.doc || (typeof document !== 'undefined' ? document : null);
    }

    /**
     * Resolves the active ytd-playlist-panel-renderer element.
     * Prioritizes watch page sidebar or active floating miniplayer.
     * Skips panels that reside inside an inactive miniplayer.
     * @returns {Element|null}
     */
    _findActiveQueuePanel() {
      const doc = this._getDoc();
      if (!doc) return null;

      const pathname = (this.win?.location?.pathname) || '';
      const isWatchPage = typeof pathname === 'string' && pathname.startsWith('/watch');

      // 1. If on watch page, prioritize watch page sidebar panel
      if (isWatchPage) {
        const watchPanel = DomHelpers.safeQuery(SELECTORS.WATCH_PANEL, doc);
        if (watchPanel && this._hasQueueItems(watchPanel) && !this._isInInactiveMiniplayer(watchPanel)) {
          return watchPanel;
        }
      }

      // 2. Check active miniplayer panel (miniplayer with [active] attribute)
      const miniplayerPanel = DomHelpers.safeQuery(SELECTORS.MINIPLAYER_PANEL, doc);
      if (miniplayerPanel && this._hasQueueItems(miniplayerPanel)) {
        return miniplayerPanel;
      }

      // 3. Fallback: Check miniplayer container with active attribute
      const activeMiniplayer = DomHelpers.safeQuery(SELECTORS.MINIPLAYER_ACTIVE, doc);
      if (activeMiniplayer) {
        const panelWithin = DomHelpers.safeQuery(SELECTORS.QUEUE_PANEL, activeMiniplayer);
        if (panelWithin && this._hasQueueItems(panelWithin)) {
          return panelWithin;
        }
      }

      // 4. Fallback: Check any watch panel
      const fallbackWatch = DomHelpers.safeQuery(SELECTORS.WATCH_PANEL, doc);
      if (fallbackWatch && this._hasQueueItems(fallbackWatch) && !this._isInInactiveMiniplayer(fallbackWatch)) {
        return fallbackWatch;
      }

      // 5. Fallback: Any playlist-panel-renderer that has items and is NOT in an inactive miniplayer
      const allPanels = DomHelpers.safeQueryAll(SELECTORS.QUEUE_PANEL, doc);
      for (const panel of allPanels) {
        if (this._isInInactiveMiniplayer(panel)) {
          continue;
        }
        if (this._hasQueueItems(panel)) {
          return panel;
        }
      }

      return null;
    }

    /**
     * Checks if a panel is inside a ytd-miniplayer element that lacks the [active] attribute.
     * @param {Element} panel
     * @returns {boolean}
     */
    _isInInactiveMiniplayer(panel) {
      if (!panel) return false;
      const miniplayer = DomHelpers.closest(panel, SELECTORS.MINIPLAYER_CONTAINER || 'ytd-miniplayer');
      if (miniplayer && !miniplayer.hasAttribute('active')) {
        return true;
      }
      return false;
    }

    /**
     * Checks if a panel element contains #items and at least 1 queue item.
     * @param {Element} panel
     * @returns {boolean}
     */
    _hasQueueItems(panel) {
      if (!panel) return false;
      // Guard against hidden watch panel on home page or non-watch routes
      if (panel.hasAttribute?.('hidden') || panel.style?.display === 'none' || panel.hidden === true) {
        return false;
      }
      const itemsContainer = DomHelpers.safeQuery('#items', panel) || panel;
      const items = DomHelpers.safeQueryAll(SELECTORS.QUEUE_ITEM, itemsContainer);
      return items.length > 0;
    }

    /**
     * Resolves the #items container within the active queue panel.
     * @param {Element} panel
     * @returns {Element|null}
     */
    _findItemsContainer(panel) {
      if (!panel) return null;
      return DomHelpers.safeQuery('#items', panel) || panel;
    }

    // =========================================================================
    // Observer Binding Strategy
    // =========================================================================

    /**
     * Binds MutationObservers to #items and host container.
     */
    _bindObservers() {
      const doc = this._getDoc();
      if (!doc) return;

      const MutationObserverClass = this.win?.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
      if (!MutationObserverClass) {
        return;
      }

      // 1. Container observer for dynamic appearance / route changes
      if (!this._containerObserver) {
        this._containerObserver = new MutationObserver((mutations) => {
          let shouldRebind = false;
          for (const m of mutations) {
            if (m.type === 'childList') {
              shouldRebind = true;
              break;
            }
            if (m.type === 'attributes' && (m.attributeName === 'active' || m.attributeName === 'hidden')) {
              shouldRebind = true;
              break;
            }
          }
          if (shouldRebind) {
            this._rebindContainer();
          }
        });

        const targetHost = doc.body || doc.documentElement || doc;
        if (targetHost && typeof targetHost.querySelector === 'function') {
          try {
            this._containerObserver.observe(targetHost, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['active', 'hidden']
            });
          } catch (_) {}
        }
      }

      // 2. Re-bind items observer
      this._rebindContainer();
    }

    /**
     * Re-binds items observer when queue container changes.
     */
    _rebindContainer() {
      const MutationObserverClass = this.win?.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
      if (!MutationObserverClass) return;

      const activePanel = this._findActiveQueuePanel();
      const itemsContainer = activePanel ? this._findItemsContainer(activePanel) : null;

      if (itemsContainer === this._currentItemsEl && itemsContainer !== null) {
        return;
      }

      if (this._itemsObserver) {
        this._itemsObserver.disconnect();
        this._itemsObserver = null;
      }

      this._currentPanelEl = activePanel;
      this._currentItemsEl = itemsContainer;

      if (itemsContainer) {
        this._itemsObserver = new MutationObserver(() => {
          this.rescan(this.debounceMs === 0);
        });

        try {
          this._itemsObserver.observe(itemsContainer, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['selected', 'class']
          });
        } catch (_) {}
      }

      this.rescan(this.debounceMs === 0);
    }

    // =========================================================================
    // Core Queue Extraction & State Emission
    // =========================================================================

    /**
     * Extracts active video IDs, calculates current index, diffs signature,
     * and notifies subscribers if state has changed.
     */
    _rescanQueue() {
      const doc = this._getDoc();
      if (!doc) return;

      const activePanel = this._findActiveQueuePanel();
      const itemsContainer = activePanel ? this._findItemsContainer(activePanel) : null;

      const rawItemEls = itemsContainer
        ? DomHelpers.safeQueryAll(SELECTORS.QUEUE_ITEM, itemsContainer)
        : [];

      const newVideoIds = [];
      const newItems = [];
      let selectedIndex = -1;

      for (let i = 0; i < rawItemEls.length; i++) {
        const itemEl = rawItemEls[i];

        // 1. Extract 11-char video ID - prioritize fresh child anchor href to prevent stale attributes under DOM recycling
        let videoId = null;
        const endpoint = DomHelpers.safeQuery(SELECTORS.QUEUE_ITEM_ENDPOINT || 'a#wc-endpoint', itemEl) ||
          (itemEl.querySelector && itemEl.querySelector('a#wc-endpoint, a#thumbnail, a[href*="watch?v="], a[href*="/watch?"], a[href*="v="], a'));
        if (endpoint && endpoint.getAttribute) {
          const href = endpoint.getAttribute('href');
          if (href) {
            videoId = UrlParser.extractVideoId(href);
          }
        }
        if (!videoId) {
          videoId = UrlParser.extractVideoIdFromElement(itemEl);
        }

        if (videoId && UrlParser.isValidVideoId(videoId)) {
          newVideoIds.push(videoId);
          if (typeof itemEl.setAttribute === 'function') {
            itemEl.setAttribute('data-yqp-video-id', videoId);
          }

          // 2. Extract item metadata
          const titleEl = DomHelpers.safeQuery(SELECTORS.QUEUE_ITEM_TITLE, itemEl);
          const channelEl = DomHelpers.safeQuery('#byline, #channel-name, .ytd-channel-name', itemEl);
          const durationEl = DomHelpers.safeQuery('#badge, .badge-shape-wiz__text', itemEl);
          const imgEl = DomHelpers.safeQuery('img#img, img', itemEl);

          newItems.push({
            id: videoId,
            title: titleEl ? (titleEl.textContent || titleEl.innerText || '').trim() : '',
            channelTitle: channelEl ? (channelEl.textContent || channelEl.innerText || '').trim() : '',
            duration: durationEl ? (durationEl.textContent || '').trim() : '',
            thumbnailUrl: imgEl ? (imgEl.getAttribute?.('src') || '') : ''
          });

          // 3. Check selected state
          if (itemEl.hasAttribute?.('selected') || DomHelpers.matches(itemEl, SELECTORS.QUEUE_ITEM_SELECTED)) {
            if (selectedIndex === -1) {
              selectedIndex = newVideoIds.length - 1;
            }
          }
        }
      }

      // 4. Calculate currentIndex and currentVideoId
      let newCurrentIndex = 0;
      let newCurrentVideoId = null;

      if (newVideoIds.length > 0) {
        if (selectedIndex >= 0) {
          newCurrentIndex = selectedIndex;
        } else {
          // Fallback: check current URL video ID
          const currentUrl = (this.win?.location?.href) || '';
          const urlVideoId = UrlParser.extractVideoId(currentUrl);
          const foundIdx = urlVideoId ? newVideoIds.indexOf(urlVideoId) : -1;

          if (foundIdx >= 0) {
            newCurrentIndex = foundIdx;
          } else if (this.currentIndex >= 0 && this.currentIndex < newVideoIds.length) {
            newCurrentIndex = this.currentIndex;
          } else {
            newCurrentIndex = 0;
          }
        }

        newCurrentIndex = Math.max(0, Math.min(newCurrentIndex, newVideoIds.length - 1));
        newCurrentVideoId = newVideoIds[newCurrentIndex] || null;
      }

      // 5. In-Memory Diff Check
      const newSignature = `${newVideoIds.join(',')}|${newCurrentIndex}|${newCurrentVideoId || ''}`;
      if (newSignature === this._lastSignature) {
        return; // Skip redundant emission
      }

      this._lastSignature = newSignature;
      this.activeVideoIds = newVideoIds;
      this.activeIdsSet = new Set(newVideoIds);
      this.currentIndex = newCurrentIndex;
      this.currentVideoId = newCurrentVideoId;
      this.count = newVideoIds.length;
      this.items = newItems;
      this.lastUpdated = Date.now();

      // 6. Notify Subscribers
      const stateSnapshot = this.getState();
      for (const subscriber of this._subscribers) {
        try {
          subscriber(stateSnapshot);
        } catch (err) {
          console.error('[YQP QueueObserver] Subscriber callback error:', err);
        }
      }
    }
  }

  return QueueObserver;
});
