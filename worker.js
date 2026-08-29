export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Proxy /api/* to Transit Backend with Server-Side Edge Signature
    if (url.pathname.startsWith('/api/')) {
      const backendOrigin = env.BACKEND_URL || 'https://api.ridertech.online';
      const backendUrl = new URL(url.pathname + url.search, backendOrigin);
      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.set('X-Forwarded-Host', url.host);
      forwardHeaders.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
      if (!forwardHeaders.get('User-Agent')) {
        forwardHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
      }

      // Edge Server-Side Signing (Keeps API_SECRET 100% hidden from client browsers)
      const secret = env.API_SECRET || 'REDACTED_SECRET';
      const ts = Math.floor(Date.now() / 1000).toString();
      const msg = new TextEncoder().encode(ts + secret);
      const hashBuf = await crypto.subtle.digest('SHA-256', msg);
      const signature = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

      forwardHeaders.set('X-App-Timestamp', ts);
      forwardHeaders.set('X-App-Signature', signature);

      const newRequest = new Request(backendUrl.toString(), {
        method: request.method,
        headers: forwardHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        redirect: 'follow'
      });
      return fetch(newRequest);
    }

    // 2. Proxy /tiles/* to Map Tiles Backend
    if (url.pathname.startsWith('/tiles/')) {
      const backendOrigin = env.BACKEND_URL || 'https://api.ridertech.online';
      const backendUrl = new URL(url.pathname + url.search, backendOrigin);
      return fetch(new Request(backendUrl.toString(), request));
    }

    // 3. Serve static asset from Cloudflare Workers Assets
    let response;
    try {
      response = await env.ASSETS.fetch(request);
    } catch (e) {
      return new Response('Asset not found', { status: 404 });
    }

    // 4. Force anti-cache headers for sw.js, index.html and root
    if (url.pathname === '/sw.js' || url.pathname === '/' || url.pathname === '/index.html') {
      const newHeaders = new Headers(response.headers);
      newHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
      newHeaders.set('Pragma', 'no-cache');
      newHeaders.set('Expires', '0');
      return new Response(response.body, {
        status: response.status,
        headers: newHeaders
      });
    }

    return response;
  }
};
