/**
 * YoutubeQueuePlus - Storage Keys & Schemas
 * Canonical storage keys, default models, and validation/sanitization helpers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.__YQP__ = root.__YQP__ || {};
    root.__YQP__.StorageKeys = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEYS = Object.freeze({
    ACTIVE_QUEUE: 'yqp_active_queue',
    SAVED_SESSION: 'yqp_saved_session',
    PREFERENCES: 'yqp_preferences',
    SESSION_STATE: 'yqp_session_state'
  });

  const DEFAULT_PREFERENCES = Object.freeze({
    feedTreatmentMode: 'badge_and_dim', // 'badge_and_dim' | 'hide' | 'badge_only'
    duplicateGuardEnabled: true,
    showRestoreBanner: true,
    autoSaveSession: true
  });

  const INITIAL_QUEUE_STATE = Object.freeze({
    videoIds: [],
    currentIndex: 0,
    currentVideoId: null,
    count: 0,
    lastUpdated: 0,
    items: []
  });

  const DEFAULT_QUEUE_STATE = INITIAL_QUEUE_STATE;

  const INITIAL_SAVED_SESSION = Object.freeze({
    videoIds: [],
    currentIndex: 0,
    count: 0,
    savedAt: 0,
    items: []
  });

  const DEFAULT_SAVED_SESSION = INITIAL_SAVED_SESSION;

  const INITIAL_SESSION_STATE = Object.freeze({
    bannerDismissedTimestamp: 0,
    bannerDismissedSessionSavedAt: 0,
    lastRestoredTimestamp: 0
  });

  const DEFAULT_SESSION_STATE = INITIAL_SESSION_STATE;

  const VALID_FEED_MODES = new Set(['badge_and_dim', 'hide', 'badge_only']);

  /**
   * Sanitizes and validates user preferences, applying defaults for missing/invalid properties.
   * @param {Object} prefs
   * @returns {Object} Cleaned preferences
   */
  function sanitizePreferences(prefs) {
    if (!prefs || typeof prefs !== 'object') {
      return { ...DEFAULT_PREFERENCES };
    }

    const feedTreatmentMode = VALID_FEED_MODES.has(prefs.feedTreatmentMode)
      ? prefs.feedTreatmentMode
      : DEFAULT_PREFERENCES.feedTreatmentMode;

    const duplicateGuardEnabled = typeof prefs.duplicateGuardEnabled === 'boolean'
      ? prefs.duplicateGuardEnabled
      : DEFAULT_PREFERENCES.duplicateGuardEnabled;

    const showRestoreBanner = typeof prefs.showRestoreBanner === 'boolean'
      ? prefs.showRestoreBanner
      : DEFAULT_PREFERENCES.showRestoreBanner;

    const autoSaveSession = typeof prefs.autoSaveSession === 'boolean'
      ? prefs.autoSaveSession
      : DEFAULT_PREFERENCES.autoSaveSession;

    return {
      feedTreatmentMode,
      duplicateGuardEnabled,
      showRestoreBanner,
      autoSaveSession
    };
  }

  /**
   * Sanitizes active queue state.
   * @param {Object} state
   * @returns {Object} Validated queue snapshot
   */
  function sanitizeQueueState(state) {
    if (!state || typeof state !== 'object') {
      return { ...INITIAL_QUEUE_STATE, lastUpdated: Date.now() };
    }

    const rawVideoIds = Array.isArray(state.videoIds) ? state.videoIds : [];
    const videoIds = rawVideoIds
      .filter(id => typeof id === 'string' && id.length === 11)
      .slice(0, 500);

    const count = videoIds.length;
    const rawIndex = parseInt(state.currentIndex, 10);
    const currentIndex = Number.isNaN(rawIndex) || rawIndex < 0 ? 0 : Math.min(rawIndex, Math.max(0, count - 1));
    const currentVideoId = typeof state.currentVideoId === 'string' && state.currentVideoId.length === 11
      ? state.currentVideoId
      : (videoIds[currentIndex] || null);

    const rawItems = Array.isArray(state.items) ? state.items : [];
    const items = rawItems.slice(0, 500).map((it, idx) => ({
      id: typeof it?.id === 'string' ? it.id : (videoIds[idx] || ''),
      title: typeof it?.title === 'string' ? it.title : '',
      channelTitle: typeof it?.channelTitle === 'string' ? it.channelTitle : '',
      duration: typeof it?.duration === 'string' ? it.duration : '',
      thumbnailUrl: typeof it?.thumbnailUrl === 'string' ? it.thumbnailUrl : ''
    }));

    return {
      videoIds,
      currentIndex,
      currentVideoId,
      count,
      lastUpdated: typeof state.lastUpdated === 'number' && state.lastUpdated > 0 ? state.lastUpdated : Date.now(),
      items
    };
  }

  /**
   * Sanitizes durable saved session.
   * @param {Object} session
   * @returns {Object} Validated saved session
   */
  function sanitizeSavedSession(session) {
    if (!session || typeof session !== 'object') {
      return { ...INITIAL_SAVED_SESSION };
    }

    const rawVideoIds = Array.isArray(session.videoIds) ? session.videoIds : [];
    const videoIds = rawVideoIds
      .filter(id => typeof id === 'string' && id.length === 11)
      .slice(0, 500);

    const count = videoIds.length;
    const rawIndex = parseInt(session.currentIndex, 10);
    const currentIndex = Number.isNaN(rawIndex) || rawIndex < 0 ? 0 : Math.min(rawIndex, Math.max(0, count - 1));

    const rawItems = Array.isArray(session.items) ? session.items : [];
    const items = rawItems.slice(0, 500).map((it, idx) => ({
      id: typeof it?.id === 'string' ? it.id : (videoIds[idx] || ''),
      title: typeof it?.title === 'string' ? it.title : '',
      channelTitle: typeof it?.channelTitle === 'string' ? it.channelTitle : '',
      duration: typeof it?.duration === 'string' ? it.duration : '',
      thumbnailUrl: typeof it?.thumbnailUrl === 'string' ? it.thumbnailUrl : ''
    }));

    return {
      videoIds,
      currentIndex,
      count,
      savedAt: typeof session.savedAt === 'number' && session.savedAt > 0 ? session.savedAt : Date.now(),
      items
    };
  }

  /**
   * Sanitizes session UI state.
   * @param {Object} state
   * @returns {Object}
   */
  function sanitizeSessionState(state) {
    if (!state || typeof state !== 'object') {
      return { ...INITIAL_SESSION_STATE };
    }

    return {
      bannerDismissedTimestamp: typeof state.bannerDismissedTimestamp === 'number' ? state.bannerDismissedTimestamp : 0,
      bannerDismissedSessionSavedAt: typeof state.bannerDismissedSessionSavedAt === 'number' ? state.bannerDismissedSessionSavedAt : 0,
      lastRestoredTimestamp: typeof state.lastRestoredTimestamp === 'number' ? state.lastRestoredTimestamp : 0
    };
  }

  return Object.freeze({
    STORAGE_KEYS,
    DEFAULT_PREFERENCES,
    INITIAL_QUEUE_STATE,
    DEFAULT_QUEUE_STATE,
    INITIAL_SAVED_SESSION,
    DEFAULT_SAVED_SESSION,
    INITIAL_SESSION_STATE,
    DEFAULT_SESSION_STATE,
    sanitizePreferences,
    sanitizeQueueState,
    sanitizeSavedSession,
    sanitizeSessionState
  });
});
