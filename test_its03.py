import requests

url = "http://its03.ru/php/apiRequest.php"
payload = {
    "action": "getVehicles",
    "city": "Ulan-Ude"
}
try:
    r = requests.post(url, json=payload, timeout=10)
    print(r.text[:500])
except Exception as e:
    print(f"Error: {e}")
