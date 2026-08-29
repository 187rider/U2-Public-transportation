/**
 * Pure Web Crypto RFC 8291 & RFC 8292 Web Push Encryption for Cloudflare Workers
 * No external npm dependencies required.
 */

function base64UrlToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function uint8ArrayToBase64Url(uint8Array) {
  let binary = '';
  for (let i = 0; i < uint8Array.byteLength; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function createVapidJwt(audience, subject, vapidJwk) {
  const header = { typ: 'JWT', alg: 'ES256' };
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
    'jwk',
    vapidJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const sigBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    enc.encode(unsignedToken)
  );

  // Convert DER/raw signature to IEEE P1363 (64 bytes: r + s)
  let sigBytes = new Uint8Array(sigBuffer);
  // Web Crypto on ES256 already produces 64-byte raw r||s
  const sigB64 = uint8ArrayToBase64Url(sigBytes);
  return `${unsignedToken}.${sigB64}`;
}

async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey(
    'raw',
    salt,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm));
}

async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey(
    'raw',
    prk,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const input = new Uint8Array(info.length + 1);
  input.set(info, 0);
  input[info.length] = 1;
  const hash = await crypto.subtle.sign('HMAC', key, input);
  return new Uint8Array(hash).slice(0, length);
}

export async function encryptWebPushPayload(subscription, payloadText, vapidConfig) {
  const userPublicKeyBytes = base64UrlToUint8Array(subscription.keys.p256dh);
  const userAuthBytes = base64UrlToUint8Array(subscription.keys.auth);

  // 1. Generate local ephemeral ECDH keypair
  const localKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  const localPublicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', localKeyPair.publicKey)
  );

  // 2. Import user's public key
  const userPublicKey = await crypto.subtle.importKey(
    'raw',
    userPublicKeyBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  // 3. Derive shared secret
  const sharedSecretBuffer = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: userPublicKey },
    localKeyPair.privateKey,
    256
  );
  const sharedSecret = new Uint8Array(sharedSecretBuffer);

  // 4. RFC 8291 Key Derivation
  // IKM = HKDF-Extract(salt=auth, IKM=sharedSecret)
  // Info for IKM: "WebPush: info\0" + user_public_key + local_public_key
  const authInfo = new Uint8Array(
    new TextEncoder().encode('WebPush: info\0').length +
      userPublicKeyBytes.length +
      localPublicKeyRaw.length
  );
  let offset = 0;
  const webPushInfo = new TextEncoder().encode('WebPush: info\0');
  authInfo.set(webPushInfo, offset);
  offset += webPushInfo.length;
  authInfo.set(userPublicKeyBytes, offset);
  offset += userPublicKeyBytes.length;
  authInfo.set(localPublicKeyRaw, offset);

  const prk = await hkdfExtract(userAuthBytes, sharedSecret);
  const ikm = await hkdfExpand(prk, authInfo, 32);

  // 5. Random 16-byte salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 6. Derive CEK (Content Encryption Key) and Nonce
  const cekPrk = await hkdfExtract(salt, ikm);
  const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\0');

  const cek = await hkdfExpand(cekPrk, cekInfo, 16);
  const nonce = await hkdfExpand(cekPrk, nonceInfo, 12);

  // 7. Encrypt payload (padded with \x02 for single record delimiter)
  const payloadBytes = new TextEncoder().encode(payloadText);
  const record = new Uint8Array(payloadBytes.length + 2); // 1 byte padding + delimiter
  record.set(payloadBytes, 0);
  record[payloadBytes.length] = 0x02; // record delimiter

  const aesKey = await crypto.subtle.importKey(
    'raw',
    cek,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    aesKey,
    record
  );
  const ciphertext = new Uint8Array(encryptedBuffer);

  // 8. Build Header (RFC 8291 aes128gcm format)
  // salt (16 bytes) + rs (4 bytes = 4096 = 0x00,0x00,0x10,0x00) + idlen (1 byte = 65) + key (65 bytes) + ciphertext
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  header[16] = (rs >> 24) & 0xff;
  header[17] = (rs >> 16) & 0xff;
  header[18] = (rs >> 8) & 0xff;
  header[19] = rs & 0xff;
  header[20] = 65; // idlen
  header.set(localPublicKeyRaw, 21);

  const body = new Uint8Array(header.length + ciphertext.length);
  body.set(header, 0);
  body.set(ciphertext, header.length);

  // 9. Generate VAPID Authorization header
  const endpointUrl = new URL(subscription.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const jwt = await createVapidJwt(audience, vapidConfig.subject, vapidConfig.jwk);

  return {
    body,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '60',
      'Urgency': 'high',
      'Authorization': `vapid t=${jwt}, k=${vapidConfig.publicKey}`
    }
  };
}

export async function sendWebPush(subscription, payload, vapidConfig) {
  try {
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const { body, headers } = await encryptWebPushPayload(subscription, payloadStr, vapidConfig);

    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers,
      body
    });

    return {
      status: res.status,
      ok: res.ok,
      endpoint: subscription.endpoint
    };
  } catch (err) {
    return {
      status: 500,
      ok: false,
      error: err.message,
      endpoint: subscription.endpoint
    };
  }
}
