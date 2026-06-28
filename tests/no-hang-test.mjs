import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const api = require('../api/analyze-gpx.js')._test;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeGpx(seed, points = 450) {
  const lat0 = 46 + (seed % 20) * 0.01;
  const lon0 = 14 + (seed % 20) * 0.01;
  let body = '';
  for (let i = 0; i < points; i += 1) {
    const lat = lat0 + i * 0.00018;
    const lon = lon0 + Math.sin(i / 18) * 0.004 + i * 0.00005;
    const ele = 300 + Math.sin(i / 20) * 35 + (i % 80);
    body += `<trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><ele>${ele.toFixed(1)}</ele></trkpt>`;
  }
  return `<?xml version="1.0"?><gpx><trk><trkseg>${body}</trkseg></trk></gpx>`;
}

let fetchCalls = 0;
global.fetch = async (_url, options = {}) => {
  fetchCalls += 1;
  const body = JSON.parse(options.body || '{}');
  const coords = body.coordinates || [];
  const surfaceSummary = [
    { value: 3, distance: Math.max(100, coords.length * 70) },
    { value: 8, distance: Math.max(20, coords.length * 20) },
    { value: 10, distance: Math.max(10, coords.length * 10) },
  ];
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ features: [{ properties: { extras: { surface: { summary: surfaceSummary } } } }] });
    },
  };
};

process.env.TRAILPSI_ORS_CHUNK_TIMEOUT_MS = '200';
process.env.TRAILPSI_ORS_GLOBAL_TIMEOUT_MS = '1500';
process.env.TRAILPSI_ORS_CONCURRENCY = '4';

const start = Date.now();
for (let i = 0; i < 100; i += 1) {
  const points = api.parseGpxPoints(makeGpx(i, 320 + (i % 200)));
  assert(points.length > 300, `synthetic GPX ${i} parse failed`);
  const result = await api.analyzeWithOpenRouteService(points, 'bike', 'test-key');
  assert(result.chunkCount >= 1, `synthetic GPX ${i} no chunks`);
  assert(result.successfulChunks >= 1, `synthetic GPX ${i} no successful chunks`);
  const total = Object.values(result.percentages).reduce((sum, value) => sum + Number(value || 0), 0);
  assert(Math.abs(total - 100) < 0.2, `synthetic GPX ${i} percentages do not sum to 100: ${total}`);
}
const elapsed = Date.now() - start;
assert(elapsed < 10000, `100 GPX synthetic test took too long: ${elapsed} ms`);
assert(fetchCalls >= 100, 'fetch mock was not called enough');

// Test that permanently slow route chunks cannot hang the analysis.
global.fetch = async (_url, options = {}) => new Promise((resolve, reject) => {
  const signal = options.signal;
  if (signal?.aborted) reject(new Error('aborted'));
  signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});
process.env.TRAILPSI_ORS_CHUNK_TIMEOUT_MS = '25';
process.env.TRAILPSI_ORS_GLOBAL_TIMEOUT_MS = '160';
process.env.TRAILPSI_ORS_CONCURRENCY = '3';
const slowStart = Date.now();
const slowPoints = api.parseGpxPoints(makeGpx(999, 900));
const slowResult = await api.analyzeWithOpenRouteService(slowPoints, 'bike', 'test-key');
const slowElapsed = Date.now() - slowStart;
assert(slowElapsed < 1000, `slow ORS test hung for ${slowElapsed} ms`);
assert(slowResult.failedChunks > 0, 'slow ORS test should fail chunks');

console.log(`PASS: no-hang tests. 100 synthetic GPX files, ${fetchCalls} mocked ORS calls, slow backend returned in ${slowElapsed} ms.`);
