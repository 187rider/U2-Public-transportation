from fastapi import FastAPI, HTTPException, Request, Depends
import time
from fastapi.middleware.cors import CORSMiddleware
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import uvicorn
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
import binascii
from datetime import datetime, timezone
import os
from dotenv import load_dotenv
import hashlib

load_dotenv()

# Persistent HTTP Connection Pool for sub-millisecond connection reuse
session = requests.Session()
adapter = HTTPAdapter(
    pool_connections=50,
    pool_maxsize=50,
    max_retries=Retry(total=2, backoff_factor=0.1)
)
session.mount("http://", adapter)
session.mount("https://", adapter)

CACHE = {}
CACHE_TTL_VEHICLES = 2.0
CACHE_TTL_FORECASTS = 10.0
CACHE_TTL_STATIC = 6200.0

def get_from_cache(key: str, ttl: float):
    if key in CACHE:
        timestamp, data = CACHE[key]
        if time.time() - timestamp < ttl:
            return data
    return None

def set_in_cache(key: str, data, ttl: float):
    CACHE[key] = (time.time(), data)
    # Cleanup expired items occasionally
    current_time = time.time()
    keys_to_delete = [k for k, v in CACHE.items() if current_time - v[0] > max(ttl, 60.0)]
    for k in keys_to_delete:
        del CACHE[k]

app = FastAPI(title="Ulan-Ude Transit API")

# Enable CORS so your React frontend can make requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    if signature != expected:
        raise HTTPException(status_code=403, detail="Invalid signature")

@app.get("/api/stations", dependencies=[Depends(verify_signature)])
def get_stations():
    cached = get_from_cache("stations", CACHE_TTL_STATIC)
    if cached:
        return cached

    try:
        r = session.get(
            STATIONS_API_URL, 
            params={"city": BUS62_CITY}, 
            headers=get_headers(), 
            timeout=30
        )
        r.raise_for_status()
        raw_stations = r.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch stations: {str(e)}")

    features = []

    for station in raw_stations:
        # 0 = bus, 1 = tram
        st_type = "bus" if str(station.get("type")) == "0" else "tram"
        st_name = station.get("name", "").strip()
        st_id = str(station.get("id", ""))
        is_warm = str(station.get("is_warm", "0"))
        description = station.get("description", "").strip()

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
def get_routes():
    cached = get_from_cache("routes", CACHE_TTL_STATIC)
    if cached:
        return cached

    try:
        r = session.get(
            ROUTES_API_URL, 
            params={"city": BUS62_CITY}, 
            headers=get_headers(), 
            timeout=30
        )
        r.raise_for_status()
        raw_routes = r.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch routes: {str(e)}")

    routes_by_num = {}
    for rt in raw_routes:
        num = rt.get("number", "").strip()
        name = rt.get("name", "").strip()
        raw_type = rt.get("type", "")
        if raw_type in ["Т", "Тм", "Трамвай"] or name.startswith("Т-"):
            rt_type = "tram"
        elif raw_type == "М":
            rt_type = "minibus"
        else:
            rt_type = "bus"

        key = f"{rt_type}_{num}"
        if key not in routes_by_num:
            routes_by_num[key] = {
                "id": [rt.get("id")],
                "number": num,
                "name": name,
                "type": rt_type,
                "from_station": rt.get("from_station_name", ""),
                "to_station": rt.get("to_station_name", ""),
                "subroutes": []
            }
        else:
            if rt.get("id") not in routes_by_num[key]["id"]:
                routes_by_num[key]["id"].append(rt.get("id"))

        routes_by_num[key]["subroutes"].append({
            "id": rt.get("id"),
            "from_station": rt.get("from_station_name", ""),
            "to_station": rt.get("to_station_name", "")
        })

    formatted_routes = list(routes_by_num.values())
    for r in formatted_routes:
        r["id"] = ",".join(r["id"])

    def sort_key(r):
        num = r["number"]
        return (r["type"], int(num) if num.isdigit() else 999, num)

    formatted_routes.sort(key=sort_key)

    result = {
        "count": len(formatted_routes),
        "routes": formatted_routes
    }
    set_in_cache("routes", result, CACHE_TTL_STATIC)
    return result

@app.get("/api/vehicles", dependencies=[Depends(verify_signature)])
def get_vehicles(rids: str = "", curk: str = "0"):
    if not rids:
        return {"vehicles": []}
        
    cache_key = f"vehicles_{rids}_{curk}"
    cached = get_from_cache(cache_key, CACHE_TTL_VEHICLES)
    if cached:
        return cached

    try:
        params = {"curk": curk, "city": BUS62_CITY, "rids": rids}
        
        if BUS62_HEX_KEY:
            # Use v9 API with SHA256 signature
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
            # Fallback to old API with AES timestamp hash
            headers = get_headers()
            api_url = VEHICLES_API_URL

        r = session.get(
            api_url, 
            params=params, 
            headers=headers, 
            timeout=10
        )
        r.raise_for_status()

        # If api9 returned an empty string, it might not support this city (e.g. Ulan-Ude).
        # Fallback to the older AES apitest2 API in that case.
        if not r.text.strip() and api_url == VEHICLES_API9_URL:
            headers = get_headers()
            api_url = VEHICLES_API_URL
            r = session.get(api_url, params=params, headers=headers, timeout=10)
            r.raise_for_status()

        if not r.text.strip():
            return {"vehicles": []}
            
        data = r.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch vehicles: {str(e)}")

    vehicles = []
    max_curk = int(curk) if curk.isdigit() else 0
    items = data if isinstance(data, list) else []
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            lat = float(item.get("lat", 0))
            lng = float(item.get("lng", item.get("lon", 0)))
            if abs(lat) > 1000:
                lat /= 1_000_000
            if abs(lng) > 1000:
                lng /= 1_000_000
        except:
            continue
            
        anim_key = item.get("anim_key")
        if anim_key and str(anim_key).isdigit():
            max_curk = max(max_curk, int(anim_key))

        vehicles.append({
            "id": str(item.get("vehid") or item.get("id") or ""),
            "lat": lat,
            "lng": lng,
            "route": str(item.get("rnum", "")),
            "dir": float(item.get("dir", 0)),
            "speed": float(item.get("speed", 0)),
            "gosNum": str(item.get("gosNum") or item.get("gos_num") or ""),
            "type": str(item.get("rtype") or ""),
            "rid": str(item.get("rid") or ""),
            "anim_key": str(anim_key),
            "animPoints": item.get("animPoints", [])
        })
        
    result = {"vehicles": vehicles, "next_curk": str(max_curk)}
    set_in_cache(cache_key, result, CACHE_TTL_VEHICLES)
    return result

