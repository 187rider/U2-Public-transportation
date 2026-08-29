/**
 * Cloudflare Worker Backend for U2 Public Transportation
 * 100% Serverless: Edge API, AES Bus62 Decryption, RFC 8291 Web Push & Static Assets
 */

// -------------------------------------------------------------
// 1. Upstream Transit & Dynamic VAPID Configuration
// -------------------------------------------------------------
function getUpstreamConfig(env = {}) {
  return {
    url: env.BUS62_URL || env.UPSTREAM_URL || "",
    city: env.BUS62_CITY || env.UPSTREAM_CITY || "ulanude",
    key: env.BUS62_KEY || env.UPSTREAM_KEY || "",
    iv: env.BUS62_IV || env.UPSTREAM_IV || ""
  };
}

const DEFAULT_VAPID_PUBLIC_KEY = "BIXzDjpsB1MtIw0XKWIZG-5ugMwqqj3lkptzyFAeMbBPkWuaMc4H9AKy0AxUHCejIXmPskURHUbYKJsA-DaG1uE";

function getVapidConfig(env = {}) {
  const subject = env.VAPID_SUBJECT || "mailto:support@ridertech.online";
  const publicKey = env.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY;

  let jwk = null;
  if (env.VAPID_JWK_JSON) {
    try {
      jwk = JSON.parse(env.VAPID_JWK_JSON);
    } catch (e) {}
  }

  if (!jwk) {
    const d = env.VAPID_PRIVATE_KEY || "";
    jwk = {
      kty: "EC",
      x: env.VAPID_PUBLIC_X || "hfMOOmwHUy0jDRcpYhkb7m6AzCqqPeWSm3PIUB4xsE8",
      y: env.VAPID_PUBLIC_Y || "kWuaMc4H9AKy0AxUHCejIXmPskURHUbYKJsA-DaG1uE",
      crv: "P-256",
      d
    };
  }

  return { subject, publicKey, jwk };
}

// In-Memory Global Cache
const CACHE = new Map();
function getFromCache(key, maxAgeSec) {
  const item = CACHE.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > maxAgeSec * 1000) {
    CACHE.delete(key);
    return null;
  }
  return item.val;
}
function setInCache(key, val) {
  CACHE.set(key, { ts: Date.now(), val });
}

// In-Memory Store for Reminders
const MEMORY_REMINDERS = new Map();

