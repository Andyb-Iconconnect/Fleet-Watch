/* -----------------------------------------------------------------------------
 * app.js — what the relay answers.
 *
 * Three things, and no framework to do them: the board itself, a snapshot of
 * the fleet, and an honest account of its own health. Node's own http module is
 * enough for that, and a dependency-free app deploys to Azure as a zip with
 * nothing to install and nothing to go wrong at install time.
 *
 * THE BOARD IS SERVED FROM HERE TOO, and that is not laziness. Same origin
 * means no CORS to configure, no preflight, and no list of allowed origins to
 * keep in step with whatever the screens are called this year. It also means
 * the key stays where it belongs: the browser never learns the provider exists.
 *
 * WHAT IS NOT HERE: any authentication. This is a board of sixty-one customers'
 * yachts and it should not be on a public hostname. That belongs in front of
 * the app rather than inside it — App Service Authentication with Entra ID,
 * turned on in the portal, costs nothing and needs no code. See README.md.
 * -------------------------------------------------------------------------- */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

/**
 * The board, and nothing else in the repository.
 */
const SERVE = ['index.html', 'console.html', 'fleet.js', 'config.js',
               'fleet-template.csv', 'js', 'css', 'data', 'assets'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.csv': 'text/csv; charset=utf-8'
};

