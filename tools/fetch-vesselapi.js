/* -----------------------------------------------------------------------------
 * fetch-vesselapi.js — ask VesselAPI for the fleet, and count what it costs.
 *
 *   node tools/fetch-vesselapi.js YOUR_KEY              one page
 *   node tools/fetch-vesselapi.js YOUR_KEY --pages 10   follow the cursor
 *   node tools/fetch-vesselapi.js YOUR_KEY --pages 10 --limit 200
 *
 * You do not need to know anything about HTTP to run this. It reads the
 * sixty-one MMSIs out of fleet.js, asks for all of them at once, and reports
 * what came back against the fleet we actually have.
 *
 * WHAT THE FIRST REAL ANSWER TAUGHT US, AND WHY THIS FILE PAGES
 *
 * This is not a "where is each of my vessels now" endpoint. It is a stream of
 * position REPORTS, newest first, twenty to a page, with a cursor. Twenty
 * records covered four minutes and held twelve distinct yachts, several of them
 * twice — so a single page can never answer how many of the sixty-one it
 * carries, and reading one as if it could would have written this provider off
 * at twelve.
 *
 * That shape also changes the arithmetic. Polling for positions costs a request
 * every time you look, however little has happened; reading a stream costs one
 * request per twenty reports, however often you look. What the plan has to
 * cover is therefore HOW MUCH THE FLEET TALKS, not how fresh we want the board
 * — which is why this prints records-per-call and a projected monthly figure
 * rather than just a vessel count.
 *
 * THE KEY IS NEVER STORED. Read from the command line or VESSELAPI_KEY, sent in
 * the Authorization header, and written to nothing.
 * -------------------------------------------------------------------------- */

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.env.VESSELAPI_BASE || 'https://api.vesselapi.com';
const PATHNAME = process.env.VESSELAPI_PATH || '/v1/vessels/positions';

// The cursor comes back as `nextToken`. Which query parameter sends it back is
// not something a response reveals, so it is a guess with an override — and the
// run below detects the guess being wrong rather than quietly re-reading page
// one for ever.
const TOKEN_PARAM = process.env.VESSELAPI_TOKEN_PARAM || 'nextToken';

/**
 * One URL, all sixty-one.
 *
 * Bulk is the whole point: a provider that answers one vessel per request
 * cannot serve this board at any price we would pay. Kept as a plain function
 * so a test can read what would be sent without a network.
 */
function buildUrl(mmsis, opts) {
  const o = opts || {};
  const url = new URL((o.pathname || PATHNAME).replace(/^\/?/, '/'),
                      o.base || BASE);
  url.searchParams.set('filter.idType', 'mmsi');
  url.searchParams.set('filter.ids', mmsis.map(String).join(','));
  if (o.limit) url.searchParams.set('limit', String(o.limit));
  if (o.token) url.searchParams.set(o.tokenParam || TOKEN_PARAM, o.token);
  return url.toString();
}

/**
 * The records, wherever they are, and the cursor if there is one.
 *
 * Shape-blind on purpose, like tools/check-provider.js: take the longest array
 * of objects in the body. Their key is `vesselPositions` today; a tool that
 * hard-codes that reports zero the day it changes.
 */
function readPage(body) {
  const lists = [];
  (function walk(node, depth) {
    if (depth > 6 || node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const objects = node.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
      if (objects.length === node.length && objects.length) lists.push(node);
      return;
    }
    Object.keys(node).forEach((k) => walk(node[k], depth + 1));
  })(body, 0);
  lists.sort((a, b) => b.length - a.length);
  const token = body && (body.nextToken || body.next_token || body.nextPageToken);
  return { rows: lists[0] || [], token: token || null };
}

/**
 * The newest report for each vessel.
 *
 * The stream carries the same fix more than once — the first real answer had
 * RADIANT at 22:32:42.238727Z and again at 22:32:42Z, same position, different
 * processing times, plainly one broadcast heard twice. Counting reports would
 * flatter the feed and confuse the arithmetic; counting vessels is the question.
 */
