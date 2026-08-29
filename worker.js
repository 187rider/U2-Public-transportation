/**
 * Cloudflare Worker Backend for U2 Public Transportation
 * 100% Serverless: Edge API, AES Bus62 Decryption, RFC 8291 Web Push & Static Assets
 */

// -------------------------------------------------------------
// 1. Constants & VAPID Configuration
// -------------------------------------------------------------
const BUS62_URL = "https://api9.bus62.ru";
const BUS62_CITY = "ulanude";
const BUS62_KEY = "maps.bus62.ru:80";
const BUS62_IV = "Content-MD5-Hash";

const VAPID_CONFIG = {
  subject: "mailto:support@ridertech.online",
  publicKey: "BIXzDjpsB1MtIw0XKWIZG-5ugMwqqj3lkptzyFAeMbBPkWuaMc4H9AKy0AxUHCejIXmPskURHUbYKJsA-DaG1uE",
  jwk: {
    kty: "EC",
    x: "hfMOOmwHUy0jDRcpYhkb7m6AzCqqPeWSm3PIUB4xsE8",
    y: "kWuaMc4H9AKy0AxUHCejIXmPskURHUbYKJsA-DaG1uE",
    crv: "P-256",
    d: "REDACTED_VAPID_PRIVATE_KEY"
  }
};

// In-Memory Global Cache (Lives across requests within the same Edge Worker instance)
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

// In-Memory Fallback Store for Reminders (also supports D1 if bound)
const MEMORY_REMINDERS = new Map();

// -------------------------------------------------------------
// 2. Bus62 API AES-128-CBC Header Generator
// -------------------------------------------------------------
async function generateBus62Hash() {
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
    enc.encode(BUS62_KEY),
    { name: "AES-CBC" },
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: enc.encode(BUS62_IV) },
    key,
    enc.encode(str)
  );

  return Array.from(new Uint8Array(encrypted))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getBus62Headers() {
  const hash = await generateBus62Hash();
  return {
    "Content-MD5-Hash": hash,
    "User-Agent": "ios_BE690AAB-3365-4C72-9975-C71A288BF57E_f3d999a6",
    "Accept": "*/*",
    "Accept-Language": "ru",
    "Accept-Encoding": "gzip, deflate"
  };
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

  return {
    body,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "60",
      "Urgency": "high",
      "Authorization": `vapid t=${jwt}, k=${vapidConfig.publicKey}`
    }
  };
}

async function sendWebPush(subscription, payload) {
  try {
    const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
    const { body, headers } = await encryptWebPushPayload(subscription, payloadStr, VAPID_CONFIG);

    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers,
      body
    });

    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// -------------------------------------------------------------
// 4. API Endpoints Implementation
// -------------------------------------------------------------
async function handleGetRoutes(url) {
  const cached = getFromCache("all_routes", 3600);
  if (cached) return Response.json(cached);

  const headers = await getBus62Headers();
  const res = await fetch(`${BUS62_URL}/getAllRoutes.php?city=${BUS62_CITY}`, { headers });
  if (!res.ok) return new Response("Failed to fetch routes", { status: 502 });

  const data = await res.json();
  setInCache("all_routes", data);
  return Response.json(data);
}

async function handleGetStops(url) {
  const cached = getFromCache("all_stops", 3600);
  if (cached) return Response.json(cached);

  const headers = await getBus62Headers();
  const res = await fetch(`${BUS62_URL}/getAllStations.php?city=${BUS62_CITY}`, { headers });
  if (!res.ok) return new Response("Failed to fetch stations", { status: 502 });

  const data = await res.json();
  setInCache("all_stops", data);
  return Response.json(data);
}

