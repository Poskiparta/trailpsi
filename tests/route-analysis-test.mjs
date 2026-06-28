import fs from 'node:fs';

const gpxPath = process.argv[2] || '/mnt/data/HERO_2026.gpx';
const xml = fs.readFileSync(gpxPath, 'utf8');
const points = [...xml.matchAll(/<trkpt[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*>[\s\S]*?<ele>([^<]+)<\/ele>[\s\S]*?<\/trkpt>/g)].map((m) => ({
  lat: Number(m[1]),
  lon: Number(m[2]),
  ele: Number(m[3]),
}));

function haversineMeters(a, b) {
  const R = 6371000;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function calculateFilteredElevation(points, distanceKm) {
  const elevations = points.map((point) => point.ele).filter((value) => Number.isFinite(value));
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

const distanceKm = points.slice(1).reduce((sum, point, index) => sum + haversineMeters(points[index], point), 0) / 1000;
const elevation = calculateFilteredElevation(points, distanceKm);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(points.length > 1000, 'GPX parsing failed.');
if (gpxPath.includes('HERO')) {
  assert(distanceKm > 1000 && distanceKm < 1040, `Unexpected HERO distance: ${distanceKm}`);
  assert(elevation.gain > 9300 && elevation.gain < 10100, `Filtered HERO elevation gain should be around 9600-9800 m, got ${elevation.gain}`);
}
if (gpxPath.includes('Slovenia')) {
  assert(distanceKm > 330 && distanceKm < 355, `Unexpected Slovenia distance: ${distanceKm}`);
  assert(elevation.gain > 5200 && elevation.gain < 6100, `Filtered Slovenia elevation gain should be plausible, got ${elevation.gain}`);
}

function normalizeOsmValue(value) {
  return String(value || '').toLowerCase().trim().replaceAll(' ', '_');
}
function classifyOsmWay(tags = {}) {
  const surface = normalizeOsmValue(tags.surface);
  const highway = normalizeOsmValue(tags.highway);
  if (['paved', 'asphalt', 'concrete'].includes(surface)) return { key: 'paved', explicit: true };
  if (['gravel', 'fine_gravel', 'compacted'].includes(surface)) return { key: 'hardpack', explicit: true };
  if (['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'service', 'cycleway', 'road'].includes(highway)) return { key: 'paved', explicit: false };
  if (highway === 'track') return { key: 'hardpack', explicit: false };
  if (['path', 'footway'].includes(highway)) return { key: 'trail', explicit: false };
  return { key: 'unknown', explicit: false };
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
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function chooseClassForPoint(point, segments) {
  const nearby = segments.map((segment) => ({
    distance: pointToSegmentMeters(point, segment.start, segment.end),
    classification: segment.classification,
  })).filter((item) => item.distance <= 45).sort((a, b) => a.distance - b.distance);
  if (nearby.length === 0) return { key: 'unknown', explicit: false, matched: false };
  const nearest = nearby[0];
  const paved = nearby.find((item) => item.classification.key === 'paved' && item.distance <= 42);
  const explicitPaved = nearby.find((item) => item.classification.key === 'paved' && item.classification.explicit && item.distance <= 30);
  const explicitUnpaved = nearby.find((item) => item.classification.explicit && item.classification.key !== 'paved' && item.distance <= 30);
  const implicitUnpaved = nearby.find((item) => !item.classification.explicit && item.classification.key !== 'paved' && item.classification.key !== 'unknown' && item.distance <= 35);
  if (explicitUnpaved) {
    if (!explicitPaved || explicitUnpaved.distance + 8 < explicitPaved.distance) {
      if (!paved || explicitUnpaved.distance + 12 < paved.distance) {
        return { ...explicitUnpaved.classification, matched: true };
      }
    }
  }
  if (explicitPaved && (!explicitUnpaved || explicitPaved.distance <= explicitUnpaved.distance + 8)) return { ...explicitPaved.classification, matched: true };
  if (implicitUnpaved) {
    if (!paved) return { ...implicitUnpaved.classification, matched: true };
    if (implicitUnpaved.distance + 14 < paved.distance) return { ...implicitUnpaved.classification, matched: true };
  }
  if (nearest.classification.key !== 'paved' && nearest.classification.key !== 'unknown') {
    if (!paved || nearest.distance + 10 < paved.distance) return { ...nearest.classification, matched: true };
  }
  if (paved) return { ...paved.classification, matched: true };
  if (nearest.distance <= 28) return { ...nearest.classification, matched: true };
  return { key: 'unknown', explicit: false, matched: false };
}

const routePoint = { lat: 60.0, lon: 25.0 };
const pavedRoad = { start: { lat: 59.9999, lon: 25.0 }, end: { lat: 60.0001, lon: 25.0 }, classification: classifyOsmWay({ highway: 'secondary' }) };
const sideGravel = { start: { lat: 59.9999, lon: 25.00008 }, end: { lat: 60.0001, lon: 25.00008 }, classification: classifyOsmWay({ highway: 'track', surface: 'gravel' }) };
const chosen = chooseClassForPoint(routePoint, [sideGravel, pavedRoad]);
assert(chosen.key === 'paved', `Road bias failed: expected paved, got ${chosen.key}`);

console.log(`PASS: ${gpxPath.split('/').pop()} distance ${distanceKm.toFixed(1)} km, filtered gain ${Math.round(elevation.gain)} m, road-bias synthetic OSM test -> ${chosen.key}`);

function offsetSegment(lonOffset, classification) {
  return {
    start: { lat: 59.9999, lon: 25.0 + lonOffset },
    end: { lat: 60.0001, lon: 25.0 + lonOffset },
    classification,
  };
}

const closeImplicitTrack = offsetSegment(0.00002, classifyOsmWay({ highway: 'track' }));
const fartherPavedRoad = offsetSegment(0.00042, classifyOsmWay({ highway: 'secondary' }));
const chosenTrack = chooseClassForPoint(routePoint, [closeImplicitTrack, fartherPavedRoad]);
assert(chosenTrack.key === 'hardpack', `Closest implicit track should win when clearly closer than road, got ${chosenTrack.key}`);

const closePavedRoad = offsetSegment(0.00002, classifyOsmWay({ highway: 'secondary' }));
const sideTrack = offsetSegment(0.00012, classifyOsmWay({ highway: 'track' }));
const chosenPaved = chooseClassForPoint(routePoint, [sideTrack, closePavedRoad]);
assert(chosenPaved.key === 'paved', `Road route with nearby track should stay paved, got ${chosenPaved.key}`);

const explicitGravel = offsetSegment(0.00003, classifyOsmWay({ highway: 'track', surface: 'gravel' }));
const explicitChosen = chooseClassForPoint(routePoint, [explicitGravel, fartherPavedRoad]);
assert(explicitChosen.key === 'hardpack', `Explicit gravel should win when near route, got ${explicitChosen.key}`);

console.log('PASS: balanced surface matching synthetic tests');
