/**
 * YoutubeQueuePlus - Tier 4: Real-World Application Scenario Test Suite
 * Zero-dependency native Node.js test suite.
 * Executable via: node test/e2e/tier4_realworld.test.js
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

describe('Tier 4: Real-World Application Scenario Tests', () => {
  let mockChrome;

  beforeEach(() => {
    mockChrome = new MockChrome();
    setupGlobalChrome(mockChrome);
    if (typeof ToastManager.reset === 'function') {
      ToastManager.reset();
    }
  });

  afterEach(() => {
    if (typeof ToastManager.reset === 'function') {
      ToastManager.reset();
    }
    restoreGlobalDOM();
    restoreGlobalChrome();
  });

  // ===========================================================================
  // Scenario 1: Complete Browser Restart Session Restore Workflow
  // ===========================================================================
  test('Scenario 1: Complete browser restart session restore end-to-end workflow', async () => {
    // -------------------------------------------------------------------------
    // Phase 1: User Session 1 (Before Browser Shutdown)
    // -------------------------------------------------------------------------
    const doc1 = new MockDocument();
    const win1 = new MockWindow(doc1);
    setupGlobalDOM({ document: doc1, window: win1 });
    createYouTubePageDOM(doc1);

    const queuedVideos = ['vidRest0001', 'vidRest0002', 'vidRest0003', 'vidRest0004'];

    // Setup native YouTube playlist panel with 4 videos
    const { panel: playlistPanel1 } = createMockPlaylistPanel(doc1, queuedVideos, 0);
    doc1.body.appendChild(playlistPanel1);

    // Setup home feed cards matching the queued videos
    const homeCards1 = queuedVideos.map(vid => {
      const { card } = createMockFeedCard(doc1, vid);
      doc1.body.appendChild(card);
      return card;
    });

    // Boot ContentMain in Session 1
    const app1 = new ContentMain({
      document: doc1,
      window: win1,
      storageArea: mockChrome.storage.local,
      storageOnChanged: mockChrome.storage.onChanged,
      storageSyncOptions: { debounceDelay: 0 },
      queueObserverOptions: { debounceMs: 0 }
    });
    await app1.init();

    // Trigger queue scan & state sync
    app1.queueObserver.rescan(true);
    await app1.storageSync.flush();

    // Verify Session 1 active state
    assert.deepEqual(app1.queueObserver.getActiveVideoIds(), queuedVideos, 'Session 1 queue observer has 4 videos');
    homeCards1.forEach((card, idx) => {
      assert.equal(card.getAttribute('data-yqp-status'), 'queued', `Card ${idx + 1} must be badged`);
      assert.equal(card.style.opacity, '0.4', `Card ${idx + 1} must be dimmed`);
    });

    // Verify storage has both active queue and durable saved session
    const storageState1 = await mockChrome.storage.local.get([
      StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE,
      StorageKeys.STORAGE_KEYS.SAVED_SESSION
    ]);
    const savedSession1 = storageState1[StorageKeys.STORAGE_KEYS.SAVED_SESSION];
    assert.ok(savedSession1, 'Saved session must be written to chrome.storage.local');
    assert.deepEqual(savedSession1.videoIds, queuedVideos);
    assert.ok(savedSession1.savedAt > 0);

    // -------------------------------------------------------------------------
    // Phase 2: Browser Shutdown Simulation
    // -------------------------------------------------------------------------
    // Browser quits: in-memory DOM, observers, and listeners are completely destroyed
    app1.destroy();
    restoreGlobalDOM();

    // Reset active queue to simulate fresh browser startup where native queue is empty
    await mockChrome.storage.local.set({
      [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: { videoIds: [], currentIndex: 0, count: 0 }
    });

    // -------------------------------------------------------------------------
    // Phase 3: Browser Restart Simulation (Fresh Session 2)
    // -------------------------------------------------------------------------
    // User relaunches browser and opens YouTube homepage
    const doc2 = new MockDocument();
    const win2 = new MockWindow(doc2);
    setupGlobalDOM({ document: doc2, window: win2 });
    createYouTubePageDOM(doc2);

    // After browser restart, YouTube's native queue is EMPTY (no playlist panel in DOM)
    assert.equal(doc2.querySelector('ytd-playlist-panel-renderer'), null, 'Native queue absent on startup');

    // Fresh feed cards appear on home feed
    const freshHomeCard = createMockFeedCard(doc2, 'vidRest0001').card;
    doc2.body.appendChild(freshHomeCard);

    // Boot ContentMain in fresh Session 2
    const app2 = new ContentMain({
      document: doc2,
      window: win2,
      storageArea: mockChrome.storage.local,
      storageOnChanged: mockChrome.storage.onChanged,
      storageSyncOptions: { debounceDelay: 0 },
      queueObserverOptions: { debounceMs: 0 },
      restoreControllerOptions: { autoStart: false }
    });
    await app2.init();

    // Verify RestoreController detected available restore session and displayed banner
    const isRestoreAvailable = await app2.restoreController.checkRestoreAvailable();
    assert.equal(isRestoreAvailable, true, 'Restore session must be detected on browser restart');

    await app2.restoreController.checkAndShowBanner();
    const banner = doc2.getElementById('yqp-restore-banner');
    assert.ok(banner, 'Restore banner #yqp-restore-banner must be injected into DOM on restart');
    assert.ok(banner.textContent.includes('4 videos'), 'Banner must indicate 4 videos in saved session');

    // -------------------------------------------------------------------------
    // Phase 4: 1-Click Restore Action
    // -------------------------------------------------------------------------
    const restoreBtn = banner.querySelector('.yqp-banner-btn-restore');
    assert.ok(restoreBtn, 'Restore button must be present in banner');

    // User clicks "Restore Queue" button
    restoreBtn.click();
    await new Promise(r => setTimeout(r, 60));

    // Verify navigation was triggered to /watch_videos with all 4 video IDs and index 0
    const expectedUrl = UrlParser.buildRestoreUrl(queuedVideos, 0);
    assert.equal(win2.location.href, expectedUrl, 'Window location must navigate to native /watch_videos endpoint');
    assert.ok(win2.location.href.includes('vidRest0001'), 'URL contains video IDs');
    assert.ok(win2.location.href.includes('vidRest0004'), 'URL contains all videos');

    // Verify banner was cleanly removed after restore
    assert.equal(doc2.getElementById('yqp-restore-banner'), null, 'Banner must be dismissed after restore');

    // Verify session state updated with lastRestoredTimestamp
    const sessionState = await app2.storageSync.getSessionState();
    assert.ok(sessionState.lastRestoredTimestamp > 0, 'lastRestoredTimestamp must be recorded');

    app2.destroy();
  });

  // ===========================================================================
  // Scenario 2: Heavy Multi-Page Browse & Queue Building Workflow
  // ===========================================================================
  test('Scenario 2: Heavy multi-page browse & queue building with duplicate guard, mode switch, and popup reactivity', async () => {
    const doc = new MockDocument();
    const win = new MockWindow(doc);
    setupGlobalDOM({ document: doc, window: win });
    createYouTubePageDOM(doc);

    // Boot ContentMain
    const app = new ContentMain({
      document: doc,
      window: win,
      storageArea: mockChrome.storage.local,
      storageOnChanged: mockChrome.storage.onChanged,
      storageSyncOptions: { debounceDelay: 0 },
      queueObserverOptions: { debounceMs: 0 }
    });
    await app.init();

    // -------------------------------------------------------------------------
    // Step 1: User starts on Home Feed (/) and queues 2 videos
    // -------------------------------------------------------------------------
    const homeVid1 = 'vidHme00001';
    const homeVid2 = 'vidHme00002';
    const cardHme1 = createMockFeedCard(doc, homeVid1).card;
    const cardHme2 = createMockFeedCard(doc, homeVid2).card;
    doc.body.appendChild(cardHme1);
    doc.body.appendChild(cardHme2);

    // Native playlist panel created as videos are added
    const { panel: playlistPanel } = createMockPlaylistPanel(doc, [homeVid1, homeVid2], 0);
    doc.body.appendChild(playlistPanel);

    app.queueObserver.rescan(true);
    await app.storageSync.flush();

    // Both home cards decorated
    assert.equal(cardHme1.getAttribute('data-yqp-status'), 'queued');
    assert.equal(cardHme2.getAttribute('data-yqp-status'), 'queued');
    assert.equal(cardHme1.style.opacity, '0.4');

    // -------------------------------------------------------------------------
    // Step 2: SPA Navigation to Search Results (/results?search_query=nature)
    // -------------------------------------------------------------------------
    win.location.href = 'https://www.youtube.com/results?search_query=nature';

    // Search page displays 3 results: a new video, and homeVid1 again in search results
    const srchVid1 = 'vidSrch0001';
    const { card: cardSrch1 } = createMockFeedCard(doc, srchVid1, { title: 'Nature 1' });
    const { card: cardSrchDup, innerBtn: dupInnerBtn } = createMockFeedCard(doc, homeVid1, { title: 'Nature Dup' });
    doc.body.appendChild(cardSrch1);
    doc.body.appendChild(cardSrchDup);

    // SPA navigation event fires
    win.dispatchEvent(new MockEvent('yt-navigate-finish', { bubbles: true }));

    // cardSrchDup is automatically decorated because homeVid1 is already queued!
    assert.equal(cardSrchDup.getAttribute('data-yqp-status'), 'queued', 'Already queued video appearing on search feed must be badged');
    assert.equal(cardSrch1.getAttribute('data-yqp-status'), null, 'New search video not yet badged');

    // -------------------------------------------------------------------------
    // Step 3: Duplicate Guard Intercepts Accidental Re-add
    // -------------------------------------------------------------------------
    // User tries to add cardSrchDup (homeVid1) to queue again
    const dupClick = new MockEvent('click', { bubbles: true, cancelable: true });
    dupInnerBtn.dispatchEvent(dupClick);

    assert.equal(dupClick.defaultPrevented, true, 'Duplicate addition on search page must be intercepted');
    const toast = doc.getElementById('yqp-toast');
    assert.ok(toast, 'Toast notification must inform user');
    assert.equal(toast.textContent.includes('Video is already in queue'), true);

    // Queue count remains 2 (duplicate prevented)
    assert.equal(app.queueObserver.count, 2);

    // -------------------------------------------------------------------------
    // Step 4: User Opens Options Popup and Switches Mode to 'hide'
    // -------------------------------------------------------------------------
    const popupDOM = createPopupDOM(doc);
    const popupController = new PopupController({
      document: doc,
      window: win,
      chrome: mockChrome
    });
    popupController.init();
    await new Promise(r => setTimeout(r, 15));

    // Verify popup displays live queue state (2 videos)
    assert.equal(popupDOM.queueCount.textContent, '2 videos', 'Popup must display live 2 videos');
    assert.equal(popupDOM.playingIndex.textContent, 'Video 1 of 2');

    // User switches mode to 'hide' in popup
    popupDOM.radioHide.checked = true;
    popupDOM.radioHide.dispatchEvent(new MockEvent('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 15));

    // Verify preference written to storage
    const storedPrefs = (await mockChrome.storage.local.get(StorageKeys.STORAGE_KEYS.PREFERENCES))[StorageKeys.STORAGE_KEYS.PREFERENCES];
    assert.equal(storedPrefs.feedTreatmentMode, 'hide');

    // Verify queued card on the page dynamically changes from dimmed to hidden!
    assert.equal(cardSrchDup.getAttribute('data-yqp-mode'), 'hide');
    assert.equal(cardSrchDup.style.display, 'none', 'Card must be hidden in "hide" mode without page reload');

    // -------------------------------------------------------------------------
    // Step 5: Continuation to Watch Page (/watch?v=vidSrch0001)
    // -------------------------------------------------------------------------
    win.location.href = `https://www.youtube.com/watch?v=${srchVid1}`;

    // On watch page, sidebar contains compact video card for homeVid2
    const { card: compactCard } = createMockFeedCard(doc, homeVid2, { tagName: 'ytd-compact-video-renderer' });
    doc.body.appendChild(compactCard);

    win.dispatchEvent(new MockEvent('yt-navigate-finish', { bubbles: true }));

    // Compact card matching queued item is hidden according to 'hide' mode preference
    assert.equal(compactCard.getAttribute('data-yqp-status'), 'queued');
    assert.equal(compactCard.getAttribute('data-yqp-mode'), 'hide');
    assert.equal(compactCard.style.display, 'none', 'Sidebar compact video must be hidden');

    app.destroy();
  });
});