function newestPerVessel(rows) {
  const best = new Map();
  rows.forEach((row) => {
    const m = mmsiOf(row);
    if (!m) return;
    const at = Date.parse(row.timestamp || row.time || 0) || 0;
    const held = best.get(m);
    if (!held || at > held.at) best.set(m, { at: at, row: row });
  });
  return best;
}

function mmsiOf(row) {
  const looksRight = (v) => /^[2-7]\d{8}$/.test(String(v));
  const named = ['mmsi', 'MMSI', 'Mmsi', 'mmsi_number', 'mmsiNumber'];
  for (const k of named) if (row[k] != null && looksRight(row[k])) return String(row[k]);
  for (const k of Object.keys(row)) if (looksRight(row[k])) return String(row[k]);
  return null;
}

module.exports = { buildUrl, readPage, newestPerVessel };

if (require.main === module) main();

function main() {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf('--' + name);
    return i === -1 ? dflt : Number(args[i + 1]);
  };
  const pages = Math.max(1, flag('pages', 1));
  const limit = flag('limit', 0);
  const key = args.filter((a) => !a.startsWith('--') &&
    !/^\d+$/.test(a))[0] || process.env.VESSELAPI_KEY;

  if (!key) {
    console.error('usage: node tools/fetch-vesselapi.js YOUR_KEY [--pages N] [--limit N]');
    console.error('   or: VESSELAPI_KEY=... node tools/fetch-vesselapi.js');
    console.error('');
    console.error('The key is the one on the VesselAPI dashboard. It is used for');
    console.error('these requests and is not saved anywhere.');
    console.error('');
    console.error('--pages costs one request PER PAGE. Start with 1.');
    process.exit(2);
  }

  global.window = {};
  require(path.join(__dirname, '..', 'fleet.js'));
  const fleet = global.window.FLEET;
  const mmsis = fleet.map((y) => y.mmsi);
  const out = path.join(process.cwd(), 'vesselapi.json');

  console.log('ASKING');
  console.log('  ' + mmsis.length + ' vessels' +
    (pages > 1 ? ', up to ' + pages + ' pages — that is up to ' + pages +
      ' requests off the allowance' : ', one request'));
  if (limit) console.log('  asking for ' + limit + ' records a page');
  console.log();

  const all = [];
  let calls = 0;
  let token = null;
  let firstOfFirstPage = null;

  const step = () => fetch(buildUrl(mmsis, { limit: limit, token: token }), {
    // A key in the query string ends up in server logs and in the URL printed
    // above; a header does not.
    headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' }
  }).then((res) => res.text().then((body) => ({ res: res, body: body })))
    .then((got) => {
      calls++;
      if (!got.res.ok) {
        console.log('HTTP ' + got.res.status + ' ' + got.res.statusText +
          ' on request ' + calls + '. What they said:');
        console.log(got.body.slice(0, 1200));
        return finish(all, calls, fleet, out, limit);
      }

      let parsed;
      try { parsed = JSON.parse(got.body); }
      catch (e) {
        console.log('That answer is not JSON:');
        console.log(got.body.slice(0, 800));
        return finish(all, calls, fleet, out, limit);
      }

      const page = readPage(parsed);
      const firstId = page.rows.length ? JSON.stringify(page.rows[0]) : null;

      if (calls === 1) {
        firstOfFirstPage = firstId;
        console.log('  page 1: ' + page.rows.length + ' records' +
          (limit && page.rows.length < limit
            ? '  (asked for ' + limit + ' — a page size this provider will not exceed)'
            : ''));
      } else {
        if (firstId && firstId === firstOfFirstPage) {
          // The cursor was sent and ignored: the same page came back. Paging on
          // would burn the allowance re-reading one page, which is exactly the
          // sort of quiet loop that produces an invoice.
          console.log('  page ' + calls + ': the same records as page 1 — the ' +
            'cursor is not being accepted under the name "' + TOKEN_PARAM + '".');
          console.log('  Their documentation will name it. Re-run with:');
          console.log('    VESSELAPI_TOKEN_PARAM=<the right name> node ' +
            'tools/fetch-vesselapi.js ...');
          return finish(all, calls, fleet, out, limit);
        }
        console.log('  page ' + calls + ': ' + page.rows.length + ' records');
      }

      all.push.apply(all, page.rows);
      token = page.token;

      if (!token || calls >= pages || !page.rows.length) {
        return finish(all, calls, fleet, out, limit, !token);
      }
      return step();
    });

  step().catch((err) => {
    console.error('The request did not complete: ' + ((err && err.message) || err));
    console.error('If this machine is behind a proxy or offline, that is what ' +
      'this looks like.');
    process.exit(1);
  });
}

