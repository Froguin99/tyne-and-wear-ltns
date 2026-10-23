// LTN plausibility explorer: pick an area, see its neighbourhood scores, through routes and modal filters.
// Data comes from build_explorer.py (data/manifest.js + one data/<area>.js per area, loaded on demand).
(function () {
  "use strict";

  const M = window.LTN_MANIFEST;
  const ST = M.style;
  const PLACES = Object.fromEntries(M.places.map((p) => [p.key, p]));
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- map + basemap

  const map = L.map("map", { preferCanvas: true, zoomControl: false, zoomSnap: 0.25, zoomDelta: 0.5 });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.control.scale({ position: "bottomleft" }).addTo(map);

  // CARTO keys are restricted by referrer host, so pick the one for the host we're served from
  const keys = window.CARTO_KEYS || {};
  const cartoKey = keys[location.hostname] || window.CARTO_API_KEY || "";
  const attribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors '
    + '&copy; <a href="https://carto.com/attributions">CARTO</a> &middot; Contains OS data &copy; Crown copyright and database right';
  const tiles = (style) => `https://basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}{r}.png?key=${cartoKey}`;
  L.tileLayer(tiles("light_nolabels"), { attribution, maxZoom: 20 }).addTo(map);
  map.createPane("labels");
  map.getPane("labels").style.zIndex = 650;
  map.getPane("labels").style.pointerEvents = "none";
  L.tileLayer(tiles("light_only_labels"), { pane: "labels", maxZoom: 20 }).addTo(map);
  if (!keys[location.hostname] && !window.CARTO_API_KEY) {
    console.warn(`No CARTO key for host "${location.hostname}" - serve over http://localhost or http://127.0.0.1 for the basemap.`);
  }

  // ---------------------------------------------------------------- helpers

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(s);
    });
  }

  function scoreColour(score) {
    for (let i = 1; i < ST.scoreBins.length; i++) if (score <= ST.scoreBins[i]) return ST.scoreColours[i - 1];
    return ST.scoreColours[ST.scoreColours.length - 1];
  }

  const filterColour = (t) => ST.filterColours[t] || "#1f2933";
  const filterLabel = (t) => ST.filterLabels[t] || t;
  const isLine = (g) => g && (g.type === "LineString" || g.type === "MultiLineString");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function lineSymbol(style, height) {
    const bg = style.dashArray
      ? `repeating-linear-gradient(90deg, ${style.color} 0 3px, transparent 3px 6px)` : style.color;
    return `<span class="line" style="background:${bg};height:${height}px"></span>`;
  }

  function neighbourhoodTip(p) {
    const rows = [["LTN score", p.score], ["No rat-runs", p.rr], ["Low permeability", p.perm], ["Modal filters", p.filt]];
    if (p.n_rr !== null && p.n_rr !== undefined) {
      rows.push(["Through routes (faster or up to 50% slower)", p.n_rr], ["Through routes (50&ndash;100% slower)", p.n_slow]);
    }
    return `<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v ?? "&ndash;"}</td></tr>`).join("")}</table>`;
  }

  // ---------------------------------------------------------------- layers

  // draw order, bottom to top (canvas: later layers paint over earlier ones)
  const roadOrder = ST.roadLegend.map(([k]) => k).reverse();
  const ORDER = ["mask", "neighbourhoods", ...roadOrder, "boundary", "others", "filterLines", "filterPoints"];
  const ALWAYS = new Set(["mask", "boundary", "others"]);
  const visible = { neighbourhoods: true, filterLines: true, filterPoints: true };
  ST.roadLegend.forEach(([k]) => { visible[k] = true; });

  const group = L.layerGroup().addTo(map);
  let layers = {};
  let current = null;

  function restack() {
    group.clearLayers();
    ORDER.forEach((k) => { if (layers[k] && (ALWAYS.has(k) || visible[k])) group.addLayer(layers[k]); });
  }

  function maskLayer(boundary) {
    const holes = [];
    boundary.features.forEach((f) => {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      polys.forEach((poly) => holes.push(L.GeoJSON.coordsToLatLngs(poly[0])));
    });
    const world = [[48, -12], [48, 6], [62, 6], [62, -12]];
    return L.polygon([world, ...holes], { stroke: false, fillColor: "#ffffff", fillOpacity: 0.72, interactive: false });
  }

  // the other areas: faint tint + a name label; click either to switch
  function othersLayer(currentKey) {
    const others = M.places.filter((p) => p.key !== currentKey);
    const areas = L.geoJSON({ type: "FeatureCollection", features: others.map((p) => ({ ...p.outline, properties: { key: p.key, label: p.label } })) }, {
      style: { color: "#7b8794", weight: 1.2, dashArray: "4 4", fillColor: "#7b8794", fillOpacity: 0.08 },
      onEachFeature: (f, l) => {
        l.bindTooltip(`Show <strong>${esc(f.properties.label)}</strong>`, { sticky: true, className: "ltn-tip" });
        l.on("mouseover", () => l.setStyle({ fillOpacity: 0.16, color: "#3e4c59" }));
        l.on("mouseout", () => l.setStyle({ fillOpacity: 0.08, color: "#7b8794" }));
        l.on("click", () => selectPlace(f.properties.key));
      },
    });
    const at = PLACES[currentKey].neighbourLabels || {};
    const labels = others.filter((p) => at[p.key] || p.labelAt).map((p) => L.marker(at[p.key] || p.labelAt, {
      icon: L.divIcon({ className: "area-label", html: `<span>${esc(p.label)} &rsaquo;</span>`, iconSize: null }),
      keyboard: true, title: `Show ${p.label}`,
    }).on("click", () => selectPlace(p.key)));
    return L.layerGroup([areas, ...labels]);
  }

  function buildLayers(key) {
    const D = window.LTN_DATA[key];
    const out = { mask: maskLayer(D.boundary), others: othersLayer(key) };

    const nb = L.geoJSON(D.neighbourhoods, {
      style: (f) => ({ fillColor: scoreColour(f.properties.score), fillOpacity: 0.78, color: "#ffffff", weight: 0.8 }),
      onEachFeature: (f, l) => {
        l.bindTooltip(neighbourhoodTip(f.properties), { sticky: true, className: "ltn-tip" });
        l.on("mouseover", () => { l.setStyle({ color: "#1f2933", weight: 2, fillOpacity: 0.9 }); });
        l.on("mouseout", () => { nb.resetStyle(l); });
      },
    });
    out.neighbourhoods = nb;

    ST.roadLegend.forEach(([k]) => {
      const fc = D.roads[k];
      if (fc && fc.features.length) out[k] = L.geoJSON(fc, { style: ST.roadStyles[k], interactive: false });
    });

    out.boundary = L.geoJSON(D.boundary, {
      style: { color: "#3e4c59", weight: 1.5, fill: false, dashArray: "4 4" }, interactive: false,
    });

    const tip = (f) => `${esc(filterLabel(f.properties.type))}${f.properties.name ? ` &middot; ${esc(f.properties.name)}` : ""}`;
    const lineFeats = D.filters.features.filter((f) => isLine(f.geometry));
    const pointFeats = D.filters.features.filter((f) => !isLine(f.geometry));
    if (lineFeats.length) {
      out.filterLines = L.geoJSON({ type: "FeatureCollection", features: lineFeats }, {
        style: (f) => ({ color: filterColour(f.properties.type), weight: 3, opacity: 0.95 }),
        onEachFeature: (f, l) => l.bindTooltip(tip(f), { className: "ltn-tip" }),
      });
    }
    if (pointFeats.length) {
      out.filterPoints = L.geoJSON({ type: "FeatureCollection", features: pointFeats }, {
        pointToLayer: (f, latlng) => L.circleMarker(latlng, {
          radius: 2.8, color: "#ffffff", weight: 0.8, fillColor: filterColour(f.properties.type), fillOpacity: 1,
        }),
        onEachFeature: (f, l) => l.bindTooltip(tip(f), { className: "ltn-tip" }),
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- key / toggles

  function renderScale() {
    const b = ST.scoreBins;
    $("scale").innerHTML = ST.scoreColours.map((c, i) =>
      `<div class="step"><span class="sw" style="background:${c}"></span>${b[i]}&ndash;${b[i + 1]}</div>`).join("");
  }

  function renderKey(key) {
    const D = window.LTN_DATA[key];

    // modal filters: count per type, symbol by the geometries that type actually has in this area
    const types = new Map();
    D.filters.features.forEach((f) => {
      const t = types.get(f.properties.type) || { n: 0, line: false, point: false };
      t.n += 1;
      if (isLine(f.geometry)) t.line = true; else t.point = true;
      types.set(f.properties.type, t);
    });
    const sorted = [...types.entries()].sort((a, b) => b[1].n - a[1].n);
    $("filterRows").innerHTML = sorted.map(([t, info]) => {
      const c = filterColour(t);
      const sym = (info.line ? `<span class="line" style="background:${c};height:3px"></span>` : "")
        + (info.point ? `<span class="dot" style="background:${c}"></span>` : "");
      return `<div class="row"><span class="sym">${sym}</span>${esc(filterLabel(t))}<span class="count">${info.n}</span></div>`;
    }).join("") || `<div class="row off">None mapped</div>`;
    $("chipLines").hidden = !layers.filterLines;
    $("chipPoints").hidden = !layers.filterPoints;

    // roads: each row toggles its layer
    $("roadRows").innerHTML = ST.roadLegend.filter(([k]) => layers[k]).map(([k, label]) => {
      const s = ST.roadStyles[k];
      return `<label class="row${visible[k] ? "" : " off"}"><input type="checkbox" data-layer="${k}"${visible[k] ? " checked" : ""}>`
        + `<span class="sym">${lineSymbol(s, Math.max(s.weight, 1.2).toFixed(1))}</span>${label}</label>`;
    }).join("");

    $("meta").textContent = `${D.neighbourhoods.features.length} neighbourhoods · ${D.filters.features.length} filters · hover for detail`;
  }

  document.addEventListener("change", (e) => {
    const k = e.target.dataset && e.target.dataset.layer;
    if (!k) return;
    visible[k] = e.target.checked;
    const row = e.target.closest(".row");
    if (row) row.classList.toggle("off", !visible[k]);
    restack();
  });

  // ---------------------------------------------------------------- area switching

  const select = $("place");
  select.innerHTML = M.places.map((p) => `<option value="${p.key}">${esc(p.label)}</option>`).join("");
  select.addEventListener("change", () => selectPlace(select.value));

  function fitPlace(key) {
    const wide = window.innerWidth > 700;
    const panelW = wide ? $("panel").offsetWidth + 32 : 10;
    map.fitBounds(PLACES[key].bounds, { paddingTopLeft: [panelW, 20], paddingBottomRight: [20, 20] });
  }

  async function selectPlace(key) {
    if (!PLACES[key]) key = M.places[0].key;
    if (key === current) return;
    if (!(window.LTN_DATA && window.LTN_DATA[key])) {
      $("loading").hidden = false;
      try { await loadScript(PLACES[key].file); } finally { $("loading").hidden = true; }
    }
    current = key;
    layers = buildLayers(key);
    restack();
    renderKey(key);
    select.value = key;
    document.title = `${PLACES[key].label} · LTN Plausibility Explorer`;
    history.replaceState(null, "", `#area=${key}`);
    fitPlace(key);
  }

  // ---------------------------------------------------------------- panel

  function setCollapsed(collapsed) {
    $("panel").classList.toggle("collapsed", collapsed);
    $("collapse").textContent = collapsed ? "Show key" : "Hide key";
    $("collapse").setAttribute("aria-expanded", String(!collapsed));
  }
  $("collapse").addEventListener("click", () => setCollapsed(!$("panel").classList.contains("collapsed")));
  if (window.innerWidth <= 600) setCollapsed(true);  // phones: start with the map visible

  window.addEventListener("hashchange", () => selectPlace(new URLSearchParams(location.hash.slice(1)).get("area")));

  window.LTN_APP = { map, group, layers: () => layers, selectPlace };  // handy from the browser console

  renderScale();
  selectPlace(new URLSearchParams(location.hash.slice(1)).get("area") || M.places[0].key);
})();
