// --- Carte de base ---
const map = L.map('map', { zoomControl: true }).setView([43.2965, 5.3698], 12);

const baseOSM = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; OpenStreetMap'
}).addTo(map);

const baseTopo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
  maxZoom: 17, attribution: '&copy; OpenTopoMap'
});

const baseSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19, attribution: 'Imagery © Esri'
});

const baseLayers = { 'OpenStreetMap': baseOSM, 'Topo': baseTopo, 'Satellite': baseSat };
const overlayLayers = {};
L.control.layers(baseLayers, overlayLayers, { position: 'topleft' }).addTo(map);

// --- Styles ---
const styleLimite = { color:'#0ea5e9', weight:2, fillOpacity:0 };
function styleVert(f){
  const p = f.properties || {};
  if (p.leisure === 'park')   return { color:'#2e7d32', fillColor:'#4caf50', weight:1, fillOpacity:.45 };
  if (p.leisure === 'garden') return { color:'#33691e', fillColor:'#81c784', weight:1, fillOpacity:.45 };
  if (p.landuse === 'forest') return { color:'#1b5e20', fillColor:'#2e7d32', weight:1, fillOpacity:.45 };
  if (p.natural === 'wood')   return { color:'#2e7d32', fillColor:'#66bb6a', weight:1, fillOpacity:.45 };
  return { color:'#14532d', fillColor:'#43a047', weight:1, fillOpacity:.40 };
}

// --- Couches globales ---
let layerLimite, layerVerts, heatLayer;

// --- Chargement des données (chemins adaptés à ton dossier) ---
Promise.all([
  fetch('./data/Marseille.geojson').then(r => r.json()),                 // limite communale
  fetch('./data/espaces_verts_marseille.geojson').then(r => r.json())    // espaces verts OSM
]).then(([limite, verts]) => {

  // 1) Limite
  layerLimite = L.geoJSON(limite, { style: styleLimite }).addTo(map);
  overlayLayers['Limite Marseille'] = layerLimite;

  // 2) Polygones verts + popups
  layerVerts = L.geoJSON(verts, {
    style: styleVert,
    onEachFeature: (f, l) => {
      const name = f.properties?.name || '(nom non renseigné)';
      const isPoly = f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon');
      const ha = isPoly ? (turf.area(f)/10000).toFixed(2) + ' ha' : '';
      l.bindPopup(`<b>${name}</b>${ha ? '<br>'+ha : ''}`);
    }
  }).addTo(map);
  overlayLayers['Espaces verts (polygones)'] = layerVerts;

  // 3) HEATMAP : centroïdes pondérés par surface (hectares)
  const pts = [];
  let minW = Infinity, maxW = -Infinity;

  // prendre la première feature de la limite pour le test d'inclusion
  const limFeat = Array.isArray(limite.features) ? limite.features[0] : limite;

  verts.features.forEach(f => {
    if (!f.geometry || !['Polygon','MultiPolygon'].includes(f.geometry.type)) return;

    const areaHa = turf.area(f) / 10000.0;
    if (!isFinite(areaHa) || areaHa <= 0) return;

    const c = turf.centroid(f);                    // centroïde
    if (!turf.booleanPointInPolygon(c, limFeat)) return; // garder dans la limite

    const [lon, lat] = c.geometry.coordinates;
    pts.push({ lat, lon, w: areaHa });
    if (areaHa < minW) minW = areaHa;
    if (areaHa > maxW) maxW = areaHa;
  });

  const range = (maxW - minW) || 1;
  const heatData = pts.map(p => {
    const w = Math.max(0.15, Math.min(1, (p.w - minW) / range)); // 0..1 (éviter 0)
    return [p.lat, p.lon, w];
  });

  heatLayer = L.heatLayer(heatData, { radius: 28, blur: 20, maxZoom: 17 }).addTo(map);
  overlayLayers['Heatmap (intensité par surface)'] = heatLayer;

  // 4) Emprise
  const group = L.featureGroup([layerLimite, layerVerts, heatLayer]);
  try { map.fitBounds(group.getBounds(), { padding:[20,20] }); } catch(e){}

}).catch(e => {
  console.error('Chargement des données échoué :', e);
  alert('Impossible de charger les GeoJSON. Vérifie les chemins et relance.');
});
