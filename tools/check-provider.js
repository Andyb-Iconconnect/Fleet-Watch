/* -----------------------------------------------------------------------------
 * check-provider.js — does this feed actually carry our fleet?
 *
 *   node tools/check-provider.js response.json
 *
 * Point a provider at the fleet, save whatever comes back, and run this. It
 * answers the only question that has ever mattered when choosing between them:
 * HOW MANY OF OUR SIXTY-ONE ARE IN HERE, AND WHICH ARE NOT.
 *
 * Two providers were built against before this existed. AISstream took a
 * fortnight of real running to reveal it carried thirty-five; MarineTraffic
 * turned out to have no tier that reaches sixty vessels at all. Both were
 * decided on coverage, and in both cases the coverage was the last thing
 * anyone measured rather than the first.
 *
 * DELIBERATELY IGNORANT OF SHAPE. It does not know VesselAPI's field names, or
 * anyone's: it hunts for a list of records, finds whatever in each looks like
 * an MMSI, and matches those against fleet.js. That is what lets it be run
 * against a provider nobody has integrated yet — which is the whole point,
 * because integrating first is the mistake it exists to prevent.
 *
 * It also prints one record whole, because the fastest way to learn a
 * provider's field names and units is to look at one.
 * -------------------------------------------------------------------------- */

'use strict';

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/check-provider.js <response.json>');
  process.exit(2);
}

global.window = {};
require(path.join(__dirname, '..', 'fleet.js'));
const FLEET = global.window.FLEET;

let body;
try {
  body = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error('That file is not JSON: ' + e.message);
  console.error('If the provider refused the request it may have sent HTML or ' +
                'a plain-text error. Open it and look.');
  process.exit(1);
}

/**
 * Find the records, wherever they are.
 *
 * Some providers answer with a bare array, some wrap it — {vessels: [...]},
 * {data: [...]}, {results: [...]}. Rather than guess, take the longest array of
 * objects anywhere in the response: on a fleet query that is the fleet.
 */
function findRecords(node, depth) {
  if (depth > 6 || node == null || typeof node !== 'object') return [];
  if (Array.isArray(node)) {
    const objects = node.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
    return objects.length === node.length && objects.length ? [node] : [];
  }
  return Object.keys(node).reduce(
    (found, k) => found.concat(findRecords(node[k], depth + 1)), []);
}

const lists = findRecords(body, 0).sort((a, b) => b.length - a.length);
const rows = lists[0] || [];

/**
 * What in this record is the MMSI?
 *
 * A nine-digit number whose first three are a ship-station MID (201-775). Tried
 * by key name first, then by value, so a provider that calls it `vesselId` or
 * nests it is still matched. Anything else — an IMO, a database id, a port
 * code — fails the shape or the range.
 */
function mmsiOf(row) {
  const looksRight = (v) => /^[2-7]\d{8}$/.test(String(v));
  const named = ['mmsi', 'MMSI', 'Mmsi', 'mmsi_number', 'mmsiNumber'];
  for (const k of named) {
    if (row[k] != null && looksRight(row[k])) return String(row[k]);
  }
  for (const k of Object.keys(row)) {
    if (looksRight(row[k])) return String(row[k]);
  }
  return null;
}

const ours = new Map(FLEET.map((y) => [String(y.mmsi), y]));
const seen = new Set();
let unidentified = 0;

rows.forEach((row) => {
  const m = mmsiOf(row);
  if (!m) { unidentified++; return; }
  if (ours.has(m)) seen.add(m);
});

const missing = FLEET.filter((y) => !seen.has(String(y.mmsi)));

console.log('RECORDS');
console.log('  ' + rows.length + ' returned' +
  (lists.length > 1 ? '  (the longest of ' + lists.length + ' lists in the response)' : ''));
if (unidentified) {
  console.log('  ' + unidentified + ' with nothing that looks like an MMSI — ' +
    'check the field names below');
}
console.log();

console.log('OUR FLEET');
console.log('  ' + seen.size + ' of ' + FLEET.length + ' carried by this provider');
// When nothing at all came back, every vessel is "missing" and the list is
// sixty-one lines of noise burying the one line that matters — that the
// request itself failed. Say that instead.
if (missing.length && rows.length) {
  console.log();
  console.log('  NOT carried (' + missing.length + '):');
  missing.forEach((y) => {
    console.log('    ' + String(y.mmsi) + '  ' + y.name +
      (y.sentinel ? '   [Sentinel]' : ''));
  });
}
console.log();

if (!rows.length) {
  console.log('Nothing came back. If the request was refused, the reason is in ' +
    'the file — providers often report a refusal with an ordinary HTTP 200 and ' +
    'an error inside the body.');
  process.exit(0);
}

/**
 * One record, whole.
 *
 * Field names and units are where an integration silently goes wrong: speed in
 * knots-times-ten reads as a fleet doing seventy, and a timestamp with no zone
 * is read as local time and is an hour out all summer. Both have already
 * happened on this project. Looking at one real record costs nothing and
 * catches both.
 */
console.log('ONE RECORD, AS IT ARRIVED');
console.log(JSON.stringify(rows[0], null, 2));
console.log();

console.log('FIELDS TO CHECK BEFORE WRITING AN ADAPTER');
const keys = Object.keys(rows[0]);
const flag = (label, test) => {
  const hits = keys.filter(test);
  console.log('  ' + label.padEnd(22) + (hits.length ? hits.join(', ') : '— none obvious'));
};
flag('position', (k) => /^(lat|lon|latitude|longitude)/i.test(k));
flag('speed / course', (k) => /(speed|sog|course|cog|heading)/i.test(k));
flag('time of the fix', (k) => /(time|timestamp|epoch|utc|updated|last)/i.test(k));
flag('where it came from', (k) => /(source|dsrc|sat|terr)/i.test(k));
console.log();
console.log('  Speed: knots, or knots x10? Time: UTC with a zone on it, or without?');
console.log('  Those two have each already cost this project a day.');
