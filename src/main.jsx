import React, { useMemo, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Upload, Save, Trash2, Route, Gauge, Bike, Info, SlidersHorizontal, MapPinned, Check, Lock, Unlock, FileText, Activity } from 'lucide-react';
import './styles.css';

const BAR_PER_PSI = 0.0689476;

const routeModes = {
  smooth_road: {
    label: 'Smooth road',
    desc: 'Fast asphalt, low vibration',
    factor: 0.96,
  },
  bad_asphalt: {
    label: 'Bad asphalt',
    desc: 'Cracks, chipseal, rough paved roads',
    factor: 0.86,
  },
  mixed: {
    label: 'Mixed road & gravel',
    desc: 'A balanced all-road route',
    factor: 0.88,
  },
  fast_gravel: {
    label: 'Fast gravel',
    desc: 'Compact gravel and smoother dirt roads',
    factor: 0.92,
  },
  rough_gravel: {
    label: 'Rough gravel',
    desc: 'Loose, rocky or uneven gravel',
    factor: 0.80,
  },
  loaded_bikepacking: {
    label: 'Loaded bikepacking',
    desc: 'Long ride, mixed surfaces and extra gear',
    factor: 0.86,
  },
};

const surfaceTypes = {
  paved: {
    label: 'Paved',
    hint: 'Asphalt, concrete, smooth cycleways',
    factor: 0.96,
  },
  hardpack: {
    label: 'Hardpack / fast gravel',
    hint: 'Compact gravel and smooth dirt roads',
    factor: 0.88,
  },
  loose: {
    label: 'Loose / rough gravel',
    hint: 'Coarse gravel, washboard, rocky roads',
    factor: 0.80,
  },
  trail: {
    label: 'Trail / singletrack',
    hint: 'Roots, rocks, forest paths',
    factor: 0.74,
  },
  unknown: {
    label: 'Unknown',
    hint: 'Use when GPX or route source does not say',
    factor: 0.88,
  },
};

const defaultSurfaces = {
  paved: '',
  hardpack: '',
  loose: '',
  trail: '',
  unknown: '',
};

const surfacePresets = {
  smooth_road: { paved: '98', hardpack: '', loose: '', trail: '', unknown: '2' },
  bad_asphalt: { paved: '95', hardpack: '', loose: '', trail: '', unknown: '5' },
  mixed: { paved: '50', hardpack: '30', loose: '10', trail: '', unknown: '10' },
  fast_gravel: { paved: '25', hardpack: '60', loose: '10', trail: '', unknown: '5' },
  rough_gravel: { paved: '15', hardpack: '30', loose: '40', trail: '5', unknown: '10' },
  loaded_bikepacking: { paved: '70', hardpack: '20', loose: '5', trail: '', unknown: '5' },
};

function surfacesForRouteMode(mode) {
  return cleanSurfaceMix({ ...defaultSurfaces, ...(surfacePresets[mode] || surfacePresets.mixed) });
}

function cleanSurfaceMix(surfaceMix) {
  const keys = Object.keys(surfaceTypes);
  const values = keys.map((key) => Math.max(0, Number(String(surfaceMix?.[key] ?? '0').replace(',', '.')) || 0));
  const total = values.reduce((sum, value) => sum + value, 0);

  if (total <= 0) {
    return { paved: '0', hardpack: '0', loose: '0', trail: '0', unknown: '100' };
  }

  const exact = values.map((value) => (value / total) * 100);
  const floored = exact.map(Math.floor);
  let remaining = 100 - floored.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (let i = 0; i < remaining; i += 1) {
    floored[order[i % order.length].index] += 1;
  }

  return Object.fromEntries(keys.map((key, index) => [key, String(floored[index])])) ;
}

function redistributeSurfaceMix(currentMix, changedKey, nextValue) {
  const keys = Object.keys(surfaceTypes);
  const clamped = Math.max(0, Math.min(100, Math.round(Number(nextValue) || 0)));
  const otherKeys = keys.filter((key) => key !== changedKey);
  const current = cleanSurfaceMix(currentMix);
  const remaining = 100 - clamped;
  const otherTotal = otherKeys.reduce((sum, key) => sum + parsePercent(current[key]), 0);
  const next = { [changedKey]: String(clamped) };

  if (remaining === 0) {
    otherKeys.forEach((key) => { next[key] = '0'; });
    return next;
  }

  if (otherTotal <= 0) {
    otherKeys.forEach((key) => { next[key] = key === 'unknown' ? String(remaining) : '0'; });
    if (!otherKeys.includes('unknown')) next[otherKeys[0]] = String(remaining);
    return next;
  }

  const exact = otherKeys.map((key) => (parsePercent(current[key]) / otherTotal) * remaining);
  const floored = exact.map(Math.floor);
  let leftover = remaining - floored.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (let i = 0; i < leftover; i += 1) {
    floored[order[i % order.length].index] += 1;
  }

  otherKeys.forEach((key, index) => { next[key] = String(floored[index]); });
  return next;
}

function redistributeSurfaceMixWithLocks(currentMix, changedKey, nextValue, lockedKeys = {}) {
  const keys = Object.keys(surfaceTypes);
  const current = cleanSurfaceMix(currentMix);
  const nextLocks = { ...lockedKeys, [changedKey]: true };
  const otherLockedKeys = keys.filter((key) => key !== changedKey && nextLocks[key]);
  const lockedOtherTotal = otherLockedKeys.reduce((sum, key) => sum + parsePercent(current[key]), 0);
  const clamped = Math.max(0, Math.min(100 - lockedOtherTotal, Math.round(Number(nextValue) || 0)));

  const next = Object.fromEntries(keys.map((key) => [key, '0']));
  otherLockedKeys.forEach((key) => { next[key] = String(parsePercent(current[key])); });
  next[changedKey] = String(clamped);

  const unlockedKeys = keys.filter((key) => !nextLocks[key]);
  const remaining = Math.max(0, 100 - lockedOtherTotal - clamped);

  if (unlockedKeys.length === 0) {
    return cleanSurfaceMix(next);
  }

  if (remaining === 0) {
    unlockedKeys.forEach((key) => { next[key] = '0'; });
    return next;
  }

  const unlockedCurrentTotal = unlockedKeys.reduce((sum, key) => sum + parsePercent(current[key]), 0);
  let exact;

  if (unlockedCurrentTotal > 0) {
    exact = unlockedKeys.map((key) => (parsePercent(current[key]) / unlockedCurrentTotal) * remaining);
  } else {
    exact = unlockedKeys.map((key) => (key === 'unknown' ? remaining : 0));
    if (!unlockedKeys.includes('unknown')) exact[0] = remaining;
  }

  const floored = exact.map(Math.floor);
  let leftover = remaining - floored.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (let i = 0; i < leftover; i += 1) {
    floored[order[i % order.length].index] += 1;
  }

  unlockedKeys.forEach((key, index) => { next[key] = String(floored[index]); });
  return next;
}

