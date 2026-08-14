import requests
url = "http://127.0.0.1:8000/api/route_stations?id=1"
try:
    print(requests.get(url).json())
except Exception as e:
    print("Error:", e)
