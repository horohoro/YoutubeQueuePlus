# Project: YoutubeQueuePlus

## Architecture
YoutubeQueuePlus is a Manifest V3, Vanilla JavaScript Chrome extension that augments YouTube's native temporary queue and playlist player without replacing it.

### System Components & Data Flow
1. **Manifest & Extension Boundary** (`manifest.json`, `src/background/service_worker.js`):
   - Strict Manifest V3 conformance.
   - Minimal permissions: `"storage"` only. Host permissions: `["*://*.youtube.com/*"]`.
   - Zero compile/build steps; runs directly unpacked.
   - Zero external 3rd-party network requests or telemetry.
   - Service worker maintains action badge text based on active queue count.

2. **Isolated World Content Scripts** (Loaded in strict order via `manifest.json`):
   - `src/shared/constants.js` & `src/shared/storage_keys.js`: Selectors, event types, storage keys.
   - `src/utils/dom_helpers.js`: Safe querying, debounce, attribute helpers.
   - `src/utils/url_parser.js`: Video ID extraction (`/[?&]v=([a-zA-Z0-9_-]{11})/`), `/watch_videos` URL builder.
   - `src/modules/storage_sync.js`: Debounced (300ms) writes to `chrome.storage.local`, in-memory diffing, cross-tab sync.
   - `src/modules/queue_observer.js`: MutationObserver on `ytd-playlist-panel-renderer` (watch page and miniplayer), emits queue state.
   - `src/modules/feed_decorator.js`: Decorates `ytd-rich-item-renderer`, `ytd-video-renderer`, `ytd-compact-video-renderer` with QUEUED badge and dimming/hiding based on mode (`badge_and_dim`, `hide`, `badge_only`).
   - `src/modules/toast_manager.js`: Non-intrusive native YouTube-styled snackbar toast for duplicate blocked notices.
   - `src/modules/duplicate_guard.js`: Capturing-phase event listener (`document.addEventListener('click', handler, true)`) intercepting hover overlay button and 3-dot menu "Add to queue" actions when video is already queued.
   - `src/modules/restore_controller.js`: Detects empty native queue with non-empty saved session, injects restore banner, and triggers navigation to `/watch_videos?video_ids=...&index=...`.
   - `src/content_main.js`: Bootstraps components on `DOMContentLoaded` and `yt-navigate-finish`.
   - `src/styles/queue_plus.css`: Styles for badge chips, card dimming/hiding, restore banner, and toast snackbar.

3. **Options & Status UI** (`popup/`):
   - `popup/popup.html`, `popup/popup.css`, `popup/popup.js`: Real-time active queue count, feed mode selector radio group, saved session display, manual restore trigger.