// -------------------------------------------------------------
// 2. Native AES-128-CBC Decryption & Hash Generator
// -------------------------------------------------------------
async function generateBus62Hash(env = {}) {
  const cfg = getUpstreamConfig(env);
  if (!cfg.key || !cfg.iv) return "";

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const s = pad(d.getUTCSeconds());
  const m = pad(d.getUTCMinutes());
  const h = pad(d.getUTCHours());
  const Y = d.getUTCFullYear();
  const M = pad(d.getUTCMonth() + 1);
  const D = pad(d.getUTCDate());
  const str = `${s}:${m}:${h} ${Y}-${M}-${D}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(cfg.key),
    { name: "AES-CBC" },
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: enc.encode(cfg.iv) },
    key,
    enc.encode(str)
  );

  return Array.from(new Uint8Array(encrypted))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getBus62Headers(env = {}) {
  const hash = await generateBus62Hash(env);
  const cfg = getUpstreamConfig(env);
  const headers = {
    "User-Agent": "ios_BE690AAB-3365-4C72-9975-C71A288BF57E_f3d999a6",
    "Accept": "*/*",
    "Accept-Language": "ru",
    "Accept-Encoding": "gzip, deflate"
  };
  if (cfg.iv && hash) {
    headers[cfg.iv] = hash;
  }
  return headers;
}

// -------------------------------------------------------------
// 3. RFC 8291 Web Push Engine (Pure Web Crypto)
// -------------------------------------------------------------
function base64UrlToUint8Array(base64Url) {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function uint8ArrayToBase64Url(uint8Array) {
  let binary = "";
  for (let i = 0; i < uint8Array.byteLength; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createVapidJwt(audience, subject, vapidJwk) {
  const header = { typ: "JWT", alg: "ES256" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + 12 * 3600,
    sub: subject
  };

  const enc = new TextEncoder();
  const headerB64 = uint8ArrayToBase64Url(enc.encode(JSON.stringify(header)));
  const payloadB64 = uint8ArrayToBase64Url(enc.encode(JSON.stringify(payload)));
  const unsignedToken = `${headerB64}.${payloadB64}`;

  const privateKey = await crypto.subtle.importKey(
    "jwk",
    vapidJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const sigBuffer = await crypto.subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    privateKey,
    enc.encode(unsignedToken)
  );

  const sigB64 = uint8ArrayToBase64Url(new Uint8Array(sigBuffer));
  return `${unsignedToken}.${sigB64}`;
}

async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey(
    "raw",
    salt,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, ikm));
}

async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey(
    "raw",
    prk,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const input = new Uint8Array(info.length + 1);
  input.set(info, 0);
  input[info.length] = 1;
  const hash = await crypto.subtle.sign("HMAC", key, input);
  return new Uint8Array(hash).slice(0, length);
}

async function encryptWebPushPayload(subscription, payloadText, vapidConfig) {
  const userPublicKeyBytes = base64UrlToUint8Array(subscription.keys.p256dh);
  const userAuthBytes = base64UrlToUint8Array(subscription.keys.auth);

  const localKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const localPublicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", localKeyPair.publicKey)
  );

  const userPublicKey = await crypto.subtle.importKey(
    "raw",
    userPublicKeyBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  const sharedSecretBuffer = await crypto.subtle.deriveBits(
    { name: "ECDH", public: userPublicKey },
    localKeyPair.privateKey,
    256
  );
  const sharedSecret = new Uint8Array(sharedSecretBuffer);

  const webPushInfo = new TextEncoder().encode("WebPush: info\0");
  const authInfo = new Uint8Array(webPushInfo.length + userPublicKeyBytes.length + localPublicKeyRaw.length);
  authInfo.set(webPushInfo, 0);
  authInfo.set(userPublicKeyBytes, webPushInfo.length);
  authInfo.set(localPublicKeyRaw, webPushInfo.length + userPublicKeyBytes.length);

  const prk = await hkdfExtract(userAuthBytes, sharedSecret);
  const ikm = await hkdfExpand(prk, authInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekPrk = await hkdfExtract(salt, ikm);
  const cekInfo = new TextEncoder().encode("Content-Encoding: aes128gcm\0");
  const nonceInfo = new TextEncoder().encode("Content-Encoding: nonce\0");

  const cek = await hkdfExpand(cekPrk, cekInfo, 16);
  const nonce = await hkdfExpand(cekPrk, nonceInfo, 12);

  const payloadBytes = new TextEncoder().encode(payloadText);
  const record = new Uint8Array(payloadBytes.length + 2);
  record.set(payloadBytes, 0);
  record[payloadBytes.length] = 0x02;

  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    aesKey,
    record
  );
  const ciphertext = new Uint8Array(encryptedBuffer);

  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  header[16] = (rs >> 24) & 0xff;
  header[17] = (rs >> 16) & 0xff;
  header[18] = (rs >> 8) & 0xff;
  header[19] = rs & 0xff;
  header[20] = 65;
  header.set(localPublicKeyRaw, 21);

  const body = new Uint8Array(header.length + ciphertext.length);
  body.set(header, 0);
  body.set(ciphertext, header.length);

  const endpointUrl = new URL(subscription.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const jwt = await createVapidJwt(audience, vapidConfig.subject, vapidConfig.jwk);

  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "aes128gcm",
    "TTL": "120",
    "Urgency": "high",
    "Authorization": `vapid t=${jwt}, k=${vapidConfig.publicKey}`,
    "Crypto-Key": `p256ecdsa=${vapidConfig.publicKey}`
  };

  // Google FCM format support
  if (subscription.endpoint.includes("fcm.googleapis.com")) {
    headers["Authorization"] = `WebPush ${jwt}`;
  }

  // Apple APNs format support
  if (subscription.endpoint.includes("apple.com")) {
    headers["apns-push-type"] = "alert";
    headers["apns-priority"] = "10";
  }

  return {
    body,
    headers
  };
}

async function sendWebPush(subscription, payload, env = {}) {
  try {
    const vapidConfig = getVapidConfig(env);
    const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
    const { body, headers } = await encryptWebPushPayload(subscription, payloadStr, vapidConfig);

    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers,
      body
    });

    console.log(`WebPush to ${subscription.endpoint.slice(0, 45)}... status: ${res.status}`);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    console.warn("WebPush send error:", err);
    return { ok: false, error: err.message };
  }
}

// -------------------------------------------------------------
// 4. API Endpoints Implementation
// -------------------------------------------------------------
async function handleGetRoutes(env = {}) {
  const cached = getFromCache("routes_grouped_v3", 3600);
  if (cached) return Response.json(cached);

  const cfg = getUpstreamConfig(env);
  if (!cfg.url) return Response.json({ count: 0, routes: [] });

  try {
    const headers = await getBus62Headers(env);
    const res = await fetch(`${cfg.url}/getAllRoutes.php?city=${cfg.city}`, {
      headers,
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return Response.json({ count: 0, routes: [] });

    const rawRoutes = await res.json();
    if (!Array.isArray(rawRoutes)) return Response.json({ count: 0, routes: [] });

    const routesByNum = new Map();
    for (const rt of rawRoutes) {
      const num = String(rt.number || "").trim();
      const name = String(rt.name || "").trim();
      const rawType = String(rt.type || "").trim();

      let rtType = "bus";
      if (["Т", "Тм", "Трамвай"].includes(rawType) || name.startsWith("Т-") || name.startsWith("Тм-")) {
        rtType = "tram";
      } else if (["М", "М-"].includes(rawType) || name.startsWith("М-")) {
        rtType = "minibus";
      }

      const key = `${rtType}_${num}`;
      const rtId = String(rt.id || "").trim();
      const fromSt = String(rt.from_station_name || rt.from_station || "").trim();
      const toSt = String(rt.to_station_name || rt.to_station || "").trim();

      if (!routesByNum.has(key)) {
        routesByNum.set(key, {
          id: rtId ? [rtId] : [],
          number: num,
          name,
          type: rtType,
          from_station: fromSt,
          to_station: toSt,
          subroutes: []
        });
      } else {
        const item = routesByNum.get(key);
        if (rtId && !item.id.includes(rtId)) item.id.push(rtId);
        if (!item.from_station && fromSt) item.from_station = fromSt;
        if (!item.to_station && toSt) item.to_station = toSt;
      }

      routesByNum.get(key).subroutes.push({
        id: rtId,
        number: num,
        name,
        type: rtType,
        from_station: fromSt,
        to_station: toSt
      });
    }

    const formattedRoutes = Array.from(routesByNum.values()).map((r) => ({
      ...r,
      id: r.id.join(",")
    }));

    formattedRoutes.sort((a, b) => {
      const typeOrder = { bus: 0, tram: 1, minibus: 2 };
      if (typeOrder[a.type] !== typeOrder[b.type]) return typeOrder[a.type] - typeOrder[b.type];
      const numA = parseInt(a.number, 10), numB = parseInt(b.number, 10);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a.number.localeCompare(b.number);
    });

    const result = { count: formattedRoutes.length, routes: formattedRoutes };
    setInCache("routes_grouped_v3", result);
    return Response.json(result);
  } catch (e) {
    return Response.json({ count: 0, routes: [] });
  }
}

async function handleGetStations(env = {}) {
  const cached = getFromCache("stations_geojson_v3", 3600);
  if (cached) return Response.json(cached);

  const cfg = getUpstreamConfig(env);
  if (!cfg.url) return Response.json({ type: "FeatureCollection", features: [] });

  try {
    const headers = await getBus62Headers(env);
    const res = await fetch(`${cfg.url}/getAllStations.php?city=${cfg.city}`, {
      headers,
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return Response.json({ type: "FeatureCollection", features: [] });

    const rawStations = await res.json();
    if (!Array.isArray(rawStations)) return Response.json({ type: "FeatureCollection", features: [] });

    const features = [];
    for (const station of rawStations) {
      const stType = String(station.type) === "0" ? "bus" : "tram";
      const stName = String(station.name || "").trim();
      const stId = String(station.id || "");
      const isWarm = String(station.is_warm || station.warm || "0");
      const description = String(station.description || station.descr || "").trim();

      const l0 = parseFloat(station.lon0 || 0) / 1000000.0;
      const a0 = parseFloat(station.lat0 || 0) / 1000000.0;
      const l1 = parseFloat(station.lon1 || 0) / 1000000.0;
      const a1 = parseFloat(station.lat1 || 0) / 1000000.0;

      let coords = null;
      if (l0 && a0 && l1 && a1) coords = [(l0 + l1) / 2.0, (a0 + a1) / 2.0];
      else if (l0 && a0) coords = [l0, a0];
      else if (l1 && a1) coords = [l1, a1];

      if (coords && coords[1] > 50.0 && coords[1] < 55.0 && coords[0] > 100.0 && coords[0] < 115.0) {
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: coords },
          properties: {
            id: stId,
            name: stName,
            type: stType,
            is_warm: isWarm,
            description: description
          }
        });
      }
    }

    const result = { type: "FeatureCollection", features };
    setInCache("stations_geojson_v3", result);
    return Response.json(result);
  } catch (e) {
    return Response.json({ type: "FeatureCollection", features: [] });
  }
}

async function handleGetRouteNodes(url, env = {}) {
  const id = url.searchParams.get("id") || "";
  if (!id) return Response.json({ nodes: [] });

  const cacheKey = `route_nodes_${id}`;
  const cached = getFromCache(cacheKey, 3600);
  if (cached) return Response.json(cached);

  const cfg = getUpstreamConfig(env);
  if (!cfg.url) return Response.json({ nodes: [] });

  try {
    const headers = await getBus62Headers(env);
    const res = await fetch(`${cfg.url}/getRouteNodes.php?id=${id}&city=${cfg.city}`, {
      headers,
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return Response.json({ nodes: [] });

    const data = await res.json();
    const nodes = [];
    if (Array.isArray(data)) {
      for (const pt of data) {
        let lat = parseFloat(pt.lat) || 0;
        let lon = parseFloat(pt.lon || pt.lng) || 0;
        if (Math.abs(lat) > 1000) lat /= 1000000;
        if (Math.abs(lon) > 1000) lon /= 1000000;
        if (lat && lon) nodes.push([lon, lat]);
      }
    }

    const result = { nodes };
    setInCache(cacheKey, result);
    return Response.json(result);
  } catch (e) {
    return Response.json({ nodes: [] });
  }
}

async function handleGetRouteStations(url, env = {}) {
  const id = url.searchParams.get("id") || "";
  if (!id) return Response.json({ stations: [] });

  const cacheKey = `route_stations_${id}`;
  const cached = getFromCache(cacheKey, 3600);
  if (cached) return Response.json(cached);

  const cfg = getUpstreamConfig(env);
  if (!cfg.url) return Response.json({ stations: [] });

  try {
    const headers = await getBus62Headers(env);
    const res = await fetch(`${cfg.url}/getRouteStations.php?id=${id}&city=${cfg.city}`, {
      headers,
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return Response.json({ stations: [] });

    const data = await res.json();
    const station_ids = [];
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item && item.station_id != null) {
          station_ids.push(String(item.station_id));
        }
      }
    }

    const result = { stations: station_ids };
    setInCache(cacheKey, result);
    return Response.json(result);
  } catch (e) {
    return Response.json({ stations: [] });
  }
}

// -------------------------------------------------------------
// Rate Limiter & Global In-Memory Vehicle Cache (10s Cooldown)
// -------------------------------------------------------------
let LAST_VEHICLE_POLL_TIME = 0;
let LAST_VEHICLE_SNAPSHOT = null;
let VEHICLE_FETCH_PROMISE = null;

function filterAndReturnVehicles(items, requestedRids, curk) {
  const ridSet = requestedRids ? new Set(requestedRids.split(",").map((r) => r.trim()).filter(Boolean)) : null;
  let maxCurk = parseInt(curk, 10) || 0;
  const vehicles = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    let lat = parseFloat(item.lat) || 0;
    let lng = parseFloat(item.lng || item.lon) || 0;
    if (Math.abs(lat) > 1000) lat /= 1000000;
    if (Math.abs(lng) > 1000) lng /= 1000000;

    const animKey = item.anim_key;
    if (animKey && !isNaN(animKey)) {
      maxCurk = Math.max(maxCurk, parseInt(animKey, 10));
    }

    const rawAnimPoints = Array.isArray(item.anim_points) ? item.anim_points : [];
    const animPoints = [];
    for (const pt of rawAnimPoints) {
      let ptLat = parseFloat(pt.lat) || 0;
      let ptLng = parseFloat(pt.lon || pt.lng) || 0;
      if (Math.abs(ptLat) > 1000) ptLat /= 1000000;
      if (Math.abs(ptLng) > 1000) ptLng /= 1000000;
      animPoints.push({
        percent: parseFloat(pt.percent) || 0,
        lat: ptLat,
        lng: ptLng,
        dir: (parseFloat(pt.dir) || 0) % 360
      });
    }

    const vehId = String(item.vehid || item.id || "");
    if (!vehId) continue;

    const vehRid = String(item.rid || "").trim();
    if (ridSet && (!vehRid || !ridSet.has(vehRid))) {
      continue;
    }

    vehicles.push({
      id: vehId,
      lat,
      lng,
      route: String(item.route || item.rnum || ""),
      dir: (parseFloat(item.dir) || 0) % 360,
      speed: parseFloat(item.speed) || 0,
      gosNum: String(item.gos_num || item.gosNum || ""),
      type: String(item.type || item.rtype || "А"),
      rid: vehRid,
      anim_key: String(animKey || maxCurk),
      animPoints: animPoints.slice(-2)
    });
  }

  return Response.json({
    vehicles,
    next_curk: String(maxCurk)
  });
}

async function handleGetVehicles(url, env = {}) {
  const requestedRids = url.searchParams.get("rids") || "";
  const curk = url.searchParams.get("curk") || "0";
  const now = Date.now();

  // 1. Strict 10-second floor cooldown: if last poll was < 10 seconds ago, return cached snapshot immediately
  if (LAST_VEHICLE_SNAPSHOT && now - LAST_VEHICLE_POLL_TIME < 10000) {
    return filterAndReturnVehicles(LAST_VEHICLE_SNAPSHOT, requestedRids, curk);
  }

  // 2. Coalesce concurrent in-flight requests (prevent dogpiling to upstream)
  if (!VEHICLE_FETCH_PROMISE) {
    VEHICLE_FETCH_PROMISE = (async () => {
      try {
        const cfg = getUpstreamConfig(env);
        if (!cfg.url) return;

        let rids = "";
        let routes = getFromCache("all_routes_raw", 3600);
        if (!routes) {
          const h = await getBus62Headers(env);
          const r = await fetch(`${cfg.url}/getAllRoutes.php?city=${cfg.city}`, {
            headers: h,
            signal: AbortSignal.timeout(5000)
          });
          if (r.ok) {
            routes = await r.json();
            setInCache("all_routes_raw", routes);
          }
        }
        if (Array.isArray(routes) && routes.length) {
          rids = routes.map((rt) => rt.id).filter(Boolean).join(",");
        }

        const headers = await getBus62Headers(env);
        const apiUrl = `${cfg.url}/getVehicleAnimations.php?curk=0&city=${cfg.city}&rids=${rids}`;
        const res = await fetch(apiUrl, {
          headers,
          signal: AbortSignal.timeout(6000)
        });
        if (res.ok) {
          const items = await res.json();
          if (Array.isArray(items) && items.length > 0) {
            LAST_VEHICLE_SNAPSHOT = items;
            LAST_VEHICLE_POLL_TIME = Date.now();
          }
        }
      } catch (e) {
      } finally {
        VEHICLE_FETCH_PROMISE = null;
      }
    })();
  }

  await VEHICLE_FETCH_PROMISE;

  if (LAST_VEHICLE_SNAPSHOT) {
    return filterAndReturnVehicles(LAST_VEHICLE_SNAPSHOT, requestedRids, curk);
  }

  return Response.json({ vehicles: [], next_curk: curk });
}

async function handleGetStationForecasts(url, env = {}) {
  const sid = url.searchParams.get("sid") || "";
  if (!sid) return Response.json({ forecasts: [], sid: "" });

  const cacheKey = `forecasts_sid_${sid}`;
  const cached = getFromCache(cacheKey, 8); // 8-second cache
  if (cached) return Response.json(cached);

  const cfg = getUpstreamConfig(env);
  if (!cfg.url) return Response.json({ forecasts: [], sid });

  try {
    const headers = await getBus62Headers(env);
    const res = await fetch(`${cfg.url}/getStationForecasts.php?sid=${sid}&city=${cfg.city}`, {
      headers,
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return Response.json({ forecasts: [], sid });

    const data = await res.json();
    const rawList = Array.isArray(data) ? data : data.forecasts || [];

    const forecasts = rawList.map((f) => {
      const rawTime = f.arrt || f.arrtime || f.time || "";
      let timeVal = 0;
      try {
        timeVal = rawTime ? Math.ceil(parseInt(rawTime, 10) / 60) : 0;
      } catch (e) {
        timeVal = 0;
      }

      return {
        rid: String(f.rid || ""),
        rnum: String(f.rnum || f.route || ""),
        time: timeVal,
        destination: String(f.where || f.destination || f.last || ""),
        vehid: String(f.obj_id || f.vehid || f.id || ""),
        gosNum: String(f.gos_num || f.gosNum || ""),
        type: String(f.type || "А")
      };
    });

    const result = { forecasts, sid };
    setInCache(cacheKey, result);
    return Response.json(result);
  } catch (e) {
    return Response.json({ forecasts: [], sid });
  }
}

async function handleGetVehicleForecasts(url, env = {}) {
  const vehid = url.searchParams.get("vehid") || "";
  if (!vehid) return Response.json({ forecasts: [], vehid: "" });

  const cacheKey = `vehicle_forecasts_${vehid}`;
  const cached = getFromCache(cacheKey, 8); // 8-second cache
  if (cached) return Response.json(cached);

  const cfg = getUpstreamConfig(env);
  if (!cfg.url) return Response.json({ forecasts: [], vehid });

  try {
    const headers = await getBus62Headers(env);
    const res = await fetch(`${cfg.url}/getVehicleForecasts.php?vehid=${vehid}&city=${cfg.city}`, {
      headers,
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return Response.json({ forecasts: [], vehid });

    const data = await res.json();
    const rawList = Array.isArray(data) ? data : [];
    const forecasts = rawList.map((item) => {
      const rawTime = item.arrt || item.time || "";
      let timeVal = 0;
      try {
        timeVal = rawTime ? Math.ceil(parseInt(rawTime, 10) / 60) : 0;
      } catch (e) {
        timeVal = 0;
      }
      return {
        stid: String(item.stid || item.station_id || ""),
        time: timeVal
      };
    });

    const result = { forecasts, vehid };
    setInCache(cacheKey, result);
    return Response.json(result);
  } catch (e) {
    return Response.json({ forecasts: [], vehid });
  }
}

// -------------------------------------------------------------
// 5. Push Reminders & Background Tracker (Cloudflare KV & Web Push)
// -------------------------------------------------------------
async function handleAddReminder(request, env) {
  const data = await request.json();
  const sub = data.subscription;
  if (!sub || !sub.endpoint) {
    return Response.json({ error: "Invalid subscription" }, { status: 400 });
  }

  const endpoint = sub.endpoint;
  const sid = String(data.sid || "");
  const rid = String(data.rid || "");
  const vehid = String(data.vehid || "");
  const gosNum = String(data.gosNum || "");
  const remKey = `rem_${endpoint}_${sid}_${rid}`;

  let initNum = null;
  if (data.initialTime != null) {
    const match = String(data.initialTime).match(/\d+/);
    if (match) initNum = parseInt(match[0], 10);
  }

  const reminderRecord = {
    remKey,
    subscription: sub,
    sid,
    stationName: String(data.stationName || ""),
    rid,
    rnum: String(data.rnum || ""),
    vehid,
    gosNum,
    lastNotifiedTime: initNum,
    createdAt: Date.now()
  };

  // 1. Store in Cloudflare KV with 2-hour auto-expiration
  if (env.REMINDERS_KV) {
    try {
      await env.REMINDERS_KV.put(remKey, JSON.stringify(reminderRecord), {
        expirationTtl: 7200 // 2 hours
      });
    } catch (e) {
      console.warn("KV put error:", e);
    }
  }

  // 2. Also keep in-memory for immediate ticks
  MEMORY_REMINDERS.set(remKey, reminderRecord);

  return Response.json({ success: true, status: "ok", key: remKey });
}

async function handleDeleteReminder(request, env) {
  const data = await request.json();
  const ep = data.endpoint || (data.subscription && data.subscription.endpoint);
  const sid = String(data.sid || "");
  const rid = String(data.rid || "");

  if (env.REMINDERS_KV && ep) {
    try {
      if (sid && rid) {
        await env.REMINDERS_KV.delete(`rem_${ep}_${sid}_${rid}`);
      } else {
        const list = await env.REMINDERS_KV.list({ prefix: `rem_${ep}` });
        for (const key of list.keys || []) {
          await env.REMINDERS_KV.delete(key.name);
        }
      }
    } catch (e) {
      console.warn("KV delete error:", e);
    }
  }

  for (const [key, rem] of MEMORY_REMINDERS.entries()) {
    if (rem.subscription.endpoint === ep) {
      if (!sid || (rem.sid === sid && rem.rid === rid)) {
        MEMORY_REMINDERS.delete(key);
      }
    }
  }

  return Response.json({ success: true, status: "ok" });
}

let LAST_REMINDER_CHECK_TIME = 0;

async function checkRemindersAndNotify(env) {
  const now = Date.now();
  // Global 10-second cooldown: never check upstream more than once per 10 seconds
  if (now - LAST_REMINDER_CHECK_TIME < 10000) {
    return;
  }
  LAST_REMINDER_CHECK_TIME = now;

  let reminders = [];

  // 1. Fetch all active reminders from Cloudflare KV
  if (env.REMINDERS_KV) {
    try {
      const list = await env.REMINDERS_KV.list({ prefix: "rem_" });
      for (const key of list.keys || []) {
        try {
          const raw = await env.REMINDERS_KV.get(key.name);
          if (raw) {
            const parsed = JSON.parse(raw);
            reminders.push(parsed);
          }
        } catch (e) {}
      }
    } catch (e) {
      console.warn("KV list error:", e);
    }
  }

  // 2. If KV returned nothing or is not bound, check memory
  if (!reminders.length && MEMORY_REMINDERS.size > 0) {
    reminders = Array.from(MEMORY_REMINDERS.values());
  }

  if (!reminders.length) return;

  const distinctSids = Array.from(new Set(reminders.map((r) => r.sid).filter(Boolean)));
  const stationForecastsMap = new Map();
  const cfg = getUpstreamConfig(env);

  if (cfg.url) {
    await Promise.all(
      distinctSids.map(async (sid) => {
        try {
          const headers = await getBus62Headers(env);
          const res = await fetch(`${cfg.url}/getStationForecasts.php?sid=${sid}&city=${cfg.city}`, { headers });
          if (res.ok) {
            const json = await res.json();
            stationForecastsMap.set(sid, Array.isArray(json) ? json : json.forecasts || []);
          }
        } catch (e) {}
      })
    );
  }

  for (const rem of reminders) {
    // Evict reminders older than 2 hours
    if (now - rem.createdAt > 7200 * 1000) {
      if (env.REMINDERS_KV) await env.REMINDERS_KV.delete(rem.remKey).catch(() => {});
      MEMORY_REMINDERS.delete(rem.remKey);
      continue;
    }

    const forecasts = stationForecastsMap.get(rem.sid);
    if (!forecasts) continue;

    let matching = null;
    if (rem.vehid) {
      matching = forecasts.find((f) => String(f.obj_id || f.vehid || f.id) === rem.vehid);
    }
    if (!matching && rem.gosNum) {
      matching = forecasts.find((f) => String(f.gos_num || f.gosNum || "").toLowerCase() === rem.gosNum.toLowerCase());
    }
    if (!matching && !rem.vehid && !rem.gosNum) {
      const candidates = forecasts.filter((f) => String(f.rid) === rem.rid);
      if (candidates.length) {
        matching = candidates.reduce((min, c) => (parseInt(c.arrt || c.time, 10) < parseInt(min.arrt || min.time, 10) ? c : min), candidates[0]);
      }
    }

    // Auto-lock to vehicle and persist in KV
    if (!rem.vehid && matching && (matching.obj_id || matching.vehid)) {
      rem.vehid = String(matching.obj_id || matching.vehid);
      rem.gosNum = String(matching.gosNum || matching.gos_num || "");
      if (env.REMINDERS_KV) {
        await env.REMINDERS_KV.put(rem.remKey, JSON.stringify(rem), { expirationTtl: 7200 }).catch(() => {});
      }
    }

    const rnum = rem.rnum;
    const stname = rem.stationName;
    const sub = rem.subscription;

    if (!matching) {
      if (rem.lastNotifiedTime !== null && rem.lastNotifiedTime <= 3) {
        await sendWebPush(sub, {
          title: `🚌 Маршрут ${rnum} прибыл!`,
          body: `Остановка «${stname}»`,
          tag: `arrival_${rem.sid}_${rem.rid}`,
          sid: rem.sid,
          rid: rem.rid
        }, env);
        if (env.REMINDERS_KV) await env.REMINDERS_KV.delete(rem.remKey).catch(() => {});
        MEMORY_REMINDERS.delete(rem.remKey);
      }
      continue;
    }

    const rawTime = matching.arrt || matching.arrtime || matching.time || 0;
    const curTime = Math.ceil(parseInt(rawTime, 10) / 60);
    const last = rem.lastNotifiedTime;

    if (last !== null && last <= 3 && (curTime >= last + 2 || (last <= 1 && curTime > last))) {
      await sendWebPush(sub, {
        title: `🚌 Маршрут ${rnum} прибыл!`,
        body: `Остановка «${stname}»`,
        tag: `arrival_${rem.sid}_${rem.rid}`,
        sid: rem.sid,
        rid: rem.rid
      }, env);
      if (env.REMINDERS_KV) await env.REMINDERS_KV.delete(rem.remKey).catch(() => {});
      MEMORY_REMINDERS.delete(rem.remKey);
      continue;
    }

    let shouldFire = false;
    if (curTime <= 0) {
      shouldFire = true;
    } else if (last === null) {
      rem.lastNotifiedTime = curTime;
      if (env.REMINDERS_KV) await env.REMINDERS_KV.put(rem.remKey, JSON.stringify(rem), { expirationTtl: 7200 }).catch(() => {});
    } else if (curTime < last) {
      shouldFire = true;
    }

    if (shouldFire) {
      rem.lastNotifiedTime = curTime;
      if (env.REMINDERS_KV) await env.REMINDERS_KV.put(rem.remKey, JSON.stringify(rem), { expirationTtl: 7200 }).catch(() => {});

      if (curTime <= 0) {
        await sendWebPush(sub, {
          title: `🚌 Маршрут ${rnum} прибыл!`,
          body: `Остановка «${stname}»`,
          tag: `arrival_${rem.sid}_${rem.rid}`,
          sid: rem.sid,
          rid: rem.rid
        }, env);
        if (env.REMINDERS_KV) await env.REMINDERS_KV.delete(rem.remKey).catch(() => {});
        MEMORY_REMINDERS.delete(rem.remKey);
      } else {
        const timeWord = curTime === 1 ? "1 минуту" : curTime < 5 ? `${curTime} минуты` : `${curTime} минут`;
        await sendWebPush(sub, {
          title: `🚌 Маршрут ${rnum} через ${timeWord}`,
          body: `Остановка «${stname}»`,
          tag: `arrival_${rem.sid}_${rem.rid}`,
          sid: rem.sid,
          rid: rem.rid,
          minutes: curTime
        }, env);
      }
    }
  }
}

// -------------------------------------------------------------
// 6. Main Worker Fetch & Scheduled Handlers
// -------------------------------------------------------------
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkRemindersAndNotify(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API Routing
    if (url.pathname.startsWith("/api/")) {
      ctx.waitUntil(checkRemindersAndNotify(env));

      if (url.pathname === "/api/routes") return handleGetRoutes(env);
      if (url.pathname === "/api/stops" || url.pathname === "/api/stations") return handleGetStations(env);
      if (url.pathname === "/api/route_nodes") return handleGetRouteNodes(url, env);
      if (url.pathname === "/api/route_stations") return handleGetRouteStations(url, env);
      if (url.pathname === "/api/vehicles") return handleGetVehicles(url, env);
      if (url.pathname === "/api/forecasts" || url.pathname === "/api/station_forecasts") {
        return handleGetStationForecasts(url, env);
      }
      if (url.pathname === "/api/vehicle_forecasts") return handleGetVehicleForecasts(url, env);

      if (url.pathname === "/api/vapid_public_key" || url.pathname === "/api/vapid-public-key") {
        const vapidCfg = getVapidConfig(env);
        return Response.json({ publicKey: vapidCfg.publicKey, public_key: vapidCfg.publicKey });
      }

      if (url.pathname === "/api/reminders/subscribe" || (url.pathname === "/api/reminders" && request.method === "POST")) {
        return handleAddReminder(request, env);
      }
      if (url.pathname === "/api/reminders/unsubscribe" || (url.pathname === "/api/reminders" && request.method === "DELETE")) {
        return handleDeleteReminder(request, env);
      }
      if (url.pathname === "/api/reminders" && request.method === "GET") {
        const list = Array.from(MEMORY_REMINDERS.values());
        return Response.json({ reminders: list });
      }

      if (url.pathname === "/api/test_push" && request.method === "POST") {
        const body = await request.json();
        const res = await sendWebPush(body.subscription, body.payload || { title: "Тестовое уведомление" }, env);
        return Response.json(res);
      }

      return new Response(JSON.stringify({ error: "Endpoint not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 2. Map Tiles Handler (Cloudflare R2 / Static Assets)
    if (url.pathname.startsWith("/tiles/")) {
      const tileKey = url.pathname.replace(/^\/tiles\//, "");

      // 1. Check Cloudflare R2 bucket if bound
      if (env.TILES_BUCKET) {
        try {
          const obj = await env.TILES_BUCKET.get(tileKey);
          if (obj) {
            const headers = new Headers();
            obj.writeHttpMetadata(headers);
            headers.set("Content-Type", "application/x-protobuf");
            headers.set("Content-Encoding", "gzip");
            headers.set("Cache-Control", "public, max-age=2592000, immutable");
            return new Response(obj.body, { headers });
          }
        } catch (e) {}
      }

      // 2. Fallback to Cloudflare Workers Static Assets
      try {
        const assetRes = await env.ASSETS.fetch(request);
        const contentType = assetRes.headers.get("Content-Type") || "";
        if (assetRes.status === 200 && !contentType.includes("text/html")) {
          const newHeaders = new Headers(assetRes.headers);
          newHeaders.set("Content-Type", "application/x-protobuf");
          newHeaders.set("Content-Encoding", "gzip");
          newHeaders.set("Cache-Control", "public, max-age=2592000, immutable");
          return new Response(assetRes.body, {
            status: 200,
            headers: newHeaders
          });
        }
      } catch (e) {}

      return new Response("Tile not found", { status: 404 });
    }

    // 3. Static Assets from Cloudflare
    let response;
    try {
      response = await env.ASSETS.fetch(request);
    } catch (e) {
      return new Response("Asset not found", { status: 404 });
    }

    // Force anti-cache for sw.js, index.html and root
    if (url.pathname === "/sw.js" || url.pathname === "/" || url.pathname === "/index.html") {
      const newHeaders = new Headers(response.headers);
      newHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
      newHeaders.set("Pragma", "no-cache");
      newHeaders.set("Expires", "0");
      return new Response(response.body, {
        status: response.status,
        headers: newHeaders
      });
    }

    return response;
  }
};
