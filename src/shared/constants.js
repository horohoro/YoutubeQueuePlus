/**
 * YoutubeQueuePlus - Shared Constants
 * Single source of truth for DOM selectors, event names, UI labels, and limits.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.__YQP__ = root.__YQP__ || {};
    root.__YQP__.Constants = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SELECTORS = Object.freeze({
    // Native Queue Containers & Items
    QUEUE_PANEL: 'ytd-playlist-panel-renderer',
    WATCH_PANEL: 'ytd-watch-flexy ytd-playlist-panel-renderer, #secondary ytd-playlist-panel-renderer',
    MINIPLAYER_PANEL: 'ytd-miniplayer[active] ytd-playlist-panel-renderer[within-miniplayer]',
    MINIPLAYER_CONTAINER: 'ytd-miniplayer',
    MINIPLAYER_ACTIVE: 'ytd-miniplayer[active]',
    QUEUE_ITEMS_CONTAINER: 'ytd-playlist-panel-renderer #items, #items.ytd-playlist-panel-renderer',
    QUEUE_ITEM: 'ytd-playlist-panel-video-renderer',
    QUEUE_ITEM_SELECTED: 'ytd-playlist-panel-video-renderer[selected]',
    QUEUE_ITEM_ENDPOINT: 'a#wc-endpoint, a#thumbnail',
    QUEUE_ITEM_TITLE: '#video-title',

    // Feed Video Cards (Homepage, Browse, Search, Related)
    FEED_ITEM_RICH: 'ytd-rich-item-renderer',
    FEED_ITEM_VIDEO: 'ytd-video-renderer',
    FEED_ITEM_COMPACT: 'ytd-compact-video-renderer',
    FEED_CARDS_ALL: 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer',
    CARD_THUMBNAIL_CONTAINER: '#thumbnail, ytd-thumbnail, .ytd-thumbnail',
    CARD_THUMBNAIL_LINK: 'a#thumbnail[href*="/watch?v="], a#video-title-link[href*="/watch?v="], a#thumbnail[href*="watch?v="]',
    CARD_TITLE_LINK: 'a#video-title-link, a#video-title',
    CARD_TITLE_TEXT: '#video-title',

    // Duplicate Guard Triggers (Hover button & 3-dot menu)
    OVERLAY_ADD_TO_QUEUE_BTN: 'ytd-thumbnail-overlay-toggle-button-renderer',
    MENU_3DOT_BTN: 'button[aria-label="Action menu"], ytd-menu-renderer yt-icon-button, button.yt-icon-button[aria-label="Action menu"]',
    MENU_SERVICE_ITEM: 'ytd-menu-service-item-renderer',
    MENU_POPUP_CONTAINER: 'ytd-popup-container, ytd-menu-popup-renderer, tp-yt-iron-dropdown',

    // Restore Banner Injection Targets
    BANNER_PARENT_HOME: 'ytd-rich-grid-renderer #contents, #contents.ytd-rich-grid-renderer',
    BANNER_PARENT_PRIMARY: '#primary #contents, ytd-browse[page-subtype="home"] #contents',
    MASTHEAD_CONTAINER: '#masthead-container, ytd-masthead'
  });

  const ATTRIBUTES = Object.freeze({
    STATUS: 'data-yqp-status',
    MODE: 'data-yqp-mode',
    VIDEO_ID: 'data-yqp-video-id',
    DECORATED: 'data-yqp-decorated'
  });

  const CLASSES = Object.freeze({
    BADGE: 'yqp-queue-badge',
    TOAST_CONTAINER: 'yqp-toast-container',
    TOAST_VISIBLE: 'yqp-toast-visible',
    TOAST_ICON: 'yqp-toast-icon',
    RESTORE_BANNER: 'yqp-restore-banner',
    BANNER_TEXT: 'yqp-restore-banner-text',
    BANNER_ACTIONS: 'yqp-restore-banner-actions',
    BANNER_BTN_RESTORE: 'yqp-banner-btn-restore',
    BANNER_BTN_DISMISS: 'yqp-banner-btn-dismiss'
  });

  const IDS = Object.freeze({
    TOAST: 'yqp-toast',
    RESTORE_BANNER: 'yqp-restore-banner'
  });

  const FEED_MODES = Object.freeze({
    BADGE_AND_DIM: 'badge_and_dim',
    HIDE: 'hide',
    BADGE_ONLY: 'badge_only'
  });

  const ALL_FEED_MODES = Object.freeze([
    FEED_MODES.BADGE_AND_DIM,
    FEED_MODES.HIDE,
    FEED_MODES.BADGE_ONLY
  ]);

  const ACTIONS = Object.freeze({
    RESTORE_SESSION: 'YQP_RESTORE_SESSION',
    GET_STATUS: 'YQP_GET_STATUS',
    SET_PREFERENCES: 'YQP_SET_PREFERENCES',
    CLEAR_SAVED_SESSION: 'YQP_CLEAR_SAVED_SESSION',
    QUEUE_MUTATED: 'YQP_QUEUE_MUTATED'
  });

  const UI_LABELS = Object.freeze({
    BADGE_TEXT: 'QUEUED',
    TOAST_DUPLICATE_MESSAGE: 'Video is already in queue',
    BANNER_RESTORE_TEXT: 'Queue session found ({count} videos)',
    BANNER_RESTORE_BTN: 'Restore Queue',
    BANNER_DISMISS_BTN: 'Dismiss',
    POPUP_NO_SESSION: 'No saved session available'
  });

  // Internationalized/Localized Queue Button Keywords
  const QUEUE_BUTTON_KEYWORDS = Object.freeze([
    'queue',
    'add to queue',
    'キュー',
    'cola',
    'añadir a la cola',
    'warteschlange',
    'in warteschlange',
    'file d\'attente',
    'ajouter à la file d\'attente',
    'fila',
    'adicionar à fila',
    'очередь',
    'добавить в очередь'
  ]);

  const EVENTS = Object.freeze({
    YT_NAVIGATE_FINISH: 'yt-navigate-finish',
    YT_PAGE_DATA_UPDATED: 'yt-page-data-updated',
    DOM_CONTENT_LOADED: 'DOMContentLoaded',
    CLICK: 'click',
    POINTERDOWN: 'pointerdown'
  });

  const TIMING = Object.freeze({
    STORAGE_DEBOUNCE_MS: 300,
    TOAST_DISPLAY_MS: 3500,
    TOAST_FADE_MS: 250,
    MUTATION_DEBOUNCE_MS: 100
  });

  const LIMITS = Object.freeze({
    MAX_RESTORE_VIDEOS: 50,
    VIDEO_ID_LENGTH: 11,
    VIDEO_ID_REGEX: /^[a-zA-Z0-9_-]{11}$/
  });

  return Object.freeze({
    SELECTORS,
    ATTRIBUTES,
    CLASSES,
    IDS,
    FEED_MODES,
    ALL_FEED_MODES,
    ACTIONS,
    UI_LABELS,
    QUEUE_BUTTON_KEYWORDS,
    EVENTS,
    TIMING,
    LIMITS
  });
});
