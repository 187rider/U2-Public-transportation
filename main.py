from fastapi import FastAPI, HTTPException, Request, Depends, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from contextlib import asynccontextmanager
import asyncio
import time
import httpx
import uvicorn
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
import binascii
from datetime import datetime, timezone
import os
import json
import base64
import sqlite3
from dotenv import load_dotenv
import hashlib
import hmac
import math
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("transit_api")

load_dotenv()

# Persistent HTTP Connection Pool for sub-millisecond connection reuse
async_client = httpx.AsyncClient(
    limits=httpx.Limits(max_keepalive_connections=50, max_connections=50),
    timeout=httpx.Timeout(10.0, read=30.0)
)

CACHE = {}
CACHE_TTL_FORECASTS = 10.0
CACHE_TTL_STATIC = 6200.0


def get_from_cache(key: str, ttl_unused: float = None):
    entry = CACHE.get(key)
    if entry:
        ts, ttl, data = entry
        if time.time() - ts < ttl:
            return data
    return None


def set_in_cache(key: str, data, ttl: float):
    now = time.time()
    CACHE[key] = (now, ttl, data)
    # Evict on each entry's own terms
    expired = [k for k, (ts, entry_ttl, _) in CACHE.items() if now - ts > entry_ttl]
    for k in expired:
        del CACHE[k]


def load_local_fallback(filename: str):
    try:
        if os.path.exists(filename):
            with open(filename, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        logger.warning("Failed to load local fallback %s: %s", filename, e)
    return None


BUS62_URL = os.getenv("BUS62_URL", "https://api9.bus62.ru").rstrip('/')
BUS62_CITY = os.getenv("BUS62_CITY", "ulanude")

STATIONS_API_URL = f"{BUS62_URL}/getAllStations.php"
ROUTES_API_URL = f"{BUS62_URL}/getAllRoutes.php"
VEHICLES_API_URL = f"{BUS62_URL}/getVehicleAnimations.php"
VEHICLES_API9_URL = os.getenv("VEHICLES_API9_URL", "https://api9.bus62.ru/getVehicleAnimations.php")

KEY = os.getenv("BUS62_KEY", "maps.bus62.ru:80").encode('utf-8')
IV  = os.getenv("BUS62_IV", "Content-MD5-Hash").encode('utf-8')


def generate_hash():
    utc_time = datetime.now(timezone.utc)
    timestamp = utc_time.strftime("%S:%M:%H %Y-%m-%d")
    plaintext = timestamp.encode('utf-8')
    cipher = AES.new(KEY, AES.MODE_CBC, IV)
    ciphertext = cipher.encrypt(pad(plaintext, AES.block_size))
    return binascii.hexlify(ciphertext).decode()


def get_headers():
    return {
        "Content-MD5-Hash": generate_hash(),
        "Accept": "*/*",
        "User-Agent": "ios_BE690AAB-3365-4C72-9975-C71A288BF57E_f3d999a6",
        "Accept-Language": "ru",
        "Accept-Encoding": "gzip, deflate",
        "Connection": "keep-alive",
    }


API_SECRET = os.getenv("VITE_API_SECRET")
if not API_SECRET:
    raise RuntimeError("VITE_API_SECRET environment variable must be set")


async def verify_signature(request: Request):
    timestamp = request.headers.get("X-App-Timestamp")
    signature = request.headers.get("X-App-Signature")
    if not timestamp or not signature:
        raise HTTPException(status_code=403, detail="Missing signature headers")
    
    try:
        ts = int(timestamp)
    except ValueError:
        raise HTTPException(status_code=403, detail="Invalid timestamp format")
    
    current_ts = int(time.time())
    if abs(current_ts - ts) > 180:
        raise HTTPException(status_code=403, detail="Timestamp expired or invalid")
        
    expected = hashlib.sha256(f"{ts}{API_SECRET}".encode('utf-8')).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=403, detail="Invalid signature")


