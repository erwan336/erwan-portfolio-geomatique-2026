/*
  RTM — Analyse par arrondissement (refonte contrôles + hexbin)
  - Choropleth par arrondissement (indice_norm)
  - Hexagones Turf (500 m) avec score pondéré bus*1 + tram*2 + metro*3 normalisé 0–100
  - Points d'arrêts en circleMarker, modes cluster/non-cluster
  - KPI/graph/barres: global (Tous les arrondissements) ou par arrondissement
*/
/* global L, turf, Chart */

// Données (chemins relatifs depuis web/)
const PATH_STATS = "../assets/data/arrondissements_stats.geojson";
const PATH_STOPS = "../assets/data/rtm_stops.geojson";
const PATH_BOUND = "../assets/data/Marseille.geojson";

// Palette sombre demandée (0 → 100)
// 0→100 : #0b2e13, #145a32, #1e7d3d, #2ea84f, #4fd36a
const PALETTE = ["#0b2e13","#145a32","#1e7d3d","#2ea84f","#4fd36a"];
function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }
function colorFor(v){ const t = clamp((v||0)/100,0,0.999); return PALETTE[Math.floor(t*PALETTE.length)]; }

// Carte
const map = L.map('map', { preferCanvas:true }).setView([43.30, 5.38], 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, attribution:'© OSM' }).addTo(map);

// Panes / groupes
map.createPane('arrPane'); map.getPane('arrPane').style.zIndex = 400;
map.createPane('hexPane'); map.getPane('hexPane').style.zIndex = 500;
map.createPane('boundaryPane'); map.getPane('boundaryPane').style.zIndex = 650;

const arrLayerGroup = L.featureGroup().addTo(map);
const hexLayerGroup = L.layerGroup().addTo(map);
const boundaryGroup = L.layerGroup().addTo(map);

// Arrêts: cluster + non-cluster
const stopsCluster = L.markerClusterGroup({ disableClusteringAtZoom: 17 });
const stopsLayer = L.layerGroup();
map.addLayer(stopsCluster);

// État
let STATS = null; let ALL_STOPS = [];
let selectedName = null; let nameField = 'arr_name';
let MARSEILLE_POLY = null; let hexGridCache = null; let hexCellM = 500;
let showChoro = true; let showHex = false;
let useCluster = true; let smallPoints = false; const RADIUS_NORMAL=5.5, RADIUS_SMALL=3; let currentRadius=RADIUS_NORMAL;

// UI
const selArr = document.getElementById('select-arr');
const btnReset = document.getElementById('btn-reset');
const btnToggleCluster = document.getElementById('btn-toggle-cluster');
const btnSmallerPoints = document.getElementById('btn-smaller-points');
const btnToggleChoropleth = document.getElementById('btn-toggle-choropleth');
const btnToggleHexbin = document.getElementById('btn-toggle-hexbin');

const kpiTotal = document.getElementById('kpi-total');
const kpiDens = document.getElementById('kpi-densite');
const kpiInd = document.getElementById('kpi-indice');
const lgSource = document.getElementById('lg-source');

let chart = null;

// Choroplèthe
function buildChoropleth(){
  arrLayerGroup.clearLayers(); if (!STATS) return;
  const layer = L.geoJSON(STATS, {
    pane: 'arrPane',
    filter: f => ['Polygon','MultiPolygon'].includes(f.geometry?.type),
    style: f => ({ color:'#334155', weight:1, fillColor: colorFor(Math.round(f.properties?.indice_norm||0)), fillOpacity: 0.6 }) ,
    onEachFeature: (f,l)=>{ const nm=f.properties?.[nameField]||'Arrondissement'; l.bindPopup(`<b>${nm}</b><br>Indice: ${Math.round(f.properties?.indice_norm||0)}`); l.on('click',()=> selectArrondissement(nm, l)); }
  });
  layer.addTo(arrLayerGroup);
}

