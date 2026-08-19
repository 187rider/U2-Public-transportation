from fastapi import FastAPI, HTTPException, Request, Depends
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


BUS62_URL = os.getenv("BUS62_URL", "http://apitest2.bus62.ru:8080").rstrip('/')
BUS62_CITY = os.getenv("BUS62_CITY", "ulanude")

STATIONS_API_URL = f"{BUS62_URL}/getAllStations.php"
ROUTES_API_URL = f"{BUS62_URL}/getAllRoutes.php"
VEHICLES_API_URL = f"{BUS62_URL}/getVehicleAnimations.php"
VEHICLES_API9_URL = os.getenv("VEHICLES_API9_URL", "http://api.bus62.ru/api9/getVehicleAnimations.php")

KEY = os.getenv("BUS62_KEY", "maps.bus62.ru:80").encode('utf-8')
IV  = os.getenv("BUS62_IV", "Content-MD5-Hash").encode('utf-8')
BUS62_HEX_KEY = os.getenv("BUS62_HEX_KEY", "")


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
    if abs(current_ts - ts) > 60:
        raise HTTPException(status_code=403, detail="Timestamp expired or invalid")
        
    expected = hashlib.sha256(f"{ts}{API_SECRET}".encode('utf-8')).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=403, detail="Invalid signature")


# ---------------------------------------------------------
# Server-Side Background Vehicle Poller
# Merges all client requests into 1 single upstream poll / 10s
# ---------------------------------------------------------
class ServerVehiclePoller:
    def __init__(self):
        self.vehicles: dict[str, dict] = {}
        self.veh_last_seen: dict[str, float] = {}
        self.version: int = 1
        self.curk: str = "0"
        self.last_poll_time: float = 0.0
        self.last_client_activity: float = 0.0
        self.rid_last_seen: dict[str, float] = {}
        self.poll_event: asyncio.Event = asyncio.Event()
        self._running: bool = False

    def register_client_request(self, rids: str) -> None:
        now = time.time()
        was_idle = (now - self.last_client_activity) > 60.0
        self.last_client_activity = now
        
        if rids:
            for r in rids.split(","):
                r_clean = r.strip()
                if r_clean:
                    self.rid_last_seen[r_clean] = now

        # Wake up poller immediately ONLY if waking from idle
        if was_idle:
            self.poll_event.set()

    def get_active_rids(self, max_age: float = 300.0) -> str:
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
                veh_rid = veh.get("rid", "")
                if veh_rid and veh_rid not in rid_set:
                    continue
            results.append(veh)

        return {
            "vehicles": results,
            "next_curk": str(self.version)
        }

    async def poll_once(self):
        now = time.time()
        # Hard floor: never hit upstream more often than every 10s, regardless of caller
        if now - self.last_poll_time < 10.0:
            return
        self.last_poll_time = now  # Set at start: attempt = poll

        active_rids = self.get_active_rids()
        if not active_rids:
            return

        params = {"curk": self.curk, "city": BUS62_CITY, "rids": active_rids}
        
        try:
            if BUS62_HEX_KEY:
                # Note: query_string is signed in raw string format; upstream validates before url decoding
                secret_bytes = bytes.fromhex(BUS62_HEX_KEY)
                query_string = f"curk={params['curk']}&city={params['city']}&rids={params['rids']}"
                payload = secret_bytes + query_string.encode('utf-8')
                signature = hashlib.sha256(payload).hexdigest()
                
                headers = {
                    "Content-MD5-Hash": signature,
                    "User-Agent": "ios_BE690AAB-3365-4C72-9975-C71A288BF57E_f3d999a6",
                    "Accept": "*/*",
                    "Accept-Language": "ru",
                    "Accept-Encoding": "gzip, deflate",
                    "Connection": "keep-alive",
                }
                api_url = VEHICLES_API9_URL
            else:
                headers = get_headers()
                api_url = VEHICLES_API_URL

            r = await async_client.get(api_url, params=params, headers=headers, timeout=10)
            r.raise_for_status()

            if not r.text.strip() and api_url == VEHICLES_API9_URL:
                headers = get_headers()
                api_url = VEHICLES_API_URL
                r = await async_client.get(api_url, params=params, headers=headers, timeout=10)
                r.raise_for_status()

            if not r.text.strip():
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

            # Evict vehicles that have not been reported for > 3 minutes (180s)
            stale_keys = [k for k, ts in self.veh_last_seen.items() if now - ts > 180.0]
            for k in stale_keys:
                self.vehicles.pop(k, None)
                self.veh_last_seen.pop(k, None)

        except httpx.HTTPError as e:
            logger.warning("Background vehicle poll upstream error: %s", e)
        except Exception as e:
            logger.error("Background vehicle poll unexpected error: %s", e)

    async def run_loop(self):
        self._running = True
        while self._running:
            try:
                now = time.time()
                # Idle backoff if no clients have requested vehicles in > 60s
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