4. **Automated Test Infrastructure** (`test/`):
   - Zero-dependency test runner executable via `node test.js` or `npm test` using Node.js v24 built-ins.
   - Mock DOM environment (`test/harness/mock-dom.js`) supporting YouTube custom elements, 3-phase event dispatch (capture/target/bubble), and MutationObserver.
   - Mock Chrome Storage (`test/harness/mock-chrome.js`) supporting async get/set/remove and `onChanged` listeners.
   - Comprehensive 4-Tier test suite (30 test cases) verifying all functional requirements and edge cases.

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | MV3 Manifest & Permissions | `manifest.json` conforming to Manifest V3 with minimal `storage` permission, YouTube host permissions, and zero external scripts | M1 | ORIGINAL_REQUEST §Acceptance Criteria |
| 2 | Shared Constants & Keys | Single-source-of-truth constants for YouTube selectors, event names, and storage keys | M1 | Explorer 2 & Spec Miner |
| 3 | URL Parser & ID Extractor | Deterministic extraction of 11-char YouTube video IDs and construction of `/watch_videos` URLs | M1 | Spec Miner & Explorer 2 |
| 4 | DOM & Debounce Utilities | Helper functions for safe element traversal, attribute manipulation, and function debouncing | M1 | Explorer 2 |
| 5 | Storage Synchronization | `chrome.storage.local` manager with 300ms debouncing, in-memory diffing, and cross-tab `onChanged` sync | M1 | ORIGINAL_REQUEST §R2 |
| 6 | Background Service Worker | Minimal service worker managing extension badge counter and initial defaults | M1 | Explorer 2 |
| 7 | Native Queue Observer | `MutationObserver` on `ytd-playlist-panel-renderer` and `ytd-miniplayer` extracting ordered video IDs and selected index | M2 | ORIGINAL_REQUEST §R1 |
| 8 | Feed Card Decorator | Dynamic badging (`.yqp-queue-badge`) and dimming/hiding on `ytd-rich-item-renderer`, `ytd-video-renderer`, `ytd-compact-video-renderer` | M2 | ORIGINAL_REQUEST §R1 |
| 9 | Feed Badging & Dim CSS | CSS styles for `.yqp-queue-badge`, dimmed cards (`opacity: 0.4`), hover restoration (`opacity: 0.95`), and hidden mode | M2 | Explorer 2 & Spec Miner |
| 10 | Toast Manager | Lightweight YouTube Material-styled notification toast container (`#yqp-toast`) | M3 | ORIGINAL_REQUEST §R3 |
| 11 | Duplicate Interception Guard | Capturing-phase click interception on hover "Add to queue" button and 3-dot dropdown menu; blocks duplicate and loop bugs | M3 | ORIGINAL_REQUEST §R3 |
| 12 | Restore Controller & Banner | Unobtrusive top banner shown when native queue is empty but saved session exists; 1-click restore | M4 | ORIGINAL_REQUEST §R2 |
| 13 | Content Main Bootstrapper | Wires all content script modules and binds to YouTube's SPA navigation events (`yt-navigate-finish`) | M4 | Explorer 2 |
| 14 | Options & Status Popup | Extension popup UI with active queue stats, feed mode selector radio group, saved session info, and restore trigger | M4 | ORIGINAL_REQUEST §R4 |
| 15 | Test Mock Harness | Lightweight in-memory `mock-dom.js` (with 3-phase events + MutationObserver) and `mock-chrome.js` | E2E | Explorer 3 |
| 16 | Tier 1 Feature Coverage Tests | 15 test cases verifying all features in isolation | E2E | Explorer 3 |
| 17 | Tier 2 Boundary Tests | 8 test cases covering empty queues, 100+ videos, invalid IDs, URL truncation, storage errors, and rapid clicks | E2E | Explorer 3 |
| 18 | Tier 3 Cross-Feature Tests | 5 test cases covering interactions (mode switch during mutation, duplicate add during banner, SPA transitions) | E2E | Explorer 3 |
| 19 | Tier 4 Real-World Tests | 2 end-to-end user journey tests validating complete browser restart and multi-page queue workflows | E2E | Explorer 3 |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| E2E | E2E Test Suite Track | Build `test/harness/`, test suites Tiers 1-4, `test/test_runner.js`, `test.js`, publish `TEST_READY.md` | none | DONE |
| M1 | Extension Core & Storage Foundation | `manifest.json`, `assets/icons/`, `src/shared/`, `src/utils/`, `src/modules/storage_sync.js`, `src/background/service_worker.js` | none | DONE |
| M2 | Queue Monitoring & Feed Decoration | `src/modules/queue_observer.js`, `src/modules/feed_decorator.js`, `src/styles/queue_plus.css` | M1 | DONE |
| M3 | Duplicate Guard & Toast Notification | `src/modules/toast_manager.js`, `src/modules/duplicate_guard.js` | M1, M2 | DONE |
| M4 | Session Restore Controller & Popup UI | `src/modules/restore_controller.js`, `src/content_main.js`, `popup/` | M1, M2, M3 | DONE |
| M5 | Final Milestone: E2E Test Pass & Adversarial Hardening | Pass 100% of E2E tests (Tiers 1-4) followed by Phase 2 Adversarial Hardening (Tier 5) | M1, M2, M3, M4, E2E | DONE |

---

## Interface Contracts

### 1. Module Packaging (Universal Module Definition / Global Namespace)
All modules in `src/` use UMD pattern:
```javascript
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      typeof require === 'function' ? require('./dependency') : null
    );
  } else {
    root.__YQP__ = root.__YQP__ || {};
    root.__YQP__.ModuleName = factory(root.__YQP__.dependency);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (dep) {
  // Module definition
});
```