function finish(rows, calls, fleet, out, limit, exhausted) {
  fs.writeFileSync(out, JSON.stringify({ vesselPositions: rows }, null, 2));

  const best = newestPerVessel(rows);
  const ours = new Set(fleet.map((y) => String(y.mmsi)));
  const mine = [];
  const strangers = [];
  best.forEach((v, m) => (ours.has(m) ? mine : strangers).push(m));

  const times = rows.map((r) => Date.parse(r.timestamp || r.time || 0))
    .filter((t) => t > 0).sort((a, b) => a - b);
  const spanMin = times.length > 1 ? (times[times.length - 1] - times[0]) / 60000 : 0;

  console.log();
  console.log('WHAT CAME BACK');
  console.log('  ' + rows.length + ' reports in ' + calls + ' request' +
    (calls === 1 ? '' : 's') + '  (' + (rows.length / calls).toFixed(1) + ' a request)');
  if (spanMin) console.log('  covering ' + spanMin.toFixed(1) + ' minutes of history');
  console.log('  ' + mine.length + ' of ' + fleet.length + ' of our yachts' +
    (exhausted ? '' : ' — the stream did not run out, so this is a floor, not the answer'));
  if (strangers.length) {
    console.log('  ' + strangers.length + ' vessels that are not ours — the MMSI ' +
      'filter is not being applied');
  }

  const missing = fleet.filter((y) => !best.has(String(y.mmsi)));
  if (missing.length && rows.length) {
    console.log();
    console.log('  NOT SEEN in this window (' + missing.length + '):');
    missing.forEach((y) => {
      console.log('    ' + y.mmsi + '  ' + y.name + (y.sentinel ? '   [Sentinel]' : ''));
    });
  }

  /**
   * What this costs a month, from what was actually observed.
   *
   * On a stream the bill follows the fleet's chatter, not our refresh rate: to
   * miss nothing we must read every report once, whenever we happen to look.
   * So the figure that matters is reports per minute divided by page size.
   */
  if (spanMin > 0.5 && rows.length) {
    const perMin = rows.length / spanMin;
    const pageSize = Math.max(1, Math.round(rows.length / calls));
    const monthly = Math.round(perMin * 60 * 24 * 30 / pageSize);
    console.log();
    console.log('WHAT IT WOULD COST');
    console.log('  ' + perMin.toFixed(1) + ' reports a minute at ' + pageSize +
      ' a page  =  about ' + monthly.toLocaleString('en-GB') + ' requests a month');
    console.log('  to read the stream without gaps, at any refresh rate.');
    if (!limit) {
      console.log('  A larger page size divides that figure directly. Worth ' +
        'finding out what they will serve: --limit 200');
    }
  }

  if (rows.length) {
    console.log();
    console.log('LATENCY, AS THEY REPORT IT');
    const lags = rows.map((r) => (Date.parse(r.processed_timestamp) -
      Date.parse(r.timestamp)) / 1000).filter((n) => isFinite(n) && n >= 0)
      .sort((a, b) => a - b);
    if (lags.length) {
      console.log('  middle ' + lags[Math.floor(lags.length / 2)].toFixed(0) +
        's, worst ' + lags[lags.length - 1].toFixed(0) + 's ' +
        'between the fix and them having it');
    } else {
      console.log('  not reported');
    }
    console.log();
    console.log('ONE RECORD, AS IT ARRIVED');
    console.log(JSON.stringify(rows[0], null, 2));
  }

  console.log();
  console.log('Saved to ' + out);
  return null;
}
