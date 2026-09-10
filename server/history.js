/* -----------------------------------------------------------------------------
 * history.js — where the fleet has been, kept in Azure SQL.
 *
 * The relay holds the present: one position per yacht and a day's trail, which
 * is what a board draws. This is the other question — "where was she in June",
 * "how much did she move last season", "when did she last leave Antibes" — and
 * it is a query, not a scan. Hence a table rather than more blobs.
 *
 * THREE RULES IT IS BUILT ON.
 *
 * 1. IT MUST NEVER TAKE THE BOARD DOWN. The feed is the job; this is a record
 *    of it. Every failure here is caught, counted and reported on /api/health,
 *    and the relay carries on. A wall board that went blank because a database
 *    was briefly unreachable would be a worse system than one with no history
 *    at all.
 *
 * 2. IT IS OPTIONAL, INCLUDING ITS DRIVER. Talking to SQL Server needs a
 *    package; the rest of the relay needs none. So the driver is loaded inside
 *    a try, and a relay with no SQL configured — or one where the install
 *    failed — runs exactly as it did before and says so.
 *
 * 3. A YACHT ALONGSIDE MUST NOT FILL IT. She broadcasts every three minutes for
 *    a fortnight without moving an inch: that is six and a half thousand rows a
 *    fortnight, per yacht, all of them the same pontoon. So a row is written
 *    when she has actually moved, or when enough time has passed to be worth a
 *    mark on the record — which keeps a berth legible at two rows an hour
 *    instead of twenty.
 * -------------------------------------------------------------------------- */

'use strict';

const path = require('path');

// The board's own distance, rather than a second implementation of the same
// formula that could disagree with the trail drawn on the chart.
global.window = global.window || {};
require(path.join(__dirname, '..', 'js', 'geo.js'));
const Geo = global.window.Geo;

const TABLE = 'dbo.vessel_positions';

/**
 * The table.
 *
 * The primary key is (mmsi, reported_at), which is both the dedupe and the
 * index the only question anyone asks — one yacht, between two dates — wants.
 *
 * IGNORE_DUP_KEY is the important part. The relay sees the same fix more than
 * once as a matter of course: the provider carries duplicate reports, and the
 * last page of every poll deliberately overlaps the previous one, because that
 * overlap is how it knows it has caught up. Without this, one repeated row
 * fails the whole batch and takes the new positions with it. With it, the
 * duplicate is dropped and the rest are written.
 */
const CREATE = [
  "IF OBJECT_ID('" + TABLE + "', 'U') IS NULL",
  'CREATE TABLE ' + TABLE + ' (',
  '  mmsi        VARCHAR(9)   NOT NULL,',
  '  reported_at DATETIME2(0) NOT NULL,',
  '  lat         DECIMAL(9,6) NOT NULL,',
  '  lon         DECIMAL(9,6) NOT NULL,',
  '  sog         DECIMAL(5,1) NULL,',
  '  cog         DECIMAL(5,1) NULL,',
  '  heading     SMALLINT     NULL,',
  '  nav_status  TINYINT      NULL,',
  '  source      VARCHAR(8)   NULL,',
  '  CONSTRAINT pk_vessel_positions PRIMARY KEY CLUSTERED (mmsi, reported_at)',
  '    WITH (IGNORE_DUP_KEY = ON)',
  ');'
].join('\n');

const COLUMNS = ['mmsi', 'reported_at', 'lat', 'lon', 'sog', 'cog', 'heading',
                 'nav_status', 'source'];

// TDS allows 2100 parameters in a statement and each row uses nine, so a
// hundred rows is comfortably inside it with room for the query's own.
const CHUNK = 100;