// Hexagones
// Grille d'hexagones strictement limitée à Marseille (masque Turf)
function buildHexGrid(){
  if (!MARSEILLE_POLY) return null;
  if (hexGridCache && hexGridCache._cellSizeM === hexCellM) return hexGridCache;
  const bbox = turf.bbox(MARSEILLE_POLY);
  // mask: découpe les cellules au contour communal
  let grid = turf.hexGrid(bbox, hexCellM/1000, { units: 'kilometers', mask: MARSEILLE_POLY });
  // Garde les cellules dont le centroïde est bien à l'intérieur
  grid.features = grid.features.filter(h => {
    try { return turf.booleanPointInPolygon(turf.centroid(h), MARSEILLE_POLY); } catch(e){ return false; }
  });
  grid._cellSizeM = hexCellM;
  hexGridCache = grid;
  return grid;
}
function computeHexScores(stops, grid){ if(!grid) return null; const pts=turf.featureCollection(stops.map(s=>turf.point(s.geometry.coordinates, s.properties))); const W={bus:1,tram:2,metro:3}; let mn=Infinity,mx=-Infinity; grid.features.forEach(c=>{ const inside=turf.pointsWithinPolygon(pts,c).features; const by={bus:0,tram:0,metro:0}; inside.forEach(p=>{ const m=(p.properties?.main_mode||p.properties?.mode||'bus'); if(by[m]==null) by[m]=0; by[m]++; }); const sc=by.bus*W.bus + by.tram*W.tram + by.metro*W.metro; c.properties={count:inside.length, ...by, score:sc}; if(sc<mn) mn=sc; if(sc>mx) mx=sc; }); const span=(mx-mn)||1; grid.features.forEach(c=>{ c.properties.score_norm=Math.round(((c.properties.score-mn)/span)*100); }); return grid; }
function renderHexLayer(){
  hexLayerGroup.clearLayers(); if(!showHex) return;
  const grid = buildHexGrid(); const g=computeHexScores(ALL_STOPS, grid); if(!g) return;
  const layer=L.geoJSON(g,{ pane:'hexPane', style:f=>{ const v=f.properties?.score_norm||0; let op=0.85; if(selectedName && STATS){ try{ const a=STATS.features.find(ft=>ft.properties?.[nameField]===selectedName); if(a){ const c=turf.centroid(f); if(!turf.booleanPointInPolygon(c,a)) op=0.2; } }catch(e){} } return { color:'#0a2a12', weight:0.6, fillColor: colorFor(v), fillOpacity: op }; }, onEachFeature:(f,l)=> l.bindPopup(`Arrêts: ${f.properties.count}<br>Indice: ${f.properties.score_norm}`) }); layer.addTo(hexLayerGroup); }

// Sélecteur et KPI/graph global/arrondissement
function computeGlobalProps(){ if(!STATS||!STATS.features?.length) return null; const fs=STATS.features.map(f=>f.properties||{}); const sum=k=>fs.reduce((a,p)=>a+(+p[k]||0),0); const mean=k=>{ const arr=fs.map(p=>+p[k]).filter(Number.isFinite); return arr.length? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }; return { [nameField]:'Marseille (global)', arrets_total:sum('arrets_total'), densite_km2:mean('densite_km2'), indice_norm:mean('indice_norm'), bus:sum('bus'), tram:sum('tram'), metro:sum('metro') }; }
function updateKPIsFromProps(p){ const src=p||computeGlobalProps()||{}; kpiTotal.textContent=String(src.arrets_total||0); kpiDens.textContent=src.densite_km2!=null? String(Number(src.densite_km2).toFixed(2)) : '-'; kpiInd.textContent=src.indice_norm!=null? String(Math.round(src.indice_norm)) : '-'; }
function updateChartFromProps(p){ const src=p||computeGlobalProps()||{bus:0,tram:0,metro:0}; const data={ labels:['Métro','Tram','Bus'], datasets:[{ label:'Arrêts', backgroundColor:['#ef4444','#06b6d4','#22c55e'], data:[src.metro||0, src.tram||0, src.bus||0] }] }; const ctx=document.getElementById('modeBar'); if(!ctx) return; if(chart){ chart.data=data; chart.update(); } else { chart=new Chart(ctx,{ type:'bar', data, options:{ responsive:true, plugins:{ legend:{ display:false } }, scales:{ y:{ beginAtZero:true } } } }); } }

