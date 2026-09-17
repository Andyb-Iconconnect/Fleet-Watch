/* ===================================================================
 * Measure VesselAPI cost model by collecting real data
 *
 * Usage:
 *   FEED_KEY=<key> node tools/measure-vesselapi.js
 *
 * Logs:
 *   - How many unique vessels appear per poll
 *   - Whether you're catching all 61 or missing some
 *   - Cursor progression (is it stuck?)
 *   - Real cost per poll cycle
 *
 * Run for 24-48 hours to understand your fleet's reporting patterns
 * =================================================================== */

'use strict';

const path = require('path');
const fs = require('fs');

global.window = {};
require(path.join(__dirname, '..', 'fleet.js'));
const FLEET = global.window.FLEET;

const API_KEY = process.env.FEED_KEY;
if (!API_KEY) {
  console.error('Error: FEED_KEY environment variable not set');
  process.exit(1);
}

const MMSI_LIST = Object.keys(FLEET).map(k => FLEET[k].mmsi).filter(Boolean);
console.log(`Tracking ${MMSI_LIST.length} vessels`);
console.log(`Fleet MMSIs: ${MMSI_LIST.join(', ')}`);
console.log('');

// Log file for data collection
const logFile = path.join(__dirname, '..', 'vesselapi-measurements.jsonl');
if (fs.existsSync(logFile)) {
  fs.unlinkSync(logFile);
}

async function poll(token) {
  const endpoint = 'https://api.vesselapi.com/v1/vessels/positions';
  const params = [
    'filter.idType=mmsi',
    'filter.ids=' + encodeURIComponent(MMSI_LIST.join(','))
  ];
  if (token) {
    params.push('nextToken=' + encodeURIComponent(token));
  }
  const url = endpoint + '?' + params.join('&');

  const res = await fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + API_KEY,
      'Accept': 'application/json'
    }
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }

  const body = await res.json();

  // Find the position array (schema-agnostic like the relay)
  const lists = [];
  (function walk(node, depth) {
    if (depth > 6 || node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const objects = node.filter(r => r && typeof r === 'object' && !Array.isArray(r));
      if (objects.length === node.length && objects.length) lists.push(node);
      return;
    }
    Object.keys(node).forEach(k => walk(node[k], depth + 1));
  })(body, 0);
  lists.sort((a, b) => b.length - a.length);

  const positions = lists[0] || [];
  const nextToken = body.nextToken || body.next_token || body.nextPageToken || null;

  return { positions, nextToken };
}

async function run() {
  let token = null;
  let pollNumber = 0;
  let totalCalls = 0;
  const vesselsSeen = new Set();
  const vesselReports = {};

  MMSI_LIST.forEach(mmsi => { vesselReports[mmsi] = 0; });

  console.log('Starting measurements... (Ctrl+C to stop)');
  console.log('Each poll = 1 API call\n');

  const startTime = Date.now();

  while (true) {
    pollNumber++;
    totalCalls++;

    const pollStart = Date.now();
    let positions = [];
    let nextToken = null;
    let error = null;

    try {
      const page = await poll(token);
      positions = page.positions;
      nextToken = page.nextToken;
    } catch (e) {
      error = e.message;
      console.error(`Poll #${pollNumber}: ERROR - ${error}`);
    }

    const pollMs = Date.now() - pollStart;

    // Analyse the page
    const mmsiInPage = new Set();
    const newest = positions.length ? new Date(positions[0].timestamp) : null;
    let ourCount = 0;

    positions.forEach(p => {
      const mmsi = String(p.mmsi);
      if (MMSI_LIST.includes(mmsi)) {
        ourCount++;
        mmsiInPage.add(mmsi);
        vesselReports[mmsi]++;
        vesselsSeen.add(mmsi);
      }
    });

    // Log the measurement
    const measurement = {
      pollNumber,
      timestamp: new Date().toISOString(),
      totalCalls,
      costSoFar: totalCalls * 0.01,
      positionsInPage: positions.length,
      ourVessels: ourCount,
      uniqueVesselsSeen: vesselsSeen.size,
      newestReport: newest ? newest.toISOString() : null,
      cursorProgression: nextToken ? 'advancing' : 'exhausted',
      pollMs
    };

    // Display
    const cursor = nextToken ? '→' : '●';
    const missing = MMSI_LIST.length - vesselsSeen.size;
    const status = missing ? `🔴 ${missing} missing` : '🟢 all 61 seen';

    console.log(
      `Poll #${pollNumber} ${cursor} ${ourCount}/${positions.length} ours | ` +
      `${vesselsSeen.size}/61 total | ${status} | $${totalCalls * 0.01.toFixed(2)} | ${pollMs}ms`
    );

    // Write to log
    fs.appendFileSync(logFile, JSON.stringify(measurement) + '\n');

    // Update cursor for next poll
    token = nextToken;

    // If cursor is exhausted, we've caught up
    if (!token) {
      console.log(`\n✓ Poll #${pollNumber}: caught up to latest`);
      token = null; // Reset to backfill from latest on next poll

      const uptime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      const costPerHour = (totalCalls / (uptime / 60)).toFixed(1);
      console.log(`\nAfter ${uptime} min: ${totalCalls} calls, ~${costPerHour} calls/hour, $${costPerHour * 0.01}/hour`);
      console.log(`Missing: ${Array.from(Object.entries(vesselReports))
        .filter(([_, count]) => count === 0)
        .map(([mmsi]) => FLEET[Object.keys(FLEET).find(k => FLEET[k].mmsi === mmsi)]?.name || mmsi)
        .join(', ') || 'none'}\n`);
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

process.on('SIGINT', () => {
  console.log('\n\n=== FINAL SUMMARY ===');
  console.log(`Data saved to: ${logFile}`);
  console.log('Analyze with: node tools/analyze-vesselapi.js');
  process.exit(0);
});

run().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
