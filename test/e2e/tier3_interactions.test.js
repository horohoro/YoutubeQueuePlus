/**
 * YoutubeQueuePlus - Tier 3: Cross-Feature Interaction Test Suite
 * Zero-dependency native Node.js test suite.
 * Executable via: node test/e2e/tier3_interactions.test.js
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
const ContentMain = require('../../src/content_main');
const { PopupController } = require('../../popup/popup');

describe('Tier 3: Cross-Feature Interaction Tests', () => {
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
  // Interaction 1: Treatment Mode Toggle while Active Queue is Mutating
  // ===========================================================================
  test('Interaction 1: Treatment mode toggle dynamically updates cards while queue is mutating without page reload', async () => {
    const vidA = 'vidAlpha001';
    const vidB = 'vidBeta0002';

    const cardA = createMockFeedCard(doc, vidA).card;
    const cardB = createMockFeedCard(doc, vidB).card;
    doc.body.appendChild(cardA);
    doc.body.appendChild(cardB);

    const storageSync = new StorageSync({
      storageArea: mockChrome.storage.local,
      storageOnChanged: mockChrome.storage.onChanged,
      debounceDelay: 0
    });

    const feedDecorator = new FeedDecorator({
      root: doc,
      mode: 'badge_and_dim',
      videoIds: [vidA],
      debounceMs: 0
    });

    // Wire preference changes to feed decorator mode
    storageSync.onPreferencesChanged((prefs) => {
      feedDecorator.setMode(prefs.feedTreatmentMode);
    });

    // Card A is decorated in badge_and_dim
    assert.equal(cardA.getAttribute('data-yqp-status'), 'queued');
    assert.equal(cardA.getAttribute('data-yqp-mode'), 'badge_and_dim');
    assert.equal(cardA.style.opacity, '0.4');

    // Step 1: User switches treatment mode to 'hide' via storage / popup
    await mockChrome.storage.local.set({
      [StorageKeys.STORAGE_KEYS.PREFERENCES]: {
        feedTreatmentMode: 'hide',
        duplicateGuardEnabled: true,
        showRestoreBanner: true
      }
    });

    // Mode updates immediately
    assert.equal(cardA.getAttribute('data-yqp-mode'), 'hide', 'Card A mode should update to hide');
    assert.equal(cardA.style.display, 'none', 'Card A should be hidden');

    // Step 2: Queue mutates - vidB is added to queue while 'hide' mode is active
    feedDecorator.updateQueue([vidA, vidB]);

    assert.equal(cardB.getAttribute('data-yqp-status'), 'queued');
    assert.equal(cardB.getAttribute('data-yqp-mode'), 'hide', 'Newly queued Card B must receive active hide mode');
    assert.equal(cardB.style.display, 'none', 'Card B should be hidden');

    // Step 3: User switches mode to 'badge_only'
    await mockChrome.storage.local.set({
      [StorageKeys.STORAGE_KEYS.PREFERENCES]: {
        feedTreatmentMode: 'badge_only',
        duplicateGuardEnabled: true,
        showRestoreBanner: true
      }
    });

    assert.equal(cardA.getAttribute('data-yqp-mode'), 'badge_only');
    assert.equal(cardB.getAttribute('data-yqp-mode'), 'badge_only');
    assert.notEqual(cardA.style.display, 'none', 'Card A display restored');
    assert.notEqual(cardB.style.display, 'none', 'Card B display restored');
    assert.ok(cardA.querySelector('.yqp-queue-badge'));
    assert.ok(cardB.querySelector('.yqp-queue-badge'));

    feedDecorator.destroy();
  });

  // ===========================================================================
  // Interaction 2: Adding Duplicate Video while Restore Banner is Visible
  // ===========================================================================
  test('Interaction 2: Adding duplicate video while restore banner is visible blocks duplicate and maintains banner stability', async () => {
    createYouTubePageDOM(doc);
    const queuedId = 'savedVid001';

    // Home feed has restore banner for a saved session while native queue is empty
    await mockChrome.storage.local.set({
      [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], count: 0 },
      [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
        videoIds: [queuedId],
        currentIndex: 0,
        count: 1,
        savedAt: Date.now() - 10000
      }
    });

    const storageSync = new StorageSync({ storageArea: mockChrome.storage.local });
    const restoreController = new RestoreController({
      document: doc,
      window: win,
      storageSync,
      queueObserver: { count: 0, getActiveVideoIds: () => [] }
    });

    // Banner is mounted
    await restoreController.checkAndShowBanner();
    const banner = doc.getElementById('yqp-restore-banner');
    assert.ok(banner, 'Restore banner must be present in DOM');

    // Add feed card matching queuedId
    const { card, innerBtn } = createMockFeedCard(doc, queuedId);
    doc.body.appendChild(card);

    const toastManager = new ToastManager({ document: doc });
    const duplicateGuard = new DuplicateGuard({
      document: doc,
      window: win,
      toastManager,
      queueObserver: {
        getActiveIdsSet: () => new Set([queuedId]),
        getActiveVideoIds: () => [queuedId],
        count: 1
      },
      enabled: true
    });
    duplicateGuard.start();

    // User attempts to add already queued video from the feed
    const clickEvent = new MockEvent('click', { bubbles: true, cancelable: true });
    innerBtn.dispatchEvent(clickEvent);

    assert.equal(clickEvent.defaultPrevented, true, 'Duplicate addition must be blocked');
    const toast = doc.getElementById('yqp-toast');
    assert.ok(toast, 'Toast notification must be displayed');

    // Crucial invariant: restore banner remains stable and undisturbed
    const bannerAfter = doc.getElementById('yqp-restore-banner');
    assert.ok(bannerAfter, 'Restore banner must remain visible and undisturbed');
    assert.equal(bannerAfter, banner, 'Banner node identity should be unchanged');

    restoreController.destroy();
    duplicateGuard.destroy();
    toastManager.destroy();
  });

  // ===========================================================================
  // Interaction 3: SPA Page Navigation (yt-navigate-finish) Lifecycle
  // ===========================================================================
  test('Interaction 3: SPA navigation (yt-navigate-finish) triggers feed re-decoration and re-evaluates banner', async () => {
    createYouTubePageDOM(doc);
    const vidActive = 'spaVid00001';

    // Initialize ContentMain
    const app = new ContentMain({
      document: doc,
      window: win,
      storageArea: mockChrome.storage.local,
      storageOnChanged: mockChrome.storage.onChanged
    });
    await app.init();

    // Simulate active queue with 1 video
    app.queueObserver.activeVideoIds = [vidActive];
    app.queueObserver.activeIdsSet = new Set([vidActive]);
    app.queueObserver.count = 1;
    app.feedDecorator.updateQueue([vidActive]);

    // Card on initial page
    const card1 = createMockFeedCard(doc, vidActive).card;
    doc.body.appendChild(card1);
    app.feedDecorator.scanAndDecorate();
    assert.equal(card1.getAttribute('data-yqp-status'), 'queued');

    // User navigates via YouTube SPA event (yt-navigate-finish)
    win.location.href = 'https://www.youtube.com/results?search_query=rock';
    const newCard = createMockFeedCard(doc, vidActive, { title: 'Search Result' }).card;
    doc.body.appendChild(newCard);

    // Fire SPA navigation event
    win.dispatchEvent(new MockEvent('yt-navigate-finish', { bubbles: true }));

    // Re-decoration occurs on new cards
    assert.equal(newCard.getAttribute('data-yqp-status'), 'queued', 'New page cards must be re-decorated after SPA navigation');
    assert.ok(newCard.querySelector('.yqp-queue-badge'));

    // Active queue is not empty, so restore banner must NOT be shown
    assert.equal(doc.getElementById('yqp-restore-banner'), null, 'Restore banner should not show during active queue session');

    app.destroy();
  });

  // ===========================================================================
  // Interaction 4: Cross-Tab Queue Mutation & Synchronization
  // ===========================================================================
  test('Interaction 4: Tab A storage sync triggers live feed re-decoration in Tab B without page reload', async () => {
    const vidCross = 'crossTab001';

    // Setup Tab B DOM and Decorator
    const docB = new MockDocument();
    const winB = new MockWindow(docB);
    const cardInTabB = createMockFeedCard(docB, vidCross).card;
    docB.body.appendChild(cardInTabB);

    const storageSyncB = new StorageSync({
      storageArea: mockChrome.storage.local,
      storageOnChanged: mockChrome.storage.onChanged,
      debounceDelay: 0
    });

    const feedDecoratorB = new FeedDecorator({
      root: docB,
      mode: 'badge_and_dim',
      videoIds: [], // Initially empty in Tab B
      debounceMs: 0
    });

    // Wire Tab B storage changes to its feed decorator
    storageSyncB.onQueueChanged((queueState) => {
      feedDecoratorB.updateQueue(queueState?.videoIds || []);
    });

    assert.equal(cardInTabB.getAttribute('data-yqp-status'), null, 'Card in Tab B initially unqueued');

    // Tab A (another tab) writes new active queue state to chrome.storage.local
    const storageSyncA = new StorageSync({
      storageArea: mockChrome.storage.local,
      storageOnChanged: mockChrome.storage.onChanged,
      debounceDelay: 0
    });

    await storageSyncA.saveActiveQueue({
      videoIds: [vidCross],
      currentIndex: 0,
      count: 1
    }, true);

    // Tab B should have received the onChanged event and decorated its card
    assert.equal(cardInTabB.getAttribute('data-yqp-status'), 'queued', 'Tab B card must be decorated on cross-tab sync');
    assert.ok(cardInTabB.querySelector('.yqp-queue-badge'));
    assert.equal(cardInTabB.style.opacity, '0.4');

    feedDecoratorB.destroy();
  });

  // ===========================================================================
  // Interaction 5: In-Flight Addition Resolved by QueueObserver Mutation
  // ===========================================================================
  test('Interaction 5: In-flight addition resolved by QueueObserver transitions to genuine duplicate blocking', () => {
    const vid = 'flowVid0001';
    const { card, innerBtn } = createMockFeedCard(doc, vid);
    doc.body.appendChild(card);

    const activeSet = new Set();
    const mockObserver = {
      activeSet,
      getActiveIdsSet: () => activeSet,
      getActiveVideoIds: () => Array.from(activeSet),
      count: activeSet.size,
      subscribe: (fn) => {
        mockObserver._sub = fn;
        return () => {};
      }
    };

    const toastManager = new ToastManager({ document: doc });
    const duplicateGuard = new DuplicateGuard({
      document: doc,
      window: win,
      toastManager,
      queueObserver: mockObserver,
      enabled: true
    });
    duplicateGuard.start();

    // 1. Initial click: not yet queued, permitted through YouTube
    const click1 = new MockEvent('click', { bubbles: true, cancelable: true });
    innerBtn.dispatchEvent(click1);
    assert.equal(click1.defaultPrevented, false, 'Click 1 permitted to native YouTube');
    assert.equal(duplicateGuard._pendingAdditions.has(vid), true, 'Marked as in-flight pending addition');

    // 2. YouTube DOM mutations occur: QueueObserver observes addition and publishes state
    activeSet.add(vid);
    if (mockObserver._sub) {
      mockObserver._sub({ videoIds: [vid], count: 1 });
    }

    // In-flight pending set resolved
    assert.equal(duplicateGuard._pendingAdditions.has(vid), false, 'In-flight set cleared once queue syncs');

    // 3. User clicks again: now officially in queue, blocked as duplicate
    const click2 = new MockEvent('click', { bubbles: true, cancelable: true });
    innerBtn.dispatchEvent(click2);

    assert.equal(click2.defaultPrevented, true, 'Subsequent click blocked as genuine duplicate');
    assert.ok(doc.getElementById('yqp-toast'), 'Toast displayed on duplicate attempt');

    duplicateGuard.destroy();
    toastManager.destroy();
  });
});
