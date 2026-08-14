# Ulan-Ude Transit Map

This project provides a real-time public transit tracking map for the city of Ulan-Ude. It features an interactive, offline-capable map built with React, MapLibre GL JS, a custom tile server, and a Python FastAPI backend that interfaces with live city data.

## System Architecture

The project consists of three main interconnected services that run concurrently:

1. **FastAPI Backend (`main.py`)**: Responsible for fetching, parsing, caching, and serving real-time vehicle data from the city's transport systems.
2. **Offline Tile Server (`server.js`)**: A lightweight Express.js server that serves self-hosted vector map tiles directly from the `ulan-ude.mbtiles` database.
3. **Frontend PWA (`web/`)**: A responsive React/Vite application utilizing MapLibre GL JS to render the map, visualize moving vehicles, and provide a mobile-first user interface.

---

## 1. Backend Service (`main.py`)

The backend is built with Python and **FastAPI**. It acts as a resilient proxy and parser for the live transit data.

### Key Responsibilities
- **Data Ingestion**: Periodically fetches live vehicle positions via `its03.py` (which scrapes or connects to the local Ulan-Ude transit API).
- **Caching (`fetch_vehicles_cached`)**: Utilizes an asynchronous caching layer to prevent overloading the upstream data source when multiple users open the app simultaneously.
- **API Endpoints**:
  - `GET /api/vehicles`: Returns the current positions, speeds, and statuses of all active buses and trams.
  - `GET /api/routes`: Returns route metadata (stops, paths, and colors).
- **CORS Management**: Configured to allow cross-origin requests from the frontend development server.

---

## 2. Tile Server (`server.js`)

To reduce reliance on external mapping services (like Google Maps or Mapbox APIs) and ensure fast, localized performance, the app serves its own map tiles.

### Key Responsibilities
- **MBTiles Hosting**: Uses `@mapbox/mbtiles` to connect to the local SQLite database (`ulan-ude.mbtiles`).
- **Vector Tile Delivery**: Serves `.pbf` (Protocolbuffer Binary Format) vector tiles to the frontend via the endpoint `GET /tiles/{z}/{x}/{y}.pbf`.
- **Styling**: Provides a `routes.json` or custom MapLibre GL style configuration to dictate how the map streets, land, and water are colored.

---

## 3. Frontend Web Application (`web/`)

The frontend is a modern, responsive Single Page Application (SPA) built with **React** and **Vite**. It is designed as a Progressive Web App (PWA) that feels like a native app on both iOS and Android.

### Core Technologies
- **React**: Manages the application state (active tabs, selected vehicles, search queries).
- **MapLibre GL JS**: The high-performance WebGL rendering engine used to draw the map tiles and hardware-accelerated vehicle markers.
- **Vite**: The build tool and development server, configured via `vite.config.js` to proxy API requests to the backend and tile servers.

### File Structure & Components

#### `App.jsx`
The central nervous system of the frontend. It manages:
- **Map Initialization**: Mounts the MapLibre instance and loads the vector tile source from the local Tile Server.
- **Data Polling**: Uses `setInterval` and `useEffect` hooks to poll `/api/vehicles` every few seconds, updating the vehicle positions on the map.
- **Marker Rendering**: Translates raw vehicle coordinates into HTML/CSS markers overlaying the map.
- **State Management**: Controls the `activeTab` (0 = Map, 1 = Stops, 2 = Routes, 3 = Favorites, 4 = Search).

#### `App.css`
Contains the entire styling system for the application, ensuring it works seamlessly across devices:
- **Mobile-First Design**: Implements the bottom sliding sheet (`.mui-bottom-drawer`) and floating navigation pill (`.mui-bottom-nav`).
- **Desktop Overrides**: Uses `@media (min-width: 768px)` to transform the mobile bottom sheet into a fixed left-side navigation rail and panel for desktop users.
- **Viewport Fixes**: Utilizes `position: fixed` and `inset: 0` on the root container (`.app-root`) to perfectly track the dynamic visible viewport on mobile browsers (like Android Chrome), preventing the UI from being pushed under the system navigation bars.
- **Safe Area Insets**: Implements CSS environment variables (`env(safe-area-inset-bottom)`) to gracefully handle the iPhone home indicator and device notches.

#### PWA Configuration
- **`index.html`**: Contains the essential meta tags (`apple-mobile-web-app-capable`, `theme-color`) to instruct iOS and Android devices how to install and display the app without browser chrome.
- **`manifest.json`**: The Web App Manifest defining the app's name ("Транспорт У-У"), display mode (`standalone`), and app icons.
- **Icons**: Includes the official Ulan-Ude Coat of Arms configured for high-resolution displays (`icon-512.png`) and iOS home screens (`apple-touch-icon.png`).

---

## Development Workflow

To run the full stack locally during development, three terminal processes are required:

1. **Frontend**: Navigate to `web/` and run `npm run dev`.
2. **Backend**: Run `source venv/bin/activate && uvicorn main:app --reload --host 0.0.0.0 --port 8000` from the root directory.
3. **Tile Server**: Run `node server.js` from the root directory.

The Vite development server (`web/vite.config.js`) handles routing by proxying requests starting with `/api` to the Python backend (port 8000) and requests starting with `/tiles` to the Node tile server (port 8080).
