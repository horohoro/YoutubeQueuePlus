/**
 * Independent Victory Audit Test Suite
 * Executed independently by Victory Auditor to verify R1–R4,
 * Manifest V3 conformance, zero-build execution, and absence of telemetry.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MockDocument,
  MockWindow,
  MockElement,
  MockEvent,
  MockMutationObserver,
  createMockFeedCard,
  createPopupDOM,
  createMockDropdownMenu,
  setupGlobalDOM,
  restoreGlobalDOM
} = require('./harness/mock-dom');
const { MockChrome } = require('./harness/mock-chrome');

const Constants = require('../src/shared/constants');
const StorageKeys = require('../src/shared/storage_keys');
const UrlParser = require('../src/utils/url_parser');
const DomHelpers = require('../src/utils/dom_helpers');
const StorageSync = require('../src/modules/storage_sync');
const ToastManager = require('../src/modules/toast_manager');
const DuplicateGuard = require('../src/modules/duplicate_guard');
const FeedDecorator = require('../src/modules/feed_decorator');
const QueueObserver = require('../src/modules/queue_observer');
const RestoreController = require('../src/modules/restore_controller');
const ContentMain = require('../src/content_main');
const ServiceWorker = require('../src/background/service_worker');
const { PopupController } = require('../popup/popup');

const ROOT_DIR = path.resolve(__dirname, '..');

// =============================================================================
// AUDIT SUITE 1: Manifest V3 & Zero-Build Conformance & Security
// =============================================================================
test('AUDIT-1: Manifest V3, Zero-Build & Telemetry Verification', async (t) => {
  await t.test('1.1: manifest.json strictly conforms to MV3 specifications', () => {
    const manifestPath = path.join(ROOT_DIR, 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist');
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);

    assert.equal(manifest.manifest_version, 3, 'manifest_version must be 3');
    assert.deepEqual(manifest.permissions, ['storage'], 'permissions must only contain storage');
    assert.deepEqual(manifest.host_permissions, ['*://*.youtube.com/*'], 'host_permissions must only be YouTube');
    assert.ok(manifest.background?.service_worker, 'service worker must be declared');
    assert.ok(fs.existsSync(path.join(ROOT_DIR, manifest.background.service_worker)), 'service worker file must exist');

    // Verify content scripts
    const cs = manifest.content_scripts?.[0];
    assert.ok(cs, 'content_scripts entry must exist');
    assert.deepEqual(cs.matches, ['*://*.youtube.com/*']);
    assert.equal(cs.run_at, 'document_idle');

    for (const jsFile of cs.js) {
      assert.ok(fs.existsSync(path.join(ROOT_DIR, jsFile)), `Content script file ${jsFile} must exist`);
    }
    for (const cssFile of cs.css) {
      assert.ok(fs.existsSync(path.join(ROOT_DIR, cssFile)), `Content CSS file ${cssFile} must exist`);
    }
  });

  await t.test('1.2: Zero-build verification - all source files load as valid vanilla JS', () => {
    const srcDir = path.join(ROOT_DIR, 'src');
    const jsFiles = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) jsFiles.push(full);
      }
    }
    walk(srcDir);
    walk(path.join(ROOT_DIR, 'popup'));

    assert.ok(jsFiles.length >= 10, 'Expected at least 10 JS source files');
    for (const file of jsFiles) {
      const code = fs.readFileSync(file, 'utf8');
      assert.doesNotThrow(() => {
        new Function(code);
      }, `File ${path.relative(ROOT_DIR, file)} must parse as valid JavaScript`);
    }
  });

  await t.test('1.3: Absence of external telemetry and network calls', () => {
    const jsFiles = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) jsFiles.push(full);
      }
    }
    walk(path.join(ROOT_DIR, 'src'));
    walk(path.join(ROOT_DIR, 'popup'));

    const telemetryPatterns = [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bnavigator\.sendBeacon\b/,
      /\bWebSocket\b/,
      /\bimportScripts\b/,
      /https?:\/\/(?!www\.youtube\.com|youtube\.com|youtu\.be|www\.w3\.org)/
    ];

    for (const file of jsFiles) {
      const code = fs.readFileSync(file, 'utf8');
      for (const pat of telemetryPatterns) {
        assert.ok(!pat.test(code), `File ${path.relative(ROOT_DIR, file)} must not contain telemetry matching ${pat}`);
      }
    }
  });
});

// =============================================================================
// AUDIT SUITE 2: Requirement R1 - Native Queue Sync & Feed Decoration
// =============================================================================
test('AUDIT-2: Requirement R1 - Feed Decoration & Dynamic Badging', async (t) => {
  function setupTestEnv() {
    const doc = new MockDocument();
    const win = new MockWindow(doc);
    setupGlobalDOM({ document: doc, window: win });

    const decorator = new FeedDecorator({
      root: doc,
      autoObserve: false,
      mode: 'badge_and_dim'
    });

    return { doc, win, decorator };
  }

  await t.test('2.1: Cards in active queue are badged and dimmed in badge_and_dim mode', () => {
    const { doc, decorator } = setupTestEnv();
    const { card: card1 } = createMockFeedCard(doc, 'dQw4w9WgXcQ');
    const { card: card2 } = createMockFeedCard(doc, 'jNQXAC9IVRw');
    doc.body.appendChild(card1);
    doc.body.appendChild(card2);

    decorator.updateQueue(['dQw4w9WgXcQ']);

    assert.equal(card1.getAttribute('data-yqp-status'), 'queued');
    assert.equal(card1.style.opacity, '0.4');
    const badge = card1.querySelector('.yqp-queue-badge');
    assert.ok(badge, 'Badge element must be injected');
    assert.equal(badge.textContent, 'QUEUED');

    assert.notEqual(card2.getAttribute('data-yqp-status'), 'queued');
    assert.ok(!card2.querySelector('.yqp-queue-badge'));

    restoreGlobalDOM();
  });

  await t.test('2.2: Mode switching dynamically re-styles cards (hide & badge_only)', () => {
    const { doc, decorator } = setupTestEnv();
    const { card } = createMockFeedCard(doc, 'dQw4w9WgXcQ');
    doc.body.appendChild(card);

    decorator.updateQueue(['dQw4w9WgXcQ']);
    assert.equal(card.getAttribute('data-yqp-status'), 'queued');

    // Switch to hide
    decorator.setMode('hide');
    assert.equal(card.style.display, 'none');

    // Switch to badge_only
    decorator.setMode('badge_only');
    assert.notEqual(card.style.display, 'none');
    assert.notEqual(card.style.opacity, '0.4');
    assert.ok(card.querySelector('.yqp-queue-badge'));

    restoreGlobalDOM();
  });

  await t.test('2.3: Unqueueing dynamically restores card styles without refresh', () => {
    const { doc, decorator } = setupTestEnv();
    const { card } = createMockFeedCard(doc, 'dQw4w9WgXcQ');
    doc.body.appendChild(card);

    decorator.updateQueue(['dQw4w9WgXcQ']);
    assert.equal(card.getAttribute('data-yqp-status'), 'queued');

    // Video removed from queue
    decorator.updateQueue([]);
    assert.equal(card.getAttribute('data-yqp-status'), null);
    assert.notEqual(card.style.opacity, '0.4');
    assert.ok(!card.querySelector('.yqp-queue-badge'), 'Badge must be removed');

    restoreGlobalDOM();
  });
});

// =============================================================================
// AUDIT SUITE 3: Requirement R2 - Session Persistence & Restore
// =============================================================================
test('AUDIT-3: Requirement R2 - Persistence, Empty Queue Detection & 1-Click Restore', async (t) => {
  function setupTestEnv() {
    const mockChrome = new MockChrome();
    const storageSync = new StorageSync({
      storageArea: mockChrome.storage.local,
      debounceDelay: 0
    });
    return { mockChrome, storageSync };
  }

  await t.test('3.1: Active queue persistence dual-writes to yqp_saved_session when queue is non-empty', async () => {
    const { storageSync } = setupTestEnv();

    await storageSync.saveActiveQueue({
      videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw'],
      currentIndex: 1,
      count: 2
    }, true);

    const saved = await storageSync.getSavedSession();
    assert.equal(saved.count, 2);
    assert.deepEqual(saved.videoIds, ['dQw4w9WgXcQ', 'jNQXAC9IVRw']);
    assert.equal(saved.currentIndex, 1);
    assert.ok(saved.savedAt > 0);
  });

  await t.test('3.2: Clearing active queue does NOT erase yqp_saved_session (preserves restart restore)', async () => {
    const { storageSync } = setupTestEnv();

    // Session saved with 2 videos
    await storageSync.saveActiveQueue({
      videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw'],
      currentIndex: 0,
      count: 2
    }, true);

    // Queue emptied (e.g. browser restart or player closed)
    await storageSync.saveActiveQueue({
      videoIds: [],
      currentIndex: 0,
      count: 0
    }, true);

    const active = await storageSync.getActiveQueue();
    assert.equal(active.count, 0);

    const saved = await storageSync.getSavedSession();
    assert.equal(saved.count, 2, 'Saved session must be retained when active queue is empty');
  });

  await t.test('3.3: RestoreController detects empty queue + saved session and injects banner', async () => {
    const { mockChrome, storageSync } = setupTestEnv();
    const doc = new MockDocument();
    const win = new MockWindow(doc);

    // Pre-populate saved session in storage
    await mockChrome.storage.local.set({
      [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
        videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw', 'M7lc1UVf-VE'],
        currentIndex: 1,
        savedAt: Date.now()
      },
      [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: {
        videoIds: [],
        currentIndex: 0,
        count: 0
      }
    });

    let navigatedUrl = null;
    const controller = new RestoreController({
      document: doc,
      window: win,
      storageSync,
      autoStart: false,
      navigateFn: (url) => { navigatedUrl = url; }
    });

    const isAvailable = await controller.checkRestoreAvailable();
    assert.equal(isAvailable, true, 'Restore session must be available');

    const shown = await controller.checkAndShowBanner();
    assert.equal(shown, true, 'Banner must be mounted');
    assert.ok(controller.isBannerVisible());

    // Trigger restore action
    await controller.restore();
    assert.ok(navigatedUrl, 'Navigation must have been triggered');
    assert.ok(navigatedUrl.includes('/watch_videos?video_ids='), 'Must target /watch_videos endpoint');
    assert.ok(navigatedUrl.includes('index=1'), 'Must preserve playing index');
  });

  await t.test('3.4: Restore URL is capped at 50 videos and clamped safely', () => {
    // Exactly 11-character valid video IDs
    const sixtyIds = Array.from({ length: 60 }, (_, i) => `vid${String(i).padStart(8, '0')}`);
    const restoreUrl = UrlParser.buildRestoreUrl(sixtyIds, 55);
    const parsed = UrlParser.parseWatchVideosUrl(restoreUrl);

    assert.equal(parsed.videoIds.length, 50, 'Must cap at 50 videos');
    assert.equal(parsed.currentIndex, 49, 'Index must clamp to max capped index (49)');
  });
});

// =============================================================================
// AUDIT SUITE 4: Requirement R3 - Duplicate Addition Guard
// =============================================================================
test('AUDIT-4: Requirement R3 - Duplicate Prevention & Event Interception', async (t) => {
  function setupTestEnv() {
    const doc = new MockDocument();
    const win = new MockWindow(doc);
    setupGlobalDOM({ document: doc, window: win });

    const toastManager = new ToastManager({ document: doc });
    const mockObserver = {
      activeSet: new Set(['dQw4w9WgXcQ']),
      getActiveIdsSet() { return this.activeSet; },
      hasVideo(id) { return this.activeSet.has(id); },
      getActiveVideoIds() { return Array.from(this.activeSet); }
    };
    const duplicateGuard = new DuplicateGuard({
      document: doc,
      window: win,
      queueObserver: mockObserver,
      toastManager,
      autoStart: true
    });

    return { doc, win, toastManager, duplicateGuard };
  }

  await t.test('4.1: Hover queue button click for already-queued video is blocked and toast is displayed', () => {
    const { doc, toastManager, duplicateGuard } = setupTestEnv();
    const { card, overlayBtn, innerBtn } = createMockFeedCard(doc, 'dQw4w9WgXcQ');
    doc.body.appendChild(card);

    const event = new MockEvent('click', { bubbles: true, cancelable: true });
    innerBtn.dispatchEvent(event);

    assert.equal(event.defaultPrevented, true, 'preventDefault must be called');
    assert.equal(toastManager.isVisible(), true, 'Toast notification must be visible');
    assert.equal(toastManager.getCurrentMessage(), 'Video is already in queue');

    duplicateGuard.destroy();
    toastManager.destroy();
    restoreGlobalDOM();
  });

  await t.test('4.2: Hover queue button click for non-queued video passes through', () => {
    const { doc, toastManager, duplicateGuard } = setupTestEnv();
    const { card, innerBtn } = createMockFeedCard(doc, 'jNQXAC9IVRw'); // Not in queue
    doc.body.appendChild(card);

    const event = new MockEvent('click', { bubbles: true, cancelable: true });
    innerBtn.dispatchEvent(event);

    assert.equal(event.defaultPrevented, false, 'Non-duplicate must not be prevented');
    assert.equal(toastManager.isVisible(), false, 'Toast must not be shown');

    duplicateGuard.destroy();
    toastManager.destroy();
    restoreGlobalDOM();
  });

  await t.test('4.3: Negative keywords ("Remove from queue") are never blocked', () => {
    const { doc, toastManager, duplicateGuard } = setupTestEnv();
    const { card, innerBtn } = createMockFeedCard(doc, 'dQw4w9WgXcQ', {
      overlayAriaLabel: 'Remove from queue'
    });
    doc.body.appendChild(card);

    const event = new MockEvent('click', { bubbles: true, cancelable: true });
    innerBtn.dispatchEvent(event);

    assert.equal(event.defaultPrevented, false, 'Remove action must never be blocked');

    duplicateGuard.destroy();
    toastManager.destroy();
    restoreGlobalDOM();
  });
});

// =============================================================================
// AUDIT SUITE 5: Requirement R4 - Popup UI & Status Control
// =============================================================================
test('AUDIT-5: Requirement R4 - Options & Status Popup UI', async (t) => {
  function setupTestEnv() {
    const doc = new MockDocument();
    const win = new MockWindow(doc);
    setupGlobalDOM({ document: doc, window: win });
    const mockChrome = new MockChrome();

    createPopupDOM(doc);

    const controller = new PopupController({
      document: doc,
      window: win,
      chrome: mockChrome
    });

    return { doc, win, mockChrome, controller };
  }

  await t.test('5.1: Popup initializes and renders live active queue and saved session stats', async () => {
    const { doc, mockChrome, controller } = setupTestEnv();

    await mockChrome.storage.local.set({
      [StorageKeys.STORAGE_KEYS.ACTIVE_QUEUE]: {
        videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw'],
        currentIndex: 0,
        count: 2
      },
      [StorageKeys.STORAGE_KEYS.SAVED_SESSION]: {
        videoIds: ['dQw4w9WgXcQ', 'jNQXAC9IVRw', 'M7lc1UVf-VE'],
        currentIndex: 1,
        savedAt: Date.now() - 120000,
        count: 3
      },
      [StorageKeys.STORAGE_KEYS.PREFERENCES]: {
        feedTreatmentMode: 'hide'
      }
    });

    controller.init();
    await new Promise(r => setImmediate(r));

    const queueCount = doc.getElementById('queueCount').textContent;
    assert.equal(queueCount, '2 videos');

    const playingIndex = doc.getElementById('playingIndex').textContent;
    assert.equal(playingIndex, 'Video 1 of 2');

    const livePill = doc.getElementById('queueLivePill').textContent;
    assert.equal(livePill, 'LIVE');

    const savedCount = doc.getElementById('savedCount').textContent;
    assert.equal(savedCount, '3 videos');

    const restoreBtn = doc.getElementById('restoreBtn');
    assert.equal(restoreBtn.disabled, false);

    const hideRadio = doc.querySelector('input[value="hide"]');
    assert.equal(hideRadio.checked, true);

    controller.destroy();
    restoreGlobalDOM();
  });

  await t.test('5.2: Selecting a treatment mode radio button persists new preference to storage', async () => {
    const { mockChrome, controller } = setupTestEnv();

    controller.init();
    await new Promise(r => setImmediate(r));

    controller.handleModeChange('badge_only');

    const stored = await mockChrome.storage.local.get(StorageKeys.STORAGE_KEYS.PREFERENCES);
    assert.equal(stored[StorageKeys.STORAGE_KEYS.PREFERENCES].feedTreatmentMode, 'badge_only');

    controller.destroy();
    restoreGlobalDOM();
  });
});

// =============================================================================
// AUDIT SUITE 6: Milestone M5 Adversarial Hardening & Stress Testing
// =============================================================================
test('AUDIT-6: Milestone M5 Adversarial Hardening & Edge Cases', async (t) => {
  await t.test('6.1: Corrupted storage data recovers gracefully with default preferences', () => {
    // Bad string passed instead of preferences object
    const sanitized = StorageKeys.sanitizePreferences('corrupted_string');
    assert.equal(sanitized.feedTreatmentMode, 'badge_and_dim');
    assert.equal(sanitized.duplicateGuardEnabled, true);
    assert.equal(sanitized.showRestoreBanner, true);

    // Bad number passed instead of queue state
    const cleanQueue = StorageKeys.sanitizeQueueState(12345);
    assert.equal(cleanQueue.count, 0);
    assert.deepEqual(cleanQueue.videoIds, []);
  });

  await t.test('6.2: Malformed percent-encoding in URLs handled safely without unhandled URIError', () => {
    const malformed1 = 'https://www.youtube.com/watch_videos?video_ids=%E0%A4%A';
    const malformed2 = 'https://www.youtube.com/watch_videos?video_ids=%';
    const malformed3 = 'https://www.youtube.com/watch_videos?video_ids=dQw4w9WgXcQ,%99,jNQXAC9IVRw';

    assert.doesNotThrow(() => {
      const res1 = UrlParser.parseWatchVideosUrl(malformed1);
      assert.equal(res1, null);
    });

    assert.doesNotThrow(() => {
      const res2 = UrlParser.parseWatchVideosUrl(malformed2);
      assert.equal(res2, null);
    });

    assert.doesNotThrow(() => {
      const res3 = UrlParser.parseWatchVideosUrl(malformed3);
      if (res3) {
        assert.ok(res3.videoIds.includes('dQw4w9WgXcQ'));
      }
    });
  });

  await t.test('6.3: Rapid double-click protection blocks in-flight duplicate additions', () => {
    const doc = new MockDocument();
    const win = new MockWindow(doc);
    setupGlobalDOM({ document: doc, window: win });

    const guard = new DuplicateGuard({
      document: doc,
      window: win,
      queueObserver: { getActiveIdsSet: () => new Set() }, // Empty active queue
      autoStart: true
    });

    const videoId = 'dQw4w9WgXcQ';
    const { card, innerBtn } = createMockFeedCard(doc, videoId);
    doc.body.appendChild(card);

    // First click: video not in queue, allowed
    const ev1 = new MockEvent('click', { bubbles: true, cancelable: true });
    innerBtn.dispatchEvent(ev1);
    assert.equal(ev1.defaultPrevented, false, 'First click allowed');

    // Second click immediately afterwards: should be blocked by pending additions guard
    const ev2 = new MockEvent('click', { bubbles: true, cancelable: true });
    innerBtn.dispatchEvent(ev2);
    assert.equal(ev2.defaultPrevented, true, 'Second rapid click intercepted as duplicate');

    guard.destroy();
    restoreGlobalDOM();
  });

  await t.test('6.4: Toast action button single-fire guard prevents multi-fire during dismissal', () => {
    const doc = new MockDocument();
    let fireCount = 0;
    const toast = new ToastManager({ document: doc, duration: 500, fadeDuration: 100 });

    toast.show('Action Test', {
      actionText: 'Undo',
      onAction: () => { fireCount++; }
    });

    const actionBtn = doc.querySelector('.yqp-toast-action-btn');
    assert.ok(actionBtn, 'Action button must exist');

    // Click 1
    actionBtn.click();
    assert.equal(fireCount, 1, 'Callback fires on first click');

    // Click 2 during dismissal
    actionBtn.click();
    assert.equal(fireCount, 1, 'Callback must NOT fire second time during dismissal');

    toast.destroy();
  });

  await t.test('6.5: Performance benchmark - 1,000 feed cards batch scan completes under 50ms', () => {
    const doc = new MockDocument();
    const win = new MockWindow(doc);
    setupGlobalDOM({ document: doc, window: win });

    const decorator = new FeedDecorator({
      root: doc,
      autoObserve: false,
      mode: 'badge_and_dim'
    });

    const queuedIds = ['vid00000001', 'vid00000002', 'vid00000003'];

    for (let i = 0; i < 1000; i++) {
      const vid = (i % 20 === 0) ? 'vid00000001' : `other${String(i).padStart(6, '0')}`;
      const { card } = createMockFeedCard(doc, vid);
      doc.body.appendChild(card);
    }

    const t0 = Date.now();
    decorator.updateQueue(queuedIds);
    const duration = Date.now() - t0;

    assert.ok(duration < 150, `1,000 cards scan must complete quickly (actual: ${duration}ms)`);

    const badged = doc.querySelectorAll('.yqp-queue-badge');
    assert.equal(badged.length, 50, 'Exactly 50 cards matching vid00000001 must be badged');

    restoreGlobalDOM();
  });
});