# ---------------------------------------------------------
# Server-Side Background Vehicle Poller
# Merges all client requests with instant on-demand fetch for new routes
# ---------------------------------------------------------
class ServerVehiclePoller:
    def __init__(self):
        self.vehicles: dict[str, dict] = {}
        self.veh_last_seen: dict[str, float] = {}
        self.polled_rids: set[str] = set()
        self.version: int = 1
        self.curk: str = "0"
        self.last_poll_time: float = 0.0
        self.last_client_activity: float = 0.0
        self.rid_last_seen: dict[str, float] = {}
        self.poll_event: asyncio.Event = asyncio.Event()
        self._running: bool = False

    def register_client_request(self, rids: str) -> bool:
        now = time.time()
        was_idle = (now - self.last_client_activity) > 60.0
        self.last_client_activity = now
        
        has_new_rids = False
        if rids:
            for r in rids.split(","):
                r_clean = r.strip()
                if r_clean:
                    if r_clean not in self.polled_rids:
                        has_new_rids = True
                    self.rid_last_seen[r_clean] = now

        # If waking from idle or new routes requested, reset curk to 0 for initial snapshot
        if was_idle or has_new_rids:
            self.curk = "0"
            self.poll_event.set()

        return has_new_rids

    def get_active_rids(self, max_age: float = 60.0) -> str:
        now = time.time()
        active = [rid for rid, ts in self.rid_last_seen.items() if now - ts < max_age]
        # Prune expired rids
        self.rid_last_seen = {rid: ts for rid, ts in self.rid_last_seen.items() if now - ts < max_age}
        return ",".join(active)

    def get_snapshot(self, rids: str = "") -> dict:
        rid_set = set(r.strip() for r in rids.split(",") if r.strip()) if rids else None
        
        results = []
        for veh in self.vehicles.values():
            if rid_set is not None:
                veh_rid = str(veh.get("rid") or "").strip()
                if not veh_rid or veh_rid not in rid_set:
                    continue
            results.append(veh)

        return {
            "vehicles": results,
            "next_curk": str(self.version)
        }

    async def poll_once(self):
        now = time.time()
        if now - self.last_poll_time < 10.0:  # Hard floor, max 1 request per 10s
            return
        self.last_poll_time = now  # Set at start: attempt = poll

        active_rids = self.get_active_rids()
        if not active_rids:
            return

        params = {"curk": self.curk, "city": BUS62_CITY, "rids": active_rids}
        
        try:
            headers = get_headers()
            api_url = VEHICLES_API9_URL if VEHICLES_API9_URL else VEHICLES_API_URL

            r = None
            for attempt in range(2):
                try:
                    r = await async_client.get(api_url, params=params, headers=headers, timeout=12)
                    r.raise_for_status()
                    break
                except (httpx.ReadError, httpx.ConnectError, httpx.RemoteProtocolError) as retry_err:
                    if attempt == 0:
                        await asyncio.sleep(0.6)
                    else:
                        raise retry_err

            if not r or not r.text.strip():
                return

            data = r.json()
            items = data if isinstance(data, list) else []
            max_curk = int(self.curk) if self.curk.isdigit() else 0

            for item in items:
                if not isinstance(item, dict):
                    continue
                try:
                    lat = float(item.get("lat", 0))
                    lng = float(item.get("lng", item.get("lon", 0)))
                    if abs(lat) > 1000: lat /= 1_000_000
                    if abs(lng) > 1000: lng /= 1_000_000
                except (TypeError, ValueError):
                    continue

                anim_key = item.get("anim_key")
                if anim_key and str(anim_key).isdigit():
                    max_curk = max(max_curk, int(anim_key))

                # Process anim_points: API uses snake_case, coords are in microdegrees
                raw_anim_points = item.get("anim_points", [])
                anim_points = []
                if isinstance(raw_anim_points, list):
                    for pt in raw_anim_points:
                        try:
                            pt_lat = float(pt.get("lat", 0))
                            pt_lng = float(pt.get("lon", pt.get("lng", 0)))
                            if abs(pt_lat) > 1000: pt_lat /= 1_000_000
                            if abs(pt_lng) > 1000: pt_lng /= 1_000_000
                            anim_points.append({
                                "percent": float(pt.get("percent", 0)),
                                "lat": pt_lat,
                                "lng": pt_lng,
                                "dir": float(pt.get("dir", 0)) % 360
                            })
                        except (TypeError, ValueError):
                            continue

                if len(anim_points) > 2:
                    anim_points = anim_points[-2:]

                veh_id = str(item.get("vehid") or item.get("id") or "")
                if not veh_id:
                    continue

                raw_dir = float(item.get("dir", 0)) if item.get("dir") is not None else 0
                normalized_dir = raw_dir % 360

                self.vehicles[veh_id] = {
                    "id": veh_id,
                    "lat": lat,
                    "lng": lng,
                    "route": str(item.get("rnum", "")),
                    "dir": normalized_dir,
                    "speed": float(item.get("speed", 0)) if item.get("speed") is not None else 0,
                    "gosNum": str(item.get("gosNum") or item.get("gos_num") or ""),
                    "type": str(item.get("rtype") or ""),
                    "rid": str(item.get("rid") or ""),
                    "anim_key": str(anim_key) if anim_key is not None else "0",
                    "animPoints": anim_points
                }
                self.veh_last_seen[veh_id] = now

            self.curk = str(max_curk)
            self.version += 1
            self.polled_rids.update(r.strip() for r in active_rids.split(",") if r.strip())

        except httpx.HTTPError as e:
            logger.warning("Background vehicle poll upstream error (%s): %s", type(e).__name__, e or repr(e))
        except Exception as e:
            logger.error("Background vehicle poll unexpected error (%s): %s", type(e).__name__, e, exc_info=True)
        finally:
            # Evict vehicles that have not been reported for > 60 seconds (synced 1:1 with frontend isLiveOnMap)
            stale_keys = [k for k, ts in self.veh_last_seen.items() if now - ts > 60.0]
            for k in stale_keys:
                self.vehicles.pop(k, None)
                self.veh_last_seen.pop(k, None)

    async def run_loop(self):
        self._running = True
        while self._running:
            try:
                now = time.time()
                # Idle backoff if no clients have requested vehicles in > 60 seconds
                if now - self.last_client_activity > 60.0:
                    self.poll_event.clear()
                    try:
                        await asyncio.wait_for(self.poll_event.wait(), timeout=60.0)
                    except asyncio.TimeoutError:
                        continue

                await self.poll_once()

                # Poll once every 10 seconds or wake early when new client requests arrive
                self.poll_event.clear()
                try:
                    await asyncio.wait_for(self.poll_event.wait(), timeout=10.0)
                except asyncio.TimeoutError:
                    pass
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Error in vehicle poller loop: %s", e)
                await asyncio.sleep(5.0)

    def stop(self):
        self._running = False
        self.poll_event.set()


