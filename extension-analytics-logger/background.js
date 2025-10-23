// Background Service Worker
// Intercepts network requests and captures analytics events

import { AnalyticsParser } from './parsers.js';
import { EventStorage } from './storage.js';

// Initialize storage
const storage = new EventStorage(1000);

// Settings
let settings = {
  enabled: true,
  captureSegment: true,
  captureGA: true,
  captureGraphQL: true,
  captureCustom: true,
  persistEvents: false,
  maxEvents: 1000,
  useDebugger: false,  // Deep inspection mode for extension requests
  debuggerTabId: null,
  useProxy: false,     // Poll local proxy server for events
  urlPatterns: [
    'segment',
    'analytics',
    'google-analytics',
    'graphql',
    'api',
    '/v1/batch',      // Segment batch endpoint
    '/v1/track',      // Segment track endpoint
    'pie.org',        // Pie production domain
    'pie-staging',    // Pie staging domain
    '/collect',       // Google Analytics
    '/events'         // Common analytics endpoint
  ]
};

// Load settings on startup and then register listener
async function initialize() {
  console.log('[Analytics Logger] Initializing...');

  // Load settings first
  const result = await chrome.storage.local.get('settings');
  if (result.settings) {
    settings = { ...settings, ...result.settings };
    console.log('[Analytics Logger] Loaded settings:', settings);
  } else {
    console.log('[Analytics Logger] Using default settings:', settings);
  }

  // Load persisted events if enabled
  if (settings.persistEvents) {
    await storage.loadFromStorage();
  }

  console.log('[Analytics Logger] Initialization complete');
  console.log('[Analytics Logger] Active URL patterns:', settings.urlPatterns);

  // Start debugger mode if enabled
  if (settings.useDebugger && settings.debuggerTabId) {
    await enableDebuggerMode(settings.debuggerTabId);
  }

  // Start proxy polling if enabled
  if (settings.useProxy) {
    startProxyPolling();
  }
}

// Proxy Mode - Poll local proxy server for captured events
let proxyPollingInterval = null;
const PROXY_URL = 'http://localhost:8889/events';
const PROXY_POLL_INTERVAL = 2000; // 2 seconds

function startProxyPolling() {
  if (proxyPollingInterval) return;

  console.log('[Analytics Logger] Starting proxy polling...');

  proxyPollingInterval = setInterval(async () => {
    try {
      const response = await fetch(PROXY_URL);
      if (!response.ok) return;

      const data = await response.json();

      if (data.events && data.events.length > 0) {
        // Get events we haven't seen yet
        const newEvents = data.events.filter(event => {
          return !storage.events.some(existing => existing.id === event.id);
        });

        if (newEvents.length > 0) {
          console.log(`[Analytics Logger] [Proxy] Received ${newEvents.length} new events`);
          storage.addEvents(newEvents);
          notifyPanels('eventsAdded', newEvents);
        }
      }
    } catch (err) {
      // Silent fail - proxy might not be running
    }
  }, PROXY_POLL_INTERVAL);
}

function stopProxyPolling() {
  if (proxyPollingInterval) {
    clearInterval(proxyPollingInterval);
    proxyPollingInterval = null;
    console.log('[Analytics Logger] Stopped proxy polling');
  }
}

// Initialize immediately
initialize();

// Debugger Mode - Captures ALL network requests including from extensions
let debuggerAttached = false;
const debuggerRequests = new Map();

async function enableDebuggerMode(tabId) {
  try {
    if (debuggerAttached) {
      console.log('[Analytics Logger] Debugger already attached');
      return;
    }

    // Attach debugger
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerAttached = true;
    console.log('[Analytics Logger] Debugger attached to tab:', tabId);

    // Enable Network domain
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    console.log('[Analytics Logger] Network monitoring enabled');

    settings.debuggerTabId = tabId;
    await chrome.storage.local.set({ settings });
  } catch (err) {
    console.error('[Analytics Logger] Error enabling debugger:', err);
    debuggerAttached = false;
  }
}

async function disableDebuggerMode() {
  if (!debuggerAttached || !settings.debuggerTabId) return;

  try {
    await chrome.debugger.detach({ tabId: settings.debuggerTabId });
    debuggerAttached = false;
    settings.debuggerTabId = null;
    await chrome.storage.local.set({ settings });
    console.log('[Analytics Logger] Debugger detached');
  } catch (err) {
    console.error('[Analytics Logger] Error detaching debugger:', err);
  }
}

