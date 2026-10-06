# YoutubeQueuePlus

> A lightweight Chrome extension (Manifest V3, Vanilla JavaScript) that augments YouTube's **native** temporary queue and playlist player with feed badging, duplicate prevention, and cross-restart session persistence — without replacing YouTube's player UI.

---

## The Problem with YouTube's Native Queue

YouTube's built-in "Add to Queue" feature provides a convenient temporary playlist player, but suffers from three frustrating limitations:

1. **Homepage Feeds Keep Showing Queued Videos**: When you queue videos from the homepage, the thumbnails and recommendations remain completely unchanged. You cannot tell which videos you already added.
2. **The Queue Vanishes on Browser Restart**: Because YouTube holds the queue in transient in-memory Polymer session state, closing your browser or rebooting your computer wipes your queue.
3. **Duplicate Videos Break the Player**: Accidentally queuing the same video twice confuses YouTube's native playlist index pointers, causing the player to skip ahead, loop infinitely, or fail to auto-advance.

Existing extensions often attempt to solve this by replacing YouTube's player with custom floating sidebars or external tab-switching engines. **YoutubeQueuePlus takes a different approach**: it acts as a companion layer on top of YouTube's existing player, fixing the native queue directly.

---

## Features

### 1. Feed Badging, Dimming & Hiding
- Automatically observes the native queue (`ytd-playlist-panel-renderer` and `ytd-miniplayer`).
- Matches queued video IDs against cards on the homepage, browse feeds, and search results (`ytd-rich-item-renderer`, `ytd-video-renderer`, `ytd-compact-video-renderer`).
- Highlights queued videos with a sleek **"QUEUED" chip badge** and **0.4 dimmed opacity** (smoothly restores to 0.95 opacity on hover).
- Supports 3 customizable treatment modes:
  - **Badge & Dim** *(Default)*: Dims thumbnail cards and adds the "QUEUED" badge.
  - **Hide completely**: Sets `display: none` on queued cards to keep your recommendations fresh.
  - **Badge only**: Adds the "QUEUED" badge without altering thumbnail opacity.
- Dynamically reacts to infinite scroll loading and queue additions/removals in real time.

### 2. Queue Session Persistence & 1-Click Native Restore
- Continuously mirrors the active queue (ordered video IDs, playing index, timestamp) to `chrome.storage.local`.
- When you reopen your browser after a restart or crash, if YouTube's native queue is empty but a previous session exists, a native-styled restore banner mounts below the masthead.
- Clicking **"Restore Queue"** launches YouTube's native multi-video endpoint:
  ```
  https://www.youtube.com/watch_videos?video_ids=ID1,ID2,ID3...&index=LAST_INDEX
  ```
- Reconstructs your exact queue state natively without flaky back-forward navigation tricks.
- Includes persistent anti-nagging dismissal tracking (dismissing the banner suppresses it until a new session is recorded).

### 3. Duplicate Addition Guard
- Uses capturing-phase event listeners (`useCapture: true`) to intercept clicks on hover "Add to queue" buttons and three-dot dropdown menu items *before* YouTube's scripts process them.
- If a video is already queued, the addition is blocked, protecting YouTube's playlist index from corruption.
- Displays a native YouTube Material dark snackbar toast: *"Already in queue"*.
- Intelligent keyword filtering ensures removal actions (*"Remove from queue"*) and other menu items pass through unhindered.

### 4. 100% Local & Privacy-First
- **Zero Third-Party Telemetry**: Contains no analytics, tracking beacons, external API calls, or remote scripts.
- **Minimal Permissions**: Requires only `storage` and host access to `*://*.youtube.com/*`.
- **Zero Build Step**: Pure Vanilla JavaScript loadable directly as an unpacked extension.

---

## Installation

### Load as an Unpacked Extension in Chrome / Edge / Brave

1. Download or clone this repository:
   ```bash
   git clone https://github.com/horohoro/YoutubeQueuePlus.git
   ```
2. Open your Chromium-based browser and navigate to the extensions page:
   - **Chrome**: `chrome://extensions/`
   - **Brave**: `brave://extensions/`
   - **Edge**: `edge://extensions/`