@app.get("/api/route_nodes", dependencies=[Depends(verify_signature)])
def get_route_nodes(id: str = ""):
    if not id:
        return {"nodes": []}
        
    cache_key = f"route_nodes_{id}"
    cached = get_from_cache(cache_key, CACHE_TTL_STATIC)
    if cached:
        return cached
    
    url = f"{BUS62_URL}/getRouteNodes.php"
    params = {"id": id, "city": BUS62_CITY}
    try:
        r = session.get(url, params=params, headers=get_headers(), timeout=10)
        r.raise_for_status()
        if not r.text.strip():
            return {"nodes": []}
        data = r.json()
        nodes = []
        for point in data:
            lat = float(point.get("lat", 0))
            lon = float(point.get("lon", point.get("lng", 0)))
            if abs(lat) > 1000: lat /= 1_000_000
            if abs(lon) > 1000: lon /= 1_000_000
            if lat and lon:
                nodes.append([lon, lat])
        result = {"nodes": nodes}
        set_in_cache(cache_key, result, CACHE_TTL_STATIC)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/route_stations", dependencies=[Depends(verify_signature)])
def get_route_stations(id: str = ""):
    if not id:
        return {"stations": []}
        
    cache_key = f"route_stations_{id}"
    cached = get_from_cache(cache_key, CACHE_TTL_STATIC)
    if cached:
        return cached
    
    url = f"{BUS62_URL}/getRouteStations.php"
    params = {"id": id, "city": BUS62_CITY}
    try:
        r = session.get(url, params=params, headers=get_headers(), timeout=10)
        r.raise_for_status()
        if not r.text.strip():
            return {"stations": []}
        data = r.json()
        
        # data is like [{"station_id": 92, ...}, ...]
        station_ids = []
        if isinstance(data, list):
            for item in data:
                sid = item.get("station_id")
                if sid is not None:
                    station_ids.append(str(sid))
                    
        result = {"stations": station_ids}
        set_in_cache(cache_key, result, CACHE_TTL_STATIC)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/vehicle_forecasts", dependencies=[Depends(verify_signature)])
def get_vehicle_forecasts(vehid: str = ""):
    if not vehid:
        return {"forecasts": []}
        
    cache_key = f"vehicle_forecasts_{vehid}"
    cached = get_from_cache(cache_key, CACHE_TTL_FORECASTS)
    if cached:
        return cached
    
    url = f"{BUS62_URL}/getVehicleForecasts.php"
    params = {"vehid": vehid, "city": BUS62_CITY}
    try:
        r = session.get(url, params=params, headers=get_headers(), timeout=10)
        r.raise_for_status()
        if not r.text.strip():
            return {"forecasts": []}
        data = r.json()
        
        forecasts = []
        if isinstance(data, list):
            for item in data:
                raw_time = item.get("arrt") or item.get("time") or ""
                try:
                    time_val = int(int(raw_time) / 60) if raw_time else 0
                except:
                    time_val = raw_time
                stid = str(item.get("stid") or "")
                forecasts.append({"stid": stid, "time": time_val})
        result = {"forecasts": forecasts}
        set_in_cache(cache_key, result, CACHE_TTL_FORECASTS)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/station_forecasts", dependencies=[Depends(verify_signature)])
def get_station_forecasts(sid: str = ""):
    if not sid:
        return {"forecasts": []}
        
    cache_key = f"station_forecasts_{sid}"
    cached = get_from_cache(cache_key, CACHE_TTL_FORECASTS)
    if cached:
        return cached
    
    url = f"{BUS62_URL}/getStationForecasts.php"
    params = {"sid": sid, "city": BUS62_CITY}
    try:
        r = session.get(url, params=params, headers=get_headers(), timeout=10)
        r.raise_for_status()
        if not r.text.strip():
            return {"forecasts": []}
        data = r.json()
        
        forecasts = []
        if isinstance(data, list):
            for item in data:
                raw_time = item.get("arrt") or item.get("time") or ""
                try:
                    time_val = int(int(raw_time) / 60) if raw_time else 0
                except:
                    time_val = raw_time
                rid = str(item.get("rid") or "")
                dest = str(item.get("where") or "")
                forecasts.append({"rid": rid, "time": time_val, "destination": dest})
        result = {"forecasts": forecasts}
        set_in_cache(cache_key, result, CACHE_TTL_FORECASTS)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
