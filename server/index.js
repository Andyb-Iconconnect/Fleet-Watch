/* -----------------------------------------------------------------------------
 * index.js — the relay, started.
 *
 *   node server/index.js
 *
 * Reads the feed once for the whole company and serves the board from the same
 * origin. Configuration is entirely in App Settings; see server/README.md for
 * what to set and, more importantly, for the two Azure settings that decide
 * whether this works at all — Always On, and one instance.
 * -------------------------------------------------------------------------- */

'use strict';

const path = require('path');
const configFile = require('./config.js');
const storeFile = require('./store.js');
const blobFile = require('./blob.js');
const sqlFile = require('./sql.js');
const historyFile = require('./history.js');

function log(msg) {
  // Plain stdout: App Service Log Stream shows it live, and it is the first
  // place anyone looks when a board has stopped moving.
  console.log(new Date().toISOString() + '  ' + msg);
}

function loadFleet() {
  // fleet.js is a browser file that assigns window.FLEET. The same file the
  // board uses, so the relay can never be reading a different fleet from the
  // screens it serves.
  global.window = global.window || {};
  require(path.join(__dirname, '..', 'fleet.js'));
  return global.window.FLEET;
}

function start(env) {
  const cfg = configFile.read(env);
  const fleet = loadFleet();
  const store = storeFile.create(fleet, {
    trackPoints: cfg.trackPoints, provider: cfg.provider
  });
  const blob = blobFile.create(cfg.snapshotUrl, log);

  const db = sqlFile.create(cfg, log);
  const history = historyFile.create(cfg, db, log);

  const ctx = {
    config: cfg, store: store, blob: blob, db: db, history: history,
    reader: null,
    problems: function () { return configFile.problems(cfg); }
  };

  const app = require('./app.js').create(ctx);

  app.server.listen(cfg.port, function () {
    log('relay listening on ' + cfg.port +
      (cfg.instanceId ? '  instance ' + cfg.instanceId.slice(0, 8) : ''));
    ctx.problems().forEach(function (p) { log('CONFIGURATION: ' + p); });
  });

  begin(ctx, fleet).catch(function (err) {
    log('the feed did not start: ' + ((err && err.message) || err));
    store.lastError = (err && err.message) || String(err);
  });

  return ctx;
}

/**
 * Fill the board from the last snapshot, then open the feed.
 *
 * In that order, and it matters. A relay restarted at four in the morning that
 * opened the feed first would serve an empty fleet for however long it took the
 * yachts to speak — three minutes for one alongside, days for one mid-ocean.
 * Restoring first means the board comes back with the fleet it had, ageing
 * honestly, and the feed corrects it as the positions arrive.
 */
async function begin(ctx, fleet) {
  const cfg = ctx.config;

  if (ctx.blob.enabled()) {
    const snap = await ctx.blob.load();
    const n = ctx.store.restore(snap);
    log(n ? 'restored ' + n + ' vessels from the last snapshot'
          : 'no snapshot to restore from — this is normal on a first deployment');
  } else {
    log('no SNAPSHOT_BLOB_SAS_URL, so a restart will blank the board until ' +
      'the fleet reports again');
  }

  if (ctx.problems().length) {
    log('not starting a feed: the configuration is incomplete. See /api/health.');
    return;
  }

  /**
   * One reader, and Azure has to be told.
   *
   * Scale this Web App to three instances and three copies of it open three
   * feeds: three times the requests on a metered plan, three times the AIS
   * bandwidth, and a bill nobody can account for — because the board looks
   * exactly the same on all of them. There is no way to detect the others from
   * inside, so this refuses to guess: keep the plan at one instance, or set
   * ALLOW_MULTIPLE_READERS and know what it costs.
   */
  if (cfg.instanceId && !cfg.allowMultipleReaders) {
    log('reading the feed as the single instance. If this Web App is scaled ' +
      'out, EVERY instance will read it and the bill multiplies — keep the ' +
      'plan at one instance.');
  }

  const mmsis = fleet.map(function (y) { return String(y.mmsi); });
  const provider = cfg.provider === 'aisstream'
    ? require('./providers/aisstream.js')
    : cfg.provider === 'myshiptracking'
    ? require('./providers/myshiptracking.js')
    : require('./providers/vesselapi.js');

  ctx.reader = provider.create(cfg, ctx.store, log);
  ctx.reader.start(mmsis);

  if (ctx.blob.enabled()) {
    const save = setInterval(function () {
      // With tracks: the point of the snapshot is that a restarted board looks
      // like the one that was there before, and a board with no tracks does
      // not.
      ctx.blob.save(ctx.store.snapshot(true));
    }, Math.max(30, cfg.snapshotSeconds) * 1000);
    if (save.unref) save.unref();
  }

  /**
   * The record of where they have been.
   *
   * On a timer rather than after each poll, because one provider pushes and the
   * other is paged and the record should not be able to tell the difference.
   * `collect` reads the store, so a fix the store refused — impossible, stale,
   * not ours — can never reach the table.
   */
  if (ctx.history.enabled) {
    log('history: ' + ctx.db.describe());
    await ctx.history.ensureSchema();

    const record = setInterval(function () {
      ctx.history.write(ctx.store);
    }, Math.max(30, cfg.history.writeSeconds) * 1000);
    if (record.unref) record.unref();

    /**
     * Pruning is hourly rather than daily so it is never the first thing a
     * fresh container does. It deletes in blocks and stops when there is
     * nothing left, so an hourly run on a tidy table costs one query.
     */
    const prune = setInterval(function () { ctx.history.prune(); }, 3600000);
    if (prune.unref) prune.unref();
    ctx.history.prune();
  } else if (ctx.db) {
    log('history: SQL is configured but the recorder did not start');
  } else {
    log('no SQL settings, so nothing is keeping a record of where they have been');
  }

  /**
   * On the way out.
   *
   * App Service sends SIGTERM before it recycles a container, which is the one
   * moment the in-memory fleet is both complete and about to be lost — and the
   * last couple of minutes of movement have not been written down yet either.
   */
  ['SIGTERM', 'SIGINT'].forEach(function (sig) {
    process.on(sig, function () {
      log('shutting down on ' + sig);
      Promise.all([
        ctx.blob.enabled() ? ctx.blob.save(ctx.store.snapshot(true)) : null,
        ctx.history.enabled ? ctx.history.write(ctx.store) : null
      ]).then(function () { process.exit(0); }, function () { process.exit(0); });
    });
  });
}

module.exports = { start: start };

if (require.main === module) start(process.env);
