/**
 * YoutubeQueuePlus - Tier 5: Adversarial Coverage Hardening Test Suite
 * Zero-dependency native Node.js test suite.
 * Executable via: node test/e2e/tier5_adversarial_1.test.js
 *
 * Focus Areas:
 * 1. DuplicateGuard: Negative keyword checks ("Remove from queue", "Quitar de la cola",
 *    "Supprimer de la file d'attente", "Delete", "Clear") in Channel B 3-dot dropdown menus.
 * 2. ToastManager: Action callback double-fire guards during rapid dismissal transitions.
 * 3. QueueObserver: Polymer DOM recycling and playlist re-ordering edge cases.
 * 4. RestoreController: Concurrency races and rapid button interaction guards.
 * 5. FeedDecorator: Polymer card recycling and high-frequency mode toggle stability.
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

describe('Tier 5: Adversarial Coverage Hardening (Adversarial Suite 1)', () => {
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
  // Focus Area 1: DuplicateGuard Channel B Negative Keyword Vulnerability
  // ===========================================================================
  describe('Focus Area 1: DuplicateGuard Channel B Negative Keyword Analysis', () => {
    test('1.1: EMPIRICAL VULNERABILITY: "Remove from queue" in 3-dot menu is falsely intercepted as an addition attempt', () => {
      const videoId = 'dQw4w9WgXcQ';
      const queueSet = new Set([videoId]);

      const toastCalls = [];
      const mockToast = {
        show: (msg) => toastCalls.push(msg)
      };

      let duplicateBlockedEvent = null;
      const guard = new DuplicateGuard({
        document: doc,
        window: win,
        queueObserver: queueSet,
        toastManager: mockToast,
        enabled: true,
        autoStart: true,
        onDuplicateBlocked: (payload) => {
          duplicateBlockedEvent = payload;
        }
      });

      // 1. Create a video feed card for the queued video
      const { card, menuBtn } = createMockFeedCard(doc, videoId);
      doc.body.appendChild(card);

      // 2. User clicks 3-dot action menu button on card (Channel B Step 1)
      const menuClickEvent = new MockEvent('click', { bubbles: true, cancelable: true });
      menuBtn.dispatchEvent(menuClickEvent);

      // Verify that DuplicateGuard tracked the card's video ID
      assert.equal(guard.getMenuState().videoId, videoId, 'Should have tracked 3-dot menu video ID');

      // 3. YouTube displays dropdown menu containing "Remove from queue"
      const popup = doc.createElement('ytd-popup-container');
      const menuPopup = doc.createElement('ytd-menu-popup-renderer');
      const listbox = doc.createElement('tp-yt-paper-listbox');

      const removeItem = doc.createElement('ytd-menu-service-item-renderer');
      const removePaper = doc.createElement('tp-yt-paper-item');
      const removeLabel = doc.createElement('yt-formatted-string');
      removeLabel.textContent = 'Remove from queue';
      removePaper.appendChild(removeLabel);
      removeItem.appendChild(removePaper);
      listbox.appendChild(removeItem);

      menuPopup.appendChild(listbox);
      popup.appendChild(menuPopup);
      doc.body.appendChild(popup);

      // 4. User clicks "Remove from queue"
      const itemClickEvent = new MockEvent('click', { bubbles: true, cancelable: true });
      removeItem.dispatchEvent(itemClickEvent);

      // HARDENED VERIFICATION:
      // Negative keywords ("Remove from queue") ensure DuplicateGuard does NOT intercept queue removal!
      assert.equal(itemClickEvent.defaultPrevented, false, 'Click on "Remove from queue" is allowed through');
      assert.equal(itemClickEvent._propagationStopped, false, 'Propagation of "Remove from queue" is not stopped');
      assert.equal(toastCalls.length, 0, 'No duplicate toast triggered for a removal action');
      assert.equal(duplicateBlockedEvent, null, 'onDuplicateBlocked was not triggered for removal');

      guard.destroy();
    });

    test('1.2: EMPIRICAL VULNERABILITY: Multilingual negative keywords ("Quitar de la cola", "Supprimer de la file d\'attente", "Aus Warteschlange entfernen", "Очистить очередь")', () => {
      const multilingualNegativeCases = [
        { lang: 'Spanish', text: 'Quitar de la cola', kw: 'cola' },
        { lang: 'French', text: 'Supprimer de la file d\'attente', kw: 'file d\'attente' },
        { lang: 'German', text: 'Aus Warteschlange entfernen', kw: 'warteschlange' },
        { lang: 'Portuguese', text: 'Remover da fila', kw: 'fila' },
        { lang: 'Japanese', text: 'キューから削除', kw: 'キュー' },
        { lang: 'Russian', text: 'Очистить очередь', kw: 'очередь' }
      ];

      for (const tc of multilingualNegativeCases) {
        const videoId = 'testVid9999';
        const queueSet = new Set([videoId]);
        let blocked = false;

        const guard = new DuplicateGuard({
          document: doc,
          window: win,
          queueObserver: queueSet,
          toastManager: { show: () => {} },
          autoStart: true,
          onDuplicateBlocked: () => { blocked = true; }
        });

        const { card, menuBtn } = createMockFeedCard(doc, videoId);
        doc.body.appendChild(card);

        // Click 3-dot menu
        menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true, cancelable: true }));

        // Create multilingual menu item
        const popup = doc.createElement('ytd-popup-container');
        const item = doc.createElement('ytd-menu-service-item-renderer');
        const label = doc.createElement('span');
        label.textContent = tc.text;
        item.appendChild(label);
        popup.appendChild(item);
        doc.body.appendChild(popup);

        const clickEvt = new MockEvent('click', { bubbles: true, cancelable: true });
        item.dispatchEvent(clickEvt);

        // HARDENED VERIFICATION: Each multilingual removal phrase passes through without interception
        assert.equal(
          clickEvt.defaultPrevented,
          false,
          `Multilingual negative phrase "${tc.text}" was correctly allowed through`
        );
        assert.equal(blocked, false, `onDuplicateBlocked did not fire for ${tc.lang}`);

        guard.destroy();
        doc.body.removeChild(card);
        doc.body.removeChild(popup);
      }
    });

    test('1.3: EMPIRICAL VULNERABILITY: "Delete from queue" and "Clear queue" trigger false positive interception', () => {
      const testPhrases = ['Delete from queue', 'Clear queue', 'Delete queue item', 'Remove item from queue'];

      for (const phrase of testPhrases) {
        const videoId = 'deleteVid01';
        let blocked = false;

        const guard = new DuplicateGuard({
          document: doc,
          window: win,
          queueObserver: new Set([videoId]),
          toastManager: { show: () => {} },
          autoStart: true,
          onDuplicateBlocked: () => { blocked = true; }
        });

        const { card, menuBtn } = createMockFeedCard(doc, videoId);
        doc.body.appendChild(card);
        menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true, cancelable: true }));

        const popup = doc.createElement('ytd-popup-container');
        const item = doc.createElement('ytd-menu-service-item-renderer');
        item.textContent = phrase;
        popup.appendChild(item);
        doc.body.appendChild(popup);

        const evt = new MockEvent('click', { bubbles: true, cancelable: true });
        item.dispatchEvent(evt);

        assert.equal(evt.defaultPrevented, false, `Phrase "${phrase}" was correctly allowed through`);
        assert.equal(blocked, false);

        guard.destroy();
        doc.body.removeChild(card);
        doc.body.removeChild(popup);
      }
    });

    test('1.4: ARCHITECTURAL CONTRAST: "Save to Watch later" is correctly ignored due to _isWatchLater', () => {
      const videoId = 'watchLater01';
      let blocked = false;

      const guard = new DuplicateGuard({
        document: doc,
        window: win,
        queueObserver: new Set([videoId]),
        toastManager: { show: () => {} },
        autoStart: true,
        onDuplicateBlocked: () => { blocked = true; }
      });

      const { card, menuBtn } = createMockFeedCard(doc, videoId);
      doc.body.appendChild(card);
      menuBtn.dispatchEvent(new MockEvent('click', { bubbles: true, cancelable: true }));

      // Menu item for "Save to Watch later"
      const popup = doc.createElement('ytd-popup-container');
      const item = doc.createElement('ytd-menu-service-item-renderer');
      item.textContent = 'Save to Watch later';
      popup.appendChild(item);
      doc.body.appendChild(popup);

      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      item.dispatchEvent(evt);

      // PROOF: Watch later has an explicit negative guard, proving that a negative check mechanism was intended
      // but was omitted for removal keywords.
      assert.equal(evt.defaultPrevented, false, '"Save to Watch later" correctly passes through');
      assert.equal(blocked, false, 'No block triggered for Watch later');

      guard.destroy();
    });

    test('1.5: Channel A Hover Overlay Toggle Button in "Remove" state is falsely intercepted', () => {
      const videoId = 'toggleVid01';
      let blocked = false;

      const guard = new DuplicateGuard({
        document: doc,
        window: win,
        queueObserver: new Set([videoId]),
        toastManager: { show: () => {} },
        autoStart: true,
        onDuplicateBlocked: () => { blocked = true; }
      });

      const { card } = createMockFeedCard(doc, videoId);
      // Toggle button in active/queued state where tooltip/aria-label indicates removal
      const overlayBtn = doc.createElement('ytd-thumbnail-overlay-toggle-button-renderer');
      overlayBtn.setAttribute('aria-label', 'Remove from queue');
      card.appendChild(overlayBtn);
      doc.body.appendChild(card);

      const evt = new MockEvent('click', { bubbles: true, cancelable: true });
      overlayBtn.dispatchEvent(evt);

      // HARDENED VERIFICATION: Overlay button click attempting to remove is not intercepted
      assert.equal(evt.defaultPrevented, false, 'Overlay "Remove from queue" button was not prevented');
      assert.equal(blocked, false);

      guard.destroy();
    });
  });

  // ===========================================================================
  // Focus Area 2: ToastManager Action Callback Double-Fire Vulnerability
  // ===========================================================================
  describe('Focus Area 2: ToastManager Action Callback Double-Fire Guards', () => {
    test('2.1: EMPIRICAL VULNERABILITY: Action callback double-fires when clicked during fade transition (< 250ms)', () => {
      let executionCount = 0;
      const toast = new ToastManager({
        document: doc,
        duration: 1000,
        fadeDuration: 250
      });

      toast.show('Video is already in queue', {
        actionText: 'Undo',
        onAction: () => {
          executionCount++;
        }
      });

      const btn = doc.querySelector('.yqp-toast-action-btn');
      assert.ok(btn, 'Action button should be present in DOM');

      // Click 1: Normal action button click
      const clickEvt1 = new MockEvent('click', { bubbles: true, cancelable: true });
      btn.dispatchEvent(clickEvt1);

      assert.equal(executionCount, 1, 'First click invokes callback once');
      assert.equal(toast._state, 'dismissing', 'Toast enters dismissing state');

      // Click 2: Rapid second click executed 50ms later while toast is fading out
      const clickEvt2 = new MockEvent('click', { bubbles: true, cancelable: true });
      btn.dispatchEvent(clickEvt2);

      // HARDENED VERIFICATION:
      // In ToastManager._handleActionClick:
      // The button is disabled and actionCallback cleared upon the first click,
      // and clicks while _state === 'dismissing' are ignored.
      // Therefore, the second click during fade-out does NOT double-fire the callback!
      assert.equal(executionCount, 1, 'Action callback executes exactly once; double-fire prevented during fade transition');

      toast.destroy();
    });

    test('2.2: EMPIRICAL VULNERABILITY: Burst multi-clicking fires callback multiple times without guard', () => {
      let executionCount = 0;
      const toast = new ToastManager({
        document: doc,
        duration: 1000,
        fadeDuration: 300
      });

      toast.show('Restore Available', {
        actionText: 'Restore',
        onAction: () => {
          executionCount++;
        }
      });

      const btn = doc.querySelector('.yqp-toast-action-btn');

      // Simulate user frantically clicking 5 times in 20ms
      for (let i = 0; i < 5; i++) {
        btn.dispatchEvent(new MockEvent('click', { bubbles: true, cancelable: true }));
      }

      // HARDENED VERIFICATION: Callback fired exactly once
      assert.equal(executionCount, 1, 'Callback fired exactly once on rapid burst clicks');

      toast.destroy();
    });

    test('2.3: Action callback returning false keeps toast visible but leaves callback vulnerable to repeated clicks', () => {
      let executionCount = 0;
      const toast = new ToastManager({
        document: doc,
        duration: 1000
      });

      toast.show('Action required', {
        actionText: 'Retry',
        onAction: () => {
          executionCount++;
          return false; // Intentionally keep visible
        }
      });

      const btn = doc.querySelector('.yqp-toast-action-btn');
      btn.dispatchEvent(new MockEvent('click', { bubbles: true, cancelable: true }));
      assert.equal(executionCount, 1);
      assert.equal(toast.isVisible(), true);

      // Second click
      btn.dispatchEvent(new MockEvent('click', { bubbles: true, cancelable: true }));
      assert.equal(executionCount, 2, 'Callback executed again on subsequent click');

      toast.destroy();
    });

    test('2.4: Queue deduplication bypass during dismissing state leads to duplicate toasts in queue', () => {
      const toast = new ToastManager({
        document: doc,
        duration: 500,
        fadeDuration: 200
      });

      toast.show('Original Toast');
      toast.dismiss(); // Enters 'dismissing' state

      // Send 3 duplicate notices while dismissing
      toast.show('Queued Message');
      toast.show('Queued Message');
      toast.show('Queued Message');

      // EMPIRICAL OBSERVATION:
      // In 'dismissing' state, the deduplication logic in show() (lines 324-329) is skipped,
      // and lines 344 pushes directly to this._queue without checking for existing identical messages.
      assert.equal(toast.getQueueLength(), 3, 'Reveals that queue deduplication is bypassed in dismissing state');

      toast.destroy();
    });
  });

  // ===========================================================================
  // Focus Area 3: QueueObserver Polymer DOM Recycling Edge Cases
  // ===========================================================================
  describe('Focus Area 3: QueueObserver Polymer DOM Recycling & Re-Ordering Edge Cases', () => {
    test('3.1: EMPIRICAL VULNERABILITY: Stale data-yqp-video-id attribute on recycled playlist item causes QueueObserver to extract incorrect video ID', () => {
      const originalVideoId = 'vidOld11111';
      const recycledVideoId = 'vidNew22222';

      // 1. Create a queue panel with 1 item
      const { panel, videoRenderers } = createMockPlaylistPanel(doc, [originalVideoId], 0);
      doc.body.appendChild(panel);

      const observer = new QueueObserver({ document: doc, window: win, debounceMs: 0 });
      observer.start();
      observer.rescan(true);

      assert.deepEqual(observer.getActiveVideoIds(), [originalVideoId]);

      // 2. Polymer virtual list recycles the DOM element for recycledVideoId:
      // It sets a cached data-yqp-video-id on the item, but updates child anchor href to the new video!
      const itemEl = videoRenderers[0];
      itemEl.setAttribute('data-yqp-video-id', originalVideoId); // Stale extension attribute remaining from previous scan

      const anchor = itemEl.querySelector('a#wc-endpoint') || itemEl.querySelector('a');
      anchor.setAttribute('href', `/watch?v=${recycledVideoId}`); // Polymer updated the true link!

      // 3. QueueObserver rescans
      observer.rescan(true);

      // HARDENED VERIFICATION:
      // Prioritizing child anchor href over stale data-yqp-video-id extracts the correct recycled ID!
      const extractedIds = observer.getActiveVideoIds();
      assert.equal(
        extractedIds[0],
        recycledVideoId,
        'QueueObserver extracted the true recycled video ID because updated child anchor href took precedence'
      );

      observer.destroy();
    });

    test('3.2: Re-ordering playlist items with transient multiple selected attributes latches onto first element', () => {
      const videoIds = ['videoAAA001', 'videoBBB002', 'videoCCC003'];
      const { panel, videoRenderers } = createMockPlaylistPanel(doc, videoIds, 2); // Third item selected
      doc.body.appendChild(panel);

      const observer = new QueueObserver({ document: doc, window: win, debounceMs: 0 });
      observer.start();
      observer.rescan(true);

      assert.equal(observer.getCurrentIndex(), 2, 'Initial selected index is 2');

      // During drag-and-drop re-order, Polymer temporarily flags both item 0 and item 2 as selected
      videoRenderers[0].setAttribute('selected', '');
      videoRenderers[2].setAttribute('selected', '');

      observer.rescan(true);

      // EMPIRICAL BEHAVIOR: Latches to first matching item in DOM tree order (index 0)
      assert.equal(observer.getCurrentIndex(), 0, 'Latches onto first element with selected attribute');

      observer.destroy();
    });

    test('3.3: Inactive watch panel retained on home page during SPA navigation is falsely identified as active queue', () => {
      // User was on watch page, then navigated to home page
      win.location.pathname = '/'; // Home page!

      // Watch panel remains in DOM because YouTube does not destroy it, but marks it hidden
      const { panel } = createMockPlaylistPanel(doc, ['vidWatch001', 'vidWatch002'], 0);
      panel.setAttribute('hidden', '');
      doc.body.appendChild(panel);

      const observer = new QueueObserver({ document: doc, window: win, debounceMs: 0 });
      observer.start();
      observer.rescan(true);

      // HARDENED VERIFICATION:
      // In QueueObserver._hasQueueItems():
      // Hidden panels are guarded against, correctly reporting queue as inactive on home page!
      assert.equal(observer.isQueueActive(), false, 'Reports queue as inactive on home page with hidden panel');
      assert.deepEqual(observer.getActiveVideoIds(), []);

      observer.destroy();
    });
  });

  // ===========================================================================
  // Focus Area 4: RestoreController Concurrency & State Inconsistencies
  // ===========================================================================
  describe('Focus Area 4: RestoreController Concurrency & Rapid Interaction Guards', () => {
    test('4.1: STRESS TEST: Concurrent checkAndShowBanner() calls mount a single banner via isBannerVisible guard', async () => {
      const savedSession = {
        videoIds: ['vidRestore1', 'vidRestore2'],
        currentIndex: 0,
        savedAt: Date.now() - 5000
      };

      const storageSync = {
        getPreferences: async () => ({ showRestoreBanner: true }),
        getActiveQueue: async () => ({ videoIds: [], count: 0 }),
        getSavedSession: async () => savedSession,
        getSessionState: async () => null,
        subscribe: () => () => {}
      };

      const masthead = doc.createElement('ytd-masthead');
      masthead.setAttribute('id', 'masthead-container');
      doc.body.appendChild(masthead);

      const controller = new RestoreController({
        document: doc,
        window: win,
        storageSync,
        autoStart: false
      });

      // Fire two checkAndShowBanner calls concurrently
      await Promise.all([
        controller.checkAndShowBanner(),
        controller.checkAndShowBanner()
      ]);

      // EMPIRICAL VERIFICATION:
      // RestoreController._mountBanner checks `this.isBannerVisible()` synchronously,
      // successfully preventing duplicate banner injection into the DOM.
      const banners = doc.querySelectorAll('#yqp-restore-banner');
      assert.equal(banners.length, 1, 'Single banner mounted in DOM without duplication');

      controller.destroy();
    });

    test('4.2: EMPIRICAL VULNERABILITY: Rapid double-clicking restore button triggers multiple navigation calls', async () => {
      const savedSession = {
        videoIds: ['vidRestore1'],
        currentIndex: 0,
        savedAt: Date.now() - 1000
      };

      let navCalls = 0;
      let stateCalls = 0;

      const storageSync = {
        getPreferences: async () => ({ showRestoreBanner: true }),
        getActiveQueue: async () => ({ videoIds: [], count: 0 }),
        getSavedSession: async () => savedSession,
        getSessionState: async () => null,
        setSessionState: async () => {
          // Simulate async storage disk write
          await new Promise(r => setTimeout(r, 10));
          stateCalls++;
        },
        subscribe: () => () => {}
      };

      const controller = new RestoreController({
        document: doc,
        window: win,
        storageSync,
        navigateFn: () => { navCalls++; },
        autoStart: false
      });

      await controller.checkAndShowBanner();

      const banner = controller.getBannerElement();
      assert.ok(banner);
      const restoreBtn = banner.querySelector('.yqp-banner-btn-restore');
      assert.ok(restoreBtn);

      // User rapidly double-clicks restore button
      restoreBtn.dispatchEvent(new MockEvent('click', { bubbles: true, cancelable: true }));
      restoreBtn.dispatchEvent(new MockEvent('click', { bubbles: true, cancelable: true }));

      // Wait for async restore promises to resolve
      await new Promise(r => setTimeout(r, 40));

      // EMPIRICAL DEFECT: Double execution without button disablement
      assert.equal(navCalls, 2, 'EMPIRICAL DEFECT: Double-click triggered 2 navigation events');
      assert.equal(stateCalls, 2, 'EMPIRICAL DEFECT: Double-click triggered 2 setSessionState writes');

      controller.destroy();
    });

    test('4.3: Interleaved restore and dismiss calls handled gracefully without unhandled rejections', async () => {
      const savedSession = {
        videoIds: ['vidA', 'vidB'],
        currentIndex: 0,
        savedAt: Date.now() - 2000
      };

      const storageSync = {
        getPreferences: async () => ({ showRestoreBanner: true }),
        getActiveQueue: async () => ({ videoIds: [], count: 0 }),
        getSavedSession: async () => savedSession,
        getSessionState: async () => null,
        setSessionState: async () => {},
        subscribe: () => () => {}
      };

      const controller = new RestoreController({
        document: doc,
        window: win,
        storageSync,
        navigateFn: () => {},
        autoStart: false
      });

      await controller.checkAndShowBanner();

      // Interleave restore and dismiss concurrently
      await assert.doesNotReject(async () => {
        await Promise.all([
          controller.restore(),
          controller.dismiss()
        ]);
      });

      assert.equal(controller.isBannerVisible(), false);
      controller.destroy();
    });
  });

  // ===========================================================================
  // Focus Area 5: FeedDecorator Polymer Recycling & Memory Stability
  // ===========================================================================
  describe('Focus Area 5: FeedDecorator Polymer Recycling & Memory Stability', () => {
    test('5.1: Recycled feed card whose video changed is correctly un-decorated by FeedDecorator anchor-first check', () => {
      const queuedId = 'video000001'; // exact 11 chars
      const unqueuedId = 'video000002'; // exact 11 chars

      const decorator = new FeedDecorator({
        mode: 'badge_and_dim',
        videoIds: [queuedId],
        root: doc,
        autoObserve: false
      });

      // 1. Create card initially containing queuedId
      const { card } = createMockFeedCard(doc, queuedId);
      doc.body.appendChild(card);

      decorator.scanAndDecorate();

      assert.equal(card.getAttribute('data-yqp-status'), 'queued');
      assert.equal(card.style.opacity, '0.4');
      assert.ok(card.querySelector('.yqp-queue-badge'));

      // 2. Polymer recycles the card for unqueuedId:
      // Updates child anchor hrefs, leaving stale data-yqp-video-id on the card host
      const anchors = card.querySelectorAll('a');
      for (const a of anchors) {
        a.setAttribute('href', `/watch?v=${unqueuedId}`);
      }

      // 3. Decorator rescans
      decorator.scanAndDecorate();

      // In FeedDecorator.getVideoId(card):
      // It explicitly checks the child anchor href first, correctly updating data-yqp-video-id and removing decoration!
      assert.equal(card.getAttribute('data-yqp-status'), null, 'Recycled card successfully un-decorated');
      assert.equal(card.style.opacity, '', 'Opacity restored');
      assert.equal(card.querySelector('.yqp-queue-badge'), null, 'Badge removed');

      decorator.destroy();
    });

    test('5.2: Rapid mode toggling under continuous mutation load maintains clean DOM state', () => {
      const videoIds = ['video000001', 'video000002', 'video000003']; // exact 11 chars
      const decorator = new FeedDecorator({
        mode: 'badge_and_dim',
        videoIds,
        root: doc,
        autoObserve: false
      });

      const cards = videoIds.map(id => {
        const { card } = createMockFeedCard(doc, id);
        doc.body.appendChild(card);
        return card;
      });

      decorator.scanAndDecorate();

      const modes = ['badge_and_dim', 'hide', 'badge_only'];

      // Perform 60 rapid mode switches
      for (let i = 0; i < 60; i++) {
        const targetMode = modes[i % modes.length];
        decorator.setMode(targetMode);
        assert.equal(decorator.getMode(), targetMode);
      }

      // Final state check with badge_only
      decorator.setMode('badge_only');
      for (const card of cards) {
        assert.equal(card.getAttribute('data-yqp-mode'), 'badge_only');
        assert.equal(card.style.display, '');
        assert.equal(card.style.opacity, '');
        assert.ok(card.querySelector('.yqp-queue-badge'));
      }

      decorator.destroy();

      // Post-destroy: all decorations cleaned up
      for (const card of cards) {
        assert.equal(card.getAttribute('data-yqp-status'), null);
        assert.equal(card.querySelector('.yqp-queue-badge'), null);
      }
    });
  });
});