function create(ctx) {
  var cfg = ctx.config;
  var store = ctx.store;

  function json(res, status, body) {
    var text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      // A snapshot is stale the moment it is made. A screen left open for a
      // month must never be served yesterday's fleet out of a proxy.
      'Cache-Control': 'no-store'
    });
    res.end(text);
  }

  function handle(req, res) {
    var url;
    try { url = new URL(req.url, 'http://relay'); }
    catch (e) { return json(res, 400, { error: 'bad request' }); }
    var route = url.pathname.replace(/\/+$/, '') || '/';

    if (route === '/api/fleet') {
      // Tracks are asked for rather than sent: they are two orders of magnitude
      // larger than the positions, and a board only needs them once, when it
      // opens. A screen polling every thirty seconds would otherwise pull a
      // third of a megabyte each time to redraw lines it already has.
      var withTracks = url.searchParams.get('tracks') === '1';
      return json(res, 200, store.snapshot(withTracks));
    }

    /**
     * One yacht, between two dates.
     *
     *   /api/history?mmsi=319012900&from=2026-06-01&to=2026-07-01
     *
     * Answered from the table rather than from memory, which is the whole point
     * of the table: the relay holds a day, and this holds a season.
     *
     * The window is required rather than defaulted to everything. A query with
     * no dates over a year of a busy fleet is the one that gets run once by
     * accident and then blamed on the database.
     */
    if (route === '/api/history') {
      if (!ctx.history || !ctx.history.enabled) {
        return json(res, 503, { error: 'no history: this relay has no SQL configured' });
      }
      // Configured but not working — the database unreachable, the table not
      // created, the login without rights. Said, rather than answered with an
      // empty passage that reads as a yacht which has never moved.
      if (ctx.history.ready === false) {
        return json(res, 503, { error: 'the history table is not available: ' +
          (ctx.history.lastError || 'it has not been created yet') });
      }
      var mmsi = url.searchParams.get('mmsi');
      var from = new Date(url.searchParams.get('from'));
      var to = new Date(url.searchParams.get('to'));
      if (!/^[2-7]\d{8}$/.test(String(mmsi))) {
        return json(res, 400, { error: 'mmsi must be a nine-digit MMSI' });
      }
      if (!isFinite(from.getTime()) || !isFinite(to.getTime()) || to <= from) {
        return json(res, 400, { error: 'from and to must be dates, and to must be after from' });
      }
      if (!store.byMmsi[String(mmsi)]) {
        // Not ours. Answered plainly rather than with an empty list, which
        // would read as "she has never moved".
        return json(res, 404, { error: 'that MMSI is not in this fleet' });
      }
      return ctx.history.read(mmsi, from, to,
        Number(url.searchParams.get('limit')) || 0).then(function (out) {
          json(res, 200, {
            mmsi: String(mmsi),
            from: from.toISOString(), to: to.toISOString(),
            rows: out.rows.length,
            // Said out loud: a caller that silently received the first five
            // thousand rows would draw a passage that stops in the middle of
            // the sea.
            truncated: out.truncated,
            positions: out.rows
          });
        }, function (err) {
          json(res, 502, { error: 'the history query failed: ' +
            ((err && err.message) || String(err)) });
        });
    }

    if (route === '/api/health') {
      return json(res, ctx.problems().length ? 503 : 200, health(ctx));
    }

    if (route === '/api/refresh') {
      if (!ctx.reader) {
        return json(res, 503, { error: 'no feed reader available' });
      }
      // Trigger a manual poll and return immediately with the fleet snapshot
      var mmsiList = Object.keys(store.byMmsi);
      ctx.reader.poll(mmsiList).catch(function (err) {
        console.error('manual refresh error:', err.message);
      });
      return json(res, 200, { status: 'refreshing', fleet: store.snapshot(false) });
    }

    if (route.indexOf('/api/') === 0) {
      return json(res, 404, { error: 'no such endpoint' });
    }

    return serveFile(route === '/' ? '/index.html' : route, res);
  }

  /**
   * A file from the repository, and only from the repository.
   *
   * The path is resolved and then checked to be inside the root, because
   * "../../etc/passwd" arrives as an ordinary-looking request and a static
   * server that trusts the URL will hand it over. Checked after resolution, not
   * before: stripping "../" from the string is the version of this that gets
   * defeated by "....//".
   */
  function serveFile(pathname, res) {
    var decoded;
    try { decoded = decodeURIComponent(pathname); }
    catch (e) { return notFound(res); }

    var file = path.resolve(ROOT, '.' + decoded);

    /**
     * Only what the board is made of.
     *
     * A list of what may be served rather than a list of what may not, because
     * the second kind is only ever as good as the last thing somebody thought
     * of. This repository also holds the relay's own source, the test suite,
     * a build directory and — depending on how it is deployed — a .git
     * directory, none of which are web content and one of which is a copy of
     * everything that has ever been in here.
     *
     * Found by asking the running server for /package.json and being handed it.
     *
     * This is also what stops a climb out of the root: the path is RESOLVED
     * first, so "/../package.json" and "/js/../../../etc/passwd" both come back
     * with ".." as their first segment and neither is on the list. Resolving
     * rather than stripping "../" from the string matters — the string version
     * is the one defeated by "....//".
     */
    var rel = path.relative(ROOT, file);
    if (SERVE.indexOf(rel.split(path.sep)[0]) === -1) return notFound(res);

    fs.stat(file, function (err, stat) {
      if (err || !stat.isFile()) return notFound(res);
      var type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        /**
         * Revalidate everything, cache nothing blind.
         *
         * The board is a screensaver that reloads itself and the console is a
         * tool somebody leaves open for a week, so a cached page means a screen
         * still running last month's build after a deployment. The scripts
         * matter just as much, and in a nastier way: a new page holding an old
         * script is not an old build, it is a broken one — the page asks for a
         * file the cached bundle has never heard of and the whole tool dies
         * before it draws anything.
         *
         * `no-cache` is not "do not store": the browser keeps the file and asks
         * whether it has changed, so an unchanged one comes back as a 304 with
         * no body. The cost is one small request per file per load; the thing
         * it buys is that a deployment is actually deployed.
         */
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(file).pipe(res);
    });
  }

  function notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  /**
   * Whether this thing is actually working, in terms someone can act on.
   *
   * Deliberately more than "ok". The failure this has to catch is the quiet
   * one: the relay up, the board being served, and no positions arriving —
   * which from the outside is indistinguishable from a calm afternoon.
   */
  function health(c) {
    var snap = store.snapshot(false);
    var ageMinutes = store.lastFixAt
      ? (Date.now() - store.lastFixAt.getTime()) / 60000 : null;
    return {
      status: c.problems().length ? 'misconfigured' : 'ok',
      problems: c.problems(),
      provider: cfg.provider,
      instanceId: cfg.instanceId,
      startedAt: store.startedAt.toISOString(),
      heard: snap.heard,
      of: snap.of,
      lastFixAt: snap.lastFixAt,
      lastPollAt: snap.lastPollAt,
      minutesSinceLastFix: ageMinutes == null ? null : Math.round(ageMinutes),
      feedError: store.lastError,
      history: ctx.history ? ctx.history.stats() : 'not configured',
      snapshot: ctx.blob && ctx.blob.enabled()
        ? { savedAt: ctx.blob.lastSavedAt ? ctx.blob.lastSavedAt.toISOString() : null,
            error: ctx.blob.lastError }
        : 'not configured',
      reader: ctx.reader && ctx.reader.lastAudit ? ctx.reader.lastAudit
        : (ctx.reader && ctx.reader.stats ? ctx.reader.stats() : null),
      calls: ctx.reader ? ctx.reader.calls || 0 : 0
    };
  }

  return { handle: handle, health: health, server: http.createServer(handle) };
}

module.exports = { create: create };
