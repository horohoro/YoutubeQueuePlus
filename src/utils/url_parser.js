/**
 * YoutubeQueuePlus - URL Parser Utility
 * YouTube video ID extraction, validation, and restore URL generation in UMD pattern.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.__YQP__ = root.__YQP__ || {};
    root.__YQP__.UrlParser = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Standard 11-character YouTube video ID regex
  const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

  /**
   * Validates if a string is a valid 11-character YouTube video ID.
   * @param {string} id
   * @returns {boolean}
   */
  function isValidVideoId(id) {
    return typeof id === 'string' && VIDEO_ID_REGEX.test(id.trim());
  }

  /**
   * Extracts an 11-character YouTube video ID from various URL formats or raw strings.
   * Supports:
   * - Standard watch URLs: https://www.youtube.com/watch?v=dQw4w9WgXcQ
   * - Shorts: https://www.youtube.com/shorts/dQw4w9WgXcQ
   * - Embeds: https://www.youtube.com/embed/dQw4w9WgXcQ
   * - Shortlinks: https://youtu.be/dQw4w9WgXcQ
   * - Live streams: https://www.youtube.com/live/dQw4w9WgXcQ
   * - Relative URLs: /watch?v=dQw4w9WgXcQ, /shorts/dQw4w9WgXcQ
   * - Direct 11-char ID strings
   * @param {string} input - URL or video ID candidate
   * @returns {string|null} 11-character video ID or null
   */
  function extractVideoId(input) {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed) return null;

    // Fast-path: Check if already an 11-character video ID
    if (isValidVideoId(trimmed)) {
      return trimmed;
    }

    // Standard watch URL: /watch?v=ID or ?...&v=ID
    const watchMatch = trimmed.match(/[?&]v=([a-zA-Z0-9_-]{11})(?:[&#]|$)/);
    if (watchMatch) return watchMatch[1];

    // YouTube Shorts: /shorts/ID
    const shortsMatch = trimmed.match(/(?:^|\/)shorts\/([a-zA-Z0-9_-]{11})(?:[/?#]|$)/);
    if (shortsMatch) return shortsMatch[1];

    // YouTube Embed: /embed/ID
    const embedMatch = trimmed.match(/(?:^|\/)embed\/([a-zA-Z0-9_-]{11})(?:[/?#]|$)/);
    if (embedMatch) return embedMatch[1];

    // youtu.be Shortlinks: youtu.be/ID
    const youtuMatch = trimmed.match(/(?:^|\/)youtu\.be\/([a-zA-Z0-9_-]{11})(?:[/?#]|$)/);
    if (youtuMatch) return youtuMatch[1];

    // YouTube Live: /live/ID
    const liveMatch = trimmed.match(/(?:^|\/)live\/([a-zA-Z0-9_-]{11})(?:[/?#]|$)/);
    if (liveMatch) return liveMatch[1];

    return null;
  }

  /**
   * Extracts video ID from a DOM element (card, thumbnail, title, or anchor).
   * @param {Element} element
   * @returns {string|null}
   */
  function extractVideoIdFromElement(element) {
    if (!element) return null;

    // 1. Check data-yqp-video-id attribute
    const directAttr = element.getAttribute && element.getAttribute('data-yqp-video-id');
    if (isValidVideoId(directAttr)) return directAttr;

    // 2. Check if element itself has href
    const href = element.getAttribute && element.getAttribute('href');
    if (href) {
      const fromHref = extractVideoId(href);
      if (fromHref) return fromHref;
    }

    // 3. Search descendant anchor elements
    if (typeof element.querySelector === 'function') {
      const candidates = [
        'a#thumbnail',
        'a#video-title-link',
        'a#video-title',
        'a#wc-endpoint',
        '#thumbnail',
        '#video-title-link',
        '#wc-endpoint',
        'a[href*="v="]',
        'a[href*="/shorts/"]',
        'a'
      ];
      for (const sel of candidates) {
        try {
          const anchor = element.querySelector(sel);
          if (anchor && anchor.getAttribute) {
            const anchorHref = anchor.getAttribute('href');
            if (anchorHref) {
              const fromAnchor = extractVideoId(anchorHref);
              if (fromAnchor) return fromAnchor;
            }
          }
        } catch (_) {}
      }
    }

    return null;
  }

  /**
   * Constructs YouTube's native multi-video player restore URL.
   * Capped at 50 videos; index is 0-indexed and safely clamped.
   * @param {string[]} videoIds - Ordered array of video IDs
   * @param {number} [currentIndex=0] - 0-based active index
   * @returns {string|null} Restore URL or null if empty/invalid
   */
  function buildRestoreUrl(videoIds, currentIndex = 0) {
    if (!Array.isArray(videoIds)) return null;

    // Filter out invalid IDs to prevent YouTube discarding the TLGG playlist
    const validIds = videoIds.filter(isValidVideoId);
    if (validIds.length === 0) return null;

    // Cap at 50 videos
    const cappedIds = validIds.slice(0, 50);

    // Clamp index to [0, cappedIds.length - 1]
    let safeIndex = typeof currentIndex === 'number' && !isNaN(currentIndex) ? Math.floor(currentIndex) : 0;
    if (safeIndex < 0) safeIndex = 0;
    if (safeIndex >= cappedIds.length) safeIndex = cappedIds.length - 1;

    // Construct URL with encoded comma-separated IDs
    return `https://www.youtube.com/watch_videos?video_ids=${encodeURIComponent(cappedIds.join(','))}&index=${safeIndex}`;
  }

  /**
   * Parses a /watch_videos URL back into an array of video IDs and active index.
   * @param {string} url
   * @returns {{ videoIds: string[], currentIndex: number }|null}
   */
  function parseWatchVideosUrl(url) {
    if (typeof url !== 'string' || !url.includes('watch_videos')) return null;

    const matchIds = url.match(/[?&]video_ids=([^&#]+)/);
    if (!matchIds) return null;

    let rawIds = '';
    try {
      rawIds = decodeURIComponent(matchIds[1]);
    } catch (_) {
      return null;
    }

    const videoIds = rawIds.split(',').map(s => s.trim()).filter(isValidVideoId);
    if (videoIds.length === 0) return null;

    const matchIndex = url.match(/[?&]index=([0-9]+)/);
    let index = matchIndex ? parseInt(matchIndex[1], 10) : 0;
    if (isNaN(index) || index < 0) index = 0;
    if (index >= videoIds.length) index = videoIds.length - 1;

    return {
      videoIds,
      currentIndex: index
    };
  }

  /**
   * Constructs a standard watch URL for a single video.
   * @param {string} videoId
   * @param {Object} [extraParams={}]
   * @returns {string|null}
   */
  function buildWatchUrl(videoId, extraParams = {}) {
    if (!isValidVideoId(videoId)) return null;
    let url = `https://www.youtube.com/watch?v=${videoId}`;
    const params = [];
    for (const [k, v] of Object.entries(extraParams)) {
      if (v !== undefined && v !== null) {
        params.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      }
    }
    if (params.length > 0) {
      url += '&' + params.join('&');
    }
    return url;
  }

  return Object.freeze({
    isValidVideoId,
    extractVideoId,
    extractVideoIdFromElement,
    buildRestoreUrl,
    parseWatchVideosUrl,
    buildWatchUrl,
    VIDEO_ID_REGEX
  });
});
