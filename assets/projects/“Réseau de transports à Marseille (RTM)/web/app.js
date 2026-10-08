/*
  RTM — Analyse par arrondissement (hexbin sécurisé)
  - Choroplèthe par arrondissement (indice_norm)
  - Grille d’hexagones Turf (≈500 m) CLIPPÉE à la commune (mask)
  - Caching: une seule génération de grille + une seule couche Leaflet
  - Points d’arrêts en circleMarker, cluster/non‑cluster, taille toggle
  - KPI/graph: global et par arrondissement
*/
/* global L, turf, Chart */

// Données (depuis la racine du projet)
const PATH_STATS = "./assets/data/arrondissements_stats.geojson";
const PATH_STOPS = "./assets/data/rtm_stops.geojson";
const PATH_BOUND = "./assets/data/Marseille.geojson";

// Palette sombre (0→100) Plus desservi → Moins desservi
const MODE_KEYS = ['metro','tram','bus'];
const MODE_COLORS = {
  metro: '#e74c3c',
  tram: '#3498db',
  bus: '#2ecc71',
  default: '#bdc3c7'
};
const MODE_LABELS = {
  metro: 'Métro',
  tram: 'Tram',
  bus: 'Bus'
};
const PALETTE = ["#0b2e13","#145a32","#1e7d3d","#2ea84f","#4fd36a"];
const clamp = (v,a,b)=>Math.max(a, Math.min(b,v));
const colorFor = v => { const t = clamp((Number(v)||0)/100, 0, 0.999); return PALETTE[Math.floor(t*PALETTE.length)]; };
function colorFromPalette(palette, t){
  const clamped = clamp(t,0,0.999);
  return palette[Math.floor(clamped*palette.length)];
}
const colorForHex = (value)=> colorFromPalette(HEX_COLORS, normalizeHexValue(value));

function normalizeMode(modeRaw){
  const value = String(modeRaw||'').toLowerCase();
  if (value.includes('metro') || value.includes('subway')) return 'metro';
  if (value.includes('tram')) return 'tram';
  if (value.includes('bus')) return 'bus';
  return null;
}
function getStopColor(mode){ const key = normalizeMode(mode); return MODE_COLORS[key] || MODE_COLORS.default; }
function getModeLabel(mode){ const key = normalizeMode(mode); return MODE_LABELS[key] || 'Mode inconnu'; }

// Carte
const map = L.map('map', { preferCanvas:true }).setView([43.30, 5.38], 11);
const BASEMAPS = {
  'OSM Standard': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, attribution:'© OSM' }),
  'Carto Positron': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom:20, maxNativeZoom:16, attribution:'Tiles © Esri' }),
  'Carto DarkMatter': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom:20, maxNativeZoom:16, attribution:'Tiles © Esri' }),
  'Esri Imagery': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom:19, attribution:'Tiles © Esri' })
};
BASEMAPS['OSM Standard'].addTo(map);
map.createPane('arrPane'); map.getPane('arrPane').style.zIndex = 400;
map.createPane('hexPane'); map.getPane('hexPane').style.zIndex = 450;
map.createPane('boundaryPane'); map.getPane('boundaryPane').style.zIndex = 650;
map.createPane('stopsPane'); map.getPane('stopsPane').style.zIndex = 700;

L.control.layers(BASEMAPS, null, { position:'topright', collapsed:true }).addTo(map);

const scheduleIdle = typeof window.requestIdleCallback === 'function'
  ? (cb)=>window.requestIdleCallback(()=>cb())
  : (cb)=>setTimeout(cb,16);

function getDominantModeFromMarkers(markers){
  const counts = {};
  MODE_KEYS.forEach(k=> counts[k]=0);
  markers.forEach(marker=>{
    const key = marker && marker.__modeKey;
    if (key && counts[key]!=null) counts[key] += 1;
  });
  let winner=null, best=0, tie=false;
  MODE_KEYS.forEach(key=>{
    const value = counts[key];
    if (value>best){
      best=value;
      winner=key;
      tie=false;
    } else if (value===best && value>0){
      tie=true;
    }
  });
  if (!best || tie) return null;
  return winner;
}
function createStopClusterIcon(cluster){
  const dominant = getDominantModeFromMarkers(cluster.getAllChildMarkers());
  const borderColor = dominant ? MODE_COLORS[dominant] : MODE_COLORS.default;
  const total = cluster.getChildCount();
  return L.divIcon({
    html: `<div style="border-color:${borderColor}"><span>${total}</span></div>`,
    className: 'rtm-cluster-icon',
    iconSize: [40,40]
  });
}

// Groupes
let choroplethLayer=null;
const hexLayerGroup = L.layerGroup();
const boundaryGroup = L.layerGroup().addTo(map);

// Arrêts: cluster + non‑cluster
const stopsCluster = L.markerClusterGroup({ disableClusteringAtZoom: 17, iconCreateFunction: createStopClusterIcon });
const stopsLayer = L.layerGroup();
map.addLayer(stopsCluster);

// État global
let STATS=null, ALL_STOPS=[]; let nameField='arr_name', selectedName=null;
let showChoro=false, showHex=false;
let MARSEILLE_POLY=null; const hexCellM=900;
let hexGridGeoJSON=null; let hexLayer=null; let hexBuilding=false; let hexGridPromise=null; let hexMaxCount=0;
let useCluster=true, smallPoints=false; const RADIUS_NORMAL=5.5, RADIUS_SMALL=3; let currentRadius=RADIUS_NORMAL;
const ARR_NAME_MAP = new Map();
let ARR_INDEX = [];
let STOP_CACHE = [];
let stopCacheReady=false;
let stopCachePromise=null;
const STOP_BATCH_SIZE = 250;
const HEX_BATCH_SIZE = 40;
const HEX_COLORS = ['#0b3d1b','#14652b','#1f8b3b','#2fbf4f','#3efc66'];
const HEX_BORDER_COLOR = '#0a2a12';
const HEX_BORDER_WEIGHT = 0.6;
const HEX_FILL_OPACITY = 0.85;
const HEX_DIM_OPACITY = 0.25;
function normalizeHexValue(value){
  const numeric = Number(value) || 0;
  const normalized = numeric > 1 ? numeric / 100 : numeric;
  return clamp(normalized, 0, 0.999);
}

