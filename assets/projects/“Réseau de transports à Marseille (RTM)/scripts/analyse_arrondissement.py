"""
Analyse spatiale des arrêts RTM par arrondissement (Marseille).

Entrées
- assets/data/arrondissement.geojson
- assets/data/rtm_stops.geojson
- assets/data/Marseille.geojson (optionnel, non nécessaire au calcul)

Sorties
- assets/data/arrondissements_stats.geojson (avec géométrie)
- assets/data/arrondissements_stats.csv     (sans géométrie)

Méthode
1) Chargement des arrondissements et des arrêts via GeoPandas (EPSG:4326)
2) Reprojection en EPSG:2154 (mètres) pour des aires fiables
3) Jointure spatiale des arrêts dans les arrondissements
4) Agrégation par arrondissement: total, densité (arrêts/km²),
   répartition bus/tram/métro, score brut = bus*1 + tram*2 + metro*3 + densité*2
5) Normalisation min‑max du score brut en 0–100 → indice_norm

Le script est robuste aux variations de champs mode côté arrêts:
  - 'main_mode', 'mode', 'route_type', 'vehicle_type' (GTFS)

Exécution (dans la racine du projet):
  python scripts/analyse_arrondissement.py
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import geopandas as gpd
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "assets" / "data"

PATH_ARR = DATA / "arrondissement.geojson"
PATH_STOPS = DATA / "rtm_stops.geojson"
PATH_CITY = DATA / "Marseille.geojson"  # facultatif

PATH_OUT_GEOJSON = DATA / "arrondissements_stats.geojson"
PATH_OUT_CSV = DATA / "arrondissements_stats.csv"


def detect_mode(props: dict) -> str:
    """Retourne 'bus' | 'tram' | 'metro' selon les propriétés disponibles.

    Prise en charge minimale des conventions GTFS:
    - route_type / vehicle_type: 0=tram, 1=metro, 3=bus
    - 'main_mode' ou 'mode' texte libre
    """
    if not props:
        return "bus"

    # Texte direct
    for key in ("main_mode", "mode", "MODES", "Mode"):
        v = str(props.get(key, "")).strip().lower()
        if v in {"bus", "tram", "metro", "métro"}:
            return "metro" if v.startswith("métro") or v == "metro" else v

    # Numérique GTFS
    for key in ("route_type", "vehicle_type"):
        if key in props:
            try:
                t = int(props[key])
            except Exception:
                continue
            if t == 0:
                return "tram"
            if t == 1:
                return "metro"
            if t == 3:
                return "bus"

    return "bus"


def main() -> None:
    if not PATH_ARR.exists():
        raise FileNotFoundError(f"Fichier manquant: {PATH_ARR}")
    if not PATH_STOPS.exists():
        raise FileNotFoundError(f"Fichier manquant: {PATH_STOPS}")

    arr = gpd.read_file(PATH_ARR)
    stops = gpd.read_file(PATH_STOPS)

    # Champs nom standardisés
    # Normalise le nom d'arrondissement -> 'arr_name'
    if "arr_name" in arr.columns:
        arr["arr_name"] = arr["arr_name"].astype(str)
    elif "name" in arr.columns:
        arr["arr_name"] = arr["name"].astype(str)
    elif "nom" in arr.columns:
        arr["arr_name"] = arr["nom"].astype(str)
    else:
        arr["arr_name"] = arr.index.astype(str)

    # Vérifie les géométries
    arr = arr.to_crs(2154)
    stops = stops.to_crs(2154)

    # Classifier le mode
    stops["mode_cls"] = stops.apply(lambda r: detect_mode(r.to_dict()), axis=1)

    # Jointure spatiale (arrêt dans arrondissement)
    # Utilise predicate="within" pour éviter les ambiguïtés sur la frontière
    joined = gpd.sjoin(stops[["mode_cls", "geometry"]], arr[["arr_name", "geometry"]], how="left", predicate="within")

    # Aire en km² pour chaque arrondissement
    arr["area_km2"] = arr.geometry.area / 1_000_000.0

    # Agrégations
    grp = joined.groupby("arr_name", dropna=False)
    total = grp.size().rename("arrets_total")
    by_mode = joined.pivot_table(
        index="arr_name", columns="mode_cls", values="geometry", aggfunc="count", fill_value=0
    )
    # Garantir colonnes
    for c in ("bus", "tram", "metro"):
        if c not in by_mode:
            by_mode[c] = 0
    by_mode = by_mode[["bus", "tram", "metro"]]

    stats = (
        pd.concat([total, by_mode], axis=1)
        .reset_index()
        .rename(columns={"arr_name": "arr_name"})
    )

    # Joindre les aires
    stats = stats.merge(arr[["arr_name", "area_km2"]], on="arr_name", how="left")
    stats["area_km2"] = stats["area_km2"].replace({0: pd.NA})
    stats["densite_km2"] = (stats["arrets_total"] / stats["area_km2"]).round(3)

    # Score brut et normalisation 0-100
    stats["indice"] = (
        stats["bus"] * 1.0
        + stats["tram"] * 2.0
        + stats["metro"] * 3.0
        + stats["densite_km2"].fillna(0) * 2.0
    )
    vmin = float(stats["indice"].min())
    vmax = float(stats["indice"].max())
    if vmax - vmin <= 0:
        stats["indice_norm"] = 50.0
    else:
        stats["indice_norm"] = ((stats["indice"] - vmin) / (vmax - vmin) * 100.0).round(2)

    # Fusionner dans la couche géo pour export GeoJSON
    arr_cols = [
        "arr_name",
        "arrets_total",
        "densite_km2",
        "bus",
        "tram",
        "metro",
        "indice",
        "indice_norm",
    ]
    arr_out = arr.merge(stats[arr_cols], on="arr_name", how="left")

    # Sauvegardes
    # Reprojection vers WGS84 pour un usage direct dans Leaflet (lon/lat)
    PATH_OUT_GEOJSON.parent.mkdir(parents=True, exist_ok=True)
    arr_out_4326 = arr_out.to_crs(4326)
    arr_out_4326.to_file(PATH_OUT_GEOJSON, driver="GeoJSON")

    stats_no_geom = arr_out_4326.drop(columns="geometry")
    stats_no_geom.to_csv(PATH_OUT_CSV, index=False)

    print(f"OK: {PATH_OUT_GEOJSON}")
    print(f"OK: {PATH_OUT_CSV}")


if __name__ == "__main__":
    main()
