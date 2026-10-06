/**
 * YoutubeQueuePlus - Tier 2: Boundary & Corner Case Test Suite
 * Zero-dependency native Node.js test suite.
 * Executable via: node test/e2e/tier2_boundaries.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Mock harnesses
const {
  MockEvent,
  MockDocument,
  MockWindow,
  MockMutationObserver,
  createYouTubePageDOM,
  createMockFeedCard,
  createMockPlaylistPanel,
  createMockDropdownMenu,
  createPopupDOM,
  setupGlobalDOM,
  restoreGlobalDOM
} = require('../harness/mock-dom');

const { MockChrome, setupGlobalChrome, restoreGlobalChrome } = require('../harness/mock-chrome');

// Modules under test
const Constants = require('../../src/shared/constants');
const StorageKeys = require('../../src/shared/storage_keys');
const UrlParser = require('../../src/utils/url_parser');
const DomHelpers = require('../../src/utils/dom_helpers');
const StorageSync = require('../../src/modules/storage_sync');
const ToastManager = require('../../src/modules/toast_manager');
const DuplicateGuard = require('../../src/modules/duplicate_guard');
const FeedDecorator = require('../../src/modules/feed_decorator');
const QueueObserver = require('../../src/modules/queue_observer');
const RestoreController = require('../../src/modules/restore_controller');
const { PopupController } = require('../../popup/popup');

describe('Tier 2: Boundary & Corner Case Tests', () => {
  let doc;
  let win;
  let mockChrome;

  beforeEach(() => {
    doc = new MockDocument();
    win = new MockWindow(doc);
    mockChrome = new MockChrome();
    setupGlobalDOM({ document: doc, window: win });
    setupGlobalChrome(mockChrome);
  });

  afterEach(() => {
    restoreGlobalDOM();
    restoreGlobalChrome();
  });

  // ===========================================================================
  // Boundary 1: Empty Queue Transitions (0 Videos)
  // ===========================================================================
  describe('Boundary 1: Empty Queue Transitions', () => {
    test('Transition from populated queue to empty queue clears all feed card decorations and attributes', () => {
      const vidA = 'vidAlpha001';
      const vidB = 'vidBeta0002';
      const cardA = createMockFeedCard(doc, vidA).card;
      const cardB = createMockFeedCard(doc, vidB).card;
      doc.body.appendChild(cardA);
      doc.body.appendChild(cardB);

      const decorator = new FeedDecorator({
        root: doc,
        mode: 'badge_and_dim',
        videoIds: [vidA, vidB],
        debounceMs: 0
      });

      assert.equal(cardA.getAttribute('data-yqp-status'), 'queued');
      assert.equal(cardB.getAttribute('data-yqp-status'), 'queued');
      assert.ok(cardA.querySelector('.yqp-queue-badge'));
      assert.ok(cardB.querySelector('.yqp-queue-badge'));

      // Empty queue transition: user clears queue
      decorator.updateQueue([]);

      assert.equal(cardA.getAttribute('data-yqp-status'), null, 'Status must be removed from Card A');
      assert.equal(cardB.getAttribute('data-yqp-status'), null, 'Status must be removed from Card B');
      assert.equal(cardA.querySelector('.yqp-queue-badge'), null, 'Badge must be removed from Card A');
      assert.equal(cardB.querySelector('.yqp-queue-badge'), null, 'Badge must be removed from Card B');
      assert.equal(cardA.style.opacity, '', 'Opacity must be restored on Card A');
      assert.equal(cardB.style.opacity, '', 'Opacity must be restored on Card B');

      decorator.destroy();
    });

    test('Empty queue preserves saved session in storage while resetting active queue', async () => {
      const storageSync = new StorageSync({
        storageArea: mockChrome.storage.local,
        debounceDelay: 0
      });

      // 1. Populated queue
      await storageSync.saveActiveQueue({
        videoIds: ['prevSaved01'],
        currentIndex: 0,
        count: 1
      }, true);

      const savedBefore = (await mockChrome.storage.local.get(StorageKeys.STORAGE_KEYS.SAVED_SESSION))[StorageKeys.STORAGE_KEYS.SAVED_SESSION];
      assert.ok(savedBefore, 'Saved session must be created');

      // 2. Queue becomes empty
      await storageSync.saveActiveQueue({
        videoIds: [],
        currentIndex: 0,
        count: 0
      }, true);

      const activeAfter = (await mockChrome.storage.local.get(StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE))[StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE];
      const savedAfter = (await mockChrome.storage.local.get(StorageKeys.STORAGE_KEYS.SAVED_SESSION))[StorageKeys.STORAGE_KEYS.SAVED_SESSION];

      assert.deepEqual(activeAfter.videoIds, [], 'Active queue must be updated to empty array');
      assert.equal(activeAfter.count, 0);
      assert.ok(savedAfter, 'Saved session must NOT be erased by empty active queue (preserves restore!)');
      assert.deepEqual(savedAfter.videoIds, ['prevSaved01'], 'Saved session contents preserved');
    });
  });

  // ===========================================================================
  // Boundary 2: Massive Queue (100+ Videos) with 50-Video Cap and Index Clamping
  // ===========================================================================
  describe('Boundary 2: Massive Queue & 50-Video URL Cap', () => {
    test('buildRestoreUrl caps video IDs to exactly 50 and clamps out-of-bounds index', () => {
      // 120 valid 11-char video IDs: vid00000000 .. vid00000119
      const massiveList = Array.from({ length: 120 }, (_, i) => 'vid' + String(i).padStart(8, '0'));
      assert.equal(massiveList.length, 120);

      // Case A: Index 75 (exceeds 50 video limit) -> clamped to 49
      const urlClampedHigh = UrlParser.buildRestoreUrl(massiveList, 75);
      assert.ok(urlClampedHigh.includes('index=49'), 'Index exceeding 50 items must clamp to 49');
      const paramMatchA = urlClampedHigh.match(/video_ids=([^&]+)/);
      assert.ok(paramMatchA, 'Must contain video_ids parameter');
      const decodedIdsA = decodeURIComponent(paramMatchA[1]).split(',');
      assert.equal(decodedIdsA.length, 50, 'Must contain exactly 50 video IDs');
      assert.equal(decodedIdsA[0], 'vid00000000');
      assert.equal(decodedIdsA[49], 'vid00000049');

      // Case B: Negative index -10 -> clamped to 0
      const urlClampedLow = UrlParser.buildRestoreUrl(massiveList, -10);
      assert.ok(urlClampedLow.includes('index=0'), 'Negative index must clamp to 0');

      // Case C: Non-numeric / NaN index -> clamped to 0
      const urlNaN = UrlParser.buildRestoreUrl(massiveList, NaN);
      assert.ok(urlNaN.includes('index=0'), 'NaN index must clamp to 0');

      // Case D: Floating point index -> floored
      const urlFloat = UrlParser.buildRestoreUrl(massiveList, 12.8);
      assert.ok(urlFloat.includes('index=12'), 'Floating index must be floored to 12');
    });

    test('StorageKeys sanitizes queue exceeding 500 items to 500 cap', () => {
      const hugeList = Array.from({ length: 700 }, (_, i) => 'vid' + String(i).padStart(8, '0'));
      const sanitized = StorageKeys.sanitizeQueueState({
        videoIds: hugeList,
        currentIndex: 600,
        count: 700
      });

      assert.equal(sanitized.videoIds.length, 500, 'Queue size must clamp to 500');
      assert.equal(sanitized.currentIndex, 499, 'Index must clamp to max valid index 499');
      assert.equal(sanitized.count, 500);
    });
  });

  // ===========================================================================
  // Boundary 3: Non-standard and Invalid Video IDs
  // ===========================================================================
  describe('Boundary 3: Non-Standard & Invalid Video IDs', () => {
    test('UrlParser.isValidVideoId strictly validates 11-char alphanumeric, hyphen, underscore', () => {
      // Valid IDs
      assert.equal(UrlParser.isValidVideoId('dQw4w9WgXcQ'), true);
      assert.equal(UrlParser.isValidVideoId('a-b_c-d_123'), true);
      assert.equal(UrlParser.isValidVideoId('12345678901'), true);

      // Invalid lengths
      assert.equal(UrlParser.isValidVideoId('tooShort'), false, '8 chars should fail');
      assert.equal(UrlParser.isValidVideoId('1234567890'), false, '10 chars should fail');
      assert.equal(UrlParser.isValidVideoId('123456789012'), false, '12 chars should fail');
      assert.equal(UrlParser.isValidVideoId(''), false, 'Empty string should fail');

      // Invalid characters
      assert.equal(UrlParser.isValidVideoId('has space01'), false, 'Space should fail');
      assert.equal(UrlParser.isValidVideoId('<script>111'), false, 'Script tag characters should fail');
      assert.equal(UrlParser.isValidVideoId('invalid.id1'), false, 'Dot should fail');
      assert.equal(UrlParser.isValidVideoId('vid?param=1'), false, 'Query characters should fail');
      assert.equal(UrlParser.isValidVideoId('vïd00000001'), false, 'Unicode non-ASCII should fail');

      // Non-strings
      assert.equal(UrlParser.isValidVideoId(null), false);
      assert.equal(UrlParser.isValidVideoId(undefined), false);
      assert.equal(UrlParser.isValidVideoId(12345678901), false);
      assert.equal(UrlParser.isValidVideoId({ id: 'dQw4w9WgXcQ' }), false);
    });

    test('FeedDecorator and DuplicateGuard ignore cards with invalid or missing video IDs', () => {
      // Card with missing / invalid href and no data-yqp-video-id
      const badCard = doc.createElement('ytd-rich-item-renderer');
      const thumb = doc.createElement('div');
      thumb.id = 'thumbnail';
      const a = doc.createElement('a');
      a.id = 'thumbnail';
      a.href = '/watch?v=bad_id'; // only 6 chars, invalid
      thumb.appendChild(a);
      badCard.appendChild(thumb);
      doc.body.appendChild(badCard);

      const decorator = new FeedDecorator({
        root: doc,
        mode: 'badge_and_dim',
        videoIds: ['dQw4w9WgXcQ'],
        debounceMs: 0
      });

      assert.equal(badCard.getAttribute('data-yqp-status'), null, 'Bad card must not be decorated');
      assert.equal(badCard.querySelector('.yqp-queue-badge'), null);

      decorator.destroy();
    });
  });

  // ===========================================================================
  // Boundary 4: Rapid Double-Clicks (<50ms) on Queue Buttons
  // ===========================================================================
  describe('Boundary 4: Rapid Double-Clicks & In-Flight Protection', () => {
    test('Rapid consecutive clicks on unqueued video: click 1 passes, click 2 blocked by in-flight guard', () => {
      const vid = 'rapidVid001';
      const { card, innerBtn } = createMockFeedCard(doc, vid);
      doc.body.appendChild(card);

      const toastManager = new ToastManager({ document: doc });
      const duplicateGuard = new DuplicateGuard({
        document: doc,
        window: win,
        toastManager,
        queueObserver: {
          getActiveIdsSet: () => new Set(), // Video is NOT yet in queue
          getActiveVideoIds: () => [],
          count: 0
        },
        enabled: true
      });

      duplicateGuard.start();

      let targetPassCount = 0;
      innerBtn.addEventListener('click', () => {
        targetPassCount++;
      });

      // Click 1: in-flight guard marks video as pending
      const click1 = new MockEvent('click', { bubbles: true, cancelable: true });
      innerBtn.dispatchEvent(click1);

      assert.equal(click1.defaultPrevented, false, 'Click 1 must pass through to native YouTube queue');
      assert.equal(targetPassCount, 1, 'Target listener received click 1');

      // Click 2 (<50ms later, in rapid succession before DOM queue mutation)
      const click2 = new MockEvent('click', { bubbles: true, cancelable: true });
      innerBtn.dispatchEvent(click2);

      assert.equal(click2.defaultPrevented, true, 'Click 2 must be blocked by in-flight guard to prevent duplicate loop');
      assert.equal(click2._propagationStopped, true, 'Click 2 propagation stopped');
      assert.equal(targetPassCount, 1, 'Target listener must NOT receive click 2');

      const toast = doc.getElementById('yqp-toast');
      assert.ok(toast, 'Toast notification must inform user on rapid duplicate attempt');

      duplicateGuard.destroy();
      toastManager.destroy();
    });
  });

  // ===========================================================================
  // Boundary 5: 3-Dot Dropdown Menu Expired TTL (>60s) and Cancellation
  // ===========================================================================
  describe('Boundary 5: 3-Dot Menu TTL Expiration & Cancellation', () => {
    test('3-dot menu video tracking expires when TTL exceeds 60s, failing open safely', () => {
      const vid = 'staleVid001';
      const { card, menuBtn } = createMockFeedCard(doc, vid);
      doc.body.appendChild(card);
      const { queueItem } = createMockDropdownMenu(doc);

      const duplicateGuard = new DuplicateGuard({
        document: doc,
        window: win,
        menuTimeoutMs: 60000,
        queueObserver: {
          getActiveIdsSet: () => new Set([vid]),
          getActiveVideoIds: () => [vid],
          count: 1
        },
        enabled: true
      });

      duplicateGuard.start();

      // Click 3-dot menu button
      menuBtn.click();
      assert.equal(duplicateGuard.lastMenuVideoId, vid);

      // Simulate TTL expiration: advance menu timestamp by 65 seconds
      duplicateGuard.lastMenuTimestamp = Date.now() - 65000;

      // User clicks dropdown Add to queue after TTL expired
      let queueItemExecuted = false;
      queueItem.addEventListener('click', () => {
        queueItemExecuted = true;
      });

      const queueClick = new MockEvent('click', { bubbles: true, cancelable: true });
      queueItem.dispatchEvent(queueClick);

      assert.equal(queueClick.defaultPrevented, false, 'Expired menu click must not be blocked (fails open)');
      assert.equal(queueItemExecuted, true, 'Target listener executed');

      duplicateGuard.destroy();
    });

    test('clearMenuState resets tracked menu video ID and card reference', () => {
      const duplicateGuard = new DuplicateGuard({ document: doc, window: win });
      duplicateGuard.lastMenuVideoId = 'testVid0001';
      duplicateGuard.lastMenuTimestamp = Date.now();

      duplicateGuard.clearMenuState();

      assert.equal(duplicateGuard.lastMenuVideoId, null);
      assert.equal(duplicateGuard.lastMenuTimestamp, 0);
    });
  });

  // ===========================================================================
  // Boundary 6: Corrupted or Uninitialized Storage Payloads
  // ===========================================================================
  describe('Boundary 6: Corrupted Storage Recovery', () => {
    test('StorageKeys sanitizes null, undefined, empty object, and malformed types safely', () => {
      // Preferences
      const cleanNullPrefs = StorageKeys.sanitizePreferences(null);
      assert.equal(cleanNullPrefs.feedTreatmentMode, 'badge_and_dim');
      assert.equal(cleanNullPrefs.duplicateGuardEnabled, true);

      const cleanCorruptPrefs = StorageKeys.sanitizePreferences({
        feedTreatmentMode: 'invalid_mode',
        duplicateGuardEnabled: 'not_a_bool'
      });
      assert.equal(cleanCorruptPrefs.feedTreatmentMode, 'badge_and_dim', 'Invalid mode falls back to default');
      assert.equal(cleanCorruptPrefs.duplicateGuardEnabled, true, 'Invalid bool falls back to default');

      // Queue State
      const cleanNullQueue = StorageKeys.sanitizeQueueState(null);
      assert.deepEqual(cleanNullQueue.videoIds, []);
      assert.equal(cleanNullQueue.count, 0);
      assert.equal(cleanNullQueue.currentIndex, 0);

      const cleanCorruptQueue = StorageKeys.sanitizeQueueState({
        videoIds: 'not_an_array',
        currentIndex: 'bad_index',
        count: 'NaN'
      });
      assert.deepEqual(cleanCorruptQueue.videoIds, []);
      assert.equal(cleanCorruptQueue.count, 0);
      assert.equal(cleanCorruptQueue.currentIndex, 0);
    });

    test('StorageSync safely recovers when storage reads or writes throw errors', async () => {
      const storageSync = new StorageSync({
        storageArea: mockChrome.storage.local,
        debounceDelay: 0
      });

      // Inject failure on next get
      mockChrome.storage.local._failNext(new Error('Corrupted storage area'));

      const active = await storageSync.getActiveQueue();
      assert.deepEqual(active.videoIds, [], 'Should return safe initial queue state on error');

      // Inject quota failure on saveActiveQueue: catches gracefully without throwing unhandled rejection
      mockChrome.storage.local._failNext(new Error('QUOTA_BYTES_PER_ITEM exceeded'));
      await assert.doesNotReject(async () => {
        await storageSync.saveActiveQueue({
          videoIds: ['testVid0001'],
          currentIndex: 0,
          count: 1
        }, true);
      }, 'saveActiveQueue must catch storage failure without crashing the host page');

      // Inject quota failure on setPreferences: returns rejection cleanly to caller
      mockChrome.storage.local._failNextSet(new Error('QUOTA_BYTES_PER_ITEM exceeded'));
      await assert.rejects(async () => {
        await storageSync.setPreferences({ feedTreatmentMode: 'hide' });
      }, /QUOTA_BYTES_PER_ITEM/, 'setPreferences returns clean rejection to caller');
    });
  });

  // ===========================================================================
  // Boundary 7: Anti-Nagging Dismissal Persistence & Newer Session Resurfacing
  // ===========================================================================
  describe('Boundary 7: Anti-Nagging Banner Dismissal & Resurfacing', () => {
    test('Dismissing restore banner records dismissal timestamp and suppresses banner for same session', async () => {
      createYouTubePageDOM(doc);
      const sessionSavedAt = Date.now() - 60000;

      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], count: 0 },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['nagVid00001'],
          currentIndex: 0,
          count: 1,
          savedAt: sessionSavedAt
        }
      });

      const storageSync = new StorageSync({ storageArea: mockChrome.storage.local });
      const restoreController = new RestoreController({
        document: doc,
        window: win,
        storageSync,
        queueObserver: { count: 0, getActiveVideoIds: () => [] }
      });

      // 1. Initial appearance
      await restoreController.checkAndShowBanner();
      const banner = doc.getElementById('yqp-restore-banner');
      assert.ok(banner, 'Banner must be displayed on first detection');

      // 2. User clicks dismiss button
      const dismissBtn = banner.querySelector('.yqp-banner-btn-dismiss');
      dismissBtn.click();
      await new Promise(r => setTimeout(r, 10));

      assert.equal(doc.getElementById('yqp-restore-banner'), null, 'Banner must be removed on dismiss');

      // Check session state stored in chrome.storage.local
      const stateRaw = await mockChrome.storage.local.get(StorageKeys.STORAGE_KEYS.SESSION_STATE);
      const sessionState = stateRaw[StorageKeys.STORAGE_KEYS.SESSION_STATE];
      assert.ok(sessionState, 'Session state must be written');
      assert.equal(sessionState.bannerDismissedSessionSavedAt, sessionSavedAt, 'Dismissed session savedAt must be recorded');

      // 3. User refreshes or rechecks banner for the SAME session
      const availableSameSession = await restoreController.checkRestoreAvailable();
      assert.equal(availableSameSession, false, 'Banner must be suppressed for the same dismissed session');

      restoreController.destroy();
    });

    test('Newer saved session resurfaces restore banner despite prior dismissal of older session', async () => {
      createYouTubePageDOM(doc);
      const olderSavedAt = Date.now() - 100000;
      const newerSavedAt = Date.now() - 5000;

      // Prior dismissal recorded for older session
      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], count: 0 },
        [StorageKeys.STORAGE_KEYS.SESSION_STATE]: {
          bannerDismissedTimestamp: olderSavedAt,
          bannerDismissedSessionSavedAt: olderSavedAt,
          lastRestoredTimestamp: 0
        },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['newVid00001', 'newVid00002'],
          currentIndex: 0,
          count: 2,
          savedAt: newerSavedAt // Newer session!
        }
      });

      const storageSync = new StorageSync({ storageArea: mockChrome.storage.local });
      const restoreController = new RestoreController({
        document: doc,
        window: win,
        storageSync,
        queueObserver: { count: 0, getActiveVideoIds: () => [] }
      });

      const available = await restoreController.checkRestoreAvailable();
      assert.equal(available, true, 'Restore must resurface when a NEWER session is saved (newerSavedAt > olderSavedAt)');

      await restoreController.checkAndShowBanner();
      assert.ok(doc.getElementById('yqp-restore-banner'), 'Banner must be injected for newer session');

      restoreController.destroy();
    });
  });
});