const goals = {
  race: { label: 'Faster', center: 1.03, spread: 0.055, note: 'Higher end of the useful range.' },
  balanced: { label: 'Balanced', center: 1.0, spread: 0.075, note: 'Good starting point for most rides.' },
  comfort: { label: 'Softer', center: 0.95, spread: 0.095, note: 'More comfort and grip, less margin for rim strikes.' },
};

const tireSetups = {
  tubeless: { label: 'Tubeless', factor: 0.97, minBar: 1.2 },
  tube: { label: 'Inner tube', factor: 1.03, minBar: 1.5 },
};

function haversineMeters(a, b) {
  const R = 6371000;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function routeBounds(points) {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  return {
    south: Math.min(...lats),
    north: Math.max(...lats),
    west: Math.min(...lons),
    east: Math.max(...lons),
  };
}

function padBounds(bounds, pad = 0.006) {
  return {
    south: bounds.south - pad,
    north: bounds.north + pad,
    west: bounds.west - pad,
    east: bounds.east + pad,
  };
}

function boundsAreaDegrees(bounds) {
  return Math.max(0, bounds.north - bounds.south) * Math.max(0, bounds.east - bounds.west);
}

function sampleRoutePoints(points, maxSamples = 500) {
  if (points.length <= maxSamples) return points;
  const step = (points.length - 1) / (maxSamples - 1);
  return Array.from({ length: maxSamples }, (_, index) => points[Math.round(index * step)]);
}

function metersProject(point, origin) {
  const latMeters = 111320;
  const lonMeters = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  return {
    x: (point.lon - origin.lon) * lonMeters,
    y: (point.lat - origin.lat) * latMeters,
  };
}

function pointToSegmentMeters(point, start, end) {
  const p = metersProject(point, point);
  const a = metersProject(start, point);
  const b = metersProject(end, point);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  const closest = { x: a.x + t * dx, y: a.y + t * dy };
  return Math.hypot(p.x - closest.x, p.y - closest.y);
}

function normalizeOsmValue(value) {
  return String(value || '').toLowerCase().trim().replaceAll(' ', '_');
}

function classifyOsmWay(tags = {}) {
  const surface = normalizeOsmValue(tags.surface);
  const highway = normalizeOsmValue(tags.highway);
  const tracktype = normalizeOsmValue(tags.tracktype);
  const smoothness = normalizeOsmValue(tags.smoothness);

  const pavedSurfaces = new Set(['paved', 'asphalt', 'concrete', 'concrete:lanes', 'concrete:plates', 'paving_stones', 'sett', 'cobblestone', 'unhewn_cobblestone', 'metal', 'wood']);
  const hardpackSurfaces = new Set(['compacted', 'fine_gravel', 'gravel', 'chipseal']);
  const looseSurfaces = new Set(['unpaved', 'ground', 'earth', 'dirt', 'mud', 'sand', 'grass', 'grass_paver', 'pebblestone', 'rock', 'salt', 'snow']);

  if (pavedSurfaces.has(surface)) return { key: 'paved', explicit: true, highway };
  if (hardpackSurfaces.has(surface)) return { key: 'hardpack', explicit: true, highway };
  if (looseSurfaces.has(surface)) return { key: highway === 'path' ? 'hardpack' : 'loose', explicit: true, highway };

  if (tracktype === 'grade1') return { key: 'hardpack', explicit: true, highway };
  if (tracktype === 'grade2') return { key: 'hardpack', explicit: true, highway };
  if (['grade3', 'grade4', 'grade5'].includes(tracktype)) return { key: 'loose', explicit: true };
  if (['bad', 'very_bad', 'horrible', 'very_horrible', 'impassable'].includes(smoothness)) return { key: highway === 'path' ? 'hardpack' : 'loose', explicit: true, highway };

  const normallyPavedHighways = [
    'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
    'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential',
    'living_street', 'unclassified', 'service', 'road', 'cycleway', 'pedestrian',
  ];
  if (normallyPavedHighways.includes(highway)) {
    return { key: 'paved', explicit: false, highway };
  }
  if (highway === 'track') return { key: 'hardpack', explicit: false, highway };
  // A generic OSM path is often a compacted cycle/foot path rather than true singletrack.
  // Only classify as trail when OSM explicitly says it is rough/loose above.
  if (['path', 'bridleway', 'footway', 'steps'].includes(highway)) return { key: 'hardpack', explicit: false, highway };

  return { key: 'unknown', explicit: false, highway };
}

function precomputeOsmSegments(elements = []) {
  const segments = [];
  elements.forEach((way) => {
    if (!way.geometry || way.geometry.length < 2) return;
    const classification = classifyOsmWay(way.tags || {});
    for (let i = 1; i < way.geometry.length; i += 1) {
      const start = { lat: way.geometry[i - 1].lat, lon: way.geometry[i - 1].lon };
      const end = { lat: way.geometry[i].lat, lon: way.geometry[i].lon };
      segments.push({
        start,
        end,
        classification,
        minLat: Math.min(start.lat, end.lat),
        maxLat: Math.max(start.lat, end.lat),
        minLon: Math.min(start.lon, end.lon),
        maxLon: Math.max(start.lon, end.lon),
      });
    }
  });
  return segments;
}


function makeOverpassChunks(points, pointsPerChunk = 8, maxChunks = 32) {
  // Keep the browser MVP fast and predictable: sample a modest number of points
  // and query OSM around those points. This avoids huge geometry responses.
  const sampled = sampleRoutePoints(points, Math.min(180, Math.max(70, Math.round(points.length / 28))));
  const chunks = [];

  for (let index = 0; index < sampled.length; index += pointsPerChunk) {
    const chunk = sampled.slice(index, index + pointsPerChunk);
    if (chunk.length >= 1) chunks.push(chunk);
  }

  if (chunks.length <= maxChunks) return chunks;

  const step = (chunks.length - 1) / (maxChunks - 1);
  return Array.from({ length: maxChunks }, (_, index) => chunks[Math.round(index * step)]).filter(Boolean);
}


function normalizeSurfaceMix(surfaceMix) {
  return getSurfaceStats(surfaceMix).normalized;
}

function fallbackPartialFromSurfaceMix(points, surfaceMix) {
  const samples = sampleRoutePoints(points, Math.max(1, Math.min(20, points.length)));
  const normalized = normalizeSurfaceMix(surfaceMix);
  const counts = { paved: 0, hardpack: 0, loose: 0, trail: 0, unknown: 0 };
  const keys = Object.keys(counts);

  samples.forEach((_, index) => {
    const target = ((index + 0.5) / samples.length) * 100;
    let cumulative = 0;
    let chosen = 'unknown';
    for (const key of keys) {
      cumulative += normalized[key] || 0;
      if (target <= cumulative) {
        chosen = key;
        break;
      }
    }
    counts[chosen] += 1;
  });

  return {
    counts,
    matched: 0,
    explicit: 0,
    total: samples.length || 1,
    fallback: true,
  };
}

function unknownPartial(points) {
  const samples = sampleRoutePoints(points, Math.max(1, Math.min(20, points.length)));
  return {
    counts: { paved: 0, hardpack: 0, loose: 0, trail: 0, unknown: samples.length || 1 },
    matched: 0,
    explicit: 0,
    total: samples.length || 1,
    fallback: true,
  };
}

function withTimeout(promise, timeoutMs, message = 'Timed out') {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

async function fetchOverpassChunk(chunk) {
  const queryPoints = sampleRoutePoints(chunk, Math.min(5, chunk.length));
  const aroundQueries = queryPoints
    .map((point) => `way["highway"](around:25,${point.lat.toFixed(6)},${point.lon.toFixed(6)});`)
    .join('');

  // Request lightweight geometry so each GPX sample can be matched to the
  // nearest OSM way instead of counting every nearby side road or forest track.
  const query = `[out:json][timeout:8];(${aroundQueries});out tags geom qt 160;`;
  const endpoints = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter',
  ];

  let lastError = null;
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8500);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      window.clearTimeout(timeout);
      if (!response.ok) throw new Error(`OpenStreetMap request failed (${response.status}).`);
      return await withTimeout(response.json(), 3500, 'OpenStreetMap response was too large.');
    } catch (err) {
      window.clearTimeout(timeout);
      lastError = err;
    }
  }
  throw lastError || new Error('OpenStreetMap analysis failed.');
}

