# Privacy Policy for YoutubeQueuePlus

**Last Updated:** October 2026

**YoutubeQueuePlus** is a free, open-source browser extension developed by **horohoro**. We respect your privacy and are committed to ensuring full transparency regarding data handling.

---

### 1. Zero Data Collection
YoutubeQueuePlus **does not collect, track, store, or transmit any personal information, browsing history, or user data**.

- We do not use cookies.
- We do not include third-party tracking scripts, analytics, or telemetry.
- We do not operate external backend servers or databases.

---

### 2. Local Storage Usage (`chrome.storage.local`)
All data managed by the extension remains strictly local to your machine within your browser's sandboxed storage (`chrome.storage.local`):

- **Active Queue Snapshot**: Stores an in-memory list of YouTube video IDs and playback indices to restore your queue across browser restarts.
- **User Preferences**: Stores your selected feed treatment mode (*Badge & Dim*, *Hide*, or *Badge Only*) and banner display preferences.

This data never leaves your device and is never transmitted over any network.

---

### 3. Permissions Explanation
The extension requests only the minimum permissions necessary for its core features:

- **`storage`**: Used exclusively to save queue states and user preferences locally on your device.
- **Host permissions (`*://*.youtube.com/*`)**: Used exclusively to observe native YouTube queue elements, badge matching video cards on YouTube feeds, intercept duplicate queue additions, and display in-page status toasts.

---

### 4. Third-Party Services
YoutubeQueuePlus does not share, sell, lease, or transfer any user data to third parties, advertising networks, or data brokers.

---

### 5. Source Code & Verification
YoutubeQueuePlus is open source. You can inspect the entire source code to verify our privacy practices at:
[https://github.com/horohoro/YoutubeQueuePlus](https://github.com/horohoro/YoutubeQueuePlus)

---

### 6. Contact
If you have questions about this privacy policy, you can open an issue on GitHub:
[https://github.com/horohoro/YoutubeQueuePlus/issues](https://github.com/horohoro/YoutubeQueuePlus/issues)
