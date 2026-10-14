/* -----------------------------------------------------------------------------
 * domotz.js — whether each yacht's network is healthy, according to Domotz.
 *
 * Not a position feed, and deliberately kept apart from them. Positions say
 * where she is; this says whether the kit we look after on board is working —
 * the collector itself, and every device Domotz has been told is important.
 *
 * Read once for the company, like the AIS feed, and for the same reasons: the
 * key stays in App Settings, a browser never learns Domotz exists, and ten
 * screens cost what one does.
 *
 * WHAT COUNTS AS A FAULT
 *   - the collector is offline: Domotz cannot see the yacht at all, which on a
 *     boat is almost always "her internet is down" — reported as unreachable,
 *     not as healthy, because silence is not good news
 *   - a device is DOWN, or an important (VITAL) device is OFFLINE
 * A guest's phone leaving the network is neither. Devices Domotz has not been
 * told matter are ignored, or every board would be red every evening.
 *
 * WHICH COLLECTOR IS WHICH YACHT
 * `domotzAgent` on the yacht in fleet.js — the collector's id, or its exact
 * name — wins. Otherwise the yacht's name is looked for as whole words in the
 * collector's name, so "Alaiya" finds "M/Y Alaiya" and "ALAIYA - Bridge" but
 * "Ares" does not find "Aresto". A collector that matches more than one yacht
 * is used for none of them and named on /api/health, rather than guessed.
 * -------------------------------------------------------------------------- */

'use strict';

const PAGE_SIZE = 100;
// Collectors asked about at once. Enough that sixty answer in a few seconds,
// few enough not to look like a burst to a rate limit.
const CONCURRENCY = 6;