function chooseClassForPoint(point, segments) {
  const nearby = [];

  for (const segment of segments) {
    const latPad = 0.00055;
    const lonPad = 0.0009;
    if (point.lat < segment.minLat - latPad || point.lat > segment.maxLat + latPad) continue;
    if (point.lon < segment.minLon - lonPad || point.lon > segment.maxLon + lonPad) continue;

    const distance = pointToSegmentMeters(point, segment.start, segment.end);
    if (distance <= 55) nearby.push({ distance, classification: segment.classification });
  }

  if (nearby.length === 0) return { key: 'unknown', explicit: false, matched: false };

  nearby.sort((a, b) => a.distance - b.distance);

  const explicitPaved = nearby
    .filter((item) => item.classification.explicit && item.classification.key === 'paved')
    .sort((a, b) => a.distance - b.distance)[0];
  const explicitUnpaved = nearby
    .filter((item) => item.classification.explicit && item.classification.key !== 'paved' && item.classification.key !== 'unknown')
    .sort((a, b) => a.distance - b.distance)[0];
  const implicitPaved = nearby
    .filter((item) => !item.classification.explicit && item.classification.key === 'paved')
    .sort((a, b) => a.distance - b.distance)[0];
  const implicitUnpaved = nearby
    .filter((item) => !item.classification.explicit && item.classification.key !== 'paved' && item.classification.key !== 'unknown')
    .sort((a, b) => a.distance - b.distance)[0];

  // Surface tags are more reliable than highway type guesses. This is the key
  // fix for mixed routes: a nearby way tagged gravel/unpaved/compacted must not
  // be overwritten just because an ordinary road is also within the search radius.
  if (explicitUnpaved) {
    if (!explicitPaved || explicitUnpaved.distance <= explicitPaved.distance + 18) {
      if (!implicitPaved || explicitUnpaved.distance <= implicitPaved.distance + 28) {
        return { ...explicitUnpaved.classification, matched: true };
      }
    }
  }

  if (explicitPaved) {
    if (!explicitUnpaved || explicitPaved.distance <= explicitUnpaved.distance + 12) {
      return { ...explicitPaved.classification, matched: true };
    }
  }

  // If the GPX point is clearly on a track/path, trust that geometry over a
  // nearby road. This prevents gravel routes from becoming 100% paved.
  if (implicitUnpaved) {
    if (!implicitPaved || implicitUnpaved.distance + 10 < implicitPaved.distance) {
      return { ...implicitUnpaved.classification, matched: true };
    }
  }

  if (implicitPaved) return { ...implicitPaved.classification, matched: true };

  const nearest = nearby[0];
  if (nearest.distance <= 35) return { ...nearest.classification, matched: true };
  return { key: 'unknown', explicit: false, matched: false };
}

function analyzeOsmSurfaceMatch(points, elements) {
  const samples = sampleRoutePoints(points, Math.max(1, Math.min(20, points.length || 1)));
  const counts = { paved: 0, hardpack: 0, loose: 0, trail: 0, unknown: 0 };
  let explicit = 0;
  let matched = 0;

  const segments = precomputeOsmSegments((elements || []).filter((way) => way.tags?.highway));

  if (segments.length === 0) {
    counts.unknown = samples.length || 1;
    return { counts, matched: 0, explicit: 0, total: samples.length || 1 };
  }

  samples.forEach((point) => {
    const classification = chooseClassForPoint(point, segments);
    counts[classification.key] += 1;
    if (classification.matched) matched += 1;
    if (classification.explicit) explicit += 1;
  });

  return {
    counts,
    matched,
    explicit,
    total: samples.length || 1,
  };
}

function combineSurfaceAnalyses(partials, failedChunks = 0) {
  const counts = { paved: 0, hardpack: 0, loose: 0, trail: 0, unknown: 0 };
  let matched = 0;
  let explicit = 0;
  let total = 0;
  let fallbackChunks = 0;

  partials.forEach((partial) => {
    Object.keys(counts).forEach((key) => { counts[key] += partial.counts[key] || 0; });
    matched += partial.matched || 0;
    explicit += partial.explicit || 0;
    total += partial.total || 0;
    if (partial.fallback) fallbackChunks += 1;
  });

  if (total === 0) {
    return {
      percentages: { paved: 50, hardpack: 30, loose: 10, trail: 0, unknown: 10 },
      matchedPercent: 0,
      explicitPercent: 0,
      confidence: 'Fallback',
      failedChunks,
      fallbackChunks,
    };
  }

  let percentages = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, (value / total) * 100]));

  // Keep Unknown visible instead of silently redistributing failed or missing OSM data.
  // This is less pretty, but avoids confidently wrong results such as 100% paved.

  const matchedPercent = (matched / total) * 100;
  const explicitPercent = matched > 0 ? (explicit / matched) * 100 : 0;

  let confidence = 'Approximate';
  if (matchedPercent > 70 && failedChunks === 0) confidence = 'Good';
  else if (matchedPercent < 35 || fallbackChunks > partials.length / 2) confidence = 'Limited';

  return { percentages, matchedPercent, explicitPercent, confidence, failedChunks, fallbackChunks };
}

