/* -----------------------------------------------------------------------------
 * fleetfilter.js — which yachts are being looked at, decided once.
 *
 * The console narrows the fleet in two ways: the chips down the left, and the
 * search box. Until now that answer was only ever used by the rail, and it
 * lived in a closure in console.js where nothing could read it.
 *
 * THEN THE CHART STARTED ASKING THE SAME QUESTION. Filter to Sentinel and the
 * chart is the Sentinel fleet; search a name and the chart is what you searched
 * for — one rule for both, because two lists that narrowed differently would be
 * two things to hold in your head, and the one on the chart is the one whose
 * labels you cannot read.
 *
 * A rule that governs two views is worth being a tested thing rather than a
 * closure, which is the whole reason this file exists. Pure: it takes vessels
 * and gives back vessels, touches no DOM and no store.
 * -------------------------------------------------------------------------- */

(function () {
  'use strict';

  var FleetFilter = {};

  /**
   * The chips, in order.
   *
   * Sentinel sits second rather than among the states because it is not one: a
   * yacht is underway or alongside, and she is separately on the out-of-hours
   * package or she is not.
   */
  FleetFilter.FILTERS = [
    ['all', 'All'],
    ['sentinel', 'Sentinel'],
    ['underway', 'Underway'],
    ['anchored', 'At anchor'],
    ['moored', 'Alongside'],
    ['dark', 'No signal']
  ];

  /**
   * `unknown` rides with `dark` on purpose.
   *
   * "No signal" is the question somebody is actually asking — which of them
   * cannot I see — and a yacht we have never heard from at all answers it just
   * as much as one that has gone quiet. Split apart, the chip would say four
   * when the honest answer is nine.
   */
  var STATE_BUCKETS = {
    underway: ['underway'],
    anchored: ['anchored'],
    moored: ['moored'],
    dark: ['dark', 'unknown']
  };

  // The overview counts by the same buckets the chips filter by, so a yacht we
  // have never heard from is counted under "No signal" there too rather than
  // vanishing from the tally.
  FleetFilter.BUCKETS = STATE_BUCKETS;

  FleetFilter.matches = function (v, filter) {
    if (!filter || filter === 'all') return true;
    // A commercial relationship, not a state she can be in, so it cuts across
    // all four statuses rather than sitting beside them.
    if (filter === 'sentinel') return !!v.yacht.sentinel;
    var states = STATE_BUCKETS[filter] || [filter];
    return states.indexOf(v.derived.status) !== -1;
  };

  /**
   * Everything about her somebody might type.
   *
   * Including the port she is off, because "who is in Antibes" is a question
   * people ask by typing Antibes — and including both the IMO and the MMSI,
   * because whichever one is on the piece of paper in front of them is the one
   * they will use.
   */
  FleetFilter.matchesQuery = function (v, query) {
    if (!query) return true;
    var y = v.yacht;
    var hay = [
      y.name, y.prefix, y.flag, y.flagCode, y.callSign, y.builder, y.classSociety,
      String(y.imo), String(y.mmsi),
      v.derived && v.derived.port ? v.derived.port.name : ''
    ].join(' ').toLowerCase();
    return hay.indexOf(String(query).toLowerCase()) !== -1;
  };

  // The list down the left: alphabetical, because it is read as a list of names.
  FleetFilter.rail = function (vessels, filter, query) {
    return vessels.filter(function (v) {
      return FleetFilter.matches(v, filter) && FleetFilter.matchesQuery(v, query);
    }).sort(function (a, b) {
      return a.yacht.name.localeCompare(b.yacht.name);
    });
  };

  /**
   * The same list, plus the one you are looking at.
   *
   * A vessel you have selected stays on the chart even when the filter has just
   * excluded her: you asked for her by name, her record is open beside it, and
   * a chart that dropped her the moment you clicked "Underway" would be
   * answering a question nobody had asked. The clustering already works this
   * way — the selected yacht is never swallowed into a crowd.
   */
  FleetFilter.chart = function (vessels, filter, query, selectedId) {
    var list = FleetFilter.rail(vessels, filter, query);
    if (!selectedId) return list;
    for (var i = 0; i < list.length; i++) {
      if (list[i].yacht.id === selectedId) return list;
    }
    for (var j = 0; j < vessels.length; j++) {
      if (vessels[j].yacht.id === selectedId) return list.concat([vessels[j]]);
    }
    return list;
  };

  /**
   * What to say on the chart when it is not showing all of them.
   *
   * Null when nothing is narrowed, so the caller shows nothing rather than a
   * chip reading "All · 61 of 61" that is only ever noise.
   */
  FleetFilter.label = function (filter, query, shown, total) {
    if ((!filter || filter === 'all') && !query) return null;
    var parts = [];
    if (filter && filter !== 'all') {
      FleetFilter.FILTERS.forEach(function (f) {
        if (f[0] === filter) parts.push(f[1]);
      });
    }
    if (query) parts.push('“' + query + '”');
    return parts.join(' · ') + '  ·  ' + shown + ' of ' + total;
  };

  window.FleetFilter = FleetFilter;
})();
