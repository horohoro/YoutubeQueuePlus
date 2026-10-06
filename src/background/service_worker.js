/**
 * YoutubeQueuePlus - Background Service Worker (Manifest V3)
 * Responsibilities:
 * 1. Initialize default preferences and storage schemas on install.
 * 2. Monitor chrome.storage.local changes for active queue count.
 * 3. Update extension action badge text dynamically (#CC0000).
 * 4. Sync badge on browser startup.
 */

// Fallback constants to support both browser service worker and test environments
const STORAGE_KEYS = {
  ACTIVE_QUEUE: 'yqp_active_queue',
  SAVED_SESSION: 'yqp_saved_session',
  PREFERENCES: 'yqp_preferences',
  SESSION_STATE: 'yqp_session_state'
};

const DEFAULT_PREFERENCES = {
  feedTreatmentMode: 'badge_and_dim', // 'badge_and_dim' | 'hide' | 'badge_only'
  duplicateGuardEnabled: true,
  showRestoreBanner: true,
  autoSaveSession: true
};

const DEFAULT_QUEUE_STATE = {
  videoIds: [],
  currentIndex: 0,
  currentVideoId: null,
  count: 0,
  lastUpdated: 0
};

const BADGE_COLOR = '#CC0000';

/**
 * Updates action badge text based on queue state.
 * @param {Object|null} queueState
 */
async function updateBadge(queueState) {
  try {
    if (typeof chrome === 'undefined' || !chrome.action) {
      return;
    }

    let count = 0;
    if (queueState) {
      if (Array.isArray(queueState.videoIds)) {
        count = queueState.videoIds.length;
      } else if (typeof queueState.count === 'number') {
        count = queueState.count;
      }
    }

    const text = count > 0 ? (count > 99 ? '99+' : String(count)) : '';

    if (typeof chrome.action.setBadgeText === 'function') {
      await chrome.action.setBadgeText({ text });
    }

    if (count > 0 && typeof chrome.action.setBadgeBackgroundColor === 'function') {
      await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    }
  } catch (err) {
    console.error('[YoutubeQueuePlus SW] Failed to update badge:', err);
  }
}

/**
 * Initializes default storage values on extension install or update.
 */
async function initializeDefaults() {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      return;
    }

    const existing = await chrome.storage.local.get([
      STORAGE_KEYS.PREFERENCES,
      STORAGE_KEYS.ACTIVE_QUEUE
    ]);

    const updates = {};
    if (!existing || !existing[STORAGE_KEYS.PREFERENCES]) {
      updates[STORAGE_KEYS.PREFERENCES] = DEFAULT_PREFERENCES;
    }
    if (!existing || !existing[STORAGE_KEYS.ACTIVE_QUEUE]) {
      updates[STORAGE_KEYS.ACTIVE_QUEUE] = DEFAULT_QUEUE_STATE;
    }

    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
      console.log('[YoutubeQueuePlus SW] Initialized defaults:', Object.keys(updates));
    }

    const activeQueue = (existing && existing[STORAGE_KEYS.ACTIVE_QUEUE]) || DEFAULT_QUEUE_STATE;
    await updateBadge(activeQueue);
  } catch (err) {
    console.error('[YoutubeQueuePlus SW] Error initializing defaults:', err);
  }
}

// Register Chrome Extension Lifecycle Listeners
if (typeof chrome !== 'undefined') {
  // 1. Extension Installed / Updated
  if (chrome.runtime && chrome.runtime.onInstalled) {
    chrome.runtime.onInstalled.addListener(async (details) => {
      console.log('[YoutubeQueuePlus SW] onInstalled event:', details ? details.reason : 'unknown');
      await initializeDefaults();
    });
  }

  // 2. Storage Changed (Queue sync -> Badge update)
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(async (changes, areaName) => {
      if (areaName !== 'local') return;

      if (changes && changes[STORAGE_KEYS.ACTIVE_QUEUE]) {
        const newQueue = changes[STORAGE_KEYS.ACTIVE_QUEUE].newValue;
        await updateBadge(newQueue);
      }
    });
  }

  // 3. Browser Startup (Sync badge state)
  if (chrome.runtime && chrome.runtime.onStartup) {
    chrome.runtime.onStartup.addListener(async () => {
      try {
        if (chrome.storage && chrome.storage.local) {
          const data = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_QUEUE);
          await updateBadge(data[STORAGE_KEYS.ACTIVE_QUEUE]);
        }
      } catch (err) {
        console.error('[YoutubeQueuePlus SW] Error updating badge on startup:', err);
      }
    });
  }
}

// CommonJS export for Node.js test harness
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STORAGE_KEYS,
    DEFAULT_PREFERENCES,
    DEFAULT_QUEUE_STATE,
    BADGE_COLOR,
    updateBadge,
    initializeDefaults
  };
}