# ---------------------------------------------------------
# Web Push Background Notification Manager (Wakes up locked devices)
# ---------------------------------------------------------
VAPID_KEY_FILE = os.getenv("VAPID_KEY_FILE", "vapid_private.pem")
if not os.path.exists(VAPID_KEY_FILE):
    try:
        from py_vapid import Vapid
        v = Vapid()
        v.generate_keys()
        v.save_key(VAPID_KEY_FILE)
    except Exception as e:
        logger.critical("Failed to generate VAPID key file %s: %s", VAPID_KEY_FILE, e)
        raise RuntimeError(f"VAPID key generation failed: {e}")

try:
    from py_vapid import Vapid
    from cryptography.hazmat.primitives import serialization
    vapid_instance = Vapid.from_file(VAPID_KEY_FILE)
    pub_bytes = vapid_instance.public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint
    )
    VAPID_PUBLIC_KEY = base64.urlsafe_b64encode(pub_bytes).decode().rstrip('=')
except Exception as e:
    logger.critical("CRITICAL: Failed to load VAPID key from file %s: %s", VAPID_KEY_FILE, e)
    raise RuntimeError(f"VAPID private key is required for Web Push but failed to load: {e}")

VAPID_CLAIMS = {"sub": "mailto:support@ridertech.online"}


DB_REMINDERS_FILE = os.getenv("DB_REMINDERS_FILE", "reminders.db")


