import fs from 'fs';
import crypto from 'crypto';

const ts = Math.floor(Date.now() / 1000);
const secret = "f91d5757d54b";
const msg = url => url + ts + secret;
const sig = url => crypto.createHash('md5').update(msg(url)).digest('hex');

const url = '/api/route_stations?id=1';
fetch('http://127.0.0.1:8000' + url, {
  headers: {
    "X-App-Timestamp": ts.toString(),
    "X-App-Signature": sig(url)
  }
}).then(r => r.json()).then(console.log).catch(console.error);
