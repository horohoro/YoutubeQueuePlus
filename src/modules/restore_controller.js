/**
 * YoutubeQueuePlus - Session Restore Controller
 * Universal Module Definition (UMD) wrapping with __YQP__.RestoreController.
 *
 * Responsibilities:
 * 1. Evaluates whether active queue is empty/closed and a valid saved session exists.
 * 2. Injects an unobtrusive floating banner (.yqp-restore-banner) below the masthead or atop feeds.
 * 3. Formats relative timestamp ("saved 5 minutes ago") and item count.
 * 4. Dispatches 1-click restore via YouTube's /watch_videos?video_ids=...&index=... endpoint.
 * 5. Manages non-nagging session dismissal tracking in storage & memory.
 * 6. Reacts to active queue changes, preference updates, and SPA navigations.
 * 7. Clean lifecycle teardown via destroy().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    let Constants = null;
    let StorageKeys = null;
    let DomHelpers = null;
    let UrlParser = null;
    try { Constants = require('../shared/constants'); } catch (_) {}
    try { StorageKeys = require('../shared/storage_keys'); } catch (_) {}
    try { DomHelpers = require('../utils/dom_helpers'); } catch (_) {}
    try { UrlParser = require('../utils/url_parser'); } catch (_) {}

    const RestoreControllerClass = factory(Constants, StorageKeys, DomHelpers, UrlParser);
    module.exports = RestoreControllerClass;
    module.exports.RestoreController = RestoreControllerClass;
    module.exports.default = RestoreControllerClass;
  } else {
    root.__YQP__ = root.__YQP__ || {};
    root.__YQP__.RestoreController = factory(
      root.__YQP__.Constants,
      root.__YQP__.StorageKeys,
      root.__YQP__.DomHelpers,
      root.__YQP__.UrlParser
    );
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ConstantsModule, StorageKeysModule, DomHelpersModule, UrlParserModule) {
  'use strict';

  const Constants = ConstantsModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.Constants) || {
    SELECTORS: {
      BANNER_PARENT_HOME: 'ytd-rich-grid-renderer #contents, #contents.ytd-rich-grid-renderer',
      BANNER_PARENT_PRIMARY: '#primary #contents, ytd-browse[page-subtype="home"] #contents',
      MASTHEAD_CONTAINER: '#masthead-container, ytd-masthead'
    },
    CLASSES: {
      RESTORE_BANNER: 'yqp-restore-banner',
      BANNER_TEXT: 'yqp-restore-banner-text',
      BANNER_ACTIONS: 'yqp-restore-banner-actions',
      BANNER_BTN_RESTORE: 'yqp-banner-btn-restore',
      BANNER_BTN_DISMISS: 'yqp-banner-btn-dismiss'
    },
    IDS: { RESTORE_BANNER: 'yqp-restore-banner' },
    UI_LABELS: {
      BANNER_RESTORE_TEXT: 'Queue session found ({count} videos)',
      BANNER_RESTORE_BTN: 'Restore Queue',
      BANNER_DISMISS_BTN: 'Dismiss'
    },
    EVENTS: {
      YT_NAVIGATE_FINISH: 'yt-navigate-finish',
      YT_PAGE_DATA_UPDATED: 'yt-page-data-updated'
    },
    STORAGE_KEYS: {
      ACTIVE_QUEUE: 'yqp_active_queue',
      SAVED_SESSION: 'yqp_saved_session',
      PREFERENCES: 'yqp_preferences',
      SESSION_STATE: 'yqp_session_state'
    }
  };

  const DomHelpers = DomHelpersModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.DomHelpers) || {
    safeQuery: (sel, ctx) => {
      try { return (ctx || document)?.querySelector?.(sel) || null; } catch (_) { return null; }
    },
    createElement: (tag, props, children) => {
      const el = document.createElement(tag);
      if (props) {
        for (const [k, v] of Object.entries(props)) {
          if (k === 'className' || k === 'class') el.className = v;
          else if (k === 'textContent') el.textContent = v;
          else if (v !== null && v !== undefined) el.setAttribute(k, String(v));
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
    removeElement: (el) => {
      if (el && el.parentNode) {
        el.parentNode.removeChild(el);
        return true;
      }
      return false;
    }
  };

  const UrlParser = UrlParserModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.UrlParser) || {
    isValidVideoId: (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id),
    buildRestoreUrl: (ids, idx) => `https://www.youtube.com/watch_videos?video_ids=${ids.join(',')}&index=${idx || 0}`
  };

  /**
   * Helper: Formats relative time difference from epoch millisecond timestamp.
   * @param {number} timestamp
   * @returns {string}
   */
  function formatRelativeTime(timestamp) {
    if (!timestamp || typeof timestamp !== 'number' || timestamp <= 0) {
      return 'recently';
    }
    const diffMs = Date.now() - timestamp;
    if (diffMs < 0) return 'just now';
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin === 1) return '1 minute ago';
    if (diffMin < 60) return `${diffMin} minutes ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours === 1) return '1 hour ago';
    if (diffHours < 24) return `${diffHours} hours ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return '1 day ago';
    if (diffDays < 30) return `${diffDays} days ago`;
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  class RestoreController {
    /**
     * @param {Object} [options={}]
     * @param {Object} [options.storageSync] - StorageSync instance
     * @param {Object} [options.queueObserver] - QueueObserver instance
     * @param {Document} [options.document] - Document context
     * @param {Window} [options.window] - Window context
     * @param {Function} [options.navigateFn] - Custom URL navigation handler
     * @param {boolean} [options.autoStart=true] - Whether to start immediately
     * @param {Object} [options.urlParser] - UrlParser override
     * @param {Object} [options.domHelpers] - DomHelpers override
     * @param {Object} [options.constants] - Constants override
     */
    constructor(options = {}) {
      this.storageSync = options.storageSync || null;
      this.queueObserver = options.queueObserver || null;
      this.doc = options.document || (typeof document !== 'undefined' ? document : null);
      this.win = options.window || (typeof window !== 'undefined' ? window : null);
      this.navigateFn = options.navigateFn || null;

      this.urlParser = options.urlParser || UrlParser;
      this.domHelpers = options.domHelpers || DomHelpers;
      this.constants = options.constants || Constants;

      this._bannerEl = null;
      this._dismissed = false;
      this._dismissedSessionSavedAt = 0;
      this._isDestroyed = false;
      this._unsubscribers = [];

      this._boundOnNavigate = () => this.checkAndShowBanner();
      this._boundOnPageData = () => this.checkAndShowBanner();

      if (options.autoStart !== false) {
        this.start();
      }
    }

    _getDoc() {
      return this.doc || (typeof document !== 'undefined' ? document : null);
    }

    // =========================================================================
    // Public API & Evaluation
    // =========================================================================

    start() {
      if (this._isDestroyed) return;
      this._bindSubscriptions();
      this.checkAndShowBanner();
    }

    /**
     * Checks whether a restore session is eligible to be shown.
     * @returns {Promise<boolean>}
     */
    async checkRestoreAvailable() {
      if (this._isDestroyed) return false;

      // 1. Preference check
      const prefs = await this._getPreferences();
      if (prefs && prefs.showRestoreBanner === false) {
        return false;
      }

      // 2. Active queue check
      const activeCount = await this._getActiveQueueCount();
      if (activeCount > 0) {
        return false;
      }

      // 3. Saved session check
      const savedSession = await this._getSavedSession();
      if (!savedSession || !Array.isArray(savedSession.videoIds) || savedSession.videoIds.length === 0) {
        return false;
      }

      const validIds = savedSession.videoIds.filter(id => this.urlParser.isValidVideoId(id));
      if (validIds.length === 0) {
        return false;
      }

      const sessionSavedAt = savedSession.savedAt || 0;

      // 4. In-memory dismissal check
      if (this._dismissed && this._dismissedSessionSavedAt >= sessionSavedAt && sessionSavedAt > 0) {
        return false;
      }

      // 5. Persistent session state dismissal check
      const sessionState = await this._getSessionState();
      if (sessionState && sessionState.bannerDismissedSessionSavedAt >= sessionSavedAt && sessionState.bannerDismissedSessionSavedAt > 0) {
        return false;
      }

      return true;
    }

    /**
     * Evaluates state and displays banner if criteria met, or hides it if not.
     * @returns {Promise<boolean>} Resolves true if banner is shown.
     */
    async checkAndShowBanner() {
      if (this._isDestroyed) return false;

      const isAvailable = await this.checkRestoreAvailable();
      if (!isAvailable) {
        this.hideBanner();
        return false;
      }

      const savedSession = await this._getSavedSession();
      return this._mountBanner(savedSession);
    }

    /**
     * Checks if banner is currently present and visible in DOM.
     * @returns {boolean}
     */
    isBannerVisible() {
      return Boolean(this._bannerEl && this._bannerEl.parentNode);
    }

    /**
     * Returns banner DOM element reference if mounted.
     * @returns {Element|null}
     */
    getBannerElement() {
      return this._bannerEl;
    }

    /**
     * Hides and cleanly removes banner from DOM.
     */
    hideBanner() {
      if (this._bannerEl) {
        this.domHelpers.removeElement(this._bannerEl);
        this._bannerEl = null;
      }
      const existing = this.domHelpers.safeQuery(`#${this.constants.IDS.RESTORE_BANNER}`, this._getDoc());
      if (existing) {
        this.domHelpers.removeElement(existing);
      }
    }

    // =========================================================================
    // 1-Click Restore & Dismiss Actions
    // =========================================================================

    /**
     * Performs 1-click restore to YouTube's native /watch_videos endpoint.
     * @param {Object} [sessionToRestore]
     * @returns {Promise<boolean>}
     */
    async restore(sessionToRestore) {
      const session = sessionToRestore || (await this._getSavedSession());
      if (!session || !Array.isArray(session.videoIds) || session.videoIds.length === 0) {
        return false;
      }

      const buildFn = this.urlParser.buildWatchVideosUrl || this.urlParser.buildRestoreUrl;
      const restoreUrl = buildFn(session.videoIds, session.currentIndex || 0);
      if (!restoreUrl) {
        return false;
      }

      // Record restore event in session state
      if (this.storageSync && typeof this.storageSync.setSessionState === 'function') {
        try {
          await this.storageSync.setSessionState({ lastRestoredTimestamp: Date.now() });
        } catch (_) {}
      }

      // Immediately hide banner
      this.hideBanner();

      // Trigger navigation
      if (typeof this.navigateFn === 'function') {
        this.navigateFn(restoreUrl);
      } else if (this.win?.location) {
        this.win.location.href = restoreUrl;
      }

      return true;
    }

    /**
     * Dismisses restore banner for the current session and records state.
     * @param {Object} [sessionToDismiss]
     * @returns {Promise<void>}
     */
    async dismiss(sessionToDismiss) {
      const session = sessionToDismiss || (await this._getSavedSession());
      const savedAt = session?.savedAt || Date.now();

      this._dismissed = true;
      this._dismissedSessionSavedAt = savedAt;

      this.hideBanner();

      if (this.storageSync && typeof this.storageSync.setSessionState === 'function') {
        try {
          await this.storageSync.setSessionState({
            bannerDismissedTimestamp: Date.now(),
            bannerDismissedSessionSavedAt: savedAt
          });
        } catch (err) {
          console.warn('[YQP RestoreController] Failed to persist dismissal state:', err);
        }
      }
    }

    // =========================================================================
    // Event Handler Delegates
    // =========================================================================

    onQueueUpdated(queueState) {
      if (this._isDestroyed) return;
      const count = (queueState?.videoIds && queueState.videoIds.length) || queueState?.count || 0;
      if (count > 0) {
        this.hideBanner();
      } else {
        this.checkAndShowBanner();
      }
    }

    onSavedSessionChanged(savedSession) {
      if (this._isDestroyed) return;
      this.checkAndShowBanner();
    }

    onPreferencesChanged(prefs) {
      if (this._isDestroyed) return;
      if (prefs && prefs.showRestoreBanner === false) {
        this.hideBanner();
      } else {
        this.checkAndShowBanner();
      }
    }

    // =========================================================================
    // DOM Mounting & Rendering
    // =========================================================================

    _mountBanner(savedSession) {
      const doc = this._getDoc();
      if (!doc) return false;

      // Avoid duplicate banner injection if already mounted
      if (this.isBannerVisible()) {
        this._updateBannerContent(savedSession);
        return true;
      }

      const target = this._findBannerTarget();
      if (!target || !target.parent) {
        return false;
      }

      const bannerEl = this._createBannerElement(savedSession);
      if (!bannerEl) return false;

      if (target.before) {
        target.parent.insertBefore(bannerEl, target.before);
      } else {
        target.parent.appendChild(bannerEl);
      }

      this._bannerEl = bannerEl;
      return true;
    }

    _findBannerTarget() {
      const doc = this._getDoc();
      if (!doc) return null;

      // Priority 1: Homepage Grid Contents
      const homeContents = this.domHelpers.safeQuery(this.constants.SELECTORS?.BANNER_PARENT_HOME, doc);
      if (homeContents) {
        return { parent: homeContents, before: homeContents.firstChild };
      }

      // Priority 2: Primary Browse Contents
      const primaryContents = this.domHelpers.safeQuery(this.constants.SELECTORS?.BANNER_PARENT_PRIMARY, doc);
      if (primaryContents) {
        return { parent: primaryContents, before: primaryContents.firstChild };
      }

      // Priority 3: Below Masthead Container
      const masthead = this.domHelpers.safeQuery(this.constants.SELECTORS?.MASTHEAD_CONTAINER, doc);
      if (masthead && masthead.parentNode) {
        return { parent: masthead.parentNode, before: masthead.nextSibling };
      }

      // Priority 4: Page Manager
      const pageManager = this.domHelpers.safeQuery('#page-manager, ytd-page-manager', doc);
      if (pageManager) {
        return { parent: pageManager, before: pageManager.firstChild };
      }

      // Priority 5: Body Fallback
      if (doc.body) {
        return { parent: doc.body, before: doc.body.firstChild };
      }

      return null;
    }

    _createElement(tag, props, children) {
      const doc = this._getDoc();
      if (!doc) return null;
      const el = doc.createElement(tag);
      if (props) {
        for (const [k, v] of Object.entries(props)) {
          if (k === 'className' || k === 'class') {
            if (typeof v === 'string') {
              v.split(/\s+/).filter(Boolean).forEach(c => el.classList?.add?.(c));
            }
          } else if (k === 'textContent') {
            el.textContent = v;
          } else if (v !== null && v !== undefined) {
            el.setAttribute(k, String(v));
          }
        }
      }
      if (Array.isArray(children)) {
        for (const c of children) {
          if (typeof c === 'string') {
            el.appendChild(doc.createTextNode ? doc.createTextNode(c) : { textContent: c });
          } else if (c) {
            el.appendChild(c);
          }
        }
      }
      return el;
    }

    _createBannerElement(session) {
      const count = session?.videoIds?.length || session?.count || 0;
      const countText = (this.constants.UI_LABELS?.BANNER_RESTORE_TEXT || 'Queue session found ({count} videos)').replace('{count}', count);
      const relativeTime = formatRelativeTime(session?.savedAt);

      const bannerEl = this._createElement('div', {
        id: this.constants.IDS.RESTORE_BANNER,
        className: this.constants.CLASSES.RESTORE_BANNER,
        role: 'banner',
        'aria-label': 'Restore previous queue session'
      });

      const textContainer = this._createElement('div', {
        className: this.constants.CLASSES.BANNER_TEXT
      });

      const titleSpan = this._createElement('span', {
        className: 'yqp-banner-title',
        textContent: countText
      });
      textContainer.appendChild(titleSpan);

      if (session?.savedAt > 0) {
        const timeSpan = this._createElement('span', {
          className: 'yqp-banner-timestamp',
          textContent: ` • saved ${relativeTime}`
        });
        textContainer.appendChild(timeSpan);
      }

      const actionsContainer = this._createElement('div', {
        className: this.constants.CLASSES.BANNER_ACTIONS
      });

      const restoreBtn = this._createElement('button', {
        type: 'button',
        className: this.constants.CLASSES.BANNER_BTN_RESTORE,
        textContent: this.constants.UI_LABELS?.BANNER_RESTORE_BTN || 'Restore Queue',
        'aria-label': 'Restore Queue'
      });

      const dismissBtn = this._createElement('button', {
        type: 'button',
        className: this.constants.CLASSES.BANNER_BTN_DISMISS,
        textContent: this.constants.UI_LABELS?.BANNER_DISMISS_BTN || 'Dismiss',
        'aria-label': 'Dismiss banner'
      });

      restoreBtn.addEventListener('click', (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        this.restore(session);
      });

      dismissBtn.addEventListener('click', (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        this.dismiss(session);
      });

      actionsContainer.appendChild(restoreBtn);
      actionsContainer.appendChild(dismissBtn);

      bannerEl.appendChild(textContainer);
      bannerEl.appendChild(actionsContainer);

      return bannerEl;
    }

    _updateBannerContent(session) {
      if (!this._bannerEl) return;
      const titleEl = this.domHelpers.safeQuery('.yqp-banner-title', this._bannerEl);
      if (titleEl) {
        const count = session?.videoIds?.length || session?.count || 0;
        titleEl.textContent = (this.constants.UI_LABELS?.BANNER_RESTORE_TEXT || 'Queue session found ({count} videos)').replace('{count}', count);
      }
      const timeEl = this.domHelpers.safeQuery('.yqp-banner-timestamp', this._bannerEl);
      if (timeEl && session?.savedAt > 0) {
        timeEl.textContent = ` • saved ${formatRelativeTime(session.savedAt)}`;
      }
    }

    // =========================================================================
    // Reactive Subscriptions & Event Binding
    // =========================================================================

    _bindSubscriptions() {
      // 1. StorageSync Subscriptions
      if (this.storageSync && typeof this.storageSync.subscribe === 'function') {
        // Queue state changed -> hide if queue became active
        const unsubQueue = this.storageSync.subscribe('queue', (queueState) => {
          this.onQueueUpdated(queueState);
        });
        if (typeof unsubQueue === 'function') this._unsubscribers.push(unsubQueue);

        // Saved session changed -> re-evaluate
        const unsubSession = this.storageSync.subscribe('saved_session', (savedSession) => {
          this.onSavedSessionChanged(savedSession);
        });
        if (typeof unsubSession === 'function') this._unsubscribers.push(unsubSession);

        // Preferences changed -> toggle visibility
        const unsubPrefs = this.storageSync.subscribe('preferences', (prefs) => {
          this.onPreferencesChanged(prefs);
        });
        if (typeof unsubPrefs === 'function') this._unsubscribers.push(unsubPrefs);

        // Session state changed -> hide if dismissed in another tab
        const unsubState = this.storageSync.subscribe('session_state', (state) => {
          if (state && state.bannerDismissedSessionSavedAt > 0) {
            this._dismissedSessionSavedAt = Math.max(this._dismissedSessionSavedAt, state.bannerDismissedSessionSavedAt);
            this.checkAndShowBanner();
          }
        });
        if (typeof unsubState === 'function') this._unsubscribers.push(unsubState);
      }

      // 2. QueueObserver Subscription
      if (this.queueObserver && typeof this.queueObserver.subscribe === 'function') {
        const unsubObserver = this.queueObserver.subscribe((queueState) => {
          this.onQueueUpdated(queueState);
        }, { immediate: false });
        if (typeof unsubObserver === 'function') this._unsubscribers.push(unsubObserver);
      }

      // 3. YouTube SPA Navigation Listeners
      const navTarget = this.win || (typeof window !== 'undefined' ? window : null) || this.doc;
      if (navTarget && typeof navTarget.addEventListener === 'function') {
        navTarget.addEventListener(this.constants.EVENTS?.YT_NAVIGATE_FINISH || 'yt-navigate-finish', this._boundOnNavigate);
        navTarget.addEventListener(this.constants.EVENTS?.YT_PAGE_DATA_UPDATED || 'yt-page-data-updated', this._boundOnPageData);
      }
    }

    // =========================================================================
    // State Access Helpers
    // =========================================================================

    async _getActiveQueueCount() {
      if (this.queueObserver && typeof this.queueObserver.getCount === 'function') {
        return this.queueObserver.getCount();
      }
      if (this.storageSync && typeof this.storageSync.getActiveQueue === 'function') {
        const q = await this.storageSync.getActiveQueue();
        return q?.videoIds?.length || q?.count || 0;
      }
      return 0;
    }

    async _getSavedSession() {
      if (this.storageSync && typeof this.storageSync.getSavedSession === 'function') {
        return await this.storageSync.getSavedSession();
      }
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        return new Promise((resolve) => {
          chrome.storage.local.get(this.constants.STORAGE_KEYS?.SAVED_SESSION || 'yqp_saved_session', (res) => {
            resolve(res?.[this.constants.STORAGE_KEYS?.SAVED_SESSION || 'yqp_saved_session'] || null);
          });
        });
      }
      return null;
    }

    async _getPreferences() {
      if (this.storageSync && typeof this.storageSync.getPreferences === 'function') {
        return await this.storageSync.getPreferences();
      }
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        return new Promise((resolve) => {
          chrome.storage.local.get(this.constants.STORAGE_KEYS?.PREFERENCES || 'yqp_preferences', (res) => {
            resolve(res?.[this.constants.STORAGE_KEYS?.PREFERENCES || 'yqp_preferences'] || null);
          });
        });
      }
      return null;
    }

    async _getSessionState() {
      if (this.storageSync && typeof this.storageSync.getSessionState === 'function') {
        return await this.storageSync.getSessionState();
      }
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        return new Promise((resolve) => {
          chrome.storage.local.get(this.constants.STORAGE_KEYS?.SESSION_STATE || 'yqp_session_state', (res) => {
            resolve(res?.[this.constants.STORAGE_KEYS?.SESSION_STATE || 'yqp_session_state'] || null);
          });
        });
      }
      return null;
    }

    // =========================================================================
    // Teardown & Lifecycle
    // =========================================================================

    destroy() {
      this._isDestroyed = true;
      this.hideBanner();

      for (const unsub of this._unsubscribers) {
        try { unsub(); } catch (_) {}
      }
      this._unsubscribers = [];

      const navTarget = this.win || (typeof window !== 'undefined' ? window : null) || this.doc;
      if (navTarget && typeof navTarget.removeEventListener === 'function') {
        navTarget.removeEventListener(this.constants.EVENTS?.YT_NAVIGATE_FINISH || 'yt-navigate-finish', this._boundOnNavigate);
        navTarget.removeEventListener(this.constants.EVENTS?.YT_PAGE_DATA_UPDATED || 'yt-page-data-updated', this._boundOnPageData);
      }

      this._bannerEl = null;
      this.storageSync = null;
      this.queueObserver = null;
      this.navigateFn = null;
    }
  }

  return RestoreController;
});