def init_reminders_db():
    with sqlite3.connect(DB_REMINDERS_FILE) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS push_reminders (
                rem_key TEXT PRIMARY KEY,
                subscription_json TEXT,
                sid TEXT,
                station_name TEXT,
                rid TEXT,
                rnum TEXT,
                last_notified_time INTEGER,
                created_at REAL
            )
        """)
        conn.commit()


init_reminders_db()


class PushReminderManager:
    def __init__(self):
        self._running = False

    def get_all_reminders(self) -> dict[str, dict]:
        try:
            with sqlite3.connect(DB_REMINDERS_FILE) as conn:
                conn.row_factory = sqlite3.Row
                rows = conn.execute("SELECT * FROM push_reminders").fetchall()
                res = {}
                for r in rows:
                    try:
                        sub = json.loads(r["subscription_json"])
                    except Exception:
                        continue
                    res[r["rem_key"]] = {
                        "subscription": sub,
                        "sid": str(r["sid"]),
                        "stationName": str(r["station_name"]),
                        "rid": str(r["rid"]),
                        "rnum": str(r["rnum"]),
                        "lastNotifiedTime": r["last_notified_time"],
                        "created_at": float(r["created_at"] or 0)
                    }
                return res
        except Exception as e:
            logger.error("Failed to read reminders DB: %s", e)
            return {}

    def add_reminder(self, data: dict) -> bool:
        sub = data.get("subscription")
        if not sub or not isinstance(sub, dict) or not sub.get("endpoint"):
            return False
        endpoint = sub.get("endpoint")
        sid = str(data.get("sid", ""))
        rid = str(data.get("rid", ""))
        rem_key = f"{endpoint}_{sid}_{rid}"

        init_time = data.get("initialTime")
        init_num = None
        if init_time is not None:
            import re
            m = re.search(r'\d+', str(init_time))
            if m:
                init_num = int(m.group())

        try:
            with sqlite3.connect(DB_REMINDERS_FILE) as conn:
                conn.execute("""
                    INSERT OR REPLACE INTO push_reminders 
                    (rem_key, subscription_json, sid, station_name, rid, rnum, last_notified_time, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    rem_key,
                    json.dumps(sub),
                    sid,
                    str(data.get("stationName", "Остановка")),
                    rid,
                    str(data.get("rnum", "Транспорт")),
                    init_num,
                    time.time()
                ))
                conn.commit()
            logger.info("Saved persistent push reminder: %s for %s (%s) initial: %s", rem_key, data.get("rnum"), data.get("stationName"), init_num)
            return True
        except Exception as e:
            logger.error("Failed to save reminder to DB: %s", e)
            return False

    def remove_reminder(self, endpoint: str, sid: str, rid: str):
        rem_key = f"{endpoint}_{sid}_{rid}"
        try:
            with sqlite3.connect(DB_REMINDERS_FILE) as conn:
                conn.execute("DELETE FROM push_reminders WHERE rem_key = ?", (rem_key,))
                conn.commit()
        except Exception as e:
            logger.error("Failed to remove reminder from DB: %s", e)

    def update_last_notified(self, rem_key: str, last_time: int):
        try:
            with sqlite3.connect(DB_REMINDERS_FILE) as conn:
                conn.execute("UPDATE push_reminders SET last_notified_time = ? WHERE rem_key = ?", (last_time, rem_key))
                conn.commit()
        except Exception as e:
            logger.error("Failed to update reminder in DB: %s", e)

    async def send_webpush(self, sub: dict, title: str, body: str, tag: str = "arrival-alarm") -> bool:
        payload = {
            "title": title,
            "body": body,
            "icon": "/apple-touch-icon.png",
            "tag": tag,
            "url": "/"
        }
        try:
            from pywebpush import webpush
            from urllib.parse import urlparse

            endpoint = sub.get("endpoint", "")
            parsed_url = urlparse(endpoint)
            aud = f"{parsed_url.scheme}://{parsed_url.netloc}"
            fresh_claims = {
                "sub": "mailto:support@ridertech.online",
                "aud": aud
            }

            push_headers = {
                "Urgency": "high"
            }
            if "apple.com" in endpoint:
                push_headers["apns-push-type"] = "alert"
                push_headers["apns-priority"] = "10"

            loop = asyncio.get_running_loop()
            await loop.run_in_executor(
                None,
                lambda: webpush(
                    subscription_info=sub,
                    data=json.dumps(payload),
                    vapid_private_key=VAPID_KEY_FILE,
                    vapid_claims=fresh_claims,
                    headers=push_headers,
                    ttl=120
                )
            )
            logger.info("Sent background WebPush: %s - %s to %s", title, body, aud)
            return True
        except Exception as e:
            logger.warning("WebPush send error (%s): %s", type(e).__name__, e)
            return False

    async def run_loop(self):
        self._running = True
        fetch_sem = asyncio.Semaphore(4)    # Bound concurrent upstream station forecast calls to 4
        push_sem = asyncio.Semaphore(15)    # Bound concurrent push HTTPS sends to 15

        while self._running:
            try:
                await asyncio.sleep(10.0)
                reminders_map = self.get_all_reminders()
                if not reminders_map:
                    continue

                now = time.time()
                active_items = list(reminders_map.items())
                sids = list(set(r["sid"] for _, r in active_items if r.get("sid")))

                # 1. Bounded parallel forecast fetch for all distinct active stations
                async def fetch_station(sid_str: str):
                    async with fetch_sem:
                        try:
                            fc = await get_station_forecasts(sid=sid_str)
                            return sid_str, fc.get("forecasts", [])
                        except Exception as err:
                            logger.warning("Error fetching forecasts for sid %s: %s", sid_str, err)
                            return sid_str, None

                fetched_results = await asyncio.gather(*[fetch_station(sid) for sid in sids], return_exceptions=True)
                station_forecasts_map = {}
                for item in fetched_results:
                    if isinstance(item, tuple) and len(item) == 2:
                        station_forecasts_map[item[0]] = item[1]

                pending_pushes = []

                # 2. Evaluate all active reminders in memory
                for rem_key, rem in active_items:
                    sid = rem.get("sid")
                    # Evict reminders older than 2 hours to prevent table growth
                    if now - rem.get("created_at", 0) > 7200:
                        self.remove_reminder(rem.get("subscription", {}).get("endpoint", ""), sid, rem.get("rid", ""))
                        continue

                    forecasts = station_forecasts_map.get(sid)
                    if forecasts is None:
                        # Upstream fetch failed for this station; retry next cycle without false arrival
                        continue

                    rem_rids = set(r.strip() for r in str(rem.get("rid", "")).split(",") if r.strip())
                    matching_fc = next((f for f in forecasts if str(f.get("rid", "")).strip() in rem_rids), None)

                    if not matching_fc:
                        # If the bus was close (<= 2 min) and now disappeared from forecast list, it has arrived!
                        if rem.get("lastNotifiedTime") is not None and rem["lastNotifiedTime"] <= 2:
                            rnum = rem.get("rnum", "")
                            stname = rem.get("stationName", "")
                            sub = rem.get("subscription")
                            pending_pushes.append({
                                "sub": sub,
                                "title": f"🚌 Маршрут {rnum} прибыл!",
                                "body": f"Остановка «{stname}»",
                                "tag": f"arrival_{rem['sid']}_{rem['rid']}"
                            })
                            self.remove_reminder(rem.get("subscription", {}).get("endpoint", ""), sid, rem.get("rid", ""))
                        continue

                    raw_t = matching_fc.get("time")
                    try:
                        cur_time = int(raw_t) if raw_t is not None else 0
                    except (ValueError, TypeError):
                        cur_time = 0

                    last = rem.get("lastNotifiedTime")
                    should_fire = False

                    if cur_time <= 0:
                        should_fire = True
                    elif last is None:
                        self.update_last_notified(rem_key, cur_time)
                    elif cur_time > last:
                        # If bus was delayed by traffic, update baseline
                        self.update_last_notified(rem_key, cur_time)
                    elif last > 10 and cur_time <= 10:
                        should_fire = True
                    elif last > 10 and cur_time > 10:
                        if cur_time <= last - 5:
                            should_fire = True
                    elif cur_time <= 10:
                        if cur_time <= last - 1:
                            should_fire = True

                    if should_fire:
                        self.update_last_notified(rem_key, cur_time)
                        rnum = rem.get("rnum", "")
                        stname = rem.get("stationName", "")
                        sub = rem.get("subscription")

                        if cur_time <= 0:
                            pending_pushes.append({
                                "sub": sub,
                                "title": f"🚌 Маршрут {rnum} прибыл!",
                                "body": f"Остановка «{stname}»",
                                "tag": f"arrival_{rem['sid']}_{rem['rid']}"
                            })
                            self.remove_reminder(rem.get("subscription", {}).get("endpoint", ""), sid, rem.get("rid", ""))
                        else:
                            pending_pushes.append({
                                "sub": sub,
                                "title": f"🚌 Маршрут {rnum} — {cur_time} мин",
                                "body": f"Остановка «{stname}» (прибытие через ~{cur_time} мин)",
                                "tag": f"arrival_{rem['sid']}_{rem['rid']}"
                            })

                # 3. Bounded parallel WebPush dispatch
                if pending_pushes:
                    async def _send_bounded(args):
                        async with push_sem:
                            await self.send_webpush(**args)

                    await asyncio.gather(*[_send_bounded(p) for p in pending_pushes], return_exceptions=True)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Error in push reminders loop: %s", e)
                await asyncio.sleep(5.0)

    def stop(self):
        self._running = False


