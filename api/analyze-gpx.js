const ORS_ENDPOINT_BASE = 'https://api.openrouteservice.org/v2/directions';
const MAX_ORS_COORDS_PER_REQUEST = 45;
const MAX_TOTAL_ROUTE_POINTS = 700;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getRuntimeLimits() {
  return {
    chunkTimeoutMs: envNumber('TRAILPSI_ORS_CHUNK_TIMEOUT_MS', 10000),
    globalTimeoutMs: envNumber('TRAILPSI_ORS_GLOBAL_TIMEOUT_MS', 55000),
    maxConcurrency: Math.max(1, Math.min(6, envNumber('TRAILPSI_ORS_CONCURRENCY', 3))),
  };
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function parseGpxPoints(gpxXml) {
  const points = [];
  const trkptRegex = /<trkpt[^>]*lat=["']([^"']+)["'][^>]*lon=["']([^"']+)["'][^>]*>([\s\S]*?)<\/trkpt>/gi;
  let match;
  while ((match = trkptRegex.exec(gpxXml))) {
    const lat = Number.parseFloat(match[1]);
    const lon = Number.parseFloat(match[2]);
    const eleMatch = match[3].match(/<ele>([^<]+)<\/ele>/i);
    const ele = eleMatch ? Number.parseFloat(eleMatch[1]) : undefined;
    if (Number.isFinite(lat) && Number.isFinite(lon)) points.push({ lat, lon, ele });
  }

  if (points.length) return points;

  const rteptRegex = /<rtept[^>]*lat=["']([^"']+)["'][^>]*lon=["']([^"']+)["'][^>]*>([\s\S]*?)<\/rtept>/gi;
  while ((match = rteptRegex.exec(gpxXml))) {
    const lat = Number.parseFloat(match[1]);
    const lon = Number.parseFloat(match[2]);
    const eleMatch = match[3].match(/<ele>([^<]+)<\/ele>/i);
    const ele = eleMatch ? Number.parseFloat(eleMatch[1]) : undefined;
    if (Number.isFinite(lat) && Number.isFinite(lon)) points.push({ lat, lon, ele });
  }

  return points;
}

function haversineMeters(a, b) {
  const earthRadius = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(h));
}

function totalDistanceKm(points) {
  let meters = 0;
  for (let i = 1; i < points.length; i += 1) meters += haversineMeters(points[i - 1], points[i]);
  return meters / 1000;
}

function calculateFilteredGain(points) {
  const elevations = points.map((p) => p.ele).filter((value) => Number.isFinite(value));
  if (elevations.length < 3) return null;

  const distanceKm = totalDistanceKm(points);
  let deadband = 3;
  if (distanceKm > 150) deadband = 8;
  else if (distanceKm > 60) deadband = 5;

  let gain = 0;
  let anchor = elevations[0];
  for (let i = 1; i < elevations.length; i += 1) {
    const current = elevations[i];
    const delta = current - anchor;
    if (Math.abs(delta) >= deadband && Math.abs(delta) < 120) {
      if (delta > 0) gain += delta;
      anchor = current;
    }
  }
  return Math.round(gain);
}

function chooseSampleDistanceMeters(distanceKm) {
  if (distanceKm > 800) return 1800;
  if (distanceKm > 300) return 700;
  if (distanceKm > 150) return 500;
  if (distanceKm > 60) return 300;
  return 180;
}

function samplePointsForRouting(points) {
  if (points.length <= 2) return points;
  const distanceKm = totalDistanceKm(points);
  const minDistanceM = chooseSampleDistanceMeters(distanceKm);
  const sampled = [points[0]];
  let last = points[0];

  for (let i = 1; i < points.length - 1; i += 1) {
    const dist = haversineMeters(last, points[i]);
    if (dist >= minDistanceM) {
      sampled.push(points[i]);
      last = points[i];
    }
  }
  sampled.push(points[points.length - 1]);

  if (sampled.length <= MAX_TOTAL_ROUTE_POINTS) return sampled;
  const step = (sampled.length - 1) / (MAX_TOTAL_ROUTE_POINTS - 1);
  const reduced = [];
  for (let i = 0; i < MAX_TOTAL_ROUTE_POINTS; i += 1) reduced.push(sampled[Math.round(i * step)]);
  return reduced;
}

function chunkPoints(points, maxPerChunk = MAX_ORS_COORDS_PER_REQUEST) {
  if (points.length <= maxPerChunk) return [points];
  const chunks = [];
  let start = 0;
  while (start < points.length - 1) {
    const end = Math.min(points.length, start + maxPerChunk);
    const chunk = points.slice(start, end);
    if (chunk.length >= 2) chunks.push(chunk);
    if (end === points.length) break;
    start = end - 1; // keep one overlapping point so chunks connect
  }
  return chunks;
}