vehicle_poller = ServerVehiclePoller()


@asynccontextmanager
async def lifespan(app: FastAPI):
    poller_task = asyncio.create_task(vehicle_poller.run_loop())
    yield
    vehicle_poller.stop()
    poller_task.cancel()
    try:
        await poller_task
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
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/api/stations", dependencies=[Depends(verify_signature)])
async def get_stations():
    cached = get_from_cache("stations", CACHE_TTL_STATIC)
    if cached:
        return cached

    try:
        r = await async_client.get(
            STATIONS_API_URL, 
            params={"city": BUS62_CITY}, 
            headers=get_headers(), 
            timeout=30
        )
        r.raise_for_status()
        raw_stations = r.json()
    except httpx.HTTPError as e:
        logger.error("Upstream stations fetch failed: %s", e)
        raise HTTPException(status_code=502, detail="Upstream transit API unavailable")
    except Exception as e:
        logger.error("Unexpected error processing stations: %s", e)
        raise HTTPException(status_code=500, detail="Failed to process stations")

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
    set_in_cache("stations", result, CACHE_TTL_STATIC)
    return result


@app.get("/api/routes", dependencies=[Depends(verify_signature)])
async def get_routes():
    cached = get_from_cache("routes", CACHE_TTL_STATIC)
    if cached:
        return cached

    try:
        r = await async_client.get(
            ROUTES_API_URL, 
            params={"city": BUS62_CITY}, 
            headers=get_headers(), 
            timeout=30
        )
        r.raise_for_status()
        raw_routes = r.json()
    except httpx.HTTPError as e:
        logger.error("Upstream routes fetch failed: %s", e)
        raise HTTPException(status_code=502, detail="Upstream transit API unavailable")
    except Exception as e:
        logger.error("Unexpected error processing routes: %s", e)
        raise HTTPException(status_code=500, detail="Failed to process routes")

    routes_by_num = {}
    for rt in raw_routes:
        num = str(rt.get("number", "")).strip()
        name = str(rt.get("name", "")).strip()
        raw_type = rt.get("type", "")
        if raw_type in ["Т", "Тм", "Трамвай"] or name.startswith("Т-"):
            rt_type = "tram"
        elif raw_type == "М":
            rt_type = "minibus"
        else:
            rt_type = "bus"

        key = f"{rt_type}_{num}"
        rt_id = str(rt.get("id", "")).strip()
        
        if key not in routes_by_num:
            routes_by_num[key] = {
                "id": [rt_id] if rt_id else [],
                "number": num,
                "name": name,
                "type": rt_type,
                "from_station": rt.get("from_station_name", ""),
                "to_station": rt.get("to_station_name", ""),
                "subroutes": []
            }
        else:
            if rt_id and rt_id not in routes_by_num[key]["id"]:
                routes_by_num[key]["id"].append(rt_id)

        routes_by_num[key]["subroutes"].append({
            "id": rt_id,
            "from_station": rt.get("from_station_name", ""),
            "to_station": rt.get("to_station_name", "")
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
    set_in_cache("routes", result, CACHE_TTL_STATIC)
    return result


@app.get("/api/vehicles", dependencies=[Depends(verify_signature)])
async def get_vehicles(rids: str = "", curk: str = "0"):
    if not rids:
        return {"vehicles": []}
        
    vehicle_poller.register_client_request(rids)
    
    # Cold-start warmup: safe because poll_once self-gates on last_poll_time
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


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
