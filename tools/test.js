/* -----------------------------------------------------------------------------
 * A browser-free check of the logic behind the board: navigation maths, unit
 * formatting, the AIS message parser, and the store's state derivation.
 *
 *   node tools/test.js
 *
 * Rendering is not covered here — open index.html for that.
 * -------------------------------------------------------------------------- */

const assert = require('assert');
const path = require('path');

// A minimal browser stand-in. localStorage throws, on purpose: the store has to
// survive a browser with site data blocked.
global.window = {};
global.localStorage = {
  getItem() { throw new Error('storage disabled'); },
  setItem() { throw new Error('storage disabled'); },
  removeItem() {}
};

const fs = require('fs');
const load = (f) => require(path.join(__dirname, '..', f));

// Enough of a 2D context for map.js to initialise. The camera maths under test
// touches none of it, but init insists on having one.
function stubCanvasContext() {
  const noop = () => {};
  return new Proxy({}, {
    get(_, key) {
      if (key === 'measureText') return () => ({ width: 40 });
      if (key === 'createRadialGradient' || key === 'createLinearGradient') {
        return () => ({ addColorStop: noop });
      }
      if (key === 'canvas') return { width: 1200, height: 800 };
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return typeof key === 'string' ? noop : undefined;
    },
    set() { return true; }
  });
}
// Some checks are about the source of a file rather than its behaviour.
const readRepo = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
['config.js', 'fleet.js', 'data/mid.js', 'data/ports.js', 'data/world-land.js',
 'js/geo.js', 'js/format.js', 'js/store.js', 'js/ais.js', 'js/vessel.js',
 'js/demo.js', 'js/csv.js', 'js/map.js', 'js/cluster.js',
 'js/marinetraffic.js', 'js/vesselapi.js', 'js/relay.js',
 'js/feed.js'].forEach(load);

const { Geo, Fmt, Store, Ais, Vessel, Demo, Csv, PORTS, CONFIG, Cluster,
        MarineTraffic, VesselApi, Relay } = window;
const FleetMap = window.FleetMap;

// The behavioural tests run against a fixed sample fleet, NOT against fleet.js.
// fleet.js is the file you replace with your own boats; a suite that failed the
// moment you did that would be crying wolf on every real edit. Checks that are
// genuinely about your file — unique ids, valid MMSIs — use REAL_FLEET below.
load('tools/fixtures/fleet-sample.js');
const FLEET = window.FLEET_SAMPLE;
const REAL_FLEET = window.FLEET;

let passed = 0;
/**
 * A run is a pass only if it reached its own last line.
 *
 * A `process.exit()` ended up in the middle of this file — twice — after an
 * edit appended past it. The run stopped there, printed nothing at all and
 * exited 0: every check below it never ran, and the suite reported success by
 * saying nothing.
 *
 * The first attempt at a guard set `process.exitCode = 1` at the top and let
 * the epilogue clear it. That did not work, because the stray line was itself
 * `process.exit(failed ? 1 : 0)` — with no failures recorded yet, it exited 0
 * and looked exactly like success. The exit code was never the thing to guard;
 * REACHING THE END was.
 *
 * So the end sets a flag, and an exit handler — which runs however the process
 * leaves, `process.exit()` included — fails the run if the flag is not set.
 */
let reachedEnd = false;
let failed = 0;

process.on('exit', function (code) {
  if (reachedEnd) return;
  console.error('\nThe suite stopped before its last line. ' + passed +
    ' checks had run and the rest never did, so this is NOT a pass' +
    (code ? '' : ' — whatever exited early reported success.'));
  process.exitCode = 1;
});

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error('FAIL  ' + name + '\n      ' + e.message);
    failed++;
  }
}
const close = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, (msg || '') + ` expected ~${b}, got ${a}`);

/* --- Navigation --------------------------------------------------------- */

test('great-circle distance matches known legs', () => {
  close(Geo.distanceNm(-0.13, 51.51, -74.01, 40.71), 3008, 8, 'London→New York');
  close(Geo.distanceNm(2.635, 39.56, 1.436, 38.908), 68, 1.5, 'Palma→Ibiza');
  assert.strictEqual(Geo.distanceNm(10, 45, 10, 45), 0);
});

test('bearing is the initial great-circle course', () => {
  close(Geo.bearing(0, 0, 0, 10), 0, 0.01, 'due north');
  close(Geo.bearing(0, 0, 10, 0), 90, 0.01, 'due east');
  close(Geo.bearing(-0.13, 51.51, -74.01, 40.71), 288, 1, 'London→New York');
});

test('destination round-trips against distance and bearing', () => {
  const [lon, lat] = Geo.destination(2.635, 39.56, 225, 68);
  close(Geo.distanceNm(2.635, 39.56, lon, lat), 68, 0.01);
  close(Geo.bearing(2.635, 39.56, lon, lat), 225, 0.1);
});

test('destination normalises across the antimeridian', () => {
  const [lon] = Geo.destination(179.5, 0, 90, 120);
  assert.ok(lon >= -180 && lon <= 180, 'longitude wrapped into range, got ' + lon);
  assert.ok(lon < 0, 'crossing east from 179.5E lands in the western hemisphere');
});

test('compass points read correctly', () => {
  assert.strictEqual(Geo.compassPoint(0), 'N');
  assert.strictEqual(Geo.compassPoint(225), 'SW');
  assert.strictEqual(Geo.compassPoint(359), 'N');
  assert.strictEqual(Geo.compassPoint(-45), 'NW');
});

test('Mercator projection round-trips and clamps at the poles', () => {
  close(Geo.latFromWorldY(Geo.worldY(39.57)), 39.57, 1e-6);
  close(Geo.lonFromWorldX(Geo.worldX(-62.85)), -62.85, 1e-9);
  assert.ok(isFinite(Geo.worldY(90)), 'the pole must not produce Infinity');
  assert.ok(isFinite(Geo.worldY(-90)));
});

/* --- Sun ----------------------------------------------------------------- */

test('sunrise and sunset match published times', () => {
  // London, midwinter: published 08:04 / 15:53 UTC.
  const london = Geo.sunTimes(new Date('2026-12-21T12:00:00Z'), -0.13, 51.51);
  close(london.sunrise.getUTCHours() * 60 + london.sunrise.getUTCMinutes(), 484, 6);
  close(london.sunset.getUTCHours() * 60 + london.sunset.getUTCMinutes(), 953, 6);
});

test('polar day and night are reported, not faked', () => {
  assert.strictEqual(Geo.sunTimes(new Date('2026-06-21T12:00:00Z'), 18.95, 69.65).polar, 'day');
  assert.strictEqual(Geo.sunTimes(new Date('2026-12-21T12:00:00Z'), 18.95, 69.65).polar, 'night');
  const temperate = Geo.sunTimes(new Date('2026-06-21T12:00:00Z'), 2.65, 39.57);
  assert.strictEqual(temperate.polar, null);
});

test('solar altitude peaks near local noon', () => {
  // Palma, late August: elevation at local apparent noon ≈ 90 - lat + declination.
  close(Geo.solarAltitude(new Date('2026-08-28T11:50:00Z'), 2.65, 39.57), 60, 2);
  assert.ok(Geo.solarAltitude(new Date('2026-08-28T23:50:00Z'), 2.65, 39.57) < 0, 'midnight');
});

test('the terminator spans the globe and picks the dark pole', () => {
  const june = Geo.terminator(new Date('2026-06-21T12:00:00Z'), 10);
  assert.strictEqual(june.points.length, 37);
  assert.strictEqual(june.nightAtNorthPole, false, 'northern midsummer');
  assert.strictEqual(Geo.terminator(new Date('2026-12-21T12:00:00Z'), 10).nightAtNorthPole, true);
});

/* --- Twilight ------------------------------------------------------------ */

test('twilight contours stay ordered toward the dark pole', () => {
  // Ordering is what lets the chart fill bands between them: if a lower contour
  // ever crossed a higher one the band would invert and paint over daylight.
  const dates = ['2026-03-20T18:00:00Z', '2026-06-21T00:00:00Z',
                 '2026-08-28T12:00:00Z', '2026-09-22T09:00:00Z',
                 '2026-12-21T06:00:00Z', '2026-01-15T21:00:00Z'];
  for (const iso of dates) {
    const date = new Date(iso);
    const result = Geo.twilightContours(date, [-6, -12, -18], 5);
    const darkSign = result.nightAtNorthPole ? 1 : -1;
    for (let i = 0; i < result.contours[0].length; i++) {
      for (let k = 1; k < result.contours.length; k++) {
        const previous = result.contours[k - 1][i][1];
        const current = result.contours[k][i][1];
        assert.ok(darkSign * (current - previous) >= -0.01,
          `${iso}: contour ${k} crosses back at lon ${result.contours[k][i][0]}`);
      }
    }
  }
});

test('every twilight contour point is a real solution, a pole, or a closed band', () => {
  const altitudes = [0, -6, -12, -18];
  for (const iso of ['2026-08-28T12:00:00Z', '2026-09-22T09:00:00Z', '2026-12-21T06:00:00Z']) {
    const date = new Date(iso);
    const result = Geo.twilightContours(date, [-6, -12, -18], 5);
    result.contours.forEach((contour, k) => {
      contour.forEach(([lon, lat], i) => {
        if (Math.abs(lat) > 89.5) return;                                   // pinned at a pole
        if (k > 0 && Math.abs(lat - result.contours[k - 1][i][1]) < 0.001) return;  // zero-width band
        close(Geo.solarAltitude(date, lon, lat), altitudes[k], 0.01,
          `${iso} contour ${altitudes[k]} at lon ${lon}`);
      });
    });
  }
});

/* --- Ports and discretion ------------------------------------------------ */

test('nearest port resolves to the right harbour', () => {
  assert.strictEqual(Geo.nearestPort(-62.83, 17.90, PORTS).name, 'Gustavia');
  assert.strictEqual(Geo.nearestPort(7.42, 43.73, PORTS).name, 'Monaco');
  const offIbiza = Geo.nearestPort(1.60, 38.95, PORTS);
  assert.strictEqual(offIbiza.name, 'Ibiza');
  assert.ok(offIbiza.distanceNm > 3 && offIbiza.distanceNm < 30, offIbiza.distanceNm);
});

test('blurring moves a fix onto a coarse grid', () => {
  const [lon, lat] = Geo.blur(7.4256, 43.7350, 60);
  assert.ok(Geo.distanceNm(7.4256, 43.7350, lon, lat) > 0.5, 'the fix actually moved');
  assert.ok(Geo.distanceNm(7.4256, 43.7350, lon, lat) < 60, 'but stays in the right area');
  // Deterministic: the same input must not wander between frames.
  assert.deepStrictEqual(Geo.blur(7.4256, 43.7350, 60), [lon, lat]);
});

/* --- Coastline ----------------------------------------------------------- */

test('coastline decodes to sane geometry', () => {
  const rings = Geo.decodeLand(window.WORLD_LAND_ENCODED, window.WORLD_LAND_SCALE);
  assert.ok(rings.length > 1000, 'ring count ' + rings.length);
  let points = 0;
  for (const r of rings) {
    assert.strictEqual(r.length % 2, 0, 'rings hold lon/lat pairs');
    for (let i = 0; i < r.length; i += 2) {
      assert.ok(r[i + 1] >= -90.5 && r[i + 1] <= 90.5, 'latitude ' + r[i + 1]);
    }
    points += r.length / 2;
  }
  assert.ok(points > 40000, 'point count ' + points);
});

// Longitudes are deliberately NOT clamped to +/-180: rings that cross the
// antimeridian are unwrapped at build time so they stay continuous. What must
// hold is that no single step jumps the seam, because a step of ~360 degrees
// draws a bar straight across the chart.
test('no ring steps across the antimeridian', () => {
  const rings = Geo.decodeLand(window.WORLD_LAND_ENCODED, window.WORLD_LAND_SCALE);
  let worst = 0, offender = null;
  for (const r of rings) {
    for (let i = 2; i < r.length; i += 2) {
      const step = Math.abs(r[i] - r[i - 2]);
      if (step > worst) { worst = step; offender = r[i]; }
    }
  }
  assert.ok(worst <= 180, `largest longitude step ${worst.toFixed(1)} deg near lon ${offender}`);
});

/* --- Formatting ---------------------------------------------------------- */

test('positions format as degrees and decimal minutes', () => {
  assert.strictEqual(Fmt.latitude(39.5696), "39° 34.18' N");
  assert.strictEqual(Fmt.longitude(2.6502), "002° 39.01' E");
  assert.strictEqual(Fmt.longitude(-62.85), "062° 51.00' W");
  assert.strictEqual(Fmt.latitude(-33.91), "33° 54.60' S");
});

test('minute rollover carries into degrees', () => {
  assert.strictEqual(Fmt.latitude(39.99999), "40° 00.00' N");
});

test('units convert on demand', () => {
  assert.strictEqual(Fmt.distance(3008), '3,008 nm');
  assert.strictEqual(Fmt.speed(12.4), '12.4 kn');
  assert.strictEqual(Fmt.temperature(24.6), '25°C');
  CONFIG.units.distance = 'km';
  CONFIG.units.temperature = 'F';
  assert.strictEqual(Fmt.distance(100), '185 km');
  assert.strictEqual(Fmt.temperature(0), '32°F');
  CONFIG.units.distance = 'nm';
  CONFIG.units.temperature = 'C';
});

test('optional vessel fields render as a dash when empty', () => {
  // A vessel added through the console's form carries only its identifiers;
  // every view has to survive that, which it did not before the form existed.
  assert.strictEqual(Fmt.metres(null), '—');
  assert.strictEqual(Fmt.metres(undefined), '—');
  assert.strictEqual(Fmt.metres(NaN), '—');
  assert.strictEqual(Fmt.metres(52.5), '52.5 m');
  assert.strictEqual(Fmt.tonnage(null), '—');
  assert.strictEqual(Fmt.tonnage(1180), '1,180 GT');
  assert.strictEqual(Fmt.year(null), '—');
  assert.strictEqual(Fmt.year(2024), '2024');
  assert.strictEqual(Fmt.text(null), '—');
  assert.strictEqual(Fmt.text(''), '—');
  assert.strictEqual(Fmt.text('Lloyd\'s Register'), "Lloyd's Register");
});

test('missing values render as a dash, never as NaN', () => {
  ['distance', 'speed', 'windSpeed', 'temperature', 'waveHeight', 'bearing'].forEach((fn) => {
    assert.strictEqual(Fmt[fn](null), '—', fn + '(null)');
    assert.strictEqual(Fmt[fn](undefined), '—', fn + '(undefined)');
  });
  assert.strictEqual(Fmt.age(null), 'no fix');
  assert.strictEqual(Fmt.date('not a date'), '—');
});

test('fix age reads in the right unit', () => {
  const now = new Date('2026-08-28T12:00:00Z');
  assert.strictEqual(Fmt.age(new Date('2026-08-28T11:59:50Z'), now), 'just now');
  assert.strictEqual(Fmt.age(new Date('2026-08-28T11:51:00Z'), now), '9 min ago');
  assert.strictEqual(Fmt.age(new Date('2026-08-28T09:00:00Z'), now), '3 h ago');
  assert.strictEqual(Fmt.age(new Date('2026-08-26T12:00:00Z'), now), '2 days ago');
});

test('countdowns handle today, tomorrow and overdue', () => {
  const now = new Date('2026-08-28T09:00:00Z');
});

test("ship's time follows longitude; a known offset wins when we have one", () => {
  const noonUtc = new Date('2026-08-28T12:00:00Z');
  assert.strictEqual(Fmt.nauticalTime(noonUtc, -62.85).text, '08:00');
  assert.strictEqual(Fmt.nauticalTime(noonUtc, -62.85).offsetHours, -4);
  assert.strictEqual(Fmt.timeAtOffset(noonUtc, 7200, false).text, '14:00');
  assert.strictEqual(Fmt.timeAtOffset(noonUtc, 7200, false).label, 'UTC+2');
  assert.strictEqual(Fmt.timeAtOffset(noonUtc, 19800, false).label, 'UTC+5:30');
});

/* --- AIS parsing --------------------------------------------------------- */

test('AISstream timestamps parse', () => {
  const t = Ais._parseTime('2026-08-28 19:41:02.123456789 +0000 UTC');
  assert.strictEqual(t.toISOString(), '2026-08-28T19:41:02.000Z');
  assert.ok(!isNaN(Ais._parseTime('nonsense')), 'garbage falls back to now');
});

/* --- Store --------------------------------------------------------------- */

function freshStore() {
  Store.listeners = [];
  Store.init(FLEET);
  Store.vessels.forEach((v) => { v.fix = null; v.track = []; v.voyage = {}; });
  return Store;
}

test('fixes are accepted only for known vessels', () => {
  const s = freshStore();
  assert.strictEqual(s.applyFix(FLEET[0].mmsi, { lon: 2, lat: 39, at: new Date() }), true);
  assert.strictEqual(s.applyFix(999999999, { lon: 2, lat: 39, at: new Date() }), false);
});

test('impossible coordinates are rejected', () => {
  const s = freshStore();
  const mmsi = FLEET[0].mmsi;
  assert.strictEqual(s.applyFix(mmsi, { lon: 181, lat: 39, at: new Date() }), false);
  assert.strictEqual(s.applyFix(mmsi, { lon: 2, lat: 91, at: new Date() }), false);
  assert.strictEqual(s.applyFix(mmsi, { lon: NaN, lat: 39, at: new Date() }), false);
  assert.strictEqual(s.byMmsi[String(mmsi)].fix, null);
});

test('an out-of-order message cannot drag a yacht backwards', () => {
  const s = freshStore();
  const mmsi = FLEET[0].mmsi;
  const now = new Date();
  s.applyFix(mmsi, { lon: 2, lat: 39, at: now });
  assert.strictEqual(s.applyFix(mmsi, { lon: 9, lat: 44, at: new Date(now - 60000) }), false);
  assert.strictEqual(s.byMmsi[String(mmsi)].fix.lon, 2);
});

test('a vessel alongside does not accumulate track points', () => {
  const s = freshStore();
  const mmsi = FLEET[0].mmsi;
  // Relative to now, not a fixed date: the store trims anything older than
  // CONFIG.display.trackHours, so a pinned timestamp quietly stops testing what
  // it says once the calendar moves past it.
  const t0 = Date.now() - 10 * 60 * 1000;
  for (let i = 0; i < 50; i++) {
    s.applyFix(mmsi, { lon: 2.0, lat: 39.0, at: new Date(t0 + i * 10000) });
  }
  assert.strictEqual(s.byMmsi[String(mmsi)].track.length, 1);
});

test('the track window drops fixes older than it', () => {
  const s = freshStore();
  const mmsi = FLEET[0].mmsi;
  const beyond = CONFIG.display.trackHours + 2;
  s.applyFix(mmsi, { lon: 2.0, lat: 39.0, at: new Date(Date.now() - beyond * 3600000) });
  s.applyFix(mmsi, { lon: 2.5, lat: 39.5, at: new Date() });
  s.recompute();
  assert.strictEqual(s.byMmsi[String(mmsi)].track.length, 1, 'only the recent fix survives');
});

test('status derives from navigational status, speed and yard period', () => {
  const s = freshStore();
  const now = new Date();
  const [a, b, c] = [FLEET[0].mmsi, FLEET[1].mmsi, FLEET[3].mmsi];
  s.applyFix(a, { lon: -30, lat: 30, sog: 12, navStatus: 0, at: now });
  s.applyFix(b, { lon: -30, lat: 31, sog: 0.1, navStatus: 1, at: now });
  s.applyFix(c, { lon: 7.4256, lat: 43.735, sog: 0, navStatus: 5, at: now });
  s.recompute();
  assert.strictEqual(s.byMmsi[String(a)].derived.status, 'underway');
  assert.strictEqual(s.byMmsi[String(b)].derived.status, 'anchored');
  assert.strictEqual(s.byMmsi[String(c)].derived.status, 'moored');

  // A yacht sitting still far from any harbour is at anchor, not alongside.
  const s2 = freshStore();
  s2.applyFix(a, { lon: -30, lat: 30, sog: 0.1, navStatus: null, at: new Date() });
  s2.recompute();
  assert.strictEqual(s2.byMmsi[String(a)].derived.status, 'anchored');
});

test('a stale fix becomes "no signal" rather than a confident position', () => {
  const s = freshStore();
  const mmsi = FLEET[0].mmsi;
  const old = new Date(Date.now() - (CONFIG.ais.darkPositionHours + 5) * 3600000);
  s.applyFix(mmsi, { lon: -38, lat: 29, sog: 15, navStatus: 0, at: old });
  s.recompute();
  const d = s.byMmsi[String(mmsi)].derived;
  assert.strictEqual(d.status, 'dark');
  assert.strictEqual(d.dark, true);
  assert.ok(d.lat != null, 'the last known position is still shown');
});

test('discreet vessels never expose an exact position downstream', () => {
  const s = freshStore();
  const discreet = FLEET.find((y) => y.discreet);
  assert.ok(discreet, 'the placeholder fleet includes a discreet yacht');
  s.applyFix(discreet.mmsi, { lon: 14.32, lat: 40.57, sog: 10, navStatus: 0, at: new Date() });
  s.recompute();
  const d = s.byMmsi[String(discreet.mmsi)].derived;
  assert.strictEqual(d.discreet, true);
  assert.notStrictEqual(d.lon, 14.32, 'the published longitude is not the real one');
  assert.ok(Geo.distanceNm(14.32, 40.57, d.lon, d.lat) > 1, 'and it has actually moved');
});

test('global discreet mode covers the whole fleet', () => {
  const s = freshStore();
  CONFIG.discreetMode = true;
  s.applyFix(FLEET[0].mmsi, { lon: 2.0, lat: 39.0, sog: 10, navStatus: 0, at: new Date() });
  s.recompute();
  assert.strictEqual(s.byMmsi[String(FLEET[0].mmsi)].derived.discreet, true);
  CONFIG.discreetMode = false;
});

test('summary counts every vessel exactly once', () => {
  const s = freshStore();
  s.recompute();
  const summary = s.summary();
  const total = Object.values(summary.counts).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, FLEET.length);
  assert.strictEqual(summary.total, FLEET.length);
});

test('a hostile storage layer does not take the board down', () => {
  const s = freshStore();
  s.applyFix(FLEET[0].mmsi, { lon: 2, lat: 39, at: new Date() });
  assert.doesNotThrow(() => s.persist());
  assert.doesNotThrow(() => s.clearCache());
});

/* --- Vessel records ------------------------------------------------------ */

test('IMO check digits are computed the way the standard defines them', () => {
  // Four real, published IMO numbers.
  for (const imo of ['9074729', '9395044', '9247455', '8814275']) {
    assert.strictEqual(Vessel.validateImo(imo).ok, true, imo + ' should be valid');
  }
});

test('a mistyped IMO is rejected with the digit it should have been', () => {
  const result = Vessel.validateImo('9074728');
  assert.strictEqual(result.ok, false);
  assert.ok(/check digit should be 9/.test(result.error), result.error);
});

test('IMO input is forgiving about formatting but strict about length', () => {
  assert.strictEqual(Vessel.validateImo('IMO 9395044').value, 9395044);
  assert.strictEqual(Vessel.validateImo('  9395044  ').value, 9395044);
  assert.strictEqual(Vessel.validateImo('123').ok, false);
  assert.strictEqual(Vessel.validateImo('90747290').ok, false);
  assert.strictEqual(Vessel.validateImo('90747ab').ok, false);
  assert.strictEqual(Vessel.validateImo('').ok, false);
  assert.strictEqual(Vessel.validateImo(null).ok, false);
});

test('MMSI must be a ship station, not a coast station or a handheld', () => {
  assert.strictEqual(Vessel.validateMmsi('319000001').value, 319000001);
  assert.strictEqual(Vessel.validateMmsi('249123456').ok, true);
  assert.strictEqual(Vessel.validateMmsi('991123456').ok, false, '99x is an aid to navigation');
  assert.strictEqual(Vessel.validateMmsi('009123456').ok, false, '00x is a coast station');
  assert.strictEqual(Vessel.validateMmsi('12345').ok, false);
  assert.strictEqual(Vessel.validateMmsi('').ok, false);
});

test('a built record renders to JavaScript that actually parses', () => {
  const record = Vessel.buildRecord({
    name: "O'Brien's Folly", mmsi: 319123456, imo: 9074729,
    loa: 52.5, yearBuilt: 2024, flag: 'Cayman Islands', prefix: 'S/Y'
  });
  const snippet = Vessel.toSnippet(record);
  const parsed = new Function('return [' + snippet + '][0]')();
  assert.strictEqual(parsed.mmsi, 319123456);
  assert.strictEqual(parsed.imo, 9074729);
  assert.strictEqual(parsed.name, "O'Brien's Folly", 'an apostrophe survives the round trip');
  assert.strictEqual(parsed.prefix, 'S/Y');
  assert.strictEqual(parsed.loa, 52.5);
  assert.strictEqual(parsed.discreet, false);
  assert.ok(!('service' in parsed) && !('systems' in parsed) && !('contacts' in parsed),
    'the record carries nothing but identity and position');
});

test('unknown fields are left null rather than guessed', () => {
  const record = Vessel.buildRecord({ name: 'Bare', mmsi: 319000999, imo: 9074729 });
  assert.strictEqual(record.beam, null);
  assert.strictEqual(record.grossTonnage, null);
  assert.strictEqual(record.classSociety, null);
  assert.strictEqual(record.yearBuilt, null);
});

test('storage being unavailable is survivable, not fatal', () => {
  // The harness at the top of this file has localStorage throw on every call.
  assert.doesNotThrow(() => Vessel.loadAdditions());
  assert.deepStrictEqual(Vessel.loadAdditions(), []);
  assert.strictEqual(Vessel.addAddition({ id: 'x', mmsi: 1 }), false, 'reports the failure');
  assert.deepStrictEqual(Vessel.mergedFleet(FLEET).length, FLEET.length);
});

test('merging never shadows a vessel already in the file', () => {
  const additions = [
    { id: 'aurelia', name: 'Impostor', mmsi: 999999999 },
    { id: 'brand-new', name: 'New', mmsi: 319555555 }
  ];
  const original = Vessel.loadAdditions;
  Vessel.loadAdditions = () => additions;
  try {
    const merged = Vessel.mergedFleet(FLEET);
    assert.strictEqual(merged.length, FLEET.length + 1, 'the id clash is dropped');
    assert.ok(merged.some((y) => y.id === 'brand-new'));
    assert.strictEqual(merged.filter((y) => y.id === 'aurelia').length, 1);
    assert.strictEqual(merged.find((y) => y.id === 'aurelia').name, 'Aurelia');
    assert.strictEqual(merged.find((y) => y.id === 'brand-new').addedLocally, true);
  } finally {
    Vessel.loadAdditions = original;
  }
});

test('the generated fleet.js is valid and carries every change', () => {
  // Removing a vessel for good means changing the file, so what the console
  // writes out has to be loadable as fleet.js — nested records and all.
  const additions = [Vessel.buildRecord({
    name: "Hal's Folly", mmsi: 319123456, imo: 9074729, loa: 44.2, yearBuilt: 2025
  })];
  const originalAdditions = Vessel.loadAdditions;
  const originalHidden = Vessel.hiddenIds;
  Vessel.loadAdditions = () => additions;
  Vessel.hiddenIds = () => ['corvina'];
  try {
    const merged = Vessel.mergedFleet(FLEET);
    const file = Vessel.toFleetFile(merged);

    // Run in a fresh realm, then normalise: objects built there carry that
    // realm's prototypes, which deepStrictEqual compares by identity.
    const sandbox = { window: {} };
    require('vm').runInNewContext(file, sandbox);
    const out = JSON.parse(JSON.stringify(sandbox.window.FLEET));

    assert.strictEqual(out.length, FLEET.length, 'one out, one in');
    assert.ok(!out.some((y) => y.id === 'corvina'), 'the removed vessel is gone');
    assert.ok(out.some((y) => y.name === "Hal's Folly"), 'the added one is there, apostrophe intact');
    assert.ok(!out.some((y) => 'addedLocally' in y), 'the local marker is not written out');

    // A full record must survive with its nesting.
    const aurelia = out.find((y) => y.id === 'aurelia');
    const source = JSON.parse(JSON.stringify(FLEET.find((y) => y.id === 'aurelia')));
    assert.deepStrictEqual(aurelia.demo.route, source.demo.route,
      'the demo route survives, nesting and all');
    assert.strictEqual(aurelia.classSociety, source.classSociety);
    assert.strictEqual(aurelia.discreet, source.discreet);
  } finally {
    Vessel.loadAdditions = originalAdditions;
    Vessel.hiddenIds = originalHidden;
  }
});

test('writing the file out and reading it back is stable', () => {
  // Round-tripping twice must not drift, or repeated edits would rot the file.
  const once = Vessel.toFleetFile(FLEET);
  const sandbox = { window: {} };
  require('vm').runInNewContext(once, sandbox);
  const twice = Vessel.toFleetFile(sandbox.window.FLEET);
  assert.strictEqual(once, twice, 'a second pass produces identical output');
});

/* --- Fleet data ---------------------------------------------------------- */

test('the AIS parser reads the fields AISstream actually sends', () => {
  // Field names are from aisstream/ais-message-models. Getting one wrong yields
  // undefined rather than an error, so it is worth pinning.
  const s = freshStore();
  const mmsi = FLEET[0].mmsi;
  const original = window.Store;
  window.Store = s;
  try {
    Ais._handle({
      MessageType: 'PositionReport',
      MetaData: { MMSI: mmsi, time_utc: new Date().toISOString() },
      Message: { PositionReport: {
        Valid: true, Latitude: 39.5, Longitude: 2.6, Cog: 91.2, Sog: 9.4,
        TrueHeading: 88, NavigationalStatus: 0, RateOfTurn: -12,
        PositionAccuracy: true, Raim: true
      } }
    });
    Ais._handle({
      MessageType: 'ShipStaticData',
      MetaData: { MMSI: mmsi, time_utc: new Date().toISOString() },
      Message: { ShipStaticData: {
        Valid: true, Name: 'AURELIA@@@@', CallSign: 'ZGAA1@', ImoNumber: 9900019,
        Type: 37, FixType: 1, MaximumStaticDraught: 3.4, Destination: 'PALMA@@',
        Dimension: { A: 40, B: 22, C: 5, D: 6 },
        Eta: { Month: 9, Day: 4, Hour: 6, Minute: 0 }
      } }
    });
  } finally {
    window.Store = original;
  }

  const v = s.byMmsi[String(mmsi)];
  assert.strictEqual(v.fix.sog, 9.4);
  assert.strictEqual(v.fix.accurate, true);
  assert.strictEqual(v.fix.turning, 'port', 'a negative rate of turn is to port');
  assert.strictEqual(v.ais.name, 'AURELIA', 'the @ padding is stripped');
  assert.strictEqual(v.ais.callSign, 'ZGAA1');
  assert.strictEqual(v.ais.imo, 9900019);
  assert.strictEqual(v.ais.shipType, 37);
  assert.strictEqual(v.ais.loa, 62, 'length is Dimension A + B');
  assert.strictEqual(v.ais.beam, 11, 'beam is Dimension C + D');
  assert.strictEqual(v.voyage.destination, 'PALMA');
});

