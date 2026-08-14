import requests
from main import get_headers, BUS62_CITY, VEHICLES_API_URL, BUS62_URL
r = requests.get(VEHICLES_API_URL, params={"city": BUS62_CITY}, headers=get_headers())
vehicles = r.json()
v46 = [v for v in vehicles if v.get("route") == "46А"]
if v46:
    vid = v46[0]["id"]
    r2 = requests.get(f"{BUS62_URL}/getVehicleForecasts.php", params={"city": BUS62_CITY, "vehid": vid}, headers=get_headers())
    print("Forecasts for 46A vehicle", vid, ":", r2.json())
