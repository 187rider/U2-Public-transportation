import requests
from main import get_headers, BUS62_CITY, BUS62_URL, BUS62_HEX_KEY
import hashlib
curk = "0"
rids = "1"
secret_bytes = bytes.fromhex(BUS62_HEX_KEY)
query = f"curk={curk}&city={BUS62_CITY}&rids={rids}"
signature = hashlib.sha256(secret_bytes + query.encode()).hexdigest()
headers = {"Content-MD5-Hash": signature, **get_headers()}
url = f"{BUS62_URL}/getVehicleAnimations.php?{query}"
r = requests.get(url, headers=headers)
print("ANIM:", r.text[:300])