test('a message the decoder marked invalid is dropped', () => {
  const s = freshStore();
  const mmsi = FLEET[0].mmsi;
  const original = window.Store;
  window.Store = s;
  try {
    Ais._handle({
      MessageType: 'PositionReport',
      MetaData: { MMSI: mmsi, time_utc: new Date().toISOString() },
      Message: { PositionReport: { Valid: false, Latitude: 0, Longitude: 0 } }
    });
  } finally {
    window.Store = original;
  }
  assert.strictEqual(s.byMmsi[String(mmsi)].fix, null, 'nothing was plotted');
});

test('AIS identity is merged across messages, not replaced', () => {
  // Name and dimensions arrive in one message, IMO and call sign in another.
  // Replacing wholesale would lose half of it on every update.
  const s = freshStore();
  const mmsi = FLEET[0].mmsi;
  s.applyIdentity(mmsi, { name: 'AURELIA', loa: 62, beam: 11 });
  s.applyIdentity(mmsi, { imo: 9900019, callSign: 'ZGAA1' });
  const ais = s.byMmsi[String(mmsi)].ais;
  assert.strictEqual(ais.name, 'AURELIA', 'the earlier message survives');
  assert.strictEqual(ais.imo, 9900019);
  assert.strictEqual(ais.loa, 62);
});

test('a transponder reporting another vessel is flagged', () => {
  // The failure this exists for: an MMSI typed one digit out subscribes the
  // board to a stranger, and every other thing on screen still looks right.
  const s = freshStore();
  const y = FLEET[0];
  s.applyIdentity(y.mmsi, {
    name: 'SOMEONE ELSE', imo: 9111111, loa: 24
  });
  s.applyFix(y.mmsi, { lon: 2, lat: 39, sog: 0, at: new Date() });
  s.recompute();
  const m = s.byMmsi[String(y.mmsi)].derived.mismatches;
  const fields = m.map((x) => x.field).sort();
  assert.deepStrictEqual(fields, ['IMO', 'Length', 'Name'], 'all three disagree');
  assert.strictEqual(m.find((x) => x.field === 'Name').reported, 'SOMEONE ELSE');
});

test('the identity check does not cry wolf over AIS formatting', () => {
  // AIS is upper case, often abbreviated, and its dimensions are integer metres
  // from the antenna rather than a registry LOA. None of that is a mismatch.
  const s = freshStore();
  const y = FLEET[0];
  s.applyIdentity(y.mmsi, {
    name: 'M/Y ' + y.name.toUpperCase(),
    imo: y.imo,
    callSign: y.callSign ? y.callSign.toLowerCase() : null,
    loa: Math.round(y.loa) - 2
  });
  s.applyFix(y.mmsi, { lon: 2, lat: 39, sog: 0, at: new Date() });
  s.recompute();
  assert.deepStrictEqual(s.byMmsi[String(y.mmsi)].derived.mismatches, [],
    'no complaint about case, prefix, or a couple of metres');
});

test('set and drift is only reported when it means something', () => {
  const s = freshStore();
  const mmsi = FLEET[0].mmsi;
  const at = new Date();

  // Stationary: heading and course disagree freely and it signifies nothing.
  s.applyFix(mmsi, { lon: 2, lat: 39, sog: 0.2, cog: 90, heading: 200, at });
  s.recompute();
  assert.strictEqual(s.byMmsi[String(mmsi)].derived.setAndDrift, null, 'not at rest');

  // Underway and pointing where she is going: nothing to report.
  s.applyFix(mmsi, { lon: 2, lat: 39, sog: 10, cog: 90, heading: 88, at });
  s.recompute();
  assert.strictEqual(s.byMmsi[String(mmsi)].derived.setAndDrift, null, 'not when tracking true');

  // Crabbing: her head is 15 degrees left of her track, so she is set to starboard.
  s.applyFix(mmsi, { lon: 2, lat: 39, sog: 10, cog: 90, heading: 75, at });
  s.recompute();
  const sd = s.byMmsi[String(mmsi)].derived.setAndDrift;
  assert.strictEqual(sd.degrees, 15);
  assert.strictEqual(sd.side, 'starboard');

  // And the wrap at north is not 345 degrees of it.
  s.applyFix(mmsi, { lon: 2, lat: 39, sog: 10, cog: 5, heading: 350, at });
  s.recompute();
  assert.strictEqual(s.byMmsi[String(mmsi)].derived.setAndDrift.degrees, 15,
    'the compass wraps');
});

test('a discreet vessel reports no set and drift either', () => {
  // It is derived from heading and course, which are exact even when the
  // position shown has been blurred.
  const s = freshStore();
  const y = FLEET.find((v) => v.discreet);
  s.applyFix(y.mmsi, { lon: 2, lat: 39, sog: 10, cog: 90, heading: 70, at: new Date() });
  s.recompute();
  assert.strictEqual(s.byMmsi[String(y.mmsi)].derived.setAndDrift, null);
});

test('a record built from the form carries a demo block that can place her', () => {
  // The failure this prevents: a vessel added through the console with nothing
  // in the position fields, which then never appears on the chart and looks for
  // all the world like a vessel that was never added.
  const bare = Vessel.buildRecord({ name: 'Bare', mmsi: 319000999, imo: 9074729 });
  assert.ok(bare.demo, 'there is always a demo block');
  assert.ok(bare.demo.route || bare.demo.position || bare.demo.port,
    'and it can always place her');

  const byPort = Vessel.buildRecord({
    name: 'Ported', mmsi: 319000998, imo: 9074729, demoStatus: 'anchored', demoPort: 'Göcek'
  });
  assert.strictEqual(byPort.demo.port, 'Göcek');
  assert.strictEqual(byPort.demo.status, 'anchored');

  // An exact position wins over a port.
  const byFix = Vessel.buildRecord({
    name: 'Fixed', mmsi: 319000997, imo: 9074729,
    demoPort: 'Göcek', demoLat: 36.75, demoLon: 28.94
  });
  assert.deepStrictEqual(byFix.demo.position, [28.94, 36.75], 'stored [lon, lat]');
  assert.ok(!('port' in byFix.demo), 'and the port is not also kept');
});

test('an existing route survives an edit through the form', () => {
  // A route is more than the form can edit. Flattening it to a single point
  // because the position boxes were empty would throw away the work.
  const source = FLEET.find((y) => y.demo && y.demo.route);
  assert.ok(source, 'the sample fleet still has a routed vessel');
  const fields = Vessel.toFields(source);
  fields.name = 'Renamed';
  const rebuilt = Vessel.buildRecord(fields);
  assert.deepStrictEqual(rebuilt.demo.route, source.demo.route);
  assert.strictEqual(rebuilt.name, 'Renamed');
});

test('a record survives a round trip through the form fields', () => {
  const source = FLEET.find((y) => y.id === 'silver-meridian');
  const rebuilt = Vessel.buildRecord(Vessel.toFields(source));
  ['id', 'name', 'prefix', 'mmsi', 'imo', 'callSign', 'flag', 'flagCode',
   'loa', 'beam', 'grossTonnage', 'builder', 'yearBuilt', 'lastRefit',
   'classSociety', 'photo', 'discreet'].forEach((key) => {
    assert.deepStrictEqual(rebuilt[key], source[key], key + ' survives');
  });
  assert.deepStrictEqual(rebuilt.demo, source.demo, 'and so does the demo block');
});

test('editing a fleet.js vessel overrides it without touching the file', () => {
  const originalOverrides = Vessel.loadOverrides;
  const target = FLEET.find((y) => y.id === 'corvina');
  const edited = Vessel.buildRecord(
    Object.assign(Vessel.toFields(target), { name: 'Corvina II', loa: 41.2 })
  );
  Vessel.loadOverrides = () => ({ corvina: edited });
  try {
    const merged = Vessel.mergedFleet(FLEET);
    assert.strictEqual(merged.length, FLEET.length, 'still one record, not two');
    const out = merged.find((y) => y.id === 'corvina');
    assert.strictEqual(out.name, 'Corvina II');
    assert.strictEqual(out.loa, 41.2);
    assert.strictEqual(out.editedLocally, true, 'and it is marked as a local edit');
    // Everyone else is untouched.
    assert.strictEqual(merged.find((y) => y.id === 'aurelia').name, 'Aurelia');
  } finally {
    Vessel.loadOverrides = originalOverrides;
  }
});

test('a local edit is never written into the file as a marker', () => {
  const originalOverrides = Vessel.loadOverrides;
  const target = FLEET.find((y) => y.id === 'corvina');
  const edited = Vessel.buildRecord(
    Object.assign(Vessel.toFields(target), { name: 'Corvina II' })
  );
  Vessel.loadOverrides = () => ({ corvina: edited });
  try {
    const file = Vessel.toFleetFile(Vessel.mergedFleet(FLEET));
    assert.ok(!/editedLocally/.test(file), 'the marker stays out of the file');
    assert.ok(!/addedLocally/.test(file), 'and so does the other one');
    const sandbox = { window: {} };
    require('vm').runInNewContext(file, sandbox);
    assert.strictEqual(
      sandbox.window.FLEET.find((y) => y.id === 'corvina').name, 'Corvina II',
      'the edit is baked in');
  } finally {
    Vessel.loadOverrides = originalOverrides;
  }
});

test('a pasted entry says the same thing the written file does', () => {
  // toSnippet was written by hand and drifted from the file writer, most
  // recently over `demo` — whose absence leaves a pasted vessel unplaceable.
  const y = FLEET.find((v) => v.id === 'wind-verity');
  const snippet = Vessel.toSnippet(y);
  const fromSnippet = new Function('return [' + snippet + '][0]')();
  const sandbox = { window: {} };
  require('vm').runInNewContext(Vessel.toFleetFile([y]), sandbox);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(fromSnippet)),
    JSON.parse(JSON.stringify(sandbox.window.FLEET[0])),
    'entry and file agree field for field');
});

test('however a spreadsheet words a state, it lands on one of the four', () => {
  // Stored raw, "At anchor" reaches demo.js as a word it has never heard: the
  // status is neither honoured nor rejected, just ignored, and the vessel
  // derives whatever her speed happens to imply.
  const cases = {
    'At anchor': 'anchored', 'ANCHORED': 'anchored', 'riding to anchor': 'anchored',
    'Alongside': 'moored', 'In port': 'moored', 'berthed': 'moored', 'At the yard': 'moored',
    'Under way': 'underway', 'underway': 'underway', 'En route': 'underway',
    'steaming': 'underway', 'on passage': 'underway',
    'No signal': 'dark', 'dark': 'dark', 'unknown': 'dark',
    '': 'moored', 'nonsense': 'moored'
  };
  Object.keys(cases).forEach((input) => {
    assert.strictEqual(Vessel.normaliseStatus(input), cases[input],
      JSON.stringify(input) + ' means ' + cases[input]);
  });
  assert.strictEqual(Vessel.buildDemo({ demoStatus: 'At anchor' }).status, 'anchored',
    'and it is normalised on the way into the record');
});

test('a vessel with nowhere given still gets somewhere real', () => {
  // The fallback used CONFIG.office.label — "Palma office", which is not a port
  // in data/ports.js. So the safety net left her with no position at all, which
  // is the precise thing it exists to prevent.
  const demo = Vessel.buildDemo({ name: 'Nowhere' });
  assert.ok(demo.position, 'she is placed by position, not by a name that may not resolve');
  assert.strictEqual(demo.position.length, 2);
  close(demo.position[0], CONFIG.office.lon, 0.001, 'office longitude');
  close(demo.position[1], CONFIG.office.lat, 0.001, 'office latitude');

  // And demo mode can actually place her, which is the whole point.
  const agent = Demo._makeAgent({ yacht: { name: 'Nowhere', mmsi: 319000123, demo: demo } });
  assert.ok(agent, 'demo mode places her');
  assert.ok(agent.lon != null && agent.lat != null);
});

test('a demo vessel told she is underway actually makes way', () => {
  // The console offers "underway" as a choice, so it has to mean something. Given
  // only a point to sit on she would report zero knots and derive as alongside,
  // which is the opposite of what was asked for.
  const withPort = Demo._makeAgent({ yacht: {
    name: 'Test', mmsi: 319000001,
    demo: { status: 'underway', port: 'Bodrum', destination: 'RHODES', speed: 12 }
  } });
  assert.ok(withPort.route, 'she is given a route');
  assert.strictEqual(withPort.route.length, 2);
  const rhodes = PORTS.find((p) => p[0] === 'Rhodes');
  assert.ok(Geo.distanceNm(withPort.route[1][0], withPort.route[1][1], rhodes[2], rhodes[3]) < 1,
    'and it heads for the port she says she is bound for');

  // A destination nobody has heard of still gets her to sea rather than stuck.
  const unknown = Demo._makeAgent({ yacht: {
    name: 'Test', mmsi: 319000002,
    demo: { status: 'underway', port: 'Bodrum', destination: 'NOWHERE' }
  } });
  assert.ok(unknown.route, 'still under way');
  assert.ok(unknown.speed > 0, 'and at some speed');
  assert.ok(Geo.distanceNm(unknown.route[0][0], unknown.route[0][1],
                           unknown.route[1][0], unknown.route[1][1]) > 50,
    'headed somewhere, not in circles');

  // Alongside stays put.
  const alongside = Demo._makeAgent({ yacht: {
    name: 'Test', mmsi: 319000003, demo: { status: 'moored', port: 'Bodrum' }
  } });
  assert.ok(!alongside.route, 'a vessel alongside is not given a route');
  assert.ok(alongside.home, 'she has a berth');
});

test('every port named in a demo block exists in data/ports.js', () => {
  // A demo block naming a port that is not in the list leaves that yacht with
  // no position at all, which looks exactly like a yacht that is simply not
  // showing up. Catch the typo here instead.
  const norm = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const known = new Set(PORTS.map((p) => norm(p[0])));
  FLEET.concat(REAL_FLEET).forEach((y) => {
    if (!y.demo || !y.demo.port) return;
    assert.ok(known.has(norm(y.demo.port)),
      `${y.name}: no port named "${y.demo.port}" in data/ports.js`);
  });
});

test('a demo block that cannot place a vessel is a fault worth naming', () => {
  /**
   * A demo block that exists but says nothing usable is the bad case: the yacht
   * never reaches the chart while looking for all the world like a record that
   * simply is not there. That is a typo, and this catches it.
   *
   * No demo block at all is a different thing entirely, and fine. It is the
   * honest state for a real fleet whose positions nobody has told us — she
   * reads "Position unknown" and stays off the chart, which is true, and live
   * AIS places her the first time she is heard. This used to insist every
   * record had one, which was right while the fleet was invented placeholders
   * and became wrong the moment real boats arrived.
   */
  REAL_FLEET.concat(FLEET).forEach((y) => {
    if (!y.demo) return;
    assert.ok(y.demo.route || y.demo.position || y.demo.port,
      `${y.name}: demo block has no route, position or port`);
  });
});

test('the whole fleet is not left unplaceable without saying so', () => {
  // Opening the board with no AIS key and no demo positions gives an empty
  // chart, which reads as broken. It is a legitimate state — but only for a
  // fleet that is genuinely going to be tracked live, so the file should say
  // as much where somebody will find it.
  const placeable = REAL_FLEET.filter((y) => y.demo &&
    (y.demo.route || y.demo.position || y.demo.port));
  if (placeable.length < REAL_FLEET.length) {
    const source = readRepo('fleet.js');
    assert.ok(/Position unknown/.test(source),
      'fleet.js explains what an unplaced vessel looks like before AIS is live');
  }
});

test('the fleet file is internally consistent', () => {
  const ids = new Set(), mmsis = new Set();
  assert.ok(REAL_FLEET.length, 'fleet.js has at least one vessel in it');
  REAL_FLEET.forEach((y) => {
    assert.ok(y.id && !ids.has(y.id), 'unique id: ' + y.id);
    ids.add(y.id);
    assert.ok(/^\d{9}$/.test(String(y.mmsi)), 'MMSI is nine digits: ' + y.mmsi);
    assert.ok(!mmsis.has(y.mmsi), 'unique MMSI: ' + y.mmsi);
    mmsis.add(y.mmsi);
    // IMO and LOA are optional, and null is the honest value for a fleet whose
    // sheet did not carry them: both ride in the AIS static message and the
    // console fills them in the first time she is heard. What is not optional is
    // that a value, once present, is a real one.
    if (y.imo != null) {
      assert.ok(/^\d{7}$/.test(String(y.imo)), 'IMO is seven digits: ' + y.imo);
      assert.strictEqual(Vessel.validateImo(String(y.imo)).ok, true,
        y.name + "'s IMO " + y.imo + ' must pass the same check the add form applies');
    }
    assert.strictEqual(Vessel.validateMmsi(String(y.mmsi)).ok, true,
      y.name + "'s MMSI " + y.mmsi + ' must be a ship-station MMSI');
    if (y.loa != null) assert.ok(y.loa > 0 && y.loa < 200, 'plausible LOA: ' + y.loa);
    if (y.grossTonnage != null) {
      assert.ok(y.grossTonnage > 0 && y.grossTonnage < 50000,
        'plausible gross tonnage: ' + y.name + ' ' + y.grossTonnage);
    }
    if (y.yearBuilt != null) {
      assert.ok(y.yearBuilt > 1900 && y.yearBuilt < 2100, 'plausible year: ' + y.yearBuilt);
      if (y.lastRefit != null) {
        assert.ok(y.lastRefit >= y.yearBuilt,
          y.name + ' cannot have been refitted before she was built');
      }
    }
    // A flag that disagrees with the MMSI is worse than no flag: it is a
    // confident wrong answer on a board people read at a glance.
    if (y.flag) {
      const fromMmsi = Vessel.flagFromMmsi(y.mmsi);
      assert.ok(fromMmsi, y.name + ': MMSI ' + y.mmsi + ' has no known flag administration');
      assert.strictEqual(y.flag, fromMmsi.flag,
        y.name + ": flag says " + y.flag + ' but MMSI ' + y.mmsi + ' says ' + fromMmsi.flag);
      // And the code, which is what actually draws the ensign. Limerence
      // reflagged Cayman to Marshall Islands; a record updated in the name but
      // not the code would fly the wrong flag on the board, which is a quieter
      // wrong than silence and harder to notice.
      assert.strictEqual(y.flagCode, fromMmsi.flagCode,
        y.name + ": flag code says " + y.flagCode + ' but MMSI ' + y.mmsi +
        ' says ' + fromMmsi.flagCode);
    }
    if (y.demo && y.demo.position) {
      assert.ok(Math.abs(y.demo.position[0]) <= 180 && Math.abs(y.demo.position[1]) <= 90);
    }
    (y.demo && y.demo.route ? y.demo.route : []).forEach(([lon, lat]) => {
      assert.ok(Math.abs(lon) <= 180 && Math.abs(lat) <= 90, y.id + ' route point');
    });
  });
});

test('the port list is well formed', () => {
  assert.ok(PORTS.length > 200, 'port count ' + PORTS.length);
  PORTS.forEach((p) => {
    assert.strictEqual(p.length, 5, 'five fields: ' + p[0]);
    assert.ok(typeof p[0] === 'string' && p[0].length, 'has a name');
    assert.ok(Math.abs(p[2]) <= 180 && Math.abs(p[3]) <= 90, 'in range: ' + p[0]);
    assert.ok(p[4] === 1 || p[4] === 2, 'tier is 1 or 2: ' + p[0]);
  });
});


/* --- Vessel profiles ------------------------------------------------------ */

