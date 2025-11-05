// app.js (avec clustering léger + icônes pastel SVG)
document.addEventListener("DOMContentLoaded", () => {

  const FILE_COMMUNES = "./data/limites_communes_abidjan.geojson";
  const FILE_SANTE    = "./data/etablissements_sante_abidjan.geojson";

  // ---------- MAP ----------
  const map = L.map("map", { preferCanvas: true }).setView([5.34, -4.02], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution:"© OpenStreetMap" }).addTo(map);

  // charge Leaflet.markercluster dynamiquement (aucun changement HTML nécessaire)
  function loadMarkerCluster(){
    return new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css";
      document.head.appendChild(css);

      const baseCss = document.createElement("link");
      baseCss.rel = "stylesheet";
      baseCss.href = "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css";
      document.head.appendChild(baseCss);

      const scr = document.createElement("script");
      scr.src = "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js";
      scr.onload = () => resolve();
      scr.onerror = reject;
      document.body.appendChild(scr);
    });
  }

  // On garde UNIQUEMENT les polygones (pas les points) pour les communes
  const onlyPolygons = f => {
    const t = f?.geometry?.type;
    return t === "Polygon" || t === "MultiPolygon";
  };

  // Contours des communes (noir, sans remplissage)
  const communesLayer = L.geoJSON(null, {
    filter: onlyPolygons,
    style: { color:"#060607ff", weight:1, fillOpacity:0.0 }
  }).addTo(map);

  // Groupe cluster (sera créé après chargement du plugin)
  let clusterGroup = null;

  // Couche GeoJSON brute (on ne l'affichera pas, mais on l'utilise pour .addData si besoin)
  const pointsLayer = L.geoJSON(null, {
    filter: f => f?.geometry?.type === "Point"
  });

  let choroplethLayer = null;
  let BAR = null;
  const DATA = { communes:null, sante:null };

  // Icônes pastel très légères (SVG inline, 18x18) – pas d'images à télécharger
  function chooseIcon(a){
    const t = (a || "").toLowerCase();
    const styles = {
      hospital: { bg:"#bfe3ff", stroke:"#5aa7e6", label:"H" }, // hôpital
      clinic:   { bg:"#ffe5b3", stroke:"#e6a84a", label:"C" }, // clinique
      doctors:  { bg:"#e3d7ff", stroke:"#8f77e6", label:"D" }, // médecin
      pharmacy: { bg:"#c8f5d2", stroke:"#44b56d", label:"+" }  // pharmacie
    };
    const st = styles[t] || styles.hospital;

    const svg = `
      <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" role="img">
        <circle cx="9" cy="9" r="8" fill="${st.bg}" stroke="${st.stroke}" stroke-width="1"/>
        <text x="9" y="10.9" text-anchor="middle" font-family="system-ui,Segoe UI,Arial"
              font-size="10" font-weight="700" fill="#ffffff">${st.label}</text>
      </svg>`;
    return L.divIcon({ html: svg, className: "", iconSize:[18,18], iconAnchor:[9,9], popupAnchor:[0,-10] });
  }

  // Centre robuste pour n'importe quelle géométrie
  function featureCenterLatLng(f){
    if(!f || !f.geometry) return null;
    const g = f.geometry;
    if(g.type === "Point"){
      const [lon, lat] = g.coordinates || [];
      return (Number.isFinite(lat) && Number.isFinite(lon)) ? L.latLng(lat, lon) : null;
    }
    try{
      const tmp = L.geoJSON(f);
      const b = tmp.getBounds();
      return (b && b.isValid()) ? b.getCenter() : null;
    }catch{ return null; }
  }

  // ---------- UI ----------
  const $type = document.getElementById("filter-type");
  const $mode = document.getElementById("view-mode");
  const $comm = document.getElementById("commune-select");
  const $min  = document.getElementById("min-threshold");
  const $minVal = document.getElementById("min-threshold-val");
  const $reset = document.getElementById("btn-reset");
  const $toggleCluster = document.getElementById("toggle-cluster");
let clusterEnabled = true; // état du clustering