// UI
// Multi-sélecteur comparaison
const arrSelect=document.getElementById('arrSelect');
const btnClearCompare=document.getElementById('btn-clear-compare');
const btnCity=document.getElementById('btn-city');
const chkCompare=document.getElementById('chk-compare');
const btnToggleCluster=document.getElementById('btn-toggle-cluster');
const btnSmallerPoints=document.getElementById('btn-smaller-points');
const btnToggleChoropleth=document.getElementById('btn-toggle-choropleth');
const btnToggleHexbin=document.getElementById('btn-toggle-hexbin');
const filterBtnBus=document.getElementById('filter-bus');
const filterBtnTram=document.getElementById('filter-tram');
const filterBtnMetro=document.getElementById('filter-metro');
const kpiTotal=document.getElementById('kpi-total');
const kpiDens=document.getElementById('kpi-densite');
const kpiInd=document.getElementById('kpi-indice');
const lgSource=document.getElementById('lg-source');
const legendGradientEl=document.getElementById('lg-gradient');
const legendContainer=document.querySelector('.legend');
const sidebarEl=document.querySelector('.sidebar');
const sidebarToggleBtn=document.getElementById('sidebar-toggle');
const sidebarBackdrop=document.getElementById('sidebar-backdrop');
const resizeHandle=document.getElementById('resize-handle');
const logoButtons=document.querySelectorAll('.partner-logo-btn');
const logoModal=document.getElementById('logo-modal');
const logoModalImg=document.getElementById('logo-modal-img');
const logoModalClose=document.getElementById('logo-modal-close');

let chart=null;
// Graphiques comparaison
let cmpChartModes=null; // barres groupées (bus/tram/métro) par arrondissement
let cmpChartInd=null;   // radar des indicateurs (Total, Densité, Indice)
// État de sélection et mode
let modeCompare=false;
let selectedArr=[]; // liste de noms sélectionnés
const selectedArrLayer = L.layerGroup().addTo(map); // polygones de sélection (surcouche)
const modeFilterState = { bus:true, tram:true, metro:true };

// Debounce helper
function debounce(fn, delay){ let t=null; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), delay); }; }
const applySelection = debounce((names, layer)=> selectArrondissements(names, layer), 80);

if(typeof Chart !== 'undefined'){
  Chart.defaults.animation.duration = 500;
  Chart.defaults.animation.easing = 'easeOutQuart';
  Chart.defaults.transitions.active.animation.duration = 350;
}
if(sidebarEl){
  requestAnimationFrame(()=> sidebarEl.classList.add('is-ready'));
}

const SIDEBAR_MIN_WIDTH = 320;
const SIDEBAR_MAX_WIDTH = 600;
const sidebarMediaQuery = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(max-width: 900px)')
  : null;