// profile.js draws into SVG elements. This is enough of a document for it: the
// nodes only need to remember their tag, attributes and children so the drawing
// can be read back and checked.
(function () {
  function stubNode(name) {
    return {
      tagName: name, attrs: {}, children: [],
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      appendChild(c) { this.children.push(c); return c; }
    };
  }
  global.document = { createElementNS: (ns, name) => stubNode(name) };
  require(path.join(__dirname, '..', 'js/profile.js'));
  const { Profile } = window;

  // Every coordinate pair in a path's `d`, and the corners of a rect.
  function pointsOf(node) {
    if (node.tagName === 'path') {
      const n = (node.attrs.d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      const pts = [];
      for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
      return pts;
    }
    if (node.tagName === 'rect') {
      const x = +node.attrs.x, y = +node.attrs.y;
      return [[x, y], [x + +node.attrs.width, y + +node.attrs.height]];
    }
    if (node.tagName === 'circle') {
      const cx = +node.attrs.cx, cy = +node.attrs.cy, r = +node.attrs.r;
      return [[cx - r, cy - r], [cx + r, cy + r]];
    }
    return [];
  }

  function drawing(yacht) {
    const svg = Profile.create(yacht);
    const vb = svg.getAttribute('viewBox').split(/\s+/).map(Number);
    // Everything the vessel is made of lives in the transformed group.
    const g = svg.children.find((c) => c.tagName === 'g');
    const scale = +/scale\(([\d.]+)\)/.exec(g.attrs.transform)[1];
    const shift = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(g.attrs.transform);
    const parts = {};
    g.children.forEach((c) => {
      const cls = c.attrs.class;
      (parts[cls] = parts[cls] || []).push(pointsOf(c).map(
        ([x, y]) => [+shift[1] + scale * x, +shift[2] + scale * y]
      ));
    });
    return { width: vb[2], height: vb[3], parts };
  }

  const box = (groups) => {
    const all = [].concat(...groups);
    return {
      x0: Math.min(...all.map((p) => p[0])), x1: Math.max(...all.map((p) => p[0])),
      y0: Math.min(...all.map((p) => p[1])), y1: Math.max(...all.map((p) => p[1]))
    };
  };

  test('every vessel in the fleet draws a profile that fits its frame', () => {
    // Both fleets: the sample for variety, yours because it is the one that goes
    // on the wall.
    FLEET.concat(REAL_FLEET).forEach((y) => {
      const d = drawing(y);
      assert.ok(d.height > 0, y.name + ': the frame has height');
      Object.keys(d.parts).forEach((cls) => {
        const b = box(d.parts[cls]);
        assert.ok(b.y0 >= -1, y.name + ': ' + cls + ' stays below the top edge (' + b.y0 + ')');
        assert.ok(b.y1 <= d.height + 1, y.name + ': ' + cls + ' stays above the bottom edge');
        assert.ok(b.x0 >= -1 && b.x1 <= d.width + 1, y.name + ': ' + cls + ' stays within the sides');
      });
    });
  });

  test('a motor yacht is drawn bow forward, not stern forward', () => {
    // The regression this guards: stepping the deck levels the other way puts
    // the bridge at the stern and draws the boat backwards.
    const big = FLEET.find((y) => !Profile.isSail(y) && y.loa >= 70);
    const d = drawing(big);
    const hull = box(d.parts['p-hull']);
    const house = box(d.parts['p-house']);

    assert.ok(house.x0 > hull.x0 && house.x1 < hull.x1,
      'the superstructure sits inside the hull');
    // The foredeck — hull forward of the bridge front — is longer than the
    // after deck. On a motor yacht it is the other way about only if she is
    // drawn facing the wrong way.
    const foredeck = hull.x1 - house.x1;
    const afterdeck = house.x0 - hull.x0;
    assert.ok(foredeck > afterdeck * 1.3,
      'the foredeck is the long one: fore ' + foredeck.toFixed(0) + ' vs aft ' + afterdeck.toFixed(0));
    // And the topmost level is the forward one.
    const tops = d.parts['p-house'][0];
    const highest = Math.min(...tops.map((p) => p[1]));
    const atTop = tops.filter((p) => p[1] < highest + 1).map((p) => p[0]);
    const bridge = (Math.min(...atTop) + Math.max(...atTop)) / 2;
    assert.ok(bridge > (hull.x0 + hull.x1) / 2,
      'the bridge deck sits forward of amidships');
  });

  test('a sailing yacht is drawn with a rig and a keel', () => {
    const sloop = FLEET.find((y) => Profile.isSail(y));
    assert.ok(sloop, 'the placeholder fleet still carries a sailing yacht');
    const d = drawing(sloop);
    const hull = box(d.parts['p-hull']);
    const mast = box(d.parts['p-mast']);
    const keel = box(d.parts['p-keel']);

    assert.ok(mast.y1 - mast.y0 > (hull.x1 - hull.x0) * 0.7,
      'the mast is tall against her length');
    assert.ok(mast.y0 < hull.y0, 'the masthead is above the sheer');
    assert.ok(keel.y1 > hull.y1, 'the keel hangs below the hull');
    assert.strictEqual(d.parts['p-keel'].length, 2, 'keel and rudder both drawn');
  });

  test('a drawn profile is never wider than the frame it is cut for', () => {
    // frameAspect is what the console sizes its band from; if it disagreed with
    // the viewBox the band would be the wrong shape.
    FLEET.forEach((y) => {
      const d = drawing(y);
      close(Profile.frameAspect(y), d.width / d.height, 0.001, y.name + ': frame aspect matches');
    });
  });
})();


/* --- Photo fetching ------------------------------------------------------- */

// The fixture as a fleet FILE, named the way fleet.js names it, so the tools
// that read one can be pointed at it instead of at yours.
const sampleSource = () => require('fs')
  .readFileSync(path.join(__dirname, 'fixtures', 'fleet-sample.js'), 'utf8')
  .replace('window.FLEET_SAMPLE =', 'window.FLEET =');

test('repointing a photo field changes that field and nothing else', () => {
  const { repoint, loadFleet } = require(path.join(__dirname, 'fetch-photos.js'));
  const source = sampleSource();
  const before = loadFleet(source);

  let edited = repoint(source, 'aurelia', 'assets/photos/aurelia.jpg');
  edited = repoint(edited, 'wind-verity', "assets/photos/o'brien.jpg");
  const after = loadFleet(edited);

  assert.strictEqual(after.length, before.length, 'the same fleet comes back');
  assert.strictEqual(after.find((y) => y.id === 'aurelia').photo, 'assets/photos/aurelia.jpg');
  assert.strictEqual(after.find((y) => y.id === 'wind-verity').photo, "assets/photos/o'brien.jpg",
    'an apostrophe in the filename survives');

  const strip = (f) => JSON.stringify(f.map((y) => Object.assign({}, y, { photo: null })));
  assert.strictEqual(strip(after), strip(before), 'every other field is untouched');

  // Only the two lines should differ. A whole-file rewrite would pass the check
  // above while flattening the header, which is the thing to guard against.
  const changedLines = source.split('\n')
    .filter((line, i) => line !== edited.split('\n')[i]).length;
  assert.ok(changedLines <= 2, 'the edit is two lines, not a rewrite (' + changedLines + ')');
});

test('repointing a record that has no photo field adds one', () => {
  const { repoint, loadFleet } = require(path.join(__dirname, 'fetch-photos.js'));
  const source = sampleSource();
  const stripped = source.replace(/^[ \t]*photo:[^\n]*\n/gm, '');
  assert.ok(!/photo:/.test(stripped), 'the fixture really has no photo fields');

  const after = loadFleet(repoint(stripped, 'corvina', 'assets/photos/corvina.jpg'));
  assert.strictEqual(after.find((y) => y.id === 'corvina').photo, 'assets/photos/corvina.jpg');
  assert.ok(after.every((y) => y.id === 'corvina' || y.photo === undefined),
    'no other record picked up a photo');
});

test('repointing an id that is not in the fleet refuses rather than guessing', () => {
  const { repoint } = require(path.join(__dirname, 'fetch-photos.js'));
  const source = sampleSource();
  assert.throws(() => repoint(source, 'not-a-yacht', 'x.jpg'), /no record with id/);
});

/* --- Photographs held in the browser -------------------------------------- */

(function () {
  // The shared harness gives a localStorage that throws, on purpose. These need
  // one that works, plus one that is full, so both are built here.
  const realStorage = global.localStorage;
  function fakeStorage(capacityBytes) {
    const data = {};
    return {
      getItem(k) { return k in data ? data[k] : null; },
      setItem(k, v) {
        const used = Object.keys(data).reduce(
          (n, key) => n + (key === k ? 0 : data[key].length), 0);
        if (capacityBytes != null && used + v.length > capacityBytes) {
          const e = new Error('quota');
          e.name = 'QuotaExceededError';
          throw e;
        }
        data[k] = String(v);
      },
      removeItem(k) { delete data[k]; }
    };
  }

  global.localStorage = fakeStorage();
  load('js/photos.js');
  const { Photos } = window;
  const uri = (n) => 'data:image/jpeg;base64,' + 'A'.repeat(n);

  test('a photograph is stored against the vessel and read back', () => {
    global.localStorage = fakeStorage();
    assert.strictEqual(Photos.get('aurelia'), null, 'nothing to begin with');
    assert.strictEqual(Photos.set('aurelia', uri(100)).ok, true);
    assert.ok(Photos.get('aurelia').startsWith('data:image/jpeg'));
    assert.deepStrictEqual(Photos.ids(), ['aurelia']);
    assert.strictEqual(Photos.has('aurelia'), true);
    assert.strictEqual(Photos.remove('aurelia'), true);
    assert.strictEqual(Photos.get('aurelia'), null, 'and it is gone');
    assert.strictEqual(Photos.remove('aurelia'), false, 'removing twice is not an error');
  });

  test('an uploaded photograph beats the path in the record', () => {
    global.localStorage = fakeStorage();
    const yacht = { id: 'aurelia', photo: 'assets/photos/aurelia.jpg' };
    assert.strictEqual(Photos.resolve(yacht), 'assets/photos/aurelia.jpg',
      'the record is used when nothing is uploaded');
    Photos.set('aurelia', uri(50));
    assert.ok(Photos.resolve(yacht).startsWith('data:'), 'the upload wins');
    Photos.remove('aurelia');
    assert.strictEqual(Photos.resolve(yacht), 'assets/photos/aurelia.jpg',
      'and the record is used again once it is gone');
    assert.strictEqual(Photos.resolve({ id: 'x' }), null, 'neither is null, not undefined');
  });

  test('running out of storage says so and leaves what was there alone', () => {
    // A photograph that silently failed to save is worse than one that plainly
    // refused, and browsers run out sooner than anyone expects.
    global.localStorage = fakeStorage(400);
    assert.strictEqual(Photos.set('aurelia', uri(100)).ok, true, 'the first one fits');
    const before = Photos.get('aurelia');

    const result = Photos.set('corvina', uri(5000));
    assert.strictEqual(result.ok, false, 'the second does not');
    assert.strictEqual(result.full, true, 'and it is reported as a quota problem');
    assert.strictEqual(Photos.get('corvina'), null, 'the one that failed is not half-stored');
    assert.strictEqual(Photos.get('aurelia'), before, 'and the one that fitted survives');
  });

  test('replacing a photograph that does not fit keeps the old one', () => {
    global.localStorage = fakeStorage(400);
    Photos.set('aurelia', uri(100));
    const before = Photos.get('aurelia');
    assert.strictEqual(Photos.set('aurelia', uri(5000)).ok, false);
    assert.strictEqual(Photos.get('aurelia'), before,
      'the photograph she had is still there');
  });

  test('storage that is switched off entirely is survivable', () => {
    global.localStorage = realStorage;      // the throwing one
    assert.doesNotThrow(() => Photos.load());
    assert.deepStrictEqual(Photos.load(), {});
    assert.strictEqual(Photos.get('aurelia'), null);
    const result = Photos.set('aurelia', uri(10));
    assert.strictEqual(result.ok, false);
    assert.doesNotThrow(() => Photos.usageBytes());
  });

  test('usage is reported in the size the bytes actually take', () => {
    global.localStorage = fakeStorage();
    Photos.set('aurelia', uri(4000));
    // Base64 carries 6 bits per character, so the bytes are three quarters of it.
    const expected = Math.round(('data:image/jpeg;base64,'.length + 4000) * 0.75);
    close(Photos.usageBytes(), expected, 2, 'usage');
    assert.strictEqual(Photos.formatBytes(512), '512 B');
    assert.strictEqual(Photos.formatBytes(2048), '2 KB');
    assert.strictEqual(Photos.formatBytes(3 * 1024 * 1024), '3.0 MB');
  });

  test('a filename is matched to the vessel it names', () => {
    const m = (n) => Photos.matchFilename(n, FLEET);

    // The identifier, or the name outright.
    assert.strictEqual(m('corvina.jpg').yacht.id, 'corvina');
    assert.strictEqual(m('corvina.jpg').confidence, 'sure');
    assert.strictEqual(m('Silver Meridian.JPEG').yacht.id, 'silver-meridian');
    assert.strictEqual(m('silver_meridian.png').yacht.id, 'silver-meridian');
    assert.strictEqual(m('WIND-VERITY.webp').yacht.id, 'wind-verity');

    // The name buried in whatever the photographer called the file.
    const buried = m('MY Cloudbreak sea trials 2016 (1).jpg');
    assert.strictEqual(buried, null, 'a vessel not in this fleet matches nothing');
    const loose = m('MY Sea Ember sea trials 2016 (1).jpg');
    assert.strictEqual(loose.yacht.id, 'sea-ember');
    assert.strictEqual(loose.confidence, 'likely', 'and it says it is only a guess');

    // Nine digits nobody types by accident.
    const byMmsi = m('IMG_' + FLEET[0].mmsi + '.jpg');
    assert.strictEqual(byMmsi.yacht.id, FLEET[0].id);
    assert.strictEqual(byMmsi.confidence, 'sure');
    assert.strictEqual(m('' + FLEET[2].imo + '.jpg').yacht.id, FLEET[2].id, 'IMO too');
  });

  test('filename matching does not guess when it should not', () => {
    const m = (n) => Photos.matchFilename(n, FLEET);
    assert.strictEqual(m('DSC_0481.jpg'), null, 'a camera filename matches nothing');
    assert.strictEqual(m('.jpg'), null, 'and neither does an empty one');
    assert.strictEqual(m('screenshot.png'), null);
    assert.strictEqual(Photos.matchFilename('corvina.jpg', []), null, 'nor an empty fleet');
  });

  test('the longer name wins where two could match', () => {
    // 'Sea Ember' contains no other vessel, but a fleet with both 'Sea' and
    // 'Sea Ember' must not hand a photo of the latter to the former.
    const fleet = [
      { id: 'sea', name: 'Sea', mmsi: 319000001 },
      { id: 'sea-ember', name: 'Sea Ember', mmsi: 319000002 }
    ];
    assert.strictEqual(
      Photos.matchFilename('sea ember at anchor.jpg', fleet).yacht.id, 'sea-ember');
  });

  test('the export path is the one the written file points at', () => {
    // These two must agree or the file names a photograph that was never saved.
    assert.strictEqual(Photos.exportName('silver-meridian'),
      'assets/photos/silver-meridian.jpg');
  });

  global.localStorage = realStorage;
})();

/* --- Reading a fleet out of a spreadsheet --------------------------------- */

test('the CSV parser survives what a real spreadsheet exports', () => {
  // Splitting on commas mangles exactly the rows a fleet list is full of.
  const rows = Csv.parse(
    'Name,Builder,Class\r\n' +
    'Corvina,"Feadship, Netherlands","Lloyd\'s Register"\r\n' +
    '"Sea ""Ember""",Benetti,RINA\r\n' +
    '"Wind\nVerity",Royal Huisman,BV\r\n');

  assert.strictEqual(rows.length, 4, 'header and three vessels');
  assert.deepStrictEqual(rows[1], ['Corvina', 'Feadship, Netherlands', "Lloyd's Register"],
    'a comma inside quotes is not a new column');
  assert.strictEqual(rows[2][0], 'Sea "Ember"', 'a doubled quote is one quote');
  assert.strictEqual(rows[3][0], 'Wind\nVerity', 'a newline inside quotes stays in the field');
});

test('the parser copes with the mess files arrive in', () => {
  assert.deepStrictEqual(Csv.parse('\ufeffName,MMSI\nCorvina,319000004\n')[0],
    ['Name', 'MMSI'], 'a byte-order mark from Excel is not part of the first heading');

  assert.strictEqual(Csv.parse('a,b\n\n\nc,d\n').length, 2, 'blank lines are dropped');
  assert.strictEqual(Csv.parse('a,b\r\nc,d').length, 2, 'a missing final newline is fine');
  assert.deepStrictEqual(Csv.parse(''), [], 'and so is an empty file');
  assert.deepStrictEqual(Csv.parse('  Name ,  MMSI  \n')[0], ['Name', 'MMSI'],
    'padding around a value is not part of it');
});

test('the delimiter is worked out rather than assumed', () => {
  assert.strictEqual(Csv.sniffDelimiter('Name;MMSI;IMO'), ';', 'a European export');
  assert.strictEqual(Csv.sniffDelimiter('Name\tMMSI\tIMO'), '\t', 'a pasted table');
  assert.strictEqual(Csv.sniffDelimiter('Name,MMSI,IMO'), ',');
  assert.strictEqual(Csv.sniffDelimiter('OnlyOneColumn'), ',', 'a single column is still valid');
  // A comma inside a quoted heading must not win the vote.
  assert.strictEqual(Csv.sniffDelimiter('"Builder, yard";MMSI;IMO'), ';');
  assert.deepStrictEqual(Csv.parse('Name;Builder\nCorvina;Benetti')[1], ['Corvina', 'Benetti']);
});

test('columns are matched to fields by their headings', () => {
  const mapping = Csv.mapColumns(
    ['Vessel Name', 'MMSI Number', 'IMO', 'LOA (m)', 'Year Built', 'Flag State',
     'Gross Tonnage', 'Call Sign', 'Current Port', 'Notes']);
  assert.deepStrictEqual(mapping,
    ['name', 'mmsi', 'imo', 'loa', 'yearBuilt', 'flag',
     'grossTonnage', 'callSign', 'demoPort', '']);
});

test('a heading that could be two fields goes to the right one', () => {
  // 'Year Built' must not be taken by the alias 'year', and 'Last Refit' must
  // not be taken by 'refit' before 'lastrefit' is tried.
  assert.deepStrictEqual(Csv.mapColumns(['Year Built', 'Last Refit']),
    ['yearBuilt', 'lastRefit']);
  assert.deepStrictEqual(Csv.mapColumns(['Length Overall', 'Beam']), ['loa', 'beam']);
  // A field is claimed once: the second 'Name' is left for the user to set.
  assert.deepStrictEqual(Csv.mapColumns(['Name', 'Name']), ['name', '']);
  assert.deepStrictEqual(Csv.mapColumns(['', 'MMSI']), ['', 'mmsi']);
});

test('a row becomes the fields the vessel form uses', () => {
  const header = ['Name', 'Type', 'MMSI', 'IMO', 'LOA', 'Discreet', 'Port'];
  const mapping = Csv.mapColumns(header);
  const fields = Csv.rowToFields(
    ['Wind Verity', 'sailing', '319000007', '9900071', '45.3', 'yes', 'Göcek'], mapping);

  assert.strictEqual(fields.name, 'Wind Verity');
  assert.strictEqual(fields.prefix, 'S/Y', 'a sailing yacht is read as one');
  assert.strictEqual(fields.discreet, true);
  assert.strictEqual(fields.demoPort, 'Göcek');
  assert.strictEqual(fields.loa, '45.3', 'numbers stay text; buildRecord coerces them');

  // Empty cells are absent rather than empty strings, so they do not overwrite.
  const sparse = Csv.rowToFields(['Petrel', '', '319000008', '', '', '', ''], mapping);
  assert.deepStrictEqual(Object.keys(sparse).sort(), ['mmsi', 'name']);
});

test('a spreadsheet says yes in a dozen ways', () => {
  ['yes', 'Y', 'TRUE', '1', 'x', '✓'].forEach((v) => {
    assert.strictEqual(Csv.truthy(v), true, v + ' means yes');
  });
  ['no', 'N', 'FALSE', '0', '', '-'].forEach((v) => {
    assert.strictEqual(Csv.truthy(v), false, JSON.stringify(v) + ' does not');
  });
});

test('the template asks only for what cannot be worked out', () => {
  const template = Csv.parse(Csv.template())[0];
  const exported = Csv.parse(Csv.fromFleet(FLEET, Vessel.toFields))[0];

  // Every heading it does ask for must be one the importer recognises, or
  // somebody fills in a sheet that is then ignored.
  const mapping = Csv.mapColumns(template);
  assert.strictEqual(mapping.filter((f) => f === '').length, 0,
    'no column in our own template is left unrecognised');
  assert.ok(mapping.indexOf('name') !== -1);
  assert.ok(mapping.indexOf('mmsi') !== -1);

  // And every one must exist in the export, so the round trip carries them.
  template.forEach((heading) => {
    assert.ok(exported.indexOf(heading) !== -1,
      heading + ' is in the export too');
  });

  // The point of the exercise: it is shorter, and specifically it does not ask
  // for anything derived from the MMSI or broadcast by the vessel.
  assert.ok(template.length < exported.length - 5,
    'the template is materially shorter than everything we hold');
  ['Flag', 'Flag code', 'IMO', 'Call sign', 'LOA (m)', 'Beam (m)', 'Type',
   'Bound for', 'Speed (kn)', 'ETA (hours)'].forEach((heading) => {
    assert.strictEqual(template.indexOf(heading), -1,
      heading + ' is not asked for — it is derived or broadcast');
  });
});

test('a flag falls out of the MMSI rather than being typed', () => {
  // The leading three digits are an ITU allocation, so this is a fact about the
  // number. Codes verified against the ITU MID list, not remembered.
  const cases = {
    319095800: ['KY', 'Cayman Islands'],
    538000123: ['MH', 'Marshall Islands'],
    215000001: ['MT', 'Malta'],
    254000001: ['MC', 'Monaco'],
    232000001: ['GB', 'United Kingdom'],
    271000001: ['TR', 'Turkey'],
    378000001: ['VG', 'British Virgin Islands'],
    244000001: ['NL', 'Netherlands']
  };
  Object.keys(cases).forEach((mmsi) => {
    const got = Vessel.flagFromMmsi(mmsi);
    assert.strictEqual(got.flagCode, cases[mmsi][0], mmsi + ' code');
    assert.strictEqual(got.flag, cases[mmsi][1], mmsi + ' country');
  });

  // An unknown or impossible MID leaves it blank rather than guessing.
  assert.strictEqual(Vessel.flagFromMmsi(999000000), null, 'not a ship-station MID');
  assert.strictEqual(Vessel.flagFromMmsi('31909580'), null, 'eight digits is not an MMSI');
  assert.strictEqual(Vessel.flagFromMmsi(''), null);
  assert.strictEqual(Vessel.flagFromMmsi(null), null);

  // And it reaches the record without anyone asking.
  const record = Vessel.buildRecord({ name: 'Test', mmsi: 319095800, imo: 9074729 });
  assert.strictEqual(record.flag, 'Cayman Islands');
  assert.strictEqual(record.flagCode, 'KY');

  // A flag somebody typed is not overwritten by it.
  const typed = Vessel.buildRecord({
    name: 'Test', mmsi: 319095800, imo: 9074729, flag: 'Somewhere Else'
  });
  assert.strictEqual(typed.flag, 'Somewhere Else');
});

test('autoFill fills blanks and never overwrites', () => {
  // Silently replacing a typed value would destroy the disagreement between
  // record and transponder that catches a wrong MMSI.
  const ais = { name: 'AURELIA', imo: 9900019, callSign: 'ZGAA1',
                loa: 62, beam: 11, shipType: 37 };

  const bare = { mmsi: 319095800, name: null, imo: null, callSign: null,
                 loa: null, beam: null, prefix: null };
  const filled = Vessel.autoFill(bare, ais);
  assert.deepStrictEqual(filled, {
    flag: 'Cayman Islands', flagCode: 'KY', name: 'AURELIA', imo: 9900019,
    callSign: 'ZGAA1', loa: 62, beam: 11, prefix: 'M/Y'
  });

  const complete = { mmsi: 319095800, name: 'Aurelia', imo: 9074729,
                     callSign: 'ZZZZ9', loa: 60, beam: 10, prefix: 'S/Y',
                     flag: 'Malta', flagCode: 'MT' };
  assert.deepStrictEqual(Vessel.autoFill(complete, ais), {},
    'nothing already filled in is touched');

  // A sailing vessel is read off the AIS ship type.
  assert.strictEqual(
    Vessel.autoFill({ mmsi: 319095800, prefix: null }, { shipType: 36 }).prefix, 'S/Y');
  // With no static message heard yet, the flag still comes from the MMSI.
  assert.deepStrictEqual(Vessel.autoFill({ mmsi: 254000001 }, null),
    { flag: 'Monaco', flagCode: 'MC' });
});

test('the template committed to the repo matches the one the console makes', () => {
  // Two copies of the same thing drift. This is the one that catches it.
  const onDisk = require('fs')
    .readFileSync(path.join(__dirname, '..', 'fleet-template.csv'), 'utf8');
  assert.strictEqual(onDisk, Csv.template(),
    'fleet-template.csv is stale — regenerate it from js/csv.js');
});

test('the template example refuses to be imported by accident', () => {
  // It is there to be copied, not kept. Left in, it must fail by name rather
  // than adding a yacht called EXAMPLE to somebody's fleet.
  const rows = Csv.parse(Csv.template());
  const fields = Csv.rowToFields(rows[1], Csv.mapColumns(rows[0]));
  assert.ok(/example/i.test(fields.name), 'it says what it is');

  const mmsi = Vessel.validateMmsi(fields.mmsi);
  assert.strictEqual(mmsi.ok, false, 'and its MMSI cannot be a real ship station');

  // Everything else in the row is valid, so it teaches the format correctly.
  assert.strictEqual(fields.discreet, false);
  assert.strictEqual(Vessel.normaliseStatus(fields.demoStatus), 'moored');
  assert.ok(PORTS.some((p) => p[0] === fields.demoPort),
    'and the port it names is a real one');
});

test('the fleet writes out to a spreadsheet and reads back the same', () => {
  // The round trip is the point: export, edit in Excel, drop it back.
  const text = Csv.fromFleet(FLEET, Vessel.toFields);
  const rows = Csv.parse(text);
  const mapping = Csv.mapColumns(rows[0]);

  assert.strictEqual(rows.length, FLEET.length + 1, 'a header and every vessel');
  assert.ok(text.charCodeAt(0) === 0xFEFF, 'with the mark Excel needs for Göcek');

  const rebuilt = rows.slice(1).map((row) => {
    const fields = Csv.rowToFields(row, mapping);
    return Vessel.buildRecord(Object.assign(fields, {
      mmsi: Number(fields.mmsi), imo: Number(fields.imo)
    }));
  });

  FLEET.forEach((source, i) => {
    const out = rebuilt[i];
    ['name', 'prefix', 'mmsi', 'imo', 'callSign', 'flag', 'flagCode', 'loa',
     'beam', 'grossTonnage', 'builder', 'yearBuilt', 'lastRefit', 'classSociety',
     'discreet'].forEach((key) => {
      assert.deepStrictEqual(out[key], source[key],
        source.name + ': ' + key + ' survives the round trip');
    });
  });

  // A comma and an apostrophe in the data must come back intact.
  const tricky = Csv.parse(Csv.fromFleet(
    [{ id: 'x', name: "O'Brien, Folly", mmsi: 319000001, imo: 9074729,
       builder: 'Feadship, Netherlands', demo: { status: 'moored', port: 'Göcek' } }],
    Vessel.toFields));
  assert.strictEqual(tricky[1][0], "O'Brien, Folly");
  assert.strictEqual(tricky[1][10], 'Feadship, Netherlands');
});

/* --- Chart layers ---------------------------------------------------------- */

test('the depth layers decode into the bands the renderer expects', () => {
  load('data/world-depth.js');
  load('data/world-borders.js');
  const { WORLD_DEPTH_ENCODED, WORLD_DEPTH_SCALE, WORLD_DEPTH_BANDS,
          WORLD_BORDERS_ENCODED, WORLD_BORDERS_SCALE } = window;

  const rings = Geo.decodeLand(WORLD_DEPTH_ENCODED, WORLD_DEPTH_SCALE);
  assert.strictEqual(rings.length, WORLD_DEPTH_BANDS.reduce((a, b) => a + b, 0),
    'the band counts account for every ring');
  assert.strictEqual(WORLD_DEPTH_BANDS.length, 2, '200 m and 1000 m');
  assert.ok(WORLD_DEPTH_BANDS[0] > WORLD_DEPTH_BANDS[1],
    'the shallower contour has more rings — the deep is one big expanse');

  const borders = Geo.decodeLand(WORLD_BORDERS_ENCODED, WORLD_BORDERS_SCALE);
  assert.ok(borders.length > 100, 'borders decoded');

  // No ring may step more than half the world between points: that is the
  // antimeridian bug, which paints a bar straight across the chart.
  [rings, borders].forEach((set, which) => {
    set.forEach((ring, i) => {
      for (let k = 2; k < ring.length; k += 2) {
        assert.ok(Math.abs(ring[k] - ring[k - 2]) <= 180,
          (which ? 'border' : 'depth') + ' ring ' + i + ' steps across the seam');
      }
    });
  });
});

test('the coastline ships at two levels of detail', () => {
  load('data/world-land-detail.js');
  const coarse = Geo.decodeLand(window.WORLD_LAND_ENCODED, window.WORLD_LAND_SCALE);
  const fine = Geo.decodeLand(window.WORLD_LAND_DETAIL_ENCODED, window.WORLD_LAND_DETAIL_SCALE);

  assert.ok(fine.length > coarse.length * 2,
    'the fine level resolves far more islands: ' + fine.length + ' against ' + coarse.length);

  const median = (rings) => {
    const segs = [];
    rings.forEach((r) => {
      for (let i = 2; i < r.length; i += 2) {
        const dx = (r[i] - r[i - 2]) * Math.cos(r[i + 1] * Math.PI / 180);
        segs.push(Math.hypot(dx, r[i + 1] - r[i - 1]) * 60);
      }
    });
    segs.sort((a, b) => a - b);
    return segs[Math.floor(segs.length / 2)];
  };
  // The whole point: at a quarter of a mile per pixel, a 4 nm segment is a
  // sixteen-pixel straight line and every shore is visibly faceted.
  assert.ok(median(fine) < 2, 'fine median segment is under 2 nm, got ' + median(fine).toFixed(2));
  assert.ok(median(coarse) > median(fine), 'and the coarse level is coarser');

  // Both levels must survive the seam, or a ring paints a bar across the chart.
  [coarse, fine].forEach((set, which) => {
    set.forEach((ring, i) => {
      for (let k = 2; k < ring.length; k += 2) {
        assert.ok(Math.abs(ring[k] - ring[k - 2]) <= 180,
          (which ? 'fine' : 'coarse') + ' ring ' + i + ' steps across the seam');
      }
    });
  });
});

test('every place name sits somewhere a name can go', () => {
  load('data/places.js');
  const { PLACES } = window;
  assert.ok(PLACES.length > 150, 'seas, oceans and countries');

  PLACES.forEach(([name, lon, lat, kind, size]) => {
    assert.ok(name && name.length, 'named');
    assert.ok(lon >= -180 && lon <= 180, name + ': longitude is in range, got ' + lon);
    assert.ok(lat >= -90 && lat <= 90, name + ': latitude is in range, got ' + lat);
    assert.ok(['ocean', 'sea', 'country'].indexOf(kind) !== -1, name + ': known kind');
    if (kind === 'country') assert.ok(size > 0, name + ': has a size to judge zoom by');
  });

  const seas = PLACES.filter((p) => p[3] === 'sea').map((p) => p[0]);
  ['Mediterranean Sea', 'Adriatic Sea', 'Aegean Sea', 'Caribbean Sea', 'English Channel']
    .forEach((n) => assert.ok(seas.indexOf(n) !== -1, n + ' is named'));
});

test('a great circle bends the right way and lands where it is aimed', () => {
  // Palma to New York should bow north of the rhumb line, not run straight
  // across the Mercator, and it must not fold back at the seam.
  const gc = FleetMap._greatCircle;
  const legs = gc(2.65, 39.57, -74.0, 40.7);
  close(legs[0][0], 2.65, 0.01, 'starts where told');
  close(legs[legs.length - 1][0], -74.0, 0.01, 'ends where told');
  const mid = legs[Math.floor(legs.length / 2)];
  assert.ok(mid[1] > 40.7, 'the middle of the leg is north of both ends');
  for (let i = 1; i < legs.length; i++) {
    assert.ok(Math.abs(legs[i][0] - legs[i - 1][0]) < 180, 'no fold at the seam');
  }
});

/* --- Both surfaces show the same fleet ---------------------------------- */

/**
 * The console kept additions in localStorage and merged them; the board read
 * fleet.js and nothing else. So a yacht added in the console appeared in the
 * console and never reached the board — indistinguishable, from the outside,
 * from the add having silently failed.
 *
 * These are source checks rather than behavioural ones because the wiring is
 * the thing that was wrong: both booted correctly in isolation.
 */

test('both the board and the console merge locally added vessels', () => {
  ['js/app.js', 'js/console.js'].forEach((f) => {
    assert.ok(/Vessel\.mergedFleet\(/.test(readRepo(f)),
      f + ' merges local additions rather than trusting fleet.js alone');
  });
});

test('the board loads the modules it now depends on, before it uses them', () => {
  const html = readRepo('index.html');
  const at = (f) => html.indexOf('src="' + f + '"');
  ['js/settings.js', 'js/vessel.js', 'js/app.js'].forEach((f) => {
    assert.ok(at(f) !== -1, 'index.html loads ' + f);
  });
  assert.ok(at('js/vessel.js') < at('js/app.js'), 'vessel.js is defined before app.js runs');
  assert.ok(at('js/settings.js') < at('js/app.js'), 'settings.js is defined before app.js runs');
  assert.ok(at('data/mid.js') < at('js/vessel.js'), 'vessel.js has the MID table it reads');
});

test('neither app reads the AIS key straight out of config', () => {
  // The single-file build strips the key out of config.js on purpose, so a key
  // read from there alone can never reach a published board.
  ['js/app.js', 'js/console.js', 'js/feed.js'].forEach((f) => {
    assert.ok(!/CONFIG\.aisStreamApiKey/.test(readRepo(f)),
      f + ' goes through Settings, so a key typed into the app is honoured');
  });
  // And exactly one file asks for it. The two pages used to ask separately and
  // reach different answers about whether the board was live.
  assert.ok(/Settings\.aisKey\(\)/.test(readRepo('js/feed.js')),
    'feed.js asks Settings for the key');
  ['js/app.js', 'js/console.js'].forEach((f) => {
    assert.ok(!/Settings\.aisKey\(\)/.test(readRepo(f)),
      f + ' does not decide anything about the key itself');
  });
});

/* --- The AIS key ---------------------------------------------------------- */

test('a key typed into the app wins over one baked into config', () => {
  const store = {};
  window.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  load('js/settings.js');
  const { Settings } = window;

  const configured = CONFIG.aisStreamApiKey;
  try {
    CONFIG.aisStreamApiKey = '';
    assert.strictEqual(Settings.aisKey(), '', 'no key anywhere is demo mode, not an error');
    assert.strictEqual(Settings.aisKeySource(), 'none');

    CONFIG.aisStreamApiKey = 'from-config';
    assert.strictEqual(Settings.aisKey(), 'from-config');
    assert.strictEqual(Settings.aisKeySource(), 'config');

    Settings.setAisKey('  from-the-app  ');
    assert.strictEqual(Settings.aisKey(), 'from-the-app', 'trimmed, and it overrides config');
    assert.strictEqual(Settings.aisKeySource(), 'browser');

    Settings.setAisKey('');
    assert.strictEqual(Settings.aisKey(), 'from-config', 'removing falls back, it does not blank');
  } finally {
    CONFIG.aisStreamApiKey = configured;
  }
});

test('saving a key tells whoever is running a feed', () => {
  const { Settings } = window;
  let told = 0;
  Settings.onChange(() => { told++; });
  Settings.setAisKey('a'.repeat(40));
  assert.strictEqual(told, 1, 'so the app can switch from simulated to live without a reload');
  Settings.setAisKey('');
  assert.strictEqual(told, 2, 'and back again');
});

test('a browser with site data blocked still boots', () => {
  const { Settings } = window;
  window.localStorage = {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('storage disabled'); },
    removeItem() { throw new Error('storage disabled'); }
  };
  assert.doesNotThrow(() => Settings.aisKey(), 'reading a blocked store is not fatal');
  assert.strictEqual(Settings.setAisKey('a'.repeat(40)), false, 'and it says so rather than pretending');
});

test('the published build carries no API key, offline or not', () => {
  const build = readRepo('tools/build-single-file.js');
  const blanking = build.indexOf('aisStreamApiKey: \'\'');
  const offlineBlock = build.indexOf('if (offline) {');
  assert.ok(blanking !== -1, 'the bundle blanks the key');
  assert.ok(blanking < offlineBlock,
    'and does it unconditionally — a bundle gets emailed and published, so a ' +
    'credential inside one goes wherever the file goes');
});

test('every connection state the feed can set has a label on both pages', () => {
  // A state with no entry in a label map falls through to the raw word, so the
  // board quietly shows "blocked" in lower case where it meant to explain
  // itself. Collect the states actually set, and insist both pages name them.
  const sources = ['js/ais.js', 'js/store.js', 'js/app.js', 'js/console.js']
    .map(readRepo).join('\n');
  const states = new Set(
    [...sources.matchAll(/setConnection\(([\s\S]{0,300}?)\);/g)]
      .flatMap((m) => [...m[1].matchAll(/'([a-z]+)'/g)].map((q) => q[1]))
  );
  assert.ok(states.has('blocked'), 'a socket that never opens says so');
  assert.ok(states.has('open') && states.has('retrying'), 'and the ordinary states are there');

  ['js/app.js', 'js/console.js'].forEach((f) => {
    const src = readRepo(f);
    states.forEach((state) => {
      assert.ok(new RegExp(state + ":\\s*'").test(src), f + ' labels "' + state + '"');
    });
  });
});

/* --- The socket, when it does not work ----------------------------------- */

/**
 * The retry used to hang off `onclose` alone, on the assumption — written in a
 * comment, never checked — that a close always follows an error. A socket
 * refused by Content-Security-Policy fires `error` and nothing else, so the
 * retry was never scheduled and the board sat on "Connecting" forever. These
 * drive the handlers directly, because that assumption is exactly the kind of
 * thing only a fake socket can falsify.
 */
function withFakeSocket(run) {
  const realWebSocket = global.WebSocket;
  const sockets = [];
  global.WebSocket = function () {
    this.readyState = 0;                 // CONNECTING
    this.binaryType = 'blob';            // the browser default, which is the trap
    this.sent = [];
    this.send = (m) => this.sent.push(m);
    this.close = () => { this.readyState = 3; };
    sockets.push(this);
  };
  Store.init([{ id: 'x', name: 'X', mmsi: 319000001, demo: { position: [0, 0] } }]);
  try {
    run(sockets);
  } finally {
    Ais.stop();
    global.WebSocket = realWebSocket;
  }
}

test('a socket refused outright says so at once, without waiting three times', () => {
  withFakeSocket((sockets) => {
    // Refused before a single event: CLOSED the moment the constructor returns.
    const realWebSocket = global.WebSocket;
    global.WebSocket = function () {
      this.readyState = 3;
      this.send = () => {};
      this.close = () => {};
      sockets.push(this);
    };
    Ais.start('k'.repeat(40), [319000001]);
    global.WebSocket = realWebSocket;
    assert.strictEqual(Store.connection, 'blocked',
      'policy is conclusive on the first try — there is nothing to learn from waiting');
    assert.strictEqual(Ais.attempt, 1, 'and it still schedules a retry in case it lifts');
  });
});

test('an error with no close behind it still schedules the retry', () => {
  withFakeSocket((sockets) => {
    Ais.start('k'.repeat(40), [319000001]);
    assert.strictEqual(Store.connection, 'connecting');
    assert.strictEqual(sockets.length, 1);

    sockets[0].readyState = 3;
    sockets[0].onerror(new Error('refused'));

    assert.strictEqual(Ais.attempt, 1, 'the attempt counter moved');
    assert.strictEqual(Store.connection, 'blocked', 'and it is named for what it is');
  });
});

test('one attempt produces one retry, however many events it ends with', () => {
  withFakeSocket((sockets) => {
    Ais.start('k'.repeat(40), [319000001]);
    const socket = sockets[0];
    socket.readyState = 3;
    socket.onerror(new Error('refused'));
    const after = Ais.attempt;
    // A close arriving behind the error must not start a second reconnect
    // racing the first.
    if (socket.onclose) socket.onclose({ code: 1006 });
    assert.strictEqual(Ais.attempt, after, 'the late close is a no-op');
  });
});

test('a socket that opened and then dropped is reconnecting, not blocked', () => {
  withFakeSocket((sockets) => {
    Ais.start('k'.repeat(40), [319000001]);
    const socket = sockets[0];
    socket.readyState = 1;
    socket.onopen();
    assert.strictEqual(Store.connection, 'listening',
      'the socket is up, but a rejected subscription leaves it up and silent, ' +
      'so "live" is not claimed until something actually arrives');

    const sub = JSON.parse(socket.sent[0]);
    assert.strictEqual(sub.APIKey, 'k'.repeat(40), 'the key goes up first');
    assert.strictEqual(sub.FiltersShipMMSI, undefined,
      'and nothing is narrowed at the server — see "nothing is filtered at the server"');
    assert.strictEqual(sub.FilterMessageTypes, undefined);

    socket.onmessage({ data: JSON.stringify({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 319000001, latitude: 43.7, longitude: 7.4 },
      Message: { PositionReport: { Latitude: 43.7, Longitude: 7.4, Cog: 90, Sog: 8 } }
    }) });
    assert.strictEqual(Store.connection, 'open', 'the first message is what makes it live');

    socket.onclose({ code: 1006 });
    assert.strictEqual(Store.connection, 'retrying',
      'it worked once, so a drop is a drop — never "unreachable"');
  });
});