const surfaceValueToKey = new Map([
  [0, 'unknown'], // unknown
  [1, 'paved'], // paved
  [2, 'loose'], // unpaved
  [3, 'paved'], // asphalt
  [4, 'paved'], // concrete
  [5, 'paved'], // cobblestone
  [6, 'paved'], // metal
  [7, 'paved'], // wood
  [8, 'hardpack'], // compacted gravel
  [9, 'hardpack'], // fine gravel
  [10, 'loose'], // gravel
  [11, 'loose'], // dirt
  [12, 'loose'], // ground
  [13, 'loose'], // ice
  [14, 'paved'], // paving stones
  [15, 'loose'], // sand
  [16, 'loose'], // woodchips
  [17, 'loose'], // grass
  [18, 'loose'], // grass paver
]);

function addSurfaceSummary(totals, summary = []) {
  for (const item of summary) {
    const key = surfaceValueToKey.get(Number(item.value)) || 'unknown';
    const distance = Number(item.distance) || 0;
    totals[key] += distance;
  }
}

function percentagesFromMeters(totals) {
  const keys = ['paved', 'hardpack', 'loose', 'trail', 'unknown'];
  const total = keys.reduce((sum, key) => sum + (Number(totals[key]) || 0), 0);
  if (!total) return { paved: 0, hardpack: 0, loose: 0, trail: 0, unknown: 100 };
  const normalized = Object.fromEntries(keys.map((key) => [key, Math.round(((Number(totals[key]) || 0) / total) * 1000) / 10]));
  const roundedTotal = keys.reduce((sum, key) => sum + normalized[key], 0);
  normalized.unknown = Math.round((normalized.unknown + (100 - roundedTotal)) * 10) / 10;
  return normalized;
}

function orsProfile(profile) {
  if (profile === 'road') return 'cycling-road';
  if (profile === 'mountain') return 'cycling-mountain';
  return 'cycling-regular';
}

