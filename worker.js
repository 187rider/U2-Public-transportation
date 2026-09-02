/**
 * Cloudflare Worker Backend for U2 Public Transportation
 * 100% Serverless: Edge API, AES Bus62 Decryption, RFC 8291 Web Push,
 * TransitState Durable Object Singleton (Global 10s Floor, Single-Writer Reminders, Dead Alarm Resuscitation)
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

function parsePemToJwk(pemStr, publicKeyStr = "") {
  try {
    const cleanStr = (pemStr || "").replace(/\\n/g, "\n").trim();
    if (cleanStr.startsWith("{")) {
      return JSON.parse(cleanStr);
    }

    const toB64Url = (buf) => {
      let bin = "";
      for (let i = 0; i < buf.byteLength; i++) bin += String.fromCharCode(buf[i]);
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };

    // If raw 32-byte scalar (e.g. 43 chars base64url)
    if (cleanStr.length >= 42 && cleanStr.length <= 44 && !cleanStr.includes(" ")) {
      const d = cleanStr;
      if (publicKeyStr) {
        try {
          const pubDer = base64UrlToUint8Array(publicKeyStr);
          if (pubDer.length === 65 && pubDer[0] === 0x04) {
            return {
              kty: "EC",
              crv: "P-256",
              d,
              x: toB64Url(pubDer.subarray(1, 33)),
              y: toB64Url(pubDer.subarray(33, 65)),
              publicKey: publicKeyStr
            };
          }
        } catch (e) {}
      }
    }

    const b64 = cleanStr.replace(/-----[^\n]+-----/g, "").replace(/\s+/g, "");
    const rawStr = atob(b64);
    const der = new Uint8Array(rawStr.length);
    for (let i = 0; i < rawStr.length; i++) der[i] = rawStr.charCodeAt(i);

    let d = null, x = null, y = null, pub = null;

    // 1. Search for private scalar d (0x04 0x20 [32 bytes])
    for (let i = 0; i < der.length - 34; i++) {
      if (der[i] === 0x04 && der[i + 1] === 0x20) {
        d = toB64Url(der.subarray(i + 2, i + 34));
        break;
      }
    }

    // 2. Search for uncompressed public point in SEC1 bitstring (0x03 0x42 0x00 0x04 [64 bytes])
    for (let i = 0; i < der.length - 66; i++) {
      if (der[i] === 0x03 && der[i + 1] === 0x42 && der[i + 2] === 0x00 && der[i + 3] === 0x04) {
        pub = toB64Url(der.subarray(i + 3, i + 68));
        x = toB64Url(der.subarray(i + 4, i + 36));
        y = toB64Url(der.subarray(i + 36, i + 68));
        break;
      }
    }

    // 3. Fallback search for OCTET STRING public point (0x04 0x41 0x04 [64 bytes])
    if (!x || !y) {
      for (let i = 0; i < der.length - 66; i++) {
        if (der[i] === 0x04 && (der[i + 1] === 0x41 || der[i + 1] === 0x42) && der[i + 2] === 0x04) {
          pub = toB64Url(der.subarray(i + 2, i + 67));
          x = toB64Url(der.subarray(i + 3, i + 35));
          y = toB64Url(der.subarray(i + 35, i + 67));
          break;
        }
      }
    }

    // 4. If public point was not in DER but provided separately in publicKeyStr
    if (d && (!x || !y) && publicKeyStr) {
      try {
        const pubDer = base64UrlToUint8Array(publicKeyStr);
        if (pubDer.length === 65 && pubDer[0] === 0x04) {
          x = toB64Url(pubDer.subarray(1, 33));
          y = toB64Url(pubDer.subarray(33, 65));
          pub = publicKeyStr;
        }
      } catch (e) {}
    }

    if (d && x && y) {
      return { kty: "EC", crv: "P-256", x, y, d, publicKey: pub };
    }
  } catch (e) {}
  return null;
}

function getVapidConfig(env = {}) {
  const subject = env.VAPID_SUBJECT || "mailto:support@ridertech.online";
  const rawKey = (
    env.VAPID_JWK_JSON ||
    env.VAPID_PRIVATE_KEY ||
    env.VAPID_KEY ||
    env.VAPID_PEM ||
    env.VAPID_PRIVATE ||
    env.vapid_private_key ||
    env.vapid_key ||
    ""
  ).trim();

  let jwk = null;
  let publicKey = env.VAPID_PUBLIC_KEY || env.vapid_public_key || "";

  if (rawKey) {
    const parsed = parsePemToJwk(rawKey, publicKey);
    if (parsed) {
      jwk = { kty: "EC", crv: "P-256", x: parsed.x, y: parsed.y, d: parsed.d };
      if (parsed.publicKey && !publicKey) {
        publicKey = parsed.publicKey;
      }
    }
  }

  // Strict Fail-Closed: Never embed private keys in source code
  if (!jwk || !jwk.d || !jwk.x || !jwk.y) {
    throw new Error("Invalid or missing VAPID key pair. Set VAPID_PRIVATE_KEY (PEM) or VAPID_JWK_JSON (JSON) in Cloudflare Secrets.");
  }

  // Derive uncompressed public key if not explicitly set
  if (!publicKey) {
    const xBytes = base64UrlToUint8Array(jwk.x);
    const yBytes = base64UrlToUint8Array(jwk.y);
    const fullPub = new Uint8Array(1 + xBytes.length + yBytes.length);
    fullPub[0] = 0x04;
    fullPub.set(xBytes, 1);
    fullPub.set(yBytes, 1 + xBytes.length);
    publicKey = uint8ArrayToBase64Url(fullPub);
  }

  return { subject, publicKey, jwk };
}

// Global In-Memory Cache for Static Transit Data (Routes & Stations)
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

// -------------------------------------------------------------
// 2. HMAC-SHA256 Client Signature Verification (Fails Closed)
// -------------------------------------------------------------
async function verifySignature(request, env = {}) {
  const secret = env.VITE_API_SECRET || env.API_SECRET;
  if (!secret) return false; // Fail closed: missing secret denies request

  const timestamp = request.headers.get("X-App-Timestamp");
  const signature = request.headers.get("X-App-Signature");
  if (!timestamp || !signature) {
    return false;
  }

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > 180) {
    return false; // Expired request window (>3 minutes)
  }

  const enc = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", enc.encode(timestamp + secret));
  const expectedHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return signature.toLowerCase() === expectedHex.toLowerCase();
}

// -------------------------------------------------------------
// 3. Native AES-128-CBC Upstream Token Generator
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
// 4. RFC 8291 Web Push Encryption Engine (Pure Web Crypto)
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

async function encryptWebPushPayload(subscription, payloadText, vapidConfig, tag = "bus-arrival", isUrgent = true) {
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

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    aesKey,
    record
  );
  const ciphertext = new Uint8Array(ciphertextBuffer);

  const header = new Uint8Array(21 + localPublicKeyRaw.length);
  header.set(salt, 0);
  header[16] = 0x00;
  header[17] = 0x00;
  header[18] = 0x10;
  header[19] = 0x00;
  header[20] = localPublicKeyRaw.length;
  header.set(localPublicKeyRaw, 21);

  const body = new Uint8Array(header.length + ciphertext.length);
  body.set(header, 0);
  body.set(ciphertext, header.length);

  const endpointUrl = new URL(subscription.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const jwt = await createVapidJwt(audience, vapidConfig.subject, vapidConfig.jwk);

  const isApple = subscription.endpoint.includes("apple.com") || subscription.endpoint.includes("push.apple.com");

  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "aes128gcm",
    "TTL": isApple ? "300" : "3600", // Android Doze tolerance: 1 hour ensures FCM delivers without early discard
    "Urgency": "high", // High priority ensures FCM wakes device in real time with screen off
    "Authorization": `vapid t=${jwt}, k=${vapidConfig.publicKey}`
  };

  // Apple APNs format support
  if (isApple) {
    headers["apns-push-type"] = "alert";
    headers["apns-priority"] = "10";
    if (tag) headers["apns-collapse-id"] = tag;
  }

  return {
    body,
    headers
  };
}

async function sendWebPush(subscription, payload, env = {}, tag = "bus-arrival", isUrgent = true) {
  try {
    const vapidConfig = getVapidConfig(env);
    const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
    const { body, headers } = await encryptWebPushPayload(subscription, payloadStr, vapidConfig, tag, isUrgent);

    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers,
      body
    });

    return { ok: res.ok, status: res.status };
  } catch (err) {
    console.warn("WebPush send error:", err);
    return { ok: false, error: err.message };
  }
}

// -------------------------------------------------------------
// 5. Shared Helper for Formatting Vehicles
// -------------------------------------------------------------
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

// -------------------------------------------------------------
// 6. Durable Object Singleton: TransitState
// Guarantees:
//  - Exactly 1 global instance for the 10s upstream rate limit floor
//  - Single-writer reminder consistency (zero duplicate pushes)
//  - Background Alarm Ticker (15s cadence + cron resuscitation)
//  - Dead subscription cleanup (HTTP 403, 404, 410 from FCM/APNs)
// -------------------------------------------------------------
export class TransitState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;

    this.lastVehiclePollTime = 0;
    this.lastVehicleSnapshot = null;
    this.vehicleFetchPromise = null;

    this.reminders = new Map();
    this.loadedFromStorage = false;
  }

  async ensureLoaded() {
    if (!this.loadedFromStorage) {
      const stored = await this.storage.list({ prefix: "rem_" });
      for (const [key, val] of stored.entries()) {
        this.reminders.set(key, val);
      }
      this.loadedFromStorage = true;
    }
  }

  async alarm() {
    await this.ensureLoaded();
    try {
      await this.checkRemindersAndNotify();
    } catch (err) {
      console.error("TransitState.alarm error:", err);
    } finally {
      // Always reschedule alarm every 15 seconds if active reminders exist
      if (this.reminders.size > 0) {
        try {
          await this.storage.setAlarm(Date.now() + 15000);
        } catch (e) {}
      }
    }
  }

  async checkRemindersAndNotify() {
    const now = Date.now();
    if (this.reminders.size === 0) return;

    const distinctSids = Array.from(new Set(Array.from(this.reminders.values()).map((r) => r.sid).filter(Boolean)));
    const stationForecastsMap = new Map();
    const cfg = getUpstreamConfig(this.env);

    if (cfg.url && distinctSids.length > 0) {
      await Promise.all(
        distinctSids.map(async (sid) => {
          try {
            const headers = await getBus62Headers(this.env);
            const res = await fetch(`${cfg.url}/getStationForecasts.php?sid=${sid}&city=${cfg.city}`, {
              headers,
              signal: AbortSignal.timeout(4000)
            });
            if (res.ok) {
              const json = await res.json();
              stationForecastsMap.set(sid, Array.isArray(json) ? json : json.forecasts || []);
            }
          } catch (e) {}
        })
      );
    }

    for (const [remKey, rem] of Array.from(this.reminders.entries())) {
      // 1. Evict reminders older than 2 hours
      if (now - rem.createdAt > 7200 * 1000) {
        await this.storage.delete(remKey);
        this.reminders.delete(remKey);
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
      // Re-lock fallback: If locked vehicle dropped out of forecast and was not close to arrival (last > 4), re-lock to nearest live bus on same route
      if (!matching) {
        const candidates = forecasts.filter((f) => String(f.rid) === rem.rid);
        if (candidates.length) {
          if (rem.lastNotifiedTime === null || rem.lastNotifiedTime > 4) {
            matching = candidates.reduce((min, c) => (parseInt(c.arrt || c.time, 10) < parseInt(min.arrt || min.time, 10) ? c : min), candidates[0]);
            rem.vehid = String(matching.obj_id || matching.vehid || "");
            rem.gosNum = String(matching.gosNum || matching.gos_num || "");
            await this.storage.put(remKey, rem);
          }
        }
      }

      // Auto-lock to specific vehicle on initial registration
      if (!rem.vehid && matching && (matching.obj_id || matching.vehid)) {
        rem.vehid = String(matching.obj_id || matching.vehid);
        rem.gosNum = String(matching.gosNum || matching.gos_num || "");
        await this.storage.put(remKey, rem);
      }

      const rnum = rem.rnum;
      const stname = rem.stationName;
      const sub = rem.subscription;
      const tag = `arrival_${rem.sid}_${rem.rid}`;

      // Vehicle vanished after being close (<= 4 min) -> Arrival event!
      if (!matching) {
        if (rem.lastNotifiedTime !== null && rem.lastNotifiedTime <= 4) {
          await sendWebPush(sub, {
            title: `🚌 Маршрут ${rnum} прибыл!`,
            body: `Остановка «${stname}»`,
            tag,
            sid: rem.sid,
            rid: rem.rid
          }, this.env, tag, true);
          await this.storage.delete(remKey);
          this.reminders.delete(remKey);
        }
        continue;
      }

      const rawVal = matching.time != null ? matching.time : (matching.arrt != null ? matching.arrt : matching.arrtime);
      const parsedTime = parseInt(rawVal, 10);
      let curTime = 0;
      if (!isNaN(parsedTime)) {
        // If > 60, it is in seconds (e.g. 180s = 3m); otherwise it is already in minutes (e.g. 3m)
        curTime = parsedTime > 60 ? Math.ceil(parsedTime / 60) : parsedTime;
      }
      const last = rem.lastNotifiedTime;

      // Arrival threshold: 0 minutes or departure bounce (time jumped by >= 3 min while close)
      if (curTime <= 0 || (last !== null && last <= 3 && curTime >= last + 3)) {
        await sendWebPush(sub, {
          title: `🚌 Маршрут ${rnum} прибыл!`,
          body: `Остановка «${stname}»`,
          tag,
          sid: rem.sid,
          rid: rem.rid
        }, this.env, tag, true);
        await this.storage.delete(remKey);
        this.reminders.delete(remKey);
        continue;
      }

      // Smart Doze-friendly Cadence:
      // Paces notifications cleanly across the countdown without burning OEM battery quotas:
      // - Initial registration (last === null)
      // - If curTime > 10: notify every 5 minutes (e.g. 20, 15, 10)
      // - If curTime <= 10 && curTime > 3: notify every 2 minutes (e.g. 8m, 6m, 4m)
      // - If curTime <= 3: notify every single minute (3m, 2m, 1m) and 0m (прибыл)
      let shouldFire = false;
      if (last === null) {
        shouldFire = true;
      } else if (curTime > 10 && curTime <= last - 5) {
        shouldFire = true;
      } else if (last > 10 && curTime <= 10) {
        shouldFire = true;
      } else if (curTime <= 10 && curTime > 3 && curTime <= last - 2) {
        shouldFire = true;
      } else if (curTime <= 3 && curTime < last) {
        shouldFire = true;
      }

      if (shouldFire) {
        rem.lastNotifiedTime = curTime;
        await this.storage.put(remKey, rem);

        const timeWord = curTime === 1 ? "1 минуту" : curTime < 5 ? `${curTime} минуты` : `${curTime} минут`;
        const res = await sendWebPush(sub, {
          title: `🚌 Маршрут ${rnum} через ${timeWord}`,
          body: `Остановка «${stname}»`,
          tag,
          sid: rem.sid,
          rid: rem.rid,
          minutes: curTime
        }, this.env, tag, true);

        // Dead subscription cleanup (HTTP 403, 404, 410 from FCM/APNs)
        if (!res.ok && [403, 404, 410].includes(res.status)) {
          await this.storage.delete(remKey);
          this.reminders.delete(remKey);
          continue;
        }
      }
    }
  }

  async fetch(request) {
    await this.ensureLoaded();
    const url = new URL(request.url);

    // 1. Vehicles endpoint with 10s global floor
    if (url.pathname === "/api/vehicles") {
      const requestedRids = url.searchParams.get("rids") || "";
      const curk = url.searchParams.get("curk") || "0";
      const now = Date.now();

      // Return cached snapshot if polled < 10 seconds ago
      if (this.lastVehicleSnapshot && now - this.lastVehiclePollTime < 10000) {
        return filterAndReturnVehicles(this.lastVehicleSnapshot, requestedRids, curk);
      }

      if (!this.vehicleFetchPromise) {
        this.vehicleFetchPromise = (async () => {
          try {
            const cfg = getUpstreamConfig(this.env);
            if (!cfg.url) return;

            let rids = requestedRids;
            if (!rids) {
              const h = await getBus62Headers(this.env);
              const r = await fetch(`${cfg.url}/getAllRoutes.php?city=${cfg.city}`, {
                headers: h,
                signal: AbortSignal.timeout(4000)
              });
              if (r.ok) {
                const routes = await r.json();
                if (Array.isArray(routes)) {
                  rids = routes.map((rt) => rt.id).filter(Boolean).slice(0, 50).join(",");
                }
              }
            }

            const headers = await getBus62Headers(this.env);
            const apiUrl = `${cfg.url}/getVehicleAnimations.php?curk=0&city=${cfg.city}&rids=${rids}`;
            const res = await fetch(apiUrl, {
              headers,
              signal: AbortSignal.timeout(6000)
            });
            if (res.ok) {
              const items = await res.json();
              if (Array.isArray(items) && items.length > 0) {
                this.lastVehicleSnapshot = items;
                this.lastVehiclePollTime = Date.now();
              }
            }
          } catch (e) {
          } finally {
            this.vehicleFetchPromise = null;
          }
        })();
      }

      await this.vehicleFetchPromise;

      if (this.lastVehicleSnapshot) {
        return filterAndReturnVehicles(this.lastVehicleSnapshot, requestedRids, curk);
      }
      return Response.json({ vehicles: [], next_curk: curk });
    }

    // 2. Reminders Subscribe
    if (url.pathname === "/api/reminders/subscribe" || (url.pathname === "/api/reminders" && request.method === "POST")) {
      const data = await request.json();
      const sub = data.subscription;
      if (!sub || !sub.endpoint || !data.sid || !data.rid) {
        return Response.json({ error: "Invalid reminder payload" }, { status: 400 });
      }

      const remKey = `rem_${data.sid}_${data.rid}_${encodeURIComponent(sub.endpoint.slice(-16))}`;
      const remObj = {
        remKey,
        sid: String(data.sid),
        rid: String(data.rid),
        rnum: String(data.rnum || ""),
        stationName: String(data.stationName || data.stname || ""),
        vehid: data.vehid ? String(data.vehid) : null,
        gosNum: data.gosNum ? String(data.gosNum) : null,
        subscription: sub,
        createdAt: Date.now(),
        lastNotifiedTime: null
      };

      this.reminders.set(remKey, remObj);
      await this.storage.put(remKey, remObj);

      // Start alarm immediately
      await this.storage.setAlarm(Date.now() + 500);

      return Response.json({ ok: true, status: "subscribed", key: remKey });
    }

    // 3. Reminders Unsubscribe (Strict endpoint ownership: only deletes reminders belonging to the requesting subscription)
    if (url.pathname === "/api/reminders/unsubscribe" || (url.pathname === "/api/reminders" && request.method === "DELETE")) {
      const data = await request.json();
      const rawEndpoint = (data.subscription && data.subscription.endpoint) || data.endpoint;
      if (rawEndpoint) {
        const endpoint = String(rawEndpoint).trim();
        const sid = data.sid ? String(data.sid) : null;
        const rid = data.rid ? String(data.rid) : null;

        const keysToDelete = [];
        for (const [key, rem] of this.reminders.entries()) {
          const remEndpoint = rem.subscription && rem.subscription.endpoint ? String(rem.subscription.endpoint).trim() : "";
          const matchEndpoint = remEndpoint === endpoint;
          const matchSid = !sid || rem.sid === sid;
          const matchRid = !rid || rem.rid === rid;

          if (matchEndpoint && matchSid && matchRid) {
            keysToDelete.push(key);
          }
        }

        for (const key of keysToDelete) {
          this.reminders.delete(key);
          await this.storage.delete(key);
        }
      }
      return Response.json({ ok: true, status: "unsubscribed", active_count: this.reminders.size });
    }

    // 4. Reminders Stats (Sanitized - Zero Credentials / Zero PII)
    if (url.pathname === "/api/reminders" && request.method === "GET") {
      return Response.json({ active_count: this.reminders.size });
    }

    // 5. Cron Trigger Backstop & Alarm Resuscitation
    if (url.pathname === "/api/reminders/check") {
      await this.checkRemindersAndNotify();
      if (this.reminders.size > 0 && (await this.storage.getAlarm()) === null) {
        await this.storage.setAlarm(Date.now() + 15000); // Resurrect a dead alarm chain
      }
      return Response.json({ ok: true, checked: this.reminders.size });
    }

    return new Response("Not found in DO", { status: 404 });
  }
}

function getTransitDO(env) {
  if (!env.TRANSIT_STATE) return null;
  const id = env.TRANSIT_STATE.idFromName("ulan-ude-global-singleton");
  return env.TRANSIT_STATE.get(id);
}

// -------------------------------------------------------------
// 7. Edge API Endpoints (Cached in Worker isolates)
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

      // Bounding box filter for Ulan-Ude region (50–55°N, 100–115°E)
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

async function handleGetStationForecasts(url, env = {}) {
  const sid = url.searchParams.get("sid") || "";
  if (!sid) return Response.json({ forecasts: [], sid: "" });

  const cacheKey = `forecasts_sid_${sid}`;
  const cached = getFromCache(cacheKey, 8);
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
  const cached = getFromCache(cacheKey, 8);
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
// 8. Main Worker Fetch & Scheduled Handlers
// -------------------------------------------------------------
export default {
  async scheduled(event, env, ctx) {
    const doStub = getTransitDO(env);
    if (doStub) {
      ctx.waitUntil(doStub.fetch("https://transit.internal/api/reminders/check"));
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Route API Endpoints
    if (url.pathname.startsWith("/api/")) {
      // Strict HMAC Signature Verification (Fails closed on sensitive endpoints)
      if (
        request.method === "POST" ||
        request.method === "DELETE" ||
        url.pathname.startsWith("/api/reminders") ||
        url.pathname === "/api/test_push"
      ) {
        const isValid = await verifySignature(request, env);
        if (!isValid) {
          return Response.json({ error: "Unauthorized: invalid signature or timestamp" }, { status: 403 });
        }
      }

      if (url.pathname === "/api/routes") return handleGetRoutes(env);
      if (url.pathname === "/api/stations") return handleGetStations(env);
      if (url.pathname === "/api/route_nodes") return handleGetRouteNodes(url, env);
      if (url.pathname === "/api/route_stations") return handleGetRouteStations(url, env);

      // Delegate /api/vehicles to the TransitState Durable Object (Global 10s Single-Writer Floor)
      if (url.pathname === "/api/vehicles") {
        const doStub = getTransitDO(env);
        if (doStub) {
          try {
            return await doStub.fetch(request);
          } catch (e) {}
        }
        return Response.json({ error: "Service temporarily unavailable" }, { status: 503 });
      }

      if (url.pathname === "/api/forecasts" || url.pathname === "/api/station_forecasts") {
        return handleGetStationForecasts(url, env);
      }
      if (url.pathname === "/api/vehicle_forecasts") return handleGetVehicleForecasts(url, env);

      if (url.pathname === "/api/vapid_public_key" || url.pathname === "/api/vapid-public-key") {
        try {
          const vapidCfg = getVapidConfig(env);
          return Response.json({ publicKey: vapidCfg.publicKey, public_key: vapidCfg.publicKey });
        } catch (e) {
          return Response.json({ error: "VAPID service unavailable: " + e.message }, { status: 503 });
        }
      }

      // Delegate Reminders strictly to the TransitState Durable Object (Single Source of Truth)
      if (url.pathname.startsWith("/api/reminders")) {
        const doStub = getTransitDO(env);
        if (doStub) {
          try {
            return await doStub.fetch(request);
          } catch (e) {}
        }
        return Response.json({ error: "Reminder service temporarily unavailable" }, { status: 503 });
      }

      if (url.pathname === "/api/test_push" && request.method === "POST") {
        const body = await request.json();
        const tag = body.tag || "test_push";
        const res = await sendWebPush(body.subscription, body.payload || { title: "Тестовое уведомление" }, env, tag);
        return Response.json(res);
      }

      return new Response(JSON.stringify({ error: "Endpoint not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 2. Map Tiles Handler (Cloudflare R2 / Static Assets with protobuf & gzip encoding)
    if (url.pathname.startsWith("/tiles/")) {
      const tileKey = url.pathname.replace(/^\/tiles\//, "");

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

      try {
        const assetRes = await env.ASSETS.fetch(request);
        const contentType = assetRes.headers.get("Content-Type") || "";
        if (assetRes.status === 200 && !contentType.includes("text/html")) {
          const bodyBuf = await assetRes.arrayBuffer();
          if (bodyBuf.byteLength === 0) {
            return new Response(null, { status: 204, statusText: "No Content" });
          }
          const newHeaders = new Headers(assetRes.headers);
          newHeaders.set("Content-Type", "application/x-protobuf");
          newHeaders.set("Cache-Control", "public, max-age=2592000, immutable");
          return new Response(bodyBuf, {
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

    // Permanent Anti-Cache for shell assets
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
