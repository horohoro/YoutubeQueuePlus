/**
 * YoutubeQueuePlus - Options & Status Popup Controller
 * Universal Module Definition (UMD) wrapping with live reactivity and testability.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    let UrlParser = null;
    try {
      UrlParser = require('../src/utils/url_parser');
    } catch (_) {}
    module.exports = factory(UrlParser);
  } else {
    root.__YQP_POPUP__ = factory(root.__YQP__?.UrlParser);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (UrlParserModule) {
  'use strict';

  const STORAGE_KEYS = {
    ACTIVE_QUEUE: 'yqp_active_queue',
    SAVED_SESSION: 'yqp_saved_session',
    PREFERENCES: 'yqp_preferences',
    SESSION_STATE: 'yqp_session_state'
  };

  /**
   * Constructs YouTube's native multi-video player restore URL.
   * @param {string[]} videoIds
   * @param {number} [currentIndex=0]
   * @returns {string|null}
   */
  function buildRestoreUrl(videoIds, currentIndex = 0) {
    if (UrlParserModule && typeof UrlParserModule.buildRestoreUrl === 'function') {
      return UrlParserModule.buildRestoreUrl(videoIds, currentIndex);
    }
    if (!Array.isArray(videoIds) || videoIds.length === 0) return null;
    const validIds = videoIds.filter(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id)).slice(0, 50);
    if (validIds.length === 0) return null;
    let idx = typeof currentIndex === 'number' && !isNaN(currentIndex) ? Math.floor(currentIndex) : 0;
    if (idx < 0) idx = 0;
    if (idx >= validIds.length) idx = validIds.length - 1;
    return `https://www.youtube.com/watch_videos?video_ids=${encodeURIComponent(validIds.join(','))}&index=${idx}`;
  }

  /**
   * Formats a millisecond timestamp to a concise human-readable date/time string.
   * @param {number} timestamp
   * @returns {string}
   */
  function formatTimestamp(timestamp) {
    if (!timestamp || typeof timestamp !== 'number' || timestamp <= 0) {
      return 'None';
    }
    const diffMs = Date.now() - timestamp;
    if (diffMs < 0) {
      return 'Just now';
    }
    if (diffMs < 60000) {
      return 'Just now';
    }
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) {
      return `${diffMins}m ago`;
    }
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) {
      return 'None';
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  class PopupController {
    /**
     * @param {Object} [options={}]
     * @param {Document} [options.document] - Document context
     * @param {Window} [options.window] - Window context
     * @param {Object} [options.chrome] - Chrome API namespace
     */
    constructor(options = {}) {
      this.doc = options.document || (typeof document !== 'undefined' ? document : null);
      this.win = options.window || (typeof window !== 'undefined' ? window : null);
      this.chromeObj = options.chrome || (typeof chrome !== 'undefined' ? chrome : null);

      this.currentSavedSession = null;
      this._boundStorageChanged = this.handleStorageChanged.bind(this);
      this._isInitialized = false;
    }

    init() {
      if (!this.doc || this._isInitialized) return;
      this._isInitialized = true;

      this.bindDOMEvents();
      this.bindStorageEvents();
      this.loadInitialState();
    }

    bindDOMEvents() {
      if (!this.doc) return;

      // 1. Radio group change listeners
      const radios = this.doc.querySelectorAll('input[name="feedTreatmentMode"]');
      if (radios && typeof radios.forEach === 'function') {
        radios.forEach(radio => {
          radio.addEventListener('change', (e) => {
            if (e.target && e.target.checked) {
              this.handleModeChange(e.target.value);
            }
          });
        });
      }

      // 2. Restore button click
      const restoreBtn = this.doc.getElementById('restoreBtn');
      if (restoreBtn) {
        restoreBtn.addEventListener('click', () => {
          this.handleRestoreClick();
        });
      }
    }

    bindStorageEvents() {
      if (this.chromeObj?.storage?.onChanged?.addListener) {
        this.chromeObj.storage.onChanged.addListener(this._boundStorageChanged);
      }
    }

    loadInitialState() {
      if (!this.chromeObj?.storage?.local?.get) return;
      this.chromeObj.storage.local.get([
        STORAGE_KEYS.ACTIVE_QUEUE,
        STORAGE_KEYS.SAVED_SESSION,
        STORAGE_KEYS.PREFERENCES
      ], (result) => {
        if (!result) return;
        this.updateActiveQueueCard(result[STORAGE_KEYS.ACTIVE_QUEUE]);
        this.updateSavedSessionCard(result[STORAGE_KEYS.SAVED_SESSION]);
        this.updatePreferencesUI(result[STORAGE_KEYS.PREFERENCES]);
      });
    }

    handleStorageChanged(changes, areaName) {
      if (areaName && areaName !== 'local') return;
      if (!changes) return;

      if (changes[STORAGE_KEYS.ACTIVE_QUEUE]) {
        this.updateActiveQueueCard(changes[STORAGE_KEYS.ACTIVE_QUEUE].newValue);
      }
      if (changes[STORAGE_KEYS.SAVED_SESSION]) {
        this.updateSavedSessionCard(changes[STORAGE_KEYS.SAVED_SESSION].newValue);
      }
      if (changes[STORAGE_KEYS.PREFERENCES]) {
        this.updatePreferencesUI(changes[STORAGE_KEYS.PREFERENCES].newValue);
      }
    }

    updateActiveQueueCard(queueState) {
      if (!this.doc) return;
      const countEl = this.doc.getElementById('queueCount');
      const playingEl = this.doc.getElementById('playingIndex');
      const pillEl = this.doc.getElementById('queueLivePill');

      const count = Array.isArray(queueState?.videoIds)
        ? queueState.videoIds.length
        : (typeof queueState?.count === 'number' ? queueState.count : 0);
      const currentIndex = typeof queueState?.currentIndex === 'number' ? queueState.currentIndex : 0;

      if (countEl) {
        countEl.textContent = `${count} video${count === 1 ? '' : 's'}`;
      }

      if (playingEl) {
        if (count > 0) {
          const displayIndex = Math.min(currentIndex + 1, count);
          playingEl.textContent = `Video ${displayIndex} of ${count}`;
        } else {
          playingEl.textContent = '—';
        }
      }

      if (pillEl) {
        if (count > 0) {
          pillEl.textContent = 'LIVE';
          pillEl.className = 'live-pill active';
        } else {
          pillEl.textContent = 'IDLE';
          pillEl.className = 'live-pill idle';
        }
      }
    }

    updateSavedSessionCard(session) {
      this.currentSavedSession = session || null;
      if (!this.doc) return;

      const savedCountEl = this.doc.getElementById('savedCount');
      const savedTimeEl = this.doc.getElementById('savedTime');
      const pillEl = this.doc.getElementById('sessionStatusPill');
      const restoreBtn = this.doc.getElementById('restoreBtn');

      const count = Array.isArray(session?.videoIds)
        ? session.videoIds.length
        : (typeof session?.count === 'number' ? session.count : 0);

      if (savedCountEl) {
        savedCountEl.textContent = count > 0 ? `${count} video${count === 1 ? '' : 's'}` : 'None';
      }

      if (savedTimeEl) {
        savedTimeEl.textContent = count > 0 && session?.savedAt ? formatTimestamp(session.savedAt) : '—';
      }

      if (pillEl) {
        if (count > 0) {
          pillEl.textContent = 'READY';
          pillEl.className = 'status-pill ready';
        } else {
          pillEl.textContent = 'NONE';
          pillEl.className = 'status-pill none';
        }
      }

      if (restoreBtn) {
        restoreBtn.disabled = count === 0;
      }
    }

    updatePreferencesUI(preferences) {
      if (!this.doc) return;
      const mode = preferences?.feedTreatmentMode || 'badge_and_dim';
      const targetRadio = this.doc.querySelector(`input[name="feedTreatmentMode"][value="${mode}"]`);
      if (targetRadio) {
        targetRadio.checked = true;
      }
    }

    handleModeChange(selectedMode) {
      if (!this.chromeObj?.storage?.local) return;
      this.chromeObj.storage.local.get([STORAGE_KEYS.PREFERENCES], (result) => {
        const rawPrefs = result?.[STORAGE_KEYS.PREFERENCES];
        const currentPrefs = (rawPrefs && typeof rawPrefs === 'object' && !Array.isArray(rawPrefs))
          ? { ...rawPrefs }
          : {};
        currentPrefs.feedTreatmentMode = selectedMode;
        this.chromeObj.storage.local.set({ [STORAGE_KEYS.PREFERENCES]: currentPrefs });
      });
    }

    handleRestoreClick() {
      const session = this.currentSavedSession;
      if (!session || !Array.isArray(session.videoIds) || session.videoIds.length === 0) {
        return;
      }

      const url = buildRestoreUrl(session.videoIds, session.currentIndex || 0);
      if (!url) return;

      if (this.chromeObj?.tabs?.query) {
        this.chromeObj.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const activeTab = tabs && tabs[0];
          if (activeTab && activeTab.url && activeTab.url.includes('youtube.com') && this.chromeObj.tabs.update) {
            this.chromeObj.tabs.update(activeTab.id, { url }, () => {
              if (this.win?.close) this.win.close();
            });
          } else if (this.chromeObj.tabs.create) {
            this.chromeObj.tabs.create({ url }, () => {
              if (this.win?.close) this.win.close();
            });
          } else if (this.win?.open) {
            this.win.open(url, '_blank');
          }
        });
      } else if (this.win?.open) {
        this.win.open(url, '_blank');
      }
    }

    destroy() {
      if (this.chromeObj?.storage?.onChanged?.removeListener) {
        this.chromeObj.storage.onChanged.removeListener(this._boundStorageChanged);
      }
      this._isInitialized = false;
      this.currentSavedSession = null;
    }
  }

  // Automatic bootstrap in browser extension environment
  if (typeof document !== 'undefined') {
    const isTestEnv = typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'test';
    if (!isTestEnv) {
      const controller = new PopupController();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => controller.init());
      } else {
        controller.init();
      }
    }
  }

  return {
    PopupController,
    buildRestoreUrl,
    formatTimestamp,
    STORAGE_KEYS
  };
});