async function callOpenRouteService(points, profile, apiKey, timeoutMs) {
  const orsMode = orsProfile(profile);
  const url = `${ORS_ENDPOINT_BASE}/${orsMode}/geojson`;
  const coordinates = points.map((p) => [Number(p.lon.toFixed(7)), Number(p.lat.toFixed(7))]);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('openrouteservice request timed out')), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json, application/geo+json',
      },
      body: JSON.stringify({
        coordinates,
        elevation: false,
        instructions: false,
        units: 'm',
        extra_info: ['surface'],
      }),
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: { message: text }, message: text }; }
    if (!response.ok) {
      const message = data?.error?.message || data?.message || `openrouteservice returned ${response.status}`;
      throw new Error(message);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function analyzeWithOpenRouteService(points, profile, apiKey) {
  const sampledPoints = samplePointsForRouting(points);
  const chunks = chunkPoints(sampledPoints);
  const totals = { paved: 0, hardpack: 0, loose: 0, trail: 0, unknown: 0 };
  const failedChunks = [];
  const limits = getRuntimeLimits();
  const deadline = Date.now() + limits.globalTimeoutMs;
  let nextIndex = 0;
  let completedChunks = 0;
  let successfulChunks = 0;

  async function worker() {
    while (nextIndex < chunks.length) {
      const index = nextIndex;
      nextIndex += 1;

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 150) {
        failedChunks.push(index + 1);
        completedChunks += 1;
        continue;
      }

      try {
        const data = await callOpenRouteService(chunks[index], profile, apiKey, Math.min(limits.chunkTimeoutMs, remainingMs));
        const surfaceSummary = data?.features?.[0]?.properties?.extras?.surface?.summary;
        if (!Array.isArray(surfaceSummary) || surfaceSummary.length === 0) {
          failedChunks.push(index + 1);
        } else {
          addSurfaceSummary(totals, surfaceSummary);
          successfulChunks += 1;
        }
      } catch (err) {
        failedChunks.push(index + 1);
      } finally {
        completedChunks += 1;
      }
    }
  }

  const workerCount = Math.min(limits.maxConcurrency, chunks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const percentages = percentagesFromMeters(totals);
  return {
    percentages,
    sampledPoints: sampledPoints.length,
    chunkCount: chunks.length,
    completedChunks,
    successfulChunks,
    failedChunks: failedChunks.length,
    timedOut: failedChunks.length > 0 && Date.now() >= deadline - 150,
    partial: successfulChunks > 0 && failedChunks.length > 0,
  };
}



// OpenStreetMap / Overpass backend analysis. This is the production surface analyzer.
// It queries a narrow corridor around actual GPX sample points. This is much more reliable
// than re-routing the GPX through ORS, and much faster than querying large bounding boxes.
function normalizeOsmValue(value) {
  return String(value || '').toLowerCase().trim().replaceAll(' ', '_');
}

function classifyOsmWay(tags = {}) {
  const surface = normalizeOsmValue(tags.surface);
  const highway = normalizeOsmValue(tags.highway);
  const tracktype = normalizeOsmValue(tags.tracktype);
  const smoothness = normalizeOsmValue(tags.smoothness);

  const paved = new Set(['paved', 'asphalt', 'concrete', 'concrete:lanes', 'concrete:plates', 'paving_stones', 'sett', 'cobblestone', 'unhewn_cobblestone', 'metal', 'wood']);
  const hardpack = new Set(['compacted', 'fine_gravel', 'gravel', 'chipseal', 'crushed_limestone', 'shells']);
  const loose = new Set(['unpaved', 'ground', 'earth', 'dirt', 'mud', 'sand', 'grass', 'grass_paver', 'pebblestone', 'rock', 'salt', 'snow']);

  if (paved.has(surface)) return { key: 'paved', explicit: true, highway, surface, tracktype };
  if (hardpack.has(surface)) return { key: 'hardpack', explicit: true, highway, surface, tracktype };
  if (loose.has(surface)) return { key: highway === 'path' ? 'trail' : 'loose', explicit: true, highway, surface, tracktype };

  if (tracktype === 'grade1') return { key: 'hardpack', explicit: true, highway, surface, tracktype };
  if (tracktype === 'grade2') return { key: 'hardpack', explicit: true, highway, surface, tracktype };
  if (['grade3', 'grade4', 'grade5'].includes(tracktype)) return { key: 'loose', explicit: true, highway, surface, tracktype };
  if (['bad', 'very_bad', 'horrible', 'very_horrible', 'impassable'].includes(smoothness)) {
    return { key: highway === 'path' ? 'trail' : 'loose', explicit: true, highway, surface, tracktype };
  }

  // Untagged OSM highways still carry useful information. In many European areas,
  // highway=track is far more informative than missing surface=*.
  const normallyPaved = new Set([
    'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
    'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential',
    'living_street', 'service', 'road', 'pedestrian', 'cycleway',
  ]);
  if (normallyPaved.has(highway)) return { key: 'paved', explicit: false, highway, surface, tracktype };
  // highway=unclassified is not always paved on remote gravel/bikepacking routes,
  // so keep it as hardpack unless surface explicitly says paved.
  if (highway === 'unclassified') return { key: 'hardpack', explicit: false, highway, surface, tracktype };
  if (highway === 'track') return { key: 'hardpack', explicit: false, highway, surface, tracktype };
  if (['path', 'bridleway'].includes(highway)) return { key: 'trail', explicit: false, highway, surface, tracktype };
  if (['footway', 'steps'].includes(highway)) return { key: 'trail', explicit: false, highway, surface, tracktype };
  return { key: 'unknown', explicit: false, highway, surface, tracktype };
}

function metersProject(point, origin) {
  const latMeters = 111320;
  const lonMeters = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  return { x: (point.lon - origin.lon) * lonMeters, y: (point.lat - origin.lat) * latMeters };
}

function pointToSegmentMeters(point, start, end) {
  const p = metersProject(point, point);
  const a = metersProject(start, point);
  const b = metersProject(end, point);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denom = dx * dx + dy * dy;
  if (!denom) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / denom));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function waySegmentsFromElements(elements = []) {
  const segments = [];
  for (const way of elements) {
    if (way.type !== 'way' || !Array.isArray(way.geometry) || way.geometry.length < 2) continue;
    if (!way.tags?.highway) continue;
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
  }
  return segments;
}

