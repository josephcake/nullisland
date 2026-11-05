/**
 * nullisland demo.
 *
 * Google Maps requires an API key for the JavaScript API, so this page asks
 * for one at runtime. Nothing is committed, and the ArcGIS layer itself is
 * public — no ArcGIS token involved.
 */

const SERVICE =
  'https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/NWS_Watches_Warnings_v1/FeatureServer';

// Pinned for reproducible demos; bump after publishing a new version.
const VERSION = '0.1.0';
const LIBRARY = `https://cdn.jsdelivr.net/npm/@offthemap/nullisland@${VERSION}/dist/index.js`;
const FALLBACK = `https://esm.sh/@offthemap/nullisland@${VERSION}`;

const STORAGE_KEY = 'nullisland.demo.key';

const LAYERS = [
  {id: 'severe', title: 'Severe', color: '#e8590c', url: `${SERVICE}/9`},
  {id: 'moderate', title: 'Moderate', color: '#f2b705', url: `${SERVICE}/10`},
  {id: 'minor', title: 'Minor', color: '#3b82f6', url: `${SERVICE}/11`},
];

const $ = (id) => document.getElementById(id);

const form = $('key-form');
const keyInput = $('key');
const rememberInput = $('remember');
const statusEl = $('status');
const layersEl = $('layers');
const forgetButton = $('forget');
const debugEl = $('debug');
const mapEl = $('map');

let engine = null;
let arcgisRequests = 0;
const logLines = [];

function log(line) {
  logLines.push(line);
  debugEl.hidden = false;
  debugEl.textContent = logLines.slice(-7).join('\n');
  console.info('[nullisland demo]', line);
}

// Count ArcGIS calls so "nothing loaded" is visible instead of silent.
const realFetch = window.fetch.bind(window);
window.fetch = (...args) => {
  const url = String(args[0]);
  if (url.includes('arcgis.com')) {
    arcgisRequests += 1;
    log(`request #${arcgisRequests} ${new URL(url).pathname.split('/').slice(-2).join('/')}`);
  }
  return realFetch(...args);
};

async function loadLibrary() {
  let lastError;
  for (const url of [LIBRARY, FALLBACK]) {
    try {
      const module = await import(url);
      log(`library loaded from ${url.includes('jsdelivr') ? 'jsDelivr' : 'esm.sh'}`);
      return module.NullIsland;
    } catch (error) {
      lastError = error;
      log(`import failed (${url.includes('jsdelivr') ? 'jsDelivr' : 'esm.sh'}): ${error.message}`);
    }
  }
  throw lastError;
}

function setStatus(message, kind = 'info') {
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

function readKey() {
  try {
    return sessionStorage.getItem(STORAGE_KEY) || localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveKey(key) {
  try {
    sessionStorage.setItem(STORAGE_KEY, key);
    if (rememberInput.checked) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be disabled; the key stays in the form for this session.
  }
}

function forgetKey() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

function loadGoogleMaps(key) {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) {
      resolve(window.google.maps);
      return;
    }

    let settled = false;
    let timer;

    const finish = (error, maps) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(maps);
    };

    timer = setTimeout(
      () => finish(new Error('Google Maps took too long to load. Check the key and your connection.')),
      20_000,
    );

    const callback = '__nullislandDemoReady';
    window[callback] = () => finish(null, window.google.maps);
    window.gm_authFailure = () =>
      finish(
        new Error(
          'Google rejected this key. Enable the Maps JavaScript API and allow this site as an HTTP referrer.',
        ),
      );

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&callback=${callback}`;
    script.async = true;
    script.onerror = () => finish(new Error('Could not download the Google Maps script.'));
    document.head.appendChild(script);
  });
}

function enableLayerToggles() {
  layersEl.hidden = false;
  forgetButton.hidden = false;

  for (const checkbox of layersEl.querySelectorAll('input[data-layer]')) {
    checkbox.disabled = false;
    checkbox.addEventListener('change', () => {
      engine?.getLayer(checkbox.dataset.layer)?.setVisible(checkbox.checked);
    });
  }
}

async function start(key) {
  setStatus('Loading Google Maps…', 'busy');

  try {
    await loadGoogleMaps(key);

    setStatus('Loading nullisland…', 'busy');
    log('Google Maps ready');
    const NullIsland = await loadLibrary();
    log(`google.maps.Data: ${typeof google.maps.Data}`);

    const map = new google.maps.Map(mapEl, {
      center: {lat: 39.5, lng: -98.35},
      zoom: 4,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      clickableIcons: false,
    });

    engine = new NullIsland({
      map,
      layers: LAYERS.map((layer) => ({
        id: layer.id,
        title: layer.title,
        url: layer.url,
        color: layer.color,
        opacity: 0.65,
        maxZoom: 12,
      })),
      indicator: true,
    });

    engine.on('error', (error) => setStatus(error.message, 'error'));
    engine.on('status', ({loading}) => {
      if (loading) setStatus('Loading layers…', 'busy');
    });

    await engine.ready;

    const states = engine.layers.map((layer) => `${layer.id}=${layer.mode}/${layer.state}`).join(' ');
    log(`layers ${states}`);
    log(`ArcGIS requests: ${arcgisRequests}`);

    if (arcgisRequests === 0) {
      setStatus('Engine loaded but made no ArcGIS requests — check the log below.', 'error');
      return;
    }

    const ready = engine.layers.filter((layer) => layer.state === 'ready').length;
    setStatus(`Ready — ${ready} layer${ready === 1 ? '' : 's'}`, 'ok');
    enableLayerToggles();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed: ${message}`);
    setStatus(message, 'error');
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const key = keyInput.value.trim();
  if (!key) {
    setStatus('Paste a Google Maps API key first.', 'error');
    return;
  }
  saveKey(key);
  // Reload so a previously failed Google script is discarded.
  location.reload();
});

forgetButton.addEventListener('click', () => {
  forgetKey();
  location.reload();
});

const savedKey = readKey();
if (savedKey) {
  keyInput.value = savedKey;
  start(savedKey);
} else {
  setStatus('Add a Google Maps API key to start. The NWS layer needs no token.');
}
