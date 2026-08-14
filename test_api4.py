import requests
from main import get_headers, BUS62_CITY, BUS62_URL
r = requests.get(f"{BUS62_URL}/getRouteStations.php", params={"city": BUS62_CITY, "id": "1"}, headers=get_headers())
print("ROUTE STATIONS STATUS:", r.status_code)
print("ROUTE STATIONS BODY:", r.text[:200])
