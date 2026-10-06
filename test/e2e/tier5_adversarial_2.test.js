/**
 * YoutubeQueuePlus - Tier 5: Adversarial Coverage Hardening Suite 2
 * White-box adversarial stress tests targeting:
 * 1. PopupController: Rapid toggle fuzzing, tab query failures, corrupted storage objects
 * 2. UrlParser: Malformed video ID strings, URL injection attempts, non-ASCII query params
 * 3. StorageSync: Concurrent read/write race conditions, quota limits, storage serialization & error recovery
 *
 * Zero-dependency native Node.js test runner executable via:
 *   node test/e2e/tier5_adversarial_2.test.js
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Harnesses
const {
  MockDocument,
  MockWindow,
  createPopupDOM,
  setupGlobalDOM,
  restoreGlobalDOM
} = require('../harness/mock-dom');

const {
  MockChrome,
  setupGlobalChrome,
  restoreGlobalChrome
} = require('../harness/mock-chrome');

// Modules under test
const StorageKeysModule = require('../../src/shared/storage_keys');
const StorageKeys = StorageKeysModule.STORAGE_KEYS;
const UrlParser = require('../../src/utils/url_parser');
const StorageSync = require('../../src/modules/storage_sync');
const { PopupController, buildRestoreUrl, formatTimestamp } = require('../../popup/popup');

describe('Tier 5 Adversarial Coverage Hardening Suite 2', () => {
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
  // Section 1: PopupController Adversarial Hardening
  // ===========================================================================
  describe('1. PopupController Adversarial Hardening', () => {

    // --- 1.1 Rapid Toggle Fuzzing & Concurrency ---
    describe('1.1 Rapid Toggle Fuzzing & Concurrency', () => {
      test('1.1.1: Rapid toggle fuzzing (60 rapid sequential mode changes) executes without throw and leaves valid radio and storage state', () => {
        createPopupDOM(doc);
        const popup = new PopupController({ document: doc, window: win, chrome: mockChrome });
        popup.init();

        const modes = ['badge_and_dim', 'hide', 'badge_only'];
        for (let i = 0; i < 60; i++) {
          const mode = modes[i % modes.length];
          assert.doesNotThrow(() => {
            popup.handleModeChange(mode);
          });
        }

        // Final mode requested was modes[59 % 3] = modes[2] = 'badge_only'
        const expectedLastMode = modes[59 % modes.length];
        const stored = mockChrome.storage.local.store.get(StorageKeys.PREFERENCES);
        assert.ok(stored, 'Preferences should be stored');
        assert.equal(stored.feedTreatmentMode, expectedLastMode, 'Stored preference should match last toggle under synchronous storage');

        popup.destroy();
      });

      test('1.1.2: Asynchronous latency inversion in handleModeChange exposes read-modify-write race condition', async () => {
        createPopupDOM(doc);

        const popup = new PopupController({ document: doc, window: win, chrome: mockChrome });
        popup.init();

        // Inject out-of-order latency into chrome.storage.local.get AFTER init()
        const origGet = mockChrome.storage.local.get.bind(mockChrome.storage.local);
        let callCount = 0;
        mockChrome.storage.local.get = (keys, cb) => {
          const callId = callCount++;
          // First toggle call (badge_only) is delayed longer than second toggle call (hide)
          const delay = callId === 0 ? 50 : 5;
          setTimeout(() => {
            origGet(keys, cb);
          }, delay);
        };

        // User clicks 'badge_only', then immediately changes mind to 'hide'
        popup.handleModeChange('badge_only');
        popup.handleModeChange('hide');

        await new Promise(r => setTimeout(r, 90));

        const stored = mockChrome.storage.local.store.get(StorageKeys.PREFERENCES);
        // Due to lack of write serialization / request ID in handleModeChange,
        // the delayed 'badge_only' get completes last and clobbers 'hide'
        assert.ok(stored, 'Preferences should be stored');
        assert.equal(
          stored.feedTreatmentMode,
          'badge_only',
          'Vulnerability documented: Out-of-order async read-modify-write overwrote later user selection'
        );

        popup.destroy();
      });

      test('1.1.3: Fuzzing handleModeChange with unexpected or invalid mode values writes raw value to storage', () => {
        createPopupDOM(doc);
        const popup = new PopupController({ document: doc, window: win, chrome: mockChrome });
        popup.init();

        const invalidModes = ['unsupported_mode', '', '123_custom', 'undefined'];
        for (const badMode of invalidModes) {
          popup.handleModeChange(badMode);
          const stored = mockChrome.storage.local.store.get(StorageKeys.PREFERENCES);
          assert.equal(stored.feedTreatmentMode, badMode, 'Popup blindly writes invalid mode without validating against VALID_FEED_MODES');
        }

        popup.destroy();
      });
    });

    // --- 1.2 Tab Query Failures & Extreme Tab Navigation States ---
    describe('1.2 Tab Query Failures & Extreme Tab Navigation States', () => {
      test('1.2.1: Closed YouTube tab / empty tabs query ([]) falls back to tabs.create with restore URL and closes popup', () => {
        createPopupDOM(doc);
        let winClosed = false;
        const testWin = { close: () => { winClosed = true; } };

        // No active tabs in current window
        mockChrome.tabs._tabs = [];

        const popup = new PopupController({ document: doc, window: testWin, chrome: mockChrome });
        popup.currentSavedSession = { videoIds: ['dQw4w9WgXcQ'], currentIndex: 0 };

        popup.handleRestoreClick();

        assert.equal(mockChrome.tabs._tabs.length, 1, 'Should create 1 new tab as fallback');
        assert.ok(mockChrome.tabs._tabs[0].url.includes('watch_videos'), 'Created tab should point to /watch_videos');
        assert.ok(mockChrome.tabs._tabs[0].url.includes('dQw4w9WgXcQ'), 'Created tab should include session video ID');
        assert.equal(winClosed, true, 'Window close should be invoked after tab creation');

        popup.destroy();
      });

      test('1.2.2: Null or undefined tabs query result falls back gracefully to tabs.create without TypeError', () => {
        createPopupDOM(doc);
        let winClosed = false;
        const testWin = { close: () => { winClosed = true; } };

        // Simulate tabs.query returning null or undefined
        mockChrome.tabs.query = (queryInfo, cb) => {
          if (typeof cb === 'function') cb(null);
          return Promise.resolve(null);
        };

        const popup = new PopupController({ document: doc, window: testWin, chrome: mockChrome });
        popup.currentSavedSession = { videoIds: ['dQw4w9WgXcQ'], currentIndex: 0 };

        assert.doesNotThrow(() => {
          popup.handleRestoreClick();
        });

        assert.equal(mockChrome.tabs._tabs.length, 2, 'Fallback tabs.create should execute successfully');
        assert.equal(winClosed, true, 'Window should close after fallback');

        popup.destroy();
      });

      test('1.2.3: Active tab on non-YouTube domain (e.g. chrome://extensions) falls back to tabs.create instead of tabs.update', () => {
        createPopupDOM(doc);
        let winClosed = false;
        const testWin = { close: () => { winClosed = true; } };

        mockChrome.tabs._tabs = [
          { id: 999, url: 'chrome://extensions', active: true }
        ];

        let updateCalled = false;
        const origUpdate = mockChrome.tabs.update.bind(mockChrome.tabs);
        mockChrome.tabs.update = (tabId, props, cb) => {
          updateCalled = true;
          return origUpdate(tabId, props, cb);
        };

        const popup = new PopupController({ document: doc, window: testWin, chrome: mockChrome });
        popup.currentSavedSession = { videoIds: ['dQw4w9WgXcQ'], currentIndex: 0 };

        popup.handleRestoreClick();

        assert.equal(updateCalled, false, 'tabs.update must NOT be called on non-YouTube tabs');
        assert.equal(mockChrome.tabs._tabs.length, 2, 'Should create new tab instead of navigating chrome:// page');
        assert.ok(mockChrome.tabs._tabs[1].url.includes('youtube.com/watch_videos'));
        assert.equal(winClosed, true);

        popup.destroy();
      });

      test('1.2.4: Active tab with undefined url (permission boundary) falls back to tabs.create', () => {
        createPopupDOM(doc);
        const testWin = { close: () => {} };

        // In MV3 without host permission for a site, activeTab.url may be undefined
        mockChrome.tabs._tabs = [
          { id: 888, url: undefined, active: true }
        ];

        const popup = new PopupController({ document: doc, window: testWin, chrome: mockChrome });
        popup.currentSavedSession = { videoIds: ['dQw4w9WgXcQ'], currentIndex: 0 };

        popup.handleRestoreClick();

        assert.equal(mockChrome.tabs._tabs.length, 2, 'Should create a new tab when active tab url is undefined');
        assert.ok(mockChrome.tabs._tabs[1].url.includes('watch_videos'));

        popup.destroy();
      });

      test('1.2.5: Missing chrome.tabs API entirely falls back cleanly to window.open', () => {
        createPopupDOM(doc);
        let openedUrl = null;
        let windowOpened = false;
        const testWin = {
          open: (url, target) => {
            openedUrl = url;
            windowOpened = true;
          },
          close: () => {}
        };

        const chromeWithoutTabs = {
          storage: mockChrome.storage
        };

        const popup = new PopupController({ document: doc, window: testWin, chrome: chromeWithoutTabs });
        popup.currentSavedSession = { videoIds: ['dQw4w9WgXcQ'], currentIndex: 0 };

        popup.handleRestoreClick();

        assert.equal(windowOpened, true, 'window.open must be called when chrome.tabs is missing');
        assert.ok(openedUrl && openedUrl.includes('watch_videos'), 'window.open must receive the valid restore URL');

        popup.destroy();
      });

      test('1.2.6: Active tab closed immediately after query (tabs.update callback with runtime.lastError)', () => {
        createPopupDOM(doc);
        let winClosed = false;
        const testWin = { close: () => { winClosed = true; } };

        mockChrome.tabs._tabs = [
          { id: 101, url: 'https://www.youtube.com/feed/subscriptions', active: true }
        ];

        // Simulate tab closing right after query, so update encounters lastError
        mockChrome.tabs.update = (tabId, props, cb) => {
          if (mockChrome.runtime) {
            mockChrome.runtime.lastError = { message: `No tab with id: ${tabId}` };
          }
          if (typeof cb === 'function') cb(undefined);
          return Promise.resolve(undefined);
        };

        const popup = new PopupController({ document: doc, window: testWin, chrome: mockChrome });
        popup.currentSavedSession = { videoIds: ['dQw4w9WgXcQ'], currentIndex: 0 };

        assert.doesNotThrow(() => {
          popup.handleRestoreClick();
        });

        // Current popup implementation still invokes win.close() regardless of lastError
        assert.equal(winClosed, true, 'Callback invoked despite lastError');

        popup.destroy();
      });
    });

    // --- 1.3 Corrupted Storage Objects & Boundary Hardening ---
    describe('1.3 Corrupted Storage Objects & Boundary Hardening', () => {
      test('1.3.1: Corrupted yqp_preferences as primitive string ("invalid_string") in init() renders default mode without throw', () => {
        createPopupDOM(doc);
        mockChrome.storage.local.store.set(StorageKeys.PREFERENCES, 'invalid_string');

        const popup = new PopupController({ document: doc, window: win, chrome: mockChrome });
        assert.doesNotThrow(() => {
          popup.init();
        });

        const defaultRadio = doc.querySelector('input[name="feedTreatmentMode"][value="badge_and_dim"]');
        assert.equal(defaultRadio.checked, true, 'Default radio should remain checked when preferences is a string');

        popup.destroy();
      });

      test('1.3.2: Corrupted yqp_preferences as primitive string ("invalid_string") in handleModeChange handled defensively without throw', () => {
        createPopupDOM(doc);
        mockChrome.storage.local.store.set(StorageKeys.PREFERENCES, 'invalid_string');

        const popup = new PopupController({ document: doc, window: win, chrome: mockChrome });
        popup.init();

        assert.doesNotThrow(() => {
          popup.handleModeChange('hide');
        });

        const stored = mockChrome.storage.local.store.get(StorageKeys.PREFERENCES);
        assert.ok(stored && typeof stored === 'object');
        assert.equal(stored.feedTreatmentMode, 'hide');

        popup.destroy();
      });

      test('1.3.3: Corrupted yqp_preferences with truthy non-objects safely fall back to new object without throw', () => {
        const truthyPrimitives = [42, true];
        for (const badPref of truthyPrimitives) {
          const testDoc = new MockDocument();
          const testChrome = new MockChrome();
          createPopupDOM(testDoc);
          testChrome.storage.local.store.set(StorageKeys.PREFERENCES, badPref);

          const popup = new PopupController({ document: testDoc, window: win, chrome: testChrome });
          popup.init();

          assert.doesNotThrow(() => {
            popup.handleModeChange('hide');
          });

          const stored = testChrome.storage.local.store.get(StorageKeys.PREFERENCES);
          assert.ok(stored && typeof stored === 'object');
          assert.equal(stored.feedTreatmentMode, 'hide');

          popup.destroy();
        }

        // Falsy values (false, 0, null, "") fall back to {} via `|| {}` and do NOT throw
        const falsyValues = [false, 0, '', null];
        for (const falsyVal of falsyValues) {
          const testDoc = new MockDocument();
          const testChrome = new MockChrome();
          createPopupDOM(testDoc);
          testChrome.storage.local.store.set(StorageKeys.PREFERENCES, falsyVal);

          const popup = new PopupController({ document: testDoc, window: win, chrome: testChrome });
          popup.init();

          assert.doesNotThrow(() => {
            popup.handleModeChange('hide');
          }, `Falsy value ${falsyVal} falls back to {} without throwing`);

          popup.destroy();
        }
      });

      test('1.3.4: Corrupted yqp_active_queue with negative count, NaN currentIndex, and malformed videoIds', () => {
        createPopupDOM(doc);
        const popup = new PopupController({ document: doc, window: win, chrome: mockChrome });
        popup.init();

        // Test 1: NaN currentIndex
        popup.updateActiveQueueCard({
          videoIds: ['dQw4w9WgXcQ'],
          currentIndex: NaN
        });
        const playingEl = doc.getElementById('playingIndex');
        // Math.min(NaN + 1, 1) produces NaN in JS
        assert.equal(playingEl.textContent, 'Video NaN of 1', 'Vulnerability documented: NaN currentIndex is not clamped and displays Video NaN');

        // Test 2: Negative count
        popup.updateActiveQueueCard({
          videoIds: null,
          count: -5
        });
        const countEl = doc.getElementById('queueCount');
        assert.equal(countEl.textContent, '-5 videos', 'Vulnerability documented: Negative count is not clamped to >= 0');

        popup.destroy();
      });

      test('1.3.5: Corrupted yqp_saved_session with non-array videoIds: restore button disabled or fail-open without unhandled crash', () => {
        createPopupDOM(doc);
        const popup = new PopupController({ document: doc, window: win, chrome: mockChrome });
        popup.init();

        // Non-array videoIds with count = 5
        popup.updateSavedSessionCard({
          videoIds: 'invalid_not_array',
          count: 5
        });

        const restoreBtn = doc.getElementById('restoreBtn');
        assert.equal(restoreBtn.disabled, false, 'Button is enabled because count > 0');

        // Clicking restore should fail-open safely without crashing
        assert.doesNotThrow(() => {
          popup.handleRestoreClick();
        });

        popup.destroy();
      });

      test('1.3.6: Malicious CSS selector injection in preferences.feedTreatmentMode does not crash DOM querySelector', () => {
        createPopupDOM(doc);
        const popup = new PopupController({ document: doc, window: win, chrome: mockChrome });
        popup.init();

        // Adversarial string attempting CSS attribute selector breakout
        const maliciousMode = 'badge_and_dim"][value="injected';
        assert.doesNotThrow(() => {
          popup.updatePreferencesUI({ feedTreatmentMode: maliciousMode });
        });

        popup.destroy();
      });

      test('1.3.7: formatTimestamp boundary fuzzing with Infinity, -Infinity, NaN, negative, and future timestamps', () => {
        assert.equal(formatTimestamp(null), 'None');
        assert.equal(formatTimestamp(undefined), 'None');
        assert.equal(formatTimestamp(0), 'None');
        assert.equal(formatTimestamp(-1000), 'None');
        assert.equal(formatTimestamp(NaN), 'None');
        assert.equal(formatTimestamp('invalid'), 'None');
        assert.equal(formatTimestamp(Date.now() + 100000), 'Just now', 'Future timestamps return Just now');
        assert.equal(formatTimestamp(Date.now() - 30000), 'Just now', 'Recent timestamps (< 1m) return Just now');
        assert.equal(formatTimestamp(Date.now() - 5 * 60 * 1000), '5m ago', 'Minutes format');
        assert.equal(formatTimestamp(Date.now() - 3 * 3600 * 1000), '3h ago', 'Hours format');
        assert.equal(formatTimestamp(Infinity), 'Just now', 'Infinity yields Just now');
        assert.equal(formatTimestamp(-Infinity), 'None', '-Infinity yields None');
      });
    });
  });

  // ===========================================================================
  // Section 2: UrlParser Adversarial Fuzzing & Injection Defense
  // ===========================================================================
  describe('2. UrlParser Adversarial Fuzzing & Injection Defense', () => {

    // --- 2.1 Non-ASCII and Unicode Query Parameters ---
    describe('2.1 Non-ASCII and Unicode Query Parameters', () => {
      test('2.1.1: Non-ASCII and multi-byte UTF-8 parameters in watch URLs extract clean 11-char video ID', () => {
        const testUrls = [
          'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=日本語リスト',
          'https://www.youtube.com/watch?v=dQw4w9WgXcQ&author=東京チャンネル&t=30s',
          'https://www.youtube.com/watch?v=dQw4w9WgXcQ&q=РусскийЗапрос',
          'https://www.youtube.com/watch?v=dQw4w9WgXcQ&tag=العربية',
          'https://www.youtube.com/watch?v=dQw4w9WgXcQ&desc=🎉🔥✨'
        ];

        for (const url of testUrls) {
          const id = UrlParser.extractVideoId(url);
          assert.equal(id, 'dQw4w9WgXcQ', `Failed to extract ID from URL with non-ASCII param: ${url}`);
        }
      });

      test('2.1.2: Fullwidth and homoglyph Unicode characters in candidate ID are strictly rejected', () => {
        // Fullwidth Latin characters resembling 'dQw4w9WgXcQ'
        const fullwidthId = '\uFF44\uFF31\uFF57\uFF14\uFF57\uFF19\uFF37\uFF47\uFF38\uFF43\uFF31';
        assert.equal(UrlParser.isValidVideoId(fullwidthId), false);
        assert.equal(UrlParser.extractVideoId(fullwidthId), null);
        assert.equal(UrlParser.extractVideoId(`https://www.youtube.com/watch?v=${fullwidthId}`), null);
      });

      test('2.1.3: Zero-width spaces, embedded BOM, and emoji in candidate ID strings are strictly rejected', () => {
        const zeroWidthMiddleId = 'dQw4\u200Bw9WgXcQ'; // Zero-width space embedded in middle
        const embeddedBomId = 'dQw4\uFEFFw9WgXcQ'; // BOM embedded in middle
        const emojiId = 'dQw4w9WgX🐱Q';

        // Embedded zero-width and emojis break the 11-char [a-zA-Z0-9_-] regex
        assert.equal(UrlParser.isValidVideoId(zeroWidthMiddleId), false);
        assert.equal(UrlParser.isValidVideoId(embeddedBomId), false);
        assert.equal(UrlParser.isValidVideoId(emojiId), false);

        assert.equal(UrlParser.extractVideoId(zeroWidthMiddleId), null);
        assert.equal(UrlParser.extractVideoId(embeddedBomId), null);
        assert.equal(UrlParser.extractVideoId(`https://www.youtube.com/watch?v=${emojiId}`), null);

        // Documenting JavaScript trim() quirk:
        // Leading BOM is stripped by String.prototype.trim(), making '\uFEFFdQw4w9WgXcQ' valid after trim
        const leadingBomId = '\uFEFFdQw4w9WgXcQ';
        assert.equal(UrlParser.isValidVideoId(leadingBomId), true, 'JavaScript built-in trim() strips leading BOM');
      });
    });

    // --- 2.2 Injection Attempts & Path Traversal ---
    describe('2.2 Injection Attempts & Path Traversal', () => {
      test('2.2.1: XSS payload injections in URLs are strictly rejected or stripped', () => {
        const xssInputs = [
          'https://www.youtube.com/watch?v=<script>alert(1)</script>',
          'https://www.youtube.com/watch?v=dQw4w9WgXcQ<script>',
          'https://www.youtube.com/watch?v=dQw4w9WgXcQ" onfocus="alert(1)',
          'https://www.youtube.com/watch?v=dQw4w9WgXcQ\'><script>alert(1)</script>',
          '<svg onload=alert(1)>'
        ];

        for (const input of xssInputs) {
          const id = UrlParser.extractVideoId(input);
          // If extracted, it MUST NOT contain any HTML/script injection tags
          if (id !== null) {
            assert.match(id, /^[a-zA-Z0-9_-]{11}$/, `Extracted ID must be clean 11-char string, got: ${id}`);
          }
        }
      });

      test('2.2.2: Protocol injection and pseudo-protocols (javascript:, data:, blob:) behavior in extractVideoId', () => {
        // extractVideoId regex searches for /[?&]v=([a-zA-Z0-9_-]{11})(?:[&#]|$)/ regardless of protocol
        const jsUrl = 'javascript:alert(1)?v=dQw4w9WgXcQ';
        const dataUrlDirect = 'data:text/html,?v=dQw4w9WgXcQ';
        const blobUrl = 'blob:https://evil.com/uuid?v=dQw4w9WgXcQ';

        // Documenting behavior: extractVideoId extracts 11-char ID pattern even from pseudo-protocols
        assert.equal(UrlParser.extractVideoId(jsUrl), 'dQw4w9WgXcQ');
        assert.equal(UrlParser.extractVideoId(dataUrlDirect), 'dQw4w9WgXcQ');
        assert.equal(UrlParser.extractVideoId(blobUrl), 'dQw4w9WgXcQ');

        // If the ID is followed by HTML quotes or attribute brackets, regex boundary (?:[&#]|$) rejects it
        const htmlAttrUrl = 'data:text/html,<a href="?v=dQw4w9WgXcQ">';
        assert.equal(UrlParser.extractVideoId(htmlAttrUrl), null, 'Trailing double quote is not [&#]|$ so it is safely rejected');
      });

      test('2.2.3: CRLF and null-byte injection attempts in candidate ID strings are rejected', () => {
        const crlfId = 'dQw4w9W\r\ngXcQ';
        const nullByteId = 'dQw4w9W\0gXcQ';
        const percentNull = 'https://www.youtube.com/watch?v=dQw4w9W%00gXcQ';

        assert.equal(UrlParser.isValidVideoId(crlfId), false);
        assert.equal(UrlParser.isValidVideoId(nullByteId), false);
        assert.equal(UrlParser.extractVideoId(crlfId), null);
        assert.equal(UrlParser.extractVideoId(nullByteId), null);
        assert.equal(UrlParser.extractVideoId(percentNull), null);
      });

      test('2.2.4: HTTP Parameter Pollution (HPP) with multiple v= parameters extracts first valid match', () => {
        const hppUrl = 'https://www.youtube.com/watch?v=first11char&v=second11cha';
        const extracted = UrlParser.extractVideoId(hppUrl);
        assert.equal(extracted, 'first11char', 'Should deterministically extract the first v= match');

        const hppEmptyFirst = 'https://www.youtube.com/watch?v=&v=second11cha';
        const extractedSecond = UrlParser.extractVideoId(hppEmptyFirst);
        assert.equal(extractedSecond, 'second11cha', 'When first v= is empty, should extract the valid second parameter');
      });

      test('2.2.5: SQL injection and path traversal syntax in URLs', () => {
        const sqlInjection = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ\' OR \'1\'=\'1';
        assert.equal(UrlParser.extractVideoId(sqlInjection), null, 'SQL injection appendage breaks 11-char boundary');

        const pathTraversal = 'https://www.youtube.com/watch?v=../../../../etc/passwd';
        assert.equal(UrlParser.extractVideoId(pathTraversal), null, 'Path traversal syntax is rejected');
      });
    });

    // --- 2.3 Malformed Video IDs & Format Boundaries ---
    describe('2.3 Malformed Video IDs & Format Boundaries', () => {
      test('2.3.1: Video ID length boundary fuzzing (0 to 30 characters) accepts only exactly 11 characters', () => {
        for (let len = 0; len <= 30; len++) {
          const candidate = 'a'.repeat(len);
          const isValid = UrlParser.isValidVideoId(candidate);
          if (len === 11) {
            assert.equal(isValid, true, 'Length 11 should be valid');
          } else {
            assert.equal(isValid, false, `Length ${len} should be invalid`);
          }
        }
      });

      test('2.3.2: Malformed URL formats (truncated query, invalid host, missing scheme)', () => {
        assert.equal(UrlParser.extractVideoId('?v='), null);
        assert.equal(UrlParser.extractVideoId('?v=short'), null);
        assert.equal(UrlParser.extractVideoId('https://'), null);
        assert.equal(UrlParser.extractVideoId('not_a_url_at_all'), null);
        assert.equal(UrlParser.extractVideoId(null), null);
        assert.equal(UrlParser.extractVideoId(undefined), null);
        assert.equal(UrlParser.extractVideoId(12345678901), null);
        assert.equal(UrlParser.extractVideoId({}), null);
        assert.equal(UrlParser.extractVideoId([]), null);
      });

      test('2.3.3: Shorts, Embeds, Shortlinks, Live URLs with complex query strings and hashes', () => {
        const testCases = [
          { url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share&t=10', expected: 'dQw4w9WgXcQ' },
          { url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ#comments', expected: 'dQw4w9WgXcQ' },
          { url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ/', expected: 'dQw4w9WgXcQ' },
          { url: 'https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&mute=1', expected: 'dQw4w9WgXcQ' },
          { url: 'https://youtu.be/dQw4w9WgXcQ?t=42s#target', expected: 'dQw4w9WgXcQ' },
          { url: 'https://www.youtube.com/live/dQw4w9WgXcQ?feature=share', expected: 'dQw4w9WgXcQ' }
        ];

        for (const { url, expected } of testCases) {
          assert.equal(UrlParser.extractVideoId(url), expected, `Failed for URL: ${url}`);
        }
      });
    });

    // --- 2.4 Restore URL Builder & Parser Robustness ---
    describe('2.4 Restore URL Builder & Parser Robustness', () => {
      test('2.4.1: Malformed percent-encoded sequences in parseWatchVideosUrl handled safely without URIError throw', () => {
        const malformedUrls = [
          'https://www.youtube.com/watch_videos?video_ids=%',
          'https://www.youtube.com/watch_videos?video_ids=%E0%A4%A',
          'https://www.youtube.com/watch_videos?video_ids=%%%'
        ];

        for (const badUrl of malformedUrls) {
          assert.doesNotThrow(() => {
            const parsed = UrlParser.parseWatchVideosUrl(badUrl);
            assert.equal(parsed, null, `Malformed URL ${badUrl} safely returns null`);
          });
        }
      });

      test('2.4.2: Extremely large array fuzzing in buildRestoreUrl (10,000 video IDs) capped at 50 without degradation', () => {
        const largeList = [];
        for (let i = 0; i < 10000; i++) {
          largeList.push('vid_' + String(i).padStart(7, '0'));
        }

        const start = Date.now();
        const url = UrlParser.buildRestoreUrl(largeList, 25);
        const elapsed = Date.now() - start;

        assert.ok(elapsed < 100, `buildRestoreUrl took too long: ${elapsed}ms`);
        assert.ok(url !== null, 'URL should be generated');

        const parsed = UrlParser.parseWatchVideosUrl(url);
        assert.equal(parsed.videoIds.length, 50, 'Must strictly cap at 50 videos');
        assert.equal(parsed.currentIndex, 25, 'Current index clamped accurately');
      });

      test('2.4.3: Index clamping boundaries (-Infinity, Infinity, NaN, null, floats) in buildRestoreUrl', () => {
        const ids = ['dQw4w9WgXcQ', 'anotherVid1', 'thirdVid111'];

        // Negative index
        assert.ok(UrlParser.buildRestoreUrl(ids, -10).includes('&index=0'));

        // -Infinity
        assert.ok(UrlParser.buildRestoreUrl(ids, -Infinity).includes('&index=0'));

        // Infinity (clamped to length - 1 = 2)
        assert.ok(UrlParser.buildRestoreUrl(ids, Infinity).includes('&index=2'));

        // Beyond length
        assert.ok(UrlParser.buildRestoreUrl(ids, 100).includes('&index=2'));

        // NaN
        assert.ok(UrlParser.buildRestoreUrl(ids, NaN).includes('&index=0'));

        // null / undefined
        assert.ok(UrlParser.buildRestoreUrl(ids, null).includes('&index=0'));
        assert.ok(UrlParser.buildRestoreUrl(ids, undefined).includes('&index=0'));

        // Floating point (2.9 clamped/floored to 2)
        assert.ok(UrlParser.buildRestoreUrl(ids, 2.9).includes('&index=2'));
      });

      test('2.4.4: buildWatchUrl fuzzing with null/non-object extraParams and special characters', () => {
        // Vulnerability reproduction:
        // buildWatchUrl does `for (const [k, v] of Object.entries(extraParams))`
        // When extraParams is null, Object.entries(null) throws TypeError!
        assert.throws(
          () => {
            UrlParser.buildWatchUrl('dQw4w9WgXcQ', null);
          },
          {
            name: 'TypeError',
            message: /Cannot convert undefined or null to object/
          },
          'Empirically reproduced: buildWatchUrl throws TypeError when extraParams is null'
        );

        // Valid extraParams with non-ASCII and injection strings
        const encodedUrl = UrlParser.buildWatchUrl('dQw4w9WgXcQ', {
          q: '日本語',
          '<script>': '</script>',
          tag: 'value&bad=1'
        });

        assert.ok(encodedUrl.includes('%E6%97%A5%E6%9C%AC%E8%AA%9E'), 'Non-ASCII params must be percent-encoded');
        assert.ok(encodedUrl.includes('%3Cscript%3E'), 'Key tags must be percent-encoded');
        assert.ok(encodedUrl.includes('%26bad%3D1'), 'Ampersands must be percent-encoded');
      });
    });
  });

  // ===========================================================================
  // Section 3: StorageSync Concurrency & Fault Recovery Hardening
  // ===========================================================================
  describe('3. StorageSync Concurrency & Fault Recovery Hardening', () => {

    // --- 3.1 Concurrent Read/Write Race Conditions & Debounce Behavior ---
    describe('3.1 Concurrent Read/Write Race Conditions & Debounce Behavior', () => {
      test('3.1.1: Rapid sequential saveActiveQueue burst (50 writes in 10ms) settles to final queue state', async () => {
        const sync = new StorageSync({
          storageArea: mockChrome.storage.local,
          debounceDelay: 30
        });

        for (let i = 0; i < 50; i++) {
          const id = 'vid_' + String(i).padStart(7, '0');
          sync.saveActiveQueue({
            videoIds: [id],
            currentIndex: 0,
            count: 1
          });
        }

        // Wait for debounce timer to fire
        await new Promise(r => setTimeout(r, 60));

        const stored = mockChrome.storage.local.store.get(StorageKeys.ACTIVE_QUEUE);
        assert.ok(stored, 'Active queue should be written');
        assert.equal(stored.videoIds[0], 'vid_0000049', 'Final saved state must match the 50th queue state');

        sync.destroy();
      });

      test('3.1.2: Debounce Promise lifecycle settles all pending promises when debounced write commits', async () => {
        const sync = new StorageSync({
          storageArea: mockChrome.storage.local,
          debounceDelay: 40
        });

        let p1Settled = false;
        let p2Settled = false;

        const p1 = sync.saveActiveQueue({ videoIds: ['vid_0000001'] }).then(() => { p1Settled = true; });
        const p2 = sync.saveActiveQueue({ videoIds: ['vid_0000002'] }).then(() => { p2Settled = true; });

        await new Promise(r => setTimeout(r, 80));

        assert.equal(p1Settled, true, 'p1 promise settles cleanly when batch commits');
        assert.equal(p2Settled, true, 'p2 promise settles successfully');

        sync.destroy();
      });

      test('3.1.3: Immediate flush() during pending debounce timer commits state and resolves debounce promises', async () => {
        const sync = new StorageSync({
          storageArea: mockChrome.storage.local,
          debounceDelay: 50
        });

        let debouncedSettled = false;
        const debouncedPromise = sync.saveActiveQueue({ videoIds: ['vid_flush01'] }).then(() => { debouncedSettled = true; });

        // Immediate flush
        await sync.flush();

        const stored = mockChrome.storage.local.store.get(StorageKeys.ACTIVE_QUEUE);
        assert.equal(stored.videoIds[0], 'vid_flush01', 'State must be immediately committed to storage by flush()');

        await new Promise(r => setTimeout(r, 70));
        assert.equal(debouncedSettled, true, 'flush() resolves pending debounce promise cleanly');

        sync.destroy();
      });

      test('3.1.4: Concurrent setPreferences read-modify-write interleaving can lose updates', async () => {
        const sync = new StorageSync({
          storageArea: mockChrome.storage.local,
          debounceDelay: 0
        });

        // Initialize defaults
        await sync.initPreferences();

        // Simulate two concurrent updates in flight
        const p1 = sync.setPreferences({ feedTreatmentMode: 'hide' });
        const p2 = sync.setPreferences({ duplicateGuardEnabled: false });

        await Promise.all([p1, p2]);

        const finalPrefs = await sync.getPreferences();
        assert.equal(finalPrefs.duplicateGuardEnabled, false);
        // Note: Because both read cached/current preferences asynchronously before set,
        // feedTreatmentMode might be preserved or lost depending on interleaving
        assert.ok(['hide', 'badge_and_dim'].includes(finalPrefs.feedTreatmentMode));

        sync.destroy();
      });
    });

    // --- 3.2 Quota Limits & Storage Fault Recovery ---
    describe('3.2 Quota Limits & Storage Fault Recovery', () => {
      test('3.2.1: Storage write failure (QuotaExceededError) triggers onError listener notification', async () => {
        const sync = new StorageSync({
          storageArea: mockChrome.storage.local,
          debounceDelay: 0
        });

        let errorReported = null;
        let operationReported = null;

        sync.onError((err, op) => {
          errorReported = err;
          operationReported = op;
        });

        // Inject quota exceeded error on next set
        mockChrome.storage.local._failNextSet(new Error('QuotaExceededError: storage quota exceeded'));

        await assert.rejects(
          async () => {
            await sync.saveSavedSession({ videoIds: ['dQw4w9WgXcQ'], currentIndex: 0 });
          },
          /QuotaExceededError/
        );

        assert.ok(errorReported, 'Error listener must be called');
        assert.equal(operationReported, 'set', 'Operation should be reported as set');
        assert.match(errorReported.message, /QuotaExceededError/);

        sync.destroy();
      });

      test('3.2.2: Error listener isolation: throwing error listener does not prevent subsequent listeners from executing', async () => {
        const sync = new StorageSync({
          storageArea: mockChrome.storage.local,
          debounceDelay: 0
        });

        let secondListenerExecuted = false;

        // Listener 1 throws
        sync.onError(() => {
          throw new Error('Exploding error listener');
        });

        // Listener 2 should still run
        sync.onError(() => {
          secondListenerExecuted = true;
        });

        mockChrome.storage.local._failNextSet(new Error('Disk error'));

        try {
          await sync.saveSavedSession({ videoIds: ['dQw4w9WgXcQ'], currentIndex: 0 });
        } catch (_) {}

        assert.equal(secondListenerExecuted, true, 'Subsequent error listeners must still be executed despite previous throw');

        sync.destroy();
      });

      test('3.2.3: Write failure diff cache rollback: failed write does not commit signature and retry succeeds', async () => {
        const sync = new StorageSync({
          storageArea: mockChrome.storage.local,
          debounceDelay: 0
        });

        const testState = { videoIds: ['vid_diff_01'], currentIndex: 0, count: 1 };

        // Inject failure on next write
        mockChrome.storage.local._failNextSet(new Error('Simulated write failure'));

        // First attempt fails
        await sync.saveActiveQueue(testState, true);

        const inStoreAfterFail = mockChrome.storage.local.store.get(StorageKeys.ACTIVE_QUEUE);
        assert.equal(inStoreAfterFail, undefined, 'Nothing was written to storage');

        // Retry saving the EXACT same state
        const retryResult = await sync.saveActiveQueue(testState, true);

        // HARDENED VERIFICATION:
        // Because _executePendingActiveQueueSave sets _lastActiveQueueSignature ONLY AFTER successful write,
        // retry succeeds and data is safely committed to storage!
        assert.equal(
          retryResult,
          true,
          'Retry succeeds because diff signature was preserved upon failure'
        );

        const inStoreAfterRetry = mockChrome.storage.local.store.get(StorageKeys.ACTIVE_QUEUE);
        assert.ok(inStoreAfterRetry, 'Storage receives state on retry');
        assert.deepEqual(inStoreAfterRetry.videoIds, ['vid_diff_01']);

        sync.destroy();
      });

      test('3.2.4: Storage read failure (corrupt disk) falls back to safe initial defaults', async () => {
        const sync = new StorageSync({
          storageArea: mockChrome.storage.local,
          debounceDelay: 0
        });

        mockChrome.storage.local._failNextGet(new Error('Disk corruption'));

        const activeQueue = await sync.getActiveQueue();
        assert.deepEqual(activeQueue.videoIds, [], 'getActiveQueue falls back to empty videoIds');
        assert.equal(activeQueue.count, 0, 'Count defaults to 0');

        mockChrome.storage.local._failNextGet(new Error('Disk corruption'));
        const savedSession = await sync.getSavedSession();
        assert.deepEqual(savedSession.videoIds, [], 'getSavedSession falls back to empty videoIds');

        mockChrome.storage.local._failNextGet(new Error('Disk corruption'));
        const prefs = await sync.getPreferences();
        assert.equal(prefs.feedTreatmentMode, 'badge_and_dim', 'getPreferences falls back to default mode');

        sync.destroy();
      });
    });

    // --- 3.3 Corrupted Storage Payloads & Deserialization Safety ---
    describe('3.3 Corrupted Storage Payloads & Deserialization Safety', () => {
      test('3.3.1: getActiveQueue with corrupted primitive storage values safely falls back to initial state', async () => {
        const sync = new StorageSync({
          storageArea: mockChrome.storage.local,
          debounceDelay: 0
        });

        const badValues = ['corrupt_string', 12345, true, null, [1, 2, 3]];
        for (const bad of badValues) {
          mockChrome.storage.local.store.set(StorageKeys.ACTIVE_QUEUE, bad);
          const state = await sync.getActiveQueue();
          assert.deepEqual(state.videoIds, [], `Bad value ${typeof bad} must fall back to empty videoIds`);
          assert.equal(state.count, 0);
          assert.equal(state.currentIndex, 0);
        }

        sync.destroy();
      });

      test('3.3.2: Cross-tab onChanged event dispatch with corrupted payload shapes emits sanitized structures', async () => {
        const sync = new StorageSync({
          storageArea: mockChrome.storage.local,
          storageOnChanged: mockChrome.storage.onChanged
        });

        let emittedQueue = null;
        let emittedPrefs = null;

        sync.onQueueChanged((queue) => {
          emittedQueue = queue;
        });

        sync.onPreferencesChanged((prefs) => {
          emittedPrefs = prefs;
        });

        // Trigger onChanged with corrupted payload shapes
        mockChrome.storage.onChanged.trigger({
          [StorageKeys.ACTIVE_QUEUE]: {
            newValue: 'completely_corrupt_payload_string',
            oldValue: null
          },
          [StorageKeys.PREFERENCES]: {
            newValue: 42,
            oldValue: null
          }
        }, 'local');

        assert.ok(emittedQueue, 'Queue subscriber must receive sanitized object');
        assert.deepEqual(emittedQueue.videoIds, [], 'Emitted queue must have array videoIds');
        assert.equal(emittedQueue.count, 0);

        assert.ok(emittedPrefs, 'Preferences subscriber must receive sanitized object');
        assert.equal(emittedPrefs.feedTreatmentMode, 'badge_and_dim', 'Emitted preferences must fall back to valid mode');

        sync.destroy();
      });

      test('3.3.3: Storage remove events for saved_session and active_queue emit safe clean states', () => {
        const sync = new StorageSync({
          storageArea: mockChrome.storage.local,
          storageOnChanged: mockChrome.storage.onChanged
        });

        let sessionEmitted = undefined;
        let queueEmitted = undefined;

        sync.onSavedSessionChanged((session) => {
          sessionEmitted = session;
        });

        sync.onQueueChanged((queue) => {
          queueEmitted = queue;
        });

        // Trigger removal changes (newValue is undefined)
        mockChrome.storage.onChanged.trigger({
          [StorageKeys.SAVED_SESSION]: {
            newValue: undefined,
            oldValue: { videoIds: ['dQw4w9WgXcQ'] }
          },
          [StorageKeys.ACTIVE_QUEUE]: {
            newValue: undefined,
            oldValue: { videoIds: ['dQw4w9WgXcQ'] }
          }
        }, 'local');

        assert.equal(sessionEmitted, null, 'Saved session remove emits null');
        assert.deepEqual(queueEmitted.videoIds, [], 'Active queue remove emits empty sanitized queue');

        sync.destroy();
      });
    });
  });
});
