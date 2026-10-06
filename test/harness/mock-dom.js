/**
/**
 * YoutubeQueuePlus - Modular Mock DOM Harness
 * Reusable mock DOM environment supporting:
 * - 3-phase event dispatching (capturing -> target -> bubbling)
 * - YouTube custom elements and attribute selectors
 * - MockMutationObserver with microtask delivery and synchronous flush
 * - Component hierarchy builders for YouTube feeds, playlist panels, menus, and popup UI
 */

// =============================================================================
// 1. Selector Engine (Simple, Compound, Descendant, and Grouped Selectors)
// =============================================================================

function matchSimpleSelector(el, sel) {
  if (!sel || !el || el.nodeType !== 1) return false;
  let s = sel.trim();

  // Pseudo-class :checked
  if (s.includes(':checked')) {
    if (!el.checked) return false;
    s = s.replace(':checked', '');
  }

  // Tag name
  const tagMatch = s.match(/^([a-zA-Z0-9_-]+)/);
  if (tagMatch) {
    if (el.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
    s = s.slice(tagMatch[1].length);
  }

  while (s.length > 0) {
    if (s.startsWith('#')) {
      const m = s.match(/^#([a-zA-Z0-9_-]+)/);
      if (!m) return false;
      if (el.getAttribute('id') !== m[1]) return false;
      s = s.slice(m[0].length);
    } else if (s.startsWith('.')) {
      const m = s.match(/^\.([a-zA-Z0-9_-]+)/);
      if (!m) return false;
      if (!el.classList.contains(m[1])) return false;
      s = s.slice(m[0].length);
    } else if (s.startsWith('[')) {
      const closeIdx = s.indexOf(']');
      if (closeIdx === -1) return false;
      let inner = s.slice(1, closeIdx).trim();
      s = s.slice(closeIdx + 1);

      let caseInsensitive = false;
      if (inner.endsWith(' i') || inner.endsWith(' I')) {
        caseInsensitive = true;
        inner = inner.slice(0, -2).trim();
      }

      if (inner.includes('*=')) {
        const [attr, rawVal] = inner.split('*=');
        let cleanVal = rawVal.trim().replace(/^["']|["']$/g, '');
        let actual = el.getAttribute(attr.trim());
        if (caseInsensitive) {
          cleanVal = cleanVal.toLowerCase();
          actual = (actual || '').toLowerCase();
        }
        if (!actual || !actual.includes(cleanVal)) return false;
      } else if (inner.includes('^=')) {
        const [attr, rawVal] = inner.split('^=');
        let cleanVal = rawVal.trim().replace(/^["']|["']$/g, '');
        let actual = el.getAttribute(attr.trim());
        if (caseInsensitive) {
          cleanVal = cleanVal.toLowerCase();
          actual = (actual || '').toLowerCase();
        }
        if (!actual || !actual.startsWith(cleanVal)) return false;
      } else if (inner.includes('$=')) {
        const [attr, rawVal] = inner.split('$=');
        let cleanVal = rawVal.trim().replace(/^["']|["']$/g, '');
        let actual = el.getAttribute(attr.trim());
        if (caseInsensitive) {
          cleanVal = cleanVal.toLowerCase();
          actual = (actual || '').toLowerCase();
        }
        if (!actual || !actual.endsWith(cleanVal)) return false;
      } else if (inner.includes('=')) {
        const [attr, rawVal] = inner.split('=');
        let cleanVal = rawVal.trim().replace(/^["']|["']$/g, '');
        let actual = el.getAttribute(attr.trim());
        if (caseInsensitive) {
          cleanVal = cleanVal.toLowerCase();
          actual = (actual || '').toLowerCase();
        }
        if (actual !== cleanVal) return false;
      } else {
        if (!el.hasAttribute(inner.trim())) return false;
      }
    } else {
      break;
    }
  }
  return s.length === 0;
}

function matchSelector(el, sel) {
  if (!sel || !el || el.nodeType !== 1) return false;
  const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    return parts.some(p => matchSelector(el, p));
  }

  const spaceParts = sel.trim().split(/\s+/);
  if (spaceParts.length > 1) {
    const targetSel = spaceParts[spaceParts.length - 1];
    if (!matchSimpleSelector(el, targetSel)) return false;
    let curr = el.parentNode;
    let i = spaceParts.length - 2;
    while (curr && i >= 0) {
      if (matchSimpleSelector(curr, spaceParts[i])) {
        i--;
      }
      curr = curr.parentNode;
    }
    return i < 0;
  }

  return matchSimpleSelector(el, sel);
}

// =============================================================================
// 2. Events & 3-Phase Event Dispatcher
// =============================================================================

class MockEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== undefined ? Boolean(init.bubbles) : true;
    this.cancelable = init.cancelable !== undefined ? Boolean(init.cancelable) : true;
    this.target = null;
    this.currentTarget = null;
    this.eventPhase = 0; // 0: NONE, 1: CAPTURING_PHASE, 2: AT_TARGET, 3: BUBBLING_PHASE
    this.defaultPrevented = false;
    this._propagationStopped = false;
    this._immediatePropagationStopped = false;
  }

  preventDefault() {
    if (this.cancelable) {
      this.defaultPrevented = true;
    }
  }

  stopPropagation() {
    this._propagationStopped = true;
  }

  stopImmediatePropagation() {
    this._propagationStopped = true;
    this._immediatePropagationStopped = true;
  }
}

class MockCustomEvent extends MockEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.detail = init.detail !== undefined ? init.detail : null;
  }
}

class MockEventTarget {
  constructor() {
    this._listeners = [];
  }

  addEventListener(type, callback, optionsOrCapture) {
    if (typeof callback !== 'function') return;
    const capture = typeof optionsOrCapture === 'boolean'
      ? optionsOrCapture
      : Boolean(optionsOrCapture?.capture);
    const once = Boolean(optionsOrCapture?.once);
    this._listeners.push({ type, callback, capture, once });
  }

  removeEventListener(type, callback, optionsOrCapture) {
    const capture = typeof optionsOrCapture === 'boolean'
      ? optionsOrCapture
      : Boolean(optionsOrCapture?.capture);
    this._listeners = this._listeners.filter(
      l => !(l.type === type && l.callback === callback && l.capture === capture)
    );
  }

  dispatchEvent(event) {
    if (!event || !event.type) return true;
    event.target = this;

    // 1. Construct propagation chain from root down to target
    const chain = [];
    let curr = this;
    while (curr) {
      chain.push(curr);
      curr = curr.parentNode;
    }
    chain.reverse();

    // 2. Phase 1: Capturing Phase (ancestors from root down to parent)
    for (let i = 0; i < chain.length - 1; i++) {
      const node = chain[i];
      event.currentTarget = node;
      event.eventPhase = 1;
      const capturing = (node._listeners || []).filter(l => l.type === event.type && l.capture === true);
      for (const entry of capturing) {
        if (entry.once) {
          node.removeEventListener(entry.type, entry.callback, entry.capture);
        }
        entry.callback.call(node, event);
        if (event._immediatePropagationStopped) break;
      }
      if (event._propagationStopped || event._immediatePropagationStopped) break;
    }

    // 3. Phase 2: Target Phase (target element)
    if (!event._propagationStopped && !event._immediatePropagationStopped) {
      const targetNode = chain[chain.length - 1];
      event.currentTarget = targetNode;
      event.eventPhase = 2;
      const atTarget = (targetNode._listeners || []).filter(l => l.type === event.type);
      for (const entry of atTarget) {
        if (entry.once) {
          targetNode.removeEventListener(entry.type, entry.callback, entry.capture);
        }
        entry.callback.call(targetNode, event);
        if (event._immediatePropagationStopped) break;
      }
    }

    // 4. Phase 3: Bubbling Phase (parent back up to root)
    if (event.bubbles && !event._propagationStopped && !event._immediatePropagationStopped) {
      for (let i = chain.length - 2; i >= 0; i--) {
        const node = chain[i];
        event.currentTarget = node;
        event.eventPhase = 3;
        const bubbling = (node._listeners || []).filter(l => l.type === event.type && l.capture === false);
        for (const entry of bubbling) {
          if (entry.once) {
            node.removeEventListener(entry.type, entry.callback, entry.capture);
          }
          entry.callback.call(node, event);
          if (event._immediatePropagationStopped) break;
        }
        if (event._propagationStopped || event._immediatePropagationStopped) break;
      }
    }

    event.currentTarget = null;
    event.eventPhase = 0;
    return !event.defaultPrevented;
  }
}

// =============================================================================
// 3. MutationObserver Mock
// =============================================================================

class MockMutationRecord {
  constructor({ type, target, addedNodes = [], removedNodes = [], attributeName = null, oldValue = null }) {
    this.type = type;
    this.target = target;
    this.addedNodes = addedNodes;
    this.removedNodes = removedNodes;
    this.attributeName = attributeName;
    this.oldValue = oldValue;
  }
}

class MockMutationObserver {
  static _activeObservers = new Set();

  constructor(callback) {
    this.callback = callback;
    this.targets = new Map();
    this._queue = [];
    MockMutationObserver._activeObservers.add(this);
  }

  observe(target, options = {}) {
    if (!target) return;
    this.targets.set(target, {
      childList: Boolean(options.childList),
      attributes: Boolean(options.attributes),
      subtree: Boolean(options.subtree),
      attributeFilter: Array.isArray(options.attributeFilter) ? options.attributeFilter : null
    });
  }

  disconnect() {
    this.targets.clear();
    this._queue = [];
    MockMutationObserver._activeObservers.delete(this);
  }

  takeRecords() {
    const records = [...this._queue];
    this._queue = [];
    return records;
  }

  _enqueue(record) {
    this._queue.push(record);
    if (this._queue.length === 1) {
      queueMicrotask(() => {
        if (this._queue.length > 0) {
          const records = this.takeRecords();
          try {
            this.callback(records, this);
          } catch (err) {
            console.error('[MockMutationObserver] callback error:', err);
          }
        }
      });
    }
  }

  static _notify(record) {
    for (const obs of MockMutationObserver._activeObservers) {
      for (const [target, options] of obs.targets.entries()) {
        const isTarget = (record.target === target);
        const isSubtree = options.subtree && (target.contains ? target.contains(record.target) : false);

        if (!isTarget && !isSubtree) continue;

        if (record.type === 'childList' && options.childList) {
          obs._enqueue(record);
          break;
        } else if (record.type === 'attributes' && options.attributes) {
          if (!options.attributeFilter || options.attributeFilter.includes(record.attributeName)) {
            obs._enqueue(record);
            break;
          }
        }
      }
    }
  }

  static flush() {
    for (const obs of MockMutationObserver._activeObservers) {
      if (obs._queue.length > 0) {
        const records = obs.takeRecords();
        try {
          obs.callback(records, obs);
        } catch (err) {
          console.error('[MockMutationObserver] flush callback error:', err);
        }
      }
    }
  }
}

// =============================================================================
// 4. MockElement and MockDocument
// =============================================================================

class MockElement extends MockEventTarget {
  constructor(tagName = 'div') {
    super();
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this._classList = new Set();
    const self = this;
    this.classList = {
      add: (...tokens) => tokens.forEach(t => self._classList.add(t)),
      remove: (...tokens) => tokens.forEach(t => self._classList.delete(t)),
      contains: (token) => self._classList.has(token),
      toggle: (token) => {
        if (self._classList.has(token)) {
          self._classList.delete(token);
          return false;
        }
        self._classList.add(token);
        return true;
      }
    };
    this.style = {};
    this._textContent = '';
    this._checked = false;
    this._disabled = false;
    this._value = '';
    this._type = '';
    this._name = '';
  }

  get parentElement() { return this.parentNode; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    if (idx !== -1 && idx + 1 < this.parentNode.children.length) {
      return this.parentNode.children[idx + 1];
    }
    return null;
  }
  get childNodes() { return [...this.children]; }

  get dataset() {
    const dataObj = {};
    for (const [attr, val] of this.attributes.entries()) {
      if (attr.startsWith('data-')) {
        const key = attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        dataObj[key] = val;
      }
    }
    return dataObj;
  }

  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }

  get className() { return Array.from(this._classList).join(' '); }
  set className(v) {
    this._classList.clear();
    if (v) String(v).split(/\s+/).filter(Boolean).forEach(c => this._classList.add(c));
    this.attributes.set('class', this.className);
  }

  get href() { return this.getAttribute('href') || ''; }
  set href(v) { this.setAttribute('href', v); }

  get checked() { return this._checked; }
  set checked(v) {
    this._checked = Boolean(v);
    if (this._checked && (this.type === 'radio' || this.getAttribute('type') === 'radio')) {
      let root = this.parentNode;
      while (root && root.parentNode) {
        root = root.parentNode;
      }
      if (root && root.querySelectorAll) {
        const name = this.name;
        if (name) {
          const siblings = root.querySelectorAll(`input[name="${name}"]`);
          for (const s of siblings) {
            if (s !== this) s._checked = false;
          }
        }
      }
    }
  }

  get disabled() { return this._disabled; }
  set disabled(v) { this._disabled = Boolean(v); }

  get value() { return this.getAttribute('value') || this._value; }
  set value(v) {
    this._value = String(v);
    this.attributes.set('value', String(v));
  }

  get type() { return this.getAttribute('type') || this._type; }
  set type(v) {
    this._type = String(v);
    this.attributes.set('type', String(v));
  }

  get name() { return this.getAttribute('name') || this._name; }
  set name(v) {
    this._name = String(v);
    this.attributes.set('name', String(v));
  }

  get textContent() {
    if (this.children.length === 0) return this._textContent;
    return this.children.map(c => c.textContent).join('');
  }
  set textContent(v) {
    this.children = [];
    this._textContent = String(v);
  }

  setAttribute(name, value) {
    const oldVal = this.getAttribute(name);
    this.attributes.set(name, String(value));
    if (name === 'class') {
      this._classList.clear();
      String(value).split(/\s+/).filter(Boolean).forEach(c => this._classList.add(c));
    }
    if (name === 'value') this._value = String(value);
    if (name === 'name') this._name = String(value);
    if (name === 'type') this._type = String(value);

    MockMutationObserver._notify(new MockMutationRecord({
      type: 'attributes',
      target: this,
      attributeName: name,
      oldValue: oldVal
    }));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    const oldVal = this.getAttribute(name);
    this.attributes.delete(name);
    if (name === 'class') this._classList.clear();

    MockMutationObserver._notify(new MockMutationRecord({
      type: 'attributes',
      target: this,
      attributeName: name,
      oldValue: oldVal
    }));
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);

    MockMutationObserver._notify(new MockMutationRecord({
      type: 'childList',
      target: this,
      addedNodes: [child],
      removedNodes: []
    }));
    return child;
  }

  insertBefore(newChild, refChild) {
    if (!newChild) return newChild;
    if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
    newChild.parentNode = this;
    if (!refChild) {
      this.children.push(newChild);
    } else {
      const idx = this.children.indexOf(refChild);
      if (idx === -1) {
        this.children.push(newChild);
      } else {
        this.children.splice(idx, 0, newChild);
      }
    }

    MockMutationObserver._notify(new MockMutationRecord({
      type: 'childList',
      target: this,
      addedNodes: [newChild],
      removedNodes: []
    }));
    return newChild;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;

      MockMutationObserver._notify(new MockMutationRecord({
        type: 'childList',
        target: this,
        addedNodes: [],
        removedNodes: [child]
      }));
      return child;
    }
    return null;
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  contains(node) {
    let curr = node;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentNode;
    }
    return false;
  }

  matches(selector) {
    return matchSelector(this, selector);
  }

  closest(selector) {
    let curr = this;
    while (curr && curr.nodeType === 1) {
      if (curr.matches && curr.matches(selector)) return curr;
      curr = curr.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.nodeType === 1) {
        if (child.matches(selector)) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    const traverse = (node) => {
      for (const child of node.children) {
        if (child.nodeType === 1) {
          if (child.matches(selector)) results.push(child);
          traverse(child);
        }
      }
    };
    traverse(this);
    return results;
  }

  click() {
    const ev = new MockEvent('click', { bubbles: true, cancelable: true });
    return this.dispatchEvent(ev);
  }
}

class MockDocument extends MockEventTarget {
  constructor() {
    super();
    this.nodeType = 9;
    this.documentElement = new MockElement('html');
    this.body = new MockElement('body');
    this.documentElement.appendChild(this.body);
    this.documentElement.parentNode = this;
    this.body.parentNode = this.documentElement;
    this.readyState = 'complete';
  }

  createElement(tagName) {
    return new MockElement(tagName);
  }

  createTextNode(text) {
    const el = new MockElement('span');
    el.textContent = text;
    return el;
  }

  querySelector(sel) {
    if (this.documentElement.matches(sel)) return this.documentElement;
    if (this.body.matches(sel)) return this.body;
    return this.documentElement.querySelector(sel);
  }

  querySelectorAll(sel) {
    const res = [];
    if (this.documentElement.matches(sel)) res.push(this.documentElement);
    if (this.body.matches(sel)) res.push(this.body);
    return res.concat(this.documentElement.querySelectorAll(sel));
  }

  getElementById(id) {
    return this.querySelector(`#${id}`);
  }
}

class MockWindow extends MockEventTarget {
  constructor(doc) {
    super();
    this.document = doc || new MockDocument();
    this.location = { href: 'https://www.youtube.com/' };
    this.history = {
      pushState: (state, title, url) => {
        if (url) this.location.href = url;
      },
      replaceState: (state, title, url) => {
        if (url) this.location.href = url;
      }
    };
    this._closed = false;
    this._openedUrls = [];
  }

  close() {
    this._closed = true;
  }

  open(url, target) {
    this._openedUrls.push({ url, target });
    return {};
  }
}

// =============================================================================
// 5. YouTube DOM Component Factories
// =============================================================================

/**
 * Creates standard YouTube Page DOM container hierarchy.
 */
function createYouTubePageDOM(docInstance) {
  const doc = docInstance || new MockDocument();

  const app = doc.createElement('ytd-app');
  doc.body.appendChild(app);

  const masthead = doc.createElement('ytd-masthead');
  masthead.id = 'masthead-container';
  app.appendChild(masthead);

  const pageManager = doc.createElement('ytd-page-manager');
  pageManager.id = 'page-manager';
  app.appendChild(pageManager);

  const richGrid = doc.createElement('ytd-rich-grid-renderer');
  const contents = doc.createElement('div');
  contents.id = 'contents';
  richGrid.appendChild(contents);
  pageManager.appendChild(richGrid);

  const popupContainer = doc.createElement('ytd-popup-container');
  doc.body.appendChild(popupContainer);

  return { doc, app, masthead, pageManager, richGrid, contents, popupContainer };
}

/**
 * Creates a mock YouTube feed card (home, browse, search, related).
 */
function createMockFeedCard(doc, videoId, options = {}) {
  const tagName = options.tagName || 'ytd-rich-item-renderer';
  const card = doc.createElement(tagName);
  if (videoId) {
    card.setAttribute('data-yqp-video-id', videoId);
  }

  // Thumbnail container
  const thumbContainer = doc.createElement('div');
  thumbContainer.id = 'thumbnail';
  thumbContainer.className = 'ytd-thumbnail';

  // Video thumbnail link
  if (videoId && !options.noLink) {
    const thumbLink = doc.createElement('a');
    thumbLink.id = 'thumbnail';
    thumbLink.href = `/watch?v=${videoId}`;
    thumbContainer.appendChild(thumbLink);
  }

  // Overlays with "Add to queue" hover toggle button
  const overlays = doc.createElement('div');
  overlays.id = 'overlays';

  const overlayBtn = doc.createElement('ytd-thumbnail-overlay-toggle-button-renderer');
  overlayBtn.setAttribute('aria-label', options.overlayAriaLabel || 'Add to queue');

  const innerIconBtn = doc.createElement('yt-icon-button');
  const innerBtn = doc.createElement('button');
  innerBtn.setAttribute('aria-label', options.overlayAriaLabel || 'Add to queue');
  const icon = doc.createElement('yt-icon');

  innerBtn.appendChild(icon);
  innerIconBtn.appendChild(innerBtn);
  overlayBtn.appendChild(innerIconBtn);
  overlays.appendChild(overlayBtn);
  thumbContainer.appendChild(overlays);
  card.appendChild(thumbContainer);

  // 3-Dot Action Menu Button on Card
  const menuRenderer = doc.createElement('ytd-menu-renderer');
  const menuIconBtn = doc.createElement('yt-icon-button');
  const menuBtn = doc.createElement('button');
  menuBtn.setAttribute('aria-label', 'Action menu');
  menuBtn.className = 'yt-icon-button';
  menuIconBtn.appendChild(menuBtn);
  menuRenderer.appendChild(menuIconBtn);
  card.appendChild(menuRenderer);

  // Video Details & Title Link
  const details = doc.createElement('div');
  details.id = 'details';
  const titleLink = doc.createElement('a');
  titleLink.id = 'video-title-link';
  if (videoId && !options.noLink) {
    titleLink.href = `/watch?v=${videoId}`;
  }
  titleLink.textContent = options.title || `Video ${videoId}`;
  details.appendChild(titleLink);
  card.appendChild(details);

  return { card, thumbContainer, overlayBtn, innerBtn, icon, menuBtn, menuIconBtn, titleLink };
}

/**
 * Creates a mock YouTube Playlist Panel (`ytd-playlist-panel-renderer` or `ytd-miniplayer`).
 */
function createMockPlaylistPanel(doc, videoIds = [], selectedIndex = 0, options = {}) {
  const panel = doc.createElement(options.isMiniplayer ? 'ytd-miniplayer' : 'ytd-playlist-panel-renderer');
  if (options.isMiniplayer) {
    panel.setAttribute('active', '');
    const innerPanel = doc.createElement('ytd-playlist-panel-renderer');
    innerPanel.setAttribute('within-miniplayer', '');
    panel.appendChild(innerPanel);
  }

  const hostPanel = options.isMiniplayer ? panel.querySelector('ytd-playlist-panel-renderer') : panel;
  const itemsContainer = doc.createElement('div');
  itemsContainer.id = 'items';
  itemsContainer.className = 'ytd-playlist-panel-renderer';
  hostPanel.appendChild(itemsContainer);

  const videoRenderers = [];
  videoIds.forEach((id, idx) => {
    const item = doc.createElement('ytd-playlist-panel-video-renderer');
    item.setAttribute('data-yqp-video-id', id);
    if (idx === selectedIndex) {
      item.setAttribute('selected', '');
    }

    const endpoint = doc.createElement('a');
    endpoint.id = 'wc-endpoint';
    endpoint.href = `/watch?v=${id}&index=${idx}`;

    const titleSpan = doc.createElement('span');
    titleSpan.id = 'video-title';
    titleSpan.textContent = `Queue Video ${idx + 1}`;
    endpoint.appendChild(titleSpan);

    item.appendChild(endpoint);
    itemsContainer.appendChild(item);
    videoRenderers.push(item);
  });

  return { panel, hostPanel, itemsContainer, videoRenderers };
}

/**
 * Creates a mock YouTube 3-Dot Dropdown Menu Popup.
 */
function createMockDropdownMenu(doc, options = {}) {
  const popup = doc.createElement('ytd-popup-container');
  const menuPopup = doc.createElement('ytd-menu-popup-renderer');
  const listbox = doc.createElement('tp-yt-paper-listbox');

  // "Add to queue" service item
  const queueItem = doc.createElement('ytd-menu-service-item-renderer');
  const queuePaperItem = doc.createElement('tp-yt-paper-item');
  const queueLabel = doc.createElement('yt-formatted-string');
  queueLabel.textContent = options.queueLabel || 'Add to queue';
  queuePaperItem.appendChild(queueLabel);
  queueItem.appendChild(queuePaperItem);
  listbox.appendChild(queueItem);

  // Secondary non-queue service item (e.g. Save to Watch later)
  const watchLaterItem = doc.createElement('ytd-menu-service-item-renderer');
  const wlPaperItem = doc.createElement('tp-yt-paper-item');
  const wlLabel = doc.createElement('yt-formatted-string');
  wlLabel.textContent = 'Save to Watch later';
  wlPaperItem.appendChild(wlLabel);
  watchLaterItem.appendChild(wlPaperItem);
  listbox.appendChild(watchLaterItem);

  menuPopup.appendChild(listbox);
  popup.appendChild(menuPopup);
  doc.body.appendChild(popup);

  return { popup, menuPopup, listbox, queueItem, queueLabel, watchLaterItem };
}

/**
 * Creates mock Popup UI DOM according to popup.html specification.
 */
function createPopupDOM(docInstance) {
  const doc = docInstance || new MockDocument();

  // Active queue metrics
  const queueCount = doc.createElement('span');
  queueCount.id = 'queueCount';
  queueCount.textContent = '0 videos';
  doc.body.appendChild(queueCount);

  const playingIndex = doc.createElement('span');
  playingIndex.id = 'playingIndex';
  playingIndex.textContent = '—';
  doc.body.appendChild(playingIndex);

  const queueLivePill = doc.createElement('span');
  queueLivePill.id = 'queueLivePill';
  queueLivePill.className = 'live-pill idle';
  queueLivePill.textContent = 'IDLE';
  doc.body.appendChild(queueLivePill);

  // Treatment mode radios
  const radioBadgeAndDim = doc.createElement('input');
  radioBadgeAndDim.type = 'radio';
  radioBadgeAndDim.name = 'feedTreatmentMode';
  radioBadgeAndDim.value = 'badge_and_dim';
  radioBadgeAndDim.id = 'modeBadgeAndDim';
  radioBadgeAndDim.checked = true;
  doc.body.appendChild(radioBadgeAndDim);

  const radioHide = doc.createElement('input');
  radioHide.type = 'radio';
  radioHide.name = 'feedTreatmentMode';
  radioHide.value = 'hide';
  radioHide.id = 'modeHide';
  doc.body.appendChild(radioHide);

  const radioBadgeOnly = doc.createElement('input');
  radioBadgeOnly.type = 'radio';
  radioBadgeOnly.name = 'feedTreatmentMode';
  radioBadgeOnly.value = 'badge_only';
  radioBadgeOnly.id = 'modeBadgeOnly';
  doc.body.appendChild(radioBadgeOnly);

  // Saved session metrics
  const savedCount = doc.createElement('span');
  savedCount.id = 'savedCount';
  savedCount.textContent = 'None';
  doc.body.appendChild(savedCount);

  const savedTime = doc.createElement('span');
  savedTime.id = 'savedTime';
  savedTime.textContent = '—';
  doc.body.appendChild(savedTime);

  const sessionStatusPill = doc.createElement('span');
  sessionStatusPill.id = 'sessionStatusPill';
  sessionStatusPill.className = 'status-pill none';
  sessionStatusPill.textContent = 'NONE';
  doc.body.appendChild(sessionStatusPill);

  const restoreBtn = doc.createElement('button');
  restoreBtn.id = 'restoreBtn';
  restoreBtn.disabled = true;
  doc.body.appendChild(restoreBtn);

  return {
    doc,
    queueCount,
    playingIndex,
    queueLivePill,
    radioBadgeAndDim,
    radioHide,
    radioBadgeOnly,
    savedCount,
    savedTime,
    sessionStatusPill,
    restoreBtn
  };
}

// =============================================================================
// 6. Global Environment Helpers
// =============================================================================

let _originalGlobals = null;

function setupGlobalDOM(options = {}) {
  const doc = options.document || new MockDocument();
  const win = options.window || new MockWindow(doc);

  _originalGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    MutationObserver: globalThis.MutationObserver,
    Event: globalThis.Event,
    CustomEvent: globalThis.CustomEvent
  };

  globalThis.document = doc;
  globalThis.window = win;
  globalThis.MutationObserver = MockMutationObserver;
  globalThis.Event = MockEvent;
  globalThis.CustomEvent = MockCustomEvent;

  return { doc, win };
}

function restoreGlobalDOM() {
  if (_originalGlobals) {
    globalThis.document = _originalGlobals.document;
    globalThis.window = _originalGlobals.window;
    globalThis.MutationObserver = _originalGlobals.MutationObserver;
    globalThis.Event = _originalGlobals.Event;
    globalThis.CustomEvent = _originalGlobals.CustomEvent;
    _originalGlobals = null;
  }
  MockMutationObserver._activeObservers.clear();
}

module.exports = {
  MockEvent,
  MockCustomEvent,
  MockEventTarget,
  MockMutationRecord,
  MockMutationObserver,
  MockElement,
  MockDocument,
  MockWindow,
  matchSelector,
  matchSimpleSelector,
  createYouTubePageDOM,
  createMockFeedCard,
  createMockPlaylistPanel,
  createMockDropdownMenu,
  createPopupDOM,
  setupGlobalDOM,
  restoreGlobalDOM
};
