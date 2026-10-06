/**
 * YoutubeQueuePlus - Storage Synchronization Engine
 * Universal Module Definition (UMD) wrapping with __YQP__.StorageSync.
 * Features:
 * - 300ms debounced write queue with immediate flush capability
 * - In-memory diff signature check skipping redundant writes
 * - Safe Promise wrappers for chrome.storage.local with lastError inspection
 * - Dual-write handling: persists durable yqp_saved_session when queue >= 1 items, preserves it on queue clear
 * - Cross-tab chrome.storage.onChanged synchronization with Pub/Sub listeners
 * - Quota & storage exception error handling
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const StorageKeys = typeof require === 'function' ? require('../shared/storage_keys') : null;
    const Constants = typeof require === 'function' ? require('../shared/constants') : null;
    const StorageSyncClass = factory(StorageKeys, Constants);
    module.exports = StorageSyncClass;
    module.exports.StorageSync = StorageSyncClass;
    module.exports.default = StorageSyncClass;
  } else {
    root.__YQP__ = root.__YQP__ || {};
    root.__YQP__.StorageSync = factory(root.__YQP__.StorageKeys, root.__YQP__.Constants);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (StorageKeysModule, ConstantsModule) {
  'use strict';

  // Fallbacks in case modules are loaded out of order
  const StorageKeys = StorageKeysModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.StorageKeys) || {
    STORAGE_KEYS: {
      ACTIVE_QUEUE: 'yqp_active_queue',
      SAVED_SESSION: 'yqp_saved_session',
      PREFERENCES: 'yqp_preferences',
      SESSION_STATE: 'yqp_session_state'
    },
    DEFAULT_PREFERENCES: {
      feedTreatmentMode: 'badge_and_dim',
      duplicateGuardEnabled: true,
      showRestoreBanner: true,
      autoSaveSession: true
    },
    INITIAL_QUEUE_STATE: { videoIds: [], currentIndex: 0, currentVideoId: null, count: 0, lastUpdated: 0, items: [] },
    DEFAULT_QUEUE_STATE: { videoIds: [], currentIndex: 0, currentVideoId: null, count: 0, lastUpdated: 0, items: [] },
    INITIAL_SAVED_SESSION: { videoIds: [], currentIndex: 0, count: 0, savedAt: 0, items: [] },
    DEFAULT_SAVED_SESSION: { videoIds: [], currentIndex: 0, count: 0, savedAt: 0, items: [] },
    INITIAL_SESSION_STATE: { bannerDismissedTimestamp: 0, bannerDismissedSessionSavedAt: 0, lastRestoredTimestamp: 0 },
    DEFAULT_SESSION_STATE: { bannerDismissedTimestamp: 0, bannerDismissedSessionSavedAt: 0, lastRestoredTimestamp: 0 },
    sanitizePreferences: p => (p && typeof p === 'object' ? { ...p } : { feedTreatmentMode: 'badge_and_dim', duplicateGuardEnabled: true, showRestoreBanner: true, autoSaveSession: true }),
    sanitizeQueueState: s => (s && typeof s === 'object' ? { videoIds: Array.isArray(s.videoIds) ? s.videoIds : [], currentIndex: s.currentIndex || 0, count: (s.videoIds && s.videoIds.length) || 0, lastUpdated: Date.now(), items: [] } : { videoIds: [], currentIndex: 0, count: 0, lastUpdated: Date.now(), items: [] }),
    sanitizeSavedSession: s => (s && typeof s === 'object' ? { videoIds: Array.isArray(s.videoIds) ? s.videoIds : [], currentIndex: s.currentIndex || 0, count: (s.videoIds && s.videoIds.length) || 0, savedAt: Date.now(), items: [] } : { videoIds: [], currentIndex: 0, count: 0, savedAt: Date.now(), items: [] }),
    sanitizeSessionState: s => (s && typeof s === 'object' ? { ...s } : { bannerDismissedTimestamp: 0, bannerDismissedSessionSavedAt: 0, lastRestoredTimestamp: 0 })
  };

  const KEYS = StorageKeys.STORAGE_KEYS;
  const DEBOUNCE_DELAY_MS = ConstantsModule?.TIMING?.STORAGE_DEBOUNCE_MS || 300;

  class StorageSync {
    /**
     * @param {Object} [options]
     * @param {number} [options.debounceDelay=300] - Debounce delay in ms for active queue writes.
     * @param {Object} [options.storageArea] - Storage backend injection for testing.
     * @param {Object} [options.storageOnChanged] - onChanged event emitter injection.
     */
    constructor(options = {}) {
      this.debounceDelay = typeof options.debounceDelay === 'number' ? options.debounceDelay : DEBOUNCE_DELAY_MS;
      this.storageArea = options.storageArea || null;
      this.storageOnChanged = options.storageOnChanged || null;

      this._activeQueueTimer = null;
      this._pendingActiveQueueState = null;
      this._pendingDebounceResolvers = [];
      this._lastActiveQueueSignature = null;
      this._listeners = new Map(); // event -> Set<callback>
      this._errorListeners = new Set();
      this._cachedPreferences = null;

      this._boundOnChanged = this._handleStorageOnChanged.bind(this);
      const emitter = this._getStorageOnChanged();
      if (emitter && typeof emitter.addListener === 'function') {
        emitter.addListener(this._boundOnChanged);
      }
    }

    _getStorageArea() {
      if (this.storageArea) return this.storageArea;
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return chrome.storage.local;
      }
      return null;
    }

    _getStorageOnChanged() {
      if (this.storageOnChanged) return this.storageOnChanged;
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        return chrome.storage.onChanged;
      }
      return null;
    }

    // =========================================================================
    // Safe Chrome Storage Primitives
    // =========================================================================

    /**
     * Safe wrapper for chrome.storage.local.get supporting Promises and callbacks.
     * @param {string|string[]|Object|null} keys
     * @returns {Promise<Object>}
     */
    _storageGet(keys) {
      return new Promise((resolve, reject) => {
        const area = this._getStorageArea();
        if (!area) {
          return resolve({});
        }

        let settled = false;
        const handleSuccess = (res) => {
          if (!settled) {
            settled = true;
            resolve(res || {});
          }
        };
        const handleError = (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        };

        try {
          const res = area.get(keys, (items) => {
            if (typeof chrome !== 'undefined' && chrome.runtime?.lastError) {
              handleError(new Error(chrome.runtime.lastError.message));
            } else {
              handleSuccess(items);
            }
          });
          if (res && typeof res.then === 'function') {
            res.then(handleSuccess).catch(handleError);
          }
        } catch (err) {
          handleError(err);
        }
      });
    }

    /**
     * Safe wrapper for chrome.storage.local.set supporting Promises and callbacks.
     * @param {Object} items
     * @returns {Promise<void>}
     */
    _storageSet(items) {
      return new Promise((resolve, reject) => {
        const area = this._getStorageArea();
        if (!area) {
          return resolve();
        }

        let settled = false;
        const handleSuccess = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        const handleError = (err) => {
          if (!settled) {
            settled = true;
            this._notifyError(err, 'set');
            reject(err);
          }
        };

        try {
          const res = area.set(items, () => {
            if (typeof chrome !== 'undefined' && chrome.runtime?.lastError) {
              handleError(new Error(chrome.runtime.lastError.message));
            } else {
              handleSuccess();
            }
          });
          if (res && typeof res.then === 'function') {
            res.then(handleSuccess).catch(handleError);
          }
        } catch (err) {
          handleError(err);
        }
      });
    }

    /**
     * Safe wrapper for chrome.storage.local.remove supporting Promises and callbacks.
     * @param {string|string[]} keys
     * @returns {Promise<void>}
     */
    _storageRemove(keys) {
      return new Promise((resolve, reject) => {
        const area = this._getStorageArea();
        if (!area) {
          return resolve();
        }

        let settled = false;
        const handleSuccess = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        const handleError = (err) => {
          if (!settled) {
            settled = true;
            this._notifyError(err, 'remove');
            reject(err);
          }
        };

        try {
          const res = area.remove(keys, () => {
            if (typeof chrome !== 'undefined' && chrome.runtime?.lastError) {
              handleError(new Error(chrome.runtime.lastError.message));
            } else {
              handleSuccess();
            }
          });
          if (res && typeof res.then === 'function') {
            res.then(handleSuccess).catch(handleError);
          }
        } catch (err) {
          handleError(err);
        }
      });
    }

    _notifyError(error, operation) {
      console.warn(`[YQP StorageSync] Storage ${operation} error:`, error);
      for (const listener of this._errorListeners) {
        try {
          listener(error, operation);
        } catch (e) {
          console.error('[YQP StorageSync] Error listener failed:', e);
        }
      }
    }

    // =========================================================================
    // Diff Signature Engine
    // =========================================================================

    /**
     * Computes deterministic signature for active queue state.
     * @param {Object} state
     * @returns {string}
     */
    _computeQueueSignature(state) {
      if (!state || !Array.isArray(state.videoIds)) {
        return 'empty';
      }
      const idsPart = state.videoIds.join(',');
      const indexPart = state.currentIndex !== undefined ? state.currentIndex : 0;
      const currentIdPart = state.currentVideoId || '';
      return `${idsPart}|${indexPart}|${currentIdPart}`;
    }

    // =========================================================================
    // Active Queue Management (Debounced & Diffed)
    // =========================================================================

    /**
     * Reads active queue state from storage.
     * @returns {Promise<Object>}
     */
    async getActiveQueue() {
      try {
        const result = await this._storageGet(KEYS.ACTIVE_QUEUE);
        const raw = result[KEYS.ACTIVE_QUEUE];
        const state = StorageKeys.sanitizeQueueState(raw);
        this._lastActiveQueueSignature = this._computeQueueSignature(state);
        return state;
      } catch (err) {
        console.warn('[YQP StorageSync] Failed to read active queue:', err);
        return { ...StorageKeys.INITIAL_QUEUE_STATE };
      }
    }

    /**
     * Schedules a debounced write for active queue state.
     * Skips writing if the signature has not changed.
     * Atomically syncs yqp_saved_session if the queue has >= 1 video.
     * @param {Object} queueState
     * @param {boolean} [immediate=false] - If true, bypasses the 300ms debounce buffer.
     * @returns {Promise<boolean>} Resolves to true if write occurred or is scheduled, false if skipped by diff.
     */
    saveActiveQueue(queueState, immediate = false) {
      const sanitized = StorageKeys.sanitizeQueueState(queueState);
      const newSignature = this._computeQueueSignature(sanitized);

      // In-memory diff check: if unchanged, always skip write
      if (newSignature === this._lastActiveQueueSignature) {
        return Promise.resolve(false);
      }

      this._pendingActiveQueueState = sanitized;

      if (immediate) {
        return this.flush().then(() => true);
      }

      if (this._activeQueueTimer) {
        clearTimeout(this._activeQueueTimer);
        this._activeQueueTimer = null;
      }

      return new Promise((resolve) => {
        this._pendingDebounceResolvers.push(resolve);
        this._activeQueueTimer = setTimeout(async () => {
          this._activeQueueTimer = null;
          await this._executePendingActiveQueueSave();
        }, this.debounceDelay);
      });
    }

    /**
     * Flushes any pending debounced active queue write immediately.
     * @returns {Promise<void>}
     */
    async flush() {
      if (this._activeQueueTimer) {
        clearTimeout(this._activeQueueTimer);
        this._activeQueueTimer = null;
      }
      if (this._pendingActiveQueueState) {
        await this._executePendingActiveQueueSave();
      } else {
        const resolvers = this._pendingDebounceResolvers;
        this._pendingDebounceResolvers = [];
        resolvers.forEach(r => r(true));
      }
    }

    /**
     * Internal commit for pending active queue snapshot.
     */
    async _executePendingActiveQueueSave() {
      const resolvers = this._pendingDebounceResolvers;
      this._pendingDebounceResolvers = [];

      const stateToSave = this._pendingActiveQueueState;
      if (!stateToSave) {
        resolvers.forEach(r => r(true));
        return;
      }
      this._pendingActiveQueueState = null;

      const newSignature = this._computeQueueSignature(stateToSave);
      if (newSignature === this._lastActiveQueueSignature) {
        resolvers.forEach(r => r(true));
        return; // Diff check double-guard
      }

      stateToSave.lastUpdated = Date.now();

      const payload = {
        [KEYS.ACTIVE_QUEUE]: stateToSave
      };

      // Dual-write durable session persistence:
      // If queue has >= 1 video, persist to yqp_saved_session.
      // If queue is empty, do NOT overwrite yqp_saved_session (preserves restart restore).
      if (stateToSave.videoIds.length > 0) {
        payload[KEYS.SAVED_SESSION] = {
          videoIds: [...stateToSave.videoIds],
          currentIndex: stateToSave.currentIndex,
          count: stateToSave.count,
          savedAt: stateToSave.lastUpdated,
          items: stateToSave.items ? [...stateToSave.items] : []
        };
      }

      try {
        await this._storageSet(payload);
        this._lastActiveQueueSignature = newSignature;
      } catch (err) {
        console.warn('[YQP StorageSync] Failed to persist active queue snapshot:', err);
      } finally {
        resolvers.forEach(r => r(true));
      }
    }

    // =========================================================================
    // Saved Session Management
    // =========================================================================

    /**
     * Reads durable saved session from storage.
     * @returns {Promise<Object>}
     */
    async getSavedSession() {
      try {
        const result = await this._storageGet(KEYS.SAVED_SESSION);
        return StorageKeys.sanitizeSavedSession(result[KEYS.SAVED_SESSION]);
      } catch (err) {
        console.warn('[YQP StorageSync] Failed to read saved session:', err);
        return { ...StorageKeys.INITIAL_SAVED_SESSION };
      }
    }

    /**
     * Explicitly saves or overwrites the durable session.
     * @param {Object} session
     * @returns {Promise<void>}
     */
    async saveSavedSession(session) {
      const sanitized = StorageKeys.sanitizeSavedSession(session);
      sanitized.savedAt = Date.now();
      await this._storageSet({ [KEYS.SAVED_SESSION]: sanitized });
    }

    /**
     * Clears durable saved session.
     * @returns {Promise<void>}
     */
    async clearSavedSession() {
      await this._storageRemove(KEYS.SAVED_SESSION);
    }

    // =========================================================================
    // User Preferences Management
    // =========================================================================

    /**
     * Initializes default preferences in storage if not already present.
     * @returns {Promise<Object>}
     */
    async initPreferences() {
      const result = await this._storageGet(KEYS.PREFERENCES);
      if (!result || !result[KEYS.PREFERENCES]) {
        const defaults = { ...StorageKeys.DEFAULT_PREFERENCES };
        await this._storageSet({ [KEYS.PREFERENCES]: defaults });
        this._cachedPreferences = defaults;
        return { ...defaults };
      }
      const prefs = StorageKeys.sanitizePreferences(result[KEYS.PREFERENCES]);
      this._cachedPreferences = prefs;
      return { ...prefs };
    }

    /**
     * Reads user preferences, applying defaults.
     * @returns {Promise<Object>}
     */
    async getPreferences() {
      if (this._cachedPreferences) {
        return { ...this._cachedPreferences };
      }
      try {
        const result = await this._storageGet(KEYS.PREFERENCES);
        const prefs = StorageKeys.sanitizePreferences(result[KEYS.PREFERENCES]);
        this._cachedPreferences = prefs;
        return { ...prefs };
      } catch (err) {
        console.warn('[YQP StorageSync] Failed to read preferences:', err);
        return { ...StorageKeys.DEFAULT_PREFERENCES };
      }
    }

    /**
     * Updates and saves user preferences.
     * @param {Object} partialPrefs
     * @returns {Promise<Object>} Saved preferences
     */
    async setPreferences(partialPrefs) {
      const current = await this.getPreferences();
      const merged = StorageKeys.sanitizePreferences({ ...current, ...partialPrefs });
      await this._storageSet({ [KEYS.PREFERENCES]: merged });
      this._cachedPreferences = merged;
      return { ...merged };
    }

    // =========================================================================
    // UI Session State Management
    // =========================================================================

    /**
     * Reads transient UI session state.
     * @returns {Promise<Object>}
     */
    async getSessionState() {
      try {
        const result = await this._storageGet(KEYS.SESSION_STATE);
        return StorageKeys.sanitizeSessionState(result[KEYS.SESSION_STATE]);
      } catch (err) {
        console.warn('[YQP StorageSync] Failed to read session state:', err);
        return { ...StorageKeys.INITIAL_SESSION_STATE };
      }
    }

    /**
     * Updates transient UI session state.
     * @param {Object} partialState
     * @returns {Promise<Object>}
     */
    async setSessionState(partialState) {
      const current = await this.getSessionState();
      const merged = StorageKeys.sanitizeSessionState({ ...current, ...partialState });
      await this._storageSet({ [KEYS.SESSION_STATE]: merged });
      return { ...merged };
    }

    // =========================================================================
    // Cross-Tab Synchronization & Event Dispatch
    // =========================================================================

    /**
     * Internal handler for chrome.storage.onChanged events.
     * @param {Object} changes - Key-value map of { oldValue, newValue }.
     * @param {string} areaName - Storage area name ('local', 'sync', etc.).
     */
    _handleStorageOnChanged(changes, areaName) {
      if (areaName && areaName !== 'local') {
        return;
      }
      if (!changes || typeof changes !== 'object') {
        return;
      }

      // 1. Active Queue Changed
      if (changes[KEYS.ACTIVE_QUEUE]) {
        const { newValue, oldValue } = changes[KEYS.ACTIVE_QUEUE];
        const sanitizedNew = StorageKeys.sanitizeQueueState(newValue);
        this._lastActiveQueueSignature = this._computeQueueSignature(sanitizedNew);
        this._emit('queue', sanitizedNew, oldValue);
      }

      // 2. Preferences Changed
      if (changes[KEYS.PREFERENCES]) {
        const { newValue, oldValue } = changes[KEYS.PREFERENCES];
        const sanitizedNew = StorageKeys.sanitizePreferences(newValue);
        this._cachedPreferences = sanitizedNew;
        this._emit('preferences', sanitizedNew, oldValue);
      }

      // 3. Saved Session Changed
      if (changes[KEYS.SAVED_SESSION]) {
        const { newValue, oldValue } = changes[KEYS.SAVED_SESSION];
        const sanitizedNew = newValue ? StorageKeys.sanitizeSavedSession(newValue) : null;
        this._emit('saved_session', sanitizedNew, oldValue);
      }

      // 4. Session State Changed
      if (changes[KEYS.SESSION_STATE]) {
        const { newValue, oldValue } = changes[KEYS.SESSION_STATE];
        const sanitizedNew = StorageKeys.sanitizeSessionState(newValue);
        this._emit('session_state', sanitizedNew, oldValue);
      }

      // Wildcard dispatch
      this._emit('*', changes);
    }

    /**
     * Subscribes to storage events.
     * Supported events: 'queue', 'preferences', 'saved_session', 'session_state', '*'
     * @param {string} event
     * @param {Function} callback
     * @returns {Function} Unsubscribe function
     */
    subscribe(event, callback) {
      if (typeof callback !== 'function') {
        return () => {};
      }
      if (!this._listeners.has(event)) {
        this._listeners.set(event, new Set());
      }
      this._listeners.get(event).add(callback);

      return () => {
        const set = this._listeners.get(event);
        if (set) {
          set.delete(callback);
          if (set.size === 0) {
            this._listeners.delete(event);
          }
        }
      };
    }

    /**
     * Subscribe to queue changes.
     */
    onQueueChanged(callback) {
      return this.subscribe('queue', callback);
    }

    /**
     * Alias for onQueueChanged.
     */
    subscribeToActiveQueue(callback) {
      return this.onQueueChanged(callback);
    }

    /**
     * Subscribe to preference changes.
     */
    onPreferencesChanged(callback) {
      return this.subscribe('preferences', callback);
    }

    /**
     * Alias for onPreferencesChanged.
     */
    subscribeToPreferences(callback) {
      return this.onPreferencesChanged(callback);
    }

    /**
     * Subscribe to saved session changes.
     */
    onSavedSessionChanged(callback) {
      return this.subscribe('saved_session', callback);
    }

    /**
     * Alias for onSavedSessionChanged.
     */
    subscribeToSavedSession(callback) {
      return this.onSavedSessionChanged(callback);
    }

    /**
     * Registers error listener.
     */
    onError(callback) {
      if (typeof callback === 'function') {
        this._errorListeners.add(callback);
      }
      return () => this._errorListeners.delete(callback);
    }

    _emit(event, ...args) {
      const set = this._listeners.get(event);
      if (!set) return;
      for (const cb of set) {
        try {
          cb(...args);
        } catch (err) {
          console.error(`[YQP StorageSync] Listener error for event "${event}":`, err);
        }
      }
    }

    // =========================================================================
    // Cleanup / Teardown
    // =========================================================================

    /**
     * Tears down active timers and event listeners.
     */
    destroy() {
      if (this._activeQueueTimer) {
        clearTimeout(this._activeQueueTimer);
        this._activeQueueTimer = null;
      }
      if (this._pendingDebounceResolvers) {
        this._pendingDebounceResolvers.forEach(r => r(false));
        this._pendingDebounceResolvers = [];
      }
      this._pendingActiveQueueState = null;

      const emitter = this._getStorageOnChanged();
      if (emitter && typeof emitter.removeListener === 'function') {
        emitter.removeListener(this._boundOnChanged);
      }

      this._listeners.clear();
      this._errorListeners.clear();
      this._cachedPreferences = null;
    }
  }

  return StorageSync;
});
