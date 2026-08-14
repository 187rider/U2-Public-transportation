from main import app
for route in app.routes:
    print(route.path)