/* --- The unattended-screen build ------------------------------------------- */

test('the display build locks the key, and only the display build', () => {
  const build = readRepo('tools/build-single-file.js');
  assert.ok(/flags\.has\('--display'\)/.test(build), 'there is a --display mode');
  assert.ok(/discreetLocked: false/.test(build) && /discreetLocked: true/.test(build),
    'which rewrites the setting rather than asking someone to remember it');
  assert.ok(/flags\.has\('--blur-all'\)/.test(build),
    'and a separate, heavier flag for a wholly approximate board');
  assert.ok(/could not find/.test(build),
    'a rewrite that silently matched nothing would ship an unlocked public board');

  // The repository default stays unlocked: the console has somebody present to
  // work the toggle, and a locked console cannot do its job.
  assert.strictEqual(CONFIG.discreetLocked, false, 'config.js itself is unlocked');
  assert.strictEqual(CONFIG.discreetMode, false, 'and shows real positions by default');
});

test('locking the key does not itself withhold anything', () => {
  // The lock used to force blanket discretion on at start-up, which made a
  // board a set of sixty-mile circles wherever it stood — most of what makes it
  // worth watching, gone. Locking now fixes whatever the build chose; what is
  // withheld is decided per yacht.
  const app = readRepo('js/app.js');
  assert.ok(!/discreetLocked\)\s*window\.CONFIG\.discreetMode = true/.test(app),
    'boot does not turn blanket discretion on just because the key is locked');
  assert.ok(/discreetLocked\) break/.test(app), 'but the key really is locked');
});

test('a yacht marked discreet is withheld on every screen, however it is configured', () => {
  const fleet = [
    { id: 'open', name: 'Open', mmsi: 319000101, demo: { position: [7.42, 43.73] } },
    { id: 'quiet', name: 'Quiet', mmsi: 319000102, discreet: true,
      demo: { position: [7.12, 43.58] } }
  ];
  const locked = CONFIG.discreetLocked;
  const mode = CONFIG.discreetMode;
  try {
    Store.init(fleet);
    Store.applyFix(319000101, { lon: 7.42, lat: 43.73, at: new Date() });
    Store.applyFix(319000102, { lon: 7.12, lat: 43.58, at: new Date() });

    // The configuration an unattended screen actually runs: key locked, blanket
    // discretion off.
    CONFIG.discreetLocked = true;
    CONFIG.discreetMode = false;
    Store.recompute();
    const [open, quiet] = Store.vessels;
    assert.strictEqual(open.derived.discreet, false, 'the ordinary yacht is shown');
    assert.ok(Math.abs(open.derived.lat - 43.73) < 0.001, 'and shown exactly');
    assert.strictEqual(quiet.derived.discreet, true, 'the marked one is not');
    assert.ok(Math.abs(quiet.derived.lat - 43.58) > 0.05,
      'her position is moved, not merely labelled — ' +
      'a rounded fix that equals the real one protects nobody');

    // And blanket mode still catches everyone, for the screen that wants it.
    CONFIG.discreetMode = true;
    Store.recompute();
    assert.strictEqual(Store.vessels[0].derived.discreet, true, 'blur-all covers the fleet');
  } finally {
    CONFIG.discreetLocked = locked;
    CONFIG.discreetMode = mode;
  }
});

test('the office is where the board actually is', () => {
  // The clock and the "from us" distances both read from this, and it spent the
  // whole build set to the placeholder demo's Palma.
  assert.strictEqual(CONFIG.office.timeZone, 'Europe/London');
  assert.ok(/Letchworth/.test(CONFIG.office.label),
    'labelled for the office it actually is, not the nearest city I offered');
  assert.ok(Math.abs(CONFIG.office.lat - 51.98) < 0.2 &&
            Math.abs(CONFIG.office.lon - -0.23) < 0.2,
    'and the coordinates agree with the label');

  // The reference office must be one of the places drawn on the chart, or the
  // board measures "from us" from somewhere it does not show.
  var hq = CONFIG.sites.filter(function (s) { return s.kind === 'hq'; });
  assert.ok(hq.length >= 2, 'both headquarters are on the chart');
  assert.ok(hq.some(function (s) {
    return Math.abs(s.lat - CONFIG.office.lat) < 0.05 &&
           Math.abs(s.lon - CONFIG.office.lon) < 0.05;
  }), 'and the one distances are measured from is among them');
});

test('a board showing approximate positions says so', () => {
  // A 60 nm circle with no label is worse than no circle: read as a fix, it is
  // wrong by up to sixty miles and gives the reader no way to know.
  const app = readRepo('js/app.js');
  assert.ok(/function renderDiscreetFlag/.test(app), 'one place renders the flag');
  assert.ok(/renderDiscreetFlag\(\);[\s\S]{0,80}buildScenes\(\)/.test(app),
    'and it runs at boot, not only when someone presses D');
  assert.ok(/discreetLocked \? 'Approximate positions'/.test(app),
    'the locked build names what the reader is looking at');
  assert.ok(!/discreet-flag'\)\.textContent = window\.CONFIG\.discreetMode \?/.test(app),
    'the D key goes through the same function, so the two cannot disagree');
});

test('an unlocked board still withholds the yachts that are marked', () => {
  // The whole point of the per-yacht flag is that it is not a toggle. A build
  // with the D key working is the one where that is easiest to get wrong.
  const fleet = [
    { id: 'quiet', name: 'Quiet', mmsi: 319000102, discreet: true,
      demo: { position: [7.12, 43.58] } }
  ];
  const locked = CONFIG.discreetLocked;
  const mode = CONFIG.discreetMode;
  try {
    Store.init(fleet);
    Store.applyFix(319000102, { lon: 7.12, lat: 43.58, at: new Date() });
    CONFIG.discreetLocked = false;     // the D key works
    CONFIG.discreetMode = false;       // and nobody has pressed it
    Store.recompute();
    const d = Store.vessels[0].derived;
    assert.strictEqual(d.discreet, true,
      'marked means withheld, with no key pressed and no lock in force');
    assert.ok(Math.abs(d.lat - 43.58) > 0.05, 'and the position she publishes has moved');
    assert.ok(/if \(d\.discreet\) return;/.test(readRepo('js/map.js')),
      'her track is not drawn either — a track is a position over time');
  } finally {
    CONFIG.discreetLocked = locked;
    CONFIG.discreetMode = mode;
  }
});

/* --- The summary view tells the truth about a sparse fleet ---------------- */

test('the console counts every vessel too, not just the board', () => {
  // The same fault lived in three more places on the desk tool: the rail
  // filter chips, the overview tiles, and the count beside each chip.
  const source = readRepo('js/console.js');
  assert.ok(/var STATE_BUCKETS = \{/.test(source),
    'one place decides which statuses a label covers');
  assert.ok(/dark: \['dark', 'unknown'\]/.test(source),
    'and a vessel never heard from is counted somewhere');
  assert.ok(!/return v\.derived\.status === filter;/.test(source),
    'the filter goes through the buckets rather than matching a status by name');
  assert.ok(!/'fix ' \+ window\.Fmt\.age\(v\.fix && v\.fix\.at\)/.test(source),
    'and a vessel with no fix does not read "fix no fix"');
});

test('the four tiles account for every vessel', () => {
  // A fleet waiting on its first AIS fix showed "1 of 61" across four tiles,
  // with sixty vessels in none of them, in front of people who can count.
  Store.init(REAL_FLEET);
  const counts = Store.summary().counts;

  const source = readRepo('js/views.js');
  const block = source.slice(source.indexOf('var STAT_STATES'),
                             source.indexOf(']', source.indexOf('[\'dark\'')) + 3);
  const named = new Set([...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1]));

  Object.keys(counts).forEach((state) => {
    assert.ok(named.has(state),
      'status "' + state + '" is counted by the store but shown by no tile');
  });

  const shown = Object.keys(counts).reduce((sum, k) => sum + counts[k], 0);
  assert.strictEqual(shown, Store.vessels.length,
    'every vessel lands in exactly one of the states the tiles cover');
});

test('an aggregate says how many vessels it was drawn from', () => {
  // "Fleet length 72 m, 61 vessels" was a confidently wrong number rather than
  // a missing one, and nobody looking at a wall could tell it from a true one.
  const source = readRepo('js/views.js');
  assert.ok(!/sum \+ \(v\.yacht\.loa \|\| 0\)/.test(source),
    'a missing length is not counted as a length of zero');
  assert.ok(/from ' \+ stat\.count \+ ' of ' \+ vessels\.length/.test(source),
    'and the figure carries the count it was drawn from');

  // The fleet this was found on: one length on file out of sixty-one.
  const withLoa = REAL_FLEET.filter((y) => typeof y.loa === 'number');
  assert.ok(withLoa.length < REAL_FLEET.length,
    'the real fleet is still sparse here, so the check is still live');
});

/* --- Saying why nothing is arriving --------------------------------------- */

test('a server complaint is surfaced, not swallowed', () => {
  // The handler switched on MessageType and dropped everything it did not
  // recognise, which included the server's own error replies. A rejected
  // subscription then looked exactly like a working one nobody had sailed past:
  // socket open, pill green, silence.
  withFakeSocket((sockets) => {
    Ais.start('k'.repeat(40), [319000001]);
    const socket = sockets[0];
    socket.readyState = 1;
    socket.onopen();
    socket.onmessage({ data: JSON.stringify({ error: 'Invalid API key' }) });
    assert.strictEqual(Store.connection, 'rejected', 'the state says it was refused');
    assert.strictEqual(Ais.lastError, 'Invalid API key', 'and keeps what was said');
  });
});

test('an AIS body called Message is not mistaken for a complaint', () => {
  // Every AIS payload has a `Message` key. Only a string one is prose.
  withFakeSocket((sockets) => {
    Ais.start('k'.repeat(40), [319000001]);
    const socket = sockets[0];
    socket.readyState = 1;
    socket.onopen();
    socket.onmessage({ data: JSON.stringify({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 319000001 },
      Message: { PositionReport: { Latitude: 43.7, Longitude: 7.4 } }
    }) });
    assert.strictEqual(Store.connection, 'open', 'a real message makes it live');
    assert.strictEqual(Ais.lastError, null, 'and is not read as an error');
  });
});

test('heard and matched are counted apart', () => {
  // A green pill cannot distinguish "the feed is dead" from "the feed works and
  // our boats are quiet". These two numbers can.
  withFakeSocket((sockets) => {
    Ais.start('k'.repeat(40), [319000001]);
    const socket = sockets[0];
    socket.readyState = 1;
    socket.onopen();
    const message = (mmsi) => socket.onmessage({ data: JSON.stringify({
      MessageType: 'PositionReport',
      MetaData: { MMSI: mmsi },
      Message: { PositionReport: { Latitude: 43.7, Longitude: 7.4 } }
    }) });
    message(319000001);
    message(244123456);
    message(244123457);
    assert.strictEqual(Ais.heard, 3, 'every message counts as heard');
    assert.strictEqual(Ais.matched, 1, 'only ours count as matched');
  });
});

test('nothing is filtered at the server', () => {
  /**
   * Both server-side filters cost us most of the fleet, and each took a
   * different kind of evidence to see.
   *
   * FilterMessageTypes named the five types this code understands. A probe
   * sending the same sixty-one MMSIs without it heard nine vessels the board
   * had never heard in a day — same key, same box, three minutes.
   *
   * FiltersShipMMSI took a full day of real running: thirty-one of sixty-one,
   * holding steady, while a second provider had every one of the silent ones
   * reporting within minutes. The same key unfiltered floods.
   *
   * The fleet is picked out in handle() instead, where it can be watched.
   */
  withFakeSocket((sockets) => {
    Ais.start('k'.repeat(40), [319000001]);
    const socket = sockets[0];
    socket.readyState = 1;
    socket.onopen();
    const sub = JSON.parse(socket.sent[0]);
    assert.strictEqual(sub.FilterMessageTypes, undefined,
      'every message type the server has');
    assert.strictEqual(sub.FiltersShipMMSI, undefined,
      'and every vessel, not only ours');
  });
});

test('a message for a vessel that is not ours is counted and dropped', () => {
  /**
   * The whole world now arrives, so this is the gate that used to be the
   * server's. It has to let ours through, drop everyone else's, and still
   * count the traffic — "heard" against "matched" is what tells you the feed is
   * alive while the fleet is quiet.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  const before = { heard: s.heard, matched: s.matched };
  try {
    const fix = (mmsi) => Ais._handle({
      MessageType: 'PositionReport',
      MetaData: { MMSI: mmsi, time_utc: new Date().toISOString() },
      Message: { PositionReport: {
        Valid: true, Latitude: 39.5, Longitude: 2.6, Cog: 91.2, Sog: 9.4
      } }
    });
    fix(FLEET[0].mmsi);
    fix('999999999');                 // a container ship off Rotterdam
    fix('123456789');
  } finally {
    window.Store = original;
  }

  assert.strictEqual(s.heard - before.heard, 3, 'all three counted as heard');
  assert.strictEqual(s.matched - before.matched, 1, 'one of them ours');
  assert.ok(s.byMmsi[String(FLEET[0].mmsi)].fix, 'ours got her fix');
  assert.strictEqual(s.byMmsi['999999999'], undefined,
    'and nobody else left a trace — at world rate that would be a leak');
});

test('the fleet gate reads the store, not a copy of the fleet', () => {
  /**
   * A second list of our own MMSIs kept in ais.js is a second thing to keep in
   * step with a fleet edited in the console, and an empty one would silence the
   * whole board while the pill stayed green. Store.byMmsi is what applyFix
   * consults anyway.
   */
  const source = readRepo('js/ais.js');
  const handle = source.slice(source.indexOf('function handle('),
                              source.indexOf('function handle(') + 2000);
  assert.ok(/window\.Store\.byMmsi\[mmsi\]/.test(handle),
    'the gate is the store\'s own map');
  assert.ok(!/Ais\.mine/.test(source), 'and there is no second copy of it');
});

test('a message type we do not handle is ignored, not fatal', () => {
  // Which is what makes dropping the server-side type filter safe.
  withFakeSocket((sockets) => {
    Ais.start('k'.repeat(40), [319000001]);
    const socket = sockets[0];
    socket.readyState = 1;
    socket.onopen();
    assert.doesNotThrow(() => socket.onmessage({ data: JSON.stringify({
      MessageType: 'AidsToNavigationReport',
      MetaData: { MMSI: 319000001 },
      Message: { AidsToNavigationReport: { Name: 'BUOY' } }
    }) }));
    assert.strictEqual(Ais.heard, 1, 'it still counts as heard');
    assert.strictEqual(Store.byMmsi['319000001'].fix, null, 'and moves nothing');
  });
});

test('the subscription matches the published schema', () => {
  // Field names checked against aisstream/ais-message-models, not recalled:
  // APIKey, BoundingBoxes, and the optional FiltersShipMMSI (strings, nine
  // characters) which is deliberately not sent — see the check above.
  withFakeSocket((sockets) => {
    Ais.start('k'.repeat(40), [319000001, 232012345]);
    const socket = sockets[0];
    socket.readyState = 1;
    socket.onopen();
    const sub = JSON.parse(socket.sent[0]);
    assert.deepStrictEqual(Object.keys(sub).sort(), ['APIKey', 'BoundingBoxes']);
  });
});

test('the MMSI filter can be put back, and goes up in the shape the schema wants', () => {
  // Kept working rather than deleted: on a metered connection, hearing half the
  // fleet cheaply may one day be the lesser problem. Nine-character strings, as
  // the published model requires — a number or a short string is rejected.
  const original = CONFIG.ais.filterAtServer;
  CONFIG.ais.filterAtServer = true;
  try {
    withFakeSocket((sockets) => {
      Ais.start('k'.repeat(40), [319000001, 232012345]);
      const socket = sockets[0];
      socket.readyState = 1;
      socket.onopen();
      const sub = JSON.parse(socket.sent[0]);
      assert.deepStrictEqual(Object.keys(sub).sort(),
        ['APIKey', 'BoundingBoxes', 'FiltersShipMMSI']);
      sub.FiltersShipMMSI.forEach((m) => {
        assert.strictEqual(typeof m, 'string', 'MMSIs go up as strings');
        assert.strictEqual(m.length, 9, 'nine characters, as the schema requires');
      });
    });
  } finally {
    CONFIG.ais.filterAtServer = original;
  }
});

test('the probe log is drawn from live state, never accumulated', () => {
  /**
   * The log wrote one line per probe at the moment that probe STARTED — before
   * its socket had opened — and only refreshed it when a message arrived. With
   * no messages nothing ever refreshed it, so every line read "never opened"
   * while the verdict, computed from the real final state, said the connection
   * had opened and been cut. The report contradicted itself and the half that
   * looked most like evidence was the stale half.
   */
  const source = readRepo('js/settings.js');
  assert.ok(/step\.results\.map\(/.test(source),
    'every line is redrawn from the results array on each callback');
  assert.ok(!/lines\[step\.index\] =/.test(source),
    'no line is written once and left to go stale');
  assert.ok(/Subscription sent \(key masked\)/.test(source),
    'and the report shows what was actually sent, with the credential masked');

  const ais = readRepo('js/ais.js');
  assert.ok(/apiKey\.slice\(0, 4\)/.test(ais),
    'the key is masked where it is echoed — a diagnostic gets pasted to support');
});

test('the probe records the socket lifecycle, not only the message count', () => {
  /**
   * The first version recorded `heard` and `error` alone, which collapsed three
   * different answers into one — a socket that never opened, one the server
   * accepted and closed on the spot, and one that stayed open and silent — and
   * then blamed the key, which is right for at most one of them. Your own fleet
   * hit exactly that case.
   */
  const source = readRepo('js/ais.js');
  assert.ok(/result\.opened = true;/.test(source), 'it records whether the socket opened');
  assert.ok(/code: event && event\.code/.test(source),
    'and the close code, which is the server explaining why it hung up');
  assert.ok(/result\.seconds = /.test(source),
    'and how long it lasted, which separates a hang-up from a silence');

  // Order matters: a socket that never opened cannot have been answered.
  const verdicts = source.slice(source.indexOf('function finish()'));
  assert.ok(verdicts.indexOf('if (never)') < verdicts.indexOf('rejected.error'),
    'an unreachable server is not reported as a rejected key');
  assert.ok(/result\.failed = true;/.test(source),
    'a transport failure is kept apart from anything the server actually said');
});

test('the probe covers each cause a green pill cannot tell apart', () => {
  // Exercised end to end against a stand-in server in each mode; this holds the
  // shape of the thing so a future edit cannot quietly drop a case.
  const source = readRepo('js/ais.js');
  assert.ok(/FiltersShipMMSI = list/.test(source), 'one probe filters to our fleet');
  assert.ok(/\[\[\[-90, -180\], \[90, 180\]\]\]/.test(source) &&
            /\[\[\[-180, -90\], \[180, 90\]\]\]/.test(source),
    'and one tries each reading of the bounding box, because the published ' +
    'examples disagree about the axis order');
  assert.ok(/results\[1\]\.matched > 0/.test(source),
    'a broken filter is only claimed when an unfiltered probe heard one of ours — ' +
    'otherwise a quiet fleet gets blamed on the filter');
});

test('every build says which build it is', () => {
  /**
   * A diagnostic report pasted back is worth nothing if nobody can tell which
   * build produced it: a stale report reads exactly like a current one and sends
   * everybody after a cause that was fixed two commits ago. That happened.
   */
  const build = readRepo('tools/build-single-file.js');
  assert.ok(/buildStamp: ''/.test(build) && /rev-parse --short HEAD/.test(build),
    'the bundler stamps the date and the commit it built from');
  assert.strictEqual(CONFIG.buildStamp, '',
    'and config.js itself carries no stamp, so a folder run says so honestly');

  const settings = readRepo('js/settings.js');
  assert.ok(/function buildLabel/.test(settings), 'the app can name its own build');
  assert.ok(/log\.textContent = buildLabel\(\)/.test(settings),
    'and every diagnostic report opens with it');
  assert.ok(/Running from a folder, not a build/.test(settings),
    'an unstamped run is named as such rather than left blank');
});

test('what is stored is shown, so a key that is not a key cannot hide', () => {
  /**
   * A diagnostic report got pasted into the key box, forced past the shape
   * warning, and stored. The sheet then said "a key is stored and the board is
   * tracking live" — behind a password field, where nothing could be seen — and
   * the resulting 1006 was read as a firewall for two rounds. The masked echo in
   * the probe output is what finally caught it.
   */
  const store = {};
  window.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  const { Settings } = window;
  const configured = CONFIG.aisStreamApiKey;
  try {
    CONFIG.aisStreamApiKey = '';

    Settings.setAisKey('');
    assert.strictEqual(Settings.maskedKey(), '', 'nothing stored shows nothing');

    const real = 'b2326793e280437b5c3987d84554e7dac1c896e2';
    Settings.setAisKey(real);
    assert.strictEqual(Settings.aisKeyLooksRight(), true, '40 hex characters is the shape');
    const masked = Settings.maskedKey();
    assert.ok(masked.indexOf('b232') === 0, 'enough to recognise your own key');
    assert.ok(masked.indexOf('96e2') !== -1, 'from both ends');
    assert.ok(masked.indexOf(real) === -1, 'and never the whole thing');
    assert.ok(/40 characters/.test(masked), 'with the length, which is what gives a paste away');

    // The actual mishap.
    Settings.setAisKey('1/3  your fleet, as the board subscribes — on your account.');
    assert.strictEqual(Settings.aisKeyLooksRight(), false,
      'a pasted report is not mistaken for a key');
    assert.ok(/characters/.test(Settings.maskedKey()),
      'and its length is on show, which is how you notice');
  } finally {
    CONFIG.aisStreamApiKey = configured;
    Settings.setAisKey('');
  }
});

test('a standalone key check exists that shares no code with the board', () => {
  // When the board and the diagnostic are both suspects, a page with none of
  // either in it is the only thing that settles the question.
  const page = readRepo('tools/ais-check.html');
  assert.ok(/wss:\/\/stream\.aisstream\.io\/v0\/stream/.test(page), 'it talks to the real endpoint');
  assert.ok(/APIKey: key, BoundingBoxes: \[\[\[-90, -180\], \[90, 180\]\]\]/.test(page),
    "and sends the subscription in aisstream's own published shape");
  ['FleetMap', 'Store.', 'window.Ais', 'Settings.'].forEach((symbol) => {
    assert.ok(page.indexOf(symbol) === -1, 'no ' + symbol + ' — it shares nothing with the app');
  });
  assert.ok(/event\.code/.test(page), 'and reports the close code, which is the finding');
});

/* --- Binary frames -------------------------------------------------------- */

test('a binary frame is decoded, not dropped', () => {
  /**
   * AISstream sends BINARY frames. A browser hands those to onmessage as a
   * Blob, `JSON.parse(aBlob)` stringifies it to "[object Blob]" and throws, and
   * the handler caught that and returned. So every message the server sent was
   * dropped, silently, for the whole life of the feed: socket open, subscription
   * accepted, thousands of frames arriving, board empty, and a diagnostic that
   * reported "0 heard" because it counted only the frames that parsed.
   */
  withFakeSocket((sockets) => {
    Ais.start('k'.repeat(40), [319000001]);
    const socket = sockets[0];
    assert.strictEqual(socket.binaryType, 'arraybuffer',
      'the socket asks for something it can decode synchronously');

    socket.readyState = 1;
    socket.onopen();

    const frame = (obj) => {
      const text = JSON.stringify(obj);
      const bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
      return bytes.buffer;
    };

    socket.onmessage({ data: frame({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 319000001 },
      Message: { PositionReport: { Latitude: 43.7, Longitude: 7.4, Cog: 90, Sog: 8 } }
    }) });

    const v = Store.byMmsi['319000001'];
    assert.ok(v && v.fix, 'the fix landed');
    assert.ok(Math.abs(v.fix.lat - 43.7) < 0.001, 'at the position in the frame');
    assert.strictEqual(Store.connection, 'open', 'and the feed counts as live');
    assert.strictEqual(Ais.unreadable, 0, 'nothing was undecodable');
  });
});

test('a frame that cannot be read still counts as a frame that arrived', () => {
  // The difference between "nothing is coming" and "plenty is coming and we
  // cannot read it" is the whole diagnosis, and the first version of this
  // counted only what it understood.
  withFakeSocket((sockets) => {
    Ais.start('k'.repeat(40), [319000001]);
    const socket = sockets[0];
    socket.readyState = 1;
    socket.onopen();
    socket.onmessage({ data: 'not json at all' });
    socket.onmessage({ data: '{"also":"not an ais message"}' });
    assert.strictEqual(Ais.heard, 2, 'both frames counted as heard');
    assert.strictEqual(Ais.unreadable, 1, 'the unparseable one counted as unreadable');
  });
});

test('a text frame still works, because nothing promises binary forever', () => {
  withFakeSocket((sockets) => {
    Ais.start('k'.repeat(40), [319000001]);
    const socket = sockets[0];
    socket.readyState = 1;
    socket.onopen();
    socket.onmessage({ data: JSON.stringify({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 319000001 },
      Message: { PositionReport: { Latitude: 40.1, Longitude: 3.2 } }
    }) });
    assert.ok(Math.abs(Store.byMmsi['319000001'].fix.lat - 40.1) < 0.001);
  });
});

test('a feed of frames none of which can be read is named as such', () => {
  const source = readRepo('js/ais.js');
  assert.ok(/r\.unreadable === r\.heard/.test(source),
    'the probe recognises "plenty arriving, none readable"');
  assert.ok(/decoding fault at this end/.test(source),
    'and says whose fault that is, rather than sending anyone back to the key');
  assert.ok(/binaryType = 'arraybuffer'/.test(source), 'both sockets ask for bytes');
  assert.ok(readRepo('tools/ais-check.html').indexOf('TextDecoder') !== -1,
    'and the standalone page decodes them too, rather than printing [object Blob]');
});

/* --- How the feed is doing, as against where the fleet is ----------------- */

test('a duration is said forwards, an age backwards', () => {
  const now = new Date('2026-09-01T12:00:00Z');
  const ago = (mins) => new Date(now - mins * 60000);
  assert.strictEqual(Fmt.duration(ago(0.5), now), 'under a minute',
    '"just now" is right for a fix and wrong for a span — it read "in just now"');
  assert.strictEqual(Fmt.duration(ago(1), now), '1 minute');
  assert.strictEqual(Fmt.duration(ago(40), now), '40 minutes');
  assert.strictEqual(Fmt.duration(ago(90), now), '2 hours');
  assert.strictEqual(Fmt.age(ago(0.5), now), 'just now', 'age is unchanged');
});

test('reception counts vessels heard from, not vessels placed', () => {
  /**
   * "5 of 61" means one thing four minutes in and another after an hour, and
   * nothing distinguished them. A yacht alongside broadcasts every three
   * minutes, so a fleet assembles over minutes; what is missing after ten is
   * out of range or switched off, not late.
   */
  Store.init([
    { id: 'a', name: 'A', mmsi: 319000101, demo: { position: [7, 43] } },
    { id: 'b', name: 'B', mmsi: 319000102, demo: { position: [7, 43] } },
    { id: 'c', name: 'C', mmsi: 319000103, demo: { position: [7, 43] } }
  ]);
  Store.feedStartedAt = new Date();

  let r = Store.reception();
  assert.deepStrictEqual([r.heard, r.waiting, r.total], [0, 3, 3], 'nothing heard yet');
  assert.strictEqual(r.settling, true, 'and it has had no time');

  Store.applyFix(319000101, { lon: 7, lat: 43, at: new Date() });
  r = Store.reception();
  assert.deepStrictEqual([r.heard, r.waiting], [1, 2], 'one heard');

  // A static message with no position is still being heard from.
  Store.applyIdentity(319000102, { name: 'B' });
  r = Store.reception();
  assert.deepStrictEqual([r.heard, r.waiting], [2, 1],
    'a name arriving counts, even with no fix behind it');

  // Long enough that silence is a fact about the vessel, not about waiting.
  Store.feedStartedAt = new Date(Date.now() - 20 * 60000);
  assert.strictEqual(Store.reception().settling, false);
});

test('the coverage test compares like with like, in one run', () => {
  /**
   * The first version trusted the caller's list of silent vessels and compared a
   * short filter against nothing, so a server honouring its filter perfectly
   * well still got blamed for the list length. The control — the full fleet
   * list, same window, same conditions — is what makes the comparison mean
   * anything.
   *
   * Exercised end to end against three stand-in servers: one silently
   * truncating a long filter, one honouring it, and one where the world is busy
   * but none of it is ours. Three distinct verdicts.
   */
  const source = readRepo('js/ais.js');
  assert.ok(/the full fleet list, exactly as the board subscribes/.test(source),
    'the control probe subscribes exactly as the board does');
  assert.ok(/materiallyMore\(n\(shortRun\), n\(full\)\)/.test(source),
    'and the list-length verdict is a comparison against it, not an assumption');
  assert.ok(/step\(i \+ 1\);          \/\/ every probe runs; nothing stops early/.test(source),
    'every probe runs — the point here is the comparison, so an early exit answers nothing');
  assert.ok(/n\(full\) > 0/.test(source),
    'a fleet that has simply started reporting is named as such, not as a fault');
  assert.ok(/COVERAGE_SECONDS = 180/.test(source),
    'each stage listens for three minutes, because that is how often a moored yacht speaks');
});

/* --- Anonymity: a different protection from discretion --------------------- */

test('anonymous mode withholds the name, which discreet mode never did', () => {
  /**
   * Discreet mode blurs POSITIONS. It turns out to protect the wrong thing: a
   * position is public, broadcast in clear by the vessel herself, while the
   * association between the fleet and this company is not. A board in full
   * discreet mode still listed all sixty-one by name down the rail — the client
   * list, on a wall, in reception.
   */
  const yacht = { name: 'Cloudbreak', loa: 72.25, mmsi: 319095800, imo: 1012763,
                  builder: 'Abeking & Rasmussen', yearBuilt: 2016 };
  const named = CONFIG.anonymousMode;
  try {
    CONFIG.anonymousMode = false;
    assert.strictEqual(Vessel.publicName(yacht, 14), 'Cloudbreak', 'named by default');
    assert.strictEqual(Vessel.showsIdentity(), true);

    CONFIG.anonymousMode = true;
    const label = Vessel.publicName(yacht, 14);
    assert.ok(label.indexOf('Cloudbreak') === -1, 'the name is gone');
    assert.ok(/Vessel 15/.test(label), 'numbered from her place in the fleet, one-based');
    assert.ok(/72 m/.test(label),
      'and her size stays — size is the point of showing the fleet at all');
    assert.strictEqual(Vessel.showsIdentity(), false);
  } finally {
    CONFIG.anonymousMode = named;
  }
});

test('the fields that name a yacht to anyone in the trade are withheld too', () => {
  // A 2016 Abeking & Rasmussen of 72 metres has exactly one answer, so hiding
  // the name alone would be theatre.
  ['name', 'mmsi', 'imo', 'callSign', 'builder', 'yearBuilt', 'lastRefit', 'photo']
    .forEach((field) => {
      assert.strictEqual(Vessel.isIdentifying(field), true, field + ' identifies her');
    });
  ['loa', 'beam', 'grossTonnage', 'flag'].forEach((field) => {
    assert.strictEqual(Vessel.isIdentifying(field), false,
      field + ' is shape, not identity — it is what a prospect is being shown');
  });
});