async function handleGetVehicles(url) {
  const requestedRids = url.searchParams.get("rids") || "";
  let rids = requestedRids;
  const curk = url.searchParams.get("curk") || "0";

  // If no specific routes requested, fetch all known city route IDs
  if (!rids) {
    let routes = getFromCache("all_routes", 3600);
    if (!routes) {
      const h = await getBus62Headers();
      const r = await fetch(`${BUS62_URL}/getAllRoutes.php?city=${BUS62_CITY}`, { headers: h });
      if (r.ok) {
        routes = await r.json();
        setInCache("all_routes", routes);
      }
    }
    if (Array.isArray(routes) && routes.length) {
      rids = routes.map((rt) => rt.id).filter(Boolean).join(",");
    }
  }

  if (!rids) {
    return Response.json({ vehicles: [], next_curk: curk });
  }

  const headers = await getBus62Headers();
  const apiUrl = `${BUS62_URL}/getVehicleAnimations.php?curk=${curk}&city=${BUS62_CITY}&rids=${rids}`;
  const res = await fetch(apiUrl, { headers });

  if (!res.ok) {
    return Response.json({ vehicles: [], next_curk: curk });
  }

  const items = await res.json();
  if (!Array.isArray(items)) {
    return Response.json({ vehicles: [], next_curk: curk });
  }

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

async function handleGetForecasts(url) {
  const sid = url.searchParams.get("sid") || "";
  if (!sid) return Response.json({ forecasts: [], sid: "" });

  const headers = await getBus62Headers();
  const res = await fetch(`${BUS62_URL}/getStationForecasts.php?sid=${sid}&city=${BUS62_CITY}`, { headers });
  if (!res.ok) return Response.json({ forecasts: [], sid });

  const data = await res.json();
  const rawList = Array.isArray(data) ? data : data.forecasts || [];

  const forecasts = rawList.map((f) => ({
    rid: String(f.rid || ""),
    rnum: String(f.rnum || f.route || ""),
    time: parseInt(f.time || f.arrtime || 0, 10),
    vehid: String(f.vehid || f.id || ""),
    gosNum: String(f.gos_num || f.gosNum || ""),
    type: String(f.type || "А")
  }));

  return Response.json({ forecasts, sid });
}

async function handleGetVehicleForecasts(url) {
  const vehid = url.searchParams.get("vehid") || "";
  if (!vehid) return Response.json({ forecasts: [], vehid: "" });

  const headers = await getBus62Headers();
  const res = await fetch(`${BUS62_URL}/getVehicleForecasts.php?vehid=${vehid}&city=${BUS62_CITY}`, { headers });
  if (!res.ok) return Response.json({ forecasts: [], vehid });

  const data = await res.json();
  return Response.json({ forecasts: Array.isArray(data) ? data : [], vehid });
}

// -------------------------------------------------------------
// 5. Push Reminders & Background Tracker
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
  const remKey = `${endpoint}_${sid}_${rid}`;

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

  // 1. Store in D1 if available
  if (env.DB) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO push_reminders 
       (rem_key, subscription_json, sid, station_name, rid, rnum, vehid, gos_num, last_notified_time, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      remKey,
      JSON.stringify(sub),
      sid,
      reminderRecord.stationName,
      rid,
      reminderRecord.rnum,
      vehid,
      gosNum,
      initNum,
      Date.now() / 1000
    ).run();
  }

  // 2. Also keep in Memory map
  MEMORY_REMINDERS.set(remKey, reminderRecord);

  return Response.json({ success: true, key: remKey });
}

async function handleDeleteReminder(request, env) {
  const data = await request.json();
  const ep = data.endpoint || (data.subscription && data.subscription.endpoint);
  const sid = String(data.sid || "");
  const rid = String(data.rid || "");

  if (env.DB && ep) {
    if (sid && rid) {
      await env.DB.prepare("DELETE FROM push_reminders WHERE rem_key = ?").bind(`${ep}_${sid}_${rid}`).run();
    } else {
      await env.DB.prepare("DELETE FROM push_reminders WHERE rem_key LIKE ?").bind(`${ep}%`).run();
    }
  }

  for (const [key, rem] of MEMORY_REMINDERS.entries()) {
    if (rem.subscription.endpoint === ep) {
      if (!sid || (rem.sid === sid && rem.rid === rid)) {
        MEMORY_REMINDERS.delete(key);
      }
    }
  }

  return Response.json({ success: true });
}