if ($toggleCluster) {
  $toggleCluster.addEventListener("change", () => {
    clusterEnabled = $toggleCluster.checked;
    updateDashboard(); // recharge les points selon l’état
  });
}


  function initDashboard(){
    const names = (DATA.communes.features||[])
      .filter(onlyPolygons)
      .map(f => (f.properties.name || f.properties.NAME_2 || "Inconnu").trim())
      .filter((v,i,a)=>v && a.indexOf(v)===i)
      .sort();

    names.forEach(n=>{
      const opt = document.createElement("option");
      opt.value = n; opt.textContent = n;
      $comm.appendChild(opt);
    });

    [$type,$mode,$comm,$min].forEach(el => el.addEventListener("change", updateDashboard));
    $min.addEventListener("input", () => { $minVal.textContent = $min.value; });
    $reset.addEventListener("click", ()=>{
      $type.value="all"; $mode.value="points"; $comm.value="__all__"; $min.value=0; $minVal.textContent="0";
      updateDashboard();
    });
  }

  // ---------- DASHBOARD ----------
  function updateDashboard(){
    const type = $type.value;
    const mode = $mode.value;
    const communeSel = $comm.value;
    const min = +$min.value;

    const { byCommune, global } = aggregate(DATA.communes, DATA.sante, type);
    const filtered = applyFilters(byCommune, communeSel, min);

    updateKPIs(global);
    drawBar(filtered);
    drawTable(filtered);

    // Points/clusters toujours visibles (au-dessus), choroplèthe en option
    drawPoints(type, communeSel);

    if(choroplethLayer) { choroplethLayer.removeFrom(map); choroplethLayer = null; }
    if(mode === "choropleth"){
      drawChoropleth(filtered);
    }

    communesLayer.bringToFront();
    if (clusterGroup) clusterGroup.bringToFront();
  }

  // Agrégation : on rattache chaque établissement (centre) à une commune (polygone)
  function aggregate(communes, sante, filterType){
    const by = {};
    (communes.features||[])
      .filter(onlyPolygons)
      .forEach(f=>{
        const n=(f.properties.name || f.properties.NAME_2 || "Inconnu").trim();
        by[n] = { total:0, pharmacy:0, hospital:0, clinic:0, doctors:0 };
      });

    (sante.features||[]).forEach(f=>{
      const a = (f.properties.amenity || "").toLowerCase();
      if(filterType !== "all" && a !== filterType) return;
      const pt = featureCenterLatLng(f);
      if(!pt) return;

      let name = null;
      communesLayer.eachLayer(poly=>{
        if (typeof poly.getBounds !== "function") return;
        if(poly.getBounds().contains(pt) && !name){
          name = (poly.feature.properties.name || poly.feature.properties.NAME_2 || "Inconnu").trim();
        }
      });
      if(!name){ name="Inconnu"; if(!by[name]) by[name] = { total:0, pharmacy:0, hospital:0, clinic:0, doctors:0 }; }

      by[name].total++;
      if(["pharmacy","hospital","clinic","doctors"].includes(a)) by[name][a]++; else by[name].hospital++;
    });

    const global = Object.values(by).reduce((acc,d)=>({
      total: acc.total + d.total,
      hosp:  acc.hosp + d.hospital + d.clinic,
      pharm: acc.pharm + d.pharmacy
    }), {total:0, hosp:0, pharm:0});

    return { byCommune: by, global };
  }

  function applyFilters(by, communeSel, min){
    let entries = Object.entries(by);
    if(communeSel !== "__all__") entries = entries.filter(([n])=>n===communeSel);
    if(min > 0) entries = entries.filter(([_,d])=>d.total >= min);
    return Object.fromEntries(entries);
  }

  function updateKPIs(g){
    document.getElementById("kpi-total").textContent = g.total;
    document.getElementById("kpi-hosp").textContent  = g.hosp;
    document.getElementById("kpi-pharm").textContent = g.pharm;
  }

  function drawBar(by){
    const labels = Object.keys(by);
    const values = Object.values(by).map(d=>d.total);
    if(BAR) BAR.destroy();
    BAR = new Chart(document.getElementById("bar"), {
      type:"bar",
      data:{ labels, datasets:[{ data:values, label:"Établissements", backgroundColor:"rgba(77,163,255,0.6)"}]},
      options:{
        plugins:{ legend:{display:false} },
        scales:{ y:{ beginAtZero:true } },
        onClick: (_e, els)=>{
          if(!els.length) return;
          const name = labels[els[0].index];
          zoomToCommune(name);
          $comm.value = name;
        }
      }
    });
  }

  function drawTable(by){
    const tbody = document.getElementById("commune-tbody");
    tbody.innerHTML = "";
    Object.entries(by).sort((a,b)=>b[1].total-a[1].total).forEach(([n,d])=>{
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${n}</td><td>${d.total}</td><td>${d.hospital+d.clinic}</td><td>${d.pharmacy}</td><td>${d.doctors}</td>`;
      tr.style.cursor = "pointer";
      tr.addEventListener("click", ()=>{ zoomToCommune(n); $comm.value = n; });
      tbody.appendChild(tr);
    });
  }

  // Création d'un joli "cluster icon" léger
  function clusterIcon(count){
    const size = count < 20 ? 26 : count < 100 ? 32 : 40;
    const bg   = count < 20 ? "#e6f2ff" : count < 100 ? "#cfe7ff" : "#9fcfff";
    const stroke = "#5aa7e6";
    const html = `
      <svg width="${size}" height="${size}" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <circle cx="20" cy="20" r="18" fill="${bg}" stroke="${stroke}" stroke-width="2"></circle>
        <text x="20" y="24" text-anchor="middle" font-family="system-ui,Segoe UI,Arial"
              font-size="16" font-weight="700" fill="#1e3a8a">${count}</text>
      </svg>`;
    return L.divIcon({ html, className:"", iconSize:[size,size], iconAnchor:[size/2,size/2] });
  }

  function ensureClusterGroup(){
    if (clusterGroup && map.hasLayer(clusterGroup)) {
      clusterGroup.clearLayers();
      return clusterGroup;
    }
    if (clusterGroup) {
      clusterGroup.clearLayers();
      map.addLayer(clusterGroup);
      return clusterGroup;
    }
    // Crée le cluster group
    clusterGroup = L.markerClusterGroup({
      maxClusterRadius: 40,
      disableClusteringAtZoom: 16,
      spiderfyOnEveryZoom: false,
      showCoverageOnHover: false,
      iconCreateFunction: (cluster) => clusterIcon(cluster.getChildCount())
    });
    map.addLayer(clusterGroup);
    return clusterGroup;
  }

 function drawPoints(typeFilter, communeSel){
  if (clusterGroup) clusterGroup.clearLayers();
  pointsLayer.clearLayers();

  const feats = (DATA.sante.features||[]).filter(f=>{
    const a = (f.properties.amenity || "").toLowerCase();
    if(typeFilter !== "all" && a !== typeFilter) return false;
    if(communeSel === "__all__") return f.geometry?.type === "Point";
    const pt = featureCenterLatLng(f); if(!pt) return false;
    let inside = false;
    communesLayer.eachLayer(poly=>{
      if (typeof poly.getBounds !== "function") return;
      const n = (poly.feature.properties.name || poly.feature.properties.NAME_2 || "Inconnu").trim();
      if(n===communeSel && poly.getBounds().contains(pt)) inside = true;
    });
    return inside && f.geometry?.type === "Point";
  });

  if (clusterEnabled) {
    const cg = ensureClusterGroup();
    feats.forEach(f=>{
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties || {};
      const m = L.marker([lat, lon], { icon: chooseIcon(p.amenity) });
      m.bindPopup(`<b>${p.name || "(sans nom)"}</b><br>${p.amenity || "Établissement"}`);
      cg.addLayer(m);
    });
    map.addLayer(cg);
  } else {
    feats.forEach(f=>{
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties || {};
      const m = L.marker([lat, lon], { icon: chooseIcon(p.amenity) });
      m.bindPopup(`<b>${p.name || "(sans nom)"}</b><br>${p.amenity || "Établissement"}`);
      pointsLayer.addLayer(m);
    });
    map.addLayer(pointsLayer);
  }
}

// ----- LÉGENDE CHOROPLÈTHE -----
let legendCtrl = null;
function showChoroLegend(palette){
  if (legendCtrl) { map.removeControl(legendCtrl); legendCtrl = null; }
  legendCtrl = L.control({position:'bottomright'});
  legendCtrl.onAdd = () => {
    const div = L.DomUtil.create('div','leaflet-bar');
    div.style.background='#fff'; div.style.padding='8px 10px'; div.style.borderRadius='6px';
    div.innerHTML = '<b>Densité</b><br>' + palette.map(c =>
      `<span style="display:inline-block;width:16px;height:12px;background:${c};margin:2px;border:1px solid #ddd"></span>`
    ).join('');
    return div;
  };
  legendCtrl.addTo(map);
}
function hideChoroLegend(){
  if (legendCtrl) { map.removeControl(legendCtrl); legendCtrl = null; }
}



  function drawChoropleth(by){
    const palette = ["#edf5ff","#cfe7ff","#9fcfff","#6fb7ff","#3d9cff","#0d74ff"];
    const vals = Object.values(by).map(d => d.total);
    const min = Math.min(0, ...vals);
    const max = Math.max(1, ...vals);
    const getColor = v => {
      if (v <= 0) return "#f5f7fb";
      const t = (v - min) / (max - min);
      const idx = Math.max(0, Math.min(palette.length - 1, Math.floor(t * (palette.length - 1))));
      return palette[idx];
    };

    choroplethLayer = L.geoJSON(DATA.communes, {
      filter: onlyPolygons,
      style: f => {
        const name = (f.properties.name || f.properties.NAME_2 || "Inconnu").trim();
        const v = (by[name]?.total) || 0;
        return { color:"#ffffff33", weight:1, fillColor:getColor(v), fillOpacity:0.85 };
      },
      onEachFeature:(f,l)=>{
        const n=(f.properties.name || f.properties.NAME_2 || "Inconnu").trim();
        const d=by[n] || { total:0, pharmacy:0, hospital:0, clinic:0, doctors:0 };
        l.bindPopup(`<b>${n}</b><br>Total: ${d.total}<br>Hosp.+Clin.: ${d.hospital + d.clinic}<br>Pharm.: ${d.pharmacy}<br>Méd.: ${d.doctors}`);
        l.on("click", ()=>{ zoomToCommune(n); $comm.value = n; });
      }
    }).addTo(map);
  }
  showChoroLegend(["#edf5ff","#cfe7ff","#9fcfff","#6fb7ff","#3d9cff","#0d74ff"]);


  function zoomToCommune(name){
    communesLayer.eachLayer(l=>{
      if (typeof l.getBounds !== "function") return;
      const n=(l.feature.properties.name || l.feature.properties.NAME_2 || "Inconnu").trim();
      if(n===name) map.fitBounds(l.getBounds().pad(0.12));
    });
  }

  // ---------- LOAD DATA + PLUGIN ----------
  Promise.all([
    loadMarkerCluster(),
    fetch(FILE_COMMUNES).then(r=>r.ok ? r.json() : Promise.reject(new Error("COMMUNES introuvable"))),
    fetch(FILE_SANTE).then(r=>r.ok ? r.json() : Promise.reject(new Error("SANTE introuvable")))
  ]).then(([_, communes, sante])=>{
    DATA.communes = communes;
    DATA.sante = sante;

    communesLayer.addData(communes);
    if (communesLayer.getLayers().length) map.fitBounds(communesLayer.getBounds());

    initDashboard();
    updateDashboard();
  }).catch(err=>{
    console.error(err);
    alert("Erreur de chargement : " + err.message);
  });

});


// ----- BOUTON EXPORT CSV -----
const exportCtrl = L.control({position:'topleft'});
exportCtrl.onAdd = ()=>{
  const div = L.DomUtil.create('div','leaflet-bar');
  const a = L.DomUtil.create('a','',div);
  a.href='#'; a.title='Exporter CSV';
  a.innerHTML='⬇️'; a.style.padding='6px 10px';
  L.DomEvent.on(a,'click', (ev)=>{ L.DomEvent.stop(ev); exportFilteredCSV(); });
  return div;
};
exportCtrl.addTo(map);

function exportFilteredCSV(){
  const type = document.getElementById("filter-type").value;
  const communeSel = document.getElementById("commune-select").value;
  const rows = [["name","amenity","lat","lon"]];
  (DATA.sante.features||[]).forEach(f=>{
    if (f.geometry?.type !== 'Point') return;
    const a = (f.properties?.amenity||"").toLowerCase();
    if(type!=="all" && a!==type) return;

    // filtre commune ~bounds.contains
    if(communeSel!=="__all__"){
      const pt = featureCenterLatLng(f); let inside=false;
      communesLayer.eachLayer(poly=>{
        if(typeof poly.getBounds!=="function") return;
        const n=(poly.feature.properties.name||poly.feature.properties.NAME_2||"Inconnu").trim();
        if(n===communeSel && poly.getBounds().contains(pt)) inside=true;
      });
      if(!inside) return;
    }
    const [lon,lat]=f.geometry.coordinates;
    rows.push([ (f.properties?.name||""), (f.properties?.amenity||""), lat, lon ]);
  });

  const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const dl = document.createElement('a');
  dl.href = url; dl.download = 'etablissements_filtrés.csv'; dl.click();
  URL.revokeObjectURL(url);
}
