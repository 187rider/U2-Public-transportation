import requests
import os
import binascii
from datetime import datetime, timezone
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

BUS62_URL = "https://bus03.ru"
VEHICLES_API_URL = f"{BUS62_URL}/getVehicleAnimations.php"
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
        "Connection": "keep-alive"
    }

try:
    r = requests.get(VEHICLES_API_URL, params={"city": "Ulan-Ude"}, headers=get_headers(), timeout=10)
    data = r.json()
    print(f"Got {len(data)} vehicles.")
    for v in data[:10]:
        print(f"Vehicle {v.get('id', v.get('vehid'))}: speed={v.get('speed')}, type={type(v.get('speed'))}")
except Exception as e:
    print(f"Error: {e}")