// Listen for debugger events
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!settings.enabled || !settings.useDebugger) return;

  // Capture request data
  if (method === 'Network.requestWillBeSent') {
    const request = params.request;

    if (request.method === 'POST') {
      console.log('[Analytics Logger] [Debugger] POST request detected:', {
        url: request.url,
        method: request.method,
        hasPostData: !!request.postData
      });

      // Store for later when we get response body
      debuggerRequests.set(params.requestId, {
        url: request.url,
        method: request.method,
        postData: request.postData,
        headers: request.headers
      });
    }
  }

  // Get response body
  if (method === 'Network.loadingFinished') {
    const requestId = params.requestId;
    const requestData = debuggerRequests.get(requestId);

    if (requestData && requestData.method === 'POST') {
      // Check if URL matches patterns
      const matchesPattern = settings.urlPatterns.some(pattern =>
        requestData.url.toLowerCase().includes(pattern.toLowerCase())
      );

      if (matchesPattern) {
        console.log('[Analytics Logger] [Debugger] Matched URL, parsing...');

        try {
          // Parse the POST data
          const postData = requestData.postData ? JSON.parse(requestData.postData) : null;

          if (postData) {
            const events = AnalyticsParser.parseRequest(
              requestData.url,
              { raw: [{ bytes: new TextEncoder().encode(requestData.postData).buffer }] },
              'debugger'
            );

            if (events.length > 0) {
              console.log(`[Analytics Logger] [Debugger] ✓ Captured ${events.length} event(s)`);
              storage.addEvents(events);
              notifyPanels('eventsAdded', events);
            }
          }
        } catch (err) {
          console.error('[Analytics Logger] [Debugger] Error parsing:', err);
        }
      }

      // Clean up
      debuggerRequests.delete(requestId);
    }
  }
});

// Auto-detach on tab close
chrome.debugger.onDetach.addListener((source, reason) => {
  console.log('[Analytics Logger] Debugger detached:', reason);
  debuggerAttached = false;
  settings.debuggerTabId = null;
});

// Network request interceptor
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Skip if disabled
    if (!settings.enabled) {
      return;
    }

    // Skip if not a POST request (most analytics use POST)
    if (details.method !== 'POST') {
      return;
    }

    // DEBUG: Log ALL POST requests to help with debugging
    console.log('[Analytics Logger] POST request detected:', {
      url: details.url,
      initiator: details.initiator,
      type: details.type,
      frameId: details.frameId,
      tabId: details.tabId,
      hasBody: !!details.requestBody
    });

    // Check if URL matches any patterns
    const matchesPattern = settings.urlPatterns.some(pattern =>
      details.url.toLowerCase().includes(pattern.toLowerCase())
    );

    if (!matchesPattern) {
      console.log('[Analytics Logger] URL does not match patterns:', details.url);
      return;
    }

    console.log('[Analytics Logger] URL matches! Parsing...');

    // Parse the request
    try {
      const events = AnalyticsParser.parseRequest(
        details.url,
        details.requestBody,
        details.initiator
      );

      console.log('[Analytics Logger] Parsed events:', events);

      if (events.length > 0) {
        console.log(`[Analytics Logger] ✓ Captured ${events.length} event(s) from:`, details.url);
        storage.addEvents(events);

        // Persist if enabled
        if (settings.persistEvents) {
          storage.saveToStorage();
        }

        // Notify open panels
        notifyPanels('eventsAdded', events);
      } else {
        console.log('[Analytics Logger] No events extracted from request');
      }
    } catch (err) {
      console.error('[Analytics Logger] Error parsing request:', err);
      console.error('[Analytics Logger] Request details:', {
        url: details.url,
        requestBody: details.requestBody
      });
    }
  },
  {
    urls: ['<all_urls>']
  },
  ['requestBody', 'extraHeaders']
);

