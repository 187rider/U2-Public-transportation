import { useEffect, useRef, useState, useMemo } from "react";
import { sha256 } from "js-sha256";
import { Map, NavigationControl, GeolocateControl, Popup, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./App.css";

const TILE_URL = "/tiles/{z}/{x}/{y}.pbf";

/**
 * ⚠️ SECURITY NOTE
 * Anything prefixed VITE_ is compiled into the public JS bundle, so this
 * "secret" is visible to anyone who opens DevTools. The timestamp+HMAC-ish
 * signature below is therefore only a *scraper deterrent*, not authentication.
 * Real protection must live server-side (sessions, tokens, rate limiting).
 */
const API_SECRET = import.meta.env.VITE_API_SECRET;

/** Escape HTML special chars to prevent XSS from upstream data. */
function escapeHtml(str) {
  if (typeof str !== "string") return String(str ?? "");
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function apiFetch(url, options = {}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = sha256(timestamp + API_SECRET);
  const headers = {
    ...options.headers,
    "X-App-Timestamp": timestamp,
    "X-App-Signature": signature
  };
  return fetch(url, { ...options, headers });
}

const BUS_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z"/></svg>`;
const TRAM_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 2l2 2h4v2h-4.34l-1.33 2H18c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2h-1v1c0 .55-.45 1-1 1h-1c-.55 0-1-.45-1-1v-1H9v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-1H5c-1.1 0-2-.9-2-2V10c0-1.1.9-2 2-2h5.67l-1.33-2H5V4h4l2-2h1zm6 8H6v4h12v-4zm-10.5 8c.83 0 1.5-.67 1.5-1.5S8.33 15 7.5 15 6 15.67 6 16.5 6.67 18 7.5 18zm9 0c.83 0 1.5-.67 1.5-1.5s-.67-1.5-1.5-1.5-1.5.67-1.5 1.5.67 1.5 1.5 1.5z"/></svg>`;

// Custom MapLibre Control for 3D Toggle
class ThreeDControl {
  constructor(onToggle) {
    this.onToggle = onToggle;
  }
  onAdd(map) {
    this._map = map;
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

    this._btn = document.createElement('button');
    this._btn.className = 'maplibregl-ctrl-icon';
    this._btn.type = 'button';
    this._btn.title = 'Toggle 3D View';
    this._btn.innerHTML = '<span style="font-weight: 900; font-family: sans-serif; font-size: 14px; color: #1e293b;">3D</span>';

    this._btn.onclick = () => {
      if (this.onToggle) this.onToggle();
    };

    this._container.appendChild(this._btn);
    return this._container;
  }
  onRemove() {
    this._container.parentNode.removeChild(this._container);
    this._map = undefined;
  }
}

const style = {
  version: 8,
  sources: {
    openmaptiles: {
      type: "vector",
      tiles: [TILE_URL],
      minzoom: 0,
      maxzoom: 14
    }
  },
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#f2f0e9" }
    },
    {
      id: "landcover",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landcover",
      paint: { "fill-color": "#e2e5d5" }
    },
    {
      id: "landuse",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landuse",
      paint: { "fill-color": "#e8e4d8", "fill-opacity": 0.7 }
    },
    {
      id: "park",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "park",
      paint: { "fill-color": "#cfe8c8", "fill-opacity": 0.8 }
    },
    {
      id: "water",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "water",
      paint: { "fill-color": "#a9d8ef" }
    },
    {
      id: "waterway",
      type: "line",
      source: "openmaptiles",
      "source-layer": "waterway",
      paint: {
        "line-color": "#8bc7e8",
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 14, 3]
      }
    },
    {
      id: "building-3d",
      type: "fill-extrusion",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 14,
      paint: {
        "fill-extrusion-color": "#d8d2c8",
        "fill-extrusion-height": [
          "coalesce",
          ["get", "render_height"],
          ["get", "height"],
          10
        ],
        "fill-extrusion-base": [
          "coalesce",
          ["get", "render_min_height"],
          ["get", "min_height"],
          0
        ],
        "fill-extrusion-opacity": 0.85
      }
    },
    {
      id: "transportation",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      paint: {
        "line-color": [
          "match",
          ["get", "class"],
          "motorway", "#e87878",
          "trunk", "#e89a6b",
          "primary", "#f0b45c",
          "secondary", "#f5c96b",
          "tertiary", "#ffffff",
          "minor", "#ffffff",
          "service", "#dddddd",
          "#ffffff"
        ],
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          5, ["match", ["get", "class"], "motorway", 1.2, "trunk", 1, "primary", 0.8, 0.3],
          10, ["match", ["get", "class"], "motorway", 5, "trunk", 4, "primary", 3.5, "secondary", 3, "tertiary", 2.5, "minor", 2, "service", 1.2, 1],
          14, ["match", ["get", "class"], "motorway", 9, "trunk", 8, "primary", 7, "secondary", 6, "tertiary", 5, "minor", 4, "service", 2, 2]
        ]
      }
    },
    {
      id: "road-labels",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "transportation_name",
      minzoom: 10,
      layout: {
        "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"], ["get", "ref"]],
        "text-size": ["interpolate", ["linear"], ["zoom"], 10, 10, 14, 14],
        "symbol-placement": "line",
        "text-font": ["Open Sans Regular"]
      },
      paint: {
        "text-color": "#555555",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.5
      }
    },
    {
      id: "place-label",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      layout: {
        "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]],
        "text-size": ["interpolate", ["linear"], ["zoom"], 5, 10, 10, 14, 14, 18],
        "text-font": ["Open Sans Bold"]
      },
      paint: {
        "text-color": "#333333",
        "text-halo-color": "#ffffff",
        "text-halo-width": 2
      }
    },
    {
      id: "housenumber",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "housenumber",
      minzoom: 16,
      layout: {
        "text-field": "{housenumber}",
        "text-size": 11,
        "text-font": ["Open Sans Regular"]
      },
      paint: {
        "text-color": "#4a4a4a",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.5
      }
    },
  ]
};

let activeStationPopup = null;

