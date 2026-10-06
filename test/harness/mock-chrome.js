/**
 * YoutubeQueuePlus - Modular Mock Chrome API Harness
 * Reusable mock Chrome environment supporting:
 * - chrome.storage.local with async Promise/callback get, set, remove, clear
 * - Deep object cloning to prevent shared reference mutations
 * - chrome.storage.onChanged event emitter with manual trigger for cross-tab simulation
 * - chrome.tabs with query, update, create
 * - chrome.action badge inspection
 * - Fault injection for storage quota limits and corrupt reads
 */

function deepClone(val) {
  if (val === undefined) return undefined;
  if (val === null) return null;
  return JSON.parse(JSON.stringify(val));
}

class MockChromeStorageArea {
  constructor() {
    this.store = new Map();
    this.changeListeners = [];
    this._failNextError = null;
    this._failNextGetError = null;
    this._failNextSetError = null;
  }

  _failNext(err) {
    this._failNextError = err;
  }

  _failNextGet(err) {
    this._failNextGetError = err;
  }

  _failNextSet(err) {
    this._failNextSetError = err;
  }

  get(keys, callback) {
    if (this._failNextError || this._failNextGetError) {
      const err = this._failNextError || this._failNextGetError;
      this._failNextError = null;
      this._failNextGetError = null;
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.lastError = { message: err.message };
      }
      if (typeof callback === 'function') {
        callback(null);
      }
      return Promise.reject(err);
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.lastError = null;
    }

    let result = {};
    if (keys === null || keys === undefined) {
      for (const [k, v] of this.store.entries()) {
        result[k] = deepClone(v);
      }
    } else if (typeof keys === 'string') {
      const v = this.store.get(keys);
      result[keys] = deepClone(v);
    } else if (Array.isArray(keys)) {
      for (const k of keys) {
        const v = this.store.get(k);
        result[k] = deepClone(v);
      }
    } else if (typeof keys === 'object') {
      for (const [k, defVal] of Object.entries(keys)) {
        const v = this.store.has(k) ? this.store.get(k) : defVal;
        result[k] = deepClone(v);
      }
    }

    if (typeof callback === 'function') {
      callback(result);
      return;
    }
    return Promise.resolve(result);
  }

  set(items, callback) {
    if (this._failNextError || this._failNextSetError) {
      const err = this._failNextError || this._failNextSetError;
      this._failNextError = null;
      this._failNextSetError = null;
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.lastError = { message: err.message };
      }
      if (typeof callback === 'function') {
        callback();
      }
      return Promise.reject(err);
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.lastError = null;
    }

    const changes = {};
    if (items && typeof items === 'object') {
      for (const [k, v] of Object.entries(items)) {
        const oldRaw = this.store.has(k) ? this.store.get(k) : undefined;
        const oldVal = deepClone(oldRaw);
        const newVal = deepClone(v);
        this.store.set(k, newVal);
        changes[k] = { oldValue: oldVal, newValue: newVal };
      }
    }

    // Trigger local listeners
    this._notifyListeners(changes, 'local');

    if (typeof callback === 'function') {
      callback();
      return;
    }
    return Promise.resolve();
  }

  remove(keys, callback) {
    if (this._failNextError) {
      const err = this._failNextError;
      this._failNextError = null;
      if (typeof callback === 'function') {
        callback();
        return;
      }
      return Promise.reject(err);
    }

    const arr = Array.isArray(keys) ? keys : [keys];
    const changes = {};
    for (const k of arr) {
      if (this.store.has(k)) {
        const oldVal = deepClone(this.store.get(k));
        this.store.delete(k);
        changes[k] = { oldValue: oldVal, newValue: undefined };
      }
    }

    this._notifyListeners(changes, 'local');

    if (typeof callback === 'function') {
      callback();
      return;
    }
    return Promise.resolve();
  }

  clear(callback) {
    const changes = {};
    for (const [k, v] of this.store.entries()) {
      changes[k] = { oldValue: deepClone(v), newValue: undefined };
    }
    this.store.clear();
    this._notifyListeners(changes, 'local');

    if (typeof callback === 'function') {
      callback();
      return;
    }
    return Promise.resolve();
  }

  _notifyListeners(changes, areaName = 'local') {
    if (!changes || Object.keys(changes).length === 0) return;
    for (const listener of [...this.changeListeners]) {
      try {
        listener(changes, areaName);
      } catch (err) {
        console.error('[MockChromeStorageArea] listener error:', err);
      }
    }
  }

  get onChanged() {
    return {
      addListener: (fn) => {
        if (typeof fn === 'function' && !this.changeListeners.includes(fn)) {
          this.changeListeners.push(fn);
        }
      },
      removeListener: (fn) => {
        const idx = this.changeListeners.indexOf(fn);
        if (idx !== -1) this.changeListeners.splice(idx, 1);
      },
      hasListener: (fn) => this.changeListeners.includes(fn),
      trigger: (changes, areaName = 'local') => this._notifyListeners(changes, areaName)
    };
  }
}