vehicle_poller = ServerVehiclePoller()
push_reminder_manager = PushReminderManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    poller_task = asyncio.create_task(vehicle_poller.run_loop())
    reminder_task = asyncio.create_task(push_reminder_manager.run_loop())
    yield
    vehicle_poller.stop()
    push_reminder_manager.stop()
    poller_task.cancel()
    reminder_task.cancel()
    try:
        await asyncio.gather(poller_task, reminder_task, return_exceptions=True)
    except asyncio.CancelledError:
        pass
    await async_client.aclose()


app = FastAPI(title="Ulan-Ude Transit API", lifespan=lifespan)

# Compress large responses (e.g. /api/stations GeoJSON) for mobile clients
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Enable CORS for frontend requests
cors_origins_env = os.getenv("CORS_ORIGINS")
allow_origins = [o.strip() for o in cors_origins_env.split(",") if o.strip()] if cors_origins_env else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

MBTILES_PATH = os.getenv("MBTILES_PATH", "ulan-ude.mbtiles")

@app.api_route("/tiles/{z}/{x}/{y}.pbf", methods=["GET", "HEAD"])
async def get_tile(z: int, x: int, y: int):
    if not os.path.exists(MBTILES_PATH):
        raise HTTPException(status_code=404, detail="MBTiles file not found")
    
    tms_y = (1 << z) - 1 - y
    try:
        conn = sqlite3.connect(f"file:{MBTILES_PATH}?mode=ro", uri=True)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
            (z, x, tms_y)
        )
        row = cursor.fetchone()
        conn.close()
        
        if not row or not row[0]:
            raise HTTPException(status_code=404, detail="Tile not found")
            
        return Response(
            content=row[0],
            media_type="application/x-protobuf",
            headers={
                "Content-Encoding": "gzip",
                "Cache-Control": "public, max-age=604800, immutable"
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error reading tile (%d, %d, %d): %s", z, x, y, e)
        raise HTTPException(status_code=500, detail="Tile query failed")


@app.get("/api/stations", dependencies=[Depends(verify_signature)])
async def get_stations():
    cached = get_from_cache("stations", CACHE_TTL_STATIC)
    if cached:
        return cached

    raw_stations = None
    candidate_urls = list(dict.fromkeys([
        STATIONS_API_URL,
        "https://api9.bus62.ru/getAllStations.php",
        "http://bus62.ru/getAllStations.php"
    ]))
    for url in candidate_urls:
        try:
            r = await async_client.get(
                url, 
                params={"city": BUS62_CITY}, 
                headers=get_headers(), 
                timeout=12
            )
            r.raise_for_status()
            parsed = r.json()
            if isinstance(parsed, list) and len(parsed) > 0:
                raw_stations = parsed
                break
        except Exception as e:
            logger.warning("Upstream stations fetch failed from %s: %s", url, e)

    if not raw_stations:
        fallback = load_local_fallback("stations.json")
        if fallback:
            logger.info("Serving local fallback snapshot for stations")
            set_in_cache("stations", fallback, CACHE_TTL_STATIC)
            return fallback
        raise HTTPException(status_code=502, detail="Upstream transit API unavailable")

    features = []
    for station in raw_stations:
        # 0 = bus, 1 = tram
        st_type = "bus" if str(station.get("type")) == "0" else "tram"
        st_name = str(station.get("name") or "").strip()
        st_id = str(station.get("id", ""))
        is_warm = str(station.get("is_warm", "0"))
        description = str(station.get("description") or "").strip()

        l0, a0 = float(station.get("lon0", 0)) / 1000000.0, float(station.get("lat0", 0)) / 1000000.0
        l1, a1 = float(station.get("lon1", 0)) / 1000000.0, float(station.get("lat1", 0)) / 1000000.0

        coords = None
        if l0 != 0 and a0 != 0 and l1 != 0 and a1 != 0:
            coords = [(l0 + l1) / 2.0, (a0 + a1) / 2.0]
        elif l0 != 0 and a0 != 0:
            coords = [l0, a0]
        elif l1 != 0 and a1 != 0:
            coords = [l1, a1]

        if coords:
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": coords},
                "properties": {
                    "id": st_id,
                    "name": st_name,
                    "type": st_type,
                    "is_warm": is_warm,
                    "description": description
                }
            })

    result = {
        "type": "FeatureCollection",
        "features": features
    }
    # Persist updated snapshot for future offline/fallback usage
    try:
        with open("stations.json", "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False)
    except Exception as e:
        logger.warning("Failed to persist stations.json snapshot: %s", e)

    set_in_cache("stations", result, CACHE_TTL_STATIC)
    return result


@app.get("/api/routes", dependencies=[Depends(verify_signature)])
async def get_routes():
    cached = get_from_cache("routes", CACHE_TTL_STATIC)
    if cached:
        return cached

    raw_routes = None
    candidate_urls = list(dict.fromkeys([
        ROUTES_API_URL,
        "https://api9.bus62.ru/getAllRoutes.php",
        "http://bus62.ru/getAllRoutes.php"
    ]))
    for url in candidate_urls:
        try:
            r = await async_client.get(
                url, 
                params={"city": BUS62_CITY}, 
                headers=get_headers(), 
                timeout=12
            )
            r.raise_for_status()
            parsed = r.json()
            if isinstance(parsed, list) and len(parsed) > 0:
                raw_routes = parsed
                break
        except Exception as e:
            logger.warning("Routes fetch failed from %s: %s", url, e)

    if not raw_routes:
        fallback = load_local_fallback("routes.json")
        if fallback:
            logger.info("Serving local fallback snapshot for routes")
            set_in_cache("routes", fallback, CACHE_TTL_STATIC)
            return fallback
        raise HTTPException(status_code=502, detail="Upstream transit API unavailable")

    routes_by_num = {}
    for rt in raw_routes:
        num = str(rt.get("number", "")).strip()
        name = str(rt.get("name", "")).strip()
        raw_type = str(rt.get("type", "")).strip()
        
        # 'А' -> bus, 'М' -> minibus, 'Т'/'Тм' -> tram
        if raw_type in ["Т", "Тм", "Трамвай"] or name.startswith("Т-") or name.startswith("Тм-"):
            rt_type = "tram"
        elif raw_type in ["М", "М-"] or name.startswith("М-"):
            rt_type = "minibus"
        else:
            rt_type = "bus"

        key = f"{rt_type}_{num}"
        rt_id = str(rt.get("id", "")).strip()
        from_st = str(rt.get("from_station_name") or rt.get("from_station") or "").strip()
        to_st = str(rt.get("to_station_name") or rt.get("to_station") or "").strip()
        
        if key not in routes_by_num:
            routes_by_num[key] = {
                "id": [rt_id] if rt_id else [],
                "number": num,
                "name": name,
                "type": rt_type,
                "from_station": from_st,
                "to_station": to_st,
                "subroutes": []
            }
        else:
            if rt_id and rt_id not in routes_by_num[key]["id"]:
                routes_by_num[key]["id"].append(rt_id)
            if not routes_by_num[key]["from_station"] and from_st:
                routes_by_num[key]["from_station"] = from_st
            if not routes_by_num[key]["to_station"] and to_st:
                routes_by_num[key]["to_station"] = to_st

        routes_by_num[key]["subroutes"].append({
            "id": rt_id,
            "from_station": from_st,
            "to_station": to_st
        })

    formatted_routes = list(routes_by_num.values())
    for route_item in formatted_routes:
        route_item["id"] = ",".join(str(i) for i in route_item["id"])

    def sort_key(item):
        num = item["number"]
        return (item["type"], int(num) if num.isdigit() else 999, num)

    formatted_routes.sort(key=sort_key)

    result = {
        "count": len(formatted_routes),
        "routes": formatted_routes
    }
    # Persist updated snapshot for future offline/fallback usage
    try:
        with open("routes.json", "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False)
    except Exception as e:
        logger.warning("Failed to persist routes.json snapshot: %s", e)

    set_in_cache("routes", result, CACHE_TTL_STATIC)
    return result


@app.get("/api/vehicles", dependencies=[Depends(verify_signature)])
async def get_vehicles(rids: str = "", curk: str = "0"):
    if not rids:
        return {"vehicles": []}
        
    vehicle_poller.register_client_request(rids)
    
    # Cold start only: if never polled before, perform initial poll
    if vehicle_poller.last_poll_time == 0:
        await vehicle_poller.poll_once()

    return vehicle_poller.get_snapshot(rids)


@app.get("/api/route_nodes", dependencies=[Depends(verify_signature)])
async def get_route_nodes(id: str = ""):
    if not id:
        return {"nodes": []}
        
    cache_key = f"route_nodes_{id}"
    cached = get_from_cache(cache_key, CACHE_TTL_STATIC)
    if cached:
        return cached
    
    url = f"{BUS62_URL}/getRouteNodes.php"
    params = {"id": id, "city": BUS62_CITY}
    try:
        r = await async_client.get(url, params=params, headers=get_headers(), timeout=10)
        r.raise_for_status()
        if not r.text.strip():
            result = {"nodes": []}
            set_in_cache(cache_key, result, CACHE_TTL_STATIC)
            return result
        data = r.json()
        nodes = []
        for point in data:
            try:
                lat = float(point.get("lat", 0))
                lon = float(point.get("lon", point.get("lng", 0)))
                if abs(lat) > 1000: lat /= 1_000_000
                if abs(lon) > 1000: lon /= 1_000_000
                if lat and lon:
                    nodes.append([lon, lat])
            except (TypeError, ValueError):
                continue
        result = {"nodes": nodes}
        set_in_cache(cache_key, result, CACHE_TTL_STATIC)
        return result
    except httpx.HTTPError as e:
        logger.error("Upstream route nodes fetch failed: %s", e)
        raise HTTPException(status_code=502, detail="Upstream transit API unavailable")
    except Exception as e:
        logger.error("Unexpected error fetching route nodes: %s", e)
        raise HTTPException(status_code=500, detail="Failed to fetch route nodes")


@app.get("/api/route_stations", dependencies=[Depends(verify_signature)])
async def get_route_stations(id: str = ""):
    if not id:
        return {"stations": []}
        
    cache_key = f"route_stations_{id}"
    cached = get_from_cache(cache_key, CACHE_TTL_STATIC)
    if cached:
        return cached
    
    url = f"{BUS62_URL}/getRouteStations.php"
    params = {"id": id, "city": BUS62_CITY}
    try:
        r = await async_client.get(url, params=params, headers=get_headers(), timeout=10)
        r.raise_for_status()
        if not r.text.strip():
            result = {"stations": []}
            set_in_cache(cache_key, result, CACHE_TTL_STATIC)
            return result
        data = r.json()
        
        station_ids = []
        if isinstance(data, list):
            for item in data:
                sid = item.get("station_id")
                if sid is not None:
                    station_ids.append(str(sid))
                    
        result = {"stations": station_ids}
        set_in_cache(cache_key, result, CACHE_TTL_STATIC)
        return result
    except httpx.HTTPError as e:
        logger.error("Upstream route stations fetch failed: %s", e)
        raise HTTPException(status_code=502, detail="Upstream transit API unavailable")
    except Exception as e:
        logger.error("Unexpected error fetching route stations: %s", e)
        raise HTTPException(status_code=500, detail="Failed to fetch route stations")


@app.get("/api/vehicle_forecasts", dependencies=[Depends(verify_signature)])
async def get_vehicle_forecasts(vehid: str = ""):
    if not vehid:
        return {"forecasts": []}
        
    cache_key = f"vehicle_forecasts_{vehid}"
    cached = get_from_cache(cache_key, CACHE_TTL_FORECASTS)
    if cached:
        return cached
    
    url = f"{BUS62_URL}/getVehicleForecasts.php"
    params = {"vehid": vehid, "city": BUS62_CITY}
    try:
        r = await async_client.get(url, params=params, headers=get_headers(), timeout=10)
        r.raise_for_status()
        if not r.text.strip():
            result = {"forecasts": []}
            set_in_cache(cache_key, result, CACHE_TTL_FORECASTS)
            return result
        data = r.json()
        
        forecasts = []
        if isinstance(data, list):
            for item in data:
                raw_time = item.get("arrt") or item.get("time") or ""
                try:
                    # Transit convention: ceil minutes so 59s displays as 1 min
                    time_val = math.ceil(int(raw_time) / 60) if raw_time else 0
                except (TypeError, ValueError):
                    time_val = 0
                stid = str(item.get("stid") or "")
                forecasts.append({"stid": stid, "time": time_val})
        result = {"forecasts": forecasts}
        set_in_cache(cache_key, result, CACHE_TTL_FORECASTS)
        return result
    except httpx.HTTPError as e:
        logger.error("Upstream vehicle forecasts fetch failed: %s", e)
        raise HTTPException(status_code=502, detail="Upstream transit API unavailable")
    except Exception as e:
        logger.error("Unexpected error fetching vehicle forecasts: %s", e)
        raise HTTPException(status_code=500, detail="Failed to fetch vehicle forecasts")


@app.get("/api/station_forecasts", dependencies=[Depends(verify_signature)])
async def get_station_forecasts(sid: str = ""):
    if not sid:
        return {"forecasts": []}
        
    cache_key = f"station_forecasts_{sid}"
    cached = get_from_cache(cache_key, CACHE_TTL_FORECASTS)
    if cached:
        return cached
    
    url = f"{BUS62_URL}/getStationForecasts.php"
    params = {"sid": sid, "city": BUS62_CITY}
    try:
        r = await async_client.get(url, params=params, headers=get_headers(), timeout=10)
        r.raise_for_status()
        if not r.text.strip():
            result = {"forecasts": []}
            set_in_cache(cache_key, result, CACHE_TTL_FORECASTS)
            return result
        data = r.json()
        
        forecasts = []
        if isinstance(data, list):
            for item in data:
                raw_time = item.get("arrt") or item.get("time") or ""
                try:
                    time_val = math.ceil(int(raw_time) / 60) if raw_time else 0
                except (TypeError, ValueError):
                    time_val = 0
                rid = str(item.get("rid") or "")
                dest = str(item.get("where") or "")
                forecasts.append({"rid": rid, "time": time_val, "destination": dest})
        result = {"forecasts": forecasts}
        set_in_cache(cache_key, result, CACHE_TTL_FORECASTS)
        return result
    except httpx.HTTPError as e:
        logger.error("Upstream station forecasts fetch failed: %s", e)
        raise HTTPException(status_code=502, detail="Upstream transit API unavailable")
    except Exception as e:
        logger.error("Unexpected error fetching station forecasts: %s", e)
        raise HTTPException(status_code=500, detail="Failed to fetch station forecasts")


@app.get("/api/vapid_public_key")
async def get_vapid_public_key():
    return {"publicKey": VAPID_PUBLIC_KEY}


@app.post("/api/reminders/subscribe", dependencies=[Depends(verify_signature)])
async def subscribe_reminder(request: Request):
    try:
        body = await request.json()
        success = push_reminder_manager.add_reminder(body)
        if not success:
            raise HTTPException(status_code=400, detail="Invalid push subscription data")
        return {"status": "ok", "message": "Subscribed to arrival push alerts"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to subscribe reminder: %s", e)
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/reminders/unsubscribe", dependencies=[Depends(verify_signature)])
async def unsubscribe_reminder(request: Request):
    try:
        body = await request.json()
        push_reminder_manager.remove_reminder(
            endpoint=str(body.get("endpoint", "")),
            sid=str(body.get("sid", "")),
            rid=str(body.get("rid", ""))
        )
        return {"status": "ok", "message": "Unsubscribed from arrival push alerts"}
    except Exception as e:
        logger.error("Failed to unsubscribe reminder: %s", e)
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/reminders/test_push", dependencies=[Depends(verify_signature)])
async def test_push_endpoint(request: Request):
    try:
        body = await request.json()
        sub = body.get("subscription")
        delay = max(0, min(int(body.get("delay", 3)), 30))
        if not sub or not isinstance(sub, dict):
            raise HTTPException(status_code=400, detail="Missing subscription")

        async def send_delayed():
            await asyncio.sleep(delay)
            await push_reminder_manager.send_webpush(
                sub=sub,
                title="🔔 Тестовое уведомление",
                body="Фоновые уведомления на экране блокировки работают!",
                tag="test-alert"
            )

        asyncio.create_task(send_delayed())
        return {"status": "ok", "message": f"Test push scheduled in {delay}s"}
    except Exception as e:
        logger.error("Failed to schedule test push: %s", e)
        raise HTTPException(status_code=400, detail=str(e))


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
