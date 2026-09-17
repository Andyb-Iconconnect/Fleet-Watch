/* ===================================================================
 * Analyse VesselAPI measurement data
 *
 * Usage:
 *   node tools/analyze-vesselapi.js
 *
 * Reads vesselapi-measurements.jsonl and produces:
 *   - Coverage analysis (which vessels report, how often)
 *   - Cost projections (daily/monthly at different poll intervals)
 *   - Recommendations (minimum poll interval for full coverage)
 * =================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, '..', 'vesselapi-measurements.jsonl');

if (!fs.existsSync(logFile)) {
  console.error(`No measurements found at ${logFile}`);
  console.error('Run: FEED_KEY=<key> node tools/measure-vesselapi.js');
  process.exit(1);
}

const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
const data = lines.map(l => JSON.parse(l));

global.window = {};
require(path.join(__dirname, '..', 'fleet.js'));
const FLEET = global.window.FLEET;

const vesselByMmsi = {};
Object.entries(FLEET).forEach(([k, v]) => {
  vesselByMmsi[v.mmsi] = v.name;
});

console.log('\n=== VESSELAPI MEASUREMENT ANALYSIS ===\n');

// ---- Timeline ----
const startTime = new Date(data[0].timestamp);
const endTime = new Date(data[data.length - 1].timestamp);
const durationMinutes = (endTime - startTime) / 1000 / 60;
const durationHours = durationMinutes / 60;

console.log(`Duration: ${durationHours.toFixed(1)} hours (${Math.round(durationMinutes)} polls)`);
console.log(`Total API calls: ${data[data.length - 1].totalCalls}`);
console.log(`Cost so far: $${(data[data.length - 1].totalCalls * 0.01).toFixed(2)} (free tier)\n`);

// ---- Coverage ----
const latestMeasurement = data[data.length - 1];
console.log(`COVERAGE AT END OF TEST:`);
console.log(`Vessels seen: ${latestMeasurement.uniqueVesselsSeen}/61`);

// Which vessels haven't been seen?
const allMmsi = Object.keys(FLEET).map(k => FLEET[k].mmsi).filter(Boolean);
const seenMmsi = new Set();
data.forEach(m => {
  if (m.cursorProgression === 'advancing') {
    m.mmsiInThisPoll?.forEach(mmsi => seenMmsi.add(mmsi));
  }
});

const missing = allMmsi.filter(mmsi => !seenMmsi.has(mmsi));
if (missing.length) {
  console.log(`\n⚠️  NOT SEEN: ${missing.map(m => vesselByMmsi[m] || m).join(', ')}`);
  console.log('These vessels either:');
  console.log('  - Have not reported yet (offline/out of range)');
  console.log('  - Report infrequently (only during movement)');
  console.log('  - May not be in VesselAPI coverage area');
} else {
  console.log('✓ All 61 vessels have reported at least once');
}

// ---- Rate analysis ----
const callsPerHour = data[data.length - 1].totalCalls / durationHours;
const avgPositionsPerCall = (data.reduce((sum, m) => sum + m.positionsInPage, 0) / data.length).toFixed(0);

console.log(`\nPOLLING PATTERN:`);
console.log(`Average calls per hour: ${callsPerHour.toFixed(1)}`);
console.log(`Average positions per call: ${avgPositionsPerCall}`);

// ---- Cost projections ----
console.log(`\nCOST PROJECTIONS (based on ${durationHours.toFixed(1)}h observed rate):`);

const scenarios = [
  { interval: 180, name: '3 minutes (max detail)' },
  { interval: 300, name: '5 minutes' },
  { interval: 600, name: '10 minutes' },
  { interval: 900, name: '15 minutes' },
  { interval: 1800, name: '30 minutes' }
];

scenarios.forEach(s => {
  const callsPerDay = (86400 / s.interval) * callsPerHour / 60;
  const callsPerMonth = callsPerDay * 30;
  const costPerDay = (callsPerDay * 0.01).toFixed(2);
  const costPerMonth = (callsPerMonth * 0.01).toFixed(2);
  const freeMonthly = 150;
  const fits = callsPerMonth <= freeMonthly ? '✓' : '✗';

  console.log(`  ${fits} ${s.name}: ${callsPerDay.toFixed(0)}/day, ${callsPerMonth.toFixed(0)}/month ($${costPerMonth})`);
});

// ---- Recommendations ----
console.log(`\nRECOMMENDATIONS:`);

if (latestMeasurement.uniqueVesselsSeen < 61) {
  console.log(`⚠️  Only ${latestMeasurement.uniqueVesselsSeen} of 61 vessels seen. Keep testing.`);
  const estTimeToSee61 = durationHours * (61 / latestMeasurement.uniqueVesselsSeen);
  console.log(`   Estimated ${estTimeToSee61.toFixed(1)} more hours needed to see all vessels.`);
}

const maxAffordable = Math.floor(150 * 86400 / 30);
const intervalAtMaxAffordable = 86400 / (150 / 30);

console.log(`\n• Free tier (150/month) supports polling every ~${intervalAtMaxAffordable.toFixed(0)} seconds`);
console.log(`• Paid tier (1500/month) supports polling every ~${(intervalAtMaxAffordable / 10).toFixed(0)} seconds`);

const obsCallsPerDay = data[data.length - 1].totalCalls / durationHours * 24;
if (obsCallsPerDay * 30 <= 150) {
  console.log(`✓ Your current test rate (${obsCallsPerDay.toFixed(0)}/day) fits free tier!`);
} else {
  console.log(`✗ Your current test rate (${obsCallsPerDay.toFixed(0)}/day) = ${(obsCallsPerDay * 30).toFixed(0)}/month (over free tier)`);
}

// ---- Data export ----
console.log(`\nFull data: ${logFile}`);
console.log('Each line is one poll cycle with timestamp, call count, vessels seen, cost.\n');
