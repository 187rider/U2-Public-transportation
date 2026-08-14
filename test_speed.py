import httpx
import json

def test():
    res = httpx.get("https://bus03.ru/api/vehicles?rids=&curk=0")
    if res.status_code == 200:
        print("Success")
        # Just check the first 10 vehicles
        data = res.json()
        print(f"Total vehicles: {len(data)}")
        for v in data[:10]:
            print(f"speed: {v.get('speed', 'missing')}")

test()
