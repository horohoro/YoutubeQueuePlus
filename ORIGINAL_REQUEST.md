# Original User Request

## 2026-10-03T08:31:00Z

Build YoutubeQueuePlus, a lightweight Chrome extension (Manifest V3, Vanilla JavaScript) that augments YouTube's native temporary queue and playlist player without replacing it. It tracks queued videos, badges/hides them on home and search feeds, prevents duplicate additions from breaking player synchronization, and enables seamless queue session restoration across browser restarts.

Working directory: YoutubeQueuePlus
Integrity mode: development

## Requirements

### R1. Native Queue Synchronization & Feed Decoration
Continuously monitor YouTube's native queue state (e.g., in `ytd-playlist-panel-renderer` / `ytd-miniplayer` / player state). Inspect video cards across the homepage, browse, and search feeds (`ytd-rich-item-renderer`, `ytd-video-renderer`). When a video is present in the active queue, visually distinguish it (badge on thumbnail and dimmed card opacity) or hide it based on user preference, updating dynamically as the queue changes.

### R2. Native Queue Session Persistence & Restore
Persist active queue snapshots (ordered list of video IDs, current video index, and timestamp) in `chrome.storage.local`. When YouTube is loaded after a browser restart or crash where the native queue is empty, detect the saved session and provide a seamless 1-click restore mechanism (or automatic restore) that loads the queued videos directly into YouTube's native player via its multi-video endpoint (`/watch_videos?video_ids=...&index=...`).

### R3. Duplicate Addition Guard
Intercept actions that attempt to add a video to the queue (hover "Add to queue" button and three-dot action menu item). If the target video ID already exists in the active queue, prevent the addition, prevent native player desynchronization/looping bugs, and display a native-styled YouTube notification/toast indicating the video is already in the queue.

### R4. Options & Status UI
Provide an extension popup / settings menu allowing the user to:
- Toggle feed treatment mode: "Badge & Dim (default)" vs "Hide completely" vs "Badge only".
- View current queue count and last saved session timestamp.
- Manually trigger a "Restore Last Session" action.
- Ensure the extension requires zero build steps and is directly loadable as an unpacked extension in Developer Mode.

## Acceptance Criteria

### Manifest & Standards Compliance
- [ ] `manifest.json` conforms strictly to Chrome Manifest V3 with minimal necessary permissions (`storage` and YouTube host permissions only).
- [ ] Pure Vanilla JavaScript implementation with no compile/build step required (loadable unpacked directly from the project directory).
- [ ] No external 3rd-party network requests or telemetry.

### Feed Badging & Dimming
- [ ] Feed cards matching active queue video IDs are tagged with custom data attributes/classes, displaying a visible "QUEUED" chip and reduced opacity.
- [ ] Adding or removing an item dynamically updates the feed decoration without requiring a full page refresh.

### Duplicate Prevention
- [ ] Adding an already-queued video is intercepted and blocked; the native queue item count does not duplicate.
- [ ] A non-intrusive on-screen notice informs the user that the video is already queued.

### Session Persistence & Restore
- [ ] Queue updates are reliably written to `chrome.storage.local`.
- [ ] When native queue is absent on page load, a clean restore banner appears or can be triggered via popup to relaunch the videos in the native player.

### Automated Test Suite
- [ ] A runnable automated test suite (`npm test` or `node test.js`) with DOM and `chrome.storage` mocks validates feed decoration, duplicate interception logic, and restore URL generation without manual browser interaction.