### 2. Storage Schema (`src/shared/storage_keys.js`)
```javascript
const STORAGE_KEYS = {
  ACTIVE_QUEUE: 'yqp_active_queue',
  SAVED_SESSION: 'yqp_saved_session',
  PREFERENCES: 'yqp_preferences',
  SESSION_STATE: 'yqp_session_state'
};

const DEFAULT_PREFERENCES = {
  feedTreatmentMode: 'badge_and_dim', // 'badge_and_dim' | 'hide' | 'badge_only'
  duplicateGuardEnabled: true,
  showRestoreBanner: true
};

const DEFAULT_QUEUE_STATE = {
  videoIds: [],
  currentIndex: 0,
  currentVideoId: null,
  count: 0,
  lastUpdated: 0
};
```

### 3. Queue Observer ↔ Consumers (`src/modules/queue_observer.js`)
- `queueObserver.getActiveVideoIds()`: Returns `string[]` of ordered 11-char video IDs.
- `queueObserver.getActiveIdsSet()`: Returns `Set<string>` for $O(1)$ membership checks.
- `queueObserver.getCurrentIndex()`: Returns 0-based integer of currently playing video.
- `queueObserver.subscribe(callback)`: Registers listener called on queue mutations: `callback({ videoIds, currentIndex, count })`.

### 4. Feed Decorator ↔ Preferences (`src/modules/feed_decorator.js`)
- `feedDecorator.updateQueue(videoIds)`: Updates active queue set and applies/clears decorations.
- `feedDecorator.setMode(mode)`: Sets treatment mode (`'badge_and_dim'` | `'hide'` | `'badge_only'`).
- Attributes applied:
  - `data-yqp-status="queued"`
  - `data-yqp-mode="badge_and_dim"`
  - `data-yqp-video-id="[11-char-id]"`
- Elements injected: `<div class="yqp-queue-badge">QUEUED</div>` inside `.ytd-thumbnail` or `#thumbnail`.

### 5. Duplicate Guard (`src/modules/duplicate_guard.js`)
- Captures document clicks: `document.addEventListener('click', handler, true)`.
- If target matches queue addition button/menu and parsed target video ID is in `queueObserver.getActiveIdsSet()`:
  - Calls `e.preventDefault()`, `e.stopPropagation()`, `e.stopImmediatePropagation()`.
  - Calls `toastManager.show('Video is already in queue')`.

### 6. Restore Protocol (`src/utils/url_parser.js` & `src/modules/restore_controller.js`)
- `urlParser.buildRestoreUrl(videoIds, currentIndex)`:
  - Input: `videoIds: string[]`, `currentIndex: number`.
  - Output: `https://www.youtube.com/watch_videos?video_ids=${encodeURIComponent(videoIds.slice(0, 50).join(','))}&index=${Math.max(0, currentIndex || 0)}`.

---

## Code Layout
```
YoutubeQueuePlus/
├── manifest.json
├── package.json
├── test.js
├── assets/
│   └── icons/
│       ├── icon-16.png
│       ├── icon-32.png
│       ├── icon-48.png
│       ├── icon-128.png
│       └── icon.svg
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── src/
│   ├── background/
│   │   └── service_worker.js
│   ├── shared/
│   │   ├── constants.js
│   │   └── storage_keys.js
│   ├── utils/
│   │   ├── dom_helpers.js
│   │   └── url_parser.js
│   ├── modules/
│   │   ├── storage_sync.js
│   │   ├── queue_observer.js
│   │   ├── feed_decorator.js
│   │   ├── duplicate_guard.js
│   │   ├── toast_manager.js
│   │   └── restore_controller.js
│   ├── styles/
│   │   └── queue_plus.css
│   └── content_main.js
└── test/
    ├── harness/
    │   ├── mock-dom.js
    │   ├── mock-chrome.js
    │   └── test-runner.js
    ├── tier1-feature-coverage.test.js
    ├── tier2-boundary-cases.test.js
    ├── tier3-cross-feature.test.js
    ├── tier4-real-world.test.js
    └── test_runner.js
```
