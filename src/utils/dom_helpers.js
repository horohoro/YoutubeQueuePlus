/**
 * YoutubeQueuePlus - DOM Helpers Utility
 * Safe query selectors, dataset manipulation, debouncing, and throttling in UMD pattern.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.__YQP__ = root.__YQP__ || {};
    root.__YQP__.DomHelpers = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Converts camelCase string to kebab-case
   * @param {string} str
   * @returns {string}
   */
  function toKebabCase(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  }

  /**
   * Safely queries a single DOM element matching selector within context.
   * Never throws if selector is invalid or context is missing.
   * @param {string} selector - CSS selector
   * @param {ParentNode|Element|Document} [context=document] - Search context
   * @returns {Element|null}
   */
  function safeQuery(selector, context) {
    const ctx = context || (typeof document !== 'undefined' ? document : null);
    if (!ctx || typeof ctx.querySelector !== 'function' || typeof selector !== 'string' || !selector.trim()) {
      return null;
    }
    try {
      return ctx.querySelector(selector);
    } catch (_) {
      return null;
    }
  }

  /**
   * Safely queries all DOM elements matching selector within context.
   * Always returns a static JavaScript Array (never a live NodeList).
   * @param {string} selector - CSS selector
   * @param {ParentNode|Element|Document} [context=document] - Search context
   * @returns {Element[]}
   */
  function safeQueryAll(selector, context) {
    const ctx = context || (typeof document !== 'undefined' ? document : null);
    if (!ctx || typeof ctx.querySelectorAll !== 'function' || typeof selector !== 'string' || !selector.trim()) {
      return [];
    }
    try {
      const nodeList = ctx.querySelectorAll(selector);
      return Array.from(nodeList);
    } catch (_) {
      return [];
    }
  }

  /**
   * Safely checks if element matches selector.
   * @param {Element} element
   * @param {string} selector
   * @returns {boolean}
   */
  function matches(element, selector) {
    if (!element || typeof selector !== 'string') return false;
    const fn = element.matches || element.webkitMatchesSelector || element.msMatchesSelector;
    if (typeof fn === 'function') {
      try {
        return fn.call(element, selector);
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  /**
   * Safely traverses up DOM hierarchy to find nearest ancestor matching selector.
   * @param {Element} element
   * @param {string} selector
   * @returns {Element|null}
   */
  function closest(element, selector) {
    if (!element || typeof selector !== 'string' || !selector.trim()) return null;
    if (typeof element.closest === 'function') {
      try {
        return element.closest(selector);
      } catch (_) {
        // Fall back to parent traversal
      }
    }
    let curr = element;
    while (curr && (curr.nodeType === 1 || curr.tagName)) {
      if (matches(curr, selector)) return curr;
      curr = curr.parentElement || curr.parentNode;
    }
    return null;
  }

  /**
   * Formats a data attribute key into a 'data-yqp-*' attribute name.
   * Accepts both camelCase ('videoId') and kebab-case ('video-id').
   * @param {string} key
   * @returns {string}
   */
  function formatYqpAttributeName(key) {
    if (typeof key !== 'string') return '';
    const cleanKey = toKebabCase(key);
    if (cleanKey.startsWith('data-yqp-')) {
      return cleanKey;
    }
    if (cleanKey.startsWith('yqp-')) {
      return 'data-' + cleanKey;
    }
    return 'data-yqp-' + cleanKey;
  }

  /**
   * Sets custom 'data-yqp-*' attribute on element safely.
   * @param {Element} element
   * @param {string} key - e.g. 'status', 'mode', 'videoId'
   * @param {string|number|boolean} value
   */
  function setDataset(element, key, value) {
    if (!element || typeof element.setAttribute !== 'function') return;
    const attrName = formatYqpAttributeName(key);
    if (!attrName) return;
    element.setAttribute(attrName, String(value));
  }

  /**
   * Gets custom 'data-yqp-*' attribute value from element safely.
   * @param {Element} element
   * @param {string} key - e.g. 'status', 'mode', 'videoId'
   * @returns {string|null}
   */
  function getDataset(element, key) {
    if (!element || typeof element.getAttribute !== 'function') return null;
    const attrName = formatYqpAttributeName(key);
    if (!attrName) return null;
    return element.getAttribute(attrName);
  }

  /**
   * Removes custom 'data-yqp-*' attribute from element safely.
   * @param {Element} element
   * @param {string} key
   */
  function removeDataset(element, key) {
    if (!element || typeof element.removeAttribute !== 'function') return;
    const attrName = formatYqpAttributeName(key);
    if (!attrName) return;
    element.removeAttribute(attrName);
  }

  /**
   * Checks if element has custom 'data-yqp-*' attribute.
   * @param {Element} element
   * @param {string} key
   * @returns {boolean}
   */
  function hasDataset(element, key) {
    if (!element || typeof element.hasAttribute !== 'function') return false;
    const attrName = formatYqpAttributeName(key);
    if (!attrName) return false;
    return element.hasAttribute(attrName);
  }

  /**
   * Debounces a function execution with optional immediate invocation.
   * Returns wrapped function augmented with .cancel(), .flush(), and .isPending().
   * @param {Function} fn - Function to debounce
   * @param {number} [wait=300] - Delay in milliseconds
   * @param {boolean|Object} [options=false] - If true, immediate=true. Or options object { immediate: bool }
   * @returns {Function}
   */
  function debounce(fn, wait = 300, options = false) {
    if (typeof fn !== 'function') {
      throw new TypeError('Expected a function to debounce');
    }
    const immediate = typeof options === 'boolean' ? options : Boolean(options && options.immediate);
    let timeoutId = null;
    let lastArgs = null;
    let lastThis = null;
    let lastResult = undefined;

    function debounced(...args) {
      lastArgs = args;
      lastThis = this;
      const callNow = immediate && !timeoutId;

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      timeoutId = setTimeout(() => {
        timeoutId = null;
        if (!immediate) {
          lastResult = fn.apply(lastThis, lastArgs);
        }
      }, wait);

      if (callNow) {
        lastResult = fn.apply(lastThis, lastArgs);
      }

      return lastResult;
    }

    debounced.cancel = function () {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      lastArgs = null;
      lastThis = null;
    };

    debounced.flush = function () {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
        if (!immediate) {
          lastResult = fn.apply(lastThis, lastArgs);
        }
      }
      return lastResult;
    };

    debounced.isPending = function () {
      return timeoutId !== null;
    };

    return debounced;
  }

  /**
   * Throttles a function execution to at most once per wait window.
   * Supports leading and trailing execution.
   * Returns wrapped function with .cancel().
   * @param {Function} fn - Function to throttle
   * @param {number} [wait=100] - Interval in milliseconds
   * @returns {Function}
   */
  function throttle(fn, wait = 100) {
    if (typeof fn !== 'function') {
      throw new TypeError('Expected a function to throttle');
    }
    let timeoutId = null;
    let lastArgs = null;
    let lastThis = null;
    let lastCallTime = 0;

    function throttled(...args) {
      const now = Date.now();
      lastArgs = args;
      lastThis = this;
      const remaining = wait - (now - lastCallTime);

      if (remaining <= 0 || remaining > wait) {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        lastCallTime = now;
        return fn.apply(lastThis, lastArgs);
      } else if (!timeoutId) {
        timeoutId = setTimeout(() => {
          lastCallTime = Date.now();
          timeoutId = null;
          fn.apply(lastThis, lastArgs);
        }, remaining);
      }
    }

    throttled.cancel = function () {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      lastCallTime = 0;
      lastArgs = null;
      lastThis = null;
    };

    return throttled;
  }

  /**
   * Safely creates an element and applies attributes, styles, dataset, and children.
   * @param {string} tagName
   * @param {Object} [props={}]
   * @param {Array<Element|string>} [children=[]]
   * @returns {Element}
   */
  function createElement(tagName, props = {}, children = []) {
    if (typeof document === 'undefined') {
      throw new Error('document is not defined');
    }
    const el = document.createElement(tagName);

    if (props) {
      for (const [key, val] of Object.entries(props)) {
        if (key === 'className' || key === 'class') {
          if (typeof val === 'string') {
            val.split(/\s+/).filter(Boolean).forEach(c => el.classList.add(c));
          }
        } else if (key === 'dataset' && typeof val === 'object' && val !== null) {
          for (const [dKey, dVal] of Object.entries(val)) {
            setDataset(el, dKey, dVal);
          }
        } else if (key === 'style' && typeof val === 'object' && val !== null) {
          Object.assign(el.style, val);
        } else if (key === 'textContent' || key === 'innerText') {
          el.textContent = String(val);
        } else if (key === 'innerHTML') {
          el.innerHTML = String(val);
        } else if (val !== null && val !== undefined) {
          el.setAttribute(key, String(val));
        }
      }
    }

    if (Array.isArray(children)) {
      for (const child of children) {
        if (typeof child === 'string' || typeof child === 'number') {
          el.appendChild(document.createTextNode(String(child)));
        } else if (child && (child.nodeType || child.tagName)) {
          el.appendChild(child);
        }
      }
    }

    return el;
  }

  /**
   * Safely removes element from DOM.
   * @param {Element} element
   * @returns {boolean} true if removed, false otherwise
   */
  function removeElement(element) {
    if (!element) return false;
    if (typeof element.remove === 'function') {
      element.remove();
      return true;
    }
    if (element.parentNode && typeof element.parentNode.removeChild === 'function') {
      element.parentNode.removeChild(element);
      return true;
    }
    return false;
  }

  return Object.freeze({
    toKebabCase,
    safeQuery,
    safeQueryAll,
    matches,
    closest,
    formatYqpAttributeName,
    setDataset,
    getDataset,
    removeDataset,
    hasDataset,
    debounce,
    throttle,
    createElement,
    removeElement
  });
});