function rebuildStopsInside(geom){ stopsCluster.clearLayers(); stopsLayer.clearLayers(); const feats = geom? ALL_STOPS.filter(pt=>turf.booleanPointInPolygon(pt, geom)) : ALL_STOPS; const styleCluster={ radius:RADIUS_NORMAL, color:'#1f4f73', weight:0.75, fillColor:'#2f7dbd', fillOpacity:0.8 }; const styleSimple={ radius:currentRadius, color:'#1f4f73', weight:0.75, fillColor:'#2f7dbd', fillOpacity:0.8 }; feats.forEach(pt=>{ const [lng,lat]=pt.geometry.coordinates; const mode=(pt.properties?.main_mode||pt.properties?.mode||'bus'); const html=`<b>${pt.properties?.stop_name||'Arrêt'}</b><br>${mode}`; stopsCluster.addLayer(L.circleMarker([lat,lng], styleCluster).bindPopup(html)); stopsLayer.addLayer(L.circleMarker([lat,lng], styleSimple).bindPopup(html)); }); }
function applyStopsLayerToggle(){ if(useCluster){ if(!map.hasLayer(stopsCluster)) map.addLayer(stopsCluster); if(map.hasLayer(stopsLayer)) map.removeLayer(stopsLayer); if(btnToggleCluster) btnToggleCluster.textContent='Désactiver le clustering'; } else { if(map.hasLayer(stopsCluster)) map.removeLayer(stopsCluster); if(!map.hasLayer(stopsLayer)) map.addLayer(stopsLayer); if(btnToggleCluster) btnToggleCluster.textContent='Activer le clustering'; } }
function applyPointSize(){ currentRadius = smallPoints? RADIUS_SMALL : RADIUS_NORMAL; stopsLayer.eachLayer(l=>{ if(typeof l.setRadius==='function') l.setRadius(currentRadius); }); if(btnSmallerPoints) btnSmallerPoints.textContent = smallPoints? 'Taille normale des points' : 'Réduire la taille des points'; }

function fitToFeature(layer){ try{ map.fitBounds(layer.getBounds(), { padding:[20,20] }); }catch(e){} }
function selectArrondissement(name, layer){ selectedName = (name && name!=='__all__') ? name : null; // highlight simple
  arrLayerGroup.eachLayer(g=>{ g.eachLayer && g.eachLayer(l=> l.setStyle && l.setStyle({ weight:1, color:'#334155' })); });
  if(layer && layer.setStyle) layer.setStyle({ weight:2, color:'#f59e0b' });
  let props=null, geom=null; if(selectedName){ const ft=STATS.features.find(f=>f.properties?.[nameField]===selectedName); if(ft){ props=ft.properties; geom=ft.geometry; if(layer) fitToFeature(layer); } } else { const b=arrLayerGroup.getBounds(); if(b&&b.isValid()) map.fitBounds(b,{padding:[20,20]}); props=computeGlobalProps(); }
  updateKPIsFromProps(props); updateChartFromProps(props); rebuildStopsInside(geom); applyStopsLayerToggle(); if(showHex) renderHexLayer(); }