test('every surface that shows a name goes through publicName', () => {
  // One missed call site is the whole protection gone, and it would be the one
  // nobody looks at.
  ['js/map.js', 'js/views.js'].forEach((f) => {
    const source = readRepo(f);
    const raw = source.match(/yacht\.name|\by\.name\b/g) || [];
    raw.forEach(() => {});
    assert.ok(!/h\('span', 'name', v\.yacht\.name\)/.test(source), f + ': rail name is gated');
    assert.ok(!/var name = v\.yacht\.name;/.test(source), f + ': map label is gated');
  });
  assert.ok(/Vessel\.publicName/.test(readRepo('js/map.js')), 'map.js asks for the public name');
  assert.ok(/Vessel\.publicName/.test(readRepo('js/views.js')), 'views.js asks for it');
  assert.ok(/Vessel\.showsIdentity\(\) \? window\.Photos\.resolve/.test(readRepo('js/views.js')),
    'a photograph is a name, so it is gated too');
});

test('the anonymous build locks the key as well as setting the mode', () => {
  const build = readRepo('tools/build-single-file.js');
  assert.ok(/anonymousMode: false/.test(build) && /anonymousLocked: false/.test(build),
    '--anonymous sets both');
  assert.strictEqual(CONFIG.anonymousMode, false, 'and the repository default is named');
  assert.strictEqual(CONFIG.anonymousLocked, false);
  assert.ok(/anonymousLocked\) break/.test(readRepo('js/app.js')),
    'a locked screen is not argued out of it at the keyboard, mid-conversation');
});

test('the message count and the feed duration share a clock', () => {
  /**
   * The socket's counters reset on every reconnect. The duration does not. So
   * the panel put "4 messages received" in the same sentence as "21 hours" and
   * read as a feed that had all but stopped — when it had simply reconnected a
   * minute earlier.
   */
  const settings = readRepo('js/settings.js');
  assert.ok(/var heard = store\.heard/.test(settings),
    'the panel counts from the store, which starts when the feed does');
  assert.ok(!/var heard = ais\.heard/.test(settings), 'not from the socket, which restarts');

  const ais = readRepo('js/ais.js');
  assert.ok(/window\.Store\.heard\+\+/.test(ais), 'the store is fed every frame');
  assert.ok(/window\.Store\.matched\+\+/.test(ais), 'and every frame of ours');

  // Both still exist: per-connection counts are what the probe needs.
  assert.ok(/Ais\.heard\+\+/.test(ais), 'the socket keeps its own, for a single run');
});

/* --- An invented position must never outlive the simulation ---------------- */

test('a demo position is never cached, and never restored into a live board', () => {
  /**
   * persist() ran every thirty seconds whatever the mode, wrote invented
   * positions into the same cache as real ones, and recorded nothing about which
   * was which. A board that had run in demo mode before the key went in restored
   * those on its next load and drew them exactly like fixes. For a vessel the
   * live feed never delivers, an invented position would sit on the chart
   * indefinitely — wrong by hundreds of miles, and indistinguishable from truth.
   *
   * A missing yacht is a fact. A yacht in the wrong place is a lie.
   */
  const store = {};
  // store.js reaches for the bare global, not window's copy.
  const realStorage = global.localStorage;
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  const realMode = Store.mode;
  const fleet = [{ id: 'a', name: 'A', mmsi: 319000101, demo: { position: [7, 43] } }];
  const KEY = 'fleetwatch.positions.v1';
  try {

  // Demo mode: a fix exists, and nothing is written.
  Store.mode = 'demo';
  Store.init(fleet);
  Store.applyFix(319000101, { lon: 2.1, lat: 41.4, at: new Date() });
  Store.persist();
  assert.strictEqual(store[KEY], undefined, 'a simulation leaves no cache behind');

  // Live mode: written, and marked as real.
  Store.mode = 'live';
  Store.init(fleet);
  Store.applyFix(319000101, { lon: 7.42, lat: 43.73, at: new Date() });
  Store.persist();
  assert.ok(store[KEY], 'a live board does cache');
  assert.strictEqual(JSON.parse(store[KEY]).mode, 'live', 'and says what it holds');

  // That cache restores into a live board.
  Store.init(fleet);
  assert.ok(Math.abs(Store.vessels[0].fix.lat - 43.73) < 0.001, 'a real fix comes back');

  // But not into a simulation.
  Store.mode = 'demo';
  Store.init(fleet);
  assert.strictEqual(Store.vessels[0].fix, null,
    'a real position does not appear under a simulated vessel');

  // A cache from before this distinction existed cannot say which it holds, so
  // it is discarded rather than trusted.
  Store.mode = 'live';
  store[KEY] = JSON.stringify({
    savedAt: Date.now(),
    vessels: { 319000101: { fix: { lon: 2.1, lat: 41.4, at: Date.now() }, track: [] } }
  });
  Store.init(fleet);
  assert.strictEqual(Store.vessels[0].fix, null, 'an unlabelled cache is not trusted');
  assert.strictEqual(store[KEY], undefined, 'and is cleared rather than left to be re-read');
  } finally {
    global.localStorage = realStorage;
    Store.mode = realMode;
  }
});

test('the feed mode is settled before the cache is read', () => {
  // init() restores the cache, and the restore depends on the mode. Setting the
  // mode afterwards, as startFeed used to, would have made the guard above
  // discard every real cache on every load.
  ['js/app.js', 'js/console.js'].forEach((f) => {
    const source = readRepo(f);
    const setMode = source.indexOf('Store.mode = window.Feed.mode()');
    const init = source.indexOf('Store.init(window.FLEET)');
    assert.ok(setMode !== -1, f + ' decides the mode explicitly');
    assert.ok(setMode < init, f + ': and does it before init reads the cache');
  });

  /**
   * And the answer comes from the provider, not from whether a key was typed.
   *
   * On the relay there IS no key at this end — that is the point of it — so
   * "no key means demo" would silently discard the cache of a board that is
   * more live than it has ever been, and put invented yachts on a wall in
   * front of customers.
   */
  const original = CONFIG.provider;
  const settings = window.Settings;
  window.Settings = { aisKey: () => '' };
  try {
    CONFIG.provider = 'relay';
    assert.strictEqual(window.Feed.mode(), 'live', 'a relay board with no key is live');
    CONFIG.provider = 'aisstream';
    assert.strictEqual(window.Feed.mode(), 'demo', 'and without one it still is not');
  } finally {
    CONFIG.provider = original;
    window.Settings = settings;
  }
});

