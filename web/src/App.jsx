import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { sha256 } from "js-sha256";
import { Map as MapLibreMap, NavigationControl, GeolocateControl, Popup, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./App.css";

const API_SECRET = import.meta.env.VITE_API_SECRET || "ulan_ude_transit_secret_2026";
let rawBase = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
if (typeof window !== "undefined" && window.location.protocol === "https:" && rawBase.startsWith("http://")) {
  rawBase = "";
}
const API_BASE_URL = rawBase;
const TILE_URL = API_BASE_URL ? `${API_BASE_URL}/tiles/{z}/{x}/{y}.pbf` : "/tiles/{z}/{x}/{y}.pbf";

/** Escape HTML special chars to prevent XSS from upstream data. */
function escapeHtml(str) {
  if (typeof str !== "string") return String(str ?? "");
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Normalize raw vehicle types ("Т", "Тм", "М", "bus", "tram", "minibus") into canonical types */
function normalizeVehicleType(type, route) {
  const t = String(type || "").toLowerCase().trim();
  const r = String(route || "").toLowerCase().trim();
  if (t === "tram" || t === "т" || t === "тм" || r.startsWith("т-") || r.startsWith("тм-") || t.includes("трамвай")) {
    return "tram";
  }
  if (t === "minibus" || t === "м" || t === "мк" || t.includes("маршрут") || t.includes("микро")) {
    return "minibus";
  }
  if (window._globalRoutes && Array.isArray(window._globalRoutes)) {
    const matched = window._globalRoutes.find(item => String(item.number || item.rnum || "").trim().toLowerCase() === r);
    if (matched && matched.type) {
      const mt = String(matched.type).toLowerCase().trim();
      if (mt === "tram" || mt === "т" || mt === "тм") return "tram";
      if (mt === "minibus" || mt === "м") return "minibus";
      return "bus";
    }
  }
  const tramNumbers = new Set(["1", "2", "4", "7", "8"]);
  if (tramNumbers.has(r) && (!t || t === "bus" || t === "tram")) {
    return "tram";
  }
  return "bus";
}

/** Format vehicle license plate (e.g. "260(P923MP03)" -> "P923MP03") */
function formatGosNum(gosNum) {
  if (!gosNum) return "";
  const match = String(gosNum).match(/\(([^)]+)\)/);
  if (match && match[1]) {
    return match[1].trim();
  }
  return String(gosNum).trim();
}

async function apiFetch(url, options = {}) {
  const headers = { ...options.headers };
  if (API_SECRET) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = sha256(timestamp + API_SECRET);
    headers["X-App-Timestamp"] = timestamp;
    headers["X-App-Signature"] = signature;
  }
  const targetUrl = API_BASE_URL && url.startsWith("/") ? `${API_BASE_URL}${url}` : url;
  return fetch(targetUrl, { ...options, headers });
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

// Floating 3D Red/White Compass Disc (Appears when map is rotated away from North)
class YandexFloatingCompassControl {
  onAdd(map) {
    this._map = map;
    this._container = document.createElement('div');
    this._container.className = 'yandex-compass-ctrl';
    this._container.title = 'Сбросить поворот карты на Север';
    
    this._container.innerHTML = `
      <svg class="yandex-compass-svg" viewBox="0 0 44 44" width="42" height="42" style="display: block; margin: auto; transition: transform 0.12s ease-out;">
        <circle cx="22" cy="22" r="19" fill="#ffffff" fill-opacity="0.95" stroke="#e2e8f0" stroke-width="1.2" filter="drop-shadow(0 2px 6px rgba(0,0,0,0.18))"/>
        <!-- 3D Red North Tip (faceted) -->
        <polygon points="22,6 22,22 15,19" fill="#EF4444"/>
        <polygon points="22,6 29,19 22,22" fill="#DC2626"/>
        <!-- 3D White/Silver South Tip (faceted) -->
        <polygon points="22,38 15,25 22,22" fill="#F8FAFC"/>
        <polygon points="22,38 22,22 29,25" fill="#CBD5E1"/>
        <circle cx="22" cy="22" r="1.6" fill="#0F172A"/>
      </svg>
    `;

    this._svg = this._container.querySelector('.yandex-compass-svg');

    this._updateRotation = () => {
      if (!this._map) return;
      const bearing = this._map.getBearing();
      if (this._svg) {
        this._svg.style.transform = `rotate(${-bearing}deg)`;
      }
      // Show disc when map is rotated away from North, hide when perfectly 0°
      if (Math.abs(bearing) > 1.5) {
        this._container.classList.add('visible');
      } else {
        this._container.classList.remove('visible');
      }
    };

    this._map.on('rotate', this._updateRotation);
    this._updateRotation();

    this._container.onclick = () => {
      if (!this._map) return;
      this._map.easeTo({ bearing: 0, duration: 400 });
    };

    return this._container;
  }

  onRemove() {
    if (this._map && this._updateRotation) {
      this._map.off('rotate', this._updateRotation);
    }
    if (this._container && this._container.parentNode) {
      this._container.parentNode.removeChild(this._container);
    }
    this._map = undefined;
  }
}

// Yandex-Style Geolocation & Heading Mode Button (↗ Idle vs | ▲ | Active Heading Mode)
class YandexLocationHeadingControl {
  constructor(geolocateControl) {
    this._geolocateControl = geolocateControl;
    this._mode = 'idle'; // 'idle' or 'active'
    this._geoWatchId = null;
    this._orientationHandler = null;
  }
  onAdd(map) {
    this._map = map;
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

    this._btn = document.createElement('button');
    this._btn.className = 'maplibregl-ctrl-icon yandex-nav-btn';
    this._btn.type = 'button';
    this._btn.title = 'Мое местоположение и слежение по курсу';
    
    this._renderIcon();

    this._btn.onclick = () => {
      if (this._mode === 'idle') {
        this._activateHeadingTracking();
      } else {
        this._deactivateHeadingTracking();
      }
    };

    this._container.appendChild(this._btn);
    return this._container;
  }

  _renderIcon() {
    if (this._mode === 'idle') {
      // 1st Screenshot: Dark grey/black angled navigation arrowhead ↗
      this._btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="22" height="22" fill="#1e293b" style="display: block; margin: auto;">
          <path d="M4 11.5L19.5 4.5L12.5 20L11 13.5L4 11.5Z"/>
        </svg>
      `;
      this._btn.classList.remove('active-heading');
    } else {
      // 2nd Screenshot: Blue navigation arrowhead with dashed course lines | ▲ |
      this._btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="24" height="24" style="display: block; margin: auto;">
          <line x1="12" y1="2" x2="12" y2="6.5" stroke="#94A3B8" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="2 3"/>
          <path d="M12 7.5L17.5 17L12 15L6.5 17L12 7.5Z" fill="#2563eb"/>
          <line x1="12" y1="17.5" x2="12" y2="22" stroke="#94A3B8" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="2 3"/>
        </svg>
      `;
      this._btn.classList.add('active-heading');
    }
  }

  _activateHeadingTracking() {
    this._mode = 'active';
    this._renderIcon();

    // 1. Automatically call and trigger GeolocateControl (GPS location + pulsing dot)
    if (this._geolocateControl) {
      try {
        this._geolocateControl.trigger();
      } catch (err) {
        console.warn("Could not trigger geolocateControl:", err);
      }
    } else if (typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (this._map && pos.coords) {
            this._map.flyTo({
              center: [pos.coords.longitude, pos.coords.latitude],
              zoom: Math.max(this._map.getZoom(), 15),
              duration: 700
            });
          }
        },
        (err) => console.warn('Geo error:', err),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    }

    const isIOS = typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

    // Hardware compass orientation ONLY on iOS
    if (isIOS) {
      this._orientationHandler = (e) => {
        if (!this._map) return;

        let compass = e.webkitCompassHeading;
        if (compass != null && Number.isFinite(compass)) {
          const target = ((compass % 360) + 360) % 360;
          const current = ((this._map.getBearing() % 360) + 360) % 360;
          let diff = (target - current) % 360;
          if (diff > 180) diff -= 360;
          if (diff < -180) diff += 360;

          const nextBearing = ((current + diff * 0.35) % 360 + 360) % 360;
          this._map.setBearing(nextBearing);
        }
      };

      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then((res) => {
          if (res === 'granted') {
            window.addEventListener('deviceorientation', this._orientationHandler, true);
          } else {
            this._deactivateHeadingTracking();
          }
        }).catch(() => {
          this._deactivateHeadingTracking();
        });
      }
    }
  }

  _deactivateHeadingTracking() {
    this._mode = 'idle';
    this._renderIcon();

    if (this._geoWatchId != null) {
      navigator.geolocation.clearWatch(this._geoWatchId);
      this._geoWatchId = null;
    }
    if (this._orientationHandler) {
      window.removeEventListener('deviceorientationabsolute', this._orientationHandler, true);
      window.removeEventListener('deviceorientation', this._orientationHandler, true);
      this._orientationHandler = null;
    }
    if (this._map) {
      this._map.easeTo({ bearing: 0, duration: 400 });
    }
  }

  onRemove() {
    this._deactivateHeadingTracking();
    if (this._container && this._container.parentNode) {
      this._container.parentNode.removeChild(this._container);
    }
    this._map = undefined;
  }
}