function showStationPopup(mapInstance, coords, props, routes = [], isFavorite = false, onToggleFavorite = null) {
  const isBus = props.type === "bus";
  const typeText = isBus ? "Автобус / Маршрутка" : "Трамвай";
  const icon = isBus ? "directions_bus" : "tram";
  const typeClass = isBus ? "bus" : "tram";

  // Always close any previous popup so only 1 popup is open at any time
  if (activeStationPopup) {
    try {
      activeStationPopup.remove();
    } catch { }
    activeStationPopup = null;
  }
  document.querySelectorAll('.maplibregl-popup').forEach(p => p.remove());

  const popupHtml = `
    <div class="stop-popup">
      <div class="stop-popup-header ${typeClass}">
        <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
          <span class="material-symbols-outlined" style="font-size: 20px; flex-shrink: 0;">${icon}</span>
          <span style="font-weight: 600; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${props.name}</span>
        </div>
        <span id="popup-fav-btn-${props.id}" class="popup-fav-btn ${isFavorite ? 'active' : ''}" role="button" tabindex="0" title="${isFavorite ? 'Удалить из избранного' : 'Добавить в избранное'}">
          <span class="material-symbols-outlined">star</span>
        </span>
      </div>
      ${props.description ? `<div style="font-size: 11px; padding: 4px 14px 0; color: #64748b;">${props.description}</div>` : ''}
      <div class="stop-popup-body">
        <div class="stop-detail-row">
          <span>Тип:</span>
          <span class="badge ${isBus ? 'badge-bus' : 'badge-tram'}">${typeText}</span>
        </div>
      </div>
      <div id="station-forecast-${props.id}" class="station-forecast-container" style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #1e293b;">
        <div style="color: #64748b; text-align: center;">Загрузка расписания...</div>
      </div>
    </div>
  `;

  const popup = new Popup({
    closeButton: false,
    maxWidth: "360px",
    anchor: "bottom",
    offset: [0, -10]
  })
    .setLngLat(coords)
    .setHTML(popupHtml)
    .addTo(mapInstance);

  activeStationPopup = popup;

  let isActive = true;
  popup.on('close', () => {
    isActive = false;
    if (activeStationPopup === popup) {
      activeStationPopup = null;
    }
  });

  const favBtn = document.getElementById(`popup-fav-btn-${props.id}`);
  if (favBtn) {
    favBtn.onclick = (e) => {
      e.stopPropagation();
      if (onToggleFavorite) {
        const nextIsFav = onToggleFavorite(props.id, e);
        if (nextIsFav !== undefined) {
          favBtn.classList.toggle('active', nextIsFav);
          favBtn.title = nextIsFav ? 'Удалить из избранного' : 'Добавить в избранное';
          const starIcon = favBtn.querySelector('.material-symbols-outlined');
          if (starIcon) {
            starIcon.style.fontVariationSettings = `'FILL' ${nextIsFav ? 1 : 0}`;
            starIcon.style.color = nextIsFav ? '#fbbf24' : '#ffffff';
          }
        }
      }
    };
  }

  const loadForecast = () => {
    if (!isActive) return;
    apiFetch(`/api/station_forecasts?sid=${props.id}`)
      .then(r => r.json())
      .then(data => {
        if (!isActive) return;
        const container = document.getElementById(`station-forecast-${props.id}`);
        if (!container) return;
        if (data.forecasts && data.forecasts.length > 0) {
          let html = `
            <div style="display: flex; align-items: center; padding-bottom: 8px; margin-bottom: 4px; border-bottom: 1px solid #cbd5e1; color: #94a3b8; font-size: 12px; font-weight: 600;">
              <div style="width: 55px; flex-shrink: 0; text-align: center;">Маршрут</div>
              <div style="width: 70px; flex-shrink: 0; text-align: center; margin-left: 8px;">Прогноз</div>
              <div style="flex-grow: 1; padding-left: 12px;">Направление</div>
            </div>
            <ul class="station-forecast-list">
          `;
          data.forecasts.forEach(f => {
            const r = routes.find(rt => {
              if (rt.id && String(rt.id).split(',').includes(String(f.rid))) return true;
              if (rt.subroutes && Array.isArray(rt.subroutes)) {
                return rt.subroutes.some(sub => String(sub.id) === String(f.rid));
              }
              return false;
            });

            let rnum = r ? (r.number || r.rnum || r.routeNumber || r.route || f.rid) : f.rid;

            if (typeof rnum === 'string') {
              rnum = rnum.replace(/\\(.*?\\)/g, '').replace('Тм-', '').replace('Т-', '');
            }

            let bgColor = "#fbbf24";
            if (r) {
              if (r.type === "bus") bgColor = "#ff5a50";
              else if (r.type === "tram") bgColor = "#10b981";
              else if (r.type === "minibus") bgColor = "#fbbf24";
            }

            let dest = f.destination || "";
            if (dest.includes("Авиазаво") && !dest.includes("Авиазавод")) {
              dest = dest.replace("Авиазаво", "Авиазавод");
            }

            html += `<li style="display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
              <div style="width: 55px; flex-shrink: 0; display: flex; justify-content: center;">
                <div style="background-color: ${bgColor}; color: white; border-radius: 6px; width: 45px; height: 28px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: bold;">${escapeHtml(rnum)}</div>
              </div>
              <div style="margin-left: 8px; flex-shrink: 0; width: 70px; display: flex; justify-content: center;">
                <div style="background-color: #f1f5f9; border-radius: 6px; display: flex; align-items: center; justify-content: center; height: 28px; width: 62px; font-size: 13px; font-weight: 600; color: #0f172a;">${escapeHtml(f.time)} мин.</div>
              </div>
              <div class="dest-wrapper" style="margin-left: 12px; flex-grow: 1; overflow: hidden; white-space: nowrap; position: relative; text-overflow: ellipsis;">
                <div class="dest-text" style="display: inline-block; font-size: 14px; color: #0f172a;">${escapeHtml(dest)}</div>
              </div>
            </li>`;
          });
          html += '</ul>';
          container.innerHTML = html;

          // Apply scroll animation to overflowing text
          setTimeout(() => {
            container.querySelectorAll('.dest-wrapper').forEach(wrapper => {
              const textEl = wrapper.querySelector('.dest-text');
              if (textEl && textEl.scrollWidth > wrapper.clientWidth) {
                const dist = textEl.scrollWidth - wrapper.clientWidth;
                // Add a little padding to the distance so it scrolls completely out of view of the edge
                textEl.style.setProperty('--scroll-dist', `-${dist + 10}px`);
                // Base speed on distance (e.g. 30px per second) plus a minimum 2s delay
                const duration = Math.max((dist / 20) + 2, 4);
                textEl.style.animation = `scroll-text-dist ${duration}s linear infinite alternate`;
              }
            });
          }, 10);
        } else {
          container.innerHTML = '<div style="color: #64748b; text-align: center; padding: 12px 0;">Нет ожидаемых маршрутов</div>';
        }

        setTimeout(loadForecast, 10000); // Poll every 10s
      })
      .catch(() => {
        if (!isActive) return;
        const container = document.getElementById(`station-forecast-${props.id}`);
        if (container) container.innerHTML = '<div style="color: #ef4444; text-align: center; padding: 12px 0;">Ошибка загрузки</div>';

        setTimeout(loadForecast, 10000); // Retry every 10s
      });
  };

  loadForecast();
}

const BUS_SVG_DATA = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48Y2lyY2xlIGN4PSIzMiIgY3k9IjMyIiByPSIyOCIgZmlsbD0iIzI1NjNlYiIgc3Ryb2tlPSIjZmZmZmZmIiBzdHJva2Utd2lkdGg9IjQiLz48cGF0aCBkPSJNMjAgNDBjMCAxLjUgMSAyLjUgMi41IDIuNVYzYzAgMSAuOCAxLjUgMS41IDEuNWgyYy44IDAgMS41LS41 IDEuNS0xLjV2LTNoOXYzYzAgMSAuNyAxLjUgMS41IDEuNWgyYy43IDAgMS41LS41 IDEuNS0xLjV2LTNjMS41IDAgMi41LTEgMi41LTIuNVYyMmMwLTUuNS01LjUtNi0xMy02cy0xMyAuNS0xMyA2djE4em01LjUgMS41Yy0xLjMgMC0yLjMtMS0yLjMtMi4zczEtMi4zIDIuMy0yLjMgMi4z IDEgMi4zIDIuMy0xIDIuMy0yLjMgMi4zem0xNSAwYy0xLjMgMC0yLjMtMS0yLjMtMi4zczEtMi4zIDIuMy0yLjMgMi4z IDEgMi4zIDIuMy0xIDIuMy0yLjMgMi4zeE00MiAzMUgyMlYyMmgyMHY5eiIgZmlsbD0iI2ZmZmZmZiIvPjwvc3ZnPg==";
const TRAM_SVG_DATA = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48Y2lyY2xlIGN4PSIzMiIgY3k9IjMyIiByPSIyOCIgZmlsbD0iI2UxMWQ0OCIgc3Ryb2tlPSIjZmZmZmZmIiBzdHJva2Utd2lkdGg9IjQiLz48cGF0aCBkPSJNMzIgMTRsMy41IDMuNWg3djMuNWgtNy41bC0yLjMgMy41SDQzYzIgMCAzLjUgMS41IDMuNSAzLjV2MTRjMCAyLTEuNSAzLjUtMy41IDMuNWgtMS44djEuOGMwIDEtLjggMS44LTEuOCAxLjhoLTEuOGMtMSAwLTEuOC0uOC0xLjgtMS44di0xLjhoLTExLjV2MS44YzAgMS0uOCAxLjgtMS44 IDEuOGgtMS44Yy0xIDAtMS44LS44LTEuOC0xLjh2LTEuOGgtMS44Yy0yIDAtMy41LTEuNS0zLjUtMy41di0xNGMwLTIgMS41LTMuNSAzLjUtMy41aDEwbC0yLjMtMy41SDIwLjVWMTcuNWg3TDMyIDE4em0xMC41 IDE4aC0yMXY3aDIxdj03em0tMTYgMTRjMS41IDAgMi42LTEuMiAyLjYtMi42cy0xLjItMi42LTIuNi0yLjYtMi42 IDEuMi0yLjYgMi42 IDEuMiAyLjYgMi42IDIuNnptMTUuOCAwYzEuNSAwIDIuNi0xLjIgMi42LTIuNnMtMS4yLTIuNi0yLjYtMi42LTIuNiAxLjItMi42IDIuNiAxLjIgMi42IDIuNiAyLjZ6IiBmaWxsPSIjZmZmZmZmIi8+PC9zdmc+";

function registerMapImages(mapInstance, callback) {
  const images = [
    { id: "bus-icon", data: BUS_SVG_DATA },
    { id: "tram-icon", data: TRAM_SVG_DATA }
  ];

  let loaded = 0;
  images.forEach(({ id, data }) => {
    if (mapInstance.hasImage(id)) {
      loaded++;
      if (loaded === images.length && callback) callback();
      return;
    }

    const img = new Image();
    img.width = 64;
    img.height = 64;

    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, 64, 64);
      const imageData = ctx.getImageData(0, 0, 64, 64);

      if (!mapInstance.hasImage(id)) {
        mapInstance.addImage(id, imageData);
      }
      loaded++;
      if (loaded === images.length && callback) callback();
    };
    img.onerror = (err) => {
      console.error("Failed to load map icon:", id, err);
      loaded++;
      if (loaded === images.length && callback) callback();
    };
    img.src = data;
  });
}