async function fetchAndAnalyzeOverpassSurfaces(points, onProgress, fallbackSurfaces = surfacePresets.mixed) {
  const chunks = makeOverpassChunks(points);
  const partials = [];
  const concurrency = Math.min(6, chunks.length);
  let completed = 0;
  let nextIndex = 0;
  let failedChunks = 0;
  let stoppedByDeadline = false;
  const deadline = Date.now() + 35000;

  async function analyzeOne(index) {
    if (Date.now() > deadline) {
      stoppedByDeadline = true;
      return unknownPartial(chunks[index]);
    }

    try {
      const data = await withTimeout(fetchOverpassChunk(chunks[index]), 10500, 'OpenStreetMap section timed out.');
      const partial = analyzeOsmSurfaceMatch(chunks[index], data.elements || []);
      if ((partial.matched || 0) === 0) return unknownPartial(chunks[index]);
      return partial;
    } catch (err) {
      failedChunks += 1;
      return unknownPartial(chunks[index]);
    }
  }

  async function worker() {
    while (nextIndex < chunks.length) {
      const index = nextIndex;
      nextIndex += 1;
      const partial = await analyzeOne(index);
      partials.push(partial);
      completed += 1;
      if (onProgress) onProgress(completed, chunks.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const result = combineSurfaceAnalyses(partials, failedChunks);
  if (stoppedByDeadline) result.confidence = 'Approximate';
  return result;
}


function calculateFilteredElevation(points, distanceKm) {
  const elevations = points
    .map((point) => point.ele)
    .filter((value) => Number.isFinite(value));

  if (elevations.length < 2) {
    return { gain: null, loss: null };
  }

  // GPX elevation often contains small saw-tooth noise. Summing every tiny
  // up/down step can almost double the climbing estimate on long routes.
  // Use a deadband: short routes keep more detail, long routes need stronger
  // filtering. This keeps HERO_2026-type long road routes close to route
  // planner values instead of raw noisy elevation totals.
  let deadband = 3;
  if (distanceKm > 150) deadband = 8;
  else if (distanceKm > 60) deadband = 5;

  let gain = 0;
  let loss = 0;
  let anchor = elevations[0];

  for (let i = 1; i < elevations.length; i += 1) {
    const current = elevations[i];
    const delta = current - anchor;
    if (Math.abs(delta) >= deadband && Math.abs(delta) < 120) {
      if (delta > 0) gain += delta;
      else loss += Math.abs(delta);
      anchor = current;
    }
  }

  return { gain, loss };
}

function parseGpx(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const error = doc.querySelector('parsererror');
  if (error) throw new Error('The GPX file could not be parsed.');

  const nodes = Array.from(doc.querySelectorAll('trkpt, rtept'));
  if (nodes.length < 2) throw new Error('The GPX file does not contain enough route points.');

  const points = nodes
    .map((node) => ({
      lat: Number(node.getAttribute('lat')),
      lon: Number(node.getAttribute('lon')),
      ele: node.querySelector('ele') ? Number(node.querySelector('ele').textContent) : null,
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  let distance = 0;
  let gain = 0;
  let loss = 0;
  let directionChanges = 0;
  let previousBearing = null;

  function bearing(p1, p2) {
    const y = Math.sin(((p2.lon - p1.lon) * Math.PI) / 180) * Math.cos((p2.lat * Math.PI) / 180);
    const x = Math.cos((p1.lat * Math.PI) / 180) * Math.sin((p2.lat * Math.PI) / 180) - Math.sin((p1.lat * Math.PI) / 180) * Math.cos((p2.lat * Math.PI) / 180) * Math.cos(((p2.lon - p1.lon) * Math.PI) / 180);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  for (let i = 1; i < points.length; i += 1) {
    const segment = haversineMeters(points[i - 1], points[i]);
    if (segment > 0 && segment < 2000) distance += segment;

    if (segment > 20) {
      const b = bearing(points[i - 1], points[i]);
      if (previousBearing !== null) {
        const diff = Math.abs(b - previousBearing);
        const normalized = Math.min(diff, 360 - diff);
        if (normalized > 25) directionChanges += 1;
      }
      previousBearing = b;
    }
  }

  const km = distance / 1000;
  const hasElevation = points.some((p) => p.ele !== null);
  if (hasElevation) {
    const filteredElevation = calculateFilteredElevation(points, km);
    gain = filteredElevation.gain ?? 0;
    loss = filteredElevation.loss ?? 0;
  }
  const climbingPer100Km = km > 0 ? (gain / km) * 100 : 0;
  const turnsPerKm = km > 0 ? directionChanges / km : 0;

  let suggestedMode = 'smooth_road';
  // GPX elevation and route shape do not reveal road surface. Avoid turning a
  // hilly paved brevet into a gravel preset just because it has lots of climbing.
  if (turnsPerKm > 8) suggestedMode = 'mixed';
  else if (turnsPerKm > 5) suggestedMode = 'bad_asphalt';
  else if (climbingPer100Km > 700) suggestedMode = 'bad_asphalt';
  else suggestedMode = 'smooth_road';

  let climbingLabel = 'Unknown climbing';
  if (hasElevation) {
    if (climbingPer100Km < 350) climbingLabel = 'Flat / gentle';
    else if (climbingPer100Km < 900) climbingLabel = 'Rolling';
    else if (climbingPer100Km < 1500) climbingLabel = 'Hilly';
    else climbingLabel = 'Very hilly';
  }

  let routeShapeLabel = 'Straight / steady';
  if (turnsPerKm > 8) routeShapeLabel = 'Very twisty / technical';
  else if (turnsPerKm > 5) routeShapeLabel = 'Twisty';
  else if (turnsPerKm > 2.5) routeShapeLabel = 'Moderately twisty';

  return {
    distanceKm: km,
    elevationGainM: hasElevation ? gain : null,
    elevationLossM: hasElevation ? loss : null,
    climbingPer100Km: hasElevation ? climbingPer100Km : null,
    turnsPerKm,
    climbingLabel,
    routeShapeLabel,
    suggestedMode,
    points,
    surfaceSource: 'GPX files usually do not contain surface data. TrailPSI uses the route shape and elevation to choose a surface preset, which you can edit.',
  };
}

function bertoPressurePsi(wheelLoadLbs, tireWidthMm) {
  // Empirical 15% tire-drop style baseline.
  // Uses wheel load in pounds and measured/nominal tire width in millimeters.
  const traditionalBerto = (600 * wheelLoadLbs) / (tireWidthMm * tireWidthMm) + 0.75 * tireWidthMm - 25;
  // Modern wide tubeless/gravel setups are often run lower than the classic Berto baseline.
  // This keeps the same load/width relationship but calibrates the MVP closer to contemporary calculators.
  const pressure = traditionalBerto * 0.85;
  return Math.max(8, pressure);
}

function parsePercent(value) {
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function getSurfaceStats(surfaces) {
  const raw = Object.fromEntries(Object.keys(surfaceTypes).map((key) => [key, parsePercent(surfaces?.[key])]));
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return {
      hasManualSurfaces: false,
      total: 0,
      normalized: { paved: 0, hardpack: 0, loose: 0, trail: 0, unknown: 100 },
      factor: null,
      confidence: 'Manual surface mix not set',
    };
  }

  const normalized = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, (value / total) * 100]));
  const factor = Object.entries(normalized).reduce((sum, [key, percent]) => sum + (percent / 100) * surfaceTypes[key].factor, 0);
  const knownPercent = 100 - normalized.unknown;

  let confidence = 'High';
  if (knownPercent < 50) confidence = 'Low';
  else if (knownPercent < 80) confidence = 'Medium';

  return { hasManualSurfaces: true, total, normalized, factor, confidence };
}

function suggestRouteModeFromSurfaces(surfaces) {
  const stats = getSurfaceStats(surfaces);
  if (!stats.hasManualSurfaces) return null;
  const s = stats.normalized;
  if (s.trail + s.loose > 45) return 'rough_gravel';
  if (s.hardpack + s.loose + s.trail > 55) return 'fast_gravel';
  if (s.paved > 80) return 'smooth_road';
  if (s.paved > 60 && s.loose + s.trail < 15) return 'bad_asphalt';
  return 'mixed';
}

function calculatePressure({ totalWeight, tireWidth, setup, routeMode, goal, weightUnit, surfaces }) {
  const enteredWeight = Number(totalWeight);
  const weight = weightUnit === 'lb' ? enteredWeight / 2.20462 : enteredWeight;
  const width = Number(tireWidth);
  if (!weight || !width || width < 20) return null;

  const route = routeModes[routeMode] ?? routeModes.mixed;
  const tire = tireSetups[setup] ?? tireSetups.tubeless;
  const g = goals[goal] ?? goals.balanced;
  const surfaceStats = getSurfaceStats(surfaces);

  // With only total system weight as input, use a practical default load split.
  // Most road/gravel bikes carry more load on the rear wheel.
  const frontLoadLbs = weight * 0.45 * 2.20462;
  const rearLoadLbs = weight * 0.55 * 2.20462;

  const routeFactor = surfaceStats.hasManualSurfaces ? surfaceStats.factor : route.factor;
  const totalFactor = routeFactor * tire.factor * g.center;

  let frontPsi = bertoPressurePsi(frontLoadLbs, width) * totalFactor;
  let rearPsi = bertoPressurePsi(rearLoadLbs, width) * totalFactor;

  const minPsi = tire.minBar / BAR_PER_PSI;
  frontPsi = Math.max(frontPsi, minPsi);
  rearPsi = Math.max(rearPsi, minPsi);

  const spread = g.spread;
  const result = {
    front: {
      lowPsi: frontPsi * (1 - spread),
      midPsi: frontPsi,
      highPsi: frontPsi * (1 + spread),
    },
    rear: {
      lowPsi: rearPsi * (1 - spread),
      midPsi: rearPsi,
      highPsi: rearPsi * (1 + spread),
    },
  };

  return { ...result, surfaceStats, routeFactorSource: surfaceStats.hasManualSurfaces ? 'surface mix' : 'route preset' };
}

function formatPressure(psi, pressureUnit) {
  if (pressureUnit === 'bar') return `${(psi * BAR_PER_PSI).toFixed(2)} bar`;
  return `${Math.round(psi)} psi`;
}

function formatRange(range, pressureUnit) {
  return `${formatPressure(range.lowPsi, pressureUnit)} - ${formatPressure(range.highPsi, pressureUnit)}`;
}

function formatPercent(value) {
  return `${Math.round(value)}%`;
}


const analysisSteps = [
  { key: 'upload', label: 'Loading GPX' },
  { key: 'parse', label: 'Parsing route' },
  { key: 'elevation', label: 'Analyzing elevation' },
  { key: 'surfaces', label: 'Analyzing surfaces' },
  { key: 'done', label: 'Ready' },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function makeFlow({ progress = 0, current = 'upload', completed = [], title = 'Analyzing route', subtitle = '' } = {}) {
  return { visible: true, progress, current, completed, title, subtitle };
}

function RouteAnalysisProgress({ flow, fileName, fileSize }) {
  if (!flow?.visible) return null;
  const completedSet = new Set(flow.completed || []);
  const progress = Math.max(0, Math.min(100, Math.round(flow.progress || 0)));

  return (
    <div className={`route-progress-card ${progress >= 100 ? 'complete' : ''}`}>
      <div className="route-progress-top">
        <div className="route-progress-title">
          <span className="progress-orb"><Activity size={16} /></span>
          <div>
            <strong>{flow.title || 'Analyzing route'}</strong>
            <p>{flow.subtitle || (fileName ? `${fileName}${fileSize ? ` · ${formatFileSize(fileSize)}` : ''}` : 'Preparing route data')}</p>
          </div>
        </div>
        <div className="progress-number">{progress}%</div>
      </div>

      <div className="hero-progress-track" aria-label={`Route analysis ${progress}% complete`}>
        <div className="hero-progress-fill" style={{ width: `${progress}%` }} />
      </div>

      <div className="analysis-step-grid">
        {analysisSteps.map((step) => {
          const done = completedSet.has(step.key) || progress >= 100;
          const active = flow.current === step.key && !done;
          return (
            <div key={step.key} className={`analysis-step ${done ? 'done' : ''} ${active ? 'active' : ''}`}>
              <span className="analysis-step-icon">{done ? <Check size={14} /> : active ? <span className="pulse-dot" /> : <span className="empty-dot" />}</span>
              <span>{step.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}


async function fetchMapMatchedSurfaces(gpxXml) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 70000);
  try {
    const response = await fetch('/api/analyze-gpx', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gpxXml, profile: 'bike' }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Route surface analysis failed.');
    }
    return data;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Surface analysis took too long. TrailPSI kept the current surface estimate so you can continue.');
    }
    throw err;
  } finally {
    window.clearTimeout(timeout);
  }
}

function App() {
  const [totalWeight, setTotalWeight] = useState('95');
  const [tireWidth, setTireWidth] = useState('45');
  const [setup, setSetup] = useState('tubeless');
  const [routeMode, setRouteMode] = useState('mixed');
  const [goal, setGoal] = useState('balanced');
  const [pressureUnit, setPressureUnit] = useState('bar');
  const [weightUnit, setWeightUnit] = useState('kg');
  const [setupName, setSetupName] = useState('My gravel setup');
  const [savedSetups, setSavedSetups] = useState([]);
  const [gpx, setGpx] = useState(null);
  const [gpxError, setGpxError] = useState('');
  const [surfaces, setSurfaces] = useState(() => surfacesForRouteMode('mixed'));
  const [lockedSurfaces, setLockedSurfaces] = useState({});
  const [activeSurfaceKey, setActiveSurfaceKey] = useState(null);
  const [surfaceSource, setSurfaceSource] = useState('Preset from route mode');
  const [osmStatus, setOsmStatus] = useState('');
  const [osmProgress, setOsmProgress] = useState(null);
  const [osmAnalysis, setOsmAnalysis] = useState(null);
  const [gpxSignature, setGpxSignature] = useState('');
  const [cachedOsmByGpx, setCachedOsmByGpx] = useState({});
  const [routeFlow, setRouteFlow] = useState(null);
  const [selectedFileMeta, setSelectedFileMeta] = useState(null);
  const [isSurfaceAnalyzing, setIsSurfaceAnalyzing] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('trailpsi-setups') || localStorage.getItem('routepsi-setups');
    if (saved) setSavedSetups(JSON.parse(saved));
  }, []);

  const surfaceStats = useMemo(() => getSurfaceStats(surfaces), [surfaces]);
  const pressure = useMemo(() => calculatePressure({ totalWeight, tireWidth, setup, routeMode, goal, weightUnit, surfaces }), [totalWeight, tireWidth, setup, routeMode, goal, weightUnit, surfaces]);

  function saveSetup() {
    const item = { id: crypto.randomUUID(), name: setupName || 'Unnamed setup', totalWeight, weightUnit, tireWidth, setup, routeMode, goal, pressureUnit, surfaces };
    const next = [item, ...savedSetups].slice(0, 8);
    setSavedSetups(next);
    localStorage.setItem('trailpsi-setups', JSON.stringify(next));
  }

  function loadSetup(item) {
    setSetupName(item.name);
    setTotalWeight(item.totalWeight);
    setTireWidth(item.tireWidth);
    setSetup(item.setup);
    setRouteMode(item.routeMode);
    setGoal(item.goal);
    setPressureUnit(item.pressureUnit || item.unit || 'bar');
    setWeightUnit(item.weightUnit || 'kg');
    setSurfaces(item.surfaces || surfacesForRouteMode(item.routeMode || 'mixed'));
    setLockedSurfaces({});
    setSurfaceSource(item.surfaces ? 'Saved setup' : 'Preset from route mode');
  }

  function deleteSetup(id) {
    const next = savedSetups.filter((item) => item.id !== id);
    setSavedSetups(next);
    localStorage.setItem('trailpsi-setups', JSON.stringify(next));
  }

  function updateSurface(key, value) {
    setSurfaces((current) => redistributeSurfaceMixWithLocks(current, key, value, lockedSurfaces));
    setSurfaceSource('Manually edited');
  }

  function startSurfaceDrag(key) {
    setActiveSurfaceKey(key);
  }

  function finishSurfaceDrag(key) {
    setActiveSurfaceKey(null);
    setLockedSurfaces((current) => ({ ...current, [key]: true }));
  }

  function toggleSurfaceLock(key) {
    setLockedSurfaces((current) => ({ ...current, [key]: !current[key] }));
  }

  function clearSurfaceLocks() {
    setLockedSurfaces({});
  }

  function selectRouteMode(key) {
    setRouteMode(key);
    setSurfaces(surfacesForRouteMode(key));
    setLockedSurfaces({});
    setSurfaceSource('Preset from route mode');
  }

  function applySurfaceSuggestion() {
    const suggested = suggestRouteModeFromSurfaces(surfaces);
    if (suggested) setRouteMode(suggested);
  }

  function resetSurfaces() {
    setSurfaces(surfacesForRouteMode(routeMode));
    setLockedSurfaces({});
    setSurfaceSource('Preset from route mode');
  }

  async function handleGpx(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setGpxError('');
    setOsmStatus('');
    setOsmProgress(null);
    setOsmAnalysis(null);
    setSelectedFileMeta({ name: file.name, size: file.size });
    setRouteFlow(makeFlow({
      progress: 8,
      current: 'upload',
      completed: [],
      title: 'Loading GPX file',
      subtitle: `${file.name} · ${formatFileSize(file.size)}`,
    }));

    try {
      const text = await file.text();
      setRouteFlow(makeFlow({
        progress: 28,
        current: 'parse',
        completed: ['upload'],
        title: 'Reading route data',
        subtitle: 'Extracting coordinates from the GPX file',
      }));
      await sleep(120);

      const signature = `${file.name}:${file.size}:${file.lastModified}`;
      const stats = parseGpx(text);
      setRouteFlow(makeFlow({
        progress: 55,
        current: 'elevation',
        completed: ['upload', 'parse'],
        title: 'Analyzing elevation and route shape',
        subtitle: `${stats.distanceKm.toFixed(1)} km detected`,
      }));
      await sleep(120);

      setGpx({ name: file.name, xml: text, ...stats });
      setGpxSignature(signature);
      setRouteMode(stats.suggestedMode);
      if (cachedOsmByGpx[signature]) {
        const cached = cachedOsmByGpx[signature];
        const nextSurfaces = cleanSurfaceMix(Object.fromEntries(Object.entries(cached.percentages).map(([key, value]) => [key, String(Math.round(value))])));
        setSurfaces(nextSurfaces);
        setLockedSurfaces({});
        setOsmAnalysis(cached);
        setSurfaceSource('Saved route surface analysis for this GPX');
        setRouteFlow(makeFlow({
          progress: 100,
          current: 'done',
          completed: ['upload', 'parse', 'elevation', 'surfaces', 'done'],
          title: 'Route ready',
          subtitle: 'Using saved surface analysis for this GPX',
        }));
      } else {
        setSurfaces(surfacesForRouteMode(stats.suggestedMode));
        setLockedSurfaces({});
        setSurfaceSource('Estimated from GPX route shape');
        setRouteFlow(makeFlow({
          progress: 100,
          current: 'done',
          completed: ['upload', 'parse', 'elevation', 'done'],
          title: 'GPX loaded',
          subtitle: 'Distance and elevation are ready. Run surface analysis when you want the surface mix.',
        }));
      }
    } catch (err) {
      setGpx(null);
      setRouteFlow(null);
      setSelectedFileMeta(null);
      setGpxError(err.message || 'Could not read GPX file.');
    }
  }

  async function handleOsmSurfaceAnalysis() {
    if (!gpx?.xml) {
      setOsmStatus('Upload a GPX file first.');
      return;
    }

    if (gpxSignature && cachedOsmByGpx[gpxSignature]) {
      const cached = cachedOsmByGpx[gpxSignature];
      const nextSurfaces = cleanSurfaceMix(Object.fromEntries(Object.entries(cached.percentages).map(([key, value]) => [key, String(Math.round(value))])));
      setOsmAnalysis(cached);
      setSurfaces(nextSurfaces);
      setLockedSurfaces({});
      setSurfaceSource('Saved map-matched route analysis for this GPX');
      setOsmProgress(100);
      setOsmStatus('Using saved map-matched surface estimate for this GPX.');
      setRouteFlow(makeFlow({
        progress: 100,
        current: 'done',
        completed: ['upload', 'parse', 'elevation', 'surfaces', 'done'],
        title: 'Route analysis complete',
        subtitle: 'Loaded saved surface estimate for this GPX',
      }));
      return;
    }

    setIsSurfaceAnalyzing(true);
    setOsmStatus('Analyzing route surfaces...');
    setOsmProgress(70);
    setOsmAnalysis(null);
    setRouteFlow(makeFlow({
      progress: 72,
      current: 'surfaces',
      completed: ['upload', 'parse', 'elevation'],
      title: 'Analyzing route surfaces',
      subtitle: 'Matching the GPX against openrouteservice surface data',
    }));

    let fakeProgress = 72;
    const progressTimer = window.setInterval(() => {
      fakeProgress = Math.min(94, fakeProgress + Math.max(1, Math.round((94 - fakeProgress) * 0.18)));
      setOsmProgress(fakeProgress);
      setRouteFlow(makeFlow({
        progress: fakeProgress,
        current: 'surfaces',
        completed: ['upload', 'parse', 'elevation'],
        title: 'Analyzing route surfaces',
        subtitle: 'Long routes can take a little longer',
      }));
    }, 850);

    try {
      const analysis = await fetchMapMatchedSurfaces(gpx.xml);
      window.clearInterval(progressTimer);
      const nextSurfaces = cleanSurfaceMix(Object.fromEntries(
        Object.entries(analysis.percentages).map(([key, value]) => [key, String(Math.round(value))])
      ));
      setOsmAnalysis(analysis);
      setSurfaces(nextSurfaces);
      setLockedSurfaces({});
      if (gpxSignature) setCachedOsmByGpx((current) => ({ ...current, [gpxSignature]: analysis }));
      const suggested = suggestRouteModeFromSurfaces(nextSurfaces);
      if (suggested) setRouteMode(suggested);
      setSurfaceSource(analysis.source || 'Map-matched route analysis');
      setOsmProgress(100);
      setRouteFlow(makeFlow({
        progress: 100,
        current: 'done',
        completed: ['upload', 'parse', 'elevation', 'surfaces', 'done'],
        title: 'Route analysis complete',
        subtitle: 'Surface mix updated from route data',
      }));
      const confidenceText = analysis.confidence ? ` Confidence: ${analysis.confidence}.` : '';
      const unknown = Math.round(analysis.percentages?.unknown || 0);
      const unknownText = unknown > 15 ? ` ${unknown}% of the route could not be classified from map data, so review the sliders.` : '';
      const partialText = analysis.partial ? ' Some route sections could not be checked before the timeout, so this is a partial estimate.' : '';
      setOsmStatus(`Route surface analysis complete.${confidenceText}${unknownText}${partialText}`);
    } catch (err) {
      window.clearInterval(progressTimer);
      setOsmProgress(100);
      setRouteFlow(makeFlow({
        progress: 100,
        current: 'done',
        completed: ['upload', 'parse', 'elevation', 'surfaces', 'done'],
        title: 'Route ready',
        subtitle: 'Surface analysis did not finish, so the current surface estimate was kept.',
      }));
      setOsmStatus(err.message || 'Surface analysis did not finish. TrailPSI kept the current surface estimate so you can continue.');
    } finally {
      setIsSurfaceAnalyzing(false);
    }
  }

  return (
    <main>
      <section className="hero">
        <div className="badge"><Bike size={16} /> Route-first tire pressure calculator</div>
        <h1>Route-aware tire pressure.</h1>
        <p className="lead">Upload a GPX file, review the route surface estimate and get practical front and rear tire pressure ranges for your setup.</p>
      </section>

      <section className="app-grid">
        <div className="side-panel">
          <div className="card form-card compact-card">
            <h2><Gauge size={20} /> 2. Bike setup</h2>
            <label>
              Total system weight
              <div className="input-with-toggle">
                <input value={totalWeight} onChange={(e) => setTotalWeight(e.target.value)} inputMode="decimal" />
                <div className="segmented small" aria-label="Weight unit">
                  <button type="button" className={weightUnit === 'kg' ? 'active' : ''} onClick={() => setWeightUnit('kg')}>kg</button>
                  <button type="button" className={weightUnit === 'lb' ? 'active' : ''} onClick={() => setWeightUnit('lb')}>lb</button>
                </div>
              </div>
              <small>Rider + bike + clothing + bottles + bags + all gear.</small>
            </label>

            <label>
              Tire width
              <input value={tireWidth} onChange={(e) => setTireWidth(e.target.value)} inputMode="decimal" />
              <small>Use measured width if you know it. Otherwise use nominal width in mm.</small>
            </label>

            <label>
              Tire setup
              <select value={setup} onChange={(e) => setSetup(e.target.value)}>
                {Object.entries(tireSetups).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
              </select>
            </label>

            <div className="field-block">
              <span className="field-label">Pressure unit</span>
              <div className="segmented" aria-label="Pressure unit">
                <button type="button" className={pressureUnit === 'bar' ? 'active' : ''} onClick={() => setPressureUnit('bar')}>bar</button>
                <button type="button" className={pressureUnit === 'psi' ? 'active' : ''} onClick={() => setPressureUnit('psi')}>psi</button>
              </div>
            </div>
          </div>

          <div className="card result-card">
            <h2>3. Pressure recommendation</h2>
            <div className="ride-feel">
              {Object.entries(goals).map(([key, item]) => (
                <button key={key} type="button" className={goal === key ? 'feel-card active' : 'feel-card'} onClick={() => setGoal(key)}>
                  <span className="feel-title">{goal === key && <Check size={15} />} {item.label}</span>
                  <small>{item.note}</small>
                </button>
              ))}
            </div>

            {pressure ? (
              <>
                <div className="result-grid">
                  <div>
                    <span>Front</span>
                    <strong>{formatPressure(pressure.front.midPsi, pressureUnit)}</strong>
                    <small>{formatRange(pressure.front, pressureUnit)}</small>
                  </div>
                  <div>
                    <span>Rear</span>
                    <strong>{formatPressure(pressure.rear.midPsi, pressureUnit)}</strong>
                    <small>{formatRange(pressure.rear, pressureUnit)}</small>
                  </div>
                </div>
                <p className="note"><Info size={16} /> Start in the middle of the range and adjust by feel after the first ride. The recommendation is based on your setup and the analyzed surface mix.</p>
              </>
            ) : (
              <p>Enter total weight and tire width to calculate a range.</p>
            )}
          </div>

          <div className="card save-card compact-card">
            <h2><Save size={20} /> My setup</h2>
            <label>
              Setup name
              <input value={setupName} onChange={(e) => setSetupName(e.target.value)} />
            </label>
            <button className="primary" onClick={saveSetup}>Save setup in this browser</button>
            <small>No account needed. Saved setups use localStorage.</small>

            <div className="saved-list">
              {savedSetups.length === 0 && <p>No saved setups yet.</p>}
              {savedSetups.map((item) => (
                <div className="saved" key={item.id}>
                  <button onClick={() => loadSetup(item)}>
                    <strong>{item.name}</strong>
                    <span>{item.totalWeight} {item.weightUnit || 'kg'} · {item.tireWidth} mm · {tireSetups[item.setup]?.label}</span>
                  </button>
                  <button className="icon" onClick={() => deleteSetup(item.id)} aria-label="Delete setup"><Trash2 size={16} /></button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="main-panel">
          <div className="card route-card">
            <h2><Upload size={20} /> 1. Upload and analyze your route</h2>
            <p className="helper top-helper">Start with the route. TrailPSI reads your GPX, checks distance, climbing and surfaces, then uses that profile for the pressure recommendation.</p>
            <label className="upload-drop">
              <input type="file" accept=".gpx,application/gpx+xml,application/xml,text/xml" onChange={handleGpx} />
              <span className="upload-icon"><Upload size={22} /></span>
              <span className="upload-title">Drop your GPX route here or click to browse</span>
              <span className="upload-copy">Distance, climbing and surfaces are used for the pressure recommendation.</span>
              {selectedFileMeta && <span className="file-chip"><FileText size={14} /> {selectedFileMeta.name} · {formatFileSize(selectedFileMeta.size)}</span>}
            </label>
            <RouteAnalysisProgress flow={routeFlow} fileName={selectedFileMeta?.name} fileSize={selectedFileMeta?.size} />
            {gpxError && <div className="error">{gpxError}</div>}
            {gpx && (
              <div className="route-box">
                <strong>{gpx.name}</strong>
                <div className="stats">
                  <span>{gpx.distanceKm.toFixed(1)} km</span>
                  <span>{gpx.elevationGainM !== null ? `${Math.round(gpx.elevationGainM)} m gain` : 'No elevation data'}</span>
                  <span>{gpx.elevationLossM !== null ? `${Math.round(gpx.elevationLossM)} m loss` : 'No loss data'}</span>
                  <span>{gpx.climbingPer100Km !== null ? `${Math.round(gpx.climbingPer100Km)} m climbing / 100 km` : 'No climb score'}</span>
                  <span>{gpx.climbingLabel}</span>
                  <span>{gpx.routeShapeLabel}</span>
                </div>
                <p>GPX-based terrain suggestion: <b>{routeModes[gpx.suggestedMode].label}</b></p>
                <div className="analysis-card route-analysis-cta">
                  <div className="route-analysis-visual" aria-hidden="true">
                    <MapPinned size={24} />
                    <span className="route-analysis-ring" />
                  </div>
                  <div className="route-analysis-copy">
                    <span className="eyebrow">Road surface analysis</span>
                    <strong>Analyze the route surface</strong>
                    <p className="muted">Match your GPX against route data to estimate paved, gravel and trail sections. The pressure range updates from this surface mix.</p>
                    <div className="analysis-mini-steps">
                      <span>Match route</span>
                      <span>Estimate surfaces</span>
                      <span>Update pressure</span>
                    </div>
                  </div>
                  <button type="button" className="primary analyze-button" onClick={handleOsmSurfaceAnalysis} disabled={isSurfaceAnalyzing}>
                    <MapPinned size={18} />
                    <span>{isSurfaceAnalyzing ? 'Analyzing route...' : 'Analyze route surfaces'}</span>
                  </button>
                </div>
                {osmStatus && (
                  <div className="analysis-status">
                    <div>{osmStatus}</div>
                  </div>
                )}
                {osmAnalysis && (
                  <div className="osm-summary">
                    <strong>Surface estimate quality: {osmAnalysis.confidence}</strong>
                    <p className="muted">Review the surface mix below, especially on private roads, forest roads and new routes.</p>
                  </div>
                )}
              </div>
            )}

            <h3><Route size={18} /> Terrain preset</h3>
            <p className="helper">No GPX? Choose the closest terrain type. You can also use a preset to override the route estimate.</p>
            <div className="mode-grid">
              {Object.entries(routeModes).map(([key, item]) => (
                <button key={key} className={routeMode === key ? 'selected' : ''} onClick={() => selectRouteMode(key)}>
                  <strong>{item.label}</strong>
                  <span>{item.desc}</span>
                </button>
              ))}
            </div>

            <h3><SlidersHorizontal size={18} /> Surface mix used in calculation</h3>
            <p className="helper">TrailPSI uses this estimate to fine-tune the pressure recommendation. When you adjust a surface, that value is locked and future changes only redistribute the remaining percentage.</p>
            <div className="surface-editor">
              {Object.entries(surfaceTypes).map(([key, item]) => {
                const value = Math.round(surfaceStats.normalized[key] || 0);
                const locked = Boolean(lockedSurfaces[key]);
                const otherLockedTotal = Object.keys(surfaceTypes)
                  .filter((surfaceKey) => surfaceKey !== key && lockedSurfaces[surfaceKey])
                  .reduce((sum, surfaceKey) => sum + Math.round(surfaceStats.normalized[surfaceKey] || 0), 0);
                return (
                  <div key={key} className={`surface-slider-row ${locked ? 'locked' : ''}`}>
                    <div className="surface-slider-head">
                      <div>
                        <strong>{item.label}</strong>
                        <small>{item.hint}</small>
                      </div>
                      <div className="surface-value-lock">
                        <b>{value}%</b>
                        <button
                          type="button"
                          className={locked ? 'lock-button active' : 'lock-button'}
                          onClick={() => toggleSurfaceLock(key)}
                          aria-label={locked ? `Unlock ${item.label}` : `Lock ${item.label}`}
                          title={locked ? 'Unlock this value' : 'Lock this value'}
                        >
                          {locked ? <Lock size={14} /> : <Unlock size={14} />}
                        </button>
                      </div>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="1"
                      value={value}
                      disabled={locked}
                      onPointerDown={() => startSurfaceDrag(key)}
                      onPointerUp={() => finishSurfaceDrag(key)}
                      onPointerCancel={() => finishSurfaceDrag(key)}
                      onMouseUp={() => finishSurfaceDrag(key)}
                      onTouchEnd={() => finishSurfaceDrag(key)}
                      onKeyDown={() => startSurfaceDrag(key)}
                      onBlur={() => { if (activeSurfaceKey === key) finishSurfaceDrag(key); }}
                      onChange={(e) => updateSurface(key, e.target.value)}
                      aria-label={`${item.label} percentage`}
                    />
                  </div>
                );
              })}
              <div className="surface-total">Total: 100% <button type="button" className="text-button" onClick={clearSurfaceLocks}>Clear locks</button></div>
            </div>
            <div className="surface-summary">
              <strong>Surface estimate</strong>
              <div className="surface-bars compact">
                {Object.entries(surfaceStats.normalized).map(([key, value]) => (
                  <div key={key} className="surface-row">
                    <span>{surfaceTypes[key].label}</span>
                    <div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>
                    <b>{formatPercent(value)}</b>
                  </div>
                ))}
              </div>
              <p className="muted">Source: {surfaceSource}. Confidence: {surfaceStats.confidence}.</p>
              <div className="mini-actions">
                <button type="button" onClick={applySurfaceSuggestion}>Suggest preset from surfaces</button>
                <button type="button" onClick={resetSurfaces}>Reset to selected preset</button>
                {gpxSignature && cachedOsmByGpx[gpxSignature] && (
                  <button type="button" onClick={handleOsmSurfaceAnalysis}>Restore OSM estimate for this GPX</button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="disclaimer">
        <strong>Important:</strong> TrailPSI gives practical starting pressures based on route, surface, tire setup and ride feel. Always stay within tire and rim manufacturer limits. Lower pressure improves comfort and grip but increases the risk of rim strikes, burping and pinch flats.
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