let resizeActive=false;
let resizeRaf=null;
function setSidebarOpen(open){
  document.body.classList.toggle('sidebar-open', !!open);
  if(sidebarToggleBtn){
    const label = open ? 'Masquer le tableau de bord' : 'Afficher le tableau de bord';
    sidebarToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    sidebarToggleBtn.setAttribute('aria-label', label);
    sidebarToggleBtn.textContent = label;
  }
}
if(sidebarToggleBtn){
  sidebarToggleBtn.addEventListener('click', ()=>{
    setSidebarOpen(!document.body.classList.contains('sidebar-open'));
  });
}
if(sidebarBackdrop){
  sidebarBackdrop.addEventListener('click', ()=> setSidebarOpen(false));
}
function scheduleMapResize(){
  if(resizeRaf) return;
  resizeRaf = requestAnimationFrame(()=>{
    resizeRaf=null;
    map.invalidateSize();
  });
}
function applySidebarWidth(widthPx){
  const clamped = clamp(widthPx, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
  document.documentElement.style.setProperty('--sidebar', `${clamped}px`);
  scheduleMapResize();
}
function startResize(){
  if(resizeActive || (sidebarMediaQuery && sidebarMediaQuery.matches)) return;
  resizeActive=true;
  document.body.classList.add('is-resizing');
  document.addEventListener('mousemove', handleResizeMove);
  document.addEventListener('mouseup', stopResize);
}
function handleResizeMove(evt){
  if(!resizeActive || !sidebarEl) return;
  evt.preventDefault();
  const rect = sidebarEl.getBoundingClientRect();
  const proposed = evt.clientX - rect.left;
  applySidebarWidth(proposed);
}
function stopResize(){
  if(!resizeActive) return;
  resizeActive=false;
  document.body.classList.remove('is-resizing');
  document.removeEventListener('mousemove', handleResizeMove);
  document.removeEventListener('mouseup', stopResize);
}
if(resizeHandle){
  resizeHandle.addEventListener('mousedown', (evt)=>{
    if(evt.button !== 0) return;
    evt.preventDefault();
    startResize();
  });
}
if(sidebarMediaQuery){
  const handleSidebarMedia = (mq)=> setSidebarOpen(!mq.matches);
  handleSidebarMedia(sidebarMediaQuery);
  if(typeof sidebarMediaQuery.addEventListener === 'function'){
    sidebarMediaQuery.addEventListener('change', handleSidebarMedia);
  } else if(typeof sidebarMediaQuery.addListener === 'function'){
    sidebarMediaQuery.addListener(handleSidebarMedia);
  }
} else {
  setSidebarOpen(true);
}

function applyLegendGradient(colors){
  if(legendGradientEl) legendGradientEl.style.background=`linear-gradient(90deg, ${colors.join(',')})`;
}
function refreshLegendGradient(){
  applyLegendGradient(showHex ? HEX_COLORS : PALETTE);
}
function updateLegendLabel(){
  if(!lgSource) return;
  if(showChoro && showHex){
    lgSource.textContent='Hexagones';
  } else if(showChoro){
    lgSource.textContent='Arrondissements';
  } else {
    lgSource.textContent='';
  }
}
function setLegendVisibility(visible){
  if(!legendContainer) return;
  legendContainer.classList.toggle('is-visible', !!visible);
}
function syncLegendUI(){
  setLegendVisibility(showChoro);
  updateLegendLabel();
}
function updateChoroplethButton(){
  if(!btnToggleChoropleth) return;
  btnToggleChoropleth.textContent = showChoro ? 'Désactiver le choroplèthe' : 'Activer le choroplèthe';
}
function setChoroplethVisibility(visible){
  if(!choroplethLayer) return;
  showChoro = !!visible;
  if(showChoro){
    if(!map.hasLayer(choroplethLayer)) choroplethLayer.addTo(map);
  } else if(map.hasLayer(choroplethLayer)){
    map.removeLayer(choroplethLayer);
  }
  updateChoroplethButton();
  syncLegendUI();
}
function isModeEnabled(modeKey){
  if(!modeKey) return true;
  return modeFilterState[modeKey] !== false;
}
function updateModeFilterButtons(){
  const mapping = [
    ['bus', filterBtnBus],
    ['tram', filterBtnTram],
    ['metro', filterBtnMetro]
  ];
  mapping.forEach(([mode, btn])=>{
    if(!btn) return;
    const active = modeFilterState[mode];
    btn.classList.toggle('is-active', !!active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}
function toggleModeFilter(mode){
  if(!(mode in modeFilterState)) return;
  modeFilterState[mode] = !modeFilterState[mode];
  updateModeFilterButtons();
  rebuildStopsInside(new Set(selectedArr));
}
updateModeFilterButtons();
updateChoroplethButton();
syncLegendUI();

function animateElement(el, duration=320, className='is-animating'){
  if(!el) return;
  if(el.__animTimer) clearTimeout(el.__animTimer);
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
  el.__animTimer = setTimeout(()=> el.classList.remove(className), duration);
}
function triggerKPIAnimation(){
  [kpiTotal,kpiDens,kpiInd].forEach(el=> animateElement(el, 320));
}
function animateComparisonSection(){
  const cmpModes=document.getElementById('cmpModes');
  const cmpIndicators=document.getElementById('cmpIndicators');
  const cmpRanks=document.getElementById('cmp-ranks');
  [cmpModes, cmpIndicators, cmpRanks].forEach(el=> animateElement(el, 400, 'comparison-animate'));
}

function prepareArrIndex(){
  ARR_NAME_MAP.clear();
  ARR_INDEX = [];
  STOP_CACHE = [];
  stopCacheReady = false;
  if(!STATS?.features) return;
  STATS.features.forEach(f=>{
    const nm = f.properties?.[nameField];
    if(!nm) return;
    ARR_NAME_MAP.set(nm, f);
    let bbox=null;
    try{ bbox = turf.bbox(f); }catch(e){ bbox=null; }
    ARR_INDEX.push({ name:nm, feature:f, bbox });
  });
}
function locateArrondissementForStop(coords, arrIndexSnapshot){
  if(!Array.isArray(arrIndexSnapshot) || !arrIndexSnapshot.length) return null;
  let pointFeature=null;
  for(const entry of arrIndexSnapshot){
    if(!entry?.feature) continue;
    if(entry.bbox){
      const [minLng,minLat,maxLng,maxLat]=entry.bbox;
      const [lng,lat]=coords;
      if(lng<minLng || lng>maxLng || lat<minLat || lat>maxLat) continue;
    }
    try{
      if(!pointFeature) pointFeature = turf.point(coords);
      if(turf.booleanPointInPolygon(pointFeature, entry.feature)) return entry.name;
    }catch(err){ console.error('stop arrondissement lookup failed', err); }
  }
  return null;
}
function buildStopMarker(lat,lng,color,radius){
  return L.circleMarker([lat,lng],{ pane:'stopsPane', radius, color, weight:1, fillColor:color, fillOpacity:0.85, stroke:true });
}
function getStopArrNameFromProps(props){
  if(!props) return null;
  const keys = [nameField,'arr_name','arrondissement','arr','district','nom_arr'];
  for(const key of keys){
    if (props[key]) return props[key];
  }
  return null;
}
function ensureStopCache(){
  if(stopCacheReady) return Promise.resolve(STOP_CACHE);
  if(stopCachePromise) return stopCachePromise;
  if(!ALL_STOPS?.length){
    stopCacheReady = true;
    STOP_CACHE = [];
    return Promise.resolve(STOP_CACHE);
  }
  console.time?.('stop-cache-build');
  const arrIndexSnapshot = ARR_INDEX.slice();
  const nextCache=[];
  let idx=0;
  stopCachePromise = new Promise((resolve)=>{
    const processBatch = ()=>{
      let processed=0;
      while(idx<ALL_STOPS.length && processed<STOP_BATCH_SIZE){
        const feature = ALL_STOPS[idx];
        try{
          const coords = feature?.geometry?.coordinates;
          if(Array.isArray(coords) && coords.length>=2){
            const [lng,lat]=coords;
            const rawMode = feature.properties?.main_mode || feature.properties?.mode || '';
            const normalizedMode = normalizeMode(rawMode);
            const color = getStopColor(rawMode);
            const label = normalizedMode ? MODE_LABELS[normalizedMode] : getModeLabel(rawMode);
            const title = feature.properties?.stop_name || `Arrêt ${idx+1}`;
            const html = `<b>${title}</b><br>${label}`;
            const arrName = getStopArrNameFromProps(feature.properties) || locateArrondissementForStop([lng,lat], arrIndexSnapshot);
            const clusteredMarker = buildStopMarker(lat,lng,color,RADIUS_NORMAL);
            clusteredMarker.__modeKey = normalizedMode;
            clusteredMarker.__arrName = arrName;
            const simpleMarker = buildStopMarker(lat,lng,color,currentRadius);
            simpleMarker.__modeKey = normalizedMode;
            simpleMarker.__arrName = arrName;
            clusteredMarker.bindPopup(html);
            simpleMarker.bindPopup(html);
            nextCache.push({ arrName, clusteredMarker, simpleMarker, modeKey: normalizedMode });
          }
        }catch(err){ console.error('stop cache build failed', err); }
        idx++; processed++;
      }
      if(idx < ALL_STOPS.length){
        scheduleIdle(processBatch);
        return;
      }
      STOP_CACHE = nextCache;
      stopCacheReady = true;
      console.timeEnd?.('stop-cache-build');
      console.log('Stop cache ready:', STOP_CACHE.length, 'markers');
      resolve(STOP_CACHE);
    };
    scheduleIdle(processBatch);
  }).catch(err=>{
    console.error('ensureStopCache failed', err);
    return [];
  }).finally(()=>{
    stopCachePromise=null;
  });
  return stopCachePromise;
}

// Choroplèthe
function buildChoropleth(){
  if(choroplethLayer && map.hasLayer(choroplethLayer)) map.removeLayer(choroplethLayer);
  choroplethLayer=null;
  if(!STATS) return;
  choroplethLayer=L.geoJSON(STATS,{ pane:'arrPane', filter:f=>['Polygon','MultiPolygon'].includes(f.geometry?.type), style:f=>({ color:'#334155', weight:1, fillColor: colorFor(Math.round(f.properties?.indice_norm||0)), fillOpacity:0.6 }), onEachFeature:(f,l)=>{ const nm=f.properties?.[nameField]||'Arrondissement'; l.bindPopup(`<b>${nm}</b><br>Indice: ${Math.round(f.properties?.indice_norm||0)}`); l.on('click',(e)=>handleArrClick(nm,l,e)); } });
  if(showChoro && choroplethLayer) choroplethLayer.addTo(map);
}

// Hexagones — construction unique + cache
function buildHexGridOnce(){
  if (hexGridGeoJSON) return Promise.resolve(hexGridGeoJSON);
  if (hexGridPromise) return hexGridPromise;
  if (!MARSEILLE_POLY || !ALL_STOPS.length){
    console.error('Impossible de construire la grille: données manquantes');
    return Promise.reject(new Error('Hex data unavailable'));
  }
  hexBuilding = true;
  console.time?.('hex-grid-build');
  let grid=null;
  let features=[];
  let idx=0;
  let pts=null;
  let maxCount=0;
  hexGridPromise = new Promise((resolve, reject)=>{
    const processBatch = ()=>{
      try{
        if(!grid){
          const bbox = turf.bbox(MARSEILLE_POLY);
          grid = turf.hexGrid(bbox, hexCellM/1000, { units:'kilometers', mask: MARSEILLE_POLY });
          grid.features = grid.features.filter(h=>{ try{ return turf.booleanPointInPolygon(turf.centroid(h), MARSEILLE_POLY); }catch(e){ return false; } });
          features = grid.features;
          pts=turf.featureCollection(ALL_STOPS.map(s=>turf.point(s.geometry.coordinates, s.properties)));
        }
        let processed=0;
        while(idx<features.length && processed<HEX_BATCH_SIZE){
          const cell = features[idx];
          const inside=turf.pointsWithinPolygon(pts,cell).features;
          const count = inside.length;
          const props={ count, count_norm:0 };
          try{ props.__centroid = turf.centroid(cell); }catch(e){ props.__centroid=null; }
          cell.properties=props;
          if(count>maxCount) maxCount=count;
          idx++; processed++;
        }
        if(idx<features.length){
          scheduleIdle(processBatch);
          return;
        }
        const divisor = Math.max(maxCount,1);
        features.forEach(cell=>{
          cell.properties.count_norm = cell.properties.count / divisor;
        });
        hexGridGeoJSON = grid;
        hexMaxCount = maxCount;
        console.timeEnd?.('hex-grid-build');
        console.log('Hex grid ready:', features.length, 'cells', 'max', maxCount);
        hexBuilding=false;
        const result=hexGridGeoJSON;
        hexGridPromise=null;
        resolve(result);
      } catch(err){
        hexBuilding=false;
        hexGridPromise=null;
        console.error('Hex grid build failed:', err);
        reject(err);
      }
    };
    scheduleIdle(processBatch);
  });
  return hexGridPromise;
}

// Couche unique à partir du cache
function ensureHexLayer(){
  if(!hexGridGeoJSON) return null;
  if(hexLayer) return hexLayer;
  try{
    hexLayer = L.geoJSON(hexGridGeoJSON,{
      pane:'hexPane',
      style:f=>{
        const v=(f&&f.properties&&Number(f.properties.count_norm))||0;
        let op=HEX_FILL_OPACITY;
        const targetArr = selectedName ? ARR_NAME_MAP.get(selectedName) : null;
        if(targetArr){
          let centroidFeature = f?.properties?.__centroid;
          if(!centroidFeature){
            try{
              centroidFeature = turf.centroid(f);
              if(!f.properties) f.properties={};
              f.properties.__centroid = centroidFeature;
            }catch(e){ centroidFeature=null; }
          }
          if(centroidFeature){
            try{
              if(!turf.booleanPointInPolygon(centroidFeature, targetArr)) op=HEX_DIM_OPACITY;
            }catch(e){ console.error('ensureHexLayer centroid check failed', e); }
          }
        }
        return { color:HEX_BORDER_COLOR, weight:HEX_BORDER_WEIGHT, fillColor: colorForHex(v*100), fillOpacity: op };
      },
      onEachFeature:(f,l)=>{
        const cnt=f?.properties?.count??0;
        l.bindPopup(`Arrêts: ${cnt}`);
      }
    });
  } catch(e){ console.error('Hex layer creation failed:', e); hexLayer=null; }
  return hexLayer;
}

// Mise à jour du style (pas de recompute)
function updateHexStyles(){
  if(!hexLayer) return;
  try{
    hexLayer.eachLayer(l=>{
      const f=l.feature;
      const v=(f&&f.properties&&Number(f.properties.count_norm))||0;
      l.setStyle({ color:HEX_BORDER_COLOR, weight:HEX_BORDER_WEIGHT, fillColor: colorForHex(v*100), fillOpacity:HEX_FILL_OPACITY });
    });
  }catch(e){ console.warn('updateHexStyles failed:', e); }
}
// Variante multi: opacité réduite si le centroïde n'est dans aucun des arrondissements sélectionnés
function updateHexStylesMulti(nameSet){
  if(!hexLayer) return;
  const targetPolys = (nameSet && nameSet.size) ? Array.from(nameSet).map(n=> ARR_NAME_MAP.get(n)).filter(Boolean) : null;
  try{
    hexLayer.eachLayer(l=>{
      const f=l.feature;
      const v=(f&&f.properties&&Number(f.properties.count_norm))||0;
      let op=HEX_FILL_OPACITY;
      if(targetPolys && targetPolys.length){
        let centroidFeature = f?.properties?.__centroid;
        if(!centroidFeature){
          try{
            centroidFeature = turf.centroid(f);
            if(!f.properties) f.properties={};
            f.properties.__centroid = centroidFeature;
          }catch(err){ centroidFeature=null; }
        }
        if(centroidFeature){
          const inside = targetPolys.some(poly=>{
            if(!poly) return false;
            try{ return turf.booleanPointInPolygon(centroidFeature, poly); }
            catch(err){ console.error('hex centroid check failed', err); return false; }
          });
          if(!inside) op=HEX_DIM_OPACITY;
        }
      }
      l.setStyle({ color:HEX_BORDER_COLOR, weight:HEX_BORDER_WEIGHT, fillColor: colorForHex(v*100), fillOpacity: op });
    });
  }catch(e){ console.warn('updateHexStylesMulti failed:', e); }
}

// KPI / Graph
function computeGlobalProps(){ if(!STATS||!STATS.features?.length) return null; const fs=STATS.features.map(f=>({p:f.properties||{}, g:f})); const sum=k=>fs.reduce((a,o)=>a+(+o.p[k]||0),0); const mean=k=>{ const arr=fs.map(o=>+o.p[k]).filter(Number.isFinite); return arr.length? arr.reduce((a,b)=>a+b,0)/arr.length:0; }; return { [nameField]:'Marseille (global)', arrets_total:sum('arrets_total'), densite_km2:mean('densite_km2'), indice_norm:mean('indice_norm'), bus:sum('bus'), tram:sum('tram'), metro:sum('metro') }; }

// Agrégats pour une sélection multiple d'arrondissements
function computeSelectionProps(names){
  if (!Array.isArray(names) || !names.length) return computeGlobalProps();
  const feats = names.map(n=> ARR_NAME_MAP.get(n)).filter(Boolean);
  if(!feats.length) return computeGlobalProps();
  const sum = (k)=> feats.reduce((a,f)=> a + (+f.properties?.[k]||0), 0);
  // Densité moyenne pondérée par surface calculée à partir de la géométrie
  let num=0, denom=0;
  feats.forEach(f=>{ try{ const area=turf.area(f)/1e6; const d=Number(f.properties?.densite_km2)||0; if(area>0){ num += d*area; denom += area; } }catch(e){} });
  const densPonderee = denom>0 ? (num/denom) : 0;
  const indiceMoy = feats.length? feats.reduce((a,f)=> a + (Number(f.properties?.indice_norm)||0), 0)/feats.length : 0;
  return {
    names, arrets_total: sum('arrets_total'), densite_km2: densPonderee, indice_norm: indiceMoy,
    bus: sum('bus'), tram: sum('tram'), metro: sum('metro')
  };
}
function updateKPIsFromProps(p){
  const src=p||computeGlobalProps()||{};
  kpiTotal.textContent=String(src.arrets_total||0);
  kpiDens.textContent=src.densite_km2!=null? String(Number(src.densite_km2).toFixed(2)):'-';
  kpiInd.textContent=src.indice_norm!=null? String(Math.round(src.indice_norm)):'-';
  triggerKPIAnimation();
}
function updateChartFromProps(p){
  const src=p||computeGlobalProps()||{bus:0,tram:0,metro:0};
  const labels = MODE_KEYS.map(k=> MODE_LABELS[k]);
  const colors = MODE_KEYS.map(k=> MODE_COLORS[k]);
  const values = MODE_KEYS.map(k=> src[k] || 0);
  const data={ labels, datasets:[{ label:'Arrêts', backgroundColor:colors, borderColor:colors, borderWidth:1, data:values }] };
  const ctx=document.getElementById('modeBar');
  if(!ctx) return;
  const chartOptions = {
    responsive:true,
    animation:{ duration:500, easing:'easeOutCubic' },
    transitions:{ active:{ animation:{ duration:350, easing:'easeOutQuad' } } },
    plugins:{ legend:{ display:false } },
    scales:{ y:{ beginAtZero:true } }
  };
  if(chart){
    chart.data=data;
    chart.update('active');
  } else {
    chart=new Chart(ctx,{ type:'bar', data, options:chartOptions });
  }
}

// Graphiques de comparaison
function buildComparisonCharts(names){
  const labels = names && names.length ? names : [];
  const feats = labels.length ? labels.map(n=> ARR_NAME_MAP.get(n)).filter(Boolean) : [];
  // Données par mode
  const bus = feats.map(f=> +f.properties?.bus || 0);
  const tram = feats.map(f=> +f.properties?.tram || 0);
  const metro = feats.map(f=> +f.properties?.metro || 0);
  const ctx1 = document.getElementById('cmpModes');
  if (ctx1){
    const data1 = { labels, datasets:[
      { label:MODE_LABELS.bus, backgroundColor:MODE_COLORS.bus, data: bus },
      { label:MODE_LABELS.tram, backgroundColor:MODE_COLORS.tram, data: tram },
      { label:MODE_LABELS.metro, backgroundColor:MODE_COLORS.metro, data: metro }
    ]};
    const cmpOptions = {
      responsive:true,
      animation:{ duration:500, easing:'easeOutQuart' },
      transitions:{ active:{ animation:{ duration:350 } } },
      plugins:{ legend:{ position:'bottom' } },
      scales:{ x:{ stacked:false }, y:{ beginAtZero:true } }
    };
    if (cmpChartModes){
      cmpChartModes.data=data1;
      cmpChartModes.update('active');
    } else {
      cmpChartModes = new Chart(ctx1, { type:'bar', data:data1, options:cmpOptions });
    }
  }
  // Indicateurs
  const ctx2 = document.getElementById('cmpIndicators');
  if (ctx2){
    const city = computeGlobalProps() || { arrets_total:0, densite_km2:0, indice_norm:0 };
    const metrics = ['Total','Densité','Indice'];
    let datasets = [];
    if (feats.length === 1){
      const f = feats[0].properties;
      datasets = [
        { label: feats[0].properties?.[nameField] || 'Arrondissement', data: [ +f.arrets_total||0, +f.densite_km2||0, +f.indice_norm||0 ], borderColor:'#2563eb', backgroundColor:'rgba(37,99,235,.2)' },
        { label: 'Ville (moyenne)', data: [ +city.arrets_total||0, +city.densite_km2||0, +city.indice_norm||0 ], borderColor:'#94a3b8', backgroundColor:'rgba(148,163,184,.2)' }
      ];
    } else if (feats.length > 1){
      datasets = feats.map((f,i)=>({ label: f.properties?.[nameField]||`A${i+1}`, data: [ +f.properties?.arrets_total||0, +f.properties?.densite_km2||0, +f.properties?.indice_norm||0 ], borderColor:'#2563eb', backgroundColor:'rgba(37,99,235,.15)' }));
    } else {
      datasets = [{ label:'Ville (moyenne)', data:[ +city.arrets_total||0, +city.densite_km2||0, +city.indice_norm||0 ], borderColor:'#94a3b8', backgroundColor:'rgba(148,163,184,.2)' }];
    }
    const radarOptions = {
      responsive:true,
      animation:{ duration:550, easing:'easeOutCubic' },
      transitions:{ active:{ animation:{ duration:400 } } },
      plugins:{ legend:{ position:'bottom' } },
      scales:{ r:{ beginAtZero:true } }
    };
    if (cmpChartInd){
      cmpChartInd.data={ labels:metrics, datasets };
      cmpChartInd.update('active');
    } else {
      cmpChartInd = new Chart(ctx2, { type:'radar', data:{ labels:metrics, datasets }, options:radarOptions });
    }
  }
  // Rangs simples (top/min/max) pour les arrondissements selectionnes
  const ranks = document.getElementById('cmp-ranks');
  if (ranks){
    if (feats.length){
      const by = (key)=> feats.slice().sort((a,b)=> (+b.properties?.[key]||0) - (+a.properties?.[key]||0));
      const topTotal = by('arrets_total')[0];
      const topDens = by('densite_km2')[0];
      const topIdx = by('indice_norm')[0];
      ranks.innerHTML = `Top arrets: <b>${topTotal.properties?.[nameField]}</b> - ${topTotal.properties?.arrets_total} - `+
                        `Top densite: <b>${topDens.properties?.[nameField]}</b> - ${(+(topDens.properties?.densite_km2)).toFixed(2)} - `+
                        `Top indice: <b>${topIdx.properties?.[nameField]}</b> - ${Math.round(+topIdx.properties?.indice_norm)}`;
    } else {
      ranks.innerHTML = '';
    }
  }
  animateComparisonSection();
}

// Arrêts
function rebuildStopsInside(selectedNamesSet){
  const namesSet = selectedNamesSet instanceof Set ? selectedNamesSet : new Set();
  const hasFilter = namesSet.size>0;
  const renderStops = ()=>{
    stopsCluster.clearLayers(); stopsLayer.clearLayers();
    if(!STOP_CACHE.length) return;
    STOP_CACHE.forEach(entry=>{
      if(hasFilter && (!entry.arrName || !namesSet.has(entry.arrName))) return;
      if(!isModeEnabled(entry.modeKey)) return;
      stopsCluster.addLayer(entry.clusteredMarker);
      stopsLayer.addLayer(entry.simpleMarker);
    });
  };
  if(stopCacheReady){
    renderStops();
  } else {
    stopsCluster.clearLayers(); stopsLayer.clearLayers();
    ensureStopCache().then(()=> renderStops()).catch(err=> console.error('rebuildStopsInside failed', err));
  }
}
function applyStopsLayerToggle(){
  if(useCluster){
    if(!map.hasLayer(stopsCluster)) map.addLayer(stopsCluster);
    if(map.hasLayer(stopsLayer)) map.removeLayer(stopsLayer);
    if(btnToggleCluster) btnToggleCluster.textContent='Désactiver le clustering';
  } else {
    if(map.hasLayer(stopsCluster)) map.removeLayer(stopsCluster);
    if(!map.hasLayer(stopsLayer)) map.addLayer(stopsLayer);
    if(btnToggleCluster) btnToggleCluster.textContent='Activer le clustering';
  }
}
function applyPointSize(){
  currentRadius=smallPoints?RADIUS_SMALL:RADIUS_NORMAL;
  stopsLayer.eachLayer(l=>{ if(typeof l.setRadius==='function') l.setRadius(currentRadius); });
  if(STOP_CACHE.length){
    STOP_CACHE.forEach(entry=>{ try{ entry.simpleMarker.setRadius(currentRadius); }catch(e){} });
  }
  if(btnSmallerPoints) btnSmallerPoints.textContent= smallPoints? 'Taille normale des points':'Réduire la taille des points';
}

// Sélection
function fitToFeature(layer){ try{ map.fitBounds(layer.getBounds(),{padding:[20,20]}); }catch(e){} }
// Couleurs stables par nom (pour bords multiples)
function colorForName(name){ let h=0; for(let i=0;i<name.length;i++) h=(h*31 + name.charCodeAt(i))>>>0; const hues=[10,35,200,260,140,300,20,180,90,0]; return `hsl(${hues[h%hues.length]} 85% 45%)`; }

// Met à jour la surcouche des polygones sélectionnés (style focus / multi)
function renderSelectedLayer(names){
  selectedArrLayer.clearLayers();
  if (!Array.isArray(names) || !names.length) return;
  const feats = names.map(n=> ARR_NAME_MAP.get(n)).filter(Boolean);
  feats.forEach(f=>{
    const single = names.length===1;
    const color = single ? '#f59e0b' : colorForName(f.properties?.[nameField]||'A');
    const style = single ? { color, weight:3, fillColor: color, fillOpacity:0.1 } : { color, weight:2, fillOpacity:0.08 };
    L.geoJSON(f, { style }).addTo(selectedArrLayer);
  });
}

// Applique styles atténués au choroplèthe selon sélection
function applyChoroplethSelection(namesSet){
  try{
    if(!choroplethLayer) return;
    choroplethLayer.eachLayer(l=>{ const nm=l.feature?.properties?.[nameField]; const selected = !namesSet || namesSet.size===0 || namesSet.has(nm); const baseFill = colorFor(Math.round(l.feature?.properties?.indice_norm||0)); l.setStyle && l.setStyle({ fillOpacity: selected? 0.6 : 0.2, fillColor: baseFill, color:'#334155', weight:1 }); });
  }catch(e){}
}

// Sélection mono/multi via carte et sélecteur
function selectArrondissements(names, layer){
  const set = new Set(names||[]);
  selectedArr = Array.from(set);
  selectedName = (set.size===1) ? selectedArr[0] : null;
  // Style des polygones choroplèthe: atténuer non-sélection
  applyChoroplethSelection(set);
  // Surcouche de sélection (bords colorés)
  renderSelectedLayer(selectedArr);
  // KPIs + graphiques
  const agg = computeSelectionProps(Array.from(set));
  updateKPIsFromProps(agg);
  updateChartFromProps(agg);
  // Graphique comparaison: modes groupés
  buildComparisonCharts(Array.from(set));
  // Points: filtre sur l’union des polygones
  rebuildStopsInside(set);
  applyStopsLayerToggle();
  // Hexagones: mise à jour style/opacité
  if (showHex) updateHexStylesMulti(set);
  // Zoom si un seul
  if (layer && set.size===1) fitToFeature(layer);
  if (!set.size && choroplethLayer){ const b=choroplethLayer.getBounds(); if(b&&b.isValid()) map.fitBounds(b,{padding:[20,20]}); }
}

// Gestion du clic carte selon le mode (mono vs comparaison)
function handleArrClick(name, layer, e){
  try{
    const ctrl = !!(e && e.originalEvent && (e.originalEvent.ctrlKey || e.originalEvent.metaKey));
    const current = new Set(selectedArr);
    if (modeCompare || ctrl){
      if (current.has(name)) current.delete(name); else current.add(name);
      // refléter dans la liste
      if (arrSelect) Array.from(arrSelect.options).forEach(o=> o.selected = current.has(o.value));
      applySelection(Array.from(current), layer);
    } else {
      if (arrSelect) Array.from(arrSelect.options).forEach(o=> o.selected = (o.value===name));
      applySelection([name], layer);
    }
  }catch(err){ console.warn('handleArrClick error', err); }
}

// Chargement
async function loadAll(){
  console.time?.('loadAll');
  const [statsRes, stopsRes, boundRes] = await Promise.all([ fetch(PATH_STATS), fetch(PATH_STOPS), fetch(PATH_BOUND) ]);
  if(!statsRes.ok) throw new Error('Impossible de charger arrondissements_stats.geojson');
  if(!stopsRes.ok) throw new Error('Impossible de charger rtm_stops.geojson');
  STATS=await statsRes.json(); const stops=await stopsRes.json(); ALL_STOPS=Array.isArray(stops.features)?stops.features:[];
  // Limite Marseille
  try{ const bound=await boundRes.json(); const fc=(bound.type==='FeatureCollection')?bound:{type:'FeatureCollection',features:[bound]}; const poly=fc.features.find(f=>['Polygon','MultiPolygon'].includes(f.geometry?.type)); if(poly) MARSEILLE_POLY=poly; const halo=L.geoJSON(fc,{pane:'boundaryPane',style:{color:'#ff0000',weight:8,opacity:.25,fill:false}}); const stroke=L.geoJSON(fc,{pane:'boundaryPane',style:{color:'#ff0000',weight:2,opacity:1,fill:false}}); boundaryGroup.addLayer(halo); boundaryGroup.addLayer(stroke);}catch(e){ console.warn('Limite Marseille introuvable'); }
  if(STATS.features.length){
    if(STATS.features[0].properties.arr_name) nameField='arr_name';
    else if(STATS.features[0].properties.name) nameField='name';
    else if(STATS.features[0].properties.nom) nameField='nom';
  }
  prepareArrIndex();
  ensureStopCache();
  buildChoropleth();
  if(arrSelect){ const names=STATS.features.map(f=>f.properties?.[nameField]).filter(Boolean).sort(); arrSelect.innerHTML = names.map(n=>`<option value="${n}">${n}</option>`).join(''); arrSelect.multiple = false; }
  // Init UI
  selectArrondissements([], null); applyStopsLayerToggle(); applyPointSize();
  refreshLegendGradient();
  syncLegendUI();
  console.timeEnd?.('loadAll');
}

// Événements (une seule attache)
// Multi-sélecteur: met à jour la sélection
// Sélecteur: bascule entre mono et multi selon le commutateur, et met à jour la sélection
if(arrSelect){ arrSelect.addEventListener('change',()=>{ const names = Array.from(arrSelect.selectedOptions).map(o=>o.value); if (!modeCompare && names.length>1){ // en mono: ne garder que le premier
    Array.from(arrSelect.options).forEach(o=> o.selected = (o.value===names[0]));
    applySelection(names.slice(0,1), null);
  } else applySelection(names, null); }); }
if(btnClearCompare){ btnClearCompare.addEventListener('click',()=>{ if(arrSelect) Array.from(arrSelect.options).forEach(o=>o.selected=false); applySelection([], null); }); }
if(btnCity){ btnCity.addEventListener('click', ()=>{ if(arrSelect) Array.from(arrSelect.options).forEach(o=>o.selected=false); applySelection([], null); }); }
if(chkCompare){ chkCompare.addEventListener('change', ()=>{ try{ modeCompare = !!chkCompare.checked; if(arrSelect) arrSelect.multiple = modeCompare; // conserver sélection actuelle mais adapter
  // En mono, si plusieurs sélectionnés, ne garder que le premier
  if (!modeCompare){ const names = Array.from(arrSelect.selectedOptions).map(o=>o.value); if (names.length>1){ Array.from(arrSelect.options).forEach(o=> o.selected = (o.value===names[0])); applySelection(names.slice(0,1), null); return; } }
  // Appliquer styles d’atténuation si on passe en comparaison
  const namesNow = Array.from(arrSelect.selectedOptions).map(o=>o.value);
  applySelection(namesNow, null);
}catch(e){ console.warn('compare toggle failed', e); } }); }
if(btnToggleCluster){ btnToggleCluster.addEventListener('click',()=>{ useCluster=!useCluster; applyStopsLayerToggle(); }); }
if(btnSmallerPoints){ btnSmallerPoints.addEventListener('click',()=>{ smallPoints=!smallPoints; applyPointSize(); }); }
if(btnToggleChoropleth){ btnToggleChoropleth.addEventListener('click',()=>{ if(!choroplethLayer) return; const shouldShow = !map.hasLayer(choroplethLayer); setChoroplethVisibility(shouldShow); }); }
if(btnToggleHexbin){
  const handleHexToggle = async ()=>{
    btnToggleHexbin.disabled=true;
    const prev=btnToggleHexbin.textContent;
    try{
      if(!showHex){
        btnToggleHexbin.textContent='Chargement…';
        await buildHexGridOnce();
        const layer=ensureHexLayer();
        if(layer && !hexLayerGroup.hasLayer(layer)) hexLayerGroup.addLayer(layer);
        if(!map.hasLayer(hexLayerGroup)) map.addLayer(hexLayerGroup);
        updateHexStylesMulti(new Set(selectedArr));
        showHex=true;
        btnToggleHexbin.textContent='Masquer les hexagones';
        refreshLegendGradient();
        syncLegendUI();
      } else {
        showHex=false;
        if(map.hasLayer(hexLayerGroup)) map.removeLayer(hexLayerGroup);
        btnToggleHexbin.textContent='Afficher les hexagones';
        refreshLegendGradient();
        syncLegendUI();
      }
    } catch(e){
      console.error('Toggle hex error:', e);
      showHex=false;
      if(map.hasLayer(hexLayerGroup)) map.removeLayer(hexLayerGroup);
      btnToggleHexbin.textContent='Afficher les hexagones';
      refreshLegendGradient();
      syncLegendUI();
    } finally {
      btnToggleHexbin.disabled=false;
      if(btnToggleHexbin.textContent==='Chargement…') btnToggleHexbin.textContent=prev;
    }
  };
  btnToggleHexbin.addEventListener('click', ()=> handleHexToggle().catch(err=> console.error('hex toggle failed', err)));
}
if(filterBtnBus) filterBtnBus.addEventListener('click', ()=> toggleModeFilter('bus'));
if(filterBtnTram) filterBtnTram.addEventListener('click', ()=> toggleModeFilter('tram'));
if(filterBtnMetro) filterBtnMetro.addEventListener('click', ()=> toggleModeFilter('metro'));

// Go!
loadAll().catch(err=> alert(err.message||String(err)));