export default function App() {
  const mapContainer = useRef(null);
  const map = useRef(null);

  const [stations, setStations] = useState([]);
  const [routes, setRoutes] = useState([]);
  const routesRef = useRef([]);
  useEffect(() => {
    routesRef.current = routes;
  }, [routes]);

  // Drawer Touch Gestures
  const drawerRef = useRef(null);
  const touchStartY = useRef(0);

  const handleDrawerTouchStart = (e) => {
    touchStartY.current = e.touches[0].clientY;
    if (drawerRef.current) {
      drawerRef.current.style.transition = 'none';
    }
  };

  const handleDrawerTouchMove = (e) => {
    const currentY = e.touches[0].clientY;
    const diff = currentY - touchStartY.current;
    if (diff > 0 && drawerRef.current) {
      drawerRef.current.style.transform = `translateY(${diff}px)`;
    }
  };

  const handleDrawerTouchEnd = (e) => {
    const currentY = e.changedTouches[0].clientY;
    const diff = currentY - touchStartY.current;
    if (drawerRef.current) {
      drawerRef.current.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
      if (diff > 80) {
        setActiveTab(0);
        setTimeout(() => {
          if (drawerRef.current) {
            drawerRef.current.style.transform = '';
            drawerRef.current.style.transition = '';
          }
        }, 300);
      } else {
        drawerRef.current.style.transform = 'translateY(0)';
        setTimeout(() => {
          if (drawerRef.current) drawerRef.current.style.transition = '';
        }, 300);
      }
    }
  };

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedVehicle, setSelectedVehicle] = useState(null);
  const [selectedRouteStations, setSelectedRouteStations] = useState(null);
  const selectedVehicleRef = useRef(null);
  const knownVehiclesRef = useRef({});

  useEffect(() => {
    selectedVehicleRef.current = selectedVehicle;
    // Update existing markers to show/hide the glowing effect
    Object.keys(vehicleMarkersRef.current).forEach(id => {
      const marker = vehicleMarkersRef.current[id];
      const markerDiv = marker.getElement().querySelector(".vehicle-marker");
      if (markerDiv) {
        if (selectedVehicle && selectedVehicle.id === id) {
          markerDiv.classList.add("vehicle-selected");
        } else {
          markerDiv.classList.remove("vehicle-selected");
        }
      }
    });
  }, [selectedVehicle]);
  const forecastMarkersRef = useRef([]);

  // Active Bottom Navigation Tab (0: Map, 1: Stops, 2: Routes, 3: Favorites)
  const [activeTab, setActiveTab] = useState(0);

  // Favorites
  const [favorites, setFavorites] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("fav_stations") || "[]"));
    } catch {
      return new Set();
    }
  });
  const favoritesRef = useRef(favorites);
  useEffect(() => {
    favoritesRef.current = favorites;
  }, [favorites]);

  // Filter toggles
  const [showBus, setShowBus] = useState(() => {
    return localStorage.getItem("pref_showBus") !== "false";
  });
  const [showTram, setShowTram] = useState(() => {
    return localStorage.getItem("pref_showTram") !== "false";
  });
  const [pitch3D, setPitch3D] = useState(() => {
    try {
      const savedState = JSON.parse(localStorage.getItem('map_view_state'));
      return savedState ? savedState.pitch > 10 : false;
    } catch {
      return false;
    }
  });
  const filtersRef = useRef({ bus: true, tram: true });
  useEffect(() => {
    filtersRef.current = { bus: showBus, tram: showTram };
    localStorage.setItem("pref_showBus", showBus);
    localStorage.setItem("pref_showTram", showTram);
  }, [showBus, showTram]);

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  // Grouped Routes UI State
  const [expandedGroups, setExpandedGroups] = useState({ bus: true, tram: true, minibus: true });
  const [selectedRoutes, setSelectedRoutes] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("pref_selectedRoutes") || "[]"));
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    localStorage.setItem("pref_selectedRoutes", JSON.stringify(Array.from(selectedRoutes)));
  }, [selectedRoutes]);

  const toggleRouteGroup = (type) => {
    setExpandedGroups(prev => ({ ...prev, [type]: !prev[type] }));
  };

  const toggleRouteSelection = (routeId) => {
    setSelectedRoutes(prev => {
      const next = new Set(prev);
      if (next.has(routeId)) next.delete(routeId);
      else next.add(routeId);
      return next;
    });
  };

  const toggleAllRoutesInGroup = (groupRoutes) => {
    setSelectedRoutes(prev => {
      const next = new Set(prev);
      const allSelected = groupRoutes.every(r => next.has(r.id));
      if (allSelected) {
        groupRoutes.forEach(r => next.delete(r.id));
      } else {
        groupRoutes.forEach(r => next.add(r.id));
      }
      return next;
    });
  };

  const groupedRoutes = useMemo(() => {
    const groups = routes.reduce((acc, r) => {
      if (r.type === "bus") acc.bus.push(r);
      else if (r.type === "tram") acc.tram.push(r);
      else if (r.type === "minibus") acc.minibus.push(r);
      return acc;
    }, { bus: [], tram: [], minibus: [] });

    // Sort strictly by numeric value first, then string suffix (e.g. 95, 95K, 100)
    const sortFn = (a, b) => {
      const numA = parseInt(a.number) || 0;
      const numB = parseInt(b.number) || 0;
      if (numA !== numB) return numA - numB;
      return String(a.number || "").localeCompare(String(b.number || ""));
    };

    groups.bus.sort(sortFn);
    groups.tram.sort(sortFn);
    groups.minibus.sort(sortFn);

    return groups;
  }, [routes]);

  // Fetch stations & routes
  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      let stRes, rtRes;
      try {
        stRes = await apiFetch("/api/stations");
        rtRes = await apiFetch("/api/routes");
        if (!stRes.ok) throw new Error(`HTTP ${stRes.status}`);
      } catch (e) {
        throw e; // Let the outer catch handle it
      }
      const stData = await stRes.json();
      const rtData = await rtRes.json();

      const features = (stData.features || []).map(f => {
        f._searchName = (f.properties.name || "").toLowerCase().trim();
        return f;
      });
      setStations(features);
      setRoutes(rtData.routes || []);
      setLoading(false);
    } catch (err) {
      console.error("Failed to load transit data:", err);
      setError("Не удалось загрузить данные. Проверьте, запущен ли FastAPI backend (main.py).");
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const stationsRef = useRef(stations);
  stationsRef.current = stations;
  const selectedRouteStationsRef = useRef(selectedRouteStations);
  selectedRouteStationsRef.current = selectedRouteStations;

  const updateSourceData = () => {
    if (!map.current) return;
    const srcAll = map.current.getSource("stations-source");
    const srcRoute = map.current.getSource("route-stations-source");
    if (!srcAll || !srcRoute) return;

    if (selectedVehicleRef.current && selectedRouteStationsRef.current) {
      if (map.current.getLayer("stations-clusters-hidden")) map.current.setLayoutProperty("stations-clusters-hidden", "visibility", "none");
      if (map.current.getLayer("stations-unclustered-hidden")) map.current.setLayoutProperty("stations-unclustered-hidden", "visibility", "none");
      if (map.current.getLayer("route-stations-hidden")) map.current.setLayoutProperty("route-stations-hidden", "visibility", "visible");

      const filtered = (stationsRef.current || []).filter(s => selectedRouteStationsRef.current.has(s.properties.id));
      srcRoute.setData({
        type: "FeatureCollection",
        features: filtered
      });
      // Force an update to clear old markers since visibility change doesn't fire data event for stations-source
      if (window.debouncedUpdateFn) window.debouncedUpdateFn();
    } else {
      if (map.current.getLayer("stations-clusters-hidden")) map.current.setLayoutProperty("stations-clusters-hidden", "visibility", "visible");
      if (map.current.getLayer("stations-unclustered-hidden")) map.current.setLayoutProperty("stations-unclustered-hidden", "visibility", "visible");
      if (map.current.getLayer("route-stations-hidden")) map.current.setLayoutProperty("route-stations-hidden", "visibility", "none");

      const filtered = (stationsRef.current || []).filter((st) => {
        const p = st.properties;
        if (p.type === "bus" && !filtersRef.current.bus) return false;
        if (p.type === "tram" && !filtersRef.current.tram) return false;
        return true;
      });

      srcAll.setData({
        type: "FeatureCollection",
        features: filtered
      });
      if (window.debouncedUpdateFn) window.debouncedUpdateFn();
    }
  };

  const markersRef = useRef({});
  const vehicleMarkersRef = useRef({});
  const activeAnimationsRef = useRef({});
  const globalAnimationId = useRef(null);

  const startGlobalAnimation = () => {
    if (globalAnimationId.current) return;

    let lastTime = performance.now();

    const animate = (timestamp) => {
      if (!map.current) {
        globalAnimationId.current = null;
        return;
      }

      const dt = timestamp - lastTime;
      lastTime = timestamp;

      let hasActive = false;
      const anims = activeAnimationsRef.current;
      const z = map.current.getZoom();
      
      if (z < 12) {
        // Snap everything
        for (const id in anims) {
          const anim = anims[id];
          if (anim.animationPoints && anim.animationPoints.length > 0) {
            const lastPt = anim.animationPoints[anim.animationPoints.length - 1];
            anim.marker.setLngLat([lastPt.lng, lastPt.lat]);
            anim.marker._currentRot = lastPt.dir;
          }
          delete anims[id];
        }
        globalAnimationId.current = null;
        return;
      }

      // Viewport culling with 20% padding matching Leaflet pad(.2)
      const bounds = map.current.getBounds();
      const padLat = (bounds.getNorth() - bounds.getSouth()) * 0.2;
      const padLng = (bounds.getEast() - bounds.getWest()) * 0.2;
      const west = bounds.getWest() - padLng;
      const east = bounds.getEast() + padLng;
      const south = bounds.getSouth() - padLat;
      const north = bounds.getNorth() + padLat;

      const shortestAngleDiff = (targetAngle, currentAngle) => {
          let t = targetAngle - currentAngle;
          if (t > 180) t -= 360;
          if (t < -180) t += 360;
          return t;
      };

      for (const id in anims) {
        const t = anims[id];
        hasActive = true;

        if (t.currentFrame > 0) {
            t.currentFrame -= 1;
            t.currentLat += t.deltaLat;
            t.currentLng += t.deltaLng;
            
            if (t.currentDirectionFrame > 0) {
                t.currentDirectionFrame -= 1;
                t.currentDirection += t.deltaDirection;
            }
        } else if (t.animationPoints && t.animationPoints.length > 0) {
            const a = t.animationPoints.shift();
            
            // 900 frames at 60 FPS = exactly 15 seconds (matching the polling window)
            const r = Math.trunc(900 * a.percent / 100) || 1;
            const o = Math.trunc(900 * a.percent / 1e3) || 1;
            
            t.deltaLat = (a.lat - t.currentLat) / r;
            t.deltaLng = (a.lng - t.currentLng) / r;
            t.deltaDirection = shortestAngleDiff(a.dir, t.currentDirection) / o;
            
            t.currentFrame = r;
            t.currentDirectionFrame = o;
        } else if (t.fallbackTarget) {
            // Disabled per user request (t.fallbackTarget = null in the fetch logic)
            t.currentFrame = 0;
            t.currentDirectionFrame = 0;
            t.fallbackTarget = null;
        }

        // Viewport culling
        if (t.currentLng >= west && t.currentLng <= east && t.currentLat >= south && t.currentLat <= north) {
          t.marker.setLngLat([t.currentLng, t.currentLat]);
          if (t.mDiv) {
              t.mDiv.style.transform = `rotate(${t.currentDirection}deg)`;
          }
          if (t.tSpan) {
              // Perfectly cancel out the parent's rotation to keep text strictly upright
              t.tSpan.style.transform = `rotate(${-t.currentDirection}deg)`;
          }
          t.marker._currentRot = t.currentDirection;
        }
      }

      if (hasActive) {
        globalAnimationId.current = requestAnimationFrame(animate);
      } else {
        globalAnimationId.current = null;
      }
    };

    globalAnimationId.current = requestAnimationFrame(animate);
  };

  // Render HTML Pill Markers and Clusters for visible viewport stops based on zoom logic
  const updateViewportMarkers = () => {
    if (!map.current) return;
    const z = map.current.getZoom();

    // queryRenderedFeatures requires layers to be loaded
    if (!map.current.getLayer("stations-clusters-hidden") || !map.current.getLayer("stations-unclustered-hidden")) {
      return;
    }

    const clusteredLayers = [];
    if (map.current.getLayer("stations-clusters-hidden") && map.current.getLayoutProperty("stations-clusters-hidden", "visibility") !== "none") {
      clusteredLayers.push("stations-clusters-hidden");
    }
    const clusteredFeatures = clusteredLayers.length > 0 ? map.current.queryRenderedFeatures({ layers: clusteredLayers }) : [];

    const unclusteredLayers = [];
    if (map.current.getLayer("stations-unclustered-hidden") && map.current.getLayoutProperty("stations-unclustered-hidden", "visibility") !== "none") {
      unclusteredLayers.push("stations-unclustered-hidden");
    }
    if (map.current.getLayer("route-stations-hidden") && map.current.getLayoutProperty("route-stations-hidden", "visibility") !== "none") {
      unclusteredLayers.push("route-stations-hidden");
    }

    const unclusteredFeatures = unclusteredLayers.length > 0 ? map.current.queryRenderedFeatures({ layers: unclusteredLayers }) : [];

    const activeIds = new Set();

    clusteredFeatures.forEach((feat) => {
      const clusterId = "cluster_" + feat.properties.cluster_id;
      activeIds.add(clusterId);
      const coords = feat.geometry.coordinates;
      const pointCount = feat.properties.point_count;

      if (markersRef.current[clusterId]) {
        const marker = markersRef.current[clusterId];
        marker.setLngLat(coords);
        const inner = marker.getElement().firstChild;
        if (inner.textContent !== String(pointCount)) {
          inner.textContent = pointCount;
        }
      } else {
        const wrapper = document.createElement("div");
        const inner = document.createElement("div");
        inner.className = "cluster-marker";
        inner.textContent = pointCount;

        inner.onclick = (e) => {
          e.stopPropagation();
          map.current.easeTo({
            center: coords,
            zoom: map.current.getZoom() + 2
          });
        };

        wrapper.appendChild(inner);
        const marker = new Marker({ element: wrapper, anchor: "center" })
          .setLngLat(coords)
          .addTo(map.current);

        markersRef.current[clusterId] = marker;
      }
    });

    unclusteredFeatures.forEach((feat) => {
      const props = feat.properties;
      const pointId = "point_" + props.id;
      activeIds.add(pointId);
      const coords = feat.geometry.coordinates;

      if (markersRef.current[pointId]) {
        const marker = markersRef.current[pointId];
        marker.setLngLat(coords);
        const inner = marker.getElement().firstChild;
        const isSmall = z < 18;
        const hasSmallClass = inner.classList.contains("small-mode");

        if (isSmall && !hasSmallClass) inner.classList.add("small-mode");
        else if (!isSmall && hasSmallClass) inner.classList.remove("small-mode");
      } else {
        const wrapper = document.createElement("div");
        const inner = document.createElement("div");
        const typeClass = props.type === "bus" ? "bus" : "tram";
        inner.className = `stop-pill-marker ${typeClass}`;

        if (z < 18) {
          inner.classList.add("small-mode");
        }

        const iconDiv = document.createElement("div");
        iconDiv.className = `stop-pill-icon ${typeClass}`;
        iconDiv.innerHTML = props.type === "bus" ? BUS_SVG : TRAM_SVG;

        const titleSpan = document.createElement("span");
        titleSpan.className = "stop-pill-title";
        titleSpan.textContent = props.name || "Остановка";

        inner.appendChild(iconDiv);
        inner.appendChild(titleSpan);

        inner.onclick = (e) => {
          e.stopPropagation();
          if (map.current) {
            map.current.easeTo({
              center: coords,
              padding: { top: 220, bottom: 90, left: 20, right: 20 },
              duration: 500
            });
          }
          showStationPopup(map.current, coords, props, routesRef.current, favoritesRef.current.has(props.id), toggleFavorite);
        };

        wrapper.appendChild(inner);
        const marker = new Marker({ element: wrapper, anchor: "center" })
          .setLngLat(coords)
          .addTo(map.current);

        markersRef.current[pointId] = marker;
      }
    });

    // Cleanup markers that are no longer visible
    Object.keys(markersRef.current).forEach(id => {
      if (!activeIds.has(id)) {
        markersRef.current[id].remove();
        delete markersRef.current[id];
      }
    });
  };

  // Initialize MapLibre
  useEffect(() => {
    if (map.current) return;

    let initialCenter = [107.605, 51.808];
    let initialZoom = 13;
    let initialPitch = 0;
    let initialBearing = 0;

    try {
      const savedState = JSON.parse(localStorage.getItem('map_view_state'));
      if (savedState) {
        initialCenter = [savedState.lng, savedState.lat];
        initialZoom = Math.max(savedState.zoom, 10);
        initialPitch = savedState.pitch;
        initialBearing = savedState.bearing;
      }
    } catch (e) {
      // ignore
    }

    map.current = new Map({
      container: mapContainer.current,
      style,
      center: initialCenter,
      zoom: initialZoom,
      pitch: initialPitch,
      bearing: initialBearing,
      minZoom: 10,
      maxZoom: 18,
      attributionControl: false
    });

    map.current.on('moveend', () => {
      const center = map.current.getCenter();
      localStorage.setItem('map_view_state', JSON.stringify({
        lng: center.lng,
        lat: center.lat,
        zoom: map.current.getZoom(),
        pitch: map.current.getPitch(),
        bearing: map.current.getBearing()
      }));
    });

    map.current.addControl(new NavigationControl(), "top-right");
    map.current.addControl(new GeolocateControl({ trackUserLocation: true }), "top-right");

    // Add custom 3D Control
    map.current.addControl(new ThreeDControl(() => {
      const is3D = map.current.getPitch() > 10;
      const next3D = !is3D;
      setPitch3D(next3D);
      map.current.easeTo({ pitch: next3D ? 60 : 0, bearing: next3D ? -20 : 0, duration: 1000 });
    }), "top-right");

    map.current.on("load", () => {
      if (!map.current) return;
      map.current.resize();
      setTimeout(() => {
        if (map.current) map.current.resize();
      }, 150);

      // Add WebGL GeoJSON source for stops
      if (!map.current.getSource("stations-source")) {
        map.current.addSource("stations-source", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
          cluster: true,
          clusterMaxZoom: 14,
          clusterRadius: 50
        });
      }

      // Add source and layer for route nodes
      if (!map.current.getSource("route-nodes")) {
        map.current.addSource("route-nodes", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] }
        });
        map.current.addLayer({
          id: "route-nodes-layer",
          type: "line",
          source: "route-nodes",
          layout: {
            "line-join": "round",
            "line-cap": "round",
            "visibility": "none"
          },
          paint: {
            "line-color": "#3b82f6",
            "line-width": 4,
            "line-opacity": 0.8
          }
        });
      }

      // Invisible layer to query clusters
      if (!map.current.getLayer("stations-clusters-hidden")) {
        map.current.addLayer({
          id: "stations-clusters-hidden",
          type: "circle",
          source: "stations-source",
          filter: ["has", "point_count"],
          paint: {
            "circle-radius": 20,
            "circle-opacity": 0
          }
        });
      }

      // Invisible layer to query unclustered points
      if (!map.current.getLayer("stations-unclustered-hidden")) {
        map.current.addLayer({
          id: "stations-unclustered-hidden",
          type: "circle",
          source: "stations-source",
          filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-radius": 10,
            "circle-opacity": 0
          }
        });
      }

      // Add unclustered source for route stations to prevent Worker memory leak
      if (!map.current.getSource("route-stations-source")) {
        map.current.addSource("route-stations-source", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
          cluster: false
        });
        map.current.addLayer({
          id: "route-stations-hidden",
          type: "circle",
          source: "route-stations-source",
          paint: {
            "circle-radius": 10,
            "circle-opacity": 0
          }
        });
      }

      // Map-wide click handler for deselection
      map.current.on("click", (e) => {
        // Prevent map click if we clicked on a marker
        if (e.originalEvent.target.closest('.vehicle-marker') ||
          e.originalEvent.target.closest('.cluster-marker') ||
          e.originalEvent.target.closest('.forecast-marker') ||
          e.originalEvent.target.closest('.stop-pill-marker')) {
          return;
        }

        // Deselect vehicle
        setSelectedVehicle(null);
        // Close the side menu
        setActiveTab(0);

        // Close all MapLibre popups
        if (activeStationPopup) {
          try {
            activeStationPopup.remove();
          } catch { }
          activeStationPopup = null;
        }
        document.querySelectorAll('.maplibregl-popup').forEach(p => p.remove());
      });

      updateSourceData();

      let debounceTimer = null;
      const debouncedUpdate = () => {
        if (debounceTimer) cancelAnimationFrame(debounceTimer);
        debounceTimer = requestAnimationFrame(() => {
          updateViewportMarkers();
        });
      };
      window.debouncedUpdateFn = debouncedUpdate; // expose for updateSourceData

      debouncedUpdate();

      // Register map movement handlers to update HTML pill markers
      map.current.on("move", debouncedUpdate);
      map.current.on("moveend", debouncedUpdate);
      map.current.on("zoomend", debouncedUpdate);

      // Crucial: Update HTML markers immediately whenever the geojson data finishes rendering!
      map.current.on("data", (e) => {
        if ((e.sourceId === "stations-source" || e.sourceId === "route-stations-source") && e.isSourceLoaded) {
          debouncedUpdate();
        }
      });
    });

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Update map padding based on activeTab (for desktop side panel and mobile drawer/pill)
  useEffect(() => {
    if (!map.current) return;

    // Check if we are on desktop (width >= 768px)
    const isDesktop = window.innerWidth >= 768;

    if (isDesktop) {
      if (activeTab !== 0) {
        // Nav rail (72) + Panel (380) = 452px offset
        map.current.easeTo({ padding: { left: 452, top: 0, bottom: 0, right: 0 }, duration: 300 });
      } else {
        // Only Nav rail (72)
        map.current.easeTo({ padding: { left: 72, top: 0, bottom: 0, right: 0 }, duration: 300 });
      }
    } else {
      if (activeTab !== 0) {
        // Drawer takes up bottom space
        map.current.easeTo({ padding: { left: 0, bottom: Math.min(window.innerHeight * 0.45, 320), top: 0, right: 0 }, duration: 300 });
      } else {
        // Main map view on mobile: add 110px bottom padding to account for the floating menu pill
        map.current.easeTo({ padding: { left: 0, bottom: 110, top: 0, right: 0 }, duration: 300 });
      }
    }
  }, [activeTab]);

  // Toggle 3D pitch
  const handleToggle3D = () => {
    if (!map.current) return;
    const next3D = !pitch3D;
    setPitch3D(next3D);
    map.current.easeTo({ pitch: next3D ? 60 : 0, bearing: next3D ? -20 : 0, duration: 1000 });
  };

  // Toggle Favorite
  const toggleFavorite = (stId, e) => {
    if (e) e.stopPropagation();
    const isCurrentlyFav = favoritesRef.current.has(stId);
    const nextIsFav = !isCurrentlyFav;

    if (nextIsFav) {
      favoritesRef.current.add(stId);
    } else {
      favoritesRef.current.delete(stId);
    }

    setFavorites(new Set(favoritesRef.current));
    localStorage.setItem("fav_stations", JSON.stringify(Array.from(favoritesRef.current)));

    return nextIsFav;
  };

  // Update GeoJSON Source & Viewport Pill Markers on Data or Filter Changes
  useEffect(() => {
    if (!map.current) return;

    const timer = setTimeout(() => {
      updateSourceData();
    }, 50);

    return () => clearTimeout(timer);
  }, [stations, showBus, showTram, selectedRouteStations]);

  // Live Vehicle Polling
  useEffect(() => {
    let isActive = true;
    let curk = "0";
    let lastFetchTime = Date.now();

    const fetchVehicles = async () => {
      if (!isActive) return;

      // Pause fetching if tab is in the background or phone is locked
      if (document.hidden) {
        setTimeout(fetchVehicles, 5000);
        return;
      }

      // If we just woke up from being locked for >30 seconds, force a full refresh
      const now = Date.now();
      if (now - lastFetchTime > 30000) {
        curk = "0";
      }
      lastFetchTime = now;

      if (selectedRoutes.size === 0) {
        Object.values(vehicleMarkersRef.current).forEach(m => m.remove());
        vehicleMarkersRef.current = {};
        activeAnimationsRef.current = {};
        if (globalAnimationId.current) {
          cancelAnimationFrame(globalAnimationId.current);
          globalAnimationId.current = null;
        }
        curk = "0";
        setTimeout(fetchVehicles, 10000);
        return;
      }

      const rids = Array.from(selectedRoutes).join(",");
      try {
        const res = await apiFetch(`/api/vehicles?rids=${rids}&curk=${curk}`);
        const data = await res.json();

        if (data && data.vehicles) {
          if (curk === "0") {
            knownVehiclesRef.current = {};
          }

          const updatesMap = {};
          data.vehicles.forEach(v => {
            knownVehiclesRef.current[v.id] = v;
            updatesMap[v.id] = v;
          });

          let allVeh = Object.values(knownVehiclesRef.current);
          const visibleIds = new Set(allVeh.map(v => v.id));

          // Cleanup markers not in top 150 or stale
          const now = Date.now();
          Object.keys(vehicleMarkersRef.current).forEach(id => {
            const marker = vehicleMarkersRef.current[id];
            if (!visibleIds.has(id) || (now - (marker._lastUpdateTime || now) > 3 * 60 * 1000 && curk !== "0")) {
              marker.remove();
              delete vehicleMarkersRef.current[id];
              delete activeAnimationsRef.current[id];
            }
          });

          if (data.next_curk && data.next_curk !== "0") {
            curk = data.next_curk;
          }

          // Add or update markers
          allVeh.forEach(v => {
            const vType = v.type === "М" ? "minibus" : (v.type === "Т" || v.type === "Тм" || v.route.startsWith("Т-") ? "tram" : "bus");
            const rotation = v.dir || 0;

            if (vehicleMarkersRef.current[v.id]) {
              const marker = vehicleMarkersRef.current[v.id];

              // Only animate if this vehicle was actually updated in this poll
              if (!updatesMap[v.id]) return;

              // Skip if this is the exact same animation event we already processed!
              if (v.anim_key && marker._anim_key === v.anim_key) {
                return;
              }

              marker._anim_key = v.anim_key;
              marker._lastUpdateTime = Date.now();

              const el = marker.getElement();
              const mDiv = el.querySelector(".vehicle-marker");
              const tSpan = el.querySelector(".vehicle-text");

              let anims = activeAnimationsRef.current;
              let t = anims[v.id];

              if (!t) {
                t = {
                  marker,
                  mDiv,
                  tSpan,
                  currentLat: v.lat,
                  currentLng: v.lng,
                  currentDirection: marker._currentRot !== undefined ? marker._currentRot : rotation,
                  animationPoints: [],
                  segment: null
                };
                anims[v.id] = t;
              }

              // Handle Teleportation / Bad GPS fix (if jump is too big, reset)
              // If difference > 0.01 degrees (~1km) it's a big jump
              if (Math.abs(v.lat - t.currentLat) > 0.01 || Math.abs(v.lng - t.currentLng) > 0.01) {
                  t.animationPoints = [];
                  t.currentFrame = 0;
                  t.currentDirectionFrame = 0;
                  t.currentLat = v.lat;
                  t.currentLng = v.lng;
                  t.currentDirection = rotation;
                  t.lastAddedPoint = null;
              }

              if (v.animPoints && v.animPoints.length > 0) {
                  const newKey = parseInt(v.anim_key, 10) || 0;
                  const oldKey = parseInt(t.anim_key, 10) || 0;
                  
                  // Strictly ensure we only accept newer animation sequences to prevent old data from causing rollbacks
                  if (newKey > oldKey) {
                      let matchIdx = -1;
                      
                      // Find the robust overlap point from our last appended trajectory
                      if (t.lastAddedPoint) {
                          let closestIdx = -1;
                          let minDist = Infinity;
                          for (let i = 0; i < v.animPoints.length; i++) {
                              const pt = v.animPoints[i];
                              const dist = Math.pow(pt.lat - t.lastAddedPoint.lat, 2) + Math.pow(pt.lng - t.lastAddedPoint.lng, 2);
                              if (dist < minDist) {
                                  minDist = dist;
                                  closestIdx = i;
                              }
                          }
                          // If the closest point is within ~400 meters (~0.000015 deg^2), treat it as the exact seam
                          if (minDist < 0.000015) {
                              matchIdx = closestIdx;
                          }
                      }
                      
                      if (matchIdx !== -1) {
                          // Seam found! Append smoothly.
                          const newPoints = v.animPoints.slice(matchIdx + 1);
                          if (newPoints.length > 0) {
                              t.animationPoints = t.animationPoints.concat(newPoints);
                              t.lastAddedPoint = newPoints[newPoints.length - 1]; // Store the absolute last point added
                          }
                      } else {
                          // Seam NOT found! The path diverged, jumped, or ran out.
                          // Fallback: compare with the CURRENT visual position to prevent rollback
                          let closestToCurrent = -1;
                          let minCurrentDist = Infinity;
                          for (let i = 0; i < v.animPoints.length; i++) {
                              const pt = v.animPoints[i];
                              const dist = Math.pow(pt.lat - t.currentLat, 2) + Math.pow(pt.lng - t.currentLng, 2);
                              if (dist < minCurrentDist) {
                                  minCurrentDist = dist;
                                  closestToCurrent = i;
                              }
                          }
                          
                          // Wipe the stale queue and stitch from exactly where the bus physically is!
                          t.animationPoints = v.animPoints.slice(closestToCurrent + 1);
                          if (t.animationPoints.length > 0) {
                              t.lastAddedPoint = t.animationPoints[t.animationPoints.length - 1];
                          } else {
                              t.lastAddedPoint = null;
                          }
                          // Force immediate pivot
                          t.currentFrame = 0;
                          t.currentDirectionFrame = 0;
                      }

                      t.anim_key = v.anim_key;
                      t.fallbackTarget = null;
                      startGlobalAnimation();
                  }
              } else {
                  // User specifically requested: "don't move vehicle only when new one data comes"
                  // We disable dead reckoning (fallbackTarget) because projecting from stale v.lat causes huge backward glides when the queue empties.
                  t.fallbackTarget = null;
              }

              if (mDiv) {
                const isSelected = selectedVehicleRef.current && selectedVehicleRef.current.id === v.id;
                if (isSelected) mDiv.classList.add("vehicle-selected");
                else mDiv.classList.remove("vehicle-selected");
              }
            } else {
              const wrapper = document.createElement("div");
              wrapper.style.width = "32px";
              wrapper.style.height = "32px";
              wrapper.style.cursor = "pointer";
              wrapper.style.setProperty("z-index", "2000", "important");
              wrapper.style.willChange = "transform";

              const markerDiv = document.createElement("div");
              markerDiv.className = `vehicle-marker vehicle-${vType}`;
              if (selectedVehicleRef.current && selectedVehicleRef.current.id === v.id) {
                markerDiv.classList.add("vehicle-selected");
              }
              markerDiv.style.transform = `rotate(${rotation}deg)`;
              markerDiv.style.width = "100%";
              markerDiv.style.height = "100%";

              const textSpan = document.createElement("span");
              textSpan.className = "vehicle-text";
              textSpan.textContent = v.rnum || v.route;
              textSpan.style.display = "inline-block";
              textSpan.style.transform = `rotate(${-rotation}deg)`;

              const pointer = document.createElement("div");
              pointer.className = "vehicle-pointer";

              markerDiv.appendChild(textSpan);
              markerDiv.appendChild(pointer);
              wrapper.appendChild(markerDiv);

              wrapper.onclick = (e) => {
                e.stopPropagation();
                if (v.rid && v.id) {
                  setSelectedVehicle(prev => {
                    if (prev && prev.id === v.id) return null;
                    return { rid: v.rid, id: v.id, gosNum: v.gosNum };
                  });
                }
              };

              const popup = new Popup({ offset: 25, closeButton: false }).setText(v.gosNum || "Unknown Plate");

              const marker = new Marker({ element: wrapper, anchor: "center" })
                .setLngLat([v.lng, v.lat])
                .setPopup(popup)
                .addTo(map.current);

              marker._lastUpdateTime = Date.now();
              marker._currentRot = rotation;
              marker._anim_key = v.anim_key;
              vehicleMarkersRef.current[v.id] = marker;

              // Immediately start predicting future movement for new markers!
              const speed = v.speed || 0;
              let targetLng = v.lng;
              let targetLat = v.lat;

              if (speed > 0) {
                const d = speed * (25 / 3600);
                const dirRad = (v.dir || 0) * Math.PI / 180;
                const deltaLat = (d / 111.32) * Math.cos(dirRad);
                const deltaLng = (d / (111.32 * Math.cos(v.lat * Math.PI / 180))) * Math.sin(dirRad);
                targetLng = v.lng + deltaLng;
                targetLat = v.lat + deltaLat;
              }

              // Start gliding to the predicted location
              activeAnimationsRef.current[v.id] = {
                  marker,
                  mDiv: markerDiv,
                  tSpan: textSpan,
                  currentLat: v.lat,
                  currentLng: v.lng,
                  currentDirection: rotation,
                  animationPoints: [],
                  currentFrame: 0,
                  currentDirectionFrame: 0,
                  deltaLat: 0,
                  deltaLng: 0,
                  deltaDirection: 0,
                  anim_key: v.anim_key,
                  lastAddedPoint: null,
                  fallbackTarget: {
                      lat: targetLat,
                      lng: targetLng
                  }
              };

              startGlobalAnimation();
            }
          });
        }
      } catch (err) {
        console.error("Failed to fetch live vehicles", err);
      }

      if (isActive) {
        setTimeout(fetchVehicles, 10000); // Continuous loop delay
      }
    };

    fetchVehicles(); // Start loop

    return () => {
      isActive = false;
      activeAnimationsRef.current = {};
      if (globalAnimationId.current) {
        cancelAnimationFrame(globalAnimationId.current);
        globalAnimationId.current = null;
      }
    };
  }, [selectedRoutes, stations]);

  // Route Nodes and Forecasts fetching
  useEffect(() => {
    if (!map.current) return;

    // Clear existing forecast markers
    forecastMarkersRef.current.forEach(m => m.remove());
    forecastMarkersRef.current = [];

    if (!selectedVehicle) {
      if (map.current.getLayer("route-nodes-layer")) {
        map.current.setLayoutProperty("route-nodes-layer", "visibility", "none");
      }
      setSelectedRouteStations(null);
      const source = map.current.getSource("route-nodes");
      if (source) {
        source.setData({ type: "FeatureCollection", features: [] });
      }
      return;
    }

    // Immediately clear old route stations to prevent stale data flashing
    setSelectedRouteStations(new Set());

    let isActive = true;
    let forecastTimeout = null;
    const abortController = new AbortController();
    const signal = abortController.signal;

    const fetchNodes = async () => {
      try {
        // Fetch and draw route nodes
        const resNodes = await apiFetch(`/api/route_nodes?id=${selectedVehicle.rid}`, { signal });
        const dataNodes = await resNodes.json();
        if (!isActive) return;

        const source = map.current.getSource("route-nodes");
        if (source) {
          if (dataNodes.nodes && dataNodes.nodes.length > 0) {
            source.setData({
              type: "Feature",
              properties: {},
              geometry: {
                type: "LineString",
                coordinates: dataNodes.nodes
              }
            });
            if (map.current.getLayer("route-nodes-layer")) {
              map.current.setLayoutProperty("route-nodes-layer", "visibility", "visible");
            }
          } else {
            source.setData({ type: "FeatureCollection", features: [] });
          }
        }
      } catch (err) {
        console.error("Failed to fetch nodes:", err);
      }
    };

    const fetchRouteStations = async () => {
      try {
        const res = await apiFetch(`/api/route_stations?id=${selectedVehicle.rid}`, { signal });
        const data = await res.json();
        if (!isActive) return;
        if (data.stations) {
          setSelectedRouteStations(new Set(data.stations));
        } else {
          setSelectedRouteStations(new Set());
        }
      } catch (err) {
        console.error("Failed to fetch route stations:", err);
      }
    };

    const fetchForecasts = async () => {
      if (!isActive) return;
      try {
        // Fetch and draw station forecasts
        const resForecasts = await apiFetch(`/api/vehicle_forecasts?vehid=${selectedVehicle.id}`, { signal });
        const dataForecasts = await resForecasts.json();
        if (!isActive) return;

        // Clear old markers before drawing new ones
        forecastMarkersRef.current.forEach(m => m.remove());
        forecastMarkersRef.current = [];

        if (dataForecasts.forecasts && dataForecasts.forecasts.length > 0) {
          // Deduplicate forecasts by station ID so we only show the earliest one and prevent massive DOM stacking
          const uniqueForecasts = [];
          const seenStids = new Set();
          dataForecasts.forecasts.forEach(f => {
            if (!seenStids.has(f.stid)) {
              seenStids.add(f.stid);
              uniqueForecasts.push(f);
            }
          });

          uniqueForecasts.forEach(f => {
            const st = stations.find(s => s.properties.id === f.stid);
            if (st) {
              const coords = st.geometry.coordinates;
              const el = document.createElement("div");
              el.className = "forecast-marker";
              el.style.backgroundColor = "white";
              el.style.border = "2px solid #ef4444";
              el.style.borderRadius = "8px";
              el.style.padding = "4px 8px";
              el.style.display = "flex";
              el.style.alignItems = "center";
              el.style.gap = "4px";
              el.style.boxShadow = "0 2px 4px rgba(0,0,0,0.2)";
              el.style.fontSize = "12px";
              el.style.fontWeight = "bold";
              el.style.color = "#1e293b";
              el.style.whiteSpace = "nowrap";

              // Draw closer arrival times over later ones
              const zIndex = 3000 - parseInt(f.time || 0, 10);
              el.style.zIndex = zIndex.toString();

              el.style.flexDirection = "column";
              el.style.cursor = "pointer";

              const nameText = st.properties.name || "Unknown Station";
              el.innerHTML = `
                <div style="display: flex; align-items: center; gap: 4px;">
                  <span>${f.time} мин.</span>
                  <div style="background-color: #ef4444; border-radius: 50%; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; color: white;">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 12 10s-6.7.6-8.5 1.1C2.7 11.3 2 12.1 2 13v3c0 .6.4 1 1 1h2"/><path d="m2 13 4-8h12l4 8"/><path d="M4 17v4c0 .6.4 1 1 1h2c.6 0 1-.4 1-1v-4"/><path d="M16 17v4c0 .6.4 1 1 1h2c.6 0 1-.4 1-1v-4"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="17.5" r="2.5"/></svg>
                  </div>
                </div>
                <div class="forecast-station-name" style="display: none; margin-top: 4px; font-size: 10px; color: #64748b; font-weight: normal; white-space: nowrap; align-self: flex-end;">
                  ${escapeHtml(nameText)}
                </div>
              `;

              el.onclick = (e) => {
                e.stopPropagation();
                const nameDiv = el.querySelector(".forecast-station-name");
                if (nameDiv) {
                  nameDiv.style.display = nameDiv.style.display === "none" ? "block" : "none";
                }
              };

              const marker = new Marker({ element: el, anchor: "bottom", offset: [0, -10] })
                .setLngLat(coords)
                .addTo(map.current);

              forecastMarkersRef.current.push(marker);
            }
          });
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error("Failed to fetch forecasts:", err);
      }

      if (isActive) {
        forecastTimeout = setTimeout(fetchForecasts, 10000);
      }
    };

    fetchNodes();
    fetchRouteStations();
    fetchForecasts();

    return () => {
      isActive = false;
      abortController.abort();
      if (forecastTimeout) clearTimeout(forecastTimeout);
    };
  }, [selectedVehicle, stations]);

  // Optimized Search Filter using pre-indexed search tokens
  const searchResults = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return [];

    const matches = [];
    for (let i = 0; i < stations.length; i++) {
      const s = stations[i];
      if (s._searchName && s._searchName.includes(q)) {
        matches.push(s);
        if (matches.length >= 8) break;
      }
    }
    return matches;
  }, [searchQuery, stations]);

  const handleSelectStation = (feat) => {
    setSearchQuery(feat.properties.name);
    setIsSearchOpen(false);

    if (map.current) {
      const coords = feat.geometry.coordinates;
      map.current.flyTo({
        center: coords,
        zoom: 16,
        duration: 1000,
        padding: { top: 220, bottom: 90, left: 20, right: 20 }
      });
      showStationPopup(map.current, coords, feat.properties, routesRef.current, favoritesRef.current.has(feat.properties.id), toggleFavorite);
    }
  };

  const favoriteStops = useMemo(() => {
    return stations.filter((st) => favorites.has(st.properties.id));
  }, [stations, favorites]);

  return (
    <>
      <div className="app-root">

        {/* Map Element */}
        <div className="map-container">
          <div ref={mapContainer} className="map" />
        </div>

        {/* Sliding Bottom Sheet Drawer (Tab 1: Stops, Tab 2: Routes, Tab 3: Favorites) */}
        {activeTab !== 0 && (
          <div className="mui-bottom-drawer" ref={drawerRef}>
            <div
              onTouchStart={handleDrawerTouchStart}
              onTouchMove={handleDrawerTouchMove}
              onTouchEnd={handleDrawerTouchEnd}
              style={{ touchAction: 'none' }}
            >
              <div className="mui-drawer-handle-bar" onClick={() => setActiveTab(0)} />
              <div className="mui-drawer-header" style={{ justifyContent: "flex-end", padding: "4px 16px 8px", borderBottom: "none" }}>
                <button
                  onClick={() => setActiveTab(0)}
                  style={{ background: "#f1f5f9", border: "none", borderRadius: "50%", width: "28px", height: "28px", cursor: "pointer", fontWeight: "bold" }}
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="mui-drawer-content">
              {/* Tab 4: Search */}
              {activeTab === 4 && (
                <div style={{ padding: "4px 0 10px 0", width: "100%", boxSizing: "border-box" }}>
                  <div className="mui-search-paper" style={{ position: "static", transform: "none", width: "100%", margin: "0 auto 12px auto", boxSizing: "border-box" }}>
                    <div className="mui-brand-icon">
                      <span className="material-symbols-outlined" style={{ fontSize: "20px", color: "#ffffff" }}>search</span>
                    </div>
                    <input
                      type="text"
                      className="mui-search-input"
                      placeholder="Поиск в Улан-Удэ (остановки)..."
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value);
                        setIsSearchOpen(true);
                      }}
                    />
                    {searchQuery && (
                      <button
                        onClick={() => { setSearchQuery(""); setIsSearchOpen(false); }}
                        style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "16px" }}
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  {searchResults.length > 0 ? (
                    <div className="mui-search-dropdown" style={{ position: "static", width: "100%", transform: "none", boxShadow: "none", border: "1px solid #e2e8f0" }}>
                      {searchResults.map((st) => (
                        <div
                          key={st.properties.id}
                          className="mui-dropdown-item"
                          onClick={() => handleSelectStation(st)}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                            <span
                              className={favorites.has(st.properties.id) ? "material-symbols-outlined fav-star active" : "material-symbols-outlined fav-star"}
                              onClick={(e) => toggleFavorite(st.properties.id, e)}
                              title={favorites.has(st.properties.id) ? "Удалить из избранного" : "Добавить в избранное"}
                            >
                              star
                            </span>
                            <div>
                              <div style={{ fontWeight: 600, color: "#1e293b", fontSize: "14px" }}>{st.properties.name}</div>
                              <div style={{ fontSize: "11px", color: "#64748b", display: "flex", alignItems: "center", gap: "4px" }}>
                                <span className="material-symbols-outlined" style={{ fontSize: "14px" }}>
                                  {st.properties.type === "bus" ? "directions_bus" : "tram"}
                                </span>
                                <span>{st.properties.type === "bus" ? "Автобусная остановка" : "Трамвайная остановка"}</span>
                              </div>
                            </div>
                          </div>
                          <span className={st.properties.type === "bus" ? "badge badge-bus" : "badge badge-tram"}>
                            {st.properties.type === "bus" ? "Автобус" : "Трамвай"}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : searchQuery ? (
                    <div style={{ textAlign: "center", padding: "20px", color: "#64748b" }}>Ничего не найдено</div>
                  ) : null}
                </div>
              )}

              {/* Tab 1: Stops List */}
              {activeTab === 1 && (
                <div>
                  <div style={{ display: "flex", justifyContent: "center", gap: "8px", padding: "10px 16px", borderBottom: "1px solid #e2e8f0", backgroundColor: "#f8fafc" }}>
                    <div
                      className={showBus ? "mui-chip active bus" : "mui-chip"}
                      onClick={() => setShowBus(!showBus)}
                      style={{ margin: 0, display: "flex", alignItems: "center", gap: "4px" }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>directions_bus</span>
                      Автобусы
                    </div>
                    <div
                      className={showTram ? "mui-chip active tram" : "mui-chip"}
                      onClick={() => setShowTram(!showTram)}
                      style={{ margin: 0, display: "flex", alignItems: "center", gap: "4px" }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>tram</span>
                      Трамваи
                    </div>
                  </div>
                  {stations.slice(0, 100).map((st) => (
                    <div
                      key={st.properties.id}
                      className="stop-card"
                      onClick={() => handleSelectStation(st)}
                    >
                      <div className="stop-card-left">
                        <span
                          className={favorites.has(st.properties.id) ? "material-symbols-outlined fav-star active" : "material-symbols-outlined fav-star"}
                          onClick={(e) => toggleFavorite(st.properties.id, e)}
                        >
                          star
                        </span>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "14px", color: "#1e293b" }}>{st.properties.name}</div>
                          <div style={{ fontSize: "11px", color: "#64748b", display: "flex", alignItems: "center", gap: "4px" }}>
                            <span className="material-symbols-outlined" style={{ fontSize: "14px" }}>
                              {st.properties.type === "bus" ? "directions_bus" : "tram"}
                            </span>
                            <span>{st.properties.type === "bus" ? "Автобус" : "Трамвай"}</span>
                          </div>
                        </div>
                      </div>
                      <span className="badge badge-bus" style={{ fontSize: "10px" }}>Показать</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Tab 2: Routes List */}
              {activeTab === 2 && (
                <div>
                  {[
                    { key: "bus", label: "Автобус", class: "bus" },
                    { key: "tram", label: "Трамвай", class: "tram" },
                    { key: "minibus", label: "Маршрутное такси", class: "minibus" }
                  ].map(group => {
                    const grpRoutes = groupedRoutes[group.key];
                    if (!grpRoutes || grpRoutes.length === 0) return null;

                    const isExpanded = expandedGroups[group.key];
                    const allSelected = grpRoutes.every(r => selectedRoutes.has(r.id));

                    return (
                      <div key={group.key}>
                        <div className={`routes-group-header ${group.class}`} onClick={() => toggleRouteGroup(group.key)}>
                          <div className="routes-group-header-left" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={allSelected}
                              onChange={() => toggleAllRoutesInGroup(grpRoutes)}
                            />
                            <span>{group.label}</span>
                          </div>
                          <span className="material-symbols-outlined" style={{ fontSize: "20px", color: "#64748b" }}>
                            {isExpanded ? "expand_less" : "expand_more"}
                          </span>
                        </div>

                        {isExpanded && (
                          <div className="routes-grid">
                            {grpRoutes.map(rt => (
                              <label key={rt.id + "_" + rt.number} className="route-checkbox-item">
                                <input
                                  type="checkbox"
                                  checked={selectedRoutes.has(rt.id)}
                                  onChange={() => toggleRouteSelection(rt.id)}
                                />
                                {rt.number}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Tab 3: Favorites Tab */}
              {activeTab === 3 && (
                <div>
                  {favoriteStops.length === 0 ? (
                    <div style={{ textAlign: "center", padding: "36px 16px", color: "#94a3b8", fontSize: "14px", display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
                      <span className="material-symbols-outlined" style={{ fontSize: "40px", color: "#cbd5e1" }}>bookmark_star</span>
                      <div>
                        У вас пока нет сохраненных остановок.<br />
                        Нажмите звездочку (<span className="material-symbols-outlined" style={{ fontSize: "16px", verticalAlign: "middle", color: "#f59e0b" }}>star</span>) возле любой остановки, чтобы добавить её в избранное.
                      </div>
                    </div>
                  ) : (
                    favoriteStops.map((st) => (
                      <div
                        key={st.properties.id}
                        className="stop-card"
                        onClick={() => handleSelectStation(st)}
                      >
                        <div className="stop-card-left">
                          <span
                            className="material-symbols-outlined fav-star active"
                            onClick={(e) => toggleFavorite(st.properties.id, e)}
                          >
                            star
                          </span>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: "14px", color: "#1e293b" }}>{st.properties.name}</div>
                            <div style={{ fontSize: "11px", color: "#64748b", display: "flex", alignItems: "center", gap: "4px" }}>
                              <span className="material-symbols-outlined" style={{ fontSize: "14px" }}>
                                {st.properties.type === "bus" ? "directions_bus" : "tram"}
                              </span>
                              <span>{st.properties.type === "bus" ? "Автобус" : "Трамвай"}</span>
                            </div>
                          </div>
                        </div>
                        <span className="badge badge-bus" style={{ fontSize: "10px" }}>Показать</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 2GIS & Material UI Fixed Bottom Navigation Bar */}
        <div className="mui-bottom-nav">
          <button className={activeTab === 4 ? "mui-nav-item active" : "mui-nav-item"} onClick={() => setActiveTab(activeTab === 4 ? 0 : 4)} title="Поиск" aria-label="Поиск">
            <span className="material-symbols-outlined mui-nav-icon">search</span>
          </button>

          <button className={activeTab === 1 ? "mui-nav-item active" : "mui-nav-item"} onClick={() => setActiveTab(activeTab === 1 ? 0 : 1)} title="Остановки" aria-label="Остановки">
            <span className="material-symbols-outlined mui-nav-icon">route</span>
          </button>

          <button className={activeTab === 2 ? "mui-nav-item active" : "mui-nav-item"} onClick={() => setActiveTab(activeTab === 2 ? 0 : 2)} title="Маршруты" aria-label="Маршруты">
            <span className="material-symbols-outlined mui-nav-icon">bus_map_pin</span>
          </button>

          <button className={activeTab === 3 ? "mui-nav-item active" : "mui-nav-item"} onClick={() => setActiveTab(activeTab === 3 ? 0 : 3)} title={`Избранное (${favorites.size})`} aria-label="Избранное">
            <span className="material-symbols-outlined mui-nav-icon">bookmark_star</span>
          </button>
        </div>
      </div>
    </>
  );
}