const style = {
  version: 8,
  sources: {
    openmaptiles: {
      type: "vector",
      tiles: [TILE_URL],
      minzoom: 4,
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
let popupStateListener = null;

function setPopupState(open) {
  if (typeof popupStateListener === 'function') {
    try { popupStateListener(Boolean(open)); } catch {}
  }
}

function closeAllStationPopups() {
  if (activeStationPopup) {
    try {
      activeStationPopup.remove();
    } catch { }
    activeStationPopup = null;
  }
  document.querySelectorAll('.maplibregl-popup').forEach(p => p.remove());
  setPopupState(false);
}

// Sound Effect for Final Arrival using Web Audio API (ambient SFX - NEVER spawns iOS Lock Screen Media Player widget)
let audioCtxInstance = null;
let arrivalAudioBuffer = null;

async function initAudioOnUserGesture() {
  try {
    if (!audioCtxInstance && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        audioCtxInstance = new AudioCtx();
      }
    }
    if (audioCtxInstance && audioCtxInstance.state === 'suspended') {
      await audioCtxInstance.resume();
    }
    if (audioCtxInstance && !arrivalAudioBuffer) {
      const res = await fetch('/arrival-chaching.wav');
      const arrayBuf = await res.arrayBuffer();
      arrivalAudioBuffer = await audioCtxInstance.decodeAudioData(arrayBuf);
    }
  } catch (e) {
    console.warn("WebAudio init error:", e);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('click', initAudioOnUserGesture, { passive: true, once: true });
  window.addEventListener('touchstart', initAudioOnUserGesture, { passive: true, once: true });
}

function playChaChingSound() {
  try {
    // Only play in-app audio if the app is currently in foreground/visible;
    // when phone is locked, native WebPush notification sound plays without lock-screen media widget
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return;
    }
    initAudioOnUserGesture();
    if (audioCtxInstance && arrivalAudioBuffer) {
      if (audioCtxInstance.state === 'suspended') {
        audioCtxInstance.resume();
      }
      const src = audioCtxInstance.createBufferSource();
      src.buffer = arrivalAudioBuffer;
      src.connect(audioCtxInstance.destination);
      src.start(0);
    }
  } catch (e) {
    console.warn("Audio playback error:", e);
  }
}

// In-App Sound and Vibration Trigger (System tray notifications are handled exclusively by backend WebPush)
async function triggerArrivalPush(title, body, tag = 'arrival-alarm', isFinalArrival = false) {
  if (isFinalArrival) {
    playChaChingSound();
    if ('vibrate' in navigator) {
      try { navigator.vibrate([300, 100, 300, 100, 450]); } catch {}
    }
  } else {
    if ('vibrate' in navigator) {
      try { navigator.vibrate([120]); } catch {}
    }
  }
}

function showStationPopup(mapInstance, coords, props, routes = [], isFavorite = false, onToggleFavorite = null) {
  const isBus = props.type === "bus";
  const typeText = isBus ? "Автобус / Маршрутка" : "Трамвай";
  const icon = isBus ? "directions_bus" : "tram";
  const typeClass = isBus ? "bus" : "tram";

  closeAllStationPopups();
  document.querySelectorAll('.forecast-marker').forEach(p => p.remove());

  const safeName = escapeHtml(props.name || "Остановка");
  const safeId = escapeHtml(props.id);
  const safeDesc = props.description ? `<div style="font-size: 11px; padding: 4px 14px 0; color: #64748b;">${escapeHtml(props.description)}</div>` : '';

  const popupHtml = `
    <div class="stop-popup">
      <div class="stop-popup-header ${typeClass}">
        <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
          <span class="material-symbols-outlined" style="font-size: 20px; flex-shrink: 0;">${icon}</span>
          <span style="font-weight: 600; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${safeName}</span>
        </div>
        <span id="popup-fav-btn-${safeId}" class="popup-fav-btn ${isFavorite ? 'active' : ''}" role="button" tabindex="0" title="${isFavorite ? 'Удалить из избранного' : 'Добавить в избранное'}">
          <span class="material-symbols-outlined">star</span>
        </span>
      </div>
      ${safeDesc}
      <div class="stop-popup-body">
        <div class="stop-detail-row">
          <span>Тип:</span>
          <span class="badge ${isBus ? 'badge-bus' : 'badge-tram'}">${typeText}</span>
        </div>
      </div>
      <div id="station-forecast-${safeId}" class="station-forecast-container" style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #1e293b;">
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
  setPopupState(true);

  let isActive = true;
  let forecastTimer = null;
  const abortCtrl = new AbortController();

  popup.on('close', () => {
    isActive = false;
    abortCtrl.abort();
    if (forecastTimer) clearTimeout(forecastTimer);
    if (activeStationPopup === popup) {
      activeStationPopup = null;
    }
    setPopupState(false);
  });

  const favBtn = document.getElementById(`popup-fav-btn-${safeId}`);
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

  // Precompute rid -> route lookup map for O(1) matching
  const routeMap = new Map();
  (routes || []).forEach(r => {
    if (r.id) {
      String(r.id).split(',').forEach(id => routeMap.set(String(id).trim(), r));
    }
    if (Array.isArray(r.subroutes)) {
      r.subroutes.forEach(sr => {
        if (sr.id) routeMap.set(String(sr.id).trim(), r);
      });
    }
  });

  const loadForecast = () => {
    if (!isActive) return;
    apiFetch(`/api/station_forecasts?sid=${encodeURIComponent(props.id)}`, { signal: abortCtrl.signal })
      .then(r => r.json())
      .then(data => {
        if (!isActive) return;
        const container = document.getElementById(`station-forecast-${safeId}`);
        if (!container) return;
        if (data.forecasts && data.forecasts.length > 0) {
          let html = `
            <div style="display: flex; align-items: center; padding-bottom: 8px; margin-bottom: 4px; border-bottom: 1px solid #cbd5e1; color: #94a3b8; font-size: 12px; font-weight: 600;">
              <div style="width: 50px; flex-shrink: 0; text-align: center;">Маршрут</div>
              <div style="width: 62px; flex-shrink: 0; text-align: center; margin-left: 6px;">Прогноз</div>
              <div style="flex-grow: 1; padding-left: 8px;">Направление</div>
              <div style="width: 32px; flex-shrink: 0; text-align: center; margin-left: 6px;" title="Оповестить за 1 мин">🔔</div>
            </div>
            <ul class="station-forecast-list">
          `;
          data.forecasts.forEach(f => {
            const r = routeMap.get(String(f.rid));
            let rnum = r ? (r.number || r.rnum || r.routeNumber || r.route || f.rid) : f.rid;

            if (typeof rnum === 'string') {
              rnum = rnum.replace(/\(.*?\)/g, '').replace('Тм-', '').replace('Т-', '');
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

            const isRemActive = window.isArrivalReminderActive ? window.isArrivalReminderActive(safeId, f.rid, f.vehid) : false;

            html += `<li style="display: flex; align-items: center; padding: 7px 0; border-bottom: 1px solid #f1f5f9;">
              <div style="width: 50px; flex-shrink: 0; display: flex; justify-content: center;">
                <div style="background-color: ${bgColor}; color: white; border-radius: 6px; width: 44px; height: 28px; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: bold;">${escapeHtml(rnum)}</div>
              </div>
              <div style="margin-left: 6px; flex-shrink: 0; width: 62px; display: flex; justify-content: center;">
                <div style="background-color: #f1f5f9; border-radius: 6px; display: flex; align-items: center; justify-content: center; height: 28px; width: 58px; font-size: 12px; font-weight: 600; color: #0f172a;">${escapeHtml(f.time)} мин.</div>
              </div>
              <div class="dest-wrapper" style="margin-left: 8px; flex-grow: 1; overflow: hidden; white-space: nowrap; position: relative; text-overflow: ellipsis;">
                <div class="dest-text" style="display: inline-block; font-size: 13px; color: #0f172a;">${escapeHtml(dest)}</div>
              </div>
              <button class="forecast-alarm-btn ${isRemActive ? 'active' : ''}" data-sid="${safeId}" data-stname="${safeName}" data-rid="${f.rid}" data-rnum="${escapeHtml(rnum)}" data-time="${escapeHtml(f.time)}" data-vehid="${f.vehid || ''}" data-gosnum="${escapeHtml(f.gosNum || '')}" title="${isRemActive ? 'Отключить напоминание' : 'Напомнить за 1 мин до прибытия'}">
                <span class="material-symbols-outlined" style="font-size: 18px;">${isRemActive ? 'notifications_active' : 'notifications'}</span>
              </button>
            </li>`;
          });
          html += '</ul>';
          container.innerHTML = html;

          container.querySelectorAll('.forecast-alarm-btn').forEach(btn => {
            btn.onclick = async (e) => {
              e.stopPropagation();
              const sid = btn.dataset.sid;
              const stname = btn.dataset.stname;
              const rid = btn.dataset.rid;
              const rnum = btn.dataset.rnum;
              const time = btn.dataset.time;
              const vehid = btn.dataset.vehid || "";
              const gosnum = btn.dataset.gosnum || "";
              if (window.toggleArrivalReminder) {
                const nowActive = await window.toggleArrivalReminder(sid, stname, rid, rnum, time, vehid, gosnum);
                btn.classList.toggle('active', nowActive);
                btn.title = nowActive ? 'Отключить напоминание' : 'Напомнить за 1 мин до прибытия';
                const icon = btn.querySelector('.material-symbols-outlined');
                if (icon) icon.textContent = nowActive ? 'notifications_active' : 'notifications';
              }
            };
          });

          setTimeout(() => {
            container.querySelectorAll('.dest-wrapper').forEach(wrapper => {
              const textEl = wrapper.querySelector('.dest-text');
              if (textEl && textEl.scrollWidth > wrapper.clientWidth) {
                const dist = textEl.scrollWidth - wrapper.clientWidth;
                textEl.style.setProperty('--scroll-dist', `-${dist + 10}px`);
                const duration = Math.max((dist / 20) + 2, 4);
                textEl.style.animation = `scroll-text-dist ${duration}s linear infinite alternate`;
              }
            });
          }, 10);
        } else {
          container.innerHTML = '<div style="color: #64748b; text-align: center; padding: 12px 0;">Нет ожидаемых маршрутов</div>';
        }

        if (isActive) {
          forecastTimer = setTimeout(loadForecast, 10000);
        }
      })
      .catch((err) => {
        if (!isActive || err.name === 'AbortError') return;
        const container = document.getElementById(`station-forecast-${safeId}`);
        if (container) container.innerHTML = '<div style="color: #ef4444; text-align: center; padding: 12px 0;">Ошибка загрузки</div>';

        if (isActive) {
          forecastTimer = setTimeout(loadForecast, 10000);
        }
      });
  };

  loadForecast();
}

function normalizeStationCompareName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/№\s*/g, " ")
    .replace(/[«»"'()\.\-–—,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function RouteProgressRing({ percent, size = 38 }) {
  const clamped = Math.min(100, Math.max(0, Math.round(percent || 0)));
  const strokeWidth = size >= 38 ? 3.2 : 2.8;
  const radius = (size / 2) - strokeWidth - 1;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (clamped / 100) * circumference;
  const fontSize = size >= 38 ? "11px" : "9px";

  return (
    <div
      className="hud-progress-ring"
      style={{ width: `${size}px`, height: `${size}px` }}
      title={`Прогресс маршрута: ${clamped}%`}
      aria-label={`Прогресс маршрута: ${clamped}%`}
    >
      <svg className="hud-progress-svg" style={{ width: `${size}px`, height: `${size}px` }} viewBox={`0 0 ${size} ${size}`}>
        <circle
          className="hud-progress-track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
        />
        <circle
          className="hud-progress-fill"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
        />
      </svg>
      <span className="hud-progress-text" style={{ fontSize }}>{clamped}%</span>
    </div>
  );
}

export default function App() {
  const mapContainer = useRef(null);
  const map = useRef(null);

  // Core Data States & Refs
  const [stations, setStations] = useState([]);
  const [routes, setRoutes] = useState([]);
  const routesRef = useRef([]);
  const stationsRef = useRef([]);
  const routeStationsCacheRef = useRef({});
  const pendingRouteStationsRef = useRef(new Set());
  const [loading, setLoading] = useState(true);
  const [isSplashMounted, setIsSplashMounted] = useState(true);
  const [isSplashFading, setIsSplashFading] = useState(false);
  const [error, setError] = useState(null);
  const [routeStationsOrder, setRouteStationsOrder] = useState([]);
  const [telemetryTick, setTelemetryTick] = useState(0); // eslint-disable-line no-unused-vars -- State setter forces re-render on telemetry updates
  const [historyProgressTick, setHistoryProgressTick] = useState(0); // eslint-disable-line no-unused-vars -- Forces re-render when history route stations are cached

  // Navigation & Search State
  const [activeTab, setActiveTab] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [stopLimit, setStopLimit] = useState(60);
  const [isPopupOpen, setIsPopupOpen] = useState(false);

  useEffect(() => {
    popupStateListener = (open) => {
      setIsPopupOpen(open);
    };
    return () => {
      popupStateListener = null;
    };
  }, []);

  // Favorites
  const [favorites, setFavorites] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("fav_stations") || "[]"));
    } catch {
      return new Set();
    }
  });
  const favoritesRef = useRef(favorites);

  // Filters
  const [showBus, setShowBus] = useState(() => {
    return localStorage.getItem("pref_showBus") !== "false";
  });
  const [showTram, setShowTram] = useState(() => {
    return localStorage.getItem("pref_showTram") !== "false";
  });
  const filtersRef = useRef({ bus: true, tram: true });

  // Route Selections
  const [expandedGroups, setExpandedGroups] = useState({ bus: true, tram: true, minibus: true });
  const [selectedRoutes, setSelectedRoutes] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("pref_selectedRoutes") || "[]"));
    } catch {
      return new Set();
    }
  });

  // Vehicle Tracking & Route Overlay States
  const [selectedVehicle, setSelectedVehicle] = useState(() => {
    try {
      const saved = localStorage.getItem("pref_selectedVehicle");
      if (!saved) return null;
      const parsed = JSON.parse(saved);
      if (!parsed || typeof parsed !== "object") return null;
      // Discard restore session if older than 30 minutes
      if (parsed.savedAt && Date.now() - parsed.savedAt > 1800000) {
        localStorage.removeItem("pref_selectedVehicle");
        return null;
      }
      parsed.type = normalizeVehicleType(parsed.type, parsed.route || parsed.rnum);
      return parsed;
    } catch {
      return null;
    }
  });
  const isSameVehicleHistoryEntry = (a, b) => {
    if (!a || !b) return false;
    if (a.id && b.id && String(a.id) === String(b.id)) return true;
    
    const aPlate = formatGosNum(a.gosNum).toLowerCase();
    const bPlate = formatGosNum(b.gosNum).toLowerCase();
    const aRoute = String(a.route || a.rnum || '').trim().toLowerCase();
    const bRoute = String(b.route || b.rnum || '').trim().toLowerCase();

    if (aPlate && bPlate && aPlate.length >= 2 && aPlate === bPlate) {
      if (!aRoute || !bRoute || aRoute === bRoute) return true;
    }
    return false;
  };

  const [selectedRouteStations, setSelectedRouteStations] = useState(null);
  const [nextStationInfo, setNextStationInfo] = useState(null);
  const [vehicleHistory, setVehicleHistory] = useState(() => {
    try {
      const saved = localStorage.getItem("pref_vehicleHistory");
      if (!saved) return [];
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        const deduped = [];
        for (const item of parsed) {
          if (!item || !item.id) continue;
          const idx = deduped.findIndex(d => isSameVehicleHistoryEntry(d, item));
          if (idx === -1) {
            deduped.push(item);
          } else {
            const existing = deduped[idx];
            const preferItem = (!String(item.id).startsWith('rem_') && String(existing.id).startsWith('rem_')) || ((item.timestamp || 0) > (existing.timestamp || 0));
            if (preferItem) {
              deduped[idx] = { ...existing, ...item, id: !String(item.id).startsWith('rem_') ? item.id : existing.id };
            }
          }
        }
        return deduped.slice(0, 9);
      }
      return [];
    } catch {
      return [];
    }
  });
  const initialIsFollowing = (() => {
    try {
      const saved = localStorage.getItem("pref_isFollowingVehicle");
      return saved !== null ? saved === "true" : true;
    } catch {
      return true;
    }
  })();
  const [isFollowingVehicle, setIsFollowingVehicle] = useState(initialIsFollowing);
  const [reminderDropOpen, setReminderDropOpen] = useState(false);
  const isFollowingVehicleRef = useRef(initialIsFollowing);
  const prevSelectedVehicleIdRef = useRef(selectedVehicle ? selectedVehicle.id : null);
  const isInitialFlyingRef = useRef(false);
  const selectedVehicleRef = useRef(null);
  const selectedRouteStationsRef = useRef(null);
  const knownVehiclesRef = useRef({});
  const lastResumeTimeRef = useRef(Date.now());
  const lastWheelTimeRef = useRef(0);
  const lastVehicleSelectionTimeRef = useRef(0);
  const lastTabCloseTimeRef = useRef(0);
  const isZoomingOrPinchingRef = useRef(false);
  const isDraggingRef = useRef(false);
  const dragStartPointRef = useRef(null);
  const wasFollowingBeforeHiddenRef = useRef(initialIsFollowing);
  const isAppResumeRef = useRef(false);
  const wakeLockRef = useRef(null);
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [consecutiveFetchErrors, setConsecutiveFetchErrors] = useState(0);
  const isProgrammaticMoveRef = useRef(false);
  const lastFollowPillUpdateRef = useRef(0);
  const missedPollsRef = useRef(0);
  const hasInitialCenteredRef = useRef(!selectedVehicle);
  const debouncedForecastRefreshRef = useRef(null);

  // Arrival Reminders & Push Notification Alarm System
  const [reminders, setReminders] = useState(() => {
    try {
      const saved = localStorage.getItem("pref_arrival_reminders");
      if (saved) {
        const parsed = JSON.parse(saved);
        const now = Date.now();
        // Prune expired reminders (older than initialTime + 5 mins or 30 mins)
        return Array.isArray(parsed) ? parsed.filter(r => {
          if (!r || r.triggered) return false;
          const initMins = parseInt(r.initialTime, 10) || 15;
          const ageMins = (now - (r.createdAt || now)) / 60000;
          return ageMins < Math.max(initMins + 5, 20);
        }) : [];
      }
    } catch {
      return [];
    }
    return [];
  });

  const remindersRef = useRef(reminders);
  useEffect(() => {
    remindersRef.current = reminders;
    try {
      localStorage.setItem("pref_arrival_reminders", JSON.stringify(reminders));
    } catch {}
  }, [reminders]);

  // Sync active reminders with Cloudflare Worker on startup and on tab foreground/visibility change
  useEffect(() => {
    const syncWithServer = async () => {
      try {
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.ready;
          if (reg && reg.pushManager) {
            const sub = await reg.pushManager.getSubscription();
            if (sub && sub.endpoint) {
              const res = await apiFetch('/api/reminders/active', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: sub.endpoint })
              });
              if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.reminders)) {
                  const serverMap = new Map(data.reminders.map(r => [r.id, r]));
                  setReminders(prev => {
                    const now = Date.now();
                    // Drop reminders that the server has already finished and removed,
                    // preserving only newly created ones (< 20s old)
                    const kept = prev.filter(r => serverMap.has(r.id) || (now - (r.createdAt || now)) < 20000);
                    // Also add any server reminders not yet in local state
                    const localIds = new Set(kept.map(r => r.id));
                    const missing = data.reminders.filter(r => !localIds.has(r.id));
                    return [...kept, ...missing];
                  });
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn("syncWithServer error:", err);
      }
    };

    syncWithServer();
    const handleVisChange = () => {
      if (document.visibilityState === 'visible') {
        syncWithServer();
      }
    };
    document.addEventListener('visibilitychange', handleVisChange);
    return () => document.removeEventListener('visibilitychange', handleVisChange);
  }, []);

  const alertToast = null;
  const setAlertToast = () => {}; // disabled – no black info messages

  const [activeReminderIdx, setActiveReminderIdx] = useState(0);
  const [reminderLimitNotice, setReminderLimitNotice] = useState(false);
  const reminderLimitTimerRef = useRef(null);
  const touchStartYRef = useRef(null);
  const touchStartXRef = useRef(null);

  const cancelArrivalReminder = async (remId, rnum = "") => {
    const existing = remindersRef.current.find(r => r.id === remId && !r.triggered);
    setReminders(prev => prev.filter(r => r.id !== remId));

    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready;
        if (reg && reg.pushManager) {
          const sub = await reg.pushManager.getSubscription();
          if (sub) {
            const parts = remId.split('_');
            const sid = existing ? existing.sid : parts[0];
            const rid = existing ? existing.rid : parts[1];
            const vehid = existing ? existing.vehid : (parts[2] || "");
            apiFetch('/api/reminders/unsubscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                subscription: sub.toJSON ? sub.toJSON() : sub,
                endpoint: sub.endpoint,
                sid: String(sid || ""),
                rid: String(rid || ""),
                vehid: String(vehid || "")
              })
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.warn("Failed to unsubscribe push reminder:", err);
    }

    const displayRnum = rnum || (existing ? existing.rnum : "");
    setAlertToast({
      title: "Уведомление отменено",
      body: displayRnum ? `Напоминание для маршрута ${displayRnum} снято.` : "Напоминание снято."
    });
    setTimeout(() => setAlertToast(null), 3000);
  };

  const toggleArrivalReminder = async (sid, stationName, rid, rnum, initialTime, inVehid = "", inGosNum = "") => {
    let vehid = inVehid || "";
    let gosNum = inGosNum || "";
    let vehType = "";

    // Find the EXACT live vehicle matching this forecast
    const targetRoute = String(rnum || "").trim().toLowerCase();
    const initTimeNum = parseFloat(initialTime) || 0;

    // Find station coordinates if sid is given
    let stLat = null, stLng = null;
    if (sid && stations && stations.length > 0) {
      const st = stations.find(s => String(s.id) === String(sid) || String(s.properties?.id) === String(sid));
      if (st && st.geometry && Array.isArray(st.geometry.coordinates)) {
        stLng = st.geometry.coordinates[0];
        stLat = st.geometry.coordinates[1];
      }
    }

    const allVehicles = Object.values(knownVehiclesRef.current);

    let liveMatch = null;
    // 1. Exact vehid match
    if (vehid) {
      liveMatch = allVehicles.find(v => String(v.id) === String(vehid));
    }
    // 2. Exact gosNum (plate) match within same route
    if (!liveMatch && gosNum) {
      const plateNorm = formatGosNum(gosNum).toLowerCase();
      liveMatch = allVehicles.find(v => {
        if (!v.gosNum) return false;
        const vRoute = String(v.route || v.rnum || "").trim().toLowerCase();
        if (targetRoute && vRoute && targetRoute !== vRoute) return false;
        return formatGosNum(v.gosNum).toLowerCase() === plateNorm;
      });
    }
    // 3. Find candidates on this route or rid
    if (!liveMatch) {
      const candidates = allVehicles.filter(v => {
        const vRoute = String(v.route || v.rnum || "").trim().toLowerCase();
        if (targetRoute && vRoute && targetRoute === vRoute) return true;
        if (rid && v.rid && String(v.rid) === String(rid)) return true;
        return false;
      });

      if (candidates.length === 1) {
        liveMatch = candidates[0];
      } else if (candidates.length > 1) {
        // Query vehicle forecasts in parallel to find exact vehicle matching arrival time to this station
        try {
          const forecastResults = await Promise.all(
            candidates.map(async (v) => {
              try {
                const res = await apiFetch(`/api/vehicle_forecasts?vehid=${encodeURIComponent(v.id)}`);
                if (!res.ok) return { v, eta: null };
                const data = await res.json();
                const stForecast = (data.forecasts || []).find(f => String(f.stid) === String(sid));
                return { v, eta: stForecast ? parseInt(stForecast.time, 10) : null };
              } catch {
                return { v, eta: null };
              }
            })
          );

          const valid = forecastResults.filter(r => r.eta != null && !isNaN(r.eta));
          if (valid.length > 0) {
            valid.sort((a, b) => Math.abs(a.eta - initTimeNum) - Math.abs(b.eta - initTimeNum));
            liveMatch = valid[0].v;
          }
        } catch {}

        // Fallback to distance scoring if vehicle forecasts API unavailable
        if (!liveMatch && stLat != null && stLng != null) {
          const expectedDistKm = Math.max(0.5, (initTimeNum / 60) * 25);
          const scored = candidates.map(v => {
            const dLat = (stLat - v.lat) * 111.32;
            const dLng = (stLng - v.lng) * (111.32 * Math.cos(stLat * Math.PI / 180));
            const distKm = Math.sqrt(dLat * dLat + dLng * dLng);
            return { v, score: Math.abs(distKm - expectedDistKm) };
          });
          scored.sort((a, b) => a.score - b.score);
          liveMatch = scored[0].v;
        }

        if (!liveMatch) {
          liveMatch = candidates[0];
        }
      }
    }

    if (liveMatch) {
      if (!vehid) vehid = String(liveMatch.id || "");
      if (!gosNum) gosNum = String(liveMatch.gosNum || "");
      vehType = liveMatch.type || "";
    }

    if (!vehType && routesRef.current) {
      const rObj = routesRef.current.find(r => String(r.number).trim().toLowerCase() === String(rnum || "").trim().toLowerCase());
      if (rObj) vehType = rObj.type;
    }

    const remId = vehid ? `${sid}_${rid}_${vehid}` : `${sid}_${rid}`;
    const cleanPlate = gosNum ? formatGosNum(gosNum).toLowerCase() : "";

    const existingRem = remindersRef.current.find(r => {
      if (r.triggered) return false;
      // 1. Same exact reminder ID
      if (r.id === remId) return true;
      // 2. Same stop and route
      if (String(r.sid) === String(sid) && (String(r.rid) === String(rid) || (vehid && String(r.vehid) === String(vehid)))) return true;
      // 3. Same vehicle ID across ANY stop
      if (vehid && r.vehid && String(r.vehid) === String(vehid)) return true;
      // 4. Same license plate across ANY stop
      if (cleanPlate && r.gosNum && formatGosNum(r.gosNum).toLowerCase() === cleanPlate) return true;
      return false;
    });

    // 1. If reminder already exists:
    if (existingRem) {
      // If clicking the bell on the EXACT same stop -> toggle off and cancel
      if (String(existingRem.sid) === String(sid)) {
        await cancelArrivalReminder(existingRem.id, rnum);
        return false;
      }
      // If setting a reminder for the same vehicle on a DIFFERENT stop -> cancel the older stop's reminder first
      await cancelArrivalReminder(existingRem.id, rnum);
    }

    // 2. Setting a new reminder -> check 3-reminder limit
    const activeList = remindersRef.current.filter(r => !r.triggered && r.id !== existingRem?.id);
    if (activeList.length >= 3) {
      setReminderLimitNotice(true);
      if (reminderLimitTimerRef.current) clearTimeout(reminderLimitTimerRef.current);
      reminderLimitTimerRef.current = setTimeout(() => {
        setReminderLimitNotice(false);
      }, 4000);
      return false;
    }

    let pushSub = null;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

    if (typeof Notification === 'undefined') {
      if (isIOS) {
        setAlertToast({
          title: "⚠️ Откройте с экрана «Домой»",
          body: "На iPhone пуш-уведомления работают только если запустить приложение с иконки на экране «Домой»."
        });
        setTimeout(() => setAlertToast(null), 7000);
      }
    } else {
      if (Notification.permission === 'default') {
        try {
          await Notification.requestPermission();
        } catch {}
      }

      if (Notification.permission === 'denied') {
        setAlertToast({
          title: "⚠️ Уведомления заблокированы",
          body: isIOS 
            ? "Разрешите уведомления: Настройки iPhone ➔ Уведомления ➔ «Транспорт У-У»"
            : "Разрешите уведомления в настройках браузера."
        });
        setTimeout(() => setAlertToast(null), 7000);
      } else if (Notification.permission === 'granted') {
        try {
          const reg = await navigator.serviceWorker.ready;
          if (reg && reg.pushManager) {
            let vapidKey = "";
            try {
              const kRes = await apiFetch('/api/vapid_public_key');
              if (kRes.ok) {
                const kData = await kRes.json();
                if (kData && (kData.publicKey || kData.public_key)) {
                  vapidKey = kData.publicKey || kData.public_key;
                }
              }
            } catch (e) {
              console.warn("Failed to fetch VAPID key:", e);
            }

            if (!vapidKey) {
              console.warn("VAPID key fetch failed — postponing subscribe");
              setAlertToast({
                title: "⚠️ Сервис уведомлений недоступен",
                body: "Не удалось получить ключ сервера. Попробуйте позже."
              });
              setTimeout(() => setAlertToast(null), 5000);
              return;
            }

            const padding = '='.repeat((4 - (vapidKey.length % 4)) % 4);
            const base64 = (vapidKey + padding).replace(/-/g, '+').replace(/_/g, '/');
            const rawData = window.atob(base64);
            const outputArray = new Uint8Array(rawData.length);
            for (let i = 0; i < rawData.length; ++i) {
              outputArray[i] = rawData.charCodeAt(i);
            }

            let existingSub = await reg.pushManager.getSubscription();
            if (existingSub) {
              const currentKey = existingSub.options && existingSub.options.applicationServerKey;
              let isMatch = false;
              if (currentKey) {
                const existingArr = new Uint8Array(currentKey);
                if (existingArr.length === outputArray.length) {
                  isMatch = existingArr.every((byte, idx) => byte === outputArray[idx]);
                }
              }
              if (!isMatch) {
                await existingSub.unsubscribe().catch(() => {});
                existingSub = null;
              }
            }

            if (!existingSub) {
              pushSub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: outputArray
              });
            } else {
              pushSub = existingSub;
            }

          }
        } catch (subErr) {
          console.warn("Push subscription failed:", subErr);
        }
      }
    }

    const initialNum = parseInt(initialTime, 10);
    const newRem = {
      id: remId,
      sid: String(sid),
      stationName: String(stationName),
      rid: String(rid),
      rnum: String(rnum),
      vehid: String(vehid || ""),
      gosNum: String(gosNum || ""),
      createdAt: Date.now(),
      initialTime: !isNaN(initialNum) ? initialNum : 10,
      currentTime: !isNaN(initialNum) ? initialNum : 10,
      triggered: false,
      lastTime: initialTime || "",
      lastNotifiedTime: !isNaN(initialNum) ? initialNum : null
    };
    setReminders(prev => [
      ...prev.filter(r => r.id !== remId && (!cleanPlate || !r.gosNum || formatGosNum(r.gosNum).toLowerCase() !== cleanPlate) && (!vehid || !r.vehid || String(r.vehid) !== String(vehid))),
      newRem
    ]);

    // Ensure reminded vehicle is placed cleanly into vehicleHistory without duplicate cards
    // Use the real vehicle ID from live telemetry if available
    const targetVehId = vehid || (liveMatch ? String(liveMatch.id) : null);
    const targetPlate = gosNum || (liveMatch ? liveMatch.gosNum : "");
    const historyEntry = {
      id: targetVehId || `rem_${sid}_${rid}_${rnum}`,
      route: rnum,
      gosNum: targetPlate,
      type: vehType || (liveMatch ? liveMatch.type : "bus"),
      rid: rid,
      timestamp: Date.now()
    };
    setVehicleHistory(prev => {
      const existingList = Array.isArray(prev) ? prev : [];
      const existing = existingList.find(v => isSameVehicleHistoryEntry(v, historyEntry));
      if (existing) {
        if (!historyEntry.nextStation && existing.nextStation) historyEntry.nextStation = existing.nextStation;
        if (historyEntry.progress == null && existing.progress != null) historyEntry.progress = existing.progress;
      }
      const filtered = existingList.filter(v => !isSameVehicleHistoryEntry(v, historyEntry));
      const updated = [historyEntry, ...filtered].slice(0, 9);
      try { localStorage.setItem("pref_vehicleHistory", JSON.stringify(updated)); } catch {}
      return updated;
    });

    // Register with server to wake device when locked/asleep
    if (pushSub) {
      apiFetch('/api/reminders/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: pushSub.toJSON(),
          sid: String(sid),
          stationName: String(stationName),
          rid: String(rid),
          rnum: String(rnum),
          vehid: String(vehid || ""),
          gosNum: String(gosNum || ""),
          initialTime: String(initialTime || "")
        })
      }).catch((e) => console.warn("Server push subscribe error:", e));
    }

    initAudioOnUserGesture();
    const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

    if (isIOS && !isStandalone) {
      setAlertToast({
        title: `🔔 Напоминание включено!`,
        body: `💡 На iPhone для показа на заблокированном экране добавьте на экран «Домой» (Поделиться ➔ На экран «Домой»).`
      });
      setTimeout(() => setAlertToast(null), 6000);
    } else {
      setAlertToast({
        title: `🔔 Напоминание установлено!`,
        body: `Оповестим даже при заблокированном экране!`
      });
      setTimeout(() => setAlertToast(null), 4000);
    }
    return true;
  };

  useEffect(() => {
    window.toggleArrivalReminder = toggleArrivalReminder;
    window.isArrivalReminderActive = (sid, rid, vehid = "") => {
      const cleanSid = String(sid || "");
      const cleanRid = String(rid || "");
      const cleanVehid = String(vehid || "");
      return remindersRef.current.some(r => {
        if (r.triggered) return false;
        // Must match the specific station (sid)
        if (String(r.sid) !== cleanSid) return false;

        // If specific vehicle ID is known, match vehicle ID
        if (cleanVehid || r.vehid) {
          return Boolean(cleanVehid && r.vehid && String(r.vehid) === cleanVehid);
        }
        // Fallback for route-level reminder without vehicle ID
        if (cleanRid && r.rid) {
          return String(r.rid) === cleanRid;
        }
        return r.id === `${cleanSid}_${cleanRid}`;
      });
    };
    return () => {
      delete window.toggleArrivalReminder;
      delete window.isArrivalReminderActive;
    };
  }, []);

  // Background arrival checker for active reminders
  useEffect(() => {
    if (reminders.length === 0) return;

    const checkReminders = async () => {
      const activeList = remindersRef.current.filter(r => !r.triggered);
      if (activeList.length === 0) return;

      const sids = Array.from(new Set(activeList.map(r => r.sid)));
      await Promise.all(sids.map(async (sid) => {
        try {
          const res = await apiFetch(`/api/station_forecasts?sid=${encodeURIComponent(sid)}`);
          if (!res.ok) return;
          const data = await res.json();
          const forecasts = data.forecasts || [];

          activeList.filter(r => r.sid === sid).forEach(rem => {
            let match = null;
            if (rem.vehid) {
              match = forecasts.find(f => String(f.vehid) === String(rem.vehid));
            }
            if (!match && rem.gosNum) {
              const cleanG = formatGosNum(rem.gosNum).toLowerCase();
              match = forecasts.find(f => f.gosNum && formatGosNum(f.gosNum).toLowerCase() === cleanG);
            }
            // Hard link strictly to current vehicle only: NEVER re-lock or switch to the next bus
            if (!rem.vehid && !rem.gosNum && !match) {
              const candidates = forecasts.filter(f => String(f.rid) === String(rem.rid));
              if (candidates.length) {
                match = candidates.reduce((min, c) => (parseInt(c.time || c.arrt, 10) < parseInt(min.time || min.arrt, 10) ? c : min), candidates[0]);
                rem.vehid = String(match.vehid || match.obj_id || "");
                rem.gosNum = String(match.gosNum || match.gos_num || "");
              }
            }
            if (match && match.gosNum && !rem.gosNum) {
              rem.gosNum = match.gosNum;
            }

            const now = Date.now();
            const elapsedMin = (now - (rem.createdAt || now)) / 60000;
            const initMin = parseInt(rem.initialTime, 10) || 0;

            if (!match) {
              if (!rem.disappearedAt) {
                rem.disappearedAt = now;
              } else if (now - rem.disappearedAt >= 180000) {
                // Bus missing from forecast for >= 180 seconds -> delete notification cleanly
                setReminders(prev => prev.filter(r => r.id !== rem.id));
                cancelArrivalReminder(rem.id, rem.rnum);
              }
              return;
            }

            // Bus reappeared within 180s -> reset disappearedAt
            if (rem.disappearedAt) {
              rem.disappearedAt = null;
            }

            const timeNum = parseInt(match.time, 10);
            const timeStr = String(match.time).toLowerCase();
            const curTime = !isNaN(timeNum) ? timeNum : (timeStr.includes("прибыв") ? 0 : null);

            if (curTime == null) {
              if (elapsedMin > initMin + 5) {
                setReminders(prev => prev.filter(r => r.id !== rem.id));
              }
              return;
            }

            rem.lastTime = match.time;
            const last = rem.lastNotifiedTime;

            // If the bus reached the stop (<= 1 min) and forecast time suddenly jumps by >= 3 min,
            // the tracked bus departed and upstream is now showing the NEXT vehicle behind it.
            // Clean up silently without playing delayed audio.
            if (last != null && last <= 1 && curTime >= 3) {
              setReminders(prev => prev.filter(r => r.id !== rem.id));
              cancelArrivalReminder(rem.id, rem.rnum);
              return;
            }

            let shouldFire = false;

            if (curTime <= 0 || timeStr.includes("прибыв")) {
              shouldFire = true;
            } else if (last == null) {
              rem.lastNotifiedTime = curTime;
            } else if (curTime > last) {
              rem.lastNotifiedTime = curTime;
            } else if (last >= 10 && curTime >= 10) {
              if (curTime <= last - 5) {
                shouldFire = true;
              }
            } else if (last >= 10 && curTime < 10) {
              if (curTime <= last - 5 || curTime <= 9) {
                shouldFire = true;
              }
            } else if (curTime < 10) {
              if (curTime <= last - 1) {
                shouldFire = true;
              }
            }

            if (shouldFire) {
              rem.lastNotifiedTime = curTime;

              if (curTime <= 0 || timeStr.includes("прибыв")) {
                // Final arrival push & reset memory
                triggerArrivalPush(
                  `🚌 Маршрут ${rem.rnum} прибыл!`,
                  `Остановка «${rem.stationName}»`,
                  `arrival_${rem.sid}_${rem.rid}`,
                  true
                );
                setAlertToast({
                  title: `🚌 Маршрут ${rem.rnum} прибыл!`,
                  body: `Остановка «${rem.stationName}»`
                });
                setTimeout(() => setAlertToast(null), 8000);

                // Reset / remove from active reminders memory
                setReminders(prev => prev.filter(r => r.id !== rem.id));
              } else {
                // Step countdown push
                triggerArrivalPush(
                  `🚌 Маршрут ${rem.rnum} — ${curTime} мин`,
                  `Остановка «${rem.stationName}» (прибытие через ~${curTime} мин)`,
                  `arrival_${rem.sid}_${rem.rid}`,
                  false
                );
                  setAlertToast({
                    title: `🚌 Маршрут ${rem.rnum} — ${curTime} мин`,
                    body: `Остановка «${rem.stationName}»`
                  });
                  setTimeout(() => setAlertToast(null), 4000);

                  // Update memory with latest notified timestamp
                  setReminders(prev => prev.map(r => r.id === rem.id ? { ...r, lastTime: match.time, lastNotifiedTime: curTime, gosNum: rem.gosNum } : r));
                }
              }
          });
        } catch (err) {
          console.warn("Failed to check station forecast reminder:", err);
        }
      }));
    };

    const timer = setInterval(checkReminders, 7000);
    checkReminders();
    return () => clearInterval(timer);
  }, [reminders.length]);

  // Calculate percentage of vehicle progress along route strictly by bus stops passed vs remaining (excluding coords)
  const routeProgressPercent = useMemo(() => {
    if (!selectedVehicle) return 0;

    // Terminal / Waiting at end of route -> 100%
    if (nextStationInfo?.isTerminal) {
      return 100;
    }

    const totalStops = routeStationsOrder.length;
    if (totalStops <= 1) {
      return 0;
    }

    // 1. Calculate from index of next station along the ordered route stops list
    if (nextStationInfo?.stid) {
      const nextIdx = routeStationsOrder.indexOf(String(nextStationInfo.stid));
      if (nextIdx !== -1) {
        return Math.min(100, Math.max(0, Math.round((nextIdx / (totalStops - 1)) * 100)));
      }
    }

    // 2. Fallback: calculate from remaining stops count in live forecast
    if (typeof nextStationInfo?.remainingCount === "number" && nextStationInfo.remainingCount > 0) {
      const passedStops = Math.max(0, totalStops - nextStationInfo.remainingCount);
      return Math.min(100, Math.max(0, Math.round((passedStops / (totalStops - 1)) * 100)));
    }

    return 0;
  }, [selectedVehicle, routeStationsOrder, nextStationInfo]);

  // MapLibre & Marker / Animation Refs
  const markersRef = useRef({});
  const vehicleMarkersRef = useRef({});
  const activeAnimationsRef = useRef({});
  const globalAnimationId = useRef(null);
  const debouncedUpdateRef = useRef(null);
  const forecastMarkersRef = useRef([]);
  const fetchVehiclesTimeoutRef = useRef(null);

  // Drawer Touch Gestures
  const drawerRef = useRef(null);
  const touchStartY = useRef(0);

  useEffect(() => {
    routesRef.current = routes;
  }, [routes]);

  useEffect(() => {
    stationsRef.current = stations;
    if (stations && stations.length > 0 && selectedVehicleRef.current && debouncedForecastRefreshRef.current) {
      debouncedForecastRefreshRef.current();
    }
  }, [stations]);

  useEffect(() => {
    favoritesRef.current = favorites;
  }, [favorites]);

  const vehicleHistoryRef = useRef(vehicleHistory);
  useEffect(() => {
    vehicleHistoryRef.current = vehicleHistory;
  }, [vehicleHistory]);

  useEffect(() => {
    filtersRef.current = { bus: showBus, tram: showTram };
    localStorage.setItem("pref_showBus", showBus);
    localStorage.setItem("pref_showTram", showTram);
    setStopLimit(60);
  }, [showBus, showTram]);

  useEffect(() => {
    localStorage.setItem("pref_selectedRoutes", JSON.stringify(Array.from(selectedRoutes)));
  }, [selectedRoutes]);

  useEffect(() => {
    isFollowingVehicleRef.current = isFollowingVehicle;
    wasFollowingBeforeHiddenRef.current = isFollowingVehicle;
    try {
      localStorage.setItem("pref_isFollowingVehicle", isFollowingVehicle);
    } catch { }
  }, [isFollowingVehicle]);

  // Online / Offline Connectivity Monitor
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Screen Wake Lock API (keeps display awake while following an approaching vehicle)
  useEffect(() => {
    if (!('wakeLock' in navigator)) return;
    let isSubscribed = true;

    const requestLock = async () => {
      if (selectedVehicle && isFollowingVehicle && document.visibilityState === 'visible' && isSubscribed) {
        try {
          if (!wakeLockRef.current) {
            const lock = await navigator.wakeLock.request('screen');
            if (!isSubscribed) {
              await lock.release();
              return;
            }
            wakeLockRef.current = lock;
            wakeLockRef.current.addEventListener('release', () => {
              wakeLockRef.current = null;
            });
          }
        } catch (err) {
          // Non-blocking fallback
        }
      }
    };

    const releaseLock = async () => {
      if (wakeLockRef.current) {
        try {
          await wakeLockRef.current.release();
        } catch { }
        wakeLockRef.current = null;
      }
    };

    if (selectedVehicle && isFollowingVehicle) {
      requestLock();
    } else {
      releaseLock();
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && selectedVehicle && isFollowingVehicle && isSubscribed) {
        requestLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      isSubscribed = false;
      document.removeEventListener('visibilitychange', handleVisibility);
      releaseLock();
    };
  }, [selectedVehicle?.id, isFollowingVehicle]);

  const addToVehicleHistory = useCallback((veh, nextSt = null) => {
    if (!veh || !veh.id) return;
    setVehicleHistory(prev => {
      const list = Array.isArray(prev) ? prev : [];
      const normalizedType = normalizeVehicleType(veh.type, veh.route || veh.rnum);
      const newEntry = {
        id: veh.id,
        rid: veh.rid,
        route: veh.route || veh.rnum || "Маршрут",
        gosNum: veh.gosNum || "",
        type: normalizedType,
        lat: veh.lat,
        lng: veh.lng,
        nextStation: nextSt || veh.nextStation || null,
        progress: typeof veh.progress === "number" ? veh.progress : null,
        timestamp: Date.now()
      };

      const existing = list.find(item => isSameVehicleHistoryEntry(item, newEntry));
      if (existing) {
        if (!newEntry.nextStation && existing.nextStation) newEntry.nextStation = existing.nextStation;
        if (newEntry.progress == null && existing.progress != null) newEntry.progress = existing.progress;
      }

      const filtered = list.filter(item => !isSameVehicleHistoryEntry(item, newEntry));
      const updated = [newEntry, ...filtered].slice(0, 9);
      try {
        localStorage.setItem("pref_vehicleHistory", JSON.stringify(updated));
      } catch { }
      return updated;
    });
  }, []);

  const clearVehicleHistory = () => {
    setVehicleHistory([]);
    try {
      localStorage.removeItem("pref_vehicleHistory");
    } catch { }
  };

  useEffect(() => {
    if (selectedVehicle?.id && typeof routeProgressPercent === "number") {
      setVehicleHistory(prev => {
        const list = Array.isArray(prev) ? prev : [];
        let changed = false;
        const updated = list.map(item => {
          if (item && item.id === selectedVehicle.id && item.progress !== routeProgressPercent) {
            changed = true;
            return { ...item, progress: routeProgressPercent };
          }
          return item;
        });
        if (changed) {
          try {
            localStorage.setItem("pref_vehicleHistory", JSON.stringify(updated));
          } catch { }
          return updated;
        }
        return prev;
      });
    }
  }, [selectedVehicle?.id, routeProgressPercent]);

  // Helper to extract all possible subroute IDs for a vehicle/history item
  const resolveRidsForItem = useCallback((item, liveVeh) => {
    if (!item) return [];
    const rids = new Set();
    if (item.rid) String(item.rid).split(",").forEach(id => { if (id.trim()) rids.add(id.trim()); });
    if (liveVeh?.rid) String(liveVeh.rid).split(",").forEach(id => { if (id.trim()) rids.add(id.trim()); });
    
    if (routesRef.current && routesRef.current.length > 0) {
      const vNum = String(item.route || item.rnum || "").trim().toLowerCase();
      const vType = normalizeVehicleType(item.type, item.route);
      const rMatch = routesRef.current.find(r => 
        String(r.number).trim().toLowerCase() === vNum &&
        normalizeVehicleType(r.type, r.number) === vType
      );
      if (rMatch) {
        if (rMatch.id) String(rMatch.id).split(",").forEach(id => { if (id.trim()) rids.add(id.trim()); });
        if (Array.isArray(rMatch.subroutes)) {
          rMatch.subroutes.forEach(sr => {
            if (sr.id) String(sr.id).split(",").forEach(id => { if (id.trim()) rids.add(id.trim()); });
          });
        }
      }
    }
    return Array.from(rids);
  }, []);

  // Fetch and cache route stations for history items to compute stops passed vs remaining
  useEffect(() => {
    if (activeTab === 5 && Array.isArray(vehicleHistory) && vehicleHistory.length > 0) {
      vehicleHistory.forEach(item => {
        if (!item) return;
        const liveVeh = knownVehiclesRef.current[item.id] || item;
        const rids = resolveRidsForItem(item, liveVeh);
        rids.forEach(rid => {
          if (rid && !routeStationsCacheRef.current[rid] && !pendingRouteStationsRef.current.has(rid)) {
            pendingRouteStationsRef.current.add(rid);
            apiFetch(`/api/route_stations?id=${encodeURIComponent(rid)}`)
              .then(res => res.json())
              .then(data => {
                const stations = (data && Array.isArray(data.stations)) ? data.stations.map(String) : [];
                routeStationsCacheRef.current[rid] = stations;
                pendingRouteStationsRef.current.delete(rid);
                if (stations.length > 0) {
                  setHistoryProgressTick(t => t + 1);
                }
              })
              .catch(() => {
                pendingRouteStationsRef.current.delete(rid);
              });
          }
        });
      });
    }
  }, [activeTab, vehicleHistory, resolveRidsForItem]);

  // Real-time live forecast polling for history vehicles when History tab is open
  useEffect(() => {
    if (activeTab !== 5) return;

    let isPollingActive = true;
    let pollTimer = null;

    const pollHistoryForecasts = async () => {
      if (!isPollingActive) return;

      if (document.hidden) {
        if (isPollingActive) pollTimer = setTimeout(pollHistoryForecasts, 15000);
        return;
      }

      const nowTime = Date.now();
      const liveItems = (vehicleHistoryRef.current || []).map(item => {
        if (!item || !item.id) return null;
        if (item.id === selectedVehicleRef.current?.id) return null;
        const itemPlate = formatGosNum(item.gosNum).toLowerCase();
        const itemRoute = String(item.route || '').trim().toLowerCase();

        let live = (item.id && !String(item.id).includes('_') && knownVehiclesRef.current[item.id]) || null;
        if (!live) {
          live = Object.values(knownVehiclesRef.current).find(v => {
            const vRoute = String(v.route || v.rnum || '').trim().toLowerCase();
            if (itemRoute && vRoute && itemRoute !== vRoute) return false;
            if (itemPlate && v.gosNum && formatGosNum(v.gosNum).toLowerCase() === itemPlate) return true;
            if (item.id && !String(item.id).includes('_') && v.id && String(v.id) === String(item.id)) return true;
            return false;
          }) || Object.values(knownVehiclesRef.current).find(v => {
            const vRoute = String(v.route || v.rnum || '').trim().toLowerCase();
            return itemRoute && vRoute && itemRoute === vRoute;
          }) || null;
        }

        const isLive = !!live && (nowTime - (live._lastSeen || 0) < 60000);
        const queryVehId = (live && live.id && !String(live.id).includes('_')) ? live.id : (!String(item.id).includes('_') ? item.id : null);
        if (!queryVehId && !isLive) return null;

        return { item, live, queryVehId };
      }).filter(Boolean);

      if (liveItems.length === 0) {
        if (isPollingActive) pollTimer = setTimeout(pollHistoryForecasts, 10000);
        return;
      }

      const updates = {};
      await Promise.all(
        liveItems.map(async ({ item, live, queryVehId }) => {
          try {
            if (queryVehId) {
              const res = await apiFetch(`/api/vehicle_forecasts?vehid=${encodeURIComponent(queryVehId)}`);
              const data = await res.json();
              if (!isPollingActive) return;

              if (data.forecasts && data.forecasts.length > 0) {
                const unique = [];
                const seen = new Set();
                data.forecasts.forEach(f => {
                  if (!seen.has(f.stid)) {
                    seen.add(f.stid);
                    unique.push(f);
                  }
                });
                unique.sort((a, b) => (parseInt(a.time, 10) || 0) - (parseInt(b.time, 10) || 0));

                if (unique.length > 0) {
                  const nextF = unique[0];
                  const st = stationsByIdRef.current.get(nextF.stid);
                  if (st?.properties?.name) {
                    const u = {
                      nextStation: st.properties.name,
                      stid: String(nextF.stid),
                      isTerminal: false
                    };
                    const rids = resolveRidsForItem(item, live);
                    for (const rid of rids) {
                      const sIds = routeStationsCacheRef.current[rid];
                      if (Array.isArray(sIds) && sIds.length > 1) {
                        const idx = sIds.indexOf(String(nextF.stid));
                        if (idx !== -1) {
                          u.progress = Math.min(100, Math.max(0, Math.round((idx / (sIds.length - 1)) * 100)));
                          break;
                        }
                      }
                    }
                    updates[item.id] = u;
                  }
                }
              } else {
                // Empty forecasts: only mark terminal if vehicle is actually near terminal stop
                if (live && isNearTerminalStopRef.current && isNearTerminalStopRef.current(live)) {
                  updates[item.id] = {
                    nextStation: "Конечная (ожидает)",
                    stid: null,
                    isTerminal: true,
                    progress: 100
                  };
                }
              }
            }
          } catch { }
        })
      );

      if (isPollingActive && Object.keys(updates).length > 0) {
        setVehicleHistory(prev => {
          const list = Array.isArray(prev) ? prev : [];
          let hasChanged = false;
          const updated = list.map(it => {
            if (it && updates[it.id]) {
              const u = updates[it.id];
              if (it.nextStation !== u.nextStation || (u.progress != null && it.progress !== u.progress)) {
                hasChanged = true;
                return { ...it, ...u };
              }
            }
            return it;
          });
          if (hasChanged) {
            try { localStorage.setItem("pref_vehicleHistory", JSON.stringify(updated)); } catch {}
            return updated;
          }
          return prev;
        });
      }

      if (isPollingActive) {
        pollTimer = setTimeout(pollHistoryForecasts, 10000);
      }
    };

    pollHistoryForecasts();

    return () => {
      isPollingActive = false;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps -- Polling lifecycle bound to activeTab, reads vehicleHistoryRef.current inside

  const prevHistorySavedVehicleIdRef = useRef(null);
  useEffect(() => {
    try {
      if (selectedVehicle) {
        const toSave = { ...selectedVehicle, savedAt: selectedVehicle.savedAt || Date.now() };
        localStorage.setItem("pref_selectedVehicle", JSON.stringify(toSave));
        if (selectedVehicle.id !== prevHistorySavedVehicleIdRef.current) {
          prevHistorySavedVehicleIdRef.current = selectedVehicle.id;
          addToVehicleHistory(selectedVehicle);
        }
      } else {
        prevHistorySavedVehicleIdRef.current = null;
        localStorage.removeItem("pref_selectedVehicle");
      }
    } catch { }
    selectedVehicleRef.current = selectedVehicle;
    selectedRouteStationsRef.current = selectedRouteStations;

    // Update existing markers to show/hide the glowing effect
    Object.keys(vehicleMarkersRef.current).forEach(id => {
      const marker = vehicleMarkersRef.current[id];
      const markerDiv = marker?.getElement()?.querySelector(".vehicle-marker");
      if (markerDiv) {
        if (selectedVehicle && selectedVehicle.id === id) {
          markerDiv.classList.add("vehicle-selected");
        } else {
          markerDiv.classList.remove("vehicle-selected");
        }
      }
    });
  }, [selectedVehicle, selectedRouteStations]);

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

  // Precompute normalized stations and route terminal coordinates for instant O(1) matching
  const stationsById = useMemo(() => {
    const map = new Map();
    (stations || []).forEach(st => {
      if (st.properties?.id != null) {
        map.set(String(st.properties.id), st);
        map.set(Number(st.properties.id), st);
      }
    });
    return map;
  }, [stations]);

  const stationsByIdRef = useRef(stationsById);
  useEffect(() => {
    stationsByIdRef.current = stationsById;
  }, [stationsById]);

  const routeTerminalsMap = useMemo(() => {
    const norm = (s) => String(s || "")
      .toLowerCase()
      .replace(/[kamtoerpyxc]/g, c => ({ k: 'к', a: 'а', m: 'м', t: 'т', o: 'о', e: 'е', r: 'р', p: 'р', y: 'у', x: 'х', c: 'с' }[c] || c))
      .replace(/[^a-zа-я0-9]/g, '');

    // Pre-map normalized station names to coordinates
    const stationCoordsByName = new Map();
    (stations || []).forEach(st => {
      const name = norm(st.properties?.name);
      const coords = st.geometry?.coordinates;
      if (name && coords) {
        if (!stationCoordsByName.has(name)) stationCoordsByName.set(name, []);
        stationCoordsByName.get(name).push({ lat: coords[1], lng: coords[0] });
      }
    });

    const map = new Map();

    (routes || []).forEach(r => {
      // Map specific subroute endpoints to subroute IDs
      if (Array.isArray(r.subroutes)) {
        r.subroutes.forEach(sr => {
          if (sr.id) {
            const srTermNames = [];
            if (sr.from_station) srTermNames.push(norm(sr.from_station));
            if (sr.to_station) srTermNames.push(norm(sr.to_station));
            const srCoords = [];
            srTermNames.forEach(tName => {
              const found = stationCoordsByName.get(tName);
              if (found) srCoords.push(...found);
            });
            if (srCoords.length > 0) {
              map.set(String(sr.id).trim(), srCoords);
            }
          }
        });
      }

      // Map main route endpoints to route IDs and route number fallback
      const termNames = [];
      if (r.from_station) termNames.push(norm(r.from_station));
      if (r.to_station) termNames.push(norm(r.to_station));
      const coordsList = [];
      termNames.forEach(tName => {
        const found = stationCoordsByName.get(tName);
        if (found) coordsList.push(...found);
      });

      if (coordsList.length > 0) {
        if (r.id) {
          String(r.id).split(',').forEach(id => {
            const key = String(id).trim();
            if (!map.has(key)) map.set(key, coordsList);
          });
        }
        if (r.number && !map.has(norm(r.number))) {
          map.set(norm(r.number), coordsList);
        }
      }
    });

    return map;
  }, [routes, stations]);

  const routeTerminalsMapRef = useRef(routeTerminalsMap);
  useEffect(() => {
    routeTerminalsMapRef.current = routeTerminalsMap;
  }, [routeTerminalsMap]);

  // Metric geometry check: 100m threshold
  const TERMINAL_MAX_DIST_SQ_M = 100 * 100; // 10,000 m^2 (100 meters)
  const METERS_PER_DEG_LAT = 111320;
  const METERS_PER_DEG_LNG = 68840; // 111320 * cos(51.8°) for Ulan-Ude

  const isNearTerminalStop = useCallback((veh) => {
    if (!veh || !veh.lat || !veh.lng) return false;
    const termMap = routeTerminalsMapRef.current;
    if (!termMap) return false;

    const norm = (s) => String(s || "")
      .toLowerCase()
      .replace(/[kamtoerpyxc]/g, c => ({ k: 'к', a: 'а', m: 'м', t: 'т', o: 'о', e: 'е', r: 'р', p: 'р', y: 'у', x: 'х', c: 'с' }[c] || c))
      .replace(/[^a-zа-я0-9]/g, '');

    const coordsList = termMap.get(String(veh.rid)) || termMap.get(norm(veh.route || veh.rnum));
    if (!coordsList || coordsList.length === 0) return false;

    for (let i = 0; i < coordsList.length; i++) {
      const pt = coordsList[i];
      const dy = (veh.lat - pt.lat) * METERS_PER_DEG_LAT;
      const dx = (veh.lng - pt.lng) * METERS_PER_DEG_LNG;
      const distSqMeters = dy * dy + dx * dx;
      if (distSqMeters <= TERMINAL_MAX_DIST_SQ_M) return true;
    }
    return false;
  }, []);


  const filteredStations = useMemo(() => {
    return (stations || []).filter(st => {
      const p = st.properties;
      if (p.type === "bus" && !showBus) return false;
      if (p.type === "tram" && !showTram) return false;
      return true;
    });
  }, [stations, showBus, showTram]);

  const getActiveReminderForVehicle = useCallback((item, live = null) => {
    if (!item || !Array.isArray(reminders) || reminders.length === 0) return null;
    const activeRems = reminders.filter(r => !r.triggered);
    if (activeRems.length === 0) return null;

    const vId = String(item.id || (live && live.id) || "").trim();
    const vPlate = formatGosNum(item.gosNum || (live && live.gosNum) || "").toLowerCase().trim();
    const vRoute = String(item.route || (live && (live.route || live.rnum)) || "").trim().toLowerCase();

    return activeRems.find(r => {
      // 1. Exact Reminder ID match
      if (item.id && (item.id === r.id || item.id === `rem_${r.sid}_${r.rid}_${r.rnum}`)) return true;
      // 2. Exact Vehicle ID match
      if (r.vehid && vId && String(r.vehid).trim() === vId) return true;
      // 3. Exact License Plate / Board Number match
      if (r.gosNum && vPlate && formatGosNum(r.gosNum).toLowerCase().trim() === vPlate) return true;
      // 4. Match by route number if route matches
      if (r.rnum && vRoute && String(r.rnum).trim().toLowerCase() === vRoute) return true;
      return false;
    }) || null;
  }, [reminders]);

  const sortedVehicleHistory = useMemo(() => {
    if (!Array.isArray(vehicleHistory) || vehicleHistory.length === 0) return [];
    
    // Strict deduplication pass: merge duplicates by ID, license plate, and route
    const deduped = [];
    for (const raw of vehicleHistory) {
      if (!raw || !raw.id) continue;
      const existingIdx = deduped.findIndex(d => isSameVehicleHistoryEntry(d, raw));
      if (existingIdx === -1) {
        deduped.push(raw);
      } else {
        const existing = deduped[existingIdx];
        const isRawRealId = raw.id && !String(raw.id).startsWith('rem_');
        deduped[existingIdx] = {
          ...existing,
          ...raw,
          id: isRawRealId ? raw.id : existing.id,
          gosNum: raw.gosNum || existing.gosNum,
          nextStation: raw.nextStation || existing.nextStation,
          progress: raw.progress ?? existing.progress,
          timestamp: Math.max(raw.timestamp || 0, existing.timestamp || 0)
        };
      }
    }

    const nowTime = Date.now();
    const decorated = deduped.map(item => {
      const itemPlate = formatGosNum(item.gosNum).toLowerCase();
      const itemRoute = String(item.route || '').trim().toLowerCase();
      const live = (() => {
        if (item.id && !String(item.id).includes('_') && knownVehiclesRef.current[item.id]) {
          const directVeh = knownVehiclesRef.current[item.id];
          const dRoute = String(directVeh.route || directVeh.rnum || '').trim().toLowerCase();
          if (!itemRoute || dRoute === itemRoute) {
            return directVeh;
          }
        }
        return Object.values(knownVehiclesRef.current).find(v => {
          const vRoute = String(v.route || v.rnum || '').trim().toLowerCase();
          if (itemRoute && vRoute && itemRoute !== vRoute) return false;
          if (itemPlate && v.gosNum && formatGosNum(v.gosNum).toLowerCase() === itemPlate) return true;
          if (item.id && !String(item.id).includes('_') && v.id && String(v.id) === String(item.id)) return true;
          return false;
        }) || (() => {
          if (!itemRoute && !item.rid) return null;
          const candidates = Object.values(knownVehiclesRef.current).filter(v => {
            const vRoute = String(v.route || v.rnum || '').trim().toLowerCase();
            if (itemRoute && vRoute && itemRoute === vRoute) return true;
            if (item.rid && v.rid && String(item.rid) === String(v.rid)) return true;
            return false;
          });
          return candidates.length > 0 ? candidates[0] : null;
        })();
      })();
      const activeRem = getActiveReminderForVehicle(item, live);
      const isLive = !!live && (nowTime - (live._lastSeen || 0) < 60000);
      return { item, hasNotify: !!activeRem, isLive };
    });

    decorated.sort((a, b) => {
      // 1. Notified vehicles ALWAYS primary at the top
      if (a.hasNotify !== b.hasNotify) {
        return a.hasNotify ? -1 : 1;
      }
      // 2. Live vehicles next
      if (a.isLive !== b.isLive) {
        return a.isLive ? -1 : 1;
      }
      // 3. Most recent timestamp
      return (b.item.timestamp || 0) - (a.item.timestamp || 0);
    });

    return decorated.map(d => d.item);
  }, [vehicleHistory, reminders, telemetryTick, activeTab, getActiveReminderForVehicle]);

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

  // Fetch stations & routes & preload initial vehicle telemetry during splash screen
  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [stRes, rtRes] = await Promise.all([
        apiFetch("/api/stations"),
        apiFetch("/api/routes")
      ]);
      if (!stRes.ok) throw new Error(`Stations API error: HTTP ${stRes.status}`);
      if (!rtRes.ok) throw new Error(`Routes API error: HTTP ${rtRes.status}`);

      const stData = await stRes.json();
      const rtData = await rtRes.json();

      const features = (stData.features || []).map(f => {
        f._searchName = (f.properties?.name || "").toLowerCase().trim();
        return f;
      });
      const fetchedRoutes = rtData.routes || [];
      window._globalRoutes = fetchedRoutes;
      setStations(features);
      setRoutes(fetchedRoutes);

      let initialSelected = new Set();
      const saved = localStorage.getItem("pref_selectedRoutes");
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) initialSelected = new Set(parsed);
        } catch { }
      }
      if (initialSelected.size === 0) {
        initialSelected = new Set(fetchedRoutes.map(r => r.id));
      }
      setSelectedRoutes(initialSelected);

      // Preload initial vehicles during splash screen so map is immediately populated with live buses
      const initialRids = [];
      initialSelected.forEach(r => {
        String(r).split(",").forEach(id => {
          if (id.trim()) initialRids.push(id.trim());
        });
      });

      if (initialRids.length > 0) {
        try {
          const vRes = await apiFetch(`/api/vehicles?rids=${initialRids.join(",")}&curk=0`);
          if (vRes.ok) {
            const vData = await vRes.json();
            if (vData && vData.vehicles) {
              const nowTime = Date.now();
              vData.vehicles.forEach(v => {
                knownVehiclesRef.current[v.id] = { ...v, _lastSeen: nowTime };
              });
            }
          }
        } catch {
          // Non-blocking fallback: poller continues in background
        }
      }

      setLoading(false);
      setTimeout(() => {
        setIsSplashFading(true);
        setTimeout(() => setIsSplashMounted(false), 780);
      }, 500);
    } catch (err) {
      console.error("Failed to load transit data:", err);
      setError("Не удалось загрузить данные. Проверьте, запущен ли FastAPI backend (main.py).");
      setLoading(false);
      setIsSplashFading(true);
      setTimeout(() => setIsSplashMounted(false), 780);
    }
  };

  useEffect(() => {
    fetchData();
    // Safety guard: guarantee splash screen fades out smoothly within 3.5 seconds
    const splashTimer = setTimeout(() => {
      setIsSplashFading(true);
      setTimeout(() => setIsSplashMounted(false), 780);
    }, 3500);
    return () => clearTimeout(splashTimer);
  }, []);

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
      if (debouncedUpdateRef.current) debouncedUpdateRef.current();
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
      if (debouncedUpdateRef.current) debouncedUpdateRef.current();
    }
  };

  const shortestAngleDiff = (targetAngle, currentAngle) => {
    let t = targetAngle - currentAngle;
    while (t > 180) t -= 360;
    while (t < -180) t += 360;
    return t;
  };

  const getNextStopBearing = (veh, curLat, curLng) => {
    if (!veh) return null;
    const lat = curLat != null ? curLat : veh.lat;
    const lng = curLng != null ? curLng : veh.lng;
    if (lat == null || lng == null) return null;

    // 1. First priority: forward waypoints along the road graph
    if (veh.animPoints && veh.animPoints.length > 0) {
      for (let i = 0; i < veh.animPoints.length; i++) {
        const pt = veh.animPoints[i];
        const dLat = pt.lat - lat;
        const dLng = pt.lng - lng;
        if (dLat * dLat + dLng * dLng > 1e-10) {
          return ((Math.atan2(dLng, dLat) * 57.29577951308232) % 360 + 360) % 360;
        }
      }
    }

    // 2. Next Stop Prediction: strictly follow route station sequence order (S_k -> S_{k+1})
    const rids = veh.rid ? String(veh.rid).split(",") : [];
    for (const rawRid of rids) {
      const rid = rawRid.trim();
      const sIds = routeStationsCacheRef.current?.[rid];
      if (Array.isArray(sIds) && sIds.length > 1 && stationsByIdRef.current) {
        let closestIdx = -1;
        let closestDist = Infinity;
        for (let i = 0; i < sIds.length; i++) {
          const sid = sIds[i];
          const st = stationsByIdRef.current.get(String(sid)) || stationsByIdRef.current.get(Number(sid));
          if (st?.geometry?.coordinates) {
            const [sLng, sLat] = st.geometry.coordinates;
            const distSq = (sLat - lat) ** 2 + (sLng - lng) ** 2;
            if (distSq < closestDist) {
              closestDist = distSq;
              closestIdx = i;
            }
          }
        }

        if (closestIdx !== -1) {
          // Always target the upcoming stop S_{k+1} in the forward direction of travel
          const nextIdx = closestIdx < sIds.length - 1 ? closestIdx + 1 : closestIdx;
          const prevIdx = nextIdx > 0 ? nextIdx - 1 : 0;
          const nextSt = stationsByIdRef.current.get(String(sIds[nextIdx])) || stationsByIdRef.current.get(Number(sIds[nextIdx]));
          const prevSt = stationsByIdRef.current.get(String(sIds[prevIdx])) || stationsByIdRef.current.get(Number(sIds[prevIdx]));

          if (nextSt?.geometry?.coordinates) {
            const [nLng, nLat] = nextSt.geometry.coordinates;
            let dLat = nLat - lat;
            let dLng = nLng - lng;
            if (dLat * dLat + dLng * dLng < 1e-10 && prevSt?.geometry?.coordinates) {
              const [pLng, pLat] = prevSt.geometry.coordinates;
              dLat = nLat - pLat;
              dLng = nLng - pLng;
            }
            if (dLat * dLat + dLng * dLng > 1e-11) {
              return ((Math.atan2(dLng, dLat) * 57.29577951308232) % 360 + 360) % 360;
            }
          }
        }
      }
    }

    if (veh.dir != null && Number.isFinite(veh.dir) && veh.dir > 0) {
      return veh.dir;
    }

    return null;
  };

  const startGlobalAnimation = () => {
    if (globalAnimationId.current) return;

    let lastTime = performance.now();

    const animate = (timestamp) => {
      if (!map.current) {
        globalAnimationId.current = null;
        return;
      }

      const rawDt = timestamp - lastTime;
      const dt = Math.min(Math.max(rawDt, 0), 200);
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

      for (const id in anims) {
        const t = anims[id];
        const hasPoints = (t.timeRemaining > 0) || (t.animationPoints && t.animationPoints.length > 0);
        const isCoasting = !hasPoints && (t.coastTime < 3500) && (Math.abs(t.velocityLat || 0) > 1e-9 || Math.abs(t.velocityLng || 0) > 1e-9);

        if (hasPoints || isCoasting) {
          hasActive = true;
          t.idle = false;
        } else {
          t.idle = true;
          continue; // Skip integration for idle vehicles
        }

        // Sub-frame time integration
        let dtLeft = dt;
        while (dtLeft > 0) {
          if (t.timeRemaining > 0) {
            t.coastTime = 0;
            const step = Math.min(dtLeft, t.timeRemaining);
            t.currentLat += t.velocityLat * step;
            t.currentLng += t.velocityLng * step;
            t.timeRemaining -= step;

            if (t.directionTimeRemaining > 0) {
              const dirStep = Math.min(dtLeft, t.directionTimeRemaining);
              t.currentDirection = ((t.currentDirection + t.velocityDirection * dirStep) % 360 + 360) % 360;
              t.directionTimeRemaining -= dirStep;
            }

            dtLeft -= step;
          } else if (t.animationPoints && t.animationPoints.length > 0) {
            t.coastTime = 0;
            const a = t.animationPoints.shift();

            // 10s baseline aligned with server polling interval; dynamic catch-up when queue accumulates
            const queueLen = t.animationPoints.length;
            const catchUpFactor = queueLen > 1 ? Math.min(2.5, 1.0 + (queueLen - 1) * 0.35) : 1.0;
            const rawPercent = a.percent || 0;
            const percent = rawPercent > 0 ? rawPercent : (100 / Math.max(1, queueLen + 1));
            const baseMs = Math.max((10000 * percent) / 100, 50);
            const rMs = Math.max(baseMs / catchUpFactor, 50);
            // Snappy turn alignment matching official bus62 o parameter (completes turn in ~400-800ms)
            const oMs = Math.min(rMs, Math.max(350, Math.min(800, rMs * 0.2)));

            t.velocityLat = (a.lat - t.currentLat) / rMs;
            t.velocityLng = (a.lng - t.currentLng) / rMs;

            // Calculate exact forward road azimuth
            const dLat = a.lat - t.currentLat;
            const dLng = a.lng - t.currentLng;
            let targetAngle = t.currentDirection;

            if (dLat * dLat + dLng * dLng > 1e-11) {
              const computedAngle = ((Math.atan2(dLng, dLat) * 57.29577951308232) % 360 + 360) % 360;
              targetAngle = computedAngle;
            } else if (a.dir != null && Number.isFinite(a.dir) && a.dir > 0) {
              targetAngle = a.dir;
            } else {
              // Fallback to next stop bearing prediction along route vector path
              const nextBearing = getNextStopBearing(t.veh || knownVehiclesRef.current[id], t.currentLat, t.currentLng);
              if (nextBearing != null) targetAngle = nextBearing;
            }

            t.velocityDirection = shortestAngleDiff(targetAngle, t.currentDirection) / oMs;
            t.timeRemaining = rMs;
            t.directionTimeRemaining = oMs;
          } else if (isCoasting && dtLeft > 0) {
            // Smooth coasting buffer between 10s poll cycles to prevent freeze
            const coastDamping = Math.max(0, 1 - (t.coastTime / 3500));
            t.currentLat += (t.velocityLat || 0) * coastDamping * dtLeft;
            t.currentLng += (t.velocityLng || 0) * coastDamping * dtLeft;
            t.coastTime = (t.coastTime || 0) + dtLeft;
            dtLeft = 0;
          } else {
            break;
          }
        }
      }

      // Viewport culling with 20% padding matching Leaflet pad(.2)
      const bounds = map.current.getBounds();
      const padLat = (bounds.getNorth() - bounds.getSouth()) * 0.2;
      const padLng = (bounds.getEast() - bounds.getWest()) * 0.2;
      const west = bounds.getWest() - padLng;
      const east = bounds.getEast() + padLng;
      const south = bounds.getSouth() - padLat;
      const north = bounds.getNorth() + padLat;

      // APPLY RENDERS
      const mapBearing = map.current ? map.current.getBearing() : 0;
      for (const id in anims) {
        const t = anims[id];
        const isSelected = selectedVehicleRef.current?.id === id;
        if (t.idle && !t._forceRender && !isSelected) continue;
        t._forceRender = false;

        const inView = (t.currentLng >= west && t.currentLng <= east && t.currentLat >= south && t.currentLat <= north);
        if (inView || isSelected) {
          t.marker.setLngLat([t.currentLng, t.currentLat]);

          // Adjust visual rotation by subtracting map bearing so arrows point strictly in real physical road direction
          const visualAngle = ((t.currentDirection - mapBearing) % 360 + 360) % 360;
          if (t.marker._lastRot === undefined || Math.abs(t.marker._lastRot - visualAngle) > 0.01) {
            const rot = visualAngle.toFixed(2);
            if (t.mDiv) {
              t.mDiv.style.transform = `rotate(${rot}deg)`;
            }
            if (t.tSpan) {
              t.tSpan.style.transform = `rotate(${-rot}deg)`;
            }
            t.marker._lastRot = visualAngle;
            t.marker._currentRot = t.currentDirection;
          }
        }
      }

      // Smooth Camera Tracking for Selected Vehicle
      if (selectedVehicleRef.current && isFollowingVehicleRef.current && !isInitialFlyingRef.current && map.current) {
        // Do not interrupt while user is actively dragging, pinch-zooming, scroll-zooming, or rotating
        const isInteracting = (
          isZoomingOrPinchingRef.current ||
          isDraggingRef.current ||
          (Date.now() - lastWheelTimeRef.current < 800) ||
          (map.current && (map.current.isZooming() || map.current.isMoving() || map.current.isRotating()))
        );
        if (!isInteracting) {
          const selId = selectedVehicleRef.current.id;
          const selMarker = vehicleMarkersRef.current[selId];
          const selAnim = anims[selId];
          const live = knownVehiclesRef.current[selId];

          const mPos = selMarker ? selMarker.getLngLat() : null;
          const cLng = mPos ? mPos.lng : (selAnim ? selAnim.currentLng : (live?.lng || selectedVehicleRef.current.lng));
          const cLat = mPos ? mPos.lat : (selAnim ? selAnim.currentLat : (live?.lat || selectedVehicleRef.current.lat));

          if (cLng != null && cLat != null) {
            const curCenter = map.current.getCenter();
            const dLng = Math.abs(curCenter.lng - cLng);
            const dLat = Math.abs(curCenter.lat - cLat);

            // Skip jumpTo if delta is negligible (< ~0.000003 deg) to prevent redundant rendering when bus idles
            if (dLng > 0.000003 || dLat > 0.000003) {
              isProgrammaticMoveRef.current = true;
              map.current.jumpTo({
                center: [cLng, cLat]
              });
              isProgrammaticMoveRef.current = false;
            }

            // Coarse periodic refresh so pill markers still update as camera follows vehicle across city
            const nowTime = performance.now();
            if (nowTime - lastFollowPillUpdateRef.current > 700) {
              lastFollowPillUpdateRef.current = nowTime;
              debouncedUpdateRef.current?.();
            }
          }
        }
      }

      if (hasActive || (selectedVehicleRef.current && isFollowingVehicleRef.current)) {
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
          setSelectedVehicle(null);
          if (isFollowingVehicleRef.current) {
            isFollowingVehicleRef.current = false;
            setIsFollowingVehicle(false);
          }
          setActiveTab(0);
          if (map.current) {
            isInitialFlyingRef.current = true;
            const isDesktop = window.innerWidth >= 768;
            const padding = isDesktop
              ? { left: 80, right: 20, top: 180, bottom: 60 }
              : { left: 20, right: 20, top: 200, bottom: 120 };
            map.current.easeTo({
              center: coords,
              padding,
              duration: 500
            });
            setTimeout(() => {
              isInitialFlyingRef.current = false;
            }, 550);
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
    if (!mapContainer.current) return;

    let initialCenter = [107.605, 51.808];
    let initialZoom = 13;
    let initialPitch = 0;
    let initialBearing = 0;

    try {
      const savedState = JSON.parse(localStorage.getItem('map_view_state'));
      if (savedState && typeof savedState.lng === 'number' && typeof savedState.lat === 'number' && Number.isFinite(savedState.lng) && Number.isFinite(savedState.lat)) {
        initialCenter = [savedState.lng, savedState.lat];
        initialZoom = typeof savedState.zoom === 'number' && Number.isFinite(savedState.zoom) ? Math.max(savedState.zoom, 10) : 13;
        initialPitch = typeof savedState.pitch === 'number' && Number.isFinite(savedState.pitch) ? savedState.pitch : 0;
        initialBearing = typeof savedState.bearing === 'number' && Number.isFinite(savedState.bearing) ? savedState.bearing : 0;
      }
    } catch {
      // ignore
    }

    try {
      map.current = new MapLibreMap({
        container: mapContainer.current,
        style,
        center: initialCenter,
        zoom: initialZoom,
        pitch: initialPitch,
        bearing: initialBearing,
        minZoom: 10,
        maxZoom: 18,
        attributionControl: false,
        pixelRatio: typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1
      });
    } catch (err) {
      console.error("Map initialization failed:", err);
      return;
    }

    let saveViewTimer = null;
    map.current.on('moveend', () => {
      if (saveViewTimer) clearTimeout(saveViewTimer);
      saveViewTimer = setTimeout(() => {
        if (!map.current) return;
        try {
          const center = map.current.getCenter();
          localStorage.setItem('map_view_state', JSON.stringify({
            lng: center.lng,
            lat: center.lat,
            zoom: map.current.getZoom(),
            pitch: map.current.getPitch(),
            bearing: map.current.getBearing()
          }));
        } catch { }
      }, 500);
    });

    map.current.on('popupopen', () => setPopupState(true));
    map.current.on('popupclose', () => {
      setTimeout(() => {
        const popups = document.querySelectorAll('.maplibregl-popup');
        setPopupState(popups.length > 0);
      }, 50);
    });

    map.current.addControl(new YandexFloatingCompassControl(), "top-right");
    map.current.addControl(new NavigationControl({ showCompass: false, showZoom: true }), "top-right");
    
    const geolocateControl = new GeolocateControl({
      positionOptions: {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 5000
      },
      trackUserLocation: true,
      showUserLocation: true,
      showAccuracyCircle: true
    });

    geolocateControl.on("error", (err) => {
      console.warn("GPS Geolocation error:", err?.message || err);
    });

    map.current.addControl(geolocateControl, "top-right");
    map.current.addControl(new YandexLocationHeadingControl(geolocateControl), "top-right");

    // Add custom 3D Control
    map.current.addControl(new ThreeDControl(() => {
      const is3D = map.current.getPitch() > 10;
      const next3D = !is3D;
      map.current.easeTo({ pitch: next3D ? 60 : 0, duration: 600 });
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
        // Ignore clicks immediately upon unlocking/resuming screen (prevents tap-to-wake deselection)
        if (Date.now() - lastResumeTimeRef.current < 1000) {
          return;
        }

        // Prevent map click if we clicked on a marker or HUD
        if (e.originalEvent.target.closest('.vehicle-marker') ||
          e.originalEvent.target.closest('.cluster-marker') ||
          e.originalEvent.target.closest('.forecast-marker') ||
          e.originalEvent.target.closest('.stop-pill-marker') ||
          e.originalEvent.target.closest('.selected-vehicle-hud')) {
          return;
        }

        // Deselect vehicle
        setSelectedVehicle(null);
        // Close the side menu
        setActiveTab(0);

        // Close all MapLibre popups
        closeAllStationPopups();
      });

      updateSourceData();

      let debounceTimer = null;
      let lastMoveUpdateTime = 0;
      const debouncedUpdate = (force = false) => {
        if (debounceTimer) cancelAnimationFrame(debounceTimer);

        const now = performance.now();
        // If map is currently moving/pinching, throttle DOM queries to avoid main-thread touch gesture lag
        if (!force && map.current && (map.current.isMoving() || map.current.isZooming() || map.current.isRotating())) {
          if (now - lastMoveUpdateTime > 300) {
            lastMoveUpdateTime = now;
            updateViewportMarkers();
          } else {
            debounceTimer = requestAnimationFrame(() => {
              if (map.current && !map.current.isMoving()) {
                updateViewportMarkers();
              }
            });
          }
          return;
        }

        lastMoveUpdateTime = now;
        debounceTimer = requestAnimationFrame(() => {
          updateViewportMarkers();
        });
      };
      debouncedUpdateRef.current = () => debouncedUpdate(true);

      debouncedUpdate(true);

      // Register map movement handlers to update HTML pill markers
      map.current.on("move", () => {
        if (!isProgrammaticMoveRef.current) {
          debouncedUpdate(false);
        }
      });
      map.current.on("moveend", () => {
        if (!isProgrammaticMoveRef.current) {
          debouncedUpdate(true);
        }
      });
      map.current.on("zoomstart", () => {
        isZoomingOrPinchingRef.current = true;
      });
      map.current.on("zoomend", () => {
        isZoomingOrPinchingRef.current = false;
        debouncedUpdate(true);
      });
      map.current.on("rotatestart", () => {
        isZoomingOrPinchingRef.current = true;
      });
      map.current.on("rotateend", () => {
        isZoomingOrPinchingRef.current = false;
      });
      map.current.on("pitchstart", () => {
        isZoomingOrPinchingRef.current = true;
      });
      map.current.on("pitchend", () => {
        isZoomingOrPinchingRef.current = false;
      });
      map.current.on("dragstart", (e) => {
        isDraggingRef.current = true;
        dragStartPointRef.current = e?.point ? { x: e.point.x, y: e.point.y } : null;
        if (isFollowingVehicleRef.current) {
          isFollowingVehicleRef.current = false;
          setIsFollowingVehicle(false);
        }
      });
      map.current.on("dragend", (e) => {
        isDraggingRef.current = false;
        if (isFollowingVehicleRef.current) {
          isFollowingVehicleRef.current = false;
          setIsFollowingVehicle(false);
        }
      });
      map.current.on("rotate", () => {
        for (const id in activeAnimationsRef.current) {
          activeAnimationsRef.current[id]._forceRender = true;
        }
        startGlobalAnimation();
      });
      map.current.on("pitch", () => {
        for (const id in activeAnimationsRef.current) {
          activeAnimationsRef.current[id]._forceRender = true;
        }
        startGlobalAnimation();
      });

      // Crucial: Update HTML markers immediately whenever the geojson data finishes rendering!
      map.current.on("data", (e) => {
        if ((e.sourceId === "stations-source" || e.sourceId === "route-stations-source") && e.isSourceLoaded) {
          debouncedUpdate();
        }
      });
    });

    const onWheel = () => {
      lastWheelTimeRef.current = Date.now();
    };
    const onTouchStart = (e) => {
      if (e.touches && e.touches.length >= 2) {
        isZoomingOrPinchingRef.current = true;
      }
    };
    const onTouchEnd = () => {
      setTimeout(() => {
        if (map.current && !map.current.isZooming() && !map.current.isRotating()) {
          isZoomingOrPinchingRef.current = false;
        }
      }, 120);
    };

    const containerEl = mapContainer.current;
    containerEl?.addEventListener("wheel", onWheel, { passive: true });
    containerEl?.addEventListener("touchstart", onTouchStart, { passive: true });
    containerEl?.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      containerEl?.removeEventListener("wheel", onWheel);
      containerEl?.removeEventListener("touchstart", onTouchStart);
      containerEl?.removeEventListener("touchend", onTouchEnd);
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Update map padding based on activeTab (for desktop side panel and mobile drawer/pill)
  useEffect(() => {
    if (activeTab !== 0) {
      closeAllStationPopups();
    }

    if (!map.current) return;
    if (isInitialFlyingRef.current) return;

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

  const openStationOnMap = useCallback((sid, stationName = "", rid = "", rnum = "", vehType = "", liveVeh = null) => {
    if (!map.current || !stations || stations.length === 0) return;
    const cleanSid = String(sid || "").trim();
    const cleanName = String(stationName || "").trim().toLowerCase();
    const cleanType = String(vehType || "").trim().toLowerCase();
    const cleanRid = String(rid || "").trim();

    // 1. Primary: Exact Station ID match
    let feat = cleanSid ? stations.find(s => String(s.properties?.id) === cleanSid || String(s.id) === cleanSid) : null;

    // 2. If not found by exact ID, search by Name with direction & route awareness
    if (!feat && cleanName) {
      let candidates = stations.filter(s => s.properties?.name && s.properties.name.trim().toLowerCase() === cleanName);

      // Filter by vehicle type (e.g. tram vs bus)
      if (cleanType && candidates.length > 1) {
        const typeCandidates = candidates.filter(s => s.properties?.type === cleanType || (cleanType === 'minibus' && s.properties?.type === 'bus'));
        if (typeCandidates.length > 0) candidates = typeCandidates;
      }

      // Filter by route stations list if route ID is known
      if (cleanRid && candidates.length > 1 && routeStationsCacheRef.current?.[cleanRid]) {
        const routeStIds = new Set(routeStationsCacheRef.current[cleanRid].map(String));
        const routeCandidates = candidates.filter(s => routeStIds.has(String(s.properties?.id)) || routeStIds.has(String(s.id)));
        if (routeCandidates.length > 0) candidates = routeCandidates;
      }

      // If multiple candidates remain and we have live vehicle coordinates, pick the candidate closest to vehicle in travel direction
      if (candidates.length > 1 && liveVeh && liveVeh.lat && liveVeh.lng) {
        candidates.sort((a, b) => {
          const aCoord = a.geometry?.coordinates || [0, 0];
          const bCoord = b.geometry?.coordinates || [0, 0];
          const distA = Math.hypot(aCoord[0] - liveVeh.lng, aCoord[1] - liveVeh.lat);
          const distB = Math.hypot(bCoord[0] - liveVeh.lng, bCoord[1] - liveVeh.lat);
          return distA - distB;
        });
      }

      if (candidates.length > 0) {
        feat = candidates[0];
      }
    }

    if (!feat || !feat.geometry || !Array.isArray(feat.geometry.coordinates)) return;
    const coords = feat.geometry.coordinates;
    closeAllStationPopups();
    map.current.flyTo({
      center: coords,
      zoom: Math.max(map.current.getZoom(), 16),
      essential: true
    });
    showStationPopup(
      map.current,
      coords,
      feat.properties,
      routesRef.current,
      favoritesRef.current.has(feat.properties.id),
      toggleFavorite
    );
    setActiveTab(0);
  }, [stations, toggleFavorite]);

  // Handle open station popup from push notification click or URL query param (?sid=...)
  useEffect(() => {
    if (!map.current || !stations || stations.length === 0) return;

    // 1. Check URL query parameters (?sid=123 or ?station=123)
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const sidParam = urlParams.get('sid') || urlParams.get('station');
      if (sidParam) {
        setTimeout(() => {
          openStationOnMap(sidParam);
        }, 300);
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } catch {}

    // 2. Listen for messages from Service Worker when notification is clicked while window is open
    const handleSwMessage = (event) => {
      if (event.data && event.data.type === 'OPEN_STATION_POPUP' && event.data.sid) {
        openStationOnMap(event.data.sid, '', event.data.rid || '');
      }
    };

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleSwMessage);
    }

    return () => {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', handleSwMessage);
      }
    };
  }, [stations, openStationOnMap]);

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
    let isFetchingVehicles = false;
    let lastVehicleKickTime = 0;
    const abortCtrl = new AbortController();

    const fetchVehicles = async () => {
      if (!isActive || isFetchingVehicles) return;

      // Pause fetching if tab is in the background or phone is locked
      if (document.hidden) {
        fetchVehiclesTimeoutRef.current = setTimeout(fetchVehicles, 15000);
        return;
      }

      isFetchingVehicles = true;

      // If we just woke up from being locked for >30 seconds, force a full refresh
      const now = Date.now();
      if (now - lastFetchTime > 30000) {
        curk = "0";
      }
      lastFetchTime = now;

      const pollRidsSet = new Set();
      if (selectedRoutes.size > 0 && (showBus || showTram)) {
        selectedRoutes.forEach(r => {
          String(r).split(",").forEach(id => {
            if (id.trim()) pollRidsSet.add(id.trim());
          });
        });
      }

      // Always include history vehicles' rids so their online LED dot is live
      if (vehicleHistoryRef.current) {
        vehicleHistoryRef.current.forEach(item => {
          if (item.rid) {
            String(item.rid).split(",").forEach(id => {
              if (id.trim()) pollRidsSet.add(id.trim());
            });
          }
          if (routesRef.current && routesRef.current.length > 0) {
            const match = routesRef.current.find(r => 
              String(r.number).trim().toLowerCase() === String(item.route || "").trim().toLowerCase() &&
              normalizeVehicleType(r.type, r.number) === normalizeVehicleType(item.type, item.route)
            );
            if (match && match.id) {
              String(match.id).split(",").forEach(id => {
                if (id.trim()) pollRidsSet.add(id.trim());
              });
            }
          }
        });
      }

      if (pollRidsSet.size === 0) {
        Object.values(vehicleMarkersRef.current).forEach(m => m.remove());
        vehicleMarkersRef.current = {};
        activeAnimationsRef.current = {};
        if (globalAnimationId.current) {
          cancelAnimationFrame(globalAnimationId.current);
          globalAnimationId.current = null;
        }
        curk = "0";
        isFetchingVehicles = false;
        fetchVehiclesTimeoutRef.current = setTimeout(fetchVehicles, 10000);
        return;
      }

      const rids = Array.from(pollRidsSet).map(encodeURIComponent).join(",");
      try {
        const res = await apiFetch(`/api/vehicles?rids=${rids}&curk=${encodeURIComponent(curk)}`, { signal: abortCtrl.signal });
        const data = await res.json();
        if (!isActive) return;
        setConsecutiveFetchErrors(0);

        if (data && data.vehicles) {
          const nowTime = Date.now();
          const incomingIds = new Set();
          const updatesMap = {};
          const isFullPoll = !data.next_curk || data.next_curk === "0" || curk === "0";

          // Record live status for ALL queried vehicles (including history telemetry)
          data.vehicles.forEach(v => {
            knownVehiclesRef.current[v.id] = { ...v, _lastSeen: nowTime };
            updatesMap[v.id] = v;
          });
          setTelemetryTick(t => (t + 1) % 1000);

          // Filter map markers strictly by active selectedRoutes and category chips (Bus/Tram)
          const activeRids = new Set();
          const activeRouteKeys = new Set();
          if (showBus || showTram) {
            if (routes && routes.length > 0) {
              routes.forEach(r => {
                if (selectedRoutes.has(r.id)) {
                  String(r.id).split(",").forEach(id => {
                    if (id.trim()) activeRids.add(id.trim());
                  });
                  const normType = normalizeVehicleType(r.type, r.number);
                  activeRouteKeys.add(`${normType}_${String(r.number).trim().toLowerCase()}`);
                }
              });
            }
          }

          const allVeh = data.vehicles.filter(v => {
            // Keep tracked vehicle visible on map even if route was temporarily toggled
            if (selectedVehicleRef.current?.id === v.id) return true;

            const vType = normalizeVehicleType(v.type, v.route || v.rnum);
            if (vType === "tram" && !showTram) return false;
            if ((vType === "bus" || vType === "minibus") && !showBus) return false;

            const vNum = String(v.route || v.rnum || "").trim().toLowerCase();
            const vKey = `${vType}_${vNum}`;
            const hasRid = v.rid && activeRids.has(String(v.rid).trim());
            const hasKey = activeRouteKeys.has(vKey);

            if (!hasRid && !hasKey) {
              return false;
            }
            return true;
          });

          allVeh.forEach(v => {
            incomingIds.add(v.id);
          });

          // Validate selected vehicle - auto-deselect if off-shift after 3 missed polls
          if (selectedVehicleRef.current) {
            const selId = selectedVehicleRef.current.id;
            const lastSeen = knownVehiclesRef.current[selId]?._lastSeen || 0;
            if ((isFullPoll && !incomingIds.has(selId)) || (nowTime - lastSeen > 180000)) {
              missedPollsRef.current++;
              if (missedPollsRef.current >= 3) {
                setSelectedVehicle(null);
                missedPollsRef.current = 0;
              }
            } else if (incomingIds.has(selId)) {
              missedPollsRef.current = 0;
            }
          }

          // Prune markers for vehicles no longer active/visible on map
          Object.keys(vehicleMarkersRef.current).forEach(id => {
            if (incomingIds.has(id)) return;
            if (selectedVehicleRef.current?.id === id) return; // never orphan the actively tracked vehicle
            try {
              vehicleMarkersRef.current[id].remove();
            } catch { }
            delete vehicleMarkersRef.current[id];
            delete activeAnimationsRef.current[id];
          });

          // Periodic memory sweep: purge stale off-shift entries from knownVehiclesRef (> 10 minutes)
          Object.keys(knownVehiclesRef.current).forEach(id => {
            if (selectedVehicleRef.current?.id === id) return;
            if (vehicleMarkersRef.current[id]) return;
            const lastSeen = knownVehiclesRef.current[id]?._lastSeen || 0;
            if (nowTime - lastSeen > 600000) {
              delete knownVehiclesRef.current[id];
            }
          });

          if (!isActive) return;

          if (data.next_curk && data.next_curk !== "0") {
            curk = data.next_curk;
          }

          // Add or update markers
          allVeh.forEach(v => {
            const vType = normalizeVehicleType(v.type, v.route || v.rnum);
            const validDir = (v.dir != null && Number.isFinite(v.dir) && v.dir > 0) ? v.dir : null;
            const rotation = validDir || 0;

            if (vehicleMarkersRef.current[v.id]) {
              const marker = vehicleMarkersRef.current[v.id];

              // Only animate if this vehicle was actually updated in this poll
              if (!updatesMap[v.id]) return;

              marker._lastUpdateTime = Date.now();

              const el = marker.getElement();
              const mDiv = el.querySelector(".vehicle-marker");
              const tSpan = el.querySelector(".vehicle-text");

              let anims = activeAnimationsRef.current;
              let t = anims[v.id];

              if (!t) {
                const mPos = marker.getLngLat();
                const curLat = mPos ? mPos.lat : v.lat;
                const curLng = mPos ? mPos.lng : v.lng;
                const predictedHeading = getNextStopBearing(v, curLat, curLng);
                const initDir = marker._currentRot !== undefined ? marker._currentRot : (predictedHeading != null ? predictedHeading : (validDir || 0));
                t = {
                  marker,
                  mDiv,
                  tSpan,
                  currentLat: curLat,
                  currentLng: curLng,
                  currentDirection: initDir,
                  animationPoints: [],
                  timeRemaining: 0,
                  directionTimeRemaining: 0,
                  velocityLat: 0,
                  velocityLng: 0,
                  velocityDirection: 0,
                  anim_key: v.anim_key,
                  lastAddedPoint: null,
                  coastTime: 0,
                  idle: false,
                  veh: v
                };
                anims[v.id] = t;
              } else {
                t.veh = v;
              }

              // On app resume from background or large jump (> 1km), snap directly to latest live coordinates
              const isResumePoll = isAppResumeRef.current;
              if (isResumePoll || Math.abs(v.lat - t.currentLat) > 0.01 || Math.abs(v.lng - t.currentLng) > 0.01) {
                t.animationPoints = [];
                t.timeRemaining = 0;
                t.directionTimeRemaining = 0;
                t.currentLat = v.lat;
                t.currentLng = v.lng;
                const predicted = getNextStopBearing(v, v.lat, v.lng);
                if (predicted != null) t.currentDirection = predicted;
                t.lastAddedPoint = null;
                marker.setLngLat([v.lng, v.lat]);
              }

              if (v.animPoints && v.animPoints.length > 0) {
                if (v.anim_key !== t.anim_key) {
                  // Only store the last 2 trajectory points max
                  t.animationPoints = v.animPoints.slice(-2);
                  t.anim_key = v.anim_key;
                  marker._anim_key = v.anim_key;
                  t.idle = false;
                  startGlobalAnimation();
                }
              } else if (!v.anim_key && v.lat != null && v.lng != null) {
                // Direct coordinate interpolation only for static vehicles without anim_key
                const dLat = Math.abs(v.lat - t.currentLat);
                const dLng = Math.abs(v.lng - t.currentLng);
                if (dLat > 0.00001 || dLng > 0.00001) {
                  t.animationPoints = [{ lat: v.lat, lng: v.lng, dir: rotation, percent: 100 }];
                  t.lastAddedPoint = { lat: v.lat, lng: v.lng, dir: rotation };
                  t.idle = false;
                  startGlobalAnimation();
                }
              }

              if (marker && marker.getPopup() && marker.getPopup().isOpen()) {
                const isAtTerminal = isNearTerminalStop(v);
                marker.getPopup().setHTML(`
                  <div style="padding: 6px 10px; font-family: sans-serif; text-align: center; line-height: 1.3;">
                    <div style="font-weight: 700; font-size: 13px; color: #0f172a;">${escapeHtml(v.gosNum || "Маршрут " + (v.route || ""))}</div>
                    ${isAtTerminal ? `
                      <div style="margin-top: 4px; display: inline-flex; align-items: center; gap: 4px; background: #ecfdf5; border: 1px solid #86efac; color: #15803d; border-radius: 12px; padding: 2px 8px; font-size: 11px; font-weight: 600;">
                        <span style="width: 6px; height: 6px; border-radius: 50%; background: #22c55e; display: inline-block;"></span>
                        На конечной (ожидает)
                      </div>
                    ` : ''}
                  </div>
                `);
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

              // Compute initial arrow direction targeting the upcoming arrival station / forward road waypoint
              const predictedHeading = getNextStopBearing(v, v.lat, v.lng);
              const initialDirection = predictedHeading != null ? predictedHeading : rotation;

              const mapBearing = map.current ? map.current.getBearing() : 0;
              const initialVisualRot = initialDirection - mapBearing;

              const markerDiv = document.createElement("div");
              markerDiv.className = `vehicle-marker vehicle-${vType}`;
              if (selectedVehicleRef.current && selectedVehicleRef.current.id === v.id) {
                markerDiv.classList.add("vehicle-selected");
              }
              markerDiv.style.transform = `rotate(${initialVisualRot.toFixed(2)}deg)`;
              markerDiv.style.width = "100%";
              markerDiv.style.height = "100%";

              const textSpan = document.createElement("span");
              textSpan.className = "vehicle-text";
              textSpan.textContent = v.rnum || v.route;
              textSpan.style.display = "inline-block";
              textSpan.style.transform = `rotate(${(-initialVisualRot).toFixed(2)}deg)`;

              const pointer = document.createElement("div");
              pointer.className = "vehicle-pointer";

              markerDiv.appendChild(textSpan);
              markerDiv.appendChild(pointer);
              wrapper.appendChild(markerDiv);

              wrapper.onclick = (e) => {
                e.stopPropagation();
                if (!v.id) return;

                const curMarker = vehicleMarkersRef.current[v.id];
                const mPos = curMarker ? curMarker.getLngLat() : null;
                const anim = activeAnimationsRef.current[v.id];
                const live = knownVehiclesRef.current[v.id] || v;
                const curLat = mPos ? mPos.lat : (anim ? anim.currentLat : (live.lat || v.lat));
                const curLng = mPos ? mPos.lng : (anim ? anim.currentLng : (live.lng || v.lng));

                let resolvedRid = v.rid || live.rid;
                if (!resolvedRid && routesRef.current) {
                  const vNum = String(live.rnum || live.route || v.rnum || v.route || "").trim().toLowerCase();
                  const match = routesRef.current.find(r => 
                    String(r.number).trim().toLowerCase() === vNum &&
                    normalizeVehicleType(r.type, r.number) === vType
                  );
                  if (match && match.id) {
                    resolvedRid = String(match.id).split(",")[0].trim();
                  }
                }

                closeAllStationPopups();
                lastVehicleSelectionTimeRef.current = Date.now();

                setSelectedVehicle(prev => {
                  if (prev && prev.id === v.id) return null;
                  return {
                    rid: resolvedRid || null,
                    id: v.id,
                    gosNum: live.gosNum || v.gosNum,
                    route: live.rnum || live.route || v.rnum || v.route,
                    type: vType,
                    lat: curLat,
                    lng: curLng
                  };
                });
              };

              const popup = new Popup({ offset: 25, closeButton: false });
              popup.on('open', () => {
                const liveVeh = knownVehiclesRef.current[v.id] || v;
                const isAtTerminal = isNearTerminalStop(liveVeh);
                popup.setHTML(`
                  <div style="padding: 6px 10px; font-family: sans-serif; text-align: center; line-height: 1.3;">
                    <div style="font-weight: 700; font-size: 13px; color: #0f172a;">${escapeHtml(liveVeh.gosNum || "Маршрут " + (liveVeh.route || ""))}</div>
                    ${isAtTerminal ? `
                      <div style="margin-top: 4px; display: inline-flex; align-items: center; gap: 4px; background: #ecfdf5; border: 1px solid #86efac; color: #15803d; border-radius: 12px; padding: 2px 8px; font-size: 11px; font-weight: 600;">
                        <span style="width: 6px; height: 6px; border-radius: 50%; background: #22c55e; display: inline-block;"></span>
                        На конечной (ожидает)
                      </div>
                    ` : ''}
                  </div>
                `);
              });

              const marker = new Marker({ element: wrapper, anchor: "center" })
                .setLngLat([v.lng, v.lat])
                .setPopup(popup)
                .addTo(map.current);

              marker._lastUpdateTime = Date.now();
              marker._currentRot = initialDirection;
              marker._lastRot = initialVisualRot;
              marker._anim_key = v.anim_key;
              vehicleMarkersRef.current[v.id] = marker;

              const initialPoints = (v.animPoints && v.animPoints.length > 0) ? v.animPoints.slice(-2) : [];
              activeAnimationsRef.current[v.id] = {
                marker,
                mDiv: markerDiv,
                tSpan: textSpan,
                currentLat: v.lat,
                currentLng: v.lng,
                currentDirection: initialDirection,
                animationPoints: initialPoints,
                timeRemaining: 0,
                directionTimeRemaining: 0,
                velocityLat: 0,
                velocityLng: 0,
                velocityDirection: 0,
                anim_key: v.anim_key,
                lastAddedPoint: initialPoints.length > 0 ? initialPoints[initialPoints.length - 1] : null,
                coastTime: 0,
                idle: false
              };

              startGlobalAnimation();
            }
          });
          isAppResumeRef.current = false;

          // Instant camera centering on initial poll resolution for restored vehicle session
          if (!hasInitialCenteredRef.current && selectedVehicleRef.current && isFollowingVehicleRef.current && map.current) {
            const selId = selectedVehicleRef.current.id;
            const live = updatesMap[selId] || knownVehiclesRef.current[selId];
            if (live && live.lat && live.lng) {
              hasInitialCenteredRef.current = true;
              map.current.easeTo({
                center: [live.lng, live.lat],
                zoom: Math.max(map.current.getZoom(), 15.5),
                duration: 600
              });
            }
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error("Failed to fetch live vehicles", err);
          setConsecutiveFetchErrors(c => c + 1);
        }
      } finally {
        isFetchingVehicles = false;
        if (isActive) {
          if (fetchVehiclesTimeoutRef.current) {
            clearTimeout(fetchVehiclesTimeoutRef.current);
          }
          fetchVehiclesTimeoutRef.current = setTimeout(fetchVehicles, 10000);
        }
      }
    };

    const handleVisibilityChange = () => {
      lastResumeTimeRef.current = Date.now();
      if (document.hidden) {
        if (selectedVehicleRef.current) {
          wasFollowingBeforeHiddenRef.current = isFollowingVehicleRef.current;
        }
        return;
      }
      if (!isActive) return;
      if (Date.now() - lastVehicleKickTime < 500) return; // Dedupes visibilitychange + focus + pageshow burst
      lastVehicleKickTime = Date.now();

      isAppResumeRef.current = true;
      if (fetchVehiclesTimeoutRef.current) {
        clearTimeout(fetchVehiclesTimeoutRef.current);
      }
      isFetchingVehicles = false;
      curk = "0";
      fetchVehicles();
      startGlobalAnimation();

      if (selectedVehicleRef.current && (isFollowingVehicleRef.current || wasFollowingBeforeHiddenRef.current)) {
        setIsFollowingVehicle(true);
        isFollowingVehicleRef.current = true;
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handleVisibilityChange);
    window.addEventListener("focus", handleVisibilityChange);
    const initialTimer = setTimeout(fetchVehicles, 60);

    return () => {
      isActive = false;
      clearTimeout(initialTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handleVisibilityChange);
      window.removeEventListener("focus", handleVisibilityChange);
      abortCtrl.abort();
      if (fetchVehiclesTimeoutRef.current) {
        clearTimeout(fetchVehiclesTimeoutRef.current);
      }
      activeAnimationsRef.current = {};
      if (globalAnimationId.current) {
        cancelAnimationFrame(globalAnimationId.current);
        globalAnimationId.current = null;
      }
    };
  }, [selectedRoutes, showBus, showTram, routes]);

  // Selected Vehicle Camera Centering & Follow Activation (Runs only on selection change)
  useEffect(() => {
    if (!map.current) return;
    const currentId = selectedVehicle?.id;
    const isNewSelection = currentId && currentId !== prevSelectedVehicleIdRef.current;
    prevSelectedVehicleIdRef.current = currentId;

    if (!selectedVehicle) {
      setIsFollowingVehicle(false);
      isFollowingVehicleRef.current = false;
      isInitialFlyingRef.current = false;
      return;
    }

    // Only auto-fly and reset follow state if a NEW vehicle was selected during active interaction
    if (isNewSelection) {
      closeAllStationPopups();

      hasInitialCenteredRef.current = true;
      setIsFollowingVehicle(true);
      isFollowingVehicleRef.current = true;
      isInitialFlyingRef.current = true;
      lastVehicleSelectionTimeRef.current = Date.now();

      const marker = vehicleMarkersRef.current[selectedVehicle.id];
      const mPos = marker ? marker.getLngLat() : null;
      const anim = activeAnimationsRef.current[selectedVehicle.id];
      const liveVeh = knownVehiclesRef.current[selectedVehicle.id] || selectedVehicle;
      const targetLng = mPos ? mPos.lng : (anim ? anim.currentLng : (liveVeh.lng || selectedVehicle.lng));
      const targetLat = mPos ? mPos.lat : (anim ? anim.currentLat : (liveVeh.lat || selectedVehicle.lat));

      if (map.current && targetLng != null && targetLat != null) {
        map.current.flyTo({
          center: [targetLng, targetLat],
          zoom: Math.max(map.current.getZoom(), 15.5),
          duration: 800,
          essential: true
        });
        setTimeout(() => {
          isInitialFlyingRef.current = false;
        }, 850);
      }
    }
  }, [selectedVehicle?.id]);



  const isNearTerminalStopRef = useRef(isNearTerminalStop);
  useEffect(() => {
    isNearTerminalStopRef.current = isNearTerminalStop;
  }, [isNearTerminalStop]);

  // Route Nodes and Forecasts fetching (Decoupled from camera flyTo and stationsById deps)
  useEffect(() => {
    if (!map.current) return;

    // Clear existing forecast markers and stale station info immediately on vehicle switch
    forecastMarkersRef.current.forEach(m => m.remove());
    forecastMarkersRef.current = [];
    setNextStationInfo(null);

    if (!selectedVehicle) {
      setRouteStationsOrder([]);
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
    setRouteStationsOrder([]);

    let isActive = true;
    let forecastTimeout = null;
    const abortController = new AbortController();
    const signal = abortController.signal;

    const fetchNodes = async () => {
      try {
        // Fetch and draw route nodes
        const resNodes = await apiFetch(`/api/route_nodes?id=${encodeURIComponent(selectedVehicle.rid)}`, { signal });
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
        if (err.name !== 'AbortError') {
          console.error("Failed to fetch nodes:", err);
        }
      }
    };

    const fetchRouteStations = async () => {
      try {
        const res = await apiFetch(`/api/route_stations?id=${encodeURIComponent(selectedVehicle.rid)}`, { signal });
        const data = await res.json();
        if (!isActive) return;
        if (data.stations && Array.isArray(data.stations)) {
          const sIds = data.stations.map(String);
          setSelectedRouteStations(new Set(sIds));
          setRouteStationsOrder(sIds);
          routeStationsCacheRef.current[String(selectedVehicle.rid)] = sIds;
        } else {
          setSelectedRouteStations(new Set());
          setRouteStationsOrder([]);
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error("Failed to fetch route stations:", err);
        }
      }
    };

    let isFetchingForecasts = false;
    let lastForecastKickTime = 0;

    const fetchForecasts = async () => {
      if (!isActive || isFetchingForecasts) return;
      isFetchingForecasts = true;
      try {
        // Fetch and draw station forecasts
        const resForecasts = await apiFetch(`/api/vehicle_forecasts?vehid=${encodeURIComponent(selectedVehicle.id)}`, { signal });
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

          // Sort by arrival time ascending to identify the immediate next stop
          uniqueForecasts.sort((a, b) => (parseInt(a.time, 10) || 0) - (parseInt(b.time, 10) || 0));

          if (uniqueForecasts.length > 0) {
            const nextF = uniqueForecasts[0];
            const nextSt = stationsByIdRef.current.get(nextF.stid);
            if (nextSt) {
              const stName = nextSt.properties?.name || "Остановка";
              setNextStationInfo({
                name: stName,
                stid: String(nextF.stid),
                time: nextF.time,
                remainingCount: uniqueForecasts.length,
                isTerminal: false
              });
              setVehicleHistory(prev => {
                const list = Array.isArray(prev) ? prev : [];
                let hasChange = false;
                const updated = list.map(item => {
                  if (item && item.id === selectedVehicle.id && item.nextStation !== stName) {
                    hasChange = true;
                    return { ...item, nextStation: stName };
                  }
                  return item;
                });
                if (hasChange) {
                  try {
                    localStorage.setItem("pref_vehicleHistory", JSON.stringify(updated));
                  } catch { }
                  return updated;
                }
                return prev;
              });
            }
          }

          uniqueForecasts.forEach(f => {
            const st = stationsByIdRef.current.get(f.stid);
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
                  <span>${escapeHtml(f.time)} мин.</span>
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
        } else {
          // If no forward forecasts, check if vehicle is actually at terminal stop (within 100m)
          const currentVeh = knownVehiclesRef.current[selectedVehicle.id] || selectedVehicle;
          if (currentVeh && currentVeh.lat && currentVeh.lng && isNearTerminalStopRef.current(currentVeh)) {
            setNextStationInfo({
              name: "Конечная (ожидает)",
              time: null,
              isTerminal: true
            });
            setVehicleHistory(prev => {
              const list = Array.isArray(prev) ? prev : [];
              let hasChange = false;
              const updated = list.map(item => {
                if (item && item.id === selectedVehicle.id && item.nextStation !== "Конечная (ожидает)") {
                  hasChange = true;
                  return { ...item, nextStation: "Конечная (ожидает)" };
                }
                return item;
              });
              if (hasChange) {
                try {
                  localStorage.setItem("pref_vehicleHistory", JSON.stringify(updated));
                } catch { }
                return updated;
              }
              return prev;
            });
            const el = document.createElement("div");
            el.className = "forecast-marker terminal-waiting-badge";
            el.innerHTML = `
              <div style="background: #ffffff; color: #0f172a; border: 2px solid #22c55e; border-radius: 20px; padding: 4px 10px; display: flex; align-items: center; gap: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); font-size: 11px; font-weight: 700; white-space: nowrap; pointer-events: none;">
                <span style="width: 8px; height: 8px; border-radius: 50%; background-color: #22c55e; box-shadow: 0 0 6px #22c55e; display: inline-block;"></span>
                На конечной (ожидает)
              </div>
            `;
            const marker = new Marker({ element: el, anchor: "bottom", offset: [0, -22] })
              .setLngLat([currentVeh.lng, currentVeh.lat])
              .addTo(map.current);

            forecastMarkersRef.current.push(marker);
          } else {
            setNextStationInfo(null);
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error("Failed to fetch forecasts:", err);
      } finally {
        isFetchingForecasts = false;
        if (isActive) {
          if (forecastTimeout) clearTimeout(forecastTimeout);
          forecastTimeout = setTimeout(fetchForecasts, 10000);
        }
      }
    };

    const handleForecastVisibility = () => {
      if (document.hidden || !isActive) return;
      if (Date.now() - lastForecastKickTime < 2000) return; // Dedupes visibilitychange burst
      lastForecastKickTime = Date.now();
      if (forecastTimeout) clearTimeout(forecastTimeout);
      fetchForecasts();
    };

    document.addEventListener("visibilitychange", handleForecastVisibility);
    debouncedForecastRefreshRef.current = fetchForecasts;

    fetchNodes();
    fetchRouteStations();
    fetchForecasts();

    return () => {
      isActive = false;
      debouncedForecastRefreshRef.current = null;
      document.removeEventListener("visibilitychange", handleForecastVisibility);
      abortController.abort();
      if (forecastTimeout) clearTimeout(forecastTimeout);
    };
  }, [selectedVehicle?.id, selectedVehicle?.rid]);

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
    setSelectedVehicle(null);

    if (isFollowingVehicleRef.current) {
      isFollowingVehicleRef.current = false;
      setIsFollowingVehicle(false);
    }

    setActiveTab(0);

    if (map.current) {
      isInitialFlyingRef.current = true;
      const coords = feat.geometry.coordinates;
      const isDesktop = window.innerWidth >= 768;
      const padding = isDesktop
        ? { left: 80, right: 20, top: 180, bottom: 60 }
        : { left: 20, right: 20, top: 200, bottom: 120 };

      map.current.flyTo({
        center: coords,
        zoom: 16.5,
        duration: 800,
        padding,
        essential: true
      });
      setTimeout(() => {
        isInitialFlyingRef.current = false;
      }, 850);
      showStationPopup(map.current, coords, feat.properties, routesRef.current, favoritesRef.current.has(feat.properties.id), toggleFavorite);
    }
  };

  const handleSelectVehicleFromHistory = useCallback((item, live) => {
    if (!item) return;
    const targetVeh = live || item;
    const targetType = normalizeVehicleType(targetVeh.type || item.type, targetVeh.route || targetVeh.rnum || item.route);
    
    let routeItem = null;
    if (routes && routes.length > 0) {
      routeItem = routes.find(r => {
        const ids = String(r.id || "").split(",");
        return (targetVeh.rid && ids.includes(String(targetVeh.rid))) || (item.rid && ids.includes(String(item.rid)));
      });
      if (!routeItem) {
        routeItem = routes.find(r => {
          const matchNum = String(r.number).trim().toLowerCase() === String(targetVeh.route || targetVeh.rnum || item.route || "").trim().toLowerCase();
          const matchType = normalizeVehicleType(r.type, r.number) === targetType;
          return matchNum && matchType;
        });
      }
    }

    const targetRouteId = routeItem ? routeItem.id : (targetVeh.rid || item.rid);
    if (targetRouteId) {
      setSelectedRoutes(prev => {
        if (prev.has(targetRouteId)) return prev;
        const next = new Set(prev);
        next.add(targetRouteId);
        return next;
      });
    }

    if (targetType === "tram" && !showTram) setShowTram(true);
    if (targetType === "bus" && !showBus) setShowBus(true);
    if (targetType === "minibus" && !showBus) setShowBus(true);

    const firstRid = routeItem ? String(routeItem.id).split(",")[0].trim() : (targetVeh.rid || item.rid || null);
    const selVehId = String(targetVeh.id || item.id);

    closeAllStationPopups();
    setActiveTab(0);

    const isDesktop = window.innerWidth >= 768;
    const padding = isDesktop
      ? { left: 80, right: 20, top: 20, bottom: 20 }
      : { left: 20, right: 20, top: 20, bottom: 120 };

    const marker = vehicleMarkersRef.current[selVehId] || (live && vehicleMarkersRef.current[live.id]);
    const mPos = marker ? marker.getLngLat() : null;
    const anim = activeAnimationsRef.current[selVehId] || (live && activeAnimationsRef.current[live.id]);
    const liveVeh = (live && knownVehiclesRef.current[live.id]) || knownVehiclesRef.current[selVehId] || live || targetVeh;
    const targetLng = mPos ? mPos.lng : (anim ? anim.currentLng : (liveVeh?.lng || targetVeh.lng || item.lng));
    const targetLat = mPos ? mPos.lat : (anim ? anim.currentLat : (liveVeh?.lat || targetVeh.lat || item.lat));

    prevSelectedVehicleIdRef.current = selVehId;
    lastVehicleSelectionTimeRef.current = Date.now();
    lastTabCloseTimeRef.current = Date.now();

    setIsFollowingVehicle(true);
    isFollowingVehicleRef.current = true;

    setSelectedVehicle({
      rid: targetVeh.rid || firstRid,
      id: selVehId,
      gosNum: targetVeh.gosNum || item.gosNum || "",
      route: targetVeh.route || targetVeh.rnum || item.route,
      type: targetType,
      lat: targetLat || targetVeh.lat,
      lng: targetLng || targetVeh.lng
    });

    if (map.current && targetLng != null && targetLat != null) {
      isInitialFlyingRef.current = true;
      map.current.flyTo({
        center: [targetLng, targetLat],
        zoom: Math.max(map.current.getZoom(), 15.5),
        duration: 750,
        padding,
        essential: true
      });
      setTimeout(() => {
        isInitialFlyingRef.current = false;
      }, 800);
    }
  }, [routes, showTram, showBus]);

  const favoriteStops = useMemo(() => {
    return stations.filter((st) => favorites.has(st.properties.id));
  }, [stations, favorites]);

  const recenterSelectedVehicle = () => {
    if (!selectedVehicle || !map.current) return;
    const marker = vehicleMarkersRef.current[selectedVehicle.id];
    const mPos = marker ? marker.getLngLat() : null;
    const anim = activeAnimationsRef.current[selectedVehicle.id];
    const liveVeh = knownVehiclesRef.current[selectedVehicle.id] || selectedVehicle;
    const targetLng = mPos ? mPos.lng : (anim ? anim.currentLng : (liveVeh.lng || selectedVehicle.lng));
    const targetLat = mPos ? mPos.lat : (anim ? anim.currentLat : (liveVeh.lat || selectedVehicle.lat));

    if (targetLng != null && targetLat != null) {
      isInitialFlyingRef.current = true;
      map.current.flyTo({
        center: [targetLng, targetLat],
        zoom: Math.max(map.current.getZoom(), 15.5),
        duration: 600,
        essential: true
      });
      setTimeout(() => {
        isInitialFlyingRef.current = false;
      }, 650);
      setIsFollowingVehicle(true);
      isFollowingVehicleRef.current = true;
    }
  };

  const toggleFollowVehicle = () => {
    if (isFollowingVehicle) {
      setIsFollowingVehicle(false);
      isFollowingVehicleRef.current = false;
    } else {
      recenterSelectedVehicle();
    }
  };

  return (
    <>
      <div className="app-root">

        {/* Startup Animated Splash Screen */}
        {isSplashMounted && (
          <div className={`startup-splash-overlay ${isSplashFading ? 'fade-out' : ''}`}>
            <div className="startup-splash-content">
              {/* Flat Vector Bus Illustration Scene */}
              <div className="startup-vehicle-scene">
                {/* Dust Puffs at Rear */}
                <div className="startup-dust-container">
                  <span className="startup-dust-puff puff-1"></span>
                  <span className="startup-dust-puff puff-2"></span>
                  <span className="startup-dust-puff puff-3"></span>
                </div>

                {/* Bus Body */}
                <div className="startup-vehicle-body">
                  <svg className="startup-bus-svg" viewBox="0 0 160 90" fill="none" xmlns="http://www.w3.org/2000/svg">
                    {/* Speed trail dashes behind bus */}
                    <g className="speed-lines-trail" stroke="#cbd5e1" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="2" y1="30" x2="10" y2="30" />
                      <line x1="0" y1="42" x2="8" y2="42" />
                      <line x1="4" y1="54" x2="11" y2="54" />
                    </g>

                    {/* Main Yellow Bus Body */}
                    <rect x="15" y="16" width="130" height="49" rx="12" fill="#FBB034" />

                    {/* Light Grey Bottom Trim */}
                    <path d="M15 58 H145 V62 C145 64 143 65 141 65 H19 C17 65 15 64 15 62 Z" fill="#B0BEC5" />

                    {/* Front Windshield */}
                    <path d="M116 23 H138 C140.5 23 142 24.8 142 27.5 V42 H116 Z" fill="#CBE9FE" />

                    {/* 6 Side Windows */}
                    <rect x="26" y="23" width="11" height="13" rx="1.5" fill="#CBE9FE" />
                    <rect x="41" y="23" width="11" height="13" rx="1.5" fill="#CBE9FE" />
                    <rect x="56" y="23" width="11" height="13" rx="1.5" fill="#CBE9FE" />
                    <rect x="71" y="23" width="11" height="13" rx="1.5" fill="#CBE9FE" />
                    <rect x="86" y="23" width="11" height="13" rx="1.5" fill="#CBE9FE" />
                    <rect x="101" y="23" width="11" height="13" rx="1.5" fill="#CBE9FE" />

                    {/* 2 White Side Accent Stripes */}
                    <rect x="42" y="42" width="62" height="3.5" rx="1.75" fill="#FFFFFF" />
                    <rect x="42" y="49.5" width="62" height="3.5" rx="1.75" fill="#FFFFFF" />

                    {/* Yellow Front Headlight */}
                    <rect x="139" y="48" width="7" height="6" rx="3" fill="#FFD54F" />

                    {/* Red Rear Taillight */}
                    <rect x="14" y="48" width="6" height="6" rx="3" fill="#EF4444" />
                  </svg>

                  {/* Rounding Rotating Wheels */}
                  <div className="startup-wheel rear-wheel">
                    <div className="wheel-tire">
                      <div className="wheel-rim"></div>
                    </div>
                  </div>

                  <div className="startup-wheel front-wheel">
                    <div className="wheel-tire">
                      <div className="wheel-rim"></div>
                    </div>
                  </div>
                </div>

                {/* Road surface & moving dashed lines */}
                <div className="startup-road-track">
                  <div className="startup-road-dashes"></div>
                </div>
              </div>

              {/* Text & Loader Bar */}
              <div className="startup-splash-text-wrap">
                <h1 className="startup-splash-title">ТРАНСПОРТ УЛАН-УДЭ</h1>

                <div className="startup-loader-bar">
                  <div className="startup-loader-progress"></div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Small top spinner for background refreshes */}
        {loading && !isSplashMounted && (
          <div style={{ position: "fixed", top: "calc(env(safe-area-inset-top, 0px) + 12px)", left: "50%", transform: "translateX(-50%)", background: "rgba(15, 23, 42, 0.88)", color: "#ffffff", padding: "8px 16px", borderRadius: "24px", fontSize: "13px", fontWeight: 600, display: "flex", alignItems: "center", gap: "8px", zIndex: 10000, boxShadow: "0 4px 14px rgba(0,0,0,0.2)" }}>
            <span className="material-symbols-outlined" style={{ animation: "spin 1s linear infinite", fontSize: "18px" }}>refresh</span>
            Загрузка маршрутов...
          </div>
        )}

        {/* Error Banner */}
        {error && (
          <div style={{ position: "fixed", top: "calc(env(safe-area-inset-top, 0px) + 12px)", left: "50%", transform: "translateX(-50%)", background: "#ef4444", color: "#ffffff", padding: "10px 18px", borderRadius: "12px", fontSize: "13px", fontWeight: 600, zIndex: 10000, boxShadow: "0 4px 14px rgba(0,0,0,0.25)", display: "flex", alignItems: "center", gap: "10px", maxWidth: "90%" }}>
            <span className="material-symbols-outlined" style={{ fontSize: "20px" }}>error</span>
            <span>{error}</span>
            <button onClick={fetchData} style={{ background: "#ffffff", color: "#ef4444", border: "none", borderRadius: "6px", padding: "4px 10px", fontWeight: 700, cursor: "pointer", marginLeft: "8px" }}>Повторить</button>
          </div>
        )}

        {/* Offline / Connectivity Banner */}
        {(!isOnline || consecutiveFetchErrors >= 2) && !error && (
          <div className="connectivity-banner">
            <span className="material-symbols-outlined" style={{ fontSize: "16px", animation: isOnline ? "spin 2s linear infinite" : "none" }}>
              {!isOnline ? "cloud_off" : "sync"}
            </span>
            <span>{!isOnline ? "Нет подключения к сети" : "Переподключение к серверу..."}</span>
          </div>
        )}


        {/* Active Arrival Reminder Topbar HUD (max 3, dropdown for 2+) */}
        {!selectedVehicle && (() => {
          const activeRems = reminders.filter(r => !r.triggered).slice(0, 3);
          if (activeRems.length === 0) return null;

          const currentIdx = Math.min(activeReminderIdx, activeRems.length - 1);
          const activeRem = activeRems[currentIdx] || activeRems[0];

          const remPlate = formatGosNum(activeRem.gosNum).toLowerCase();
          const remRoute = String(activeRem.rnum || '').trim().toLowerCase();
          const liveVeh = (activeRem.vehid && knownVehiclesRef.current[activeRem.vehid]) ||
            Object.values(knownVehiclesRef.current).find(v => {
              const vRoute = String(v.route || v.rnum || '').trim().toLowerCase();
              if (remRoute && vRoute && remRoute !== vRoute) return false;
              if (remPlate && v.gosNum && formatGosNum(v.gosNum).toLowerCase() === remPlate) return true;
              if (activeRem.vehid && v.id && String(v.id) === String(activeRem.vehid)) return true;
              return false;
            }) ||
            (() => {
              if (!remRoute && !activeRem.rid) return null;
              const candidates = Object.values(knownVehiclesRef.current).filter(v => {
                const vRoute = String(v.route || v.rnum || '').trim().toLowerCase();
                if (remRoute && vRoute && remRoute === vRoute) return true;
                if (activeRem.rid && v.rid && String(activeRem.rid) === String(v.rid)) return true;
                return false;
              });
              if (candidates.length === 0) return null;
              if (candidates.length === 1) return candidates[0];
              if (activeRem.sid && stations && stations.length > 0) {
                const st = stations.find(s => String(s.id) === String(activeRem.sid) || String(s.properties?.id) === String(activeRem.sid));
                if (st && st.geometry && Array.isArray(st.geometry.coordinates)) {
                  const stLng = st.geometry.coordinates[0];
                  const stLat = st.geometry.coordinates[1];
                  const expectedDistKm = Math.max(0.5, (parseFloat(activeRem.lastTime || 5) / 60) * 25);
                  const scored = candidates.map(v => {
                    const dLat = (stLat - v.lat) * 111.32;
                    const dLng = (stLng - v.lng) * (111.32 * Math.cos(stLat * Math.PI / 180));
                    const distKm = Math.sqrt(dLat * dLat + dLng * dLng);
                    return { v, score: Math.abs(distKm - expectedDistKm) };
                  });
                  scored.sort((a, b) => a.score - b.score);
                  return scored[0].v;
                }
              }
              return candidates[0];
            })();

          const getReminderVehicleType = (rem) => {
            if (!rem) return "bus";
            if (rem.vehid && knownVehiclesRef.current[rem.vehid]?.type) {
              return normalizeVehicleType(knownVehiclesRef.current[rem.vehid].type, rem.rnum);
            }
            const cleanRoute = String(rem.rnum || '').trim().toLowerCase();
            const liveMatch = Object.values(knownVehiclesRef.current).find(v => {
              const vr = String(v.route || v.rnum || '').trim().toLowerCase();
              return vr && vr === cleanRoute;
            });
            if (liveMatch?.type) {
              return normalizeVehicleType(liveMatch.type, rem.rnum);
            }
            if (rem.type) {
              return normalizeVehicleType(rem.type, rem.rnum);
            }
            return normalizeVehicleType(null, rem.rnum);
          };

          const currentVehType = getReminderVehicleType(activeRem);
          const currentVehIcon = currentVehType === 'tram' ? 'tram' : (currentVehType === 'minibus' ? 'airport_shuttle' : 'directions_bus');
          const displayPlate = activeRem.gosNum || liveVeh?.gosNum || "";
          const remTime = activeRem.lastTime != null ? String(activeRem.lastTime) : "";

          const isHudCompact = activeTab !== 0 || isPopupOpen;

          return (
            <div className={`reminder-topbar-stack ${isHudCompact ? 'compact' : ''}`}>
              {reminderLimitNotice && (
                <div className="reminder-limit-banner">
                  <span className="material-symbols-outlined" style={{ fontSize: "16px", color: "#d97706" }}>warning</span>
                  <span>Выбрано максимальное количество маршрутов</span>
                </div>
              )}
              <div
                key={activeRem.id}
                className={`selected-vehicle-hud reminder-topbar-hud swipe-card ${isHudCompact ? 'compact' : ''}`}
                onTouchStart={(e) => {
                  touchStartYRef.current = e.touches[0].clientY;
                  touchStartXRef.current = e.touches[0].clientX;
                }}
                onTouchEnd={(e) => {
                  if (touchStartYRef.current == null) return;
                  const deltaY = e.changedTouches[0].clientY - touchStartYRef.current;
                  const deltaX = e.changedTouches[0].clientX - touchStartXRef.current;
                  touchStartYRef.current = null;
                  touchStartXRef.current = null;

                  if (Math.abs(deltaY) > 25 || Math.abs(deltaX) > 30) {
                    if (deltaY < -25 || deltaX < -30) {
                      // Swipe UP or LEFT -> Next
                      setActiveReminderIdx(i => (i + 1) % activeRems.length);
                    } else if (deltaY > 25 || deltaX > 30) {
                      // Swipe DOWN or RIGHT -> Prev
                      setActiveReminderIdx(i => (i - 1 + activeRems.length) % activeRems.length);
                    }
                  }
                }}
                onWheel={(e) => {
                  if (activeRems.length > 1) {
                    if (e.deltaY > 15) {
                      setActiveReminderIdx(i => (i + 1) % activeRems.length);
                    } else if (e.deltaY < -15) {
                      setActiveReminderIdx(i => (i - 1 + activeRems.length) % activeRems.length);
                    }
                  }
                }}
                onClick={() => {
                  if (liveVeh) {
                    const targetRouteId = activeRem.rid || liveVeh.rid;
                    if (targetRouteId) setSelectedRoutes(prev => new Set(prev).add(targetRouteId));
                    closeAllStationPopups();
                    setIsFollowingVehicle(true);
                    isFollowingVehicleRef.current = true;
                    setSelectedVehicle({
                      rid: activeRem.rid || liveVeh.rid, id: liveVeh.id,
                      gosNum: liveVeh.gosNum || activeRem.gosNum,
                      route: activeRem.rnum || liveVeh.route, type: currentVehType,
                      lat: liveVeh.lat, lng: liveVeh.lng
                    });
                    setActiveTab(0);
                  }
                }}
              >
                <div className="hud-top-row">
                  <div className="hud-vehicle-info">
                    <div className={`hud-badge hud-badge-${currentVehType}`}>
                      <span className="material-symbols-outlined" style={{ fontSize: "15px" }}>{currentVehIcon}</span>
                      <span className="hud-route-num">{activeRem.rnum || 'Маршрут'}</span>
                    </div>
                    {displayPlate && <span className="hud-gos-num">{formatGosNum(displayPlate)}</span>}
                  </div>

                  {/* Multi-notification switcher pills: only other active reminders */}
                  {activeRems.length > 1 && (
                    <div className="hud-route-switcher" onClick={e => e.stopPropagation()}>
                      {activeRems.map((r, idx) => {
                        if (idx === currentIdx) return null;
                        const vt = getReminderVehicleType(r);
                        return (
                          <button
                            key={r.id}
                            className={`hud-switcher-pill hud-badge-${vt}`}
                            onClick={() => setActiveReminderIdx(idx)}
                            title={`Переключить на маршрут ${r.rnum || ''}`}
                          >
                            <span>{r.rnum}</span>
                          </button>
                        );
                      })}
                      <span className="hud-swipe-indicator" title="Смахните вверх/вниз для переключения">↕</span>
                    </div>
                  )}

                  <div className="hud-actions" onClick={e => e.stopPropagation()}>
                    <button
                      className="hud-notify-status-btn"
                      onClick={() => cancelArrivalReminder(activeRem.id, activeRem.rnum)}
                      title="Отключить напоминание"
                      style={{ padding: "5px 7px", borderRadius: "10px" }}
                    >
                      <span className="material-symbols-outlined hud-btn-icon" style={{ fontSize: "16px", animation: "pulse-bell 1.5s infinite ease-in-out" }}>notifications_active</span>
                    </button>
                    <button className="hud-close-btn" onClick={() => cancelArrivalReminder(activeRem.id, activeRem.rnum)} title="Отключить" aria-label="Отключить">✕</button>
                  </div>
                </div>
                <div
                  className="hud-next-station-row"
                  onClick={(e) => {
                    e.stopPropagation();
                    openStationOnMap(activeRem.sid, activeRem.stationName, activeRem.rid, activeRem.rnum, currentVehType, liveVeh);
                  }}
                  style={{ cursor: "pointer" }}
                  title="Показать остановку на карте"
                >
                  <span className="material-symbols-outlined hud-next-icon" style={{ color: "#d97706" }}>place</span>
                  <span className="hud-next-label">Остановка:</span>
                  <div className="hud-next-name-wrapper" title={activeRem.stationName}>
                    <span className={`hud-next-name ${activeRem.stationName && activeRem.stationName.length > 14 ? 'running-text' : ''}`}>
                      {activeRem.stationName}
                    </span>
                  </div>
                  {remTime !== "" && (
                    <span className={`hud-next-time ${parseInt(remTime, 10) <= 0 ? 'arriving' : ''}`} style={{ background: "#fef3c7", color: "#b45309", borderColor: "#fde68a" }}>
                      {parseInt(remTime, 10) <= 0 ? 'прибывает' : `~${remTime} мин`}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Standalone Limit Warning if 0 active reminders */}
        {!selectedVehicle && reminders.filter(r => !r.triggered).length === 0 && reminderLimitNotice && (
          <div className={`reminder-topbar-stack ${activeTab !== 0 || isPopupOpen ? 'compact' : ''}`} style={{ pointerEvents: "none" }}>
            <div className="reminder-limit-banner">
              <span className="material-symbols-outlined" style={{ fontSize: "16px", color: "#d97706" }}>warning</span>
              <span>Выбрано максимальное количество маршрутов</span>
            </div>
          </div>
        )}

        {/* Selected Vehicle Tracking HUD */}
        {selectedVehicle && (() => {
          const currentVehType = normalizeVehicleType(selectedVehicle.type, selectedVehicle.route);
          const currentVehIcon = currentVehType === 'tram' ? 'tram' : (currentVehType === 'minibus' ? 'airport_shuttle' : 'directions_bus');
          const activeRemForVeh = getActiveReminderForVehicle(selectedVehicle);
          const isHudCompact = activeTab !== 0 || isPopupOpen;

          return (
            <div className={`selected-vehicle-hud ${isHudCompact ? 'compact' : ''}`}>
              <div className="hud-top-row">
                <div className="hud-vehicle-info">
                  <div className={`hud-badge hud-badge-${currentVehType}`}>
                    <span className="material-symbols-outlined" style={{ fontSize: "15px" }}>
                      {currentVehIcon}
                    </span>
                    <span className="hud-route-num">{selectedVehicle.route || 'Маршрут'}</span>
                  </div>
                  {selectedVehicle.gosNum && (
                    <span className="hud-gos-num">{formatGosNum(selectedVehicle.gosNum)}</span>
                  )}
                  <RouteProgressRing percent={routeProgressPercent} size={30} />
                </div>

                <div className="hud-actions">
                  {activeRemForVeh && (
                    <button
                      className="hud-notify-status-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        cancelArrivalReminder(activeRemForVeh.id, activeRemForVeh.rnum);
                      }}
                      title="Напоминание активно (нажмите, чтобы отключить)"
                    >
                      <span className="material-symbols-outlined hud-btn-icon" style={{ fontSize: "15px", animation: "pulse-bell 1.5s infinite ease-in-out" }}>
                        notifications_active
                      </span>
                    </button>
                  )}
                  <button
                    className={`hud-follow-btn ${isFollowingVehicle ? 'following' : 'paused'}`}
                    onClick={toggleFollowVehicle}
                    title={isFollowingVehicle ? "Слежение активно (нажмите, чтобы остановить)" : "Возобновить слежение за транспортом"}
                  >
                    <span className={`material-symbols-outlined hud-btn-icon ${isFollowingVehicle ? 'pulse' : ''}`} style={{ fontSize: "15px" }}>
                      {isFollowingVehicle ? 'my_location' : 'near_me'}
                    </span>
                    <span>{isFollowingVehicle ? 'Слежение вкл' : 'Следить'}</span>
                  </button>

                  <button
                    className="hud-close-btn"
                    onClick={() => setSelectedVehicle(null)}
                    title="Снять выбор"
                    aria-label="Снять выбор"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {nextStationInfo && (
                <div
                  className="hud-next-station-row"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (nextStationInfo?.stid || nextStationInfo?.id || nextStationInfo?.name) {
                      openStationOnMap(
                        nextStationInfo.stid || nextStationInfo.id,
                        nextStationInfo.name,
                        selectedVehicle.rid,
                        selectedVehicle.route,
                        currentVehType,
                        selectedVehicle
                      );
                    }
                  }}
                  style={{ cursor: (nextStationInfo?.id || nextStationInfo?.name) ? "pointer" : "default" }}
                  title="Показать остановку на карте"
                >
                  <span className="material-symbols-outlined hud-next-icon">
                    {nextStationInfo.isTerminal ? 'flag' : 'arrow_forward'}
                  </span>
                  <span className="hud-next-label">
                    {nextStationInfo.isTerminal ? 'Статус:' : 'След. ост:'}
                  </span>
                  <div className="hud-next-name-wrapper" title={nextStationInfo.name}>
                    <span
                      className={`hud-next-name ${
                        nextStationInfo.name && nextStationInfo.name.length > 14 ? 'running-text' : ''
                      }`}
                    >
                      {nextStationInfo.name}
                    </span>
                  </div>
                  {nextStationInfo.time != null && nextStationInfo.time !== "" && (
                    <span className={`hud-next-time ${parseInt(nextStationInfo.time, 10) <= 0 ? 'arriving' : ''}`}>
                      {parseInt(nextStationInfo.time, 10) <= 0 ? 'прибывает' : `~${nextStationInfo.time} мин`}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })()}

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
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery("")}
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
                  {filteredStations.slice(0, stopLimit).map((st) => (
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
                  {filteredStations.length > stopLimit && (
                    <div style={{ textAlign: "center", padding: "12px 16px" }}>
                      <button
                        onClick={() => setStopLimit(prev => prev + 60)}
                        style={{
                          background: "#f1f5f9",
                          color: "#1e293b",
                          border: "1px solid #cbd5e1",
                          borderRadius: "8px",
                          padding: "8px 20px",
                          fontWeight: 600,
                          fontSize: "13px",
                          cursor: "pointer",
                          width: "100%"
                        }}
                      >
                        Показать ещё ({filteredStations.length - stopLimit} ост.)
                      </button>
                    </div>
                  )}
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
                            <div style={{ fontWeight: 700, fontSize: "16px", color: "#0f172a" }}>{st.properties.name}</div>
                            <div style={{ fontSize: "13px", fontWeight: 600, color: "#64748b", display: "flex", alignItems: "center", gap: "4px", marginTop: "2px" }}>
                              <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>
                                {st.properties.type === "bus" ? "directions_bus" : "tram"}
                              </span>
                              <span>{st.properties.type === "bus" ? "Автобус" : "Трамвай"}</span>
                            </div>
                          </div>
                        </div>
                        <span className="badge badge-bus" style={{ fontSize: "12px", padding: "4px 10px" }}>Показать</span>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* Tab 5: History Tab */}
              {activeTab === 5 && (
                <div className="history-tab-content">
                  <div className="history-tab-header">
                    <span className="history-tab-title">Недавний транспорт ({vehicleHistory.length}/9)</span>
                    {vehicleHistory.length > 0 && (
                      <button className="history-clear-btn" onClick={clearVehicleHistory} title="Очистить историю">
                        <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>delete</span>
                        <span>Очистить</span>
                      </button>
                    )}
                  </div>

                  {vehicleHistory.length === 0 ? (
                    <div className="history-empty-state">
                      <span className="material-symbols-outlined history-empty-icon">history</span>
                      <div className="history-empty-text">
                        История пуста.<br />
                        Выберите любой транспорт на карте, чтобы быстро возвращаться к нему здесь.
                      </div>
                    </div>
                  ) : (
                    <div className="history-list">
                      {sortedVehicleHistory.map((item) => {
                        const itemPlate = formatGosNum(item.gosNum).toLowerCase();
                        const itemRoute = String(item.route || '').trim().toLowerCase();
                        const live = (() => {
                          if (item.id && !String(item.id).includes('_') && knownVehiclesRef.current[item.id]) {
                            const directVeh = knownVehiclesRef.current[item.id];
                            const dRoute = String(directVeh.route || directVeh.rnum || '').trim().toLowerCase();
                            if (!itemRoute || dRoute === itemRoute) {
                              return directVeh;
                            }
                          }
                          return Object.values(knownVehiclesRef.current).find(v => {
                            const vRoute = String(v.route || v.rnum || '').trim().toLowerCase();
                            if (itemRoute && vRoute && itemRoute !== vRoute) return false;
                            if (itemPlate && v.gosNum && formatGosNum(v.gosNum).toLowerCase() === itemPlate) return true;
                            if (item.id && !String(item.id).includes('_') && v.id && String(v.id) === String(item.id)) return true;
                            return false;
                          }) || (() => {
                            if (!itemRoute && !item.rid) return null;
                            const candidates = Object.values(knownVehiclesRef.current).filter(v => {
                              const vRoute = String(v.route || v.rnum || '').trim().toLowerCase();
                              if (itemRoute && vRoute && itemRoute === vRoute) return true;
                              if (item.rid && v.rid && String(item.rid) === String(v.rid)) return true;
                              return false;
                            });
                            return candidates.length > 0 ? candidates[0] : null;
                          })();
                        })();
                        const activeReminder = getActiveReminderForVehicle(item, live);
                        const isLiveOnMap = (!!live && (Date.now() - (live._lastSeen || 0) < 60000)) || !!activeReminder;
                        const isSelected = selectedVehicle?.id === item.id || (live && selectedVehicle?.id === live.id);

                        const vehType = normalizeVehicleType(item.type, item.route);
                        const iconName = vehType === "tram" ? "tram" : (vehType === "minibus" ? "airport_shuttle" : "directions_bus");

                        const targetStation = activeReminder
                          ? (activeReminder.stationName
                              ? (activeReminder.currentTime != null
                                  ? `к «${activeReminder.stationName}» (${activeReminder.currentTime} мин)`
                                  : (activeReminder.lastTime
                                      ? `к «${activeReminder.stationName}» (${activeReminder.lastTime} мин)`
                                      : `к «${activeReminder.stationName}»`))
                              : 'Оповещение активно')
                          : '';

                        const itemNextStation = (isSelected && nextStationInfo?.name) || targetStation || item.nextStation || (live && (live.nextStation || live.destination)) || '';
                        const isNextStLong = (itemNextStation || "").length > 13;

                        const itemProgress = (() => {
                          if (isSelected && typeof routeProgressPercent === "number") {
                            return routeProgressPercent;
                          }
                          if (activeReminder) {
                            const initM = parseInt(activeReminder.initialTime, 10) || 10;
                            const curM = typeof activeReminder.currentTime === 'number'
                              ? activeReminder.currentTime
                              : (parseInt(activeReminder.lastTime || activeReminder.lastNotifiedTime, 10) || initM);
                            if (initM > 0) {
                              const pct = Math.round(((initM - Math.min(curM, initM)) / initM) * 100);
                              return Math.min(95, Math.max(15, pct));
                            }
                            return 40;
                          }
                          const target = live || item;
                          if (target) {
                            if (itemNextStation?.includes("Конечная") || target.isTerminal) {
                              return 100;
                            }
                            if (typeof target.progress === "number" && !isNaN(target.progress)) {
                              return Math.min(100, Math.max(0, Math.round(target.progress)));
                            }
                            if (typeof item.progress === "number" && !isNaN(item.progress)) {
                              return Math.min(100, Math.max(0, Math.round(item.progress)));
                            }
                          }
                          if (itemNextStation) {
                            const cleanNext = normalizeStationCompareName(itemNextStation);
                            const rids = resolveRidsForItem(item, live);
                            for (const rid of rids) {
                              const stationIds = routeStationsCacheRef.current[rid];
                              if (Array.isArray(stationIds) && stationIds.length > 1) {
                                const stopIdx = stationIds.findIndex(sid => {
                                  const st = stationsByIdRef.current.get(sid);
                                  if (!st || !st.properties?.name) return false;
                                  const sName = normalizeStationCompareName(st.properties.name);
                                  return sName.includes(cleanNext) || cleanNext.includes(sName);
                                });
                                if (stopIdx !== -1) {
                                  return Math.min(100, Math.max(0, Math.round((stopIdx / (stationIds.length - 1)) * 100)));
                                }
                              }
                            }
                          }
                          return null;
                        })();

                        return (
                          <div
                            key={item.id}
                            className={`history-card ${isSelected ? 'selected' : ''} ${!isLiveOnMap ? 'inactive' : ''}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => handleSelectVehicleFromHistory(item, live)}
                          >
                            <div className="history-card-left">
                              <div className={`hud-badge hud-badge-${vehType}`} style={{ padding: "6px 10px", borderRadius: "12px" }}>
                                <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>
                                   {iconName}
                                </span>
                                <span className="hud-route-num" style={{ fontSize: "15px", fontWeight: "800" }}>{item.route || '—'}</span>
                              </div>

                              <div className="history-card-details">
                                <div className="history-card-title-row">
                                  {(item.gosNum || (live && live.gosNum)) && (
                                    <span className="history-plate-text">{formatGosNum(item.gosNum || live.gosNum)}</span>
                                  )}
                                  <span
                                    className={`status-dot ${isLiveOnMap ? 'live' : 'offline'}`}
                                    title={isLiveOnMap ? "На линии" : "Не на линии"}
                                  />
                                </div>

                                {itemNextStation && (
                                  <div className="history-next-station-row">
                                    <span className="material-symbols-outlined history-next-icon">
                                      {itemNextStation.includes('Конечная') ? 'flag' : 'arrow_forward'}
                                    </span>
                                    <div className="running-text-wrapper">
                                      <span className={isNextStLong ? "running-text" : ""}>{itemNextStation}</span>
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="history-card-right">
                              {activeReminder && (
                                <button
                                  type="button"
                                  className="history-notify-bell-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    cancelArrivalReminder(activeReminder.id, activeReminder.rnum);
                                  }}
                                  title={`Отключить напоминание для маршрута ${item.route || ''} (${activeReminder.stationName || 'остановка'})`}
                                  aria-label="Отключить напоминание"
                                >
                                  <span className="material-symbols-outlined" style={{ fontSize: "20px" }}>
                                    notifications_active
                                  </span>
                                </button>
                              )}
                              {itemProgress != null && (
                                <RouteProgressRing percent={itemProgress} />
                              )}
                              <button
                                type="button"
                                className={`history-select-btn ${isSelected ? 'active' : ''}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleSelectVehicleFromHistory(item, live);
                                }}
                                title={isSelected ? "Слежение активно" : (isLiveOnMap ? "Показать и следить" : "Показать маршрут на карте")}
                                aria-label={isSelected ? "Слежение активно" : (isLiveOnMap ? "Показать и следить" : "Показать маршрут на карте")}
                              >
                                <span className="material-symbols-outlined" style={{ fontSize: "18px" }}>
                                  {isSelected ? 'my_location' : 'near_me'}
                                </span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
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

          <button className={activeTab === 5 ? "mui-nav-item active" : "mui-nav-item"} onClick={() => setActiveTab(activeTab === 5 ? 0 : 5)} title={`История (${vehicleHistory.length})`} aria-label="История">
            <span className="material-symbols-outlined mui-nav-icon">history</span>
          </button>

          <button className={activeTab === 3 ? "mui-nav-item active" : "mui-nav-item"} onClick={() => setActiveTab(activeTab === 3 ? 0 : 3)} title={`Избранное (${favorites.size})`} aria-label="Избранное">
            <span className="material-symbols-outlined mui-nav-icon">bookmark_star</span>
          </button>
        </div>
      </div>
    </>
  );
}
