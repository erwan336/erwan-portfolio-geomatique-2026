# scripts/build_rtm_geojson.py
import os, io, csv, json, zipfile, glob
from collections import defaultdict, Counter

DATA_DIR = "data"
OUT_DIR = os.path.join("assets", "data")
OUT_GEOJSON = os.path.join(OUT_DIR, "rtm_stops.geojson")

os.makedirs(OUT_DIR, exist_ok=True)

# Cherche le premier zip dans /data
zips = glob.glob(os.path.join(DATA_DIR, "*.zip"))
if not zips:
    raise SystemExit("Aucun fichier .zip trouvé dans /data. Place ton GTFS (ex: mamp-rtm.gtfs.zip).")
GTFS_ZIP = zips[0]
print("GTFS détecté :", GTFS_ZIP)

def label_route_type(rt: int) -> str:
    mapping = {0:"tram", 1:"metro", 2:"rail", 3:"bus", 4:"ferry", 5:"cablecar", 6:"gondola", 7:"funicular"}
    return mapping.get(rt, f"type_{rt}")

def main():
    with zipfile.ZipFile(GTFS_ZIP, "r") as z:
        required = ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt"]
        for n in required:
            if n not in z.namelist():
                raise FileNotFoundError(f"{n} manquant dans le GTFS ({GTFS_ZIP})")

        # stops
        stops = {}
        with z.open("stops.txt") as f:
            rd = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
            for r in rd:
                sid = r.get("stop_id")
                if not sid: continue
                try:
                    lat = float(r.get("stop_lat", "nan"))
                    lon = float(r.get("stop_lon", "nan"))
                except:
                    continue
                if not (lat == lat and lon == lon): continue
                stops[sid] = {"stop_id": sid, "stop_name": r.get("stop_name") or "Arrêt", "lat": lat, "lon": lon}

        # routes -> type
        routes_type = {}
        with z.open("routes.txt") as f:
            rd = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
            for r in rd:
                rid = r.get("route_id")
                if not rid: continue
                try:
                    routes_type[rid] = int(r.get("route_type", ""))
                except:
                    pass

        # trips -> route_id
        trip_route = {}
        with z.open("trips.txt") as f:
            rd = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
            for r in rd:
                tid = r.get("trip_id"); rid = r.get("route_id")
                if tid and rid: trip_route[tid] = rid

        # stop_times -> associe stop_id aux route_types rencontrés
        stop_types = defaultdict(list)
        with z.open("stop_times.txt") as f:
            rd = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
            for r in rd:
                sid = r.get("stop_id"); tid = r.get("trip_id")
                if not sid or not tid: continue
                rid = trip_route.get(tid)
                if not rid: continue
                rtype = routes_type.get(rid)
                if rtype is not None:
                    stop_types[sid].append(rtype)

    # Priorité pour choisir mode principal
    PRIORITY = [1, 0, 3, 4, 2, 7, 5, 6]
    features = []

    for sid, s in stops.items():
        types = stop_types.get(sid, [])
        if types:
            cnt = Counter(types)
            maxc = max(cnt.values())
            ties = [t for t,c in cnt.items() if c==maxc]
            ties.sort(key=lambda t: PRIORITY.index(t) if t in PRIORITY else 999)
            main_mode = label_route_type(ties[0])
            all_modes = sorted({label_route_type(t) for t in types})
        else:
            main_mode = "bus"
            all_modes = ["bus"]

        features.append({
            "type":"Feature",
            "properties":{
                "stop_id": s["stop_id"],
                "stop_name": s["stop_name"],
                "main_mode": main_mode,
                "modes": all_modes
            },
            "geometry":{"type":"Point","coordinates":[s["lon"], s["lat"]]}
        })

    geojson = {"type":"FeatureCollection", "features": features}
    with open(OUT_GEOJSON, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False)

    print(f"GeoJSON écrit -> {OUT_GEOJSON}")
    print(f"Nombre d'arrêts : {len(features)}")

if __name__ == "__main__":
    main()