async function checkRemindersAndNotify(env) {
  let reminders = [];

  // Load from D1 or Memory
  if (env.DB) {
    try {
      const { results } = await env.DB.prepare("SELECT * FROM push_reminders").all();
      for (const r of results || []) {
        try {
          reminders.push({
            remKey: r.rem_key,
            subscription: JSON.parse(r.subscription_json),
            sid: String(r.sid),
            stationName: String(r.station_name),
            rid: String(r.rid),
            rnum: String(r.rnum),
            vehid: String(r.vehid || ""),
            gosNum: String(r.gos_num || ""),
            lastNotifiedTime: r.last_notified_time,
            createdAt: r.created_at * 1000
          });
        } catch (e) {}
      }
    } catch (e) {
      reminders = Array.from(MEMORY_REMINDERS.values());
    }
  } else {
    reminders = Array.from(MEMORY_REMINDERS.values());
  }

  if (!reminders.length) return;

  const distinctSids = Array.from(new Set(reminders.map((r) => r.sid).filter(Boolean)));
  const stationForecastsMap = new Map();

  // Parallel fetch for all active stations
  await Promise.all(
    distinctSids.map(async (sid) => {
      try {
        const headers = await getBus62Headers();
        const res = await fetch(`${BUS62_URL}/getStationForecasts.php?sid=${sid}&city=${BUS62_CITY}`, { headers });
        if (res.ok) {
          const json = await res.json();
          stationForecastsMap.set(sid, Array.isArray(json) ? json : json.forecasts || []);
        }
      } catch (e) {}
    })
  );

  const now = Date.now();
  for (const rem of reminders) {
    // Evict reminders older than 2 hours
    if (now - rem.createdAt > 7200 * 1000) {
      if (env.DB) await env.DB.prepare("DELETE FROM push_reminders WHERE rem_key = ?").bind(rem.remKey).run();
      MEMORY_REMINDERS.delete(rem.remKey);
      continue;
    }

    const forecasts = stationForecastsMap.get(rem.sid);
    if (!forecasts) continue;

    let matching = null;
    if (rem.vehid) {
      matching = forecasts.find((f) => String(f.vehid || f.id) === rem.vehid);
    }
    if (!matching && rem.gosNum) {
      matching = forecasts.find((f) => String(f.gos_num || f.gosNum || "").toLowerCase() === rem.gosNum.toLowerCase());
    }
    if (!matching && !rem.vehid && !rem.gosNum) {
      const candidates = forecasts.filter((f) => String(f.rid) === rem.rid);
      if (candidates.length) {
        matching = candidates.reduce((min, c) => (parseInt(c.time, 10) < parseInt(min.time, 10) ? c : min), candidates[0]);
      }
    }

    // Auto-lock to vehicle
    if (!rem.vehid && matching && matching.vehid) {
      rem.vehid = String(matching.vehid);
      rem.gosNum = String(matching.gosNum || matching.gos_num || "");
      if (env.DB) {
        await env.DB.prepare("UPDATE push_reminders SET vehid = ?, gos_num = ? WHERE rem_key = ?")
          .bind(rem.vehid, rem.gosNum, rem.remKey).run();
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
        });
        if (env.DB) await env.DB.prepare("DELETE FROM push_reminders WHERE rem_key = ?").bind(rem.remKey).run();
        MEMORY_REMINDERS.delete(rem.remKey);
      }
      continue;
    }

    const curTime = parseInt(matching.time || matching.arrtime || 0, 10);
    const last = rem.lastNotifiedTime;

    // Arrival jump detection
    if (last !== null && last <= 3 && (curTime >= last + 2 || (last <= 1 && curTime > last))) {
      await sendWebPush(sub, {
        title: `🚌 Маршрут ${rnum} прибыл!`,
        body: `Остановка «${stname}»`,
        tag: `arrival_${rem.sid}_${rem.rid}`,
        sid: rem.sid,
        rid: rem.rid
      });
      if (env.DB) await env.DB.prepare("DELETE FROM push_reminders WHERE rem_key = ?").bind(rem.remKey).run();
      MEMORY_REMINDERS.delete(rem.remKey);
      continue;
    }

    let shouldFire = false;
    if (curTime <= 0) {
      shouldFire = true;
    } else if (last === null) {
      rem.lastNotifiedTime = curTime;
      if (env.DB) await env.DB.prepare("UPDATE push_reminders SET last_notified_time = ? WHERE rem_key = ?").bind(curTime, rem.remKey).run();
    } else if (curTime < last) {
      shouldFire = true;
    }

    if (shouldFire) {
      rem.lastNotifiedTime = curTime;
      if (env.DB) await env.DB.prepare("UPDATE push_reminders SET last_notified_time = ? WHERE rem_key = ?").bind(curTime, rem.remKey).run();

      if (curTime <= 0) {
        await sendWebPush(sub, {
          title: `🚌 Маршрут ${rnum} прибыл!`,
          body: `Остановка «${stname}»`,
          tag: `arrival_${rem.sid}_${rem.rid}`,
          sid: rem.sid,
          rid: rem.rid
        });
        if (env.DB) await env.DB.prepare("DELETE FROM push_reminders WHERE rem_key = ?").bind(rem.remKey).run();
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
        });
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
      // Background reminder tracking piggybacked on active user traffic
      ctx.waitUntil(checkRemindersAndNotify(env));

      if (url.pathname === "/api/routes") return handleGetRoutes(url);
      if (url.pathname === "/api/stops") return handleGetStops(url);
      if (url.pathname === "/api/vehicles") return handleGetVehicles(url);
      if (url.pathname === "/api/forecasts") return handleGetForecasts(url);
      if (url.pathname === "/api/vehicle_forecasts") return handleGetVehicleForecasts(url);
      if (url.pathname === "/api/vapid_public_key") {
        return Response.json({ publicKey: VAPID_CONFIG.publicKey });
      }

      if (url.pathname === "/api/reminders") {
        if (request.method === "POST") return handleAddReminder(request, env);
        if (request.method === "DELETE") return handleDeleteReminder(request, env);
        if (request.method === "GET") {
          const list = Array.from(MEMORY_REMINDERS.values());
          return Response.json({ reminders: list });
        }
      }

      if (url.pathname === "/api/test_push" && request.method === "POST") {
        const body = await request.json();
        const res = await sendWebPush(body.subscription, body.payload || { title: "Тестовое уведомление" });
        return Response.json(res);
      }

      return new Response(JSON.stringify({ error: "Endpoint not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Static Assets from Cloudflare
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