function create(cfg, db, log) {
  var h = {
    db: db,
    enabled: !!db,
    rowsWritten: 0,
    batches: 0,
    lastWriteAt: null,
    lastError: null,
    ready: false,
    // The last position actually written for each yacht, which is what the
    // "has she moved" question is asked against — not her last known position,
    // or a yacht drifting a few metres at anchor would write a row every time.
    lastRecorded: {}
  };

  h.ensureSchema = async function () {
    if (!h.db) return false;
    try {
      await h.db.exec(CREATE, []);
      h.ready = true;
      h.lastError = null;
      return true;
    } catch (err) {
      h.lastError = 'creating the table: ' + message(err);
      log('history: ' + h.lastError);
      return false;
    }
  };

  /**
   * Is this fix worth a row?
   *
   * Distance first, because a yacht under way is the case the record exists
   * for. Time second, so a berth is still legible: two rows an hour says "she
   * was alongside all week" as clearly as forty would, and a season of it fits
   * in a database rather than filling one.
   */
  h.shouldRecord = function (mmsi, fix) {
    var last = h.lastRecorded[mmsi];
    if (!last) return true;
    if (Geo.distanceNm(last.lon, last.lat, fix.lon, fix.lat) >= cfg.history.minNm) {
      return true;
    }
    return (fix.at - last.at) >= cfg.history.minMinutes * 60000;
  };

  /**
   * Everything the store has heard that is not in the table yet.
   *
   * Taken from the store rather than from the reader, so it works the same on a
   * socket that pushes and a stream that is paged, and so a fix rejected by the
   * store — impossible, stale, not ours — can never reach the record.
   */
  h.collect = function (store) {
    var rows = [];
    Object.keys(store.byMmsi).forEach(function (mmsi) {
      var v = store.byMmsi[mmsi];
      if (!v.fix) return;
      var at = new Date(v.fix.at);
      if (!isFinite(at.getTime())) return;
      var fix = { lat: v.fix.lat, lon: v.fix.lon, at: at };
      if (!h.shouldRecord(mmsi, fix)) return;
      rows.push({
        mmsi: mmsi, reported_at: at,
        lat: v.fix.lat, lon: v.fix.lon,
        sog: v.fix.sog, cog: v.fix.cog, heading: v.fix.heading,
        nav_status: v.fix.navStatus, source: v.fix.source
      });
    });
    return rows;
  };

  /**
   * One statement per hundred rows.
   *
   * A row at a time would be a round trip each, and on a first backfill of
   * sixty-one yachts that is sixty-one round trips to write what fits in one.
   */
  h.statement = function (rows) {
    var params = {};
    var tuples = rows.map(function (row, i) {
      return '(' + COLUMNS.map(function (c) {
        var name = 'p' + i + '_' + c;
        params[name] = row[c] == null ? null : row[c];
        return '@' + name;
      }).join(', ') + ')';
    });
    return {
      sql: 'INSERT INTO ' + TABLE + ' (' + COLUMNS.join(', ') + ')\nVALUES\n' +
           tuples.join(',\n') + ';',
      params: params
    };
  };

  h.write = async function (store) {
    if (!h.db || !h.ready) return 0;
    var rows = h.collect(store);
    if (!rows.length) return 0;

    var written = 0;
    try {
      for (var i = 0; i < rows.length; i += CHUNK) {
        var chunk = rows.slice(i, i + CHUNK);
        var stmt = h.statement(chunk);
        await h.db.exec(stmt.sql, stmt.params);
        // Marked as recorded only once the write has returned. A failed batch
        // that had already moved the marks would leave a hole in the record
        // that nothing would ever fill.
        chunk.forEach(function (row) {
          h.lastRecorded[row.mmsi] = { lat: row.lat, lon: row.lon, at: row.reported_at };
        });
        written += chunk.length;
      }
      h.rowsWritten += written;
      h.batches++;
      h.lastWriteAt = new Date();
      h.lastError = null;
    } catch (err) {
      h.lastError = 'writing ' + rows.length + ' rows: ' + message(err);
      log('history: ' + h.lastError);
    }
    return written;
  };

  /**
   * One yacht, between two dates.
   *
   * Capped, and the cap is reported rather than hidden: a year of a busy season
   * is a great many rows, and a caller that silently received the first five
   * thousand of them would draw a passage that stops in the middle of the sea.
   */
  h.read = async function (mmsi, from, to, limit) {
    /**
     * An unavailable table is said, never answered with nothing.
     *
     * Returning an empty list here reads as "she has never moved", which is a
     * lie told with a straight face — and it happened: with the database
     * unreachable the endpoint answered 200 and an empty passage while
     * /api/health, three lines away, reported that the connection had failed.
     * Found by pointing the relay at a dead server and asking it a question
     * anyway.
     */
    if (!h.db) throw new Error('this relay has no SQL configured');
    if (!h.ready) {
      throw new Error('the history table is not available: ' +
        (h.lastError || 'it has not been created yet'));
    }
    var cap = Math.max(1, Math.min(limit || cfg.history.maxRows, cfg.history.maxRows));
    var out = await h.db.query(
      'SELECT TOP (@limit) ' + COLUMNS.join(', ') + '\n' +
      'FROM ' + TABLE + '\n' +
      'WHERE mmsi = @mmsi AND reported_at >= @from AND reported_at < @to\n' +
      'ORDER BY reported_at;',
      { limit: cap, mmsi: String(mmsi), from: from, to: to });
    return { rows: out, truncated: out.length >= cap };
  };

  /**
   * Older than we keep.
   *
   * Deleted in blocks rather than in one statement: a single DELETE over a
   * year's rows takes a lock long enough to stall the writes behind it, and the
   * writes are the part that matters. A run does a bounded amount of work and
   * comes back tomorrow for the rest.
   */
  h.prune = async function (now) {
    if (!h.db || !h.ready || !cfg.history.keepDays) return 0;
    var cutoff = new Date((now || Date.now()) - cfg.history.keepDays * 86400000);
    var removed = 0;
    try {
      for (var pass = 0; pass < 20; pass++) {
        var n = await h.db.exec(
          'DELETE TOP (5000) FROM ' + TABLE + ' WHERE reported_at < @cutoff;',
          { cutoff: cutoff });
        removed += n || 0;
        if (!n) break;
      }
      if (removed) log('history: pruned ' + removed + ' rows older than ' +
        cfg.history.keepDays + ' days');
    } catch (err) {
      h.lastError = 'pruning: ' + message(err);
      log('history: ' + h.lastError);
    }
    return removed;
  };

  h.stats = function () {
    if (!h.db) return 'not configured';
    return {
      ready: h.ready,
      rowsWritten: h.rowsWritten,
      batches: h.batches,
      lastWriteAt: h.lastWriteAt ? h.lastWriteAt.toISOString() : null,
      error: h.lastError
    };
  };

  return h;
}

function message(err) {
  return (err && err.message) || String(err);
}

module.exports = { create: create, CREATE: CREATE, TABLE: TABLE, COLUMNS: COLUMNS };
