/**
 * MITM Proxy for Analytics (like Charles Proxy)
 *
 * This proxy intercepts HTTPS traffic (including from extension service workers)
 * and captures analytics events.
 */

const MitmProxy = require('http-mitm-proxy').Proxy;
const http = require('http');

const PROXY_PORT = 8888;
const API_PORT = 8889;

// Store captured events
const capturedEvents = [];
const MAX_EVENTS = 1000;

// Patterns to intercept
const INTERCEPT_PATTERNS = [
  'pie.org/v1/batch',
  'pie-staging.org/v1/batch',
  'segment.io/v1/batch',
  'segment.io/v1/track',
  'segment.com/v1/batch'
];

function shouldIntercept(url) {
  return INTERCEPT_PATTERNS.some(pattern => url.includes(pattern));
}

// Create MITM proxy
const proxy = new MitmProxy();

proxy.onError((ctx, err) => {
  console.error('[MITM Proxy] Error:', err.message);
});

// Intercept HTTPS requests
proxy.onRequest((ctx, callback) => {
  const url = ctx.clientToProxyRequest.url;
  const fullUrl = `${ctx.isSSL ? 'https' : 'http'}://${ctx.clientToProxyRequest.headers.host}${url}`;

  // Check if this is an analytics request we want to capture
  if (shouldIntercept(fullUrl) && ctx.clientToProxyRequest.method === 'POST') {
    console.log(`[MITM Proxy] Intercepting analytics request: ${fullUrl}`);

    // Collect request body
    let body = '';
    ctx.onRequestData((ctx, chunk, callback) => {
      body += chunk.toString();
      return callback(null, chunk);
    });

    ctx.onRequestEnd((ctx, callback) => {
      // Parse and store the analytics event
      try {
        const data = JSON.parse(body);

        // Parse Segment batch format
        if (data.batch && Array.isArray(data.batch)) {
          data.batch.forEach(event => {
            const captured = {
              id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
              timestamp: event.timestamp || event.sentAt || new Date().toISOString(),
              event: event.event || event.type,
              properties: event.properties || {},
              context: event.context || {},
              type: event.type || 'track',
              userId: event.userId,
              anonymousId: event.anonymousId,
              _metadata: {
                url: fullUrl,
                capturedAt: new Date().toISOString(),
                source: 'mitm-proxy',
                initiator: ctx.clientToProxyRequest.headers['user-agent']
              },
              _parser: 'mitm-proxy-interceptor'
            };

            capturedEvents.unshift(captured);

            // Maintain max size
            if (capturedEvents.length > MAX_EVENTS) {
              capturedEvents.length = MAX_EVENTS;
            }

            console.log(`[MITM Proxy] ✅ Captured event: ${captured.event}`);
          });
        }
      } catch (err) {
        console.error('[MITM Proxy] Error parsing body:', err.message);
      }

      return callback();
    });
  }

  return callback();
});

// Start MITM proxy
proxy.listen({
  port: PROXY_PORT,
  host: '0.0.0.0'  // Listen on all interfaces (IPv4 and IPv6)
}, () => {
  console.log(`\n🔌 MITM Proxy running on 0.0.0.0:${PROXY_PORT}`);
  console.log(`📊 API server running on port ${API_PORT}`);
  console.log(`\n📝 Certificate location: ~/.http-mitm-proxy/certs/ca.pem`);
  console.log(`\n⚠️  IMPORTANT: You must trust the CA certificate for HTTPS interception to work.`);
  console.log(`   Run: security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db ~/.http-mitm-proxy/certs/ca.pem`);
  console.log(`\n⚡ Ready to intercept analytics events!\n`);
});

// API server for Analytics Logger to fetch events
const apiServer = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: capturedEvents,
      count: capturedEvents.length
    }));
  } else if (req.url === '/clear' && req.method === 'POST') {
    capturedEvents.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

apiServer.listen(API_PORT);