function chooseClassForPoint(point, segments, radiusM = 85) {
  const nearby = [];
  const latPad = radiusM / 111320;
  const lonPad = radiusM / (111320 * Math.max(0.2, Math.cos((point.lat * Math.PI) / 180)));

  for (const segment of segments) {
    if (point.lat < segment.minLat - latPad || point.lat > segment.maxLat + latPad) continue;
    if (point.lon < segment.minLon - lonPad || point.lon > segment.maxLon + lonPad) continue;
    const distance = pointToSegmentMeters(point, segment.start, segment.end);
    if (distance <= radiusM) nearby.push({ distance, classification: segment.classification });
  }

  if (!nearby.length) return { key: 'unknown', matched: false, explicit: false };
  nearby.sort((a, b) => a.distance - b.distance);

  const nearest = nearby[0];
  const explicitPaved = nearby.find((item) => item.classification.explicit && item.classification.key === 'paved' && item.distance <= 70);
  const explicitUnpaved = nearby.find((item) => item.classification.explicit && item.classification.key !== 'paved' && item.classification.key !== 'unknown' && item.distance <= 75);
  const implicitTrackOrPath = nearby.find((item) => !item.classification.explicit && ['hardpack', 'loose', 'trail'].includes(item.classification.key) && item.distance <= 70);
  const implicitPaved = nearby.find((item) => !item.classification.explicit && item.classification.key === 'paved' && item.distance <= 70);

  // Explicit OSM surface tags beat generic highway guesses, unless they are clearly farther away.
  if (explicitUnpaved && (!explicitPaved || explicitUnpaved.distance <= explicitPaved.distance + 20)) {
    if (!implicitPaved || explicitUnpaved.distance <= implicitPaved.distance + 28) return { ...explicitUnpaved.classification, matched: true };
  }
  if (explicitPaved && (!explicitUnpaved || explicitPaved.distance <= explicitUnpaved.distance + 12)) return { ...explicitPaved.classification, matched: true };

  // When the GPX is visibly closer to a track/path than a road, trust the track/path.
  if (implicitTrackOrPath && (!implicitPaved || implicitTrackOrPath.distance + 16 < implicitPaved.distance)) return { ...implicitTrackOrPath.classification, matched: true };
  if (implicitPaved) return { ...implicitPaved.classification, matched: true };
  if (nearest.classification.key !== 'unknown') return { ...nearest.classification, matched: true };
  return { key: 'unknown', matched: false, explicit: false };
}

function samplePointsByDistance(points, targetSpacingM = 1000, maxSamples = 420) {
  if (points.length <= 2) return points.map((point) => ({ ...point, weightM: 1 }));
  const distanceKm = totalDistanceKm(points);
  let spacing = targetSpacingM;
  if (distanceKm > 800) spacing = 2200;
  else if (distanceKm > 450) spacing = 1600;
  else if (distanceKm > 220) spacing = 1000;
  else if (distanceKm > 80) spacing = 650;
  else spacing = 350;

  const samples = [{ ...points[0], weightM: spacing }];
  let lastSample = points[0];
  let sinceLast = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    sinceLast += haversineMeters(points[i - 1], points[i]);
    if (sinceLast >= spacing) {
      samples.push({ ...points[i], weightM: sinceLast });
      lastSample = points[i];
      sinceLast = 0;
    }
  }
  const tailDistance = haversineMeters(lastSample, points[points.length - 1]);
  samples.push({ ...points[points.length - 1], weightM: Math.max(1, sinceLast + tailDistance) });

  if (samples.length <= maxSamples) return samples;
  const step = (samples.length - 1) / (maxSamples - 1);
  return Array.from({ length: maxSamples }, (_, index) => samples[Math.round(index * step)]);
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function makeOverpassAroundQuery(points, radiusM = 90) {
  const aroundQueries = points.map((point) => `way(around:${radiusM},${point.lat.toFixed(6)},${point.lon.toFixed(6)})["highway"];`).join('\n');
  return `[out:json][timeout:18];(\n${aroundQueries}\n);out tags geom qt;`;
}

async function fetchOverpassAround(points, timeoutMs = 18000) {
  const endpoints = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
    'https://overpass.openstreetmap.ru/api/interpreter',
  ];
  const query = makeOverpassAroundQuery(points);
  let lastError;
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('OpenStreetMap request timed out')), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({ data: query }).toString(),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`OpenStreetMap request failed (${response.status})`);
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('OpenStreetMap analysis failed.');
}

function osmPercentagesFromWeightedCounts(counts) {
  const keys = ['paved', 'hardpack', 'loose', 'trail', 'unknown'];
  const total = keys.reduce((sum, key) => sum + (Number(counts[key]) || 0), 0);
  if (!total) return { paved: 0, hardpack: 0, loose: 0, trail: 0, unknown: 100 };
  const percentages = Object.fromEntries(keys.map((key) => [key, Math.round(((Number(counts[key]) || 0) / total) * 1000) / 10]));
  const sum = keys.reduce((acc, key) => acc + percentages[key], 0);
  percentages.unknown = Math.round((percentages.unknown + (100 - sum)) * 10) / 10;
  return percentages;
}

