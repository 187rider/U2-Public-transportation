export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Proxy /api/* to Transit Backend
    if (url.pathname.startsWith('/api/')) {
      const backendOrigin = env.BACKEND_URL || 'https://bus.ridertech.online';
      const backendUrl = new URL(url.pathname + url.search, backendOrigin);
      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.set('X-Forwarded-Host', url.host);
      forwardHeaders.set('X-Forwarded-Proto', url.protocol.replace(':', ''));

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
      const backendOrigin = env.BACKEND_URL || 'https://bus.ridertech.online';
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