3. Enable **Developer mode** using the toggle switch in the top-right corner.
4. Click the **"Load unpacked"** button in the top-left toolbar.
5. Select the `YoutubeQueuePlus` directory containing `manifest.json`.
6. Navigate to [YouTube](https://www.youtube.com) and start queuing videos!

---

## Options & Status Popup

Click the **YoutubeQueuePlus** icon in your browser toolbar to open the options menu:

- **Active Queue Status**: Shows the number of videos currently queued and the active playback index.
- **Saved Session Information**: Displays the video count and relative timestamp of your last saved queue snapshot.
- **Feed Treatment Selector**: Switch between *Badge & Dim*, *Hide*, and *Badge Only* modes (updates active feeds instantly without page refresh).
- **Restore Queue Button**: Manually trigger a 1-click restore of your previous session at any time.

---

## Project Structure

```text
YoutubeQueuePlus/
├── manifest.json              # Chrome Manifest V3 configuration
├── package.json               # Project metadata & test scripts
├── test.js                    # Unified test runner entrypoint
├── README.md                  # Project documentation
├── .gitignore                 # Standard repository ignores
├── popup/
│   ├── popup.html             # Extension options & status interface
│   ├── popup.css              # YouTube dark theme popup styling
│   └── popup.js               # Reactive popup controller
├── assets/
│   └── icons/                 # Extension icons (16, 32, 48, 128px PNG & SVG)
├── src/
│   ├── content_main.js        # Bootstrapper coordinating SPA lifecycle (yt-navigate-finish)
│   ├── background/
│   │   └── service_worker.js  # MV3 service worker managing defaults & action badge
│   ├── modules/
│   │   ├── queue_observer.js  # Dual-container queue DOM observer (watch panel & miniplayer)
│   │   ├── feed_decorator.js  # Feed card badging, dimming, and display toggling
│   │   ├── duplicate_guard.js # Capturing-phase click interceptor (hover & 3-dot menu)
│   │   ├── toast_manager.js   # Accessible YouTube Material snackbar toast
│   │   ├── restore_controller.js # Restore banner injection & /watch_videos builder
│   │   └── storage_sync.js    # Debounced storage persistence & cross-tab sync
│   ├── shared/
│   │   ├── constants.js       # Frozen selectors, limits, and class names
│   │   └── storage_keys.js    # Canonical storage schemas and defaults
│   ├── styles/
│   │   └── queue_plus.css     # Badges, opacity transitions, toasts, and banners
│   └── utils/
│       ├── dom_helpers.js     # Safe DOM querying, debounce, throttle, attribute helpers
│       └── url_parser.js      # Video ID extractors & multi-video URL builders
└── test/
    ├── harness/               # Standalone DOM 3-phase event engine & Chrome API mocks
    ├── e2e/                   # 5 Tiers of opaque-box E2E and adversarial stress tests
    └── ...                    # Unit test suites across Milestones M1–M4
```

---

## Testing & Quality Assurance

The extension includes a zero-dependency, comprehensive test suite running natively on Node.js using built-in `node:test` and `node:assert/strict`.

### Running Tests

```bash
# Run the full test suite (Unit M1–M4 + End-to-End Tiers 1–5):
node test.js

# Or using npm:
npm test
```

### Test Coverage Highlights
- **202 / 202 passing tests** across 58 test suites.
- **Tier 1 (Core Features)**: Single-feature verification of badging, duplicate interception, and persistence.
- **Tier 2 (Boundaries)**: Corrupted storage recovery, 500-video storage cap, 50-video URL cap, non-standard video IDs.
- **Tier 3 (Interactions)**: Live mode toggling during queue mutations, rapid clicks, SPA navigation (`yt-navigate-finish`).
- **Tier 4 (Real-World Scenarios)**: Multi-page queue building, browser restart lifecycle simulations.
- **Tier 5 (Adversarial Hardening)**: Negative keyword discrimination (*"Remove from queue"*), URI percent-encoding safety, Polymer virtual scroller element recycling.

---

## License

This project is licensed under the [Creative Commons Attribution 4.0 International License (CC BY 4.0)](LICENSE).