async function analyzeWithOpenStreetMap(points) {
  const samples = samplePointsByDistance(points);
  const chunks = chunkArray(samples, 18);
  const counts = { paved: 0, hardpack: 0, loose: 0, trail: 0, unknown: 0 };
  const limits = {
    maxConcurrency: Math.max(1, Math.min(4, envNumber('TRAILPSI_OVERPASS_CONCURRENCY', 3))),
    chunkTimeoutMs: envNumber('TRAILPSI_OVERPASS_CHUNK_TIMEOUT_MS', 18000),
    globalTimeoutMs: envNumber('TRAILPSI_OVERPASS_GLOBAL_TIMEOUT_MS', 52000),
  };
  const deadline = Date.now() + limits.globalTimeoutMs;
  let nextIndex = 0;
  let successfulChunks = 0;
  let failedChunks = 0;
  let matchedWeight = 0;
  let explicitWeight = 0;
  let checkedWeight = 0;
  let completedChunks = 0;

  async function analyzeChunk(index) {
    const chunk = chunks[index];
    const remainingMs = deadline - Date.now();
    if (remainingMs < 2500) throw new Error('OpenStreetMap analysis deadline reached');
    const data = await fetchOverpassAround(chunk, Math.min(limits.chunkTimeoutMs, remainingMs - 500));
    const segments = waySegmentsFromElements(data.elements || []);
    if (!segments.length) throw new Error('No nearby OSM ways returned');
    for (const point of chunk) {
      const weight = Math.max(1, Number(point.weightM) || 1);
      const chosen = chooseClassForPoint(point, segments, 95);
      counts[chosen.key || 'unknown'] += weight;
      checkedWeight += weight;
      if (chosen.matched) matchedWeight += weight;
      if (chosen.explicit) explicitWeight += weight;
    }
  }

  async function worker() {
    while (nextIndex < chunks.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        await analyzeChunk(index);
        successfulChunks += 1;
      } catch (_err) {
        failedChunks += 1;
        for (const point of chunks[index]) counts.unknown += Math.max(1, Number(point.weightM) || 1);
      } finally {
        completedChunks += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limits.maxConcurrency, chunks.length) }, () => worker()));

  const percentages = osmPercentagesFromWeightedCounts(counts);
  const matchedPercent = checkedWeight ? Math.round((matchedWeight / checkedWeight) * 1000) / 10 : 0;
  const explicitPercent = matchedWeight ? Math.round((explicitWeight / matchedWeight) * 1000) / 10 : 0;
  let confidence = 'low';
  if (successfulChunks > 0 && matchedPercent >= 70 && (percentages.unknown || 0) <= 20 && failedChunks <= Math.ceil(chunks.length * 0.15)) confidence = 'good';
  else if (successfulChunks > 0 && matchedPercent >= 45 && (percentages.unknown || 0) <= 45) confidence = 'medium';

  return {
    percentages,
    sampledPoints: samples.length,
    chunkCount: chunks.length,
    completedChunks,
    successfulChunks,
    failedChunks,
    confidence,
    matchedPercent,
    explicitPercent,
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });

  try {
    const body = await readJsonBody(req);
    const gpxXml = body.gpxXml;
    if (!gpxXml || typeof gpxXml !== 'string') return sendJson(res, 400, { error: 'Missing gpxXml.' });

    const originalPoints = parseGpxPoints(gpxXml);
    if (originalPoints.length < 2) return sendJson(res, 400, { error: 'GPX did not contain enough points.' });

    const analysis = await analyzeWithOpenStreetMap(originalPoints);
    return sendJson(res, 200, {
      source: 'openstreetmap overpass surface analysis',
      confidence: analysis.confidence,
      percentages: analysis.percentages,
      distanceKm: Math.round(totalDistanceKm(originalPoints) * 10) / 10,
      elevationGainM: calculateFilteredGain(originalPoints),
      sampledPoints: analysis.sampledPoints,
      chunkCount: analysis.chunkCount,
      failedChunks: analysis.failedChunks,
      completedChunks: analysis.completedChunks,
      successfulChunks: analysis.successfulChunks,
      timedOut: false,
      partial: analysis.successfulChunks > 0 && analysis.failedChunks > 0,
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || 'OpenStreetMap route analysis failed.' });
  }
};

module.exports._test = {
  parseGpxPoints,
  samplePointsForRouting,
  chunkPoints,
  calculateFilteredGain,
  addSurfaceSummary,
  percentagesFromMeters,
  surfaceValueToKey,
  analyzeWithOpenRouteService,
  callOpenRouteService,
  getRuntimeLimits,
  analyzeWithOpenStreetMap,
  classifyOsmWay,
  chooseClassForPoint,
};

// Ask Vercel for enough time to complete multi-section OSM analysis.
module.exports.config = { maxDuration: 60 };
