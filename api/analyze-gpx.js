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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
  const apiKey = process.env.ORS_API_KEY || process.env.OPENROUTESERVICE_API_KEY;
  if (!apiKey) {
    return sendJson(res, 501, {
      error: 'ORS_API_KEY is missing. Add it to .env.local or your Vercel environment variables.',
    });
  }

  try {
    const body = await readJsonBody(req);
    const gpxXml = body.gpxXml;
    const profile = body.profile || 'bike';
    if (!gpxXml || typeof gpxXml !== 'string') return sendJson(res, 400, { error: 'Missing gpxXml.' });

    const originalPoints = parseGpxPoints(gpxXml);
    if (originalPoints.length < 2) return sendJson(res, 400, { error: 'GPX did not contain enough points.' });

    const analysis = await analyzeWithOpenRouteService(originalPoints, profile, apiKey);
    const unknown = Number(analysis.percentages.unknown) || 0;
    return sendJson(res, 200, {
      source: 'openrouteservice route surface analysis',
      confidence: unknown <= 10 ? 'high' : unknown <= 30 ? 'medium' : 'low',
      percentages: analysis.percentages,
      distanceKm: Math.round(totalDistanceKm(originalPoints) * 10) / 10,
      elevationGainM: calculateFilteredGain(originalPoints),
      sampledPoints: analysis.sampledPoints,
      chunkCount: analysis.chunkCount,
      failedChunks: analysis.failedChunks,
      completedChunks: analysis.completedChunks,
      successfulChunks: analysis.successfulChunks,
      timedOut: analysis.timedOut,
      partial: analysis.partial,
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || 'Route analysis failed.' });
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
};
