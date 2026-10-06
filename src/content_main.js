/**
 * YoutubeQueuePlus - Content Script Entrypoint & Component Orchestrator
 * Universal Module Definition (UMD) wrapping with root.__YQP__.ContentMain.
 *
 * Responsibilities:
 * 1. Bootstraps and instantiates all submodules: StorageSync, ToastManager,
 *    QueueObserver, DuplicateGuard, FeedDecorator, and RestoreController.
 * 2. Wires reactive Pub/Sub data flow between components.
 * 3. Handles YouTube Single Page Application (SPA) navigation events
 *    ('yt-navigate-finish', 'yt-page-data-updated', 'popstate').
 * 4. Provides comprehensive error isolation so extension faults never disrupt YouTube.
 * 5. Exposes a clean, idempotent teardown API: window.__YQP__.destroy().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    let Constants = null;
    let StorageKeys = null;
    let DomHelpers = null;
    let UrlParser = null;
    let StorageSync = null;
    let ToastManager = null;
    let DuplicateGuard = null;
    let FeedDecorator = null;
    let QueueObserver = null;
    let RestoreController = null;

    try { Constants = require('./shared/constants'); } catch (_) {}
    try { StorageKeys = require('./shared/storage_keys'); } catch (_) {}
    try { DomHelpers = require('./utils/dom_helpers'); } catch (_) {}
    try { UrlParser = require('./utils/url_parser'); } catch (_) {}
    try { StorageSync = require('./modules/storage_sync'); } catch (_) {}
    try { ToastManager = require('./modules/toast_manager'); } catch (_) {}
    try { DuplicateGuard = require('./modules/duplicate_guard'); } catch (_) {}
    try { FeedDecorator = require('./modules/feed_decorator'); } catch (_) {}
    try { QueueObserver = require('./modules/queue_observer'); } catch (_) {}
    try { RestoreController = require('./modules/restore_controller'); } catch (_) {}

    const ContentMainClass = factory(
      Constants,
      StorageKeys,
      DomHelpers,
      UrlParser,
      StorageSync,
      ToastManager,
      DuplicateGuard,
      FeedDecorator,
      QueueObserver,
      RestoreController
    );

    module.exports = ContentMainClass;
    module.exports.ContentMain = ContentMainClass;
    module.exports.default = ContentMainClass;
  } else {
    root.__YQP__ = root.__YQP__ || {};
    const ContentMainClass = factory(
      root.__YQP__.Constants,
      root.__YQP__.StorageKeys,
      root.__YQP__.DomHelpers,
      root.__YQP__.UrlParser,
      root.__YQP__.StorageSync,
      root.__YQP__.ToastManager,
      root.__YQP__.DuplicateGuard,
      root.__YQP__.FeedDecorator,
      root.__YQP__.QueueObserver,
      root.__YQP__.RestoreController
    );
    root.__YQP__.ContentMain = ContentMainClass;

    // Automatic browser bootstrapping when executed as a content script
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      const isTestEnv = typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'test';
      if (!isTestEnv) {
        const bootstrap = () => {
          try {
            if (!root.__YQP__.instance) {
              const app = new ContentMainClass();
              app.init();
              root.__YQP__.instance = app;
              root.__YQP__.destroy = () => app.destroy();
              root.__YQP__.storageSync = app.storageSync;
              root.__YQP__.toastManager = app.toastManager;
              root.__YQP__.queueObserver = app.queueObserver;
              root.__YQP__.duplicateGuard = app.duplicateGuard;
              root.__YQP__.feedDecorator = app.feedDecorator;
              root.__YQP__.restoreController = app.restoreController;
            }
          } catch (err) {
            console.error('[YoutubeQueuePlus] Bootstrap exception:', err);
          }
        };

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
        } else {
          bootstrap();
        }
      }
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  ConstantsModule,
  StorageKeysModule,
  DomHelpersModule,
  UrlParserModule,
  StorageSyncModule,
  ToastManagerModule,
  DuplicateGuardModule,
  FeedDecoratorModule,
  QueueObserverModule,
  RestoreControllerModule
) {
  'use strict';

  class ContentMain {
    /**
     * @param {Object} [options]
     * @param {Document} [options.document] - Document context
     * @param {Window} [options.window] - Window context
     * @param {Object} [options.storageArea] - Mock storage area for testing
     * @param {Object} [options.storageOnChanged] - Mock onChanged event emitter
     * @param {Object} [options.modules] - Dependency injection overrides for testing
     */
    constructor(options = {}) {
      this.options = options;
      this.doc = options.document || (typeof document !== 'undefined' ? document : null);
      this.win = options.window || (typeof window !== 'undefined' ? window : null);

      // Injected module overrides or fallback references
      this._modules = {
        Constants: options.modules?.Constants || ConstantsModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.Constants),
        StorageKeys: options.modules?.StorageKeys || StorageKeysModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.StorageKeys),
        DomHelpers: options.modules?.DomHelpers || DomHelpersModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.DomHelpers),
        UrlParser: options.modules?.UrlParser || UrlParserModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.UrlParser),
        StorageSync: options.modules?.StorageSync || StorageSyncModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.StorageSync),
        ToastManager: options.modules?.ToastManager || ToastManagerModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.ToastManager),
        DuplicateGuard: options.modules?.DuplicateGuard || DuplicateGuardModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.DuplicateGuard),
        FeedDecorator: options.modules?.FeedDecorator || FeedDecoratorModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.FeedDecorator),
        QueueObserver: options.modules?.QueueObserver || QueueObserverModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.QueueObserver),
        RestoreController: options.modules?.RestoreController || RestoreControllerModule || (typeof globalThis !== 'undefined' && globalThis.__YQP__?.RestoreController)
      };

      // Instantiated submodules
      this.storageSync = null;
      this.toastManager = null;
      this.queueObserver = null;
      this.duplicateGuard = null;
      this.feedDecorator = null;
      this.restoreController = null;

      // Internal lifecycle trackers
      this.isInitialized = false;
      this.isDestroyed = false;
      this._unsubscribers = [];
      this._navigationHandlers = [];
      this._navDeferredTimer = null;
    }

    /**
     * Initializes all components, binds inter-module wiring, and sets up SPA event listeners.
     * Fully isolated: failure in any single component will not throw or break the host page.
     * @returns {Promise<ContentMain>}
     */
    async init() {
      if (this.isInitialized && !this.isDestroyed) {
        return this;
      }
      this.isDestroyed = false;

      try {
        // Stage 1: StorageSync Engine
        if (this._modules.StorageSync) {
          try {
            const storageOptions = {
              storageArea: this.options.storageArea,
              storageOnChanged: this.options.storageOnChanged || this.options.storageArea?.onChanged,
              ...(this.options.storageSyncOptions || {})
            };
            this.storageSync = new this._modules.StorageSync(storageOptions);
          } catch (err) {
            console.error('[YQP ContentMain] StorageSync instantiation failed:', err);
          }
        }

        // Stage 2: ToastManager Notification UI
        if (this._modules.ToastManager) {
          try {
            const toastOptions = {
              document: this.doc,
              ...(this.options.toastManagerOptions || {})
            };
            this.toastManager = typeof this._modules.ToastManager.getInstance === 'function'
              ? this._modules.ToastManager.getInstance(toastOptions)
              : new this._modules.ToastManager(toastOptions);
          } catch (err) {
            console.error('[YQP ContentMain] ToastManager instantiation failed:', err);
          }
        }

        // Stage 3: QueueObserver DOM Monitor
        if (this._modules.QueueObserver) {
          try {
            this.queueObserver = new this._modules.QueueObserver({
              document: this.doc,
              window: this.win,
              autoStart: true,
              ...(this.options.queueObserverOptions || {})
            });
          } catch (err) {
            console.error('[YQP ContentMain] QueueObserver instantiation failed:', err);
          }
        }

        // Stage 4: DuplicateGuard Interception
        if (this._modules.DuplicateGuard) {
          try {
            this.duplicateGuard = new this._modules.DuplicateGuard({
              document: this.doc,
              window: this.win,
              queueObserver: this.queueObserver,
              toastManager: this.toastManager,
              enabled: true,
              autoStart: true,
              ...(this.options.duplicateGuardOptions || {})
            });
          } catch (err) {
            console.error('[YQP ContentMain] DuplicateGuard instantiation failed:', err);
          }
        }

        // Stage 5: FeedDecorator Card Badging & Dimming
        if (this._modules.FeedDecorator) {
          try {
            this.feedDecorator = new this._modules.FeedDecorator({
              mode: 'badge_and_dim',
              root: this.doc,
              autoObserve: true,
              ...(this.options.feedDecoratorOptions || {})
            });
          } catch (err) {
            console.error('[YQP ContentMain] FeedDecorator instantiation failed:', err);
          }
        }

        // Stage 6: RestoreController Session Restoration
        if (this._modules.RestoreController) {
          try {
            this.restoreController = new this._modules.RestoreController({
              document: this.doc,
              window: this.win,
              storageSync: this.storageSync,
              queueObserver: this.queueObserver,
              urlParser: this._modules.UrlParser,
              domHelpers: this._modules.DomHelpers,
              constants: this._modules.Constants,
              ...(this.options.restoreControllerOptions || {})
            });
          } catch (err) {
            console.error('[YQP ContentMain] RestoreController instantiation failed:', err);
          }
        }

        // Stage 7: Wire inter-module subscriptions
        this._wireModules();

        // Stage 8: Wire SPA Navigation Events
        this._bindNavigationEvents();

        // Stage 9: Asynchronous Preferences Synchronization
        if (this.storageSync && typeof this.storageSync.getPreferences === 'function') {
          this._syncInitialPreferences().catch(err => {
            console.warn('[YQP ContentMain] Initial preferences sync failed:', err);
          });
        }

        // Stage 10: Initial Session Restore Evaluation
        if (this.restoreController && typeof this.restoreController.checkRestoreAvailable === 'function') {
          try {
            this.restoreController.checkRestoreAvailable();
          } catch (err) {
            console.warn('[YQP ContentMain] Initial restore check failed:', err);
          }
        }

        this.isInitialized = true;
      } catch (globalErr) {
        // Ultimate defensive barrier: Never throw to YouTube runtime
        console.error('[YoutubeQueuePlus] Unhandled initialization exception:', globalErr);
      }

      return this;
    }

    /**
     * Wires reactive data pipelines across all instantiated modules.
     * @private
     */
    _wireModules() {
      // 1. QueueObserver updates -> StorageSync.saveActiveQueue() & FeedDecorator.updateQueue()
      if (this.queueObserver && typeof this.queueObserver.subscribe === 'function') {
        const unsubQueue = this.queueObserver.subscribe((queueState) => {
          if (!queueState) return;

          // 1a. StorageSync active queue persistence
          if (this.storageSync && typeof this.storageSync.saveActiveQueue === 'function') {
            try {
              this.storageSync.saveActiveQueue(queueState);
            } catch (err) {
              console.warn('[YQP ContentMain] StorageSync.saveActiveQueue error:', err);
            }
          }

          // 1b. FeedDecorator active queue update
          if (this.feedDecorator && typeof this.feedDecorator.updateQueue === 'function') {
            try {
              this.feedDecorator.updateQueue(queueState.videoIds || []);
            } catch (err) {
              console.warn('[YQP ContentMain] FeedDecorator.updateQueue error:', err);
            }
          }

          // 1c. RestoreController active queue update (hides banner if queue is active)
          if (this.restoreController) {
            try {
              if (typeof this.restoreController.onQueueUpdated === 'function') {
                this.restoreController.onQueueUpdated(queueState);
              } else if (typeof this.restoreController.checkRestoreAvailable === 'function') {
                this.restoreController.checkRestoreAvailable();
              }
            } catch (err) {
              console.warn('[YQP ContentMain] RestoreController queue update error:', err);
            }
          }
        }, { immediate: true });

        if (typeof unsubQueue === 'function') {
          this._unsubscribers.push(unsubQueue);
        }
      }

      // 2. StorageSync preference changes -> FeedDecorator.setMode() & DuplicateGuard.setEnabled()
      if (this.storageSync && typeof this.storageSync.subscribe === 'function') {
        const unsubPrefs = this.storageSync.subscribe('preferences', (prefs) => {
          if (!prefs) return;

          // 2a. Feed treatment mode update
          if (prefs.feedTreatmentMode && this.feedDecorator && typeof this.feedDecorator.setMode === 'function') {
            try {
              this.feedDecorator.setMode(prefs.feedTreatmentMode);
            } catch (err) {
              console.warn('[YQP ContentMain] FeedDecorator.setMode error:', err);
            }
          }

          // 2b. Duplicate guard toggle update
          if (typeof prefs.duplicateGuardEnabled === 'boolean' && this.duplicateGuard && typeof this.duplicateGuard.setEnabled === 'function') {
            try {
              this.duplicateGuard.setEnabled(prefs.duplicateGuardEnabled);
            } catch (err) {
              console.warn('[YQP ContentMain] DuplicateGuard.setEnabled error:', err);
            }
          }

          // 2c. Restore banner preferences update
          if (this.restoreController) {
            try {
              if (typeof this.restoreController.onPreferencesChanged === 'function') {
                this.restoreController.onPreferencesChanged(prefs);
              } else if (typeof this.restoreController.checkRestoreAvailable === 'function') {
                this.restoreController.checkRestoreAvailable();
              }
            } catch (err) {
              console.warn('[YQP ContentMain] RestoreController onPreferencesChanged error:', err);
            }
          }
        });

        if (typeof unsubPrefs === 'function') {
          this._unsubscribers.push(unsubPrefs);
        }

        // 3. StorageSync saved_session changes -> RestoreController check
        const unsubSession = this.storageSync.subscribe('saved_session', (savedSession) => {
          if (this.restoreController) {
            try {
              if (typeof this.restoreController.onSavedSessionChanged === 'function') {
                this.restoreController.onSavedSessionChanged(savedSession);
              } else if (typeof this.restoreController.checkRestoreAvailable === 'function') {
                this.restoreController.checkRestoreAvailable();
              }
            } catch (err) {
              console.warn('[YQP ContentMain] RestoreController onSavedSessionChanged error:', err);
            }
          }
        });

        if (typeof unsubSession === 'function') {
          this._unsubscribers.push(unsubSession);
        }

        // 4. Cross-tab queue storage changes -> FeedDecorator update (for tabs without active queue panels)
        const unsubStorageQueue = this.storageSync.subscribe('queue', (queueState) => {
          if (!queueState) return;
          if (this.feedDecorator && (!this.queueObserver || !this.queueObserver.isQueueActive())) {
            try {
              this.feedDecorator.updateQueue(queueState.videoIds || []);
            } catch (err) {
              console.warn('[YQP ContentMain] Cross-tab FeedDecorator sync error:', err);
            }
          }
        });

        if (typeof unsubStorageQueue === 'function') {
          this._unsubscribers.push(unsubStorageQueue);
        }
      }

      // 5. Ensure DuplicateGuard is wired with QueueObserver and ToastManager
      if (this.duplicateGuard) {
        try {
          if (this.queueObserver && typeof this.duplicateGuard.setQueueObserver === 'function') {
            this.duplicateGuard.setQueueObserver(this.queueObserver);
          }
          if (this.toastManager && typeof this.duplicateGuard.setToastManager === 'function') {
            this.duplicateGuard.setToastManager(this.toastManager);
          }
        } catch (err) {
          console.warn('[YQP ContentMain] DuplicateGuard dependency wiring error:', err);
        }
      }
    }

    /**
     * Reads initial preferences from storage and applies them to modules.
     * @private
     */
    async _syncInitialPreferences() {
      try {
        const prefs = await this.storageSync.getPreferences();
        if (prefs) {
          if (prefs.feedTreatmentMode && this.feedDecorator && typeof this.feedDecorator.setMode === 'function') {
            this.feedDecorator.setMode(prefs.feedTreatmentMode);
          }
          if (typeof prefs.duplicateGuardEnabled === 'boolean' && this.duplicateGuard && typeof this.duplicateGuard.setEnabled === 'function') {
            this.duplicateGuard.setEnabled(prefs.duplicateGuardEnabled);
          }
        }
      } catch (err) {
        console.warn('[YQP ContentMain] _syncInitialPreferences failed:', err);
      }
    }

    /**
     * Binds YouTube SPA navigation and history traversal events.
     * @private
     */
    _bindNavigationEvents() {
      const target = this.win || (typeof window !== 'undefined' ? window : null) || this.doc;
      if (!target || typeof target.addEventListener !== 'function') return;

      const eventNames = [
        this._modules.Constants?.EVENTS?.YT_NAVIGATE_FINISH || 'yt-navigate-finish',
        this._modules.Constants?.EVENTS?.YT_PAGE_DATA_UPDATED || 'yt-page-data-updated',
        'popstate'
      ];

      for (const name of eventNames) {
        const handler = (evt) => this._handleNavigation(evt?.type || name);
        try {
          target.addEventListener(name, handler);
          this._navigationHandlers.push({ target, event: name, handler });
        } catch (err) {
          console.warn(`[YQP ContentMain] Failed to bind navigation event "${name}":`, err);
        }
      }
    }

    /**
     * Re-evaluates queue state, feed decoration, and restore banners across YouTube SPA navigation.
     * Runs an immediate pass followed by a 200ms deferred pass for Polymer template rendering.
     * @param {string} eventType
     * @private
     */
    _handleNavigation(eventType) {
      if (this.isDestroyed) return;

      // Immediate Phase: DOM may already contain new layout
      this._runNavigationEvaluation();

      // Deferred Phase: Polymer elements (ytd-rich-item-renderer) often stamp asynchronously
      if (this._navDeferredTimer) {
        clearTimeout(this._navDeferredTimer);
      }
      this._navDeferredTimer = setTimeout(() => {
        this._navDeferredTimer = null;
        if (!this.isDestroyed) {
          this._runNavigationEvaluation();
        }
      }, 200);
    }

    /**
     * Executes evaluation routines across all active modules.
     * @private
     */
    _runNavigationEvaluation() {
      // 1. Rescan native queue panel
      if (this.queueObserver && typeof this.queueObserver.rescan === 'function') {
        try {
          this.queueObserver.rescan(true);
        } catch (err) {
          console.warn('[YQP ContentMain] QueueObserver rescan error:', err);
        }
      }

      // 2. Scan and decorate newly rendered feed cards
      if (this.feedDecorator && typeof this.feedDecorator.scanAndDecorate === 'function') {
        try {
          this.feedDecorator.scanAndDecorate();
        } catch (err) {
          console.warn('[YQP ContentMain] FeedDecorator scanAndDecorate error:', err);
        }
      }

      // 3. Re-evaluate session restore availability
      if (this.restoreController && typeof this.restoreController.checkRestoreAvailable === 'function') {
        try {
          this.restoreController.checkRestoreAvailable();
        } catch (err) {
          console.warn('[YQP ContentMain] RestoreController checkRestoreAvailable error:', err);
        }
      }
    }

    /**
     * Clean, idempotent teardown API.
     * Disconnects observers, unbinds navigation and storage listeners, clears timers,
     * removes injected DOM elements, and resets global references.
     */
    destroy() {
      if (this.isDestroyed) return;
      this.isDestroyed = true;
      this.isInitialized = false;

      // 1. Clear pending deferred navigation timer
      if (this._navDeferredTimer) {
        clearTimeout(this._navDeferredTimer);
        this._navDeferredTimer = null;
      }

      // 2. Unbind SPA navigation listeners
      for (const { target, event, handler } of this._navigationHandlers) {
        try {
          if (target && typeof target.removeEventListener === 'function') {
            target.removeEventListener(event, handler);
          }
        } catch (err) {
          console.warn(`[YQP ContentMain] Failed to remove navigation event "${event}":`, err);
        }
      }
      this._navigationHandlers = [];

      // 3. Unsubscribe all Pub/Sub subscriptions
      for (const unsub of this._unsubscribers) {
        try {
          if (typeof unsub === 'function') unsub();
        } catch (err) {
          console.warn('[YQP ContentMain] Subscription cleanup error:', err);
        }
      }
      this._unsubscribers = [];

      // 4. Destroy modules in reverse dependency order
      // 4a. RestoreController (removes #yqp-restore-banner)
      if (this.restoreController && typeof this.restoreController.destroy === 'function') {
        try {
          this.restoreController.destroy();
        } catch (err) {
          console.warn('[YQP ContentMain] RestoreController destroy error:', err);
        }
        this.restoreController = null;
      }

      // 4b. FeedDecorator (removes all badges, attributes, and styles from DOM)
      if (this.feedDecorator && typeof this.feedDecorator.destroy === 'function') {
        try {
          this.feedDecorator.destroy();
        } catch (err) {
          console.warn('[YQP ContentMain] FeedDecorator destroy error:', err);
        }
        this.feedDecorator = null;
      }

      // 4c. DuplicateGuard (removes capturing click listeners)
      if (this.duplicateGuard && typeof this.duplicateGuard.destroy === 'function') {
        try {
          this.duplicateGuard.destroy();
        } catch (err) {
          console.warn('[YQP ContentMain] DuplicateGuard destroy error:', err);
        }
        this.duplicateGuard = null;
      }

      // 4d. QueueObserver (disconnects MutationObservers)
      if (this.queueObserver && typeof this.queueObserver.destroy === 'function') {
        try {
          this.queueObserver.destroy();
        } catch (err) {
          console.warn('[YQP ContentMain] QueueObserver destroy error:', err);
        }
        this.queueObserver = null;
      }

      // 4e. ToastManager (removes #yqp-toast container)
      if (this.toastManager && typeof this.toastManager.destroy === 'function') {
        try {
          this.toastManager.destroy();
        } catch (err) {
          console.warn('[YQP ContentMain] ToastManager destroy error:', err);
        }
        this.toastManager = null;
      }

      // 4f. StorageSync (flushes pending writes and disconnects onChanged)
      if (this.storageSync && typeof this.storageSync.destroy === 'function') {
        try {
          this.storageSync.destroy();
        } catch (err) {
          console.warn('[YQP ContentMain] StorageSync destroy error:', err);
        }
        this.storageSync = null;
      }

      // 5. Clean up window.__YQP__ references if attached
      const rootObj = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null);
      if (rootObj && rootObj.__YQP__) {
        if (rootObj.__YQP__.instance === this) {
          rootObj.__YQP__.instance = null;
          rootObj.__YQP__.storageSync = null;
          rootObj.__YQP__.toastManager = null;
          rootObj.__YQP__.queueObserver = null;
          rootObj.__YQP__.duplicateGuard = null;
          rootObj.__YQP__.feedDecorator = null;
          rootObj.__YQP__.restoreController = null;
        }
      }
    }
  }

  return ContentMain;
});