async function loadAll(){
  const [statsRes, stopsRes, boundRes] = await Promise.all([ fetch(PATH_STATS), fetch(PATH_STOPS), fetch(PATH_BOUND) ]);
  if(!statsRes.ok) throw new Error('Impossible de charger arrondissements_stats.geojson');
  if(!stopsRes.ok) throw new Error('Impossible de charger rtm_stops.geojson');
  STATS = await statsRes.json(); const stops = await stopsRes.json(); ALL_STOPS = Array.isArray(stops.features)? stops.features:[];
  // Limite Marseille + géométrie
  try{
    const bound = await boundRes.json(); const fc = (bound.type==='FeatureCollection')? bound : {type:'FeatureCollection', features:[bound]}; const poly = fc.features.find(f=>['Polygon','MultiPolygon'].includes(f.geometry?.type)); if(poly) MARSEILLE_POLY = poly; const halo=L.geoJSON(fc,{pane:'boundaryPane', style:{color:'#ff0000',weight:8,opacity:.25,fill:false}}); const stroke=L.geoJSON(fc,{pane:'boundaryPane', style:{color:'#ff0000',weight:2,opacity:1,fill:false}}); boundaryGroup.addLayer(halo); boundaryGroup.addLayer(stroke);
  }catch(e){ console.warn('Limite Marseille introuvable'); }
  if (STATS.features.length){ if (STATS.features[0].properties.arr_name) nameField='arr_name'; else if (STATS.features[0].properties.name) nameField='name'; else if (STATS.features[0].properties.nom) nameField='nom'; }
  buildChoropleth(); renderHexLayer();
  // UI init
  if (selArr){ const names = STATS.features.map(f=>f.properties?.[nameField]).filter(Boolean).sort(); selArr.innerHTML = '<option value="__all__">Tous les arrondissements</option>' + names.map(n=>`<option value="${n}">${n}</option>`).join(''); }
  selectArrondissement(null, null); applyStopsLayerToggle(); applyPointSize();
  // Synchroniser le dégradé de légende avec la palette sombre
  const elGrad = document.getElementById('lg-gradient');
  if (elGrad) elGrad.style.background = `linear-gradient(90deg, ${PALETTE.join(',')})`;
  if (lgSource) lgSource.textContent = 'Arrondissements';
}

// Evénements
if (selArr){ selArr.addEventListener('change',()=>{ const name=selArr.value; let lay=null; arrLayerGroup.eachLayer(g=>{ g.eachLayer && g.eachLayer(l=>{ const nm=l.feature?.properties?.[nameField]; if(nm===name) lay=l; }); }); selectArrondissement(name==='__all__'? null : name, lay); }); }
if (btnReset){ btnReset.addEventListener('click',()=>{ selArr.value='__all__'; selectArrondissement(null, null); }); }
if (btnToggleCluster){ btnToggleCluster.addEventListener('click',()=>{ useCluster=!useCluster; applyStopsLayerToggle(); }); }
if (btnSmallerPoints){ btnSmallerPoints.addEventListener('click',()=>{ smallPoints=!smallPoints; applyPointSize(); }); }
if (btnToggleChoropleth){ btnToggleChoropleth.addEventListener('click',()=>{ showChoro=!showChoro; if(showChoro){ if(!map.hasLayer(arrLayerGroup)) map.addLayer(arrLayerGroup); btnToggleChoropleth.textContent='Désactiver le choroplèthe'; if(lgSource && !showHex) lgSource.textContent='Arrondissements'; } else { if(map.hasLayer(arrLayerGroup)) map.removeLayer(arrLayerGroup); btnToggleChoropleth.textContent='Activer le choroplèthe'; } }); }
if (btnToggleHexbin){ btnToggleHexbin.addEventListener('click',()=>{ showHex=!showHex; if(showHex){ renderHexLayer(); if(!map.hasLayer(hexLayerGroup)) map.addLayer(hexLayerGroup); btnToggleHexbin.textContent='Masquer les hexagones'; if(lgSource) lgSource.textContent='Hexagones'; } else { if(map.hasLayer(hexLayerGroup)) map.removeLayer(hexLayerGroup); btnToggleHexbin.textContent='Afficher les hexagones'; if(lgSource && showChoro) lgSource.textContent='Arrondissements'; } }); }

// Go
loadAll().catch(err=> alert(err.message||String(err)));
