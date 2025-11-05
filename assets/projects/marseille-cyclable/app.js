// Basemap sobre (CARTO Dark)
const map = L.map('map', { zoomControl:true }).setView([43.2965, 5.3698], 12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 20,
  attribution: '&copy; OSM &copy; CARTO'
}).addTo(map);

// Fichiers (attention accent "vélo")
const limitePath   = './data/Marseille.geojson';
const pistesPath   = './data/Pistes_cyclables.geojson';
const parkingsPath = './data/' + encodeURI('Parkings_vélo.geojson');

const styleLimite = { color:'#0ea5e9', weight:2, fillOpacity:0 };
const stylePistes = { color:'#00bcd4', weight:3, opacity:0.95 };

let layerLimite, layerPistes, layerParkings;
const overlay = {};
const ctl = L.control.layers({}, overlay, { position:'topleft', collapsed:true }).addTo(map);

// KPIs
const kpiPistes   = document.getElementById('kpi-pistes');
const kpiParks    = document.getElementById('kpi-parkings');
const kpiProches  = document.getElementById('kpi-proches');
const extentInfo  = document.getElementById('extent');

// 1) Limite
fetch(limitePath).then(r=>r.json()).then(gj=>{
  layerLimite = L.geoJSON(gj, { style: styleLimite }).addTo(map);
  overlay['Limite'] = layerLimite; ctl.addOverlay(layerLimite, 'Limite');
  try{ map.fitBounds(layerLimite.getBounds(), { padding:[20,20] }); }catch(e){}
  const b = map.getBounds();
  extentInfo.textContent = `${b.getSouth().toFixed(3)}, ${b.getWest().toFixed(3)} · ${b.getNorth().toFixed(3)}, ${b.getEast().toFixed(3)}`;
});

// 2) Pistes
let pistesGeo = null;
fetch(pistesPath).then(r=>r.json()).then(gj=>{
  pistesGeo = gj;
  layerPistes = L.geoJSON(gj, {
    style: stylePistes,
    onEachFeature:(f,l)=>{
      const p=f.properties||{};
      const name=p.name||'Piste cyclable';
      const extra=[p.highway?`highway=${p.highway}`:'', p.cycleway?`cycleway=${p.cycleway}`:''].filter(Boolean).join(' · ');
      l.bindPopup(`<b>${name}</b>${extra?'<br>'+extra:''}`);
    }
  }).addTo(map);
  overlay['Pistes'] = layerPistes; ctl.addOverlay(layerPistes, 'Pistes');

  // longueur totale (km)
  const km = turf.length(gj, { units:'kilometers' });
  kpiPistes.textContent = km.toFixed(1);

  // init graph longueur
  updateLengthChart(km);
});

// 3) Parkings + analyse spatiale
fetch(parkingsPath).then(r=>r.json()).then(parkings=>{
  const cluster = L.markerClusterGroup({ disableClusteringAtZoom:17 });
  const points = L.geoJSON(parkings, {
    pointToLayer:(_f,latlng)=>L.circleMarker(latlng,{radius:6,color:'#2e7d32',fillColor:'#4caf50',fillOpacity:.9,weight:1}),
    onEachFeature:(f,l)=>l.bindPopup(`<b>${f.properties?.name||'Parking vélo'}</b>${f.properties?.capacity?'<br>Capacité : '+f.properties.capacity:''}`)
  });
  cluster.addLayer(points).addTo(map);
  layerParkings = cluster;
  overlay['Parkings (cluster)'] = layerParkings; ctl.addOverlay(layerParkings, 'Parkings (cluster)');

  // KPI nombre
  const total = parkings.features.length;
  kpiParks.textContent = total;

  // Analyse <100 m des pistes (buffer point)
  if (pistesGeo){
    let proches = 0;
    parkings.features.forEach(pt=>{
      const c = turf.point(pt.geometry.coordinates);
      const buf = turf.buffer(c, 0.1, { units:'kilometers' }); // 100 m
      const touch = pistesGeo.features.some(line=>turf.booleanIntersects(buf, line));
      if (touch) proches++;
    });
    const pct = total ? (proches / total * 100) : 0;
    kpiProches.textContent = `${pct.toFixed(0)}%`;
    // init graph parking
    updateParkingChart(proches, total - proches);
  }
}).catch(e=>{
  console.error(e);
  alert('Vérifie le nom avec accent : Parkings_vélo.geojson');
});