function create(cfg, fleet, log, fetchImpl) {
  var c = cfg.domotz;
  var doFetch = fetchImpl || fetch;

  var reader = {
    enabled: !!c.key,
    calls: 0,
    timer: null,
    stopped: true,
    lastPollAt: null,
    lastAttemptAt: null,
    inFlight: null,
    lastError: null,
    // mmsi → { state, down, agents, devices: [{ name, type, since }], checkedAt }
    byMmsi: {},
    // Collectors nobody could place, by name, so they can be given a yacht.
    unmatched: [],
    ambiguous: []
  };

  async function get(path) {
    reader.calls++;
    var res = await doFetch(c.endpoint.replace(/\/+$/, '') + path, {
      headers: { 'X-Api-Key': c.key, 'Accept': 'application/json' }
    });
    if (!res.ok) {
      var detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch (e) { /* nothing */ }
      throw new Error('Domotz ' + path.split('?')[0] + ' answered HTTP ' +
        res.status + (detail ? ' — ' + detail : ''));
    }
    return res.json();
  }

  async function agents() {
    var out = [];
    for (var page = 0; page < 50; page++) {
      var batch = await get('/agent?page_size=' + PAGE_SIZE + '&page_number=' + page);
      if (!Array.isArray(batch)) break;
      out = out.concat(batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return out;
  }

  async function poll() {
    var list = await agents();
    var matched = match(fleet, list);
    var now = new Date().toISOString();
    var next = {};

    var ids = Object.keys(matched.byAgent);
    var online = [];
    ids.forEach(function (id) {
      var agent = matched.byAgent[id].agent;
      var mmsi = matched.byAgent[id].mmsi;
      var entry = next[mmsi] || (next[mmsi] = {
        state: 'ok', down: 0, agents: 0, offline: 0, devices: [], checkedAt: now
      });
      entry.agents++;
      if (agentOnline(agent)) online.push({ agent: agent, entry: entry });
      else entry.offline++;
    });

    /**
     * A few collectors at a time, not sixty in a burst and not one by one.
     *
     * One by one was the polite version and took twenty seconds for a fleet
     * this size — fine on a server that polls in the background, not fine on
     * Vercel, where the poll happens while a screen waits for its answer.
     */
    var cursor = 0;
    async function worker() {
      while (cursor < online.length) {
        var job = online[cursor++];
        var devices = await get('/agent/' + encodeURIComponent(job.agent.id) + '/device');
        (Array.isArray(devices) ? devices : []).forEach(function (d) {
          if (!isFault(d)) return;
          job.entry.devices.push({
            name: text(d.display_name) || 'Unnamed device',
            type: d.type && text(d.type.label) || null,
            since: text(d.last_status_change) || null
          });
        });
      }
    }
    var workers = [];
    for (var w = 0; w < CONCURRENCY; w++) workers.push(worker());
    await Promise.all(workers);

    Object.keys(next).forEach(function (m) {
      var e = next[m];
      e.down = e.devices.length;
      // Every collector on board offline: we cannot see her, so we cannot say.
      e.state = e.offline && e.offline === e.agents ? 'unreachable'
              : e.down || e.offline ? 'fault' : 'ok';
    });

    reader.byMmsi = next;
    reader.unmatched = matched.unmatched;
    reader.ambiguous = matched.ambiguous;
    reader.lastPollAt = new Date();
    reader.lastError = null;
    return { agents: list.length, yachts: Object.keys(next).length };
  }

  reader.poll = poll;

  /**
   * One read, logged, never thrown — and never two at once. A timer and a
   * screen arriving together share the read already under way.
   */
  function run() {
    if (reader.inFlight) return reader.inFlight;
    reader.lastAttemptAt = new Date();
    reader.inFlight = poll().then(function (r) {
      var faults = Object.keys(reader.byMmsi).filter(function (m) {
        return reader.byMmsi[m].state !== 'ok';
      }).length;
      log('domotz: ' + r.agents + ' collectors, ' + r.yachts + ' yachts placed, ' +
        faults + ' with a fault' +
        (reader.unmatched.length ? ', ' + reader.unmatched.length + ' collectors unplaced' : ''));
    }).catch(function (err) {
      // Kept, not cleared: the last good reading, with its own time on it,
      // is more use than a blank — and the board ages it out on its own.
      reader.lastError = (err && err.message) || String(err);
      log('domotz: ' + reader.lastError);
    }).then(function () {
      reader.inFlight = null;
    });
    return reader.inFlight;
  }

  reader.start = function () {
    if (!reader.enabled) return;
    reader.stopped = false;
    run();
    reader.timer = setInterval(function () {
      if (!reader.stopped) run();
    }, Math.max(60, c.pollSeconds) * 1000);
    if (reader.timer.unref) reader.timer.unref();
  };

  /**
   * Read Domotz now if the last attempt is older than the poll interval.
   *
   * FOR VERCEL, where the timer in start() is no use: a serverless function
   * is frozen between requests, so nothing runs in the background and a
   * reading would only ever be as old as the cold start that made it. Asking
   * here, on the way to answering a screen, makes the screens the clock. On a
   * server that stays up — Azure — the timer has always just run, so this
   * finds nothing due and costs nothing.
   *
   * Timed from the last ATTEMPT, not the last success, so a Domotz that is
   * refusing us is asked once per interval rather than once per screen poll.
   *
   * Waits at most `maxWaitMs`. A slow Domotz must not hold up the positions:
   * the screen gets whatever reading there is, and the read carries on for
   * the next one wherever the platform lets it.
   */
  reader.refreshIfDue = function (maxWaitMs) {
    if (!reader.enabled) return Promise.resolve();
    var due = !reader.lastAttemptAt ||
      Date.now() - reader.lastAttemptAt.getTime() >= Math.max(60, c.pollSeconds) * 1000;
    var pending = due ? run() : reader.inFlight;
    if (!pending) return Promise.resolve();
    var timer;
    var cap = new Promise(function (resolve) {
      timer = setTimeout(resolve, maxWaitMs || 8000);
    });
    return Promise.race([pending, cap]).then(function () { clearTimeout(timer); });
  };

  reader.stop = function () {
    reader.stopped = true;
    clearInterval(reader.timer);
    reader.timer = null;
  };

  /**
   * What every screen is sent: a state and a count, nothing else.
   *
   * No device names. Those are the console's, on /api/faults — a board in
   * reception has no business listing what is broken on a client's yacht.
   */
  reader.board = function () {
    if (!reader.enabled || !reader.lastPollAt) return null;
    var out = {};
    Object.keys(reader.byMmsi).forEach(function (m) {
      out[m] = { state: reader.byMmsi[m].state, down: reader.byMmsi[m].down };
    });
    return { checkedAt: reader.lastPollAt.toISOString(), vessels: out };
  };

  reader.detail = function () {
    return {
      checkedAt: reader.lastPollAt ? reader.lastPollAt.toISOString() : null,
      error: reader.lastError,
      vessels: reader.byMmsi
    };
  };

  reader.stats = function () {
    if (!reader.enabled) return 'not configured';
    return {
      lastPollAt: reader.lastPollAt ? reader.lastPollAt.toISOString() : null,
      error: reader.lastError,
      calls: reader.calls,
      yachts: Object.keys(reader.byMmsi).length,
      unmatchedCollectors: reader.unmatched,
      ambiguousCollectors: reader.ambiguous
    };
  };

  return reader;
}

function agentOnline(agent) {
  var s = agent && agent.status;
  var value = s && typeof s === 'object' ? s.value : s;
  return String(value || '').toUpperCase() === 'ONLINE';
}

function isFault(device) {
  var status = String(device && device.status || '').toUpperCase();
  if (status === 'DOWN') return true;
  return status === 'OFFLINE' &&
    String(device.importance || '').toUpperCase() === 'VITAL';
}

/**
 * Which collector belongs to which yacht.
 *
 * Exported for the tests, because a wrong match is the failure that matters
 * here: one yacht's broken switch shown on another yacht's marker.
 */
function match(fleet, agents) {
  var byAgent = {}, unmatched = [], ambiguous = [];

  agents.forEach(function (agent) {
    var name = text(agent.display_name) || '';
    var explicit = fleet.filter(function (y) {
      if (y.domotzAgent == null || y.domotzAgent === '') return false;
      return String(y.domotzAgent) === String(agent.id) ||
        norm(y.domotzAgent) === norm(name);
    });
    var candidates = explicit.length ? explicit : fleet.filter(function (y) {
      // A yacht pinned to a collector is never guessed onto another.
      if (y.domotzAgent != null && y.domotzAgent !== '') return false;
      return containsWords(name, y.name);
    });

    if (candidates.length === 1) {
      byAgent[agent.id] = { agent: agent, mmsi: String(candidates[0].mmsi) };
    } else if (candidates.length > 1) {
      ambiguous.push(name || String(agent.id));
    } else {
      unmatched.push(name || String(agent.id));
    }
  });

  return { byAgent: byAgent, unmatched: unmatched, ambiguous: ambiguous };
}

function words(s) {
  return String(s || '').toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^A-Z0-9]+/).filter(Boolean);
}

function norm(s) { return words(s).join(' '); }

function containsWords(haystack, needle) {
  var h = words(haystack), n = words(needle);
  if (!n.length) return false;
  for (var i = 0; i + n.length <= h.length; i++) {
    var ok = true;
    for (var j = 0; j < n.length; j++) {
      if (h[i + j] !== n[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function text(v) {
  if (v == null) return null;
  var s = String(v).trim();
  return s ? s : null;
}

module.exports = { create: create, match: match, isFault: isFault };