class MockChrome {
  constructor(initialTabs = null) {
    this.storage = {
      local: new MockChromeStorageArea(),
      onChanged: {
        addListener: (fn) => this.storage.local.changeListeners.push(fn),
        removeListener: (fn) => {
          const idx = this.storage.local.changeListeners.indexOf(fn);
          if (idx !== -1) this.storage.local.changeListeners.splice(idx, 1);
        },
        hasListener: (fn) => this.storage.local.changeListeners.includes(fn),
        trigger: (changes, areaName = 'local') => this.storage.local._notifyListeners(changes, areaName)
      }
    };

    this.runtime = {
      id: 'youtube-queue-plus-test-extension-id',
      lastError: null,
      sendMessage: (message, callback) => {
        if (callback) callback({ status: 'ok' });
        return Promise.resolve({ status: 'ok' });
      },
      onMessage: {
        _listeners: [],
        addListener: (fn) => this.runtime.onMessage._listeners.push(fn),
        removeListener: (fn) => {
          const idx = this.runtime.onMessage._listeners.indexOf(fn);
          if (idx !== -1) this.runtime.onMessage._listeners.splice(idx, 1);
        }
      }
    };

    this.tabs = {
      _tabs: initialTabs || [{ id: 101, url: 'https://www.youtube.com/', active: true }],
      query: (queryInfo, callback) => {
        let matched = [...this.tabs._tabs];
        if (queryInfo) {
          if (queryInfo.active !== undefined) {
            matched = matched.filter(t => Boolean(t.active) === Boolean(queryInfo.active));
          }
          if (queryInfo.currentWindow !== undefined) {
            // all test tabs match current window
          }
          if (queryInfo.url) {
            const pattern = typeof queryInfo.url === 'string' ? queryInfo.url : '';
            if (pattern) {
              matched = matched.filter(t => (t.url || '').includes(pattern.replace(/\*/g, '')));
            }
          }
        }
        if (typeof callback === 'function') {
          callback(matched);
        }
        return Promise.resolve(matched);
      },
      update: (tabId, updateProps, callback) => {
        let tab = null;
        if (tabId === undefined || tabId === null) {
          tab = this.tabs._tabs.find(t => t.active) || this.tabs._tabs[0];
        } else {
          tab = this.tabs._tabs.find(t => t.id === tabId);
        }

        if (tab && updateProps) {
          if (updateProps.url) tab.url = updateProps.url;
          if (updateProps.active !== undefined) tab.active = Boolean(updateProps.active);
        }

        if (typeof callback === 'function') {
          callback(tab);
        }
        return Promise.resolve(tab);
      },
      create: (createProps, callback) => {
        const newTab = {
          id: Math.floor(Math.random() * 10000) + 200,
          url: createProps?.url || 'about:blank',
          active: createProps?.active !== undefined ? Boolean(createProps.active) : true
        };
        this.tabs._tabs.push(newTab);
        if (typeof callback === 'function') {
          callback(newTab);
        }
        return Promise.resolve(newTab);
      }
    };

    this.action = {
      _badgeText: '',
      _badgeBackgroundColor: '',
      setBadgeText: (details, callback) => {
        this.action._badgeText = details?.text || '';
        if (typeof callback === 'function') callback();
        return Promise.resolve();
      },
      getBadgeText: (details, callback) => {
        if (typeof callback === 'function') callback(this.action._badgeText);
        return Promise.resolve(this.action._badgeText);
      },
      setBadgeBackgroundColor: (details, callback) => {
        this.action._badgeBackgroundColor = details?.color || '';
        if (typeof callback === 'function') callback();
        return Promise.resolve();
      }
    };
  }

  reset() {
    this.storage.local.store.clear();
    this.storage.local.changeListeners = [];
    this.tabs._tabs = [{ id: 101, url: 'https://www.youtube.com/', active: true }];
    this.action._badgeText = '';
  }
}

let _originalChrome = null;

function setupGlobalChrome(mockInstance) {
  const chromeInstance = mockInstance || new MockChrome();
  _originalChrome = globalThis.chrome;
  globalThis.chrome = chromeInstance;
  return chromeInstance;
}

function restoreGlobalChrome() {
  if (typeof _originalChrome !== 'undefined') {
    globalThis.chrome = _originalChrome;
    _originalChrome = null;
  } else {
    delete globalThis.chrome;
  }
}

module.exports = {
  MockChromeStorageArea,
  MockChrome,
  setupGlobalChrome,
  restoreGlobalChrome,
  deepClone
};