// Message handler for communication with UI and external extensions
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Analytics Logger] Received message:', message.action || 'event');

  // Handle direct event logging from other extensions
  if (!message.action && message.event) {
    console.log('[Analytics Logger] Direct event from extension:', sender.id);

    const event = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      timestamp: message.timestamp || new Date().toISOString(),
      event: message.event,
      properties: message.properties || {},
      type: message.type || 'track',
      userId: message.userId,
      anonymousId: message.anonymousId,
      context: message.context || {},
      _parser: 'direct-message',
      _metadata: {
        capturedAt: new Date().toISOString(),
        source: message.source || sender.id,
        initiator: sender.id
      }
    };

    storage.addEvents([event]);
    notifyPanels('eventsAdded', [event]);

    sendResponse({ success: true });
    return false;
  }

  switch (message.action) {
    case 'getEvents':
      sendResponse({
        success: true,
        events: storage.getEvents(message.filters)
      });
      break;

    case 'getAllEvents':
      sendResponse({
        success: true,
        events: storage.getAllEvents()
      });
      break;

    case 'getStats':
      sendResponse({
        success: true,
        stats: storage.getStats()
      });
      break;

    case 'clearEvents':
      storage.clearAll().then(async (success) => {
        // Also clear proxy server events if proxy mode is active
        if (settings.useProxy) {
          try {
            await fetch('http://localhost:8889/clear', { method: 'POST' });
            console.log('[Analytics Logger] Cleared proxy server events');
          } catch (err) {
            console.log('[Analytics Logger] Could not clear proxy events (proxy may not be running)');
          }
        }

        // Notify panels that events were cleared
        notifyPanels('eventsCleared', {});
        sendResponse({ success });
      }).catch(err => {
        console.error('[Analytics Logger] Error clearing events:', err);
        sendResponse({ success: false, error: err.message });
      });
      return true; // Keep channel open for async response

    case 'exportJSON':
      sendResponse({
        success: true,
        data: storage.exportJSON(message.filters)
      });
      break;

    case 'exportCSV':
      sendResponse({
        success: true,
        data: storage.exportCSV(message.filters)
      });
      break;

    case 'getSettings':
      sendResponse({
        success: true,
        settings: settings
      });
      break;

    case 'updateSettings':
      const oldUseProxy = settings.useProxy;
      settings = { ...settings, ...message.settings };
      chrome.storage.local.set({ settings });
      storage.setMaxSize(settings.maxEvents);

      // Handle proxy mode changes
      if (settings.useProxy && !oldUseProxy) {
        startProxyPolling();
      } else if (!settings.useProxy && oldUseProxy) {
        stopProxyPolling();
      }

      sendResponse({ success: true });
      break;

    case 'enableDebugger':
      enableDebuggerMode(message.tabId).then(() => {
        sendResponse({ success: true });
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true; // Keep channel open

    case 'disableDebugger':
      disableDebuggerMode().then(() => {
        sendResponse({ success: true });
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true; // Keep channel open

    case 'getCurrentTab':
      chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
        sendResponse({ success: true, tabId: tabs[0]?.id });
      });
      return true; // Keep channel open

    case 'saveEvents':
      storage.saveToStorage().then(success => {
        sendResponse({ success });
      });
      return true; // Keep channel open for async response

    case 'loadEvents':
      storage.loadFromStorage().then(success => {
        sendResponse({ success });
      });
      return true; // Keep channel open for async response

    default:
      sendResponse({ success: false, error: 'Unknown action' });
  }

  return false;
});

// Connection handler for long-lived connections (real-time updates)
const connectedPanels = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'analytics-logger-panel') {
    console.log('[Analytics Logger] Panel connected');
    connectedPanels.add(port);

    port.onDisconnect.addListener(() => {
      console.log('[Analytics Logger] Panel disconnected');
      connectedPanels.delete(port);
    });
  }
});

// Notify all connected panels of new events
function notifyPanels(action, data) {
  connectedPanels.forEach(port => {
    try {
      port.postMessage({ action, data });
    } catch (err) {
      console.error('[Analytics Logger] Error notifying panel:', err);
      connectedPanels.delete(port);
    }
  });
}

// Extension icon click - open side panel
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// Periodic auto-save (if persistence enabled)
setInterval(() => {
  if (settings.persistEvents && storage.events.length > 0) {
    storage.saveToStorage();
  }
}, 60000); // Every minute

console.log('[Analytics Logger] Background service worker initialized');
