/**
 * YoutubeQueuePlus - Tier 1: Core Feature Coverage Test Suite (R1–R4 in Isolation)
 * Zero-dependency native Node.js test suite.
 * Executable via: node test/e2e/tier1_features.test.js
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

describe('Tier 1: Core Feature Coverage (R1–R4 in Isolation)', () => {
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
  // Feature R1: Native Queue Synchronization & Feed Decoration
  // ===========================================================================
  describe('R1: Queue Monitoring & Feed Decoration', () => {
    test('R1.1: QueueObserver extracts ordered video IDs and current index from watch panel', async () => {
      const videoIds = ['dQw4w9WgXcQ', 'jNQXAC9IVRw', 'kJQP7kiw5Fk'];
      const { panel } = createMockPlaylistPanel(doc, videoIds, 1);
      doc.body.appendChild(panel);

      const observer = new QueueObserver({ document: doc, window: win, debounceMs: 0 });
      observer.start();
      observer.rescan(true);

      assert.deepEqual(observer.getActiveVideoIds(), videoIds, 'Should extract exact list of 3 video IDs');
      assert.equal(observer.getCurrentIndex(), 1, 'Should extract selected index of 1');
      assert.equal(observer.getCurrentVideoId(), 'jNQXAC9IVRw', 'Should track current playing video ID');
      assert.equal(observer.getActiveIdsSet().has('dQw4w9WgXcQ'), true, 'Set should contain first video');
      assert.equal(observer.getActiveIdsSet().has('unknown0001'), false, 'Set should not contain untracked ID');

      observer.destroy();
    });

    test('R1.2: QueueObserver extracts queue state from miniplayer when watch panel is absent', async () => {
      const miniIds = ['miniVid0001', 'miniVid0002'];
      const { panel } = createMockPlaylistPanel(doc, miniIds, 0, { isMiniplayer: true });
      doc.body.appendChild(panel);

      const observer = new QueueObserver({ document: doc, window: win, debounceMs: 0 });
      observer.start();
      observer.rescan(true);

      assert.deepEqual(observer.getActiveVideoIds(), miniIds, 'Should extract video IDs from active miniplayer');
      assert.equal(observer.count, 2, 'Count should match miniplayer items');

      observer.destroy();
    });

    test('R1.3: FeedDecorator attaches QUEUED badge and data attributes to matching feed cards', () => {
      const queuedId = 'dQw4w9WgXcQ';
      const unqueuedId = 'notInQueue1';

      const card1 = createMockFeedCard(doc, queuedId).card;
      const card2 = createMockFeedCard(doc, unqueuedId).card;
      doc.body.appendChild(card1);
      doc.body.appendChild(card2);

      const decorator = new FeedDecorator({
        root: doc,
        mode: 'badge_and_dim',
        videoIds: [queuedId],
        debounceMs: 0
      });

      assert.equal(card1.getAttribute('data-yqp-status'), 'queued', 'Queued card should have status="queued"');
      assert.equal(card1.getAttribute('data-yqp-video-id'), queuedId, 'Queued card should store video ID');
      const badge = card1.querySelector('.yqp-queue-badge');
      assert.ok(badge, 'Queued card should contain .yqp-queue-badge element');
      assert.equal(badge.textContent, 'QUEUED', 'Badge should display QUEUED text');

      assert.equal(card2.getAttribute('data-yqp-status'), null, 'Unqueued card should not have queued status');
      assert.equal(card2.querySelector('.yqp-queue-badge'), null, 'Unqueued card should not have badge');

      decorator.destroy();
    });

    test('R1.4: Feed treatment mode "badge_and_dim" sets reduced opacity and displays badge', () => {
      const vid = 'testDimV001';
      const { card } = createMockFeedCard(doc, vid);
      doc.body.appendChild(card);

      const decorator = new FeedDecorator({
        root: doc,
        mode: 'badge_and_dim',
        videoIds: [vid],
        debounceMs: 0
      });

      assert.equal(card.getAttribute('data-yqp-mode'), 'badge_and_dim');
      assert.equal(card.style.opacity, '0.4', 'Card opacity should be dimmed to 0.4');
      assert.ok(card.querySelector('.yqp-queue-badge'), 'Badge element should be present');

      decorator.destroy();
    });

    test('R1.5: Feed treatment mode "hide" sets display to none', () => {
      const vid = 'testHide001';
      const { card } = createMockFeedCard(doc, vid);
      doc.body.appendChild(card);

      const decorator = new FeedDecorator({
        root: doc,
        mode: 'hide',
        videoIds: [vid],
        debounceMs: 0
      });

      assert.equal(card.getAttribute('data-yqp-mode'), 'hide');
      assert.equal(card.style.display, 'none', 'Card display should be set to none');

      decorator.destroy();
    });

    test('R1.6: Feed treatment mode "badge_only" attaches badge without dimming opacity or hiding', () => {
      const vid = 'testBadge01';
      const { card } = createMockFeedCard(doc, vid);
      doc.body.appendChild(card);

      const decorator = new FeedDecorator({
        root: doc,
        mode: 'badge_only',
        videoIds: [vid],
        debounceMs: 0
      });

      assert.equal(card.getAttribute('data-yqp-mode'), 'badge_only');
      assert.ok(card.querySelector('.yqp-queue-badge'), 'Badge element should be present');
      assert.notEqual(card.style.display, 'none', 'Card should not be hidden');
      assert.notEqual(card.style.opacity, '0.4', 'Card should not be dimmed');

      decorator.destroy();
    });

    test('R1.7: Removing an item from queue dynamically clears decoration and restores card styling', () => {
      const vid = 'removeMe001';
      const { card } = createMockFeedCard(doc, vid);
      doc.body.appendChild(card);

      const decorator = new FeedDecorator({
        root: doc,
        mode: 'badge_and_dim',
        videoIds: [vid],
        debounceMs: 0
      });

      assert.equal(card.getAttribute('data-yqp-status'), 'queued');
      assert.equal(card.style.opacity, '0.4');

      // Update queue removing vid
      decorator.updateQueue([]);

      assert.equal(card.getAttribute('data-yqp-status'), null, 'Status attribute should be removed');
      assert.equal(card.querySelector('.yqp-queue-badge'), null, 'Badge should be removed');
      assert.equal(card.style.opacity, '', 'Opacity should be cleared');

      decorator.destroy();
    });

    test('R1.8: Newly appended feed cards via infinite scroll are automatically decorated', async () => {
      const vid = 'infScroll01';
      const decorator = new FeedDecorator({
        root: doc,
        mode: 'badge_and_dim',
        videoIds: [vid],
        debounceMs: 0
      });

      const { card } = createMockFeedCard(doc, vid);
      doc.body.appendChild(card);

      // Flush MutationObserver microtasks and debounced scanner
      MockMutationObserver.flush();
      await new Promise(r => setTimeout(r, 15));

      assert.equal(card.getAttribute('data-yqp-status'), 'queued', 'Newly added card should be decorated automatically');
      assert.ok(card.querySelector('.yqp-queue-badge'), 'Badge should be added');

      decorator.destroy();
    });
  });

  // ===========================================================================
  // Feature R2: Native Queue Session Persistence & Restore Protocol
  // ===========================================================================
  describe('R2: Session Persistence & Restore Protocol', () => {
    test('R2.1: StorageSync writes active queue snapshot to chrome.storage.local', async () => {
      const storageSync = new StorageSync({
        storageArea: mockChrome.storage.local,
        debounceDelay: 0
      });

      const queueState = {
        videoIds: ['vid00000001', 'vid00000002'],
        currentIndex: 0,
        currentVideoId: 'vid00000001',
        count: 2
      };

      await storageSync.saveActiveQueue(queueState, true);

      const raw = await mockChrome.storage.local.get(StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE);
      const stored = raw[StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE];
      assert.ok(stored, 'Active queue should be stored in chrome.storage.local');
      assert.deepEqual(stored.videoIds, queueState.videoIds);
      assert.equal(stored.currentIndex, 0);
      assert.equal(stored.count, 2);
    });

    test('R2.2: StorageSync atomically updates saved session when active queue has >= 1 video', async () => {
      const storageSync = new StorageSync({
        storageArea: mockChrome.storage.local,
        debounceDelay: 0
      });

      const queueState = {
        videoIds: ['vidSaved001', 'vidSaved002', 'vidSaved003'],
        currentIndex: 1,
        currentVideoId: 'vidSaved002',
        count: 3
      };

      await storageSync.saveActiveQueue(queueState, true);

      const raw = await mockChrome.storage.local.get(StorageKeys.STORAGE_KEYS.SAVED_SESSION);
      const saved = raw[StorageKeys.STORAGE_KEYS.SAVED_SESSION];
      assert.ok(saved, 'Saved session must be written to chrome.storage.local');
      assert.deepEqual(saved.videoIds, queueState.videoIds);
      assert.equal(saved.currentIndex, 1);
      assert.ok(saved.savedAt > 0, 'Timestamp should be recorded');
    });

    test('R2.3: StorageSync in-memory diffing suppresses redundant writes for identical queue state', async () => {
      const storageSync = new StorageSync({
        storageArea: mockChrome.storage.local,
        debounceDelay: 0
      });

      const queueState = {
        videoIds: ['vidDiff0001'],
        currentIndex: 0,
        currentVideoId: 'vidDiff0001',
        count: 1
      };

      const firstWrite = await storageSync.saveActiveQueue(queueState, true);
      assert.equal(firstWrite, true, 'First save should execute write');

      const secondWrite = await storageSync.saveActiveQueue(queueState, true);
      assert.equal(secondWrite, false, 'Identical second save should be skipped by diff');
    });

    test('R2.4: RestoreController detects restore availability when active queue is empty and saved session exists', async () => {
      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], currentIndex: 0, count: 0 },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['restVid0001', 'restVid0002', 'restVid0003'],
          currentIndex: 0,
          count: 3,
          savedAt: Date.now() - 1000
        }
      });

      const restoreController = new RestoreController({
        document: doc,
        window: win,
        storageSync: new StorageSync({ storageArea: mockChrome.storage.local }),
        queueObserver: { count: 0, getActiveVideoIds: () => [] }
      });

      const available = await restoreController.checkRestoreAvailable();
      assert.equal(available, true, 'Restore should be available when active queue is empty and saved session exists');

      restoreController.destroy();
    });

    test('R2.5: RestoreController injects restore banner below masthead container', async () => {
      const { masthead, pageManager } = createYouTubePageDOM(doc);

      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], count: 0 },
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['bannerVid01', 'bannerVid02'],
          currentIndex: 0,
          count: 2,
          savedAt: Date.now() - 5000
        }
      });

      const restoreController = new RestoreController({
        document: doc,
        window: win,
        storageSync: new StorageSync({ storageArea: mockChrome.storage.local }),
        queueObserver: { count: 0, getActiveVideoIds: () => [] }
      });

      await restoreController.checkAndShowBanner();

      const banner = doc.getElementById('yqp-restore-banner');
      assert.ok(banner, 'Banner #yqp-restore-banner should be injected into the DOM');
      assert.equal(banner.classList.contains('yqp-restore-banner'), true);

      const restoreBtn = banner.querySelector('.yqp-banner-btn-restore');
      const dismissBtn = banner.querySelector('.yqp-banner-btn-dismiss');
      assert.ok(restoreBtn, 'Restore button should be present in banner');
      assert.ok(dismissBtn, 'Dismiss button should be present in banner');

      restoreController.destroy();
    });

    test('R2.6: UrlParser builds canonical /watch_videos multi-video player restore URL', () => {
      const ids = ['vidAlpha001', 'vidBeta0002', 'vidGamma003'];
      const url = UrlParser.buildRestoreUrl(ids, 1);
      assert.equal(
        url,
        'https://www.youtube.com/watch_videos?video_ids=vidAlpha001%2CvidBeta0002%2CvidGamma003&index=1',
        'Should build valid watch_videos URL with comma-separated IDs and index'
      );
    });
  });

  // ===========================================================================
  // Feature R3: Duplicate Addition Guard & Feedback
  // ===========================================================================
  describe('R3: Duplicate Addition Guard', () => {
    test('R3.1: Capturing-phase click interception suppresses duplicate hover queue addition', () => {
      const queuedId = 'queuedVid01';
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

      let targetClicked = false;
      innerBtn.addEventListener('click', () => {
        targetClicked = true;
      });

      const clickEvent = new MockEvent('click', { bubbles: true, cancelable: true });
      const dispatched = innerBtn.dispatchEvent(clickEvent);

      assert.equal(clickEvent.defaultPrevented, true, 'Default action should be prevented on duplicate');
      assert.equal(clickEvent._propagationStopped, true, 'Event propagation should be stopped');
      assert.equal(dispatched, false, 'dispatchEvent should return false when prevented');
      assert.equal(targetClicked, false, 'Target listener should not have been reached');

      const toast = doc.getElementById('yqp-toast');
      assert.ok(toast, 'Toast notification element should be created');
      assert.equal(toast.textContent.includes('Video is already in queue'), true, 'Toast should display duplicate notice');

      duplicateGuard.destroy();
      toastManager.destroy();
    });

    test('R3.2: 3-Dot dropdown menu click tracks video ID and intercepts subsequent Add to queue click', () => {
      const queuedId = 'queuedVid02';
      const { card, menuBtn } = createMockFeedCard(doc, queuedId);
      doc.body.appendChild(card);

      const { popup, queueItem } = createMockDropdownMenu(doc);

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

      // Step 1: User clicks 3-dot menu button on card
      menuBtn.click();
      assert.equal(duplicateGuard.lastMenuVideoId, queuedId, 'DuplicateGuard should record lastMenuVideoId');

      // Step 2: User clicks "Add to queue" in dropdown menu
      const queueClick = new MockEvent('click', { bubbles: true, cancelable: true });
      queueItem.dispatchEvent(queueClick);

      assert.equal(queueClick.defaultPrevented, true, 'Dropdown Add to queue should be prevented for queued video');
      assert.equal(queueClick._propagationStopped, true, 'Dropdown click propagation should be stopped');

      duplicateGuard.destroy();
      toastManager.destroy();
    });

    test('R3.3: ToastManager renders native YouTube styled snackbar with ARIA accessibility', () => {
      const toastManager = new ToastManager({ document: doc });
      toastManager.show('Video is already in queue');

      const toast = doc.getElementById('yqp-toast');
      assert.ok(toast, '#yqp-toast container should exist');
      assert.equal(toast.getAttribute('role'), 'status', 'Toast should have role="status"');
      assert.equal(toast.getAttribute('aria-live'), 'polite', 'Toast should have aria-live="polite"');
      assert.equal(toast.classList.contains('yqp-toast-visible'), true, 'Toast should have visible class');

      toastManager.destroy();
    });

    test('R3.4: Unqueued video addition attempts pass through unhindered without interception or toast', () => {
      const unqueuedId = 'notQueued01';
      const { card, innerBtn } = createMockFeedCard(doc, unqueuedId);
      doc.body.appendChild(card);

      const toastManager = new ToastManager({ document: doc });
      const duplicateGuard = new DuplicateGuard({
        document: doc,
        window: win,
        toastManager,
        queueObserver: {
          getActiveIdsSet: () => new Set(['otherVid001']),
          getActiveVideoIds: () => ['otherVid001'],
          count: 1
        },
        enabled: true
      });

      duplicateGuard.start();

      let targetInvoked = false;
      innerBtn.addEventListener('click', () => {
        targetInvoked = true;
      });

      const clickEvent = new MockEvent('click', { bubbles: true, cancelable: true });
      const dispatched = innerBtn.dispatchEvent(clickEvent);

      assert.equal(clickEvent.defaultPrevented, false, 'Default action should NOT be prevented for unqueued video');
      assert.equal(targetInvoked, true, 'Target listener should be executed');
      assert.equal(dispatched, true, 'dispatchEvent should return true');
      assert.equal(doc.getElementById('yqp-toast'), null, 'Toast should NOT be displayed');

      duplicateGuard.destroy();
      toastManager.destroy();
    });
  });

  // ===========================================================================
  // Feature R4: Options & Status Popup UI
  // ===========================================================================
  describe('R4: Options & Status Popup UI', () => {
    test('R4.1: Popup renders active queue metrics and playing index from storage', async () => {
      const popupDOM = createPopupDOM(doc);

      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: {
          videoIds: ['popVid00001', 'popVid00002', 'popVid00003'],
          currentIndex: 2,
          count: 3
        }
      });

      const controller = new PopupController({
        document: doc,
        window: win,
        chrome: mockChrome
      });
      controller.init();

      // Allow async state load
      await new Promise(r => setTimeout(r, 10));

      assert.equal(popupDOM.queueCount.textContent, '3 videos', 'Queue count should render "3 videos"');
      assert.equal(popupDOM.playingIndex.textContent, 'Video 3 of 3', 'Playing index should render format "Video 3 of 3"');
      assert.equal(popupDOM.queueLivePill.textContent, 'LIVE', 'Pill should display LIVE when queue > 0');
    });

    test('R4.2: Popup renders saved session details and formatted date/time', async () => {
      const popupDOM = createPopupDOM(doc);
      const savedTime = Date.now() - 120000; // 2 minutes ago

      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds: ['saved000001', 'saved000002'],
          currentIndex: 0,
          count: 2,
          savedAt: savedTime
        }
      });

      const controller = new PopupController({
        document: doc,
        window: win,
        chrome: mockChrome
      });
      controller.init();

      await new Promise(r => setTimeout(r, 10));

      assert.equal(popupDOM.savedCount.textContent, '2 videos', 'Saved count should display "2 videos"');
      assert.equal(popupDOM.savedTime.textContent, '2m ago', 'Saved time should format relative minutes "2m ago"');
      assert.equal(popupDOM.restoreBtn.disabled, false, 'Restore button should be enabled when session exists');
    });

    test('R4.3: Changing feed treatment mode radio button writes preference to chrome.storage.local', async () => {
      const popupDOM = createPopupDOM(doc);

      const controller = new PopupController({
        document: doc,
        window: win,
        chrome: mockChrome
      });
      controller.init();

      await new Promise(r => setTimeout(r, 10));

      // User selects "hide" mode
      popupDOM.radioHide.checked = true;
      popupDOM.radioHide.dispatchEvent(new MockEvent('change', { bubbles: true }));

      await new Promise(r => setTimeout(r, 10));

      const raw = await mockChrome.storage.local.get(StorageKeys.STORAGE_KEYS.PREFERENCES);
      const prefs = raw[StorageKeys.STORAGE_KEYS.PREFERENCES];
      assert.ok(prefs, 'Preferences should be written to storage');
      assert.equal(prefs.feedTreatmentMode, 'hide', 'Stored feedTreatmentMode should be "hide"');
    });

    test('R4.4: Clicking restore button in popup navigates active tab to /watch_videos URL', async () => {
      const popupDOM = createPopupDOM(doc);
      const videoIds = ['restore0001', 'restore0002'];

      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
          videoIds,
          currentIndex: 0,
          count: 2,
          savedAt: Date.now() - 5000
        }
      });

      const controller = new PopupController({
        document: doc,
        window: win,
        chrome: mockChrome
      });
      controller.init();

      await new Promise(r => setTimeout(r, 10));

      // Click restore button
      popupDOM.restoreBtn.click();

      await new Promise(r => setTimeout(r, 10));

      // Verify active tab URL updated
      const activeTab = mockChrome.tabs._tabs[0];
      assert.ok(activeTab.url.includes('/watch_videos?video_ids='), 'Active tab should navigate to /watch_videos URL');
      assert.ok(activeTab.url.includes('restore0001'), 'URL should include video IDs');
    });

    test('R4.5: Popup updates UI live via chrome.storage.onChanged without reopening', async () => {
      const popupDOM = createPopupDOM(doc);

      const controller = new PopupController({
        document: doc,
        window: win,
        chrome: mockChrome
      });
      controller.init();

      await new Promise(r => setTimeout(r, 10));

      assert.equal(popupDOM.queueCount.textContent, '0 videos');

      // External storage change occurs (e.g. video queued in YouTube tab)
      await mockChrome.storage.local.set({
        [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: {
          videoIds: ['liveVid0001', 'liveVid0002'],
          currentIndex: 0,
          count: 2
        }
      });

      await new Promise(r => setTimeout(r, 10));

      assert.equal(popupDOM.queueCount.textContent, '2 videos', 'Live onChanged event should update queue count to 2');
      assert.equal(popupDOM.queueLivePill.textContent, 'LIVE', 'Live pill should switch to LIVE');
    });
  });
});
