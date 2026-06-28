import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const api = require('../api/analyze-gpx.js')._test;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const heroXml = fs.readFileSync('/mnt/data/HERO_2026.gpx', 'utf8');
const heroPoints = api.parseGpxPoints(heroXml);
assert(heroPoints.length > 1000, 'HERO GPX parse failed');
const heroGain = api.calculateFilteredGain(heroPoints);
assert(heroGain > 9300 && heroGain < 10300, `HERO gain outside expected range: ${heroGain}`);

const sloveniaXml = fs.readFileSync('/mnt/data/7S26_1 - Slovenia.gpx', 'utf8');
const sloveniaPoints = api.parseGpxPoints(sloveniaXml);
assert(sloveniaPoints.length > 1000, 'Slovenia GPX parse failed');
const sloveniaGain = api.calculateFilteredGain(sloveniaPoints);
assert(sloveniaGain > 5100 && sloveniaGain < 6200, `Slovenia gain outside expected range: ${sloveniaGain}`);

const sampled = api.samplePointsForRouting(sloveniaPoints);
assert(sampled.length <= 700, `Sampled points exceed ORS cap: ${sampled.length}`);
assert(sampled.length > 100, `Sampled too few points: ${sampled.length}`);

const chunks = api.chunkPoints(sampled);
assert(chunks.every((chunk) => chunk.length <= 45), 'Chunk exceeds ORS coordinate limit');
assert(chunks.every((chunk) => chunk.length >= 2), 'Chunk too short');

const totals = { paved: 0, hardpack: 0, loose: 0, trail: 0, unknown: 0 };
api.addSurfaceSummary(totals, [
  { value: 3, distance: 6000 },  // asphalt
  { value: 8, distance: 2500 },  // compacted gravel
  { value: 10, distance: 1500 }, // gravel
]);
const pct = api.percentagesFromMeters(totals);
assert(pct.paved === 60, `Expected 60% paved, got ${pct.paved}`);
assert(pct.hardpack === 25, `Expected 25% hardpack, got ${pct.hardpack}`);
assert(pct.loose === 15, `Expected 15% loose, got ${pct.loose}`);
assert(Math.round((pct.paved + pct.hardpack + pct.loose + pct.trail + pct.unknown) * 10) / 10 === 100, 'Percentages do not sum to 100');

console.log(`PASS: ORS backend tests. HERO gain ${heroGain} m, Slovenia gain ${sloveniaGain} m, sampled Slovenia ${sampled.length} points in ${chunks.length} chunks.`);