test('a running test does not leave the feed reporting on itself', () => {
  /**
   * A diagnostic stops the live feed for its duration. Two things went wrong
   * with that, both of them making the sheet lie about the feed's health:
   *
   * The counts panel went on showing the stopped socket's numbers, so mid-test
   * it read "1 message received, none for this fleet" — a fault report about a
   * socket that was not running.
   *
   * And closing the sheet cancelled the test without restarting the feed, so
   * the board sat dead until somebody reloaded it, having just been told
   * everything was fine.
   */
  const source = readRepo('js/settings.js');
  assert.ok(/if \(cancelDiagnosis\) \{\s*\n\s*node\.textContent = 'The feed is stopped/.test(source),
    'the panel says the feed is stopped rather than reporting its dead counters');

  const closeFn = source.slice(source.indexOf('function close(d)'),
                               source.indexOf('function close(d)') + 700);
  assert.ok(/cancelDiagnosis\(\);[\s\S]{0,400}notify\(\);/.test(closeFn),
    'closing mid-test brings the feed back up');
});

/* --- Identifiers that do not exist ---------------------------------------- */

test('no file refers to something that was never declared', () => {
  /**
   * The bug this exists for: a variable declared in the wrong function. The file
   * parsed, node --check was happy, and every check in this suite passed —
   * because they all read the source rather than running it. The branch using it
   * was a diagnostic nobody had opened in a browser, so it threw a ReferenceError
   * the first time somebody pressed the button, and the feature had never once
   * worked while I was interpreting its silence as evidence about a data feed.
   *
   * `no-undef` finds that in every branch without running anything. Skipped
   * where eslint is not installed rather than failing: it is not a dependency of
   * the board, which has none.
   */
  const { execFileSync } = require('child_process');
  const root = path.join(__dirname, '..');
  let output;
  try {
    execFileSync('npx', ['--no-install', 'eslint', 'js', 'tools', 'config.js', 'fleet.js'],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    return;                                   // clean
  } catch (e) {
    output = String((e.stdout || '') + (e.stderr || ''));
    // No eslint here: not a failure of the code under test.
    if (/could not determine executable|not found|Cannot find module/i.test(output)) return;
    assert.fail('undefined identifiers:\n' + output.trim());
  }
});

test('a couple of vessels either way is not a finding', () => {
  /**
   * Nine against seven, out of sixty-one, in one three-minute sample of world
   * traffic — a plain `>` read that as proof and named the bounding box. It sent
   * us after a cause that had not been demonstrated at all, and buried the real
   * one, which was sitting in the stage above.
   */
  const source = readRepo('js/ais.js');
  assert.ok(/function materiallyMore/.test(source), 'differences are tested for size');
  assert.ok(/a >= b \+ 5 && a >= b \* 1\.5/.test(source),
    'and a margin of two out of sixty-one does not clear it');
  assert.ok(/materiallyMore\(n\(reversed\), n\(unfiltered\)\)/.test(source),
    'the bounding-box verdict in particular goes through it');
});

test('message 27 places a vessel, with its own not-available codes', () => {
  /**
   * The low-rate position a Class A sends for long-range and satellite
   * reception. It was not in the old subscription's type list, and it is not in
   * the same shape as the others: ITU M.1371 codes speed-not-available as 63
   * here and course as 511, where the ordinary position report uses 102.3 and
   * 360. Reusing the usual constants would have shown a yacht doing 63 knots.
   */
  withFakeSocket((sockets) => {
    Ais.start('k'.repeat(40), [319000001]);
    const socket = sockets[0];
    socket.readyState = 1;
    socket.onopen();
    socket.onmessage({ data: JSON.stringify({
      MessageType: 'LongRangeAisBroadcastMessage',
      MetaData: { MMSI: 319000001 },
      Message: { LongRangeAisBroadcastMessage: {
        Latitude: 36.75, Longitude: 28.94, Sog: 63, Cog: 511, Valid: true
      } }
    }) });
    const v = Store.byMmsi['319000001'];
    assert.ok(v.fix, 'she is placed');
    assert.ok(Math.abs(v.fix.lat - 36.75) < 0.001, 'where the message said');
    assert.strictEqual(v.fix.sog, null, '63 knots is this message saying "unknown"');
    assert.strictEqual(v.fix.cog, null, 'and 511 likewise, not a course');
    assert.strictEqual(v.fix.heading, null, 'message 27 carries no heading at all');
  });
});

test('a Class B static report is read from its two halves', () => {
  /**
   * Message 24 nests its content: ReportA carries the name, ReportB the call
   * sign and dimensions, and nothing useful sits at the top level. Handing the
   * message straight to applyIdentity — as it was — read every field as
   * undefined and quietly learned nothing, which is how a Class B yacht could be
   * heard from all day and still have no name.
   */
  withFakeSocket((sockets) => {
    Ais.start('k'.repeat(40), [319000001]);
    const socket = sockets[0];
    socket.readyState = 1;
    socket.onopen();
    socket.onmessage({ data: JSON.stringify({
      MessageType: 'StaticDataReport',
      MetaData: { MMSI: 319000001 },
      Message: { StaticDataReport: {
        Valid: true,
        ReportA: { Name: 'QUIET ONE           ', Valid: true },
        ReportB: { CallSign: 'ZGAA1  ', ShipType: 37,
                   Dimension: { A: 40, B: 20, C: 5, D: 5 }, Valid: true }
      } }
    }) });
    const ais = Store.byMmsi['319000001'].ais;
    assert.strictEqual(ais.name, 'QUIET ONE', 'the name comes out of ReportA');
    assert.strictEqual(ais.callSign, 'ZGAA1', 'the call sign out of ReportB');
    assert.strictEqual(ais.shipType, 37, 'and the ship type, which fills in M/Y');
    assert.strictEqual(ais.loa, 60, 'dimensions add up to a length');
  });
});

test('the coverage test refuses to pick a winner out of noise', () => {
  /**
   * Two consecutive real runs disagreed by a factor of nine on the same stage —
   * 9 of the silent vessels found, then 1. The stages run one after another, so
   * each samples a DIFFERENT three minutes, and a yacht at rest transmits once
   * every three. Which vessels appear is close to a coin toss.
   *
   * On the strength of that, this named the bounding box once (9 against 7) and
   * the MMSI filter once (2 against 1). Both were confident readings of a
   * difference the instrument cannot resolve. An instrument that reports noise
   * as a cause is worse than no instrument: it sends people to work on the
   * wrong thing, with evidence in hand.
   */
  const source = readRepo('js/ais.js');
  // Anchored inside diagnoseCoverage, not on the first `function finish()` in
  // the file — the survey has one of those too now, and the slice quietly
  // landed on it, checking a function that has nothing to do with this.
  const coverage = source.indexOf('Ais.diagnoseCoverage = ');
  assert.ok(coverage !== -1, 'the coverage test exists');
  const finish = source.slice(source.indexOf('function finish()', coverage),
                              source.indexOf('function finish()', coverage) + 4000);

  // No bare comparison of two sampled counts survives.
  assert.ok(!/n\(shortRun\) > n\(full\)/.test(finish), 'the list-length branch has a margin');
  assert.ok(!/n\(unfiltered\) > n\(full\)/.test(finish), 'the filter branch has a margin');
  assert.ok(!/n\(reversed\) > n\(unfiltered\)/.test(finish), 'the bounding-box branch has one');
  assert.strictEqual((finish.match(/materiallyMore\(/g) || []).length, 3,
    'all three comparisons go through it');

  assert.ok(/biggest > 0 && biggest < 5/.test(finish),
    'and a run too thin to distinguish anything says so');
  assert.ok(/Too few to tell/.test(finish), 'in those words, rather than naming a cause');
  assert.ok(/heard since/.test(finish),
    'pointing at the measurement that does work — hours of live running');
});

/* --- Our own places on the chart ------------------------------------------ */

test('every site is placeable and of a kind the chart can draw', () => {
  const sites = CONFIG.sites;
  assert.ok(sites.length >= 5, 'two headquarters and three yards');
  sites.forEach((s) => {
    assert.ok(s.name && s.name.length, 'named');
    assert.ok(['hq', 'yard'].indexOf(s.kind) !== -1, s.name + ': a kind the chart knows');
    assert.ok(s.lat >= -90 && s.lat <= 90, s.name + ': latitude in range');
    assert.ok(s.lon >= -180 && s.lon <= 180, s.name + ': longitude in range');
  });

  // Spot-check against the towns they name, so a transposed pair cannot pass.
  const at = (name) => sites.filter((s) => s.name.indexOf(name) === 0)[0];
  const near = (site, lat, lon) =>
    Math.abs(site.lat - lat) < 0.6 && Math.abs(site.lon - lon) < 0.6;
  assert.ok(near(at('Letchworth'), 51.98, -0.23), 'Letchworth is in Hertfordshire');
  assert.ok(near(at('Monaco'), 43.74, 7.42), 'Monaco is on the Côte d\'Azur');
  assert.ok(near(at('Antalya'), 36.90, 30.71), 'Antalya is on the Turkish south coast');
  assert.ok(near(at('Istanbul'), 41.01, 28.98), 'Istanbul is on the Bosphorus');
  assert.ok(near(at('Amsterdam'), 52.37, 4.90), 'Amsterdam is in North Holland');

  const yards = sites.filter((s) => s.kind === 'yard').map((s) => s.name);
  assert.deepStrictEqual(yards.sort(), ['Amsterdam', 'Antalya', 'Istanbul']);
});

test('our own places survive anonymous mode', () => {
  // Anonymous mode withholds the CLIENTS' identities. These are ours, and on a
  // board being shown to a prospect they are rather the point.
  const source = readRepo('js/map.js');
  const draw = source.slice(source.indexOf('function layoutSites'),
                            source.indexOf('function layoutSites') + 2000);
  assert.ok(!/publicName|showsIdentity|anonymous/i.test(draw),
    'layoutSites does not consult the anonymity gate');
  assert.ok(/CONFIG\.sites/.test(draw), 'and reads them straight from config');
});

/* --- Sentinel -------------------------------------------------------------- */

test('sentinel survives a round trip through the form and the file', () => {
  const fields = { name: 'Covered', mmsi: '319000101', sentinel: true, discreet: false };
  const record = Vessel.buildRecord(fields);
  assert.strictEqual(record.sentinel, true, 'the form sets it');
  assert.strictEqual(Vessel.toFields(record).sentinel, true, 'and reading it back keeps it');

  const off = Vessel.buildRecord({ name: 'Plain', mmsi: '319000102' });
  assert.strictEqual(off.sentinel, false, 'absent means not covered, never undefined');

  // It has to reach fleet.js, or marking a yacht in the console is lost the
  // moment the file is written.
  assert.ok(/sentinel: true/.test(Vessel.toSnippet(record)),
    'the snippet carries it');
});

test('sentinel is a relationship, not a status', () => {
  /**
   * It cuts across all four states — a Sentinel yacht is still moored, or
   * underway, or dark — so it filters separately and is drawn under the marker
   * rather than instead of it. Her own status colour stays the thing you read
   * first.
   */
  const console_ = readRepo('js/console.js');
  assert.ok(/if \(filter === 'sentinel'\) return !!v\.yacht\.sentinel;/.test(console_),
    'the filter matches on the flag, not on a derived state');
  assert.ok(!/STATE_BUCKETS\s*=\s*\{[^}]*sentinel/.test(console_),
    'and it is not folded in with the statuses, which must still add up to the fleet');
  assert.ok(/status === 'sentinel'\) return 'var\(--sentinel\)'/.test(console_),
    'its chip has a colour of its own — var(--status-sentinel) resolves to nothing');

  const map = readRepo('js/map.js');
  assert.ok(/if \(v\.yacht\.sentinel\) drawSentinelGlow/.test(map), 'the chart draws the halo');
  assert.ok(map.indexOf('drawSentinelGlow') < map.indexOf('if (d.discreet) {'),
    'under the marker, so the halo never replaces her status');
  assert.ok(/isFinite\(x\) \|\| !isFinite\(y\) \|\| !isFinite\(now\)/.test(map),
    'and a non-finite frame is skipped rather than thrown over — a gradient ' +
    'rejects one by raising, once per marker per frame');
});

/* --- Choosing between yachts in the same place ----------------------------- */

test('a crowded spot returns everything under the pointer, nearest first', () => {
  // Port Hercule puts half the fleet inside twenty pixels. Returning only the
  // nearest makes the ones behind her unreachable: drawn, and unselectable.
  const map = readRepo('js/map.js');
  assert.ok(/Map\.hitTestAll = function/.test(map), 'there is a way to ask for all of them');
  assert.ok(/under\.sort\(function \(a, b\) \{ return a\.distance - b\.distance; \}\)/.test(map),
    'ordered by distance, so the obvious choice is first');
  assert.ok(/Map\.hitTest = function[\s\S]{0,200}hitTestAll/.test(map),
    'and the single-vessel case is expressed in terms of it, not duplicated');
});

test('the picker keeps the promises the rest of the board makes', () => {
  const picker = readRepo('js/picker.js');
  assert.ok(/under\.length === 1/.test(picker),
    'one vessel under the pointer selects her outright — a list of one is a wasted click');
  assert.ok(/Vessel\.publicName\(vessel\.yacht, vessel\.index\)/.test(picker),
    'names go through the anonymity gate, so clicking cannot undo it');
  assert.ok(/document\.addEventListener\('mousedown', dismiss, true\)/.test(picker),
    'a click anywhere closes it, in capture, before it reads as a new selection');
  assert.ok(/event\.key !== 'Escape'/.test(picker), 'and Escape closes it');

  ['js/app.js', 'js/console.js'].forEach((f) => {
    assert.ok(/Picker\.handleClick/.test(readRepo(f)), f + ' goes through the picker');
  });
  assert.ok(/Picker\.isOpen\(\)/.test(readRepo('js/app.js')),
    'and Escape closes the list before it reaches the board’s own shortcuts');
});

/* --- Browsing the chart ---------------------------------------------------- */

test('zoom about a point leaves that point where it was', () => {
  /**
   * The whole of zoom-to-cursor. Without it, whatever you are aiming at slides
   * toward the centre as you approach it, and closing in on a marina becomes a
   * chase.
   */
  // readTheme reads the stylesheet through getComputedStyle, which does not
  // exist here. The camera maths under test does not care what colour anything
  // is; only that init completed.
  global.getComputedStyle = () => ({ getPropertyValue: () => '' });
  FleetMap.init({
    width: 1200, height: 800, style: {},
    getContext: () => stubCanvasContext(),
    getBoundingClientRect: () => ({ width: 1200, height: 800, left: 0, top: 0 })
  });
  FleetMap.centreOn(7.42, 43.73, 4000);
  FleetMap.snap();

  const point = [900, 260];
  const before = FleetMap.unproject(point[0], point[1]);
  FleetMap.zoomAt(point[0], point[1], 2.5);
  const after = FleetMap.unproject(point[0], point[1]);

  close(after[0], before[0], 0.0005, 'longitude under the pointer');
  close(after[1], before[1], 0.0005, 'latitude under the pointer');
  assert.ok(FleetMap.zoomLevel() > 4000, 'and it did actually zoom');
});

test('the chart cannot be scrolled off the world', () => {
  /**
   * Not "is the latitude still a number" — latFromWorldY asymptotes to ±90, so
   * that can never fail and the check was vacuous. The symptom of no clamp is
   * scrolling the world off the screen entirely and staring at blank space, so
   * measure that: where the top edge of the Mercator world lands.
   */
  const MERC_TOP = 85.0511;
  FleetMap.centreOn(0, 0, 900);
  FleetMap.snap();

  FleetMap.panBy(0, 100000);                 // far past the north pole
  const topEdge = FleetMap.project(0, MERC_TOP)[1];
  assert.ok(topEdge <= 400 + 1,
    'the top of the world never drops below the middle of the view, ' +
    'so there is always chart on screen — got y=' + Math.round(topEdge));

  FleetMap.panBy(0, -200000);                // and far past the south
  const bottomEdge = FleetMap.project(0, -MERC_TOP)[1];
  assert.ok(bottomEdge >= 400 - 1,
    'nor the bottom above it — got y=' + Math.round(bottomEdge));

  // Longitude does wrap: sailing west past the dateline is a real thing.
  FleetMap.centreOn(179, 0, 900);
  FleetMap.snap();
  FleetMap.panBy(-4000, 0);
  assert.ok(isFinite(FleetMap.unproject(600, 400)[0]), 'longitude wraps rather than sticking');
});

test('zoom is bounded at both ends', () => {
  FleetMap.centreOn(0, 0, 900);
  FleetMap.snap();
  for (let i = 0; i < 60; i++) FleetMap.zoomAt(600, 400, 4);
  const tightest = FleetMap.zoomLevel();
  for (let i = 0; i < 120; i++) FleetMap.zoomAt(600, 400, 0.25);
  const widest = FleetMap.zoomLevel();
  assert.ok(tightest <= FleetMap.limits.max, 'it stops zooming in');
  assert.ok(widest >= FleetMap.limits.min, 'and stops zooming out');
  assert.ok(widest < tightest, 'and the two limits are the right way round');
});

test('a drag is not a click, and browsing suspends automatic aiming', () => {
  /**
   * Driven in a browser as well — a drag beginning on a marker must not select
   * her, a plain click must, and two pixels of jitter is still a click. This
   * holds the reasoning so it cannot be undone by an edit.
   */
  const browse = readRepo('js/browse.js');
  assert.ok(/CLICK_SLOP_PX = 4/.test(browse), 'a few pixels of jitter is still a click');
  assert.ok(/CLICK_SLOP_MS = 400/.test(browse), 'and a press held a long time is not');
  assert.ok(/!wasDragging && moved <= CLICK_SLOP_PX && quick/.test(browse),
    'a click needs all three: no drag, little movement, little time');
  assert.ok(/window\.addEventListener\('mousemove'/.test(browse),
    'the drag follows the pointer off the canvas rather than sticking');
  assert.ok(/event\.preventDefault\(\)/.test(browse),
    'the wheel zooms rather than scrolling the page behind it');

  const console_ = readRepo('js/console.js');
  assert.ok(/if \(window\.Browse\.hasHold\(\)\) return;/.test(console_),
    'aimChart stands down while somebody is holding the chart — a fix arrives ' +
    'every few seconds and would drag the view out from under them');
  assert.ok(/window\.Browse\.release\(\);\s*\n\s*select\(id\)/.test(console_),
    'and choosing a vessel gives the chart back, because that is an instruction to look');
  assert.ok(/chart-home/.test(readRepo('console.html')),
    'there is a visible way back, not one you have to know about');
});


/* --- Crowds ---------------------------------------------------------------- */

// A stand-in for what the map hands the clusterer.
function at(id, x, y, extra) {
  const o = extra || {};
  return {
    x, y,
    vessel: {
      yacht: { id, name: id, sentinel: !!o.sentinel },
      derived: { status: o.status || 'moored', discreet: !!o.discreet }
    }
  };
}

test('a crowd becomes one mark and the loners are left alone', () => {
  const placed = [
    at('a', 100, 100), at('b', 108, 104), at('c', 96, 112), at('d', 112, 96),
    at('far', 600, 400)
  ];
  const g = Cluster.group(placed, 26, null);

  assert.strictEqual(g.clusters.length, 1, 'the four in the bay are one crowd');
  assert.strictEqual(g.clusters[0].members.length, 4);
  assert.strictEqual(g.singles.length, 1, 'and the one out at sea is still herself');
  assert.strictEqual(g.singles[0].vessel.yacht.id, 'far');
});

test('two side by side stay two vessels', () => {
  // Collapsing a pair into a disc reading "2" trades two headings for a digit
  // and buys nothing: both markers were already readable.
  const g = Cluster.group([at('a', 200, 200), at('b', 210, 204)], 26, null);
  assert.strictEqual(g.clusters.length, 0);
  assert.strictEqual(g.singles.length, 2);
});

test('every vessel comes out exactly once', () => {
  /**
   * The failure this guards against is a count that lies. The greedy sweep
   * consumes members as it goes; get the bookkeeping wrong and a yacht is
   * either drawn twice or silently dropped off the chart, and the number on the
   * disc stops meaning anything.
   */
  const placed = [];
  for (let i = 0; i < 60; i++) {
    // Three loose knots plus a scatter, which is roughly the Mediterranean.
    const knot = i % 3;
    placed.push(at('v' + i, 150 + knot * 90 + (i % 7) * 6, 200 + knot * 40 + (i % 5) * 7));
  }
  const g = Cluster.group(placed, 26, null);

  const seen = new Set();
  g.singles.forEach((p) => seen.add(p.vessel.yacht.id));
  g.clusters.forEach((c) => c.members.forEach((p) => seen.add(p.vessel.yacht.id)));
  assert.strictEqual(seen.size, 60, 'none lost');

  const total = g.singles.length +
    g.clusters.reduce((n, c) => n + c.members.length, 0);
  assert.strictEqual(total, 60, 'and none counted twice');

  assert.ok(g.clusters.length + g.singles.length < 20,
    'and sixty yachts draw as fewer than twenty marks — got ' +
    (g.clusters.length + g.singles.length));
});

test('the selected yacht is never swallowed by a crowd', () => {
  // You asked for her by name. A disc reading "4" is not an answer.
  const placed = [at('a', 100, 100), at('b', 104, 104), at('c', 108, 96), at('me', 102, 108)];
  const g = Cluster.group(placed, 26, 'me');

  assert.ok(g.singles.some((p) => p.vessel.yacht.id === 'me'), 'she is drawn as herself');
  g.clusters.forEach((c) => {
    assert.ok(!c.members.some((p) => p.vessel.yacht.id === 'me'),
      'and is not also inside the crowd');
  });
});

test('a crowd holding a Sentinel yacht still shows gold', () => {
  /**
   * The gold glow exists to answer "where are my out-of-hours customers" at a
   * glance. A crowd that hides one has taken the answer away in exactly the
   * place — a busy marina — where it is most likely to be needed.
   */
  const g = Cluster.group([
    at('a', 100, 100), at('b', 106, 104), at('s', 110, 98, { sentinel: true })
  ], 26, null);

  assert.strictEqual(g.clusters.length, 1);
  assert.strictEqual(g.clusters[0].sentinel, true);
});

test('a crowd reports how much of it is moving', () => {
  const g = Cluster.group([
    at('a', 100, 100, { status: 'underway' }),
    at('b', 106, 104, { status: 'underway' }),
    at('c', 110, 98, { status: 'moored' })
  ], 26, null);
  assert.strictEqual(g.clusters[0].underway, 2, 'two of the three');
});

test('a discreet vessel is never folded into a crowd', () => {
  // Her position is deliberately vague and drawn as an area rather than a
  // point. Averaging that into a centre would quietly make it precise again.
  const g = Cluster.group([
    at('a', 100, 100), at('b', 106, 104), at('c', 110, 98),
    at('d', 104, 102, { discreet: true })
  ], 26, null);

  assert.ok(g.singles.some((p) => p.vessel.yacht.id === 'd'));
  assert.strictEqual(g.clusters[0].members.length, 3);
});

test('the same positions group the same way twice', () => {
  // A cluster that shimmers between frames is worse than no cluster at all.
  const make = () => [
    at('c', 108, 96), at('a', 100, 100), at('d', 112, 108),
    at('b', 104, 104), at('e', 300, 300), at('f', 306, 304), at('g', 310, 296)
  ];
  const one = Cluster.group(make(), 26, null);
  const two = Cluster.group(make().reverse(), 26, null);

  const shape = (g) => g.clusters
    .map((c) => c.members.map((p) => p.vessel.yacht.id).sort().join(','))
    .sort().join(' | ');
  assert.strictEqual(shape(one), shape(two),
    'input order must not change the answer');
});

test('a crowd grows with its count but not without limit', () => {
  const three = Cluster.radiusFor(3);
  const twelve = Cluster.radiusFor(12);
  const forty = Cluster.radiusFor(40);
  assert.ok(twelve > three, 'a bigger crowd is a bigger mark');
  assert.ok(forty - twelve < twelve - three, 'but it stops running away');
  assert.ok(forty < 20, 'and never swallows the coast — got ' + forty.toFixed(1));
});

test('the wind yields to the fleet rather than the other way round', () => {
  /**
   * The mess in a busy sea was a wind arrow and a speed drawn at every single
   * marker, unconditionally, with the labels told to work around all of them.
   * A dozen yachts in one bay share one wind; twelve arrows saying so was the
   * single biggest source of clutter on the chart.
   */
  const source = readRepo('js/map.js');
  const layout = source.slice(source.indexOf('function layoutWind'),
                              source.indexOf('function layoutWind') + 900);
  assert.ok(/collides\(box, boxes/.test(layout),
    'a wind arrow has to find room before it is drawn');

  const draw = source.slice(source.indexOf('function drawWind'),
                            source.indexOf('function drawWind') + 400);
  assert.ok(/winds\[i\]/.test(draw) && !/placed/.test(draw),
    'and drawWind paints the vetted list, not every marker');
});

test('our own places paint over the fleet, not under it', () => {
  // Asked for directly: the offices are meant to be findable at a glance, and a
  // chevron parked on Monaco was hiding the mark.
  const source = readRepo('js/map.js');
  // Both branches build the frame — one instrumented for the profiler, one not.
  // Checking only the first meant a reordering of the other went unnoticed.
  const body = source.slice(source.indexOf('Map.render = function'),
                            source.indexOf('Map.lastFrame = {'));
  const where = (needle) => [...body.matchAll(new RegExp(needle, 'g'))].map((m) => m.index);
  const marks = where('paintMarkers\\(');
  const names = where('paintLabels\\(');
  const sites = where('paintSites\\(');
  assert.strictEqual(sites.length, 2, 'both branches paint the site marks');
  sites.forEach((at, i) => {
    assert.ok(at > marks[i], 'over the fleet (branch ' + (i + 1) + ')');
    assert.ok(at > names[i], 'and over the names (branch ' + (i + 1) + ')');
  });
  assert.ok(/drawHqMark\(m\.x, m\.y, HALO/.test(source),
    'and carry a dark under-stroke so they read over whatever is beneath');
});


test('a crowd sitting on an office mark moves, and says that it moved', () => {
  /**
   * Monaco is both a headquarters and the busiest bay in the fleet, so the
   * office mark lands on precisely the pixels the count is drawn in. The disc
   * gives way rather than the mark — that was asked for — but a count floating
   * clear of the yachts it counts is the chart lying about where they are, so
   * the displacement is drawn as a leader back to the true centre.
   */
  const source = readRepo('js/map.js');
  const settle = source.slice(source.indexOf('function settleClusters'),
                              source.indexOf('function sitePoints'));
  assert.ok(/sitePoints\(\)/.test(settle), 'the office marks are obstacles');
  assert.ok(/c\.drawnX = x;/.test(settle),
    'and the disc records where it ended up, separately from where it is');

  const paint = source.slice(source.indexOf('function paintClusters'),
                             source.indexOf('function paintClusters') + 1400);
  assert.ok(/Math\.hypot\(cx - c\.x, cy - c\.y\) > 1/.test(paint),
    'a moved disc is drawn with a leader back to the crowd');
});

test('the hit test follows the disc that was actually drawn', () => {
  // Otherwise a nudged crowd opens on empty water and does nothing where the
  // number is — which is the only place anyone would click.
  const source = readRepo('js/map.js');
  const hit = source.slice(source.indexOf('Map.clusterAt'),
                           source.indexOf('Map.clusterAt') + 700);
  assert.ok(/c\.drawnX/.test(hit) && !/c\.x \+ frame\.driftX/.test(hit),
    'clusterAt measures from drawnX/drawnY');
});


test('a name outranks a wind arrow for the same space', () => {
  /**
   * The wind used to claim its space before the labels were laid out, so a
   * breeze could push a yacht's name off the chart entirely. Her name and her
   * speed are what anyone is looking at; the wind is decoration.
   */
  const source = readRepo('js/map.js');
  // Two branches build the frame — one instrumented for the profiler, one not —
  // and the order has to hold in both.
  const body = source.slice(source.indexOf('Map.render = function'),
                            source.indexOf('Map.lastFrame = {'));
  const labels = [...body.matchAll(/layoutLabels\(/g)].map((m) => m.index);
  const winds = [...body.matchAll(/layoutWind\(/g)].map((m) => m.index);
  assert.strictEqual(labels.length, 2, 'both branches lay out labels');
  assert.strictEqual(winds.length, 2, 'and both lay out wind');
  labels.forEach((at, i) => assert.ok(at < winds[i],
    'the names are placed first, and the wind fills what is left (branch ' + (i + 1) + ')'));
});

test('a wind arrow is not blocked by its own vessel', () => {
  // The arrow belongs to that marker. Treating the marker as an obstacle
  // suppressed every arrow on the chart rather than only the crowded ones.
  const source = readRepo('js/map.js');
  const layout = source.slice(source.indexOf('function layoutWind'),
                              source.indexOf('function layoutWind') + 1400);
  assert.ok(/collides\(box, boxes, p\.vessel\.yacht\.id\)/.test(layout),
    'her own id is passed as selfId');

  const box = source.slice(source.indexOf('function windBox'),
                           source.indexOf('function windBox') + 400);
  assert.ok(!/owner/.test(box),
    'but the box itself stays unowned, so it still blocks her name');
});


/* --- Clicking a crowd on the board ----------------------------------------- */

test('holding the camera abandons the journey rather than finishing it', () => {
  /**
   * The board's chart tour is always easing somewhere, so a mark is usually
   * moving under the pointer. snap() would finish the journey — jumping the
   * chart to wherever it was heading and taking with it the very disc somebody
   * has just put a finger on. hold() stops where it is.
   */
  global.getComputedStyle = () => ({ getPropertyValue: () => '' });
  FleetMap.init({
    width: 1200, height: 800, style: {},
    getContext: () => stubCanvasContext(),
    getBoundingClientRect: () => ({ width: 1200, height: 800, left: 0, top: 0 })
  });
  FleetMap.centreOn(7.42, 43.73, 4000);
  FleetMap.snap();
  const where = { cx: FleetMap.camera.cx, cy: FleetMap.camera.cy, scale: FleetMap.camera.scale };

  FleetMap.centreOn(-64.8, 32.3, 90000);              // off to Bermuda
  assert.notStrictEqual(FleetMap.target.scale, where.scale, 'a journey is in flight');

  FleetMap.hold();
  assert.strictEqual(FleetMap.camera.cx, where.cx, 'the camera has not moved');
  assert.strictEqual(FleetMap.target.cx, FleetMap.camera.cx, 'and has nowhere left to go');
  assert.strictEqual(FleetMap.target.cy, FleetMap.camera.cy);
  assert.strictEqual(FleetMap.target.scale, FleetMap.camera.scale);
});

test('the camera stamp changes when the chart moves, and not otherwise', () => {
  // What tells a list drawn over the chart that the chart has gone.
  FleetMap.centreOn(7.42, 43.73, 4000);
  FleetMap.snap();
  const at = FleetMap.cameraStamp();
  assert.strictEqual(FleetMap.cameraStamp(), at, 'a still chart reads the same twice');

  FleetMap.panBy(40, 0);
  assert.notStrictEqual(FleetMap.cameraStamp(), at, 'a pan shows');

  // Zoom on its own, with the centre held, or a stamp that only watched the
  // centre would call a chart that had zoomed right in "unchanged".
  FleetMap.centreOn(7.42, 43.73, 4000);
  FleetMap.snap();
  const near = FleetMap.cameraStamp();
  FleetMap.centreOn(7.42, 43.73, 16000);
  FleetMap.snap();
  assert.notStrictEqual(FleetMap.cameraStamp(), near, 'a zoom shows too');

  FleetMap.zoomAt(600, 400, 1);
  assert.strictEqual(FleetMap.cameraStamp(), FleetMap.cameraStamp(),
    'and a zoom of one is not a move');
});

test('the board stops the chart when a hand goes near it', () => {
  /**
   * Aiming at a disc on a chart that is panning under the pointer is a lottery,
   * and the miss is silent: you click, and nothing at all happens. The press
   * freezes the chart so the click that follows lands on the frame the pointer
   * was aimed at.
   */
  const app = readRepo('js/app.js');
  assert.ok(/addEventListener\('pointerdown', onCanvasPointerDown\)/.test(app),
    'the press is listened for');

  const down = app.slice(app.indexOf('function onCanvasPointerDown'),
                         app.indexOf('function onCanvasClick'));
  assert.ok(/App\.paused = true/.test(down), 'and pauses the rotation');
  assert.ok(/FleetMap\.hold\(\)/.test(down), 'and holds the camera where it is');
  assert.ok(/noteActivity\(\)/.test(down),
    'and counts as activity, so the five-minute auto-resume still applies');
});

test('a list does not outlive the chart it was opened on', () => {
  /**
   * The board moves on its own. A list positioned once against the viewport
   * cannot follow it, so left alone it sits there naming three yachts that are
   * no longer under it — and then floats over whatever view comes next.
   */
  const picker = readRepo('js/picker.js');
  assert.ok(/openedAt = window\.FleetMap\.cameraStamp\(\)/.test(picker),
    'the list remembers the chart it was opened on');
  const check = picker.slice(picker.indexOf('Picker.checkStillValid'),
                             picker.indexOf('Picker.checkStillValid') + 400);
  assert.ok(/cameraStamp\(\) !== openedAt/.test(check) && /Picker\.close\(\)/.test(check),
    'and closes when that chart has moved');

  const app = readRepo('js/app.js');
  assert.ok(/Picker\.checkStillValid\(\)/.test(app), 'the frame loop asks');
  const enter = app.slice(app.indexOf('function enterScene'),
                          app.indexOf('function enterScene') + 300);
  assert.ok(/Picker\.close\(\)/.test(enter), 'and a change of view closes it outright');
});

test('our own places are placed before the chart names its seas', () => {
  // "SEA OF MARMARA" was winning the space Istanbul needed. Our offices still
  // yield to the fleet, which is claimed above both.
  const source = readRepo('js/map.js');
  const body = source.slice(source.indexOf('Map.render = function'),
                            source.indexOf('Map.lastFrame = {'));
  const sites = [...body.matchAll(/layoutSites\(/g)].map((m) => m.index);
  const places = [...body.matchAll(/drawPlaces\(/g)].map((m) => m.index);
  const labels = [...body.matchAll(/layoutLabels\(/g)].map((m) => m.index);
  assert.strictEqual(sites.length, 2, 'both branches lay out the sites');
  sites.forEach((at, i) => {
    assert.ok(at < places[i], 'before the place names (branch ' + (i + 1) + ')');
    assert.ok(at > labels[i], 'and after the fleet (branch ' + (i + 1) + ')');
  });
});

test('a site name that cannot go beside the mark tries elsewhere', () => {
  // One position meant Letchworth simply did not appear whenever a yacht was
  // crossing the North Sea, which on this fleet is most of the time.
  const source = readRepo('js/map.js');
  const offsets = source.slice(source.indexOf('var SITE_OFFSETS'),
                               source.indexOf('function layoutSites'));
  const count = (offsets.match(/\[[-\d]+, [-\d]+, '/g) || []).length;
  assert.ok(count >= 4, 'several positions are tried, not one — found ' + count);
});

test('a build yard is filled, not outlined', () => {
  /**
   * The yard mark was a thin outline in a desaturated blue at 70% opacity, on
   * the reasoning that a yard is context rather than the subject. Against this
   * sea it was invisible, which is not "quiet" — it is absent.
   */
  const source = readRepo('js/map.js');
  const yard = source.slice(source.indexOf('function drawYardMark'),
                            source.indexOf('function drawYardMark') + 900);
  assert.ok(/ctx\.fill\(\)/.test(yard), 'the diamond is filled');

  const tokens = readRepo('css/tokens.css');
  const value = /--map-site-yard:\s*([^;]+);/.exec(tokens)[1].trim();
  assert.ok(!/rgba/.test(value), 'and drawn at full opacity — got ' + value);
});


test('the board never calls one place by two names', () => {
  /**
   * The header clock and the chart both name the UK office. They are set in
   * different blocks of config and drifted apart the moment one of them was
   * shortened — "Letchworth" in the corner and "Letchworth Garden City" on the
   * chart, which reads as two places to anyone who has not seen the file.
   */
  const office = CONFIG.office;
  const here = (CONFIG.sites || []).filter((s) =>
    Math.abs(s.lat - office.lat) < 0.05 && Math.abs(s.lon - office.lon) < 0.05);
  assert.strictEqual(here.length, 1, 'the office appears once among the sites');
  assert.strictEqual(here[0].name, office.label,
    'and under the same name the clock uses — got "' + here[0].name +
    '" against "' + office.label + '"');
});


test('what the feed costs is measured, not estimated', () => {
  /**
   * Taking the whole world instead of asking for sixty-one vessels puts real
   * traffic on somebody's office connection. Measured on a stand-in running at
   * the rate the live key delivers — about a hundred messages a second — that
   * is 144 MB an hour. Nobody should have to take my word for it, least of all
   * on a connection I cannot see, so the panel shows the figure from their own
   * run.
   */
  const ais = readRepo('js/ais.js');
  const receive = ais.slice(ais.indexOf('function receive('),
                            ais.indexOf('function receive(') + 700);
  assert.ok(/Store\.bytes \+= frameBytes\(event\.data\)/.test(receive),
    'counted off the wire, before anything is decoded');

  // A UTF-8 string counted by character would under-report a feed full of
  // accented ship names.
  const fn = ais.slice(ais.indexOf('function frameBytes('),
                       ais.indexOf('function frameBytes(') + 500);
  assert.ok(/byteLength/.test(fn), 'a binary frame is counted by its byte length');
  assert.ok(/new Blob\(\[data\]\)\.size/.test(fn), 'and a string by its encoded size');

  const settings = readRepo('js/settings.js');
  assert.ok(/Fmt\.bytes\(r\.bytesPerHour\)/.test(settings), 'the panel says the rate');
});

test('the byte rate is reported against the same clock as the counts', () => {
  // "144 MB an hour" beside "21 hours" has to mean the same stretch of time, or
  // it is the per-socket-versus-per-feed mistake all over again.
  const store = readRepo('js/store.js');
  const rec = store.slice(store.indexOf('Store.reception = '),
                          store.indexOf('var SETTLE_MS'));
  assert.ok(/feedStartedAt/.test(rec) && /bytesPerHour/.test(rec),
    'the rate is derived from feedStartedAt, like heard and matched');
  assert.ok(/Store\.bytes \/ seconds \* 3600/.test(rec), 'and is a rate, not a total');
});

test('bytes are shown in the unit an allowance is sold in', () => {
  // Decimal MB, because a broadband allowance is quoted in decimal gigabytes
  // and this figure exists to be compared against one.
  assert.strictEqual(Fmt.bytes(0), '0 B');
  assert.strictEqual(Fmt.bytes(999), '999 B');
  assert.strictEqual(Fmt.bytes(1500), '1.5 kB');
  assert.strictEqual(Fmt.bytes(143.6e6), '144 MB');
  assert.strictEqual(Fmt.bytes(3.4e9), '3.4 GB');
  assert.strictEqual(Fmt.bytes(null), '—', 'and nothing is not zero');
  assert.strictEqual(Fmt.bytes(Infinity), '—');
});


/* --- What is actually on the feed? ---------------------------------------- */

// settings.js is loaded by an earlier test, which also has to stand up a
// localStorage for it. Don't lean on that having happened: these checks are
// about the report builder and should not fail because a test above moved.
function settingsModule() {
  if (!window.Settings) {
    const store = {};
    window.localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    };
    load('js/settings.js');
  }
  return window.Settings;
}

// Build a survey summary the way handle() would, from a list of [mmsi, type].
function surveyOf(messages, seconds) {
  const counts = {}, types = {};
  messages.forEach(([mmsi, type]) => {
    counts[mmsi] = (counts[mmsi] || 0) + 1;
    types[type] = (types[type] || 0) + 1;
  });
  return Ais._summarise(counts, types, messages.length, seconds);
}

test('the survey measures our vessels against the rest of the feed', () => {
  /**
   * "One message per vessel every five minutes" is neither good nor bad until
   * you know what the feed manages for everybody else. That comparison is the
   * whole instrument; the raw number was never going to settle anything.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const msgs = [];
    // A busy feed: strangers heard every few seconds.
    for (let v = 0; v < 100; v++) {
      for (let n = 0; n < 60; n++) msgs.push(['20000' + String(v).padStart(4, '0'), 'PositionReport']);
    }
    // Ours, heard twice each in the same three minutes.
    FLEET.slice(0, 5).forEach((y) => {
      msgs.push([String(y.mmsi), 'StandardClassBPositionReport']);
      msgs.push([String(y.mmsi), 'StandardClassBPositionReport']);
    });
    const r = surveyOf(msgs, 180);

    assert.strictEqual(r.vessels, 105, 'every distinct MMSI counted');
    assert.strictEqual(r.median, 60, 'the middle vessel on the feed');
    assert.strictEqual(r.best, 60, 'and on a flat feed the busiest is the same');
    assert.strictEqual(r.ours.length, 5, 'and ours picked out of it');
    assert.strictEqual(r.oursTotal, 10);
    assert.ok(r.classBShare > 0 && r.classBShare < 0.01,
      'Class B share is of the whole feed');
  } finally {
    window.Store = original;
  }
});

test('the middle of the feed is the middle, not the loudest thing on it', () => {
  /**
   * A ferry running a circuit past a receiver reports every few seconds all
   * day. Two of those in a survey of a thousand quiet vessels would drag a mean
   * — or a badly taken quantile — up to something that makes a thin feed look
   * healthy, and the verdict then blames our fleet for a network that is not
   * carrying anyone.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const msgs = [];
    for (let v = 0; v < 300; v++) msgs.push(['30000' + String(v).padStart(4, '0'), 'PositionReport']);
    // Three ferries, heard two hundred times each.
    for (let f = 0; f < 3; f++) {
      for (let n = 0; n < 200; n++) msgs.push(['99900000' + f, 'PositionReport']);
    }
    const r = surveyOf(msgs, 180);
    assert.strictEqual(r.vessels, 303);
    assert.strictEqual(r.best, 200, 'the busiest is a ferry');
    assert.strictEqual(r.median, 1, 'and the middle vessel is still heard once');
    assert.strictEqual(r.upper, 1, 'nine in ten are heard once');
  } finally {
    window.Store = original;
  }
});

test('a thin feed is called thin, not blamed on our fleet', () => {
  /**
   * The failure mode that matters. If every vessel on the feed is heard once
   * every few minutes, then so are ours, and there is nothing at this end to
   * fix — no key, no filter, no bounding box. Saying otherwise sends somebody
   * to spend a week tuning a subscription that was never the problem.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const msgs = [];
    for (let v = 0; v < 200; v++) {
      for (let n = 0; n < 2; n++) msgs.push(['20000' + String(v).padStart(4, '0'), 'PositionReport']);
    }
    FLEET.slice(0, 8).forEach((y) => {
      msgs.push([String(y.mmsi), 'PositionReport']);
      msgs.push([String(y.mmsi), 'PositionReport']);
    });
    const r = surveyOf(msgs, 180);
    assert.strictEqual(r.median, 2, 'the whole feed is thin');

    const report = settingsModule()._surveyReport(r);
    assert.ok(/heard as often as anything else/.test(report),
      'the verdict says ours are not being singled out');
    assert.ok(/denser receivers|satellite/.test(report),
      'and points at the provider, which is the only thing that changes it');
    // The feed's Class B share is printed as a statistic either way; what must
    // not appear is Class B offered as the CAUSE, which this run has no
    // evidence for.
    assert.ok(!/The usual reason/.test(report),
      'and does not reach for a cause it has no evidence for');
    assert.ok(!/MarineTraffic/.test(report),
      'nor send anyone off to check one');
  } finally {
    window.Store = original;
  }
});

test('a feed that hears everyone but us says so, and names the likely reason', () => {
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const msgs = [];
    for (let v = 0; v < 200; v++) {
      for (let n = 0; n < 40; n++) msgs.push(['20000' + String(v).padStart(4, '0'), 'PositionReport']);
    }
    FLEET.slice(0, 6).forEach((y) => msgs.push([String(y.mmsi), 'StandardClassBPositionReport']));
    const r = surveyOf(msgs, 180);
    assert.strictEqual(r.median, 40);

    const report = settingsModule()._surveyReport(r);
    assert.ok(/markedly less/.test(report), 'the difference is stated');
    assert.ok(/Class B/.test(report), 'with the first thing to check on a fleet of yachts');
    assert.ok(/MarineTraffic/.test(report), 'and where to check it');
  } finally {
    window.Store = original;
  }
});

test('the survey watches the live feed and never takes it down', () => {
  /**
   * The question is about traffic already arriving. Stopping the feed to ask it
   * would be absurd — and the coverage test, which does stop it, once left the
   * board dead because it threw before its cancel handle was assigned.
   */
  const source = readRepo('js/ais.js');
  const survey = source.slice(source.indexOf('Ais.survey = '),
                              source.indexOf('var CLASS_B_TYPES'));
  assert.ok(!/new WebSocket|Ais\.stop\(\)|connect\(\)/.test(survey),
    'no socket of its own, and nothing stopped');
  assert.ok(/Ais\.observer = function/.test(survey), 'it observes the live one');

  // BOTH ways out have to let go: finishing and being stopped. Checking that
  // the line appears somewhere passes with either one deleted.
  assert.strictEqual((survey.match(/Ais\.observer = null/g) || []).length, 2,
    'released when it finishes and when it is cancelled');
  assert.strictEqual((survey.match(/clearInterval\(tick\)/g) || []).length, 2,
    'and the tick is cleared on both paths');
});

test('stopping a survey lets go of the feed immediately', () => {
  // Behaviour, not source: an observer left attached counts every message on
  // earth into a map behind a panel nobody has open.
  const cancel = Ais.survey(180, null, null);
  assert.strictEqual(typeof window.Ais.observer, 'function', 'attached while it runs');
  cancel();
  assert.strictEqual(window.Ais.observer, null, 'and gone the moment it is stopped');
  cancel();
  assert.strictEqual(window.Ais.observer, null, 'stopping twice is harmless');
});

test('a feed with a ceiling on it is called out before anything else', () => {
  /**
   * The real run that settled this, kept as a fixture: 56,306 messages in 233
   * seconds from 26,482 vessels; the middle vessel heard twice, the BUSIEST
   * heard nine times.
   *
   * Nine. A vessel underway broadcasts every 2 to 10 seconds, so in 233 seconds
   * she sends between 23 and 117 positions — and out of twenty-six thousand
   * ships, a great many are moving. A maximum of nine across all of them means
   * nothing on the feed is arriving at the rate it is sent.
   *
   * The first verdict missed this entirely. It compared our median (1) against
   * the feed's median (2), called the difference too small to matter and said
   * "the feed itself is thin" — true, but it read the weakest number in the
   * report and never looked at the one that settles it.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const msgs = [];
    // 26,000 vessels heard once or twice; a handful of "busiest" heard nine
    // times. Nothing anywhere near an underway rate.
    for (let v = 0; v < 26000; v++) {
      const n = v % 2 ? 1 : 2;
      for (let k = 0; k < n; k++) msgs.push(['4' + String(v).padStart(8, '0'), 'PositionReport']);
    }
    for (let v = 0; v < 20; v++) {
      for (let k = 0; k < 9; k++) msgs.push(['5' + String(v).padStart(8, '0'), 'PositionReport']);
    }
    // The sample fleet is eight boats, so this stands in for the real 18 of 61:
    // a minority of ours heard once each against that ceiling.
    FLEET.slice(0, 3).forEach((y) => msgs.push([String(y.mmsi), 'PositionReport']));
    const r = surveyOf(msgs, 233);

    assert.strictEqual(r.best, 9, 'the busiest vessel on the feed');
    assert.strictEqual(r.ours.length, 3, 'and only a few of ours appeared at all');

    const report = settingsModule()._surveyReport(r);
    assert.ok(/busiest vessel out of 26,023 was heard 9 times/.test(report),
      'the ceiling is the headline, with the numbers in it');
    assert.ok(/every 2 to 10 seconds/.test(report),
      'measured against what AIS actually transmits');
    assert.ok(/ceiling is the feed/.test(report), 'and named as the feed\'s limit');
    assert.ok(/not something a key, a filter or a bounding box reaches/.test(report),
      'with nothing at this end left to try');
    assert.ok(/3 of 8 of ours appeared/.test(report),
      'and the fleet coverage stated alongside it');
    assert.ok(/satellite/.test(report), 'pointing at what would actually change it');
  } finally {
    window.Store = original;
  }
});

test('a feed carrying vessels at their real rate is not called capped', () => {
  // The guard against crying wolf: if something on the feed IS arriving every
  // few seconds, the ceiling verdict must not fire, or every survey ends in
  // "change provider" regardless of what it measured.
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const msgs = [];
    for (let v = 0; v < 2000; v++) msgs.push(['6' + String(v).padStart(8, '0'), 'PositionReport']);
    // One vessel underway and fully relayed: 30 positions in 233 seconds, which
    // is what a feed carrying its traffic looks like.
    for (let k = 0; k < 30; k++) msgs.push(['700000001', 'PositionReport']);
    FLEET.forEach((y) => msgs.push([String(y.mmsi), 'PositionReport']));
    const r = surveyOf(msgs, 233);
    assert.strictEqual(r.best, 30, 'something on the feed is arriving at rate');

    const report = settingsModule()._surveyReport(r);
    assert.ok(!/ceiling is the feed/.test(report),
      'no ceiling verdict when the feed is carrying something at rate');
  } finally {
    window.Store = original;
  }
});


/* --- Is she on the feed under a different number? ------------------------- */

test('a name is compared the way a name survives AIS', () => {
  /**
   * AIS pads to twenty characters with '@', and yards, brokers and registries
   * disagree about spacing and punctuation. Comparing raw strings would find
   * nothing and the whole check would quietly always pass.
   */
  const n = Ais._normaliseName;
  assert.strictEqual(n('LAZY ME@@@@@@@@@@@@@'), 'LAZYME', 'padding and spaces go');
  assert.strictEqual(n('Lazy Me'), 'LAZYME', 'so does case');
  assert.strictEqual(n('LADY M. II'), n('LADY M II'), 'and punctuation');
  assert.strictEqual(n('Alaïa'), 'ALAIA', 'accents fold to the plain letter');
  assert.strictEqual(n(''), '');
  assert.strictEqual(n(null), '', 'and nothing is not a match for anything');
});

test('a vessel broadcasting our name under another number is caught', () => {
  /**
   * The case that prompted this: Class A, reported two minutes ago elsewhere,
   * never once on the board. A Class A transponder is 12.5 watts every few
   * seconds — if a network hears anything in that sea it hears her. So either
   * the feed does not carry her, or it does and we are listening for the wrong
   * number.
   *
   * Sixty-one MMSIs were read off another site and typed in by hand. A wrong
   * one fails silently for ever, and nothing until now could tell that apart
   * from a vessel genuinely off the feed.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const target = s.vessels[0];
    delete target.firstHeardAt;                       // never heard from
    const heard = s.vessels[1];
    heard.firstHeardAt = new Date();                  // reporting normally

    const cancel = Ais.chase(300, null, null);

    const say = (mmsi, name) => Ais.observer(String(mmsi), {
      MessageType: 'PositionReport',
      MetaData: { MMSI: mmsi, ShipName: name }
    });

    say(999888777, target.yacht.name.toUpperCase() + '@@@@@');   // ours, wrong number
    say(999888777, target.yacht.name.toUpperCase() + '@@@@@');
    say(111222333, 'MAERSK SELETAR');                            // a stranger
    say(heard.yacht.mmsi, heard.yacht.name);                     // ours, reporting fine

    const r = cancel();
    assert.strictEqual(r.total, 4, 'every message was seen');

    // Seen, but not offered: nothing about her agrees except the name, and a
    // bare name on a global feed is what coincidence looks like.
    assert.strictEqual(r.leads.leads.length, 0, 'not put forward to act on');
    assert.strictEqual(r.leads.nameOnly.length, 1, 'reported as a name match only');
    assert.strictEqual(r.leads.nameOnly[0].feedMmsi, '999888777', 'what the feed says');
    assert.strictEqual(r.leads.nameOnly[0].ourMmsi, String(target.yacht.mmsi),
      'what we have');
    assert.strictEqual(r.leads.nameOnly[0].n, 2);
    assert.strictEqual(r.found.length, 0, 'she never used our number');
  } finally {
    window.Store = original;
    window.Ais.observer = null;
  }
});

test('a vessel reporting under her own number is not called an impostor', () => {
  // The guard. Every vessel on the feed carries a name, and ours carry ours —
  // a check that fires on those would report sixty-one impostors a minute.
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    s.vessels.forEach((v) => delete v.firstHeardAt);
    const cancel = Ais.chase(300, null, null);
    s.vessels.forEach((v) => Ais.observer(String(v.yacht.mmsi), {
      MessageType: 'PositionReport',
      MetaData: { MMSI: v.yacht.mmsi, ShipName: v.yacht.name }
    }));
    const r = cancel();
    assert.strictEqual(r.leads.leads.length, 0, 'nobody is impersonating anybody');
    assert.strictEqual(r.leads.nameOnly.length, 0, 'not even weakly');
    assert.strictEqual(r.found.length, s.vessels.length, 'they simply turned up');
  } finally {
    window.Store = original;
    window.Ais.observer = null;
  }
});

test('a common name is reported as noise, never as a finding', () => {
  /**
   * The real run, kept as a fixture. Forty-three rows came back and every one
   * of them was almost certainly wrong: "Aurora" alone appeared under twenty
   * different MMSIs — Dutch, American, Danish, Norwegian, Swedish, Finnish,
   * Italian — because Aurora is one of the commonest vessel names afloat.
   *
   * That output looked like forty-three findings. Acting on any of them would
   * have pointed the board at a stranger and put a client's name on her, which
   * is the same class of error as caching demo positions and drawing them as
   * real — the worst thing this board can do.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const raw = [];
    // Aurora under twenty foreign numbers, as it actually came back.
    const auroras = ['244130216', '367379320', '219018833', '368456530', '253242285',
      '244630029', '257080590', '244060938', '368380740', '259036280', '230110440',
      '265818840', '244180911', '368389610', '219030958', '244860651', '247225520',
      '258125580', '503304700', '235061881'];
    auroras.forEach((m) => raw.push({
      name: 'Aurora', ourMmsi: '533110715', feedMmsi: m, n: 3, ourLoa: null,
      shipType: null, loa: null, beam: null
    }));
    const weighed = Ais._weigh(raw);

    assert.strictEqual(weighed.leads.length, 0, 'not one of them survives');
    assert.strictEqual(weighed.common.length, 1, 'reported once, as a common name');
    assert.strictEqual(weighed.common[0].count, 20);

    const report = settingsModule()._chaseReport({
      seconds: 314, total: 75228, silent: 23, found: [], leads: weighed
    });
    assert.ok(/COMMON NAMES, IGNORED/.test(report));
    assert.ok(/Aurora \(20\)/.test(report), 'named, with its count');
    assert.ok(!/WORTH CHECKING/.test(report), 'and nothing offered to act on');
    assert.ok(/Nothing worth acting on/.test(report), 'the verdict is plain');
    assert.ok(/the numbers in the fleet file are not the problem/.test(report));
  } finally {
    window.Store = original;
  }
});

test('a lead is weighed on more than its name', () => {
  /**
   * Limerence: the one row out of forty-three that was worth a second look.
   * Our record says 319230200, a Cayman number; the feed says 538072789 —
   * Marshall Islands, and sitting immediately before Nero's 538072790, which is
   * one of ours. MMSIs go out in blocks, so yachts under the same management
   * are often numbered together. That is a reason to look, and it is exactly
   * what the first version of this buried under forty-two other rows.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    // Ours flies a Cayman number; the candidate is a Marshall Islands one
    // sitting immediately before another of our boats, exactly as Limerence
    // sits before Nero.
    const ours = s.vessels[0].yacht;
    const neighbour = s.vessels[1].yacht;
    ours.mmsi = 319230200;
    neighbour.mmsi = 538072790;
    neighbour.name = 'Nero';
    window.Store.init(s.vessels.map((v) => v.yacht));

    const weighed = Ais._weigh([{
      name: ours.name, ourMmsi: '319230200', feedMmsi: '538072789',
      n: 6, ourLoa: null, shipType: 37, loa: null, beam: null
    }]);

    assert.strictEqual(weighed.leads.length, 1);
    const lead = weighed.leads[0];
    const why = lead.evidence.join(' | ');
    assert.ok(/broadcasts as a yacht/.test(why), 'ship type 37 is what a yacht sends');
    assert.ok(/numbered next to Nero \(538072790\)/.test(why),
      'and the block allocation is noticed — got: ' + why);
    assert.ok(/flies Marshall Islands, our record says Cayman Islands/.test(why),
      'with the flag difference stated rather than hidden');
    assert.ok(lead.weight >= 6, 'which together is worth reading — got ' + lead.weight);
  } finally {
    window.Store = original;
  }
});

test('a number a digit away from our own reads as a typo, not an allocation', () => {
  // The other way a near-miss happens, and it means something different: a
  // transposed digit lands beside the number already in the record.
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const ours = s.vessels[0].yacht;
    const weighed = Ais._weigh([{
      name: ours.name, ourMmsi: String(ours.mmsi),
      feedMmsi: String(Number(ours.mmsi) + 3),
      n: 6, ourLoa: null, shipType: 37, loa: null, beam: null
    }]);
    const why = weighed.leads[0].evidence.join(' | ');
    assert.ok(/only 3 away from the number we hold/.test(why), 'got: ' + why);
    assert.ok(/mistyped digit/.test(why), 'and says what that looks like');
  } finally {
    window.Store = original;
  }
});

test('a cargo ship sharing a name is ruled out, not listed', () => {
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const ours = s.vessels[0].yacht;
    const weighed = Ais._weigh([{
      name: ours.name, ourMmsi: String(ours.mmsi), feedMmsi: '636092837',
      n: 40, ourLoa: 45, shipType: 70, loa: 229, beam: 32
    }]);
    assert.strictEqual(weighed.leads.length, 0, 'not offered');
    assert.strictEqual(weighed.ruledOut.length, 1, 'and said to have been considered');
    assert.ok(/not a yacht/.test(weighed.ruledOut[0].ruledOut));
  } finally {
    window.Store = original;
  }
});

test('a vessel of the wrong size sharing a name is ruled out', () => {
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const ours = s.vessels[0].yacht;
    const weighed = Ais._weigh([{
      name: ours.name, ourMmsi: String(ours.mmsi), feedMmsi: '244000111',
      n: 9, ourLoa: 45, shipType: 37, loa: 12, beam: 4
    }]);
    assert.strictEqual(weighed.leads.length, 0, 'a 12 m boat is not our 45 m one');
    assert.ok(/12 m and ours is 45 m/.test(weighed.ruledOut[0].ruledOut));
  } finally {
    window.Store = original;
  }
});

test('the report will not let a lead be acted on without checking it', () => {
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const ours = s.vessels[0].yacht;
    const weighed = Ais._weigh([{
      name: ours.name, ourMmsi: String(ours.mmsi), feedMmsi: '319508123',
      n: 14, ourLoa: null, shipType: 37, loa: null, beam: null
    }]);
    const report = settingsModule()._chaseReport({
      seconds: 300, total: 72000, silent: 26,
      found: [{ mmsi: '319071900', name: 'Aviva', n: 3 }], leads: weighed
    });
    assert.ok(/WORTH CHECKING/.test(report), 'offered as a lead');
    assert.ok(/Look each of these up on MarineTraffic before touching the fleet file/
      .test(report.replace(/\n\s*/g, ' ')), 'with the check named first');
    assert.ok(/puts a stranger on the chart under your client's name/
      .test(report.replace(/\n\s*/g, ' ')),
      'and the cost of getting it wrong stated, because silence is the safer failure');
    assert.ok(/TURNED UP AFTER ALL/.test(report), 'the merely slow are listed apart');
  } finally {
    window.Store = original;
  }
});

test('the chase lets go of the feed however it ends', () => {
  const cancel = Ais.chase(300, null, null);
  assert.strictEqual(typeof window.Ais.observer, 'function');
  const r = cancel();
  assert.strictEqual(window.Ais.observer, null, 'released on cancel');
  assert.ok(r && typeof r.total === 'number', 'and hands back what it had');
  assert.strictEqual(cancel(), null, 'stopping twice reports nothing twice');
});

test('a name and nothing else is not a lead', () => {
  /**
   * The second half of the same lesson. Cutting forty-three rows to ten by
   * dropping common names was not enough: of those ten, nine were a yacht in
   * the Mediterranean and a stranger under a flag we do not fly, with no ship
   * type, no length and no other agreement. On a feed of twenty-six thousand
   * vessels that is what coincidence looks like.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const ours = s.vessels[0].yacht;
    ours.mmsi = 319288700;
    window.Store.init(s.vessels.map((v) => v.yacht));
    const weighed = Ais._weigh([{
      name: ours.name, ourMmsi: '319288700', feedMmsi: '503200370',
      n: 8, ourLoa: null, shipType: null, loa: null, beam: null
    }]);

    assert.strictEqual(weighed.leads.length, 0, 'not offered as a lead');
    assert.strictEqual(weighed.nameOnly.length, 1, 'but not hidden either');

    const report = settingsModule()._chaseReport({
      seconds: 314, total: 75228, silent: 23, found: [], leads: weighed
    });
    assert.ok(/NAME ONLY — PROBABLY NOTHING/.test(report));
    assert.ok(!/WORTH CHECKING/.test(report), 'and nothing above it to act on');
    assert.ok(/what coincidence looks like/.test(report.replace(/\n\s*/g, ' ')));
  } finally {
    window.Store = original;
  }
});

test('a busy vessel is not a more likely match for being busy', () => {
  // Message count says she is really out there, which is true of every vessel
  // on the feed. It says nothing about whose she is, so it earns no weight.
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const ours = s.vessels[0].yacht;
    const one = Ais._weigh([{ name: ours.name, ourMmsi: String(ours.mmsi),
      feedMmsi: '503200370', n: 1, ourLoa: null, shipType: null, loa: null, beam: null }]);
    const many = Ais._weigh([{ name: ours.name, ourMmsi: String(ours.mmsi),
      feedMmsi: '503200370', n: 400, ourLoa: null, shipType: null, loa: null, beam: null }]);
    const w = (r) => (r.leads[0] || r.nameOnly[0]).weight;
    assert.strictEqual(w(one), w(many), 'four hundred messages weigh the same as one');
  } finally {
    window.Store = original;
  }
});

test('the neighbour named is the nearest one, not the first one found', () => {
  /**
   * On a fleet registered together several numbers are within range at once —
   * ours has eleven Marshall Islands boats in one block. Naming whichever came
   * first in the file would put an arbitrary boat in the evidence, and the
   * whole point of the line is that the number sits NEXT TO a particular one.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const ours = s.vessels[0].yacht;
    ours.mmsi = 319230200;                       // far away, a Cayman number
    s.vessels[1].yacht.mmsi = 538072700;         // in range, 89 off
    s.vessels[1].yacht.name = 'Rafter';
    s.vessels[2].yacht.mmsi = 538072790;         // in range, 1 off
    s.vessels[2].yacht.name = 'Nero';
    window.Store.init(s.vessels.map((v) => v.yacht));

    const weighed = Ais._weigh([{
      name: ours.name, ourMmsi: '319230200', feedMmsi: '538072789',
      n: 6, ourLoa: null, shipType: 37, loa: null, beam: null
    }]);
    const why = weighed.leads[0].evidence.join(' | ');
    assert.ok(/numbered next to Nero/.test(why),
      'the one it actually sits beside — got: ' + why);
    assert.ok(!/Rafter/.test(why), 'not merely the first in range');
  } finally {
    window.Store = original;
  }
});

test('a vessel id still matches the number it was named for', () => {
  // The convention is name-lastfour. It is only a handle, but one that says
  // 0200 while the record says 2789 is a trap for whoever reads the file next.
  REAL_FLEET.forEach((y) => {
    const tail = y.id.split('-').pop();
    if (!/^\d{4}$/.test(tail)) return;          // not all ids follow it
    assert.strictEqual(tail, String(y.mmsi).slice(-4),
      y.name + "'s id ends " + tail + ' but her MMSI ends ' + String(y.mmsi).slice(-4));
  });
});

/* --- MarineTraffic ---------------------------------------------------------
 *
 * Driven off MarineTraffic's own test fixture, taken from their published
 * client library — real field names, real units, a real sample body. It is not
 * a response this code has seen, which is why MarineTraffic.audit() exists;
 * but it is a great deal better than a shape I made up.
 * ------------------------------------------------------------------------- */

const MT_FIXTURE = JSON.parse(readRepo('tools/fixtures/marinetraffic-ps02.json'));

test('the request goes to the endpoint MarineTraffic documents', () => {
  const u = MarineTraffic.url('KEY-123', {
    endpoint: 'https://services.marinetraffic.com/api/exportvessels',
    timespanMinutes: 60
  });
  assert.strictEqual(u,
    'https://services.marinetraffic.com/api/exportvessels/KEY-123' +
    '/v:8/protocol:jsono/msgtype:simple/timespan:60');

  // jsono, never json. Plain `json` returns bare arrays whose meaning depends
  // on column order — a schema change would silently shift every field by one.
  assert.ok(/protocol:jsono/.test(u));

  // The relay, when there is one, and no trailing-slash surprise.
  assert.ok(/^http:\/\/localhost:9000\/mt\/K\//.test(
    MarineTraffic.url('K', { endpoint: 'http://localhost:9000/mt/', timespanMinutes: 5 })),
    'a configured endpoint is used verbatim, minus any trailing slash');
});

test('speed comes back as knots x10 and is divided', () => {
  /**
   * Their own field description: "The speed (in knots x10)". The fixture says
   * SPEED "74", which is 7.4 knots. Taken at face value the fleet does seventy
   * knots and every yacht reads as underway — including the ones alongside.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const row = Object.assign({}, MT_FIXTURE[0], { MMSI: String(FLEET[0].mmsi) });
    MarineTraffic._apply(row);
    const v = s.byMmsi[String(FLEET[0].mmsi)];
    assert.strictEqual(v.fix.sog, 7.4, '74 is 7.4 knots');
    assert.strictEqual(v.fix.cog, 327, 'course is plain degrees');
    assert.strictEqual(v.fix.heading, 329, 'and so is heading');
    close(v.fix.lat, 47.7585, 0.0001, 'latitude survives being a string');
    close(v.fix.lon, -5.154223, 0.0001, 'longitude too, sign included');
  } finally {
    window.Store = original;
  }
});

test('draught is metres x10, and length is not', () => {
  // Two scaled fields, one unscaled, adjacent in the same response. Getting
  // this uniform either way would be wrong.
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const row = Object.assign({}, MT_FIXTURE[0], { MMSI: String(FLEET[0].mmsi) });
    MarineTraffic._apply(row);
    const v = s.byMmsi[String(FLEET[0].mmsi)];
    assert.strictEqual(v.voyage.draught, 4.4, 'DRAUGHT 44 is 4.4 m');
    close(v.ais.loa, 81.79, 0.01, 'LENGTH is already metres');
    close(v.ais.beam, 11.3, 0.01, 'and so is WIDTH');
  } finally {
    window.Store = original;
  }
});

test('a timestamp with no zone is read as UTC, which is what it is', () => {
  /**
   * Their timestamps are UTC and say so nowhere: "2017-05-19T09:39:57". A
   * date-time in that form is LOCAL time to JavaScript — an hour out in London
   * in summer, two in Monaco. Every fix would be stamped wrong and every age
   * along with it, and "seen 40 minutes ago" would be a confident lie.
   */
  const at = MarineTraffic._parseTime('2017-05-19T09:39:57');
  assert.strictEqual(at.toISOString(), '2017-05-19T09:39:57.000Z');

  // An offset already present is left alone rather than double-stamped.
  assert.strictEqual(MarineTraffic._parseTime('2017-05-19T09:39:57Z').toISOString(),
    '2017-05-19T09:39:57.000Z');
  assert.strictEqual(MarineTraffic._parseTime('2017-05-19T11:39:57+02:00').toISOString(),
    '2017-05-19T09:39:57.000Z');

  // Nonsense is now, not Invalid Date, which would poison every comparison.
  assert.ok(isFinite(MarineTraffic._parseTime('not a date').getTime()));
  assert.ok(isFinite(MarineTraffic._parseTime(null).getTime()));
});

test('the timestamp is read as UTC on a machine that is not', () => {
  /**
   * The check above cannot see this bug. This container runs on UTC, where
   * local time and UTC are the same thing, so parsing "2017-05-19T09:39:57" as
   * local gives the right answer by luck and the assertion passes either way —
   * confirmed by deleting the fix and watching the suite stay green.
   *
   * The board runs in London and Monaco. So this asks a second node, told it
   * is in Tokyo, and that one cannot get the right answer by accident.
   */
  const { execFileSync } = require('child_process');
  const script = `
    global.window = {};
    require('${path.join(__dirname, '..', 'js', 'marinetraffic.js')}');
    process.stdout.write(
      window.MarineTraffic._parseTime('2017-05-19T09:39:57').toISOString());
  `;
  ['Asia/Tokyo', 'America/New_York'].forEach((zone) => {
    const out = execFileSync(process.execPath, ['-e', script], {
      env: Object.assign({}, process.env, { TZ: zone }), encoding: 'utf8'
    });
    assert.strictEqual(out, '2017-05-19T09:39:57.000Z',
      'parsed in ' + zone + ' it is still the same instant');
  });
});

test('an error body with a 200 is not read as an empty fleet', () => {
  /**
   * Their errors arrive as { errors: [...] } with a perfectly ordinary HTTP
   * 200. A handler that only checks the status treats a refused key as a fleet
   * that has gone silent — which is the same reading the AISstream socket gave
   * for a rejected subscription, and it cost days.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    MarineTraffic._receive({ errors: [{ code: '12', detail: 'Invalid API key' }] });
    assert.strictEqual(s.connection, 'rejected', 'said out loud, not drawn as silence');
    assert.ok(/Invalid API key/.test(MarineTraffic.lastError), 'with their words');
    assert.ok(/code 12/.test(MarineTraffic.lastError), 'and their code');
  } finally {
    window.Store = original;
  }
});

test('a vessel that is not ours is ignored', () => {
  // PS02 returns the fleet defined in THEIR account, which may be wider than
  // ours — and one day will be, when somebody adds a boat there and not here.
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    MarineTraffic._apply(MT_FIXTURE[0]);          // MMSI 304010417, a stranger
    assert.strictEqual(s.byMmsi['304010417'], undefined);
    assert.strictEqual(s.vessels.filter((v) => v.fix).length, 0, 'nothing landed');
  } finally {
    window.Store = original;
  }
});

test('where the position came from is kept', () => {
  /**
   * DSRC is 'TER' or 'SAT'. AIS itself does not carry it — it is the provider
   * saying how it heard her — and it is the entire reason for changing
   * provider: a satellite fix is why a yacht mid-ocean appears at all.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    const mmsi = String(FLEET[0].mmsi);
    MarineTraffic._apply(Object.assign({}, MT_FIXTURE[0],
      { MMSI: mmsi, DSRC: 'SAT' }));
    assert.strictEqual(s.byMmsi[mmsi].fix.source, 'SAT');
  } finally {
    window.Store = original;
  }
});

test('the audit says which of ours the account is missing', () => {
  /**
   * PS02 answers with the fleet defined in the MarineTraffic account, not with
   * an MMSI list we send. A yacht missing from that fleet never appears here
   * however long the board runs, and nothing else would ever say why.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    MarineTraffic.mmsiList = FLEET.map((y) => String(y.mmsi));
    const rows = [
      Object.assign({}, MT_FIXTURE[0], { MMSI: String(FLEET[0].mmsi) }),
      Object.assign({}, MT_FIXTURE[0], { MMSI: '999000111' })
    ];
    const a = MarineTraffic._audit(rows);
    assert.strictEqual(a.rows, 2);
    assert.strictEqual(a.matched, 1, 'one of the two was ours');
    assert.deepStrictEqual(a.extra, ['999000111'], 'the other named');
    assert.strictEqual(a.missing.length, FLEET.length - 1,
      'and everyone of ours their account did not return');
    assert.ok(a.missing.includes(String(FLEET[1].mmsi)));
  } finally {
    window.Store = original;
  }
});

test('the audit names a field that never arrived', () => {
  /**
   * The mapping in marinetraffic.js was read off their published client and
   * its fixtures, not off a response this code has seen. A key spelled
   * differently does not throw — the value silently becomes null, and a fleet
   * with no speeds looks like a fleet at anchor.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    MarineTraffic.mmsiList = [];
    const complete = MarineTraffic._audit([MT_FIXTURE[0]]);
    assert.deepStrictEqual(complete.absentFields, [],
      'their own fixture carries every field this file reads');

    const thin = JSON.parse(JSON.stringify(MT_FIXTURE[0]));
    delete thin.SPEED;
    delete thin.DSRC;
    const short = MarineTraffic._audit([thin]);
    assert.deepStrictEqual(short.absentFields.sort(), ['DSRC', 'SPEED']);

    assert.strictEqual(MarineTraffic._audit([]).absentFields, null,
      'and an empty answer is not evidence of a missing field');
  } finally {
    window.Store = original;
  }
});

test('the provider is chosen in one place, and everything stops before anything starts', () => {
  /**
   * The board and the console each carried their own copy of "if there is a
   * key, start the socket, else start the demo" — two places to edit, two to
   * get wrong. And the demo writing invented fixes over real ones is a bug
   * this board has already had: invisible, because invented positions look
   * exactly like positions.
   */
  const feed = readRepo('js/feed.js');
  const stop = feed.slice(feed.indexOf('Feed.stop = function'),
                          feed.indexOf('Feed.restart'));
  assert.ok(/Ais\.stop\(\)/.test(stop) && /Demo\.stop\(\)/.test(stop) &&
            /MarineTraffic\.stop\(\)/.test(stop),
    'all three are stopped, not only the one believed to be running');

  ['js/app.js', 'js/console.js'].forEach((f) => {
    const src = readRepo(f);
    assert.ok(!/Ais\.start\(/.test(src), f + ' no longer picks a provider itself');
    assert.ok(!/Demo\.start\(/.test(src), f + ' does not start the demo itself either');
    assert.ok(/Feed\.start\(\)/.test(src) && /Feed\.restart\(\)/.test(src),
      f + ' goes through Feed');
  });
});

test('feed.js and marinetraffic.js are loaded by both pages, in order', () => {
  ['index.html', 'console.html'].forEach((page) => {
    const html = readRepo(page);
    const at = (f) => html.indexOf('js/' + f);
    assert.ok(at('marinetraffic.js') > -1, page + ' loads the adapter');
    assert.ok(at('vesselapi.js') > -1, page + ' loads the VesselAPI adapter');
    assert.ok(at('feed.js') > at('marinetraffic.js'),
      page + ' loads feed.js after the providers it chooses between');
    assert.ok(at('feed.js') > at('vesselapi.js'),
      page + ' loads feed.js after the VesselAPI adapter too');
    assert.ok(at('feed.js') < at('app.js') || at('app.js') === -1,
      page + ' has Feed defined before the page that calls it');
  });
});

/* --- Three things only the running console showed ------------------------- */

test('restarting onto the same provider and key does nothing', () => {
  /**
   * A billing loop, found by driving the adapter against a stand-in and
   * watching the request count climb: each answer filled in a length or a call
   * sign, the console adopted it, adopting reloaded the fleet, reloading
   * restarted the feed, and the restart fetched again.
   *
   * Free and pushed, a needless reconnect is untidy. Billed by the call, it is
   * a loop with an invoice attached.
   */
  const feed = readRepo('js/feed.js');
  const restart = feed.slice(feed.indexOf('Feed.restart = function'),
                             feed.indexOf('function mmsis'));
  assert.ok(/if \(Feed\.running === wanted\) return false;/.test(restart),
    'the same provider on the same key is not a restart');
  assert.ok(/Feed\.stop\(\)/.test(restart) && /Feed\.start\(\)/.test(restart),
    'and a genuine change still bounces it');

  const start = feed.slice(feed.indexOf('Feed.start = function'),
                           feed.indexOf('Feed.stop = function'));
  assert.ok(/Feed\.running = provider/.test(start), 'start records what is running');
  assert.ok(/Feed\.running = null/.test(
    feed.slice(feed.indexOf('Feed.stop = function'), feed.indexOf('Feed.restart'))),
    'and stop forgets it, so the next start is never skipped');
});

test('a batch is saved before anyone is told about it', () => {
  /**
   * recompute() notifies the console, which adopts what the batch filled in,
   * which reloads the fleet, which re-inits the Store — and Store.init restores
   * from the cache. Persisting afterwards meant restore read a cache written
   * before the batch existed: a poll that fetched twelve vessels ended with
   * none, every fix applied and then thrown away by the reload it provoked.
   *
   * The store was empty after a request that had plainly worked.
   */
  const src = readRepo('js/marinetraffic.js');
  const receive = src.slice(src.indexOf('function receive('),
                            src.indexOf('function apply('));
  const persist = receive.indexOf('Store.persist()');
  const recompute = receive.indexOf('Store.recompute()');
  assert.ok(persist !== -1 && recompute !== -1, 'it does both');
  assert.ok(persist < recompute, 'and saves first');
});

test('crossing between simulated and real empties the store', () => {
  /**
   * Demo mode writes invented fixes down the same path as a live one, so
   * afterwards nothing tells them apart: a yacht heard in the simulation still
   * counted as heard once the key went in, and the console read thirteen of
   * sixty-one when the answer held twelve.
   *
   * The board has already drawn invented positions as real once. It is the
   * worst thing it can do and it is invisible.
   */
  const feed = readRepo('js/feed.js');
  const start = feed.slice(feed.indexOf('Feed.start = function'),
                           feed.indexOf('Feed.stop = function'));
  assert.ok(/if \(window\.Store\.mode !== mode\)/.test(start),
    'only when the mode actually changes');
  assert.ok(/window\.Store\.init\(window\.FLEET\)/.test(start),
    'and the store is rebuilt, which restores only a cache stamped live');

  // The store side of the same promise, which is what makes the rebuild safe.
  const store = readRepo('js/store.js');
  assert.ok(/if \(Store\.mode !== 'live'\) return;/.test(store),
    'nothing is cached in demo mode');
  assert.ok(/payload\.mode !== 'live'/.test(store),
    'and nothing not stamped live is restored');
});

test('where a position came from survives the cache', () => {
  // TER against SAT is the reason for changing provider at all. Dropped on a
  // reload it would look like the satellite positions had stopped.
  const store = readRepo('js/store.js');
  ['source: fix.source', 'source: v.fix.source', 'source: saved.fix.source']
    .forEach((needle) => {
      assert.ok(store.indexOf(needle) !== -1,
        'carried through: ' + needle);
    });
});

test('the timespan asked for is one they will serve', () => {
  /**
   * From their own PS02 query parameters: "Maximum value for terrestrial
   * coverage is 60. Maximum value for satellite coverage is 180." Asking for
   * more than the plan allows is a refusal, and a board does not recover from
   * one of those on its own at three in the morning.
   */
  assert.strictEqual(MarineTraffic.timespan({ timespanMinutes: 60 }), 60);
  assert.strictEqual(MarineTraffic.timespan({ timespanMinutes: 240 }), 60,
    'clamped to the terrestrial ceiling');
  assert.strictEqual(MarineTraffic.timespan({ timespanMinutes: 240, satellite: true }), 180,
    'and to the satellite one when the plan has satellite');
  assert.strictEqual(MarineTraffic.timespan({ timespanMinutes: 30, satellite: true }), 30,
    'a smaller ask is left alone');
  assert.strictEqual(MarineTraffic.timespan({}), 60, 'the default is the ceiling');
  assert.strictEqual(MarineTraffic.timespan({ satellite: true }), 180);
  // Zero is treated as unset rather than honoured: "look back over no time at
  // all" is a typo, not a request, and the forgiving reading is the one that
  // leaves a board working.
  assert.strictEqual(MarineTraffic.timespan({ timespanMinutes: 0 }), 60);
  assert.ok(MarineTraffic.timespan({ timespanMinutes: -5 }) >= 1,
    'and a negative never asks for a negative window');
});

/* --- Checking a provider before integrating one --------------------------- */

test('the provider check finds the records whatever they are wrapped in', () => {
  /**
   * Providers disagree about the envelope: MarineTraffic answers with a bare
   * array, others wrap it in {vessels: []}, {data: []}, {results: []}. Guessing
   * the key means the tool works for one provider and silently reports "0 of
   * 61" for the next — which is indistinguishable from the answer that would
   * make us reject them.
   */
  const { execFileSync } = require('child_process');
  const tool = path.join(__dirname, 'check-provider.js');
  const tmp = path.join(require('os').tmpdir(), 'fw-provider-test.json');
  const run = (body) => {
    fs.writeFileSync(tmp, JSON.stringify(body));
    return execFileSync(process.execPath, [tool, tmp], { encoding: 'utf8' });
  };
  const row = (y) => ({ mmsi: String(y.mmsi), latitude: 43.5, longitude: 7.1 });
  const three = REAL_FLEET.slice(0, 3).map(row);

  ['vessels', 'data', 'results'].forEach((key) => {
    const out = run({ [key]: three });
    assert.ok(/3 of 61 carried/.test(out), 'found inside {' + key + ': []}');
  });
  assert.ok(/3 of 61 carried/.test(run(three)), 'and as a bare array');

  // The longest list wins: an answer carrying a short "meta" or "errors" array
  // alongside the fleet must not be read as the fleet.
  const out = run({ warnings: [{ code: 'x' }], vessels: three });
  assert.ok(/3 of 61 carried/.test(out), 'the fleet, not the warnings');

  fs.unlinkSync(tmp);
});

test('the provider check names the vessels a feed does not carry', () => {
  // The list of what is MISSING is the output that decides a provider. A count
  // alone cannot be acted on; a name can be looked up on another site.
  const { execFileSync } = require('child_process');
  const tool = path.join(__dirname, 'check-provider.js');
  const tmp = path.join(require('os').tmpdir(), 'fw-provider-missing.json');
  fs.writeFileSync(tmp, JSON.stringify(
    REAL_FLEET.slice(0, 2).map((y) => ({ mmsi: String(y.mmsi) }))));
  const out = execFileSync(process.execPath, [tool, tmp], { encoding: 'utf8' });

  assert.ok(/2 of 61 carried/.test(out));
  assert.ok(/NOT carried \(59\)/.test(out));
  assert.ok(out.includes(REAL_FLEET[3].name), 'by name');
  assert.ok(out.includes(String(REAL_FLEET[3].mmsi)), 'and by number');

  // Sentinel vessels are marked, because those are the ones whose absence
  // actually breaks a service commitment. Taken from the vessels the response
  // did NOT include, so it is genuinely in the missing list — the first version
  // of this leaned on a helper that always returned false, which meant the
  // assertion never ran at all.
  const returned = new Set(REAL_FLEET.slice(0, 2).map((y) => String(y.mmsi)));
  const sentinel = REAL_FLEET.find((y) => y.sentinel && !returned.has(String(y.mmsi)));
  assert.ok(sentinel, 'the fleet has a Sentinel vessel outside the two returned');
  assert.ok(new RegExp(sentinel.name + '\\s+\\[Sentinel\\]').test(out),
    'and a missing Sentinel yacht is flagged as one');
  fs.unlinkSync(tmp);
});

test('an empty answer is reported as a failed request, not as 61 absences', () => {
  /**
   * A refused key comes back as an ordinary HTTP 200 with an error in the body.
   * Listing all sixty-one as "not carried" buries the one line that matters
   * under sixty-one lines of noise, and reads as a damning coverage verdict
   * when it is really "the request did not work".
   */
  const { execFileSync } = require('child_process');
  const tool = path.join(__dirname, 'check-provider.js');
  const tmp = path.join(require('os').tmpdir(), 'fw-provider-refused.json');
  fs.writeFileSync(tmp, JSON.stringify({ error: { message: 'API key not recognised' } }));
  const out = execFileSync(process.execPath, [tool, tmp], { encoding: 'utf8' });

  assert.ok(/0 of 61 carried/.test(out));
  assert.ok(!/NOT carried/.test(out), 'no list of sixty-one');
  assert.ok(/Nothing came back/.test(out), 'the request is named as the problem');
  assert.ok(/ordinary HTTP 200/.test(out), 'with the reason it can look like success');
  fs.unlinkSync(tmp);
});

test('an MMSI is recognised by its shape, not only by its field name', () => {
  // A provider that calls it `vesselId`, or returns it as a number rather than
  // a string, is still matched — otherwise the tool reports zero coverage for a
  // feed that has everything, which is the worst answer it could give.
  const { execFileSync } = require('child_process');
  const tool = path.join(__dirname, 'check-provider.js');
  const tmp = path.join(require('os').tmpdir(), 'fw-provider-shape.json');
  const run = (rows) => {
    fs.writeFileSync(tmp, JSON.stringify(rows));
    return execFileSync(process.execPath, [tool, tmp], { encoding: 'utf8' });
  };

  assert.ok(/2 of 61/.test(run(REAL_FLEET.slice(0, 2)
    .map((y) => ({ vesselId: String(y.mmsi) })))), 'an unexpected key name');
  assert.ok(/2 of 61/.test(run(REAL_FLEET.slice(0, 2)
    .map((y) => ({ mmsi: y.mmsi })))), 'a number rather than a string');

  // And an IMO must not be mistaken for one: seven digits, wrong shape.
  assert.ok(/0 of 61/.test(run([{ imo: 9249403 }, { imo: 9015462 }])),
    'an IMO is not an MMSI');
  fs.unlinkSync(tmp);
});

test('one request carries the whole fleet, and never the key', () => {
  // The two things that decide whether a provider is usable at all: can it be
  // asked for sixty-one vessels at once, and does the key stay out of the URL.
  // A URL is logged by every proxy it passes and printed to the terminal by
  // this very tool; a header is not.
  const { buildUrl } = require(path.join(__dirname, 'fetch-vesselapi.js'));
  const url = buildUrl(REAL_FLEET.map((y) => y.mmsi));
  const ids = decodeURIComponent(new URL(url).searchParams.get('filter.ids'));

  assert.strictEqual(ids.split(',').length, REAL_FLEET.length,
    'every vessel in the one request');
  REAL_FLEET.forEach((y) => {
    assert.ok(ids.split(',').indexOf(String(y.mmsi)) !== -1, y.name + ' is asked for');
  });
  assert.strictEqual(new URL(url).searchParams.get('filter.idType'), 'mmsi');

  const src = readRepo('tools/fetch-vesselapi.js');
  assert.ok(/Authorization/.test(src), 'the key travels in a header');
  assert.ok(!/searchParams\.set\(\s*['"](key|apikey|api_key|token)/i.test(src),
    'and never in the query string');
  // Nor to disk. The response is saved; the key is not part of it.
  assert.ok(!/writeFileSync\([^)]*\bkey\b/.test(src), 'the key is never written out');
});

test('the endpoint can be pointed elsewhere, so it can be driven without a key', () => {
  // Every provider adapter on this project was got wrong first and found out by
  // running it against a stand-in. A tool that can only talk to the real
  // service can only be tested by spending quota on it.
  const { buildUrl } = require(path.join(__dirname, 'fetch-vesselapi.js'));
  const url = buildUrl([123456789],
    { base: 'http://127.0.0.1:8791', pathname: '/v2/elsewhere' });
  assert.strictEqual(new URL(url).origin, 'http://127.0.0.1:8791');
  assert.strictEqual(new URL(url).pathname, '/v2/elsewhere');
});

test('the same fix heard twice counts once, and the newest one wins', () => {
  // The first real answer carried RADIANT at 22:32:42.238727Z and again at
  // 22:32:42Z — one broadcast, two records. Counting reports as vessels would
  // have flattered the feed; taking the older of two as current would have put
  // a yacht back where she was.
  const { newestPerVessel } = require(path.join(__dirname, 'fetch-vesselapi.js'));
  const best = newestPerVessel([
    { mmsi: 319012900, timestamp: '2026-09-08T22:32:42Z', longitude: 1 },
    { mmsi: 319012900, timestamp: '2026-09-08T22:36:00Z', longitude: 2 },
    { mmsi: 232058397, timestamp: '2026-09-08T22:35:47Z', longitude: 3 }
  ]);
  assert.strictEqual(best.size, 2, 'two vessels, not three reports');
  assert.strictEqual(best.get('319012900').row.longitude, 2, 'the newer fix');
});

test('the records and the cursor are found without knowing their key names', () => {
  // Their list is called `vesselPositions` today. A tool that hard-codes that
  // reports zero coverage the day it is renamed, which reads as a provider
  // that has lost the fleet.
  const { readPage } = require(path.join(__dirname, 'fetch-vesselapi.js'));
  const page = readPage({
    vesselPositions: [{ mmsi: 319012900 }, { mmsi: 232058397 }],
    nextToken: 'abc'
  });
  assert.strictEqual(page.rows.length, 2);
  assert.strictEqual(page.token, 'abc');

  const renamed = readPage({ data: { positions: [{ mmsi: 1 }, { mmsi: 2 }, { mmsi: 3 }] } });
  assert.strictEqual(renamed.rows.length, 3, 'nested and renamed, still found');
  assert.strictEqual(renamed.token, null, 'no cursor is null, not undefined');

  // A response that carries a second, shorter list of objects — a warnings
  // array, an errors array — must not be mistaken for the records.
  const twoLists = readPage({
    warnings: [{ code: 7 }],
    vesselPositions: [{ mmsi: 1 }, { mmsi: 2 }, { mmsi: 3 }]
  });
  assert.strictEqual(twoLists.rows.length, 3, 'the longer list is the records');
});

test('a page size can be asked for, so the cost of the stream can be divided', () => {
  // The bill follows how much the fleet talks divided by the page size, so the
  // page size is the only lever there is. A flag that quietly did nothing would
  // read as a provider that will not serve more than twenty.
  const { buildUrl } = require(path.join(__dirname, 'fetch-vesselapi.js'));
  assert.strictEqual(
    new URL(buildUrl([123456789], { limit: 200 })).searchParams.get('limit'), '200');
  assert.strictEqual(
    new URL(buildUrl([123456789], {})).searchParams.get('limit'), null,
    'and not sent at all when it was not asked for');

  // The cursor goes back under a name, and the name is a guess with an
  // override — so it has to be the override that is honoured.
  assert.strictEqual(
    new URL(buildUrl([1], { token: 'abc', tokenParam: 'pageToken' }))
      .searchParams.get('pageToken'), 'abc');
});

/* -----------------------------------------------------------------------------
 * VesselAPI — the third provider, and the first that is a stream.
 *
 * The fixture is the shape of a real response: the field set, the duplicate
 * fixes, the rows that arrive with no `cog` and no `imo`, the cursor. The
 * positions and the day are invented, because a repository is a poor place to
 * archive where anyone's yacht actually was on a particular night.
 * ------------------------------------------------------------------------- */

const VA_FIXTURE = JSON.parse(readRepo('tools/fixtures/vesselapi-stream.json'));
const VA_ROWS = VA_FIXTURE.vesselPositions;

// The fixture carries real MMSIs, so these run against the real fleet rather
// than the sample one.
function realStore() {
  Store.listeners = [];
  Store.init(REAL_FLEET);
  Store.vessels.forEach((v) => { v.fix = null; v.track = []; v.voyage = {}; v.ais = null; });
  return Store;
}

function withStore(fn) {
  const original = window.Store;
  const s = realStore();
  window.Store = s;
  VesselApi.mmsiList = REAL_FLEET.map((y) => String(y.mmsi));
  try { return fn(s); } finally { window.Store = original; }
}

test('all sixty-one are asked for at once, and the key is never in the URL', () => {
  // Bulk is the only reason this provider is affordable: one request covers the
  // fleet. And a URL is logged by every proxy it passes and printed by every
  // diagnostic that touches it, so the key travels in a header instead.
  const mmsis = REAL_FLEET.map((y) => String(y.mmsi));
  const u = VesselApi.url('SECRET-KEY', mmsis, null);
  const ids = decodeURIComponent(new URL(u).searchParams.get('filter.ids'));

  assert.strictEqual(ids.split(',').length, REAL_FLEET.length);
  assert.ok(!/SECRET-KEY/.test(u), 'the key is not in the URL');
  assert.ok(/Authorization/.test(readRepo('js/vesselapi.js')),
    'it travels in a header instead');
});

test('the cursor and the page size go back under names that can be corrected', () => {
  /**
   * Both are guesses. A response names its cursor `nextToken` but says nothing
   * about what to call it going back, and nothing about asking for a bigger
   * page — and page size divides the monthly bill directly. Guesses belong in
   * config where they can be fixed without touching code.
   */
  const original = CONFIG.vesselApi;
  CONFIG.vesselApi = {
    endpoint: 'http://relay.local/v', pageSize: 200,
    pageParam: 'page_size', cursorParam: 'cursor'
  };
  try {
    const u = new URL(VesselApi.url('K', ['123456789'], 'TOK'));
    assert.strictEqual(u.searchParams.get('page_size'), '200');
    assert.strictEqual(u.searchParams.get('cursor'), 'TOK');
    assert.strictEqual(u.origin + u.pathname, 'http://relay.local/v',
      'the relay endpoint is used verbatim');

    CONFIG.vesselApi = { endpoint: 'http://relay.local/v' };
    const bare = new URL(VesselApi.url('K', ['123456789'], null));
    assert.strictEqual(bare.searchParams.get('limit'), null,
      'no page size is asked for when none is set');
    assert.strictEqual(bare.searchParams.get('nextToken'), null,
      'and no cursor on the first page');
  } finally { CONFIG.vesselApi = original; }
});

test('one broadcast heard twice is one fix, and the newer report wins', () => {
  /**
   * The first real answer had one yacht at 22:32:42.238727Z and again at
   * 22:32:42Z — same position, different processing times, plainly a single
   * transmission carried twice. Applied as they arrive, every duplicate counts
   * as another message received and the console's reception figures overstate
   * the feed it is there to measure.
   */
  withStore((s) => {
    const before = s.messageCount;
    VesselApi.since = null;
    const audit = VesselApi._done(VA_ROWS, 1, false);

    const reports = VA_ROWS.length;
    const vessels = new Set(VA_ROWS.filter((r) => !r.suspected_glitch)
      .map((r) => String(r.mmsi))).size;
    assert.ok(reports > vessels, 'the fixture does carry duplicates');
    assert.strictEqual(s.messageCount - before, vessels,
      'one message counted per vessel, not per report');
    assert.strictEqual(audit.heard, vessels);

    // ANAWA appears three times; the newest is the one on the chart.
    const anawa = VA_ROWS.filter((r) => r.vessel_name === 'ANAWA')
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
    const held = s.byMmsi[String(anawa.mmsi)];
    assert.strictEqual(held.fix.at.toISOString(), new Date(anawa.timestamp).toISOString());
    assert.strictEqual(held.fix.lon, anawa.longitude);
  });

  /**
   * And again with the page reversed.
   *
   * They answer newest first, so taking whichever duplicate comes first in the
   * list happens to be right and this check passed against code that did — I
   * only found that by making it take the older one and watching the suite stay
   * green. Their order is their business, not a promise to us.
   */
  withStore((s) => {
    VesselApi.since = null;
    VesselApi._done(VA_ROWS.slice().reverse(), 1, false);
    const anawa = VA_ROWS.filter((r) => r.vessel_name === 'ANAWA')
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
    assert.strictEqual(
      s.byMmsi[String(anawa.mmsi)].fix.at.toISOString(),
      new Date(anawa.timestamp).toISOString(),
      'the newest report wins whatever order it arrives in');
  });
});

test('a report their own pipeline doubts is not drawn', () => {
  // `suspected_glitch` is their quality flag. A position they do not believe is
  // a yacht drawn in a field, and the last good fix ageing honestly is better.
  const glitched = VA_ROWS.filter((r) => r.suspected_glitch);
  assert.ok(glitched.length, 'the fixture exercises the flag');

  withStore((s) => {
    VesselApi.since = null;
    const audit = VesselApi._done(glitched, 1, false);
    assert.strictEqual(audit.glitches, glitched.length);
    assert.strictEqual(audit.heard, 0);
    assert.strictEqual(s.byMmsi[String(glitched[0].mmsi)].fix, null,
      'nothing was drawn from it');
  });
});

test('speed is plain knots, and the timestamp is the instant they meant', () => {
  /**
   * MarineTraffic reports knots x10 and a UTC time with no zone on it; taking
   * either at face value put the fleet at seventy knots and every age an hour
   * out. VesselAPI does neither — sog is knots and the stamp carries a Z — but
   * that is checked here rather than believed, because both have already cost
   * this project a day.
   */
  const moving = VA_ROWS.filter((r) => r.sog > 0)
    .sort((a, b) => b.sog - a.sog)[0];
  assert.ok(moving && moving.sog < 30,
    'the fastest in the fixture is a plausible speed, not a scaled one');

  withStore((s) => {
    VesselApi._apply(String(moving.mmsi), moving, new Date(moving.timestamp));
    const fix = s.byMmsi[String(moving.mmsi)].fix;
    assert.strictEqual(fix.sog, moving.sog, 'not divided by ten');
    assert.strictEqual(fix.cog, moving.cog);
    assert.strictEqual(fix.navStatus, moving.nav_status);
    assert.strictEqual(fix.lat, moving.latitude);
    assert.strictEqual(fix.source, null,
      'they do not say shore or satellite, so we do not claim either');
  });
});

test('a stamp with a zone on it is not given a second one', () => {
  /**
   * The MarineTraffic adapter appends a Z because theirs have none. Doing the
   * same here would corrupt a stamp that already carries one — and this
   * container runs on UTC, where the damage is invisible, so it is asked of a
   * node that thinks it is in Tokyo.
   */
  const { execFileSync } = require('child_process');
  const script = `
    global.window = { CONFIG: { vesselApi: {} } };
    require('${path.join(__dirname, '..', 'js', 'vesselapi.js')}');
    process.stdout.write(
      window.VesselApi._parseTime('2026-09-08T22:36:31.138103Z').toISOString());
  `;
  ['Asia/Tokyo', 'America/New_York'].forEach((zone) => {
    const out = execFileSync(process.execPath, ['-e', script], {
      env: Object.assign({}, process.env, { TZ: zone }), encoding: 'utf8'
    });
    assert.strictEqual(out, '2026-09-08T22:36:31.138Z',
      'parsed in ' + zone + ' it is still the same instant');
  });
});

test('a vessel that is not ours is reported rather than quietly dropped', () => {
  /**
   * Everything in the first real answer was ours, which is the finding that
   * separates this provider from AISstream — whose MMSI filter returned almost
   * nothing and whose unfiltered feed returned twenty-six thousand vessels. If
   * that ever stops being true, the cost model stops being true with it, and
   * nothing else on the board would say so.
   */
  withStore(() => {
    VesselApi.mmsiList = REAL_FLEET.map((y) => String(y.mmsi));
    VesselApi.since = null;
    const audit = VesselApi._done(VA_ROWS.concat([{
      mmsi: 244660000, vessel_name: 'A STRANGER',
      latitude: 52.1, longitude: 4.3, timestamp: VA_ROWS[0].timestamp
    }]), 1, false);
    assert.deepStrictEqual(audit.strangers, ['244660000']);
  });
});

test('a page is not a fleet, and the audit says how far back it reached', () => {
  /**
   * Twenty records held twelve yachts over four minutes. Read as coverage that
   * says twelve of sixty-one and this provider gets written off on a number
   * that means nothing: the other forty-nine had simply not spoken yet. The
   * window is what makes the count readable.
   */
  withStore(() => {
    VesselApi.mmsiList = REAL_FLEET.map((y) => String(y.mmsi));
    VesselApi.since = null;
    const audit = VesselApi._done(VA_ROWS, 1, false);
    assert.ok(audit.windowMinutes > 3 && audit.windowMinutes < 6,
      'the window is minutes, and it is measured: ' + audit.windowMinutes);
    assert.ok(audit.heard < REAL_FLEET.length / 2,
      'and it holds nothing like the whole fleet');
    assert.strictEqual(audit.reports, VA_ROWS.length);
  });
});

test('the watermark means a second read applies nothing already seen', () => {
  /**
   * This is the whole economics of a stream. Reading only what is new makes a
   * poll cost a request per page of NEW reports, so looking every three minutes
   * and looking every thirty cost very nearly the same — and the board can be
   * three minutes fresh for the price of being half an hour stale.
   */
  withStore((s) => {
    VesselApi.since = null;
    VesselApi._done(VA_ROWS, 1, false);
    const after = s.messageCount;
    const mark = VesselApi.since;
    assert.ok(mark instanceof Date, 'a watermark was set');

    VesselApi._done(VA_ROWS, 1, false);
    assert.strictEqual(s.messageCount, after,
      'the same reports a second time change nothing');
    assert.strictEqual(VesselApi.since.getTime(), mark.getTime(),
      'and the watermark does not move backwards');
  });
});

test('paging stops when the cursor is ignored, and inside its budget', () => {
  /**
   * Two ways a stream reader empties a month's allowance in an afternoon, both
   * silent on the board — the positions simply stop moving.
   *
   * A cursor sent back under a name the server does not accept returns page one
   * again, for ever. And a poll with no ceiling follows a stream that has
   * started repeating itself as far as it goes. Driven here through a stand-in
   * fetch, in a second node so the fake cannot leak into the rest of the suite.
   */
  const { execFileSync } = require('child_process');
  const run = (mode, cfg) => {
    const script = `
      global.window = {};
      global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
      const load = (f) => require('${path.join(__dirname, '..')}/' + f);
      ['config.js', 'fleet.js', 'data/mid.js', 'data/ports.js', 'js/geo.js',
       'js/format.js', 'js/store.js', 'js/vesselapi.js'].forEach(load);
      const W = global.window;
      Object.assign(W.CONFIG.vesselApi, ${JSON.stringify(cfg)});
      W.Store.init(W.FLEET);
      let served = 0;
      W.fetch = function () {
        served++;
        const at = new Date(Date.now() - served * 1000).toISOString();
        const page = '${mode}' === 'ignore'
          ? { vesselPositions: [{ mmsi: W.FLEET[0].mmsi, latitude: 40, longitude: 5,
                                  timestamp: '2020-01-02T10:00:00.000Z' }],
              nextToken: 'T' + served }
          : { vesselPositions: [{ mmsi: W.FLEET[served % 40].mmsi, latitude: 40,
                                  longitude: 5, timestamp: at }],
              nextToken: 'T' + served };
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(page); } });
      };
      W.VesselApi.start('K', W.FLEET.map((y) => String(y.mmsi)));
      // The interval only, not stop(): stopping sets the flag the paging loop
      // itself checks, so the run under test would end after its first page.
      clearInterval(W.VesselApi.timer);
      setTimeout(function () {
        process.stdout.write(JSON.stringify({
          calls: W.VesselApi.calls, error: W.VesselApi.lastError
        }));
      }, 200);
    `;
    return JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
  };

  const ignored = run('ignore', { backfillPages: 20 });
  assert.strictEqual(ignored.calls, 2,
    'one wasted request to notice, and then it stops');
  assert.ok(/cursorParam/.test(ignored.error || ''),
    'and it says what to set: ' + ignored.error);

  const budgeted = run('walk', { backfillPages: 5 });
  assert.strictEqual(budgeted.calls, 5, 'a poll never exceeds its budget');
  assert.strictEqual(budgeted.error, null, 'and that is not an error');
});

/* -----------------------------------------------------------------------------
 * The relay — one reader for the whole company.
 *
 * These run the server's own modules directly. The HTTP ones start it in a
 * second node and ask it real questions, because the things worth checking
 * about a static server — that it will not serve /etc/passwd, that it will not
 * serve its own configuration — are properties of what it answers, not of what
 * it intends.
 * ------------------------------------------------------------------------- */

const relayConfig = require(path.join(__dirname, '..', 'server', 'config.js'));
const relayStore = require(path.join(__dirname, '..', 'server', 'store.js'));

test('a relay with no settings says what is missing, and still starts', () => {
  /**
   * An app that refuses to boot on a missing setting tells you only that it is
   * down. This one serves the board, reports the fault on /api/health, and is
   * therefore diagnosable from a phone at eight in the morning.
   */
  const problems = relayConfig.problems(relayConfig.read({}));
  assert.ok(problems.some((p) => /FEED_PROVIDER/.test(p)));
  assert.ok(problems.some((p) => /FEED_KEY/.test(p)));
  assert.ok(problems.every((p) => /\.$/.test(p.trim())),
    'each is a sentence someone can act on');

  const named = relayConfig.problems(relayConfig.read(
    { FEED_PROVIDER: 'marinetraffic', FEED_KEY: 'k' }));
  assert.ok(named.some((p) => /not a provider/.test(p)),
    'a provider this relay does not have is named, not ignored');

  assert.strictEqual(
    relayConfig.problems(relayConfig.read(
      { FEED_PROVIDER: 'vesselapi', FEED_KEY: 'k' })).length, 0);
});

test('the relay reads PORT from Azure and nothing else', () => {
  // App Service picks the port and tells the app through PORT. A hard-coded one
  // means a container that starts, logs nothing wrong, and is never reachable.
  assert.strictEqual(relayConfig.read({ PORT: '1234' }).port, 1234);
  assert.strictEqual(relayConfig.read({}).port, 8080);
});

test('the relay store refuses what the board would draw wrongly', () => {
  const fleet = [{ mmsi: 235070865, name: 'A' }, { mmsi: 319012900, name: 'B' }];
  const s = relayStore.create(fleet, {});
  const at = new Date('2026-09-08T22:00:00Z');

  assert.strictEqual(s.applyFix('235070865', { lat: 43, lon: 7, at: at }), true);
  assert.strictEqual(s.applyFix('999999999', { lat: 43, lon: 7, at: at }), false,
    'a vessel that is not ours');
  assert.strictEqual(s.applyFix('319012900', { lat: 91, lon: 7, at: at }), false,
    'an impossible latitude');
  assert.strictEqual(s.applyFix('319012900', { lat: 43, lon: 7, at: 'not a date' }),
    false, 'a timestamp that is not one');

  // A page of stream history arrives in whatever order it likes, and a yacht
  // must never walk backwards on a wall board.
  const earlier = new Date('2026-09-08T21:00:00Z');
  assert.strictEqual(s.applyFix('235070865', { lat: 44, lon: 8, at: earlier }), false);
  assert.strictEqual(s.byMmsi['235070865'].fix.lat, 43);
});

test('a yacht alongside does not fill the snapshot with the same berth', () => {
  /**
   * She broadcasts every three minutes for a fortnight. Recorded
   * unconditionally that is a quarter of a million identical points, all of
   * them at the same pontoon, in every snapshot written and every board served.
   */
  const s = relayStore.create([{ mmsi: 235070865, name: 'A' }], {});
  for (let i = 0; i < 50; i++) {
    s.applyFix('235070865', {
      lat: 43.5, lon: 7.1, at: new Date(Date.UTC(2026, 8, 8, 20, i))
    });
  }
  assert.strictEqual(s.byMmsi['235070865'].track.length, 1);

  s.applyFix('235070865', { lat: 43.9, lon: 7.6, at: new Date(Date.UTC(2026, 8, 8, 21)) });
  assert.strictEqual(s.byMmsi['235070865'].track.length, 2, 'but a passage is kept');
});

test('the track is capped, so a relay left running does not grow for ever', () => {
  const s = relayStore.create([{ mmsi: 235070865, name: 'A' }], { trackPoints: 10 });
  for (let i = 0; i < 40; i++) {
    s.applyFix('235070865', {
      lat: 43 + i * 0.01, lon: 7 + i * 0.01, at: new Date(Date.UTC(2026, 8, 8, 20, i))
    });
  }
  assert.strictEqual(s.byMmsi['235070865'].track.length, 10);
  assert.ok(Math.abs(s.byMmsi['235070865'].track[9][0] - 7.39) < 0.001,
    'and it is the newest ten that are kept');
});

test('tracks are asked for, not sent', () => {
  /**
   * They are two orders of magnitude larger than the positions and a board only
   * needs them when it opens. A screen polling every thirty seconds would
   * otherwise pull a third of a megabyte each time to redraw lines it already
   * has — on every screen, for ever.
   */
  const s = relayStore.create([{ mmsi: 235070865, name: 'A' }], {});
  for (let i = 0; i < 20; i++) {
    s.applyFix('235070865', {
      lat: 43 + i * 0.02, lon: 7 + i * 0.02, at: new Date(Date.UTC(2026, 8, 8, 20, i))
    });
  }
  assert.strictEqual(s.snapshot(false).vessels[0].track, undefined);
  assert.strictEqual(s.snapshot(true).vessels[0].track.length, 20);
  // Twenty points already treble the answer for one yacht. Across sixty-one,
  // with the full run kept, it is the difference between eight kilobytes a poll
  // and a third of a megabyte — every thirty seconds, on every screen.
  assert.ok(JSON.stringify(s.snapshot(true)).length >
            JSON.stringify(s.snapshot(false)).length * 3,
    'which is why it is not sent every thirty seconds');
});

test('the snapshot carries positions and nothing about how they were got', () => {
  // It goes to every screen, and one of them will eventually be somewhere it
  // should not be.
  const s = relayStore.create([{ mmsi: 235070865, name: 'A' }], {});
  s.applyFix('235070865', { lat: 43, lon: 7, at: new Date() });
  const text = JSON.stringify(s.snapshot(true));
  ['key', 'Bearer', 'Authorization', 'endpoint', 'vesselapi.com', 'aisstream']
    .forEach((word) => {
      assert.ok(text.toLowerCase().indexOf(word.toLowerCase()) === -1,
        'the snapshot must not mention ' + word);
    });
});

test('a restart costs one request, not a backfill', () => {
  /**
   * Azure restarts this app whenever it likes. Restoring the fleet is what
   * stops the board blanking — but the watermark coming back with it is what
   * stops the reader paging from nothing on a metered plan. Measured on a real
   * restart against a stand-in: twelve requests became one.
   */
  const fleet = [{ mmsi: 235070865, name: 'A' }, { mmsi: 319012900, name: 'B' }];
  const before = relayStore.create(fleet, {});
  const newest = new Date('2026-09-08T22:30:00Z');
  before.applyFix('235070865', { lat: 43, lon: 7, at: new Date('2026-09-08T22:00:00Z') });
  before.applyFix('319012900', { lat: 44, lon: 8, at: newest, sog: 12 });
  before.applyIdentity('319012900', { name: 'B', imo: 9249403 });

  const after = relayStore.create(fleet, {});
  assert.strictEqual(after.watermark(), null, 'a cold store has nowhere to resume from');
  assert.strictEqual(after.restore(JSON.parse(JSON.stringify(before.snapshot(true)))), 2);
  assert.strictEqual(after.watermark().getTime(), newest.getTime(),
    'and a restored one resumes where it got to');
  assert.strictEqual(after.byMmsi['319012900'].fix.sog, 12);
  assert.strictEqual(after.byMmsi['319012900'].ais.imo, 9249403);
});

test('the relay serves the board but not itself', () => {
  /**
   * A static server hands over whatever the URL asks for unless it is told not
   * to, and this repository is not a web root: it also holds the relay's own
   * source, the test suite, a build directory and — depending on how it is
   * deployed — a .git directory, which is a copy of everything that has ever
   * been in here.
   *
   * So it serves an allowlist, not a blocklist. Found by asking the running
   * server for /package.json and being handed it.
   *
   * The climb out of the root is asked over a raw socket, because fetch tidies
   * "/../x" into "/x" before it sends it and the check would pass without ever
   * testing anything. And the check in the server resolves the path before
   * comparing it, rather than stripping "../" from the string — the string
   * version is the one defeated by "....//".
   */
  const { execFileSync } = require('child_process');
  const out = path.join(require('os').tmpdir(), 'fw-relay-probe.json');
  const script = `
    const ctx = require('${path.join(__dirname, '..', 'server', 'index.js')}')
      .start({ PORT: '0' });
    const server = require('http').createServer(
      require('${path.join(__dirname, '..', 'server', 'app.js')}').create(ctx).handle);
    server.listen(0, async () => {
      const port = server.address().port;
      const ask = async (p) => {
        const r = await fetch('http://127.0.0.1:' + port + p, { redirect: 'manual' });
        return { status: r.status, cache: r.headers.get('cache-control') };
      };
      // Untouched by any client's tidying up.
      const raw = (line) => new Promise((resolve) => {
        const s = require('net').connect(port, '127.0.0.1', () => {
          s.write(line + ' HTTP/1.1\\r\\nHost: relay\\r\\nConnection: close\\r\\n\\r\\n');
        });
        let buf = '';
        s.on('data', (d) => { buf += d; });
        s.on('end', () => resolve(Number((buf.split(' ')[1] || '0'))));
      });
      const result = {
        board: await ask('/'),
        script: await ask('/js/map.js'),
        fleet: await ask('/api/fleet'),
        nonsense: await ask('/api/nothing'),
        source: await ask('/server/config.js'),
        manifest: await ask('/package.json'),
        suite: await ask('/tools/test.js'),
        climb: await raw('GET /../package.json'),
        deepClimb: await raw('GET /js/../../../etc/passwd'),
        dotdot: await raw('GET /....//....//etc/passwd')
      };
      require('fs').writeFileSync('${out.replace(/\\/g, '\\\\')}',
        JSON.stringify(result));
      process.exit(0);
    });
  `;
  execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.unlinkSync(out);

  assert.strictEqual(r.board.status, 200, 'the board is served');
  assert.strictEqual(r.script.status, 200, 'and its scripts');
  assert.strictEqual(r.fleet.status, 200);
  assert.strictEqual(r.nonsense.status, 404, 'an unknown endpoint is not the board');

  assert.strictEqual(r.source.status, 404, 'the relay does not serve its own source');
  assert.strictEqual(r.manifest.status, 404, 'nor anything else in the repository');
  assert.strictEqual(r.suite.status, 404, 'nor the test suite');
  assert.strictEqual(r.climb, 404, 'nor anything above the root');
  assert.strictEqual(r.deepClimb, 404, 'however deep the climb starts');
  assert.strictEqual(r.dotdot, 404, 'nor the form that defeats stripping "../"');

  // A screensaver runs for weeks. Without this a proxy can serve the same fleet
  // all afternoon and nothing on the wall would say so.
  assert.strictEqual(r.fleet.cache, 'no-store');
  assert.strictEqual(r.board.cache, 'no-cache',
    'and a wall must not still be running an old build after a deployment');
});

test('the board takes tracks from the relay once, and only when they arrive', () => {
  /**
   * Asked for on the first poll and not again — but only marked as done if that
   * poll actually worked. A board that opened during a deployment would
   * otherwise draw no track at all until somebody reloaded it.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    Relay.wantTracks = true;
    const mmsi = String(FLEET[0].mmsi);
    // Inside the board's own trackHours window, because it trims anything older
    // than that on every recompute — correctly. A relay that has been running
    // for a week still only hands over a day's worth of usable trail.
    const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
    Relay._receive({
      vessels: [{
        mmsi: mmsi, lat: 43.5, lon: 7.1, sog: 8, cog: 200, at: ago(0.5),
        track: [[7.0, 43.4, ago(3)], [7.05, 43.45, ago(2)]]
      }]
    });

    const v = s.byMmsi[mmsi];
    assert.strictEqual(v.track.length, 3, 'the handed track, then the fix on the end');
    assert.strictEqual(v.track[0].lon, 7.0);
    assert.ok(v.track[0].at instanceof Date, 'and its times are times, not strings');
    assert.strictEqual(v.fix.sog, 8);
    assert.strictEqual(s.connection, 'open');
    assert.strictEqual(Relay.wantTracks, false, 'not asked for again');
  } finally { window.Store = original; }
});

test('a relay that answers with something else is not read as an empty sea', () => {
  /**
   * The relay being unreachable, or answering nonsense, is the one failure this
   * board could not have before. It must never look like a calm afternoon:
   * every yacht on screen goes on ageing from the time her fix was taken, and
   * the pill says the connection is retrying.
   */
  const s = freshStore();
  const original = window.Store;
  window.Store = s;
  try {
    Relay.wantTracks = true;
    Relay._receive({ error: 'nope' });
    assert.strictEqual(s.connection, 'retrying');
    assert.ok(/not a fleet/.test(Relay.lastError));
    assert.strictEqual(Relay.wantTracks, true,
      'and the next poll still asks for the tracks it never got');
  } finally { window.Store = original; }
});

/* --- end of tests. Anything new goes ABOVE this line. --------------------- */

reachedEnd = true;
console.log(`\n${passed} checks passed` + (failed ? ` — ${failed} failed, above\n` : '\n'));

// Exit rather than waiting for the event loop to drain: a timer left running by
// code under test keeps node alive for ever, and the suite would otherwise hang
// after printing its result — in CI, a build that times out with nothing named.
process.exit(failed ? 1 : 0);
