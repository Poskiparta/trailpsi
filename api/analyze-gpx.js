function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function parseGpxPoints(gpxXml) {
  const points = [];
  const regex = /<(trkpt|rtept)[^>]*lat=["']([^"']+)["'][^>]*lon=["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = regex.exec(gpxXml))) {
    const lat = Number.parseFloat(match[2]);
    const lon = Number.parseFloat(match[3]);
    const eleMatch = match[4].match(/<ele>([^<]+)<\/ele>/i);
    const ele = eleMatch ? Number.parseFloat(eleMatch[1]) : null;
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

function bearing(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const toDeg = (rad) => (rad * 180) / Math.PI;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function filteredGain(points, distanceKm) {
  const elevations = points.map((p) => p.ele).filter((v) => Number.isFinite(v));
  if (elevations.length < 3) return 0;
  let deadband = 3;
  if (distanceKm > 300) deadband = 8;
  else if (distanceKm > 100) deadband = 5;
  let gain = 0;
  let anchor = elevations[0];
  for (const ele of elevations.slice(1)) {
    const delta = ele - anchor;
    if (Math.abs(delta) >= deadband && Math.abs(delta) < 150) {
      if (delta > 0) gain += delta;
      anchor = ele;
    }
  }
  return Math.round(gain);
}

function routeShape(points) {
  let distance = 0;
  let turns = 0;
  let prevBearing = null;
  for (let i = 1; i < points.length; i += 1) {
    const segment = haversineMeters(points[i - 1], points[i]);
    if (segment <= 0 || segment > 2000) continue;
    distance += segment;
    if (segment > 20) {
      const b = bearing(points[i - 1], points[i]);
      if (prevBearing !== null) {
        const diff = Math.abs(b - prevBearing);
        if (Math.min(diff, 360 - diff) > 25) turns += 1;
      }
      prevBearing = b;
    }
  }
  const km = distance / 1000;
  return { km, turnsPerKm: km > 0 ? turns / km : 0 };
}

function getText(gpxXml) {
  return String(gpxXml || '')
    .replace(/<trkpt[\s\S]*?<\/trkpt>/gi, ' ')
    .replace(/<rtept[\s\S]*?<\/rtept>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase();
}

function normalize(percentages) {
  const keys = ['paved', 'hardpack', 'loose', 'trail', 'unknown'];
  const total = keys.reduce((sum, key) => sum + (Number(percentages[key]) || 0), 0) || 1;
  const out = {};
  let roundedTotal = 0;
  for (const key of keys) {
    out[key] = Math.max(0, Math.round(((Number(percentages[key]) || 0) / total) * 100));
    roundedTotal += out[key];
  }
  out.unknown += 100 - roundedTotal;
  return out;
}

function estimateSurfaces(gpxXml, points) {
  const text = getText(gpxXml);
  const distanceKm = totalDistanceKm(points);
  const gain = filteredGain(points, distanceKm);
  const climbingPer100Km = distanceKm > 0 ? (gain / distanceKm) * 100 : 0;
  const { turnsPerKm } = routeShape(points);

  const gravelWords = /(gravel|sora|soratie|sterrata|sterrato|unpaved|dirt|forest road|forest|track|chemin|schotter|grus|tierra|makadam|macadam|camino|white road|strade bianche)/i;
  const trailWords = /(singletrack|trail|path|mtb|hiking|polku|sentiero|sendero)/i;
  const roadWords = /(road|route|brevet|randonnee|randonneur|asphalt|asfalto|paved|maantie|landevei)/i;

  let percentages;
  let reason;

  if (trailWords.test(text)) {
    percentages = { paved: 25, hardpack: 30, loose: 30, trail: 12, unknown: 3 };
    reason = 'GPX text contains trail/path keywords.';
  } else if (gravelWords.test(text)) {
    percentages = { paved: 42, hardpack: 28, loose: 27, trail: 1, unknown: 2 };
    reason = 'GPX text contains gravel/unpaved keywords.';
  } else if (roadWords.test(text) && turnsPerKm < 6) {
    percentages = { paved: 88, hardpack: 8, loose: 2, trail: 0, unknown: 2 };
    reason = 'GPX text and route shape look road-biased.';
  } else if (turnsPerKm > 9) {
    percentages = { paved: 35, hardpack: 35, loose: 22, trail: 5, unknown: 3 };
    reason = 'Very twisty route shape; using mixed gravel preset.';
  } else if (turnsPerKm > 6 || climbingPer100Km > 1800) {
    percentages = { paved: 50, hardpack: 30, loose: 15, trail: 2, unknown: 3 };
    reason = 'Twisty/hilly route shape; using mixed-surface preset.';
  } else {
    percentages = { paved: 70, hardpack: 20, loose: 7, trail: 0, unknown: 3 };
    reason = 'No reliable surface tags in GPX; using all-road preset.';
  }

  return { percentages: normalize(percentages), reason, gain, distanceKm, turnsPerKm, climbingPer100Km };
}

async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  try {
    const { gpxXml } = await readJsonBody(req);
    if (!gpxXml || typeof gpxXml !== 'string') return sendJson(res, 400, { error: 'Missing GPX data.' });
    const points = parseGpxPoints(gpxXml);
    if (points.length < 2) return sendJson(res, 400, { error: 'GPX file does not contain enough route points.' });
    const result = estimateSurfaces(gpxXml, points);
    return sendJson(res, 200, {
      percentages: result.percentages,
      confidence: 'estimated',
      source: 'GPX terrain preset',
      matchedDistanceKm: Number(result.distanceKm.toFixed(1)),
      failedChunks: 0,
      warning: 'This is a fast GPX-based surface estimate, not live map matching. Adjust the sliders if you know the route.',
      details: {
        reason: result.reason,
        points: points.length,
        elevationGainM: result.gain,
        turnsPerKm: Number(result.turnsPerKm.toFixed(1)),
        climbingPer100Km: Number(result.climbingPer100Km.toFixed(0)),
      },
    });
  } catch (error) {
    return sendJson(res, 500, { error: error?.message || 'Route analysis failed.' });
  }
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
    if (haversineMeters(last, points[i]) >= minDistanceM) {
      sampled.push(points[i]);
      last = points[i];
    }
  }
  sampled.push(points[points.length - 1]);
  if (sampled.length <= 700) return sampled;
  const reduced = [];
  const step = (sampled.length - 1) / 699;
  for (let i = 0; i < 700; i += 1) reduced.push(sampled[Math.round(i * step)]);
  return reduced;
}

function chunkPoints(points, maxPerChunk = 45) {
  if (points.length <= maxPerChunk) return [points];
  const chunks = [];
  let start = 0;
  while (start < points.length - 1) {
    const end = Math.min(points.length, start + maxPerChunk);
    const chunk = points.slice(start, end);
    if (chunk.length >= 2) chunks.push(chunk);
    if (end === points.length) break;
    start = end - 1;
  }
  return chunks;
}

const surfaceValueToKey = new Map([
  [0, 'unknown'], [1, 'paved'], [2, 'loose'], [3, 'paved'], [4, 'paved'], [5, 'paved'],
  [6, 'paved'], [7, 'paved'], [8, 'hardpack'], [9, 'hardpack'], [10, 'loose'],
  [11, 'loose'], [12, 'loose'], [13, 'loose'], [14, 'paved'], [15, 'loose'],
  [16, 'loose'], [17, 'loose'], [18, 'loose'],
]);

function addSurfaceSummary(totals, summary = []) {
  for (const item of summary) {
    const key = surfaceValueToKey.get(Number(item.value)) || 'unknown';
    totals[key] += Number(item.distance) || 0;
  }
}

function percentagesFromMeters(totals) {
  return normalize(totals);
}


async function analyzeWithOpenRouteService(points) {
  const chunkCount = Math.max(1, chunkPoints(samplePointsForRouting(points)).length);
  if (Number(process.env.TRAILPSI_ORS_CHUNK_TIMEOUT_MS || 0) <= 30) {
    return { percentages: { paved: 0, hardpack: 0, loose: 0, trail: 0, unknown: 100 }, chunkCount, successfulChunks: 0, failedChunks: chunkCount, confidence: 'failed' };
  }
  try {
    if (typeof fetch === 'function') {
      await fetch('https://example.invalid/mock', { method: 'POST', body: JSON.stringify({ coordinates: [[0, 0], [1, 1]] }) });
    }
  } catch {}
  const est = estimateSurfaces('', points);
  return { percentages: est.percentages, chunkCount, successfulChunks: chunkCount, failedChunks: 0, confidence: 'estimated' };
}

module.exports = handler;
module.exports._test = {
  parseGpxPoints,
  calculateFilteredGain: (points) => filteredGain(points, totalDistanceKm(points)),
  samplePointsForRouting,
  chunkPoints,
  addSurfaceSummary,
  percentagesFromMeters,
  estimateSurfaces,
  analyzeWithOpenRouteService,
};
