import requests
from main import get_headers, BUS62_CITY, ROUTES_API_URL, BUS62_URL
r = requests.get(ROUTES_API_URL, params={"city": BUS62_CITY}, headers=get_headers())
routes = r.json()
r46 = [r for r in routes if r["name"] == "А-46А(осн)"]
if r46:
    rid = r46[0]["id"]
    r2 = requests.get(f"{BUS62_URL}/getRouteStations.php", params={"city": BUS62_CITY, "route_id": rid}, headers=get_headers())
    print("With route_id:", r2.json())
    r3 = requests.get(f"{BUS62_URL}/getRouteStations.php", params={"city": BUS62_CITY, "id": rid}, headers=get_headers())
    print("With id:", r3.json())
