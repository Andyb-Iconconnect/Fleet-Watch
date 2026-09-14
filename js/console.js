/* -----------------------------------------------------------------------------
 * console.js — the desk tool for looking a vessel up.
 *
 * Shares everything factual with the office display: the same store, the same
 * feeds, the same chart renderer, the same fleet file. What differs is the job.
 * The board is glanced at and never touched; this is opened when someone needs
 * to answer "where is she", so it can be searched, filtered and read in full.
 *
 * Full detail is the point here, which is why discretion is a deliberate,
 * visible act rather than the default: the redacted install is index.html with
 * discreetLocked set, on a machine a passer-by cannot talk out of it.
 * -------------------------------------------------------------------------- */

(function () {
  'use strict';

  var App = { selected: null, filter: 'all', query: '' };
  var el = function (id) { return document.getElementById(id); };

  var CHART_FPS = 20;
  var RAIL_MIN_INTERVAL_MS = 3000;
  var WORK_MIN_INTERVAL_MS = 3000;

  /* --- Small DOM helpers -------------------------------------------------- */

  function h(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function statusVar(status) {
    // Sentinel has no --status- of its own: it is not a state, and giving it one
    // would have the chip render as var(--status-sentinel), which resolves to
    // nothing and paints an invisible swatch.
    if (status === 'sentinel') return 'var(--sentinel)';
    return 'var(--status-' + (status === 'unknown' ? 'dark' : status) + ')';
  }

  /* --- Boot ---------------------------------------------------------------- */

  // fleet.js as shipped, kept apart from anything added in this browser so the
  // two never compound on a reload.
  var BASE_FLEET = null;

  /**
   * fleet.js is hand-edited, and a missing bracket there takes the whole file
   * with it: the script throws, `window.FLEET` never gets defined, and the board
   * boots into nothing at all. Silence is the worst possible answer to that, so
   * say what happened and how to find it.
   */
  function fleetLoaded(where) {
    if (Array.isArray(window.FLEET) && window.FLEET.length) return true;
    var missing = typeof window.FLEET === 'undefined';
    document.body.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'boot-error';
    box.innerHTML =
      '<h1>' + (missing ? 'fleet.js did not load' : 'fleet.js has no vessels in it') + '</h1>' +
      '<p>' + (missing
        ? 'The file threw before it could define the fleet — almost always an ' +
          'unclosed bracket or a missing comma. Nothing else on ' + where + ' can start until it parses.'
        : 'The file loaded and parsed, but <code>window.FLEET</code> is an empty list.') +
      '</p>' +
      '<p>Check it with:</p><pre>node --check fleet.js</pre>' +
      '<p>The browser console has the line number too.</p>';
    document.body.appendChild(box);
    return false;
  }

  /**
   * Every script this page is made of, and whether it arrived.
   *
   * A console is thirty-odd files in a fixed order, and one of them missing
   * takes the whole tool down before a single line of it has run: the IIFE
   * throws, boot() is never called, and what you get is a blank page with an
   * error only somebody who knows to open developer tools will ever see.
   *
   * That is exactly what a stale bundle looks like from the outside — and a
   * stale bundle is not hypothetical. A console handed out on a USB stick sat
   * six days behind the repository while the board beside it was current, and
   * the only symptom was that things quietly did not happen.
   *
   * So the parts are named, checked, and the missing ones reported in words.
   */
  var PARTS = [
    ['Geo', 'js/geo.js'], ['Fmt', 'js/format.js'], ['Store', 'js/store.js'],
    ['Vessel', 'js/vessel.js'], ['Feed', 'js/feed.js'], ['FleetMap', 'js/map.js'],
    ['FleetFilter', 'js/fleetfilter.js'], ['Passage', 'js/passage.js'],
    ['Browse', 'js/browse.js'], ['Settings', 'js/settings.js'],
    ['Photos', 'js/photos.js'], ['Profile', 'js/profile.js'],
    ['Csv', 'js/csv.js'], ['Weather', 'js/weather.js']
  ];

  function partsLoaded() {
    var missing = PARTS.filter(function (p) { return !window[p[0]]; });
    if (!missing.length) return true;

    document.body.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'boot-error';
    box.innerHTML =
      '<h1>This console is missing ' +
        (missing.length === 1 ? 'a file' : missing.length + ' files') + '</h1>' +
      '<p>Nothing here can start without ' +
        (missing.length === 1 ? 'it' : 'them') + ':</p>' +
      '<pre>' + missing.map(function (p) { return p[1]; }).join('\n') + '</pre>' +
      '<p>If this is a single downloaded file, it is an old one — build a new ' +
      'one with <code>npm run build</code> and use <code>dist/fleet-console.html</code>. ' +
      'If it is a folder or a server, the file did not load: check the network ' +
      'tab, and hard-refresh in case an old copy is cached.</p>';
    document.body.appendChild(box);
    return false;
  }

  function boot() {
    if (!partsLoaded()) return;
    if (!fleetLoaded('the console')) return;
    BASE_FLEET = window.FLEET.slice();
    window.FLEET = window.Vessel.mergedFleet(BASE_FLEET);
    // Before init: the cache restore inside it depends on which mode we are in.
    window.Store.mode = window.Feed.mode();
    window.Store.init(window.FLEET);
    window.FleetMap.init(el('chart-canvas'));
    renderBrand();

    window.Store.subscribe(onStoreChange);
    el('connection').addEventListener('click', function () {
      window.Settings.openAisDialog();
    });
    window.Settings.onChange(restartFeed);
    startFeed();
    window.Weather.start();

    // Asked once. Until it answers the passage panel is absent rather than
    // present and broken, which is the right way round: most of the time the
    // answer is "there is a record", and a panel that flickered in and out
    // would be worse than one that arrives a moment late.
    window.Passage.probe().then(function () { renderWork(true); });

    el('search').addEventListener('input', function (e) {
      App.query = e.target.value.trim().toLowerCase();
      renderRail(true);
      if (!App.selected) renderWork(true);
    });
    el('rail-list').addEventListener('click', onRailClick);
    el('work').addEventListener('click', onWorkClick);
    el('filters').addEventListener('click', onFilterClick);
    window.Browse.attach(el('chart-canvas'), onChartClick, renderChartHome);
    el('chart-home').addEventListener('click', chartHome);
    el('clear-selection').addEventListener('click', function () { select(null); });
    el('chart-filter').addEventListener('click', clearNarrowing);
    el('discreet-toggle').addEventListener('click', toggleDiscreet);
    wireAddDialog();
    wirePhotoImport();
    wireSheetImport();
    wireRemoveDialog();
    wireFileDialog();
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', function () {
      window.FleetMap.resize();
      window.FleetMap.readTheme();
    });

    setInterval(function () { window.Store.recompute(); }, 1000);
    setInterval(function () { window.Store.persist(); }, 30000);
    setInterval(tickClock, 1000);
    tickClock();

    window.Store.recompute();
    renderFilters();
    renderRail(true);
    renderHiddenNote();
    renderSaveButton();
    renderWork(true);
    aimChart();
    window.FleetMap.snap();
    requestAnimationFrame(frame);
  }

  function startFeed() { window.Feed.start(); }
  function restartFeed() { window.Feed.restart(); }

  function renderBrand() {
    var host = el('brand');
    var cfg = window.CONFIG;
    host.textContent = '';
    el('brand-locations').textContent = cfg.brandLocations || '';

    if (cfg.brandLogo) {
      var img = document.createElement('img');
      img.src = cfg.brandLogo;
      img.alt = cfg.brand || '';
      img.onerror = function () { cfg.brandLogo = null; renderBrand(); };
      host.appendChild(img);
      return;
    }
    var name = cfg.brand || '';
    var split = cfg.brandPowerMark ? name.indexOf('O') : -1;
    if (split < 0) { host.textContent = name; return; }
    host.appendChild(document.createTextNode(name.slice(0, split)));
    host.appendChild(powerMark());
    host.appendChild(document.createTextNode(name.slice(split + 1)));
  }

  function powerMark() {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'power-o');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('aria-hidden', 'true');
    var ring = document.createElementNS(NS, 'path');
    ring.setAttribute('d', 'M 59.1 22.9 A 33 33 0 1 1 40.9 22.9');
    svg.appendChild(ring);
    var bar = document.createElementNS(NS, 'line');
    bar.setAttribute('x1', '50'); bar.setAttribute('y1', '8');
    bar.setAttribute('x2', '50'); bar.setAttribute('y2', '42');
    svg.appendChild(bar);
    return svg;
  }

  /* --- Rail ---------------------------------------------------------------- */

  /**
   * Which derived statuses each label covers.
   *
   * `unknown` — never heard from — belonged to no label, so a fleet waiting on
   * its first fix showed 61 vessels and four chips adding up to one. It sits
   * with `dark`: the two differ in how they came about, which the vessel's own
   * record still says, and not at all in what the reader needs from a count.
   */
  // Who is being looked at is one rule, shared by the rail, the chart and the
  // overview list, and it lives in js/fleetfilter.js so it can be tested
  // without a browser. Read when it is needed, never at load: a module that
  // has not arrived must produce the message below, not a TypeError thrown
  // before anything has had a chance to say so.
  function filterChips() { return window.FleetFilter.FILTERS; }

  function renderFilters() {
    var host = el('filters');
    host.textContent = '';
    filterChips().forEach(function (f) {
      var button = h('button', 'chip-filter');
      button.type = 'button';
      button.dataset.filter = f[0];
      button.setAttribute('aria-pressed', String(App.filter === f[0]));
      if (f[0] !== 'all') {
        var swatch = h('span', 'swatch');
        swatch.style.background = statusVar(f[0]);
        button.appendChild(swatch);
      }
      button.appendChild(document.createTextNode(f[1]));
      button.appendChild(h('span', 'n', String(countFor(f[0]))));
      host.appendChild(button);
    });
  }

  // "fix " + Fmt.age reads "fix no fix" for a vessel never heard from, which is
  // most of a fleet on its first day.
  // The same gold as the chart halo, beside her name in the list. Without it the
  // rail and the chart disagree about which yachts are covered, and the rail is
  // where somebody checks.
  function sentinelPip() {
    var pip = h('span', 'sentinel-pip');
    pip.title = 'Sentinel — out-of-hours package';
    pip.setAttribute('aria-label', 'Sentinel');
    return pip;
  }

  function fixAge(v) {
    if (!v.fix || !v.fix.at) return 'no fix yet';
    return 'fix ' + window.Fmt.age(v.fix.at);
  }

  function countFor(filter) {
    return window.Store.vessels.filter(function (v) { return matchesFilter(v, filter); }).length;
  }

  function matchesFilter(v, filter) {
    return window.FleetFilter.matches(v, filter);
  }

  function visibleVessels() {
    return window.FleetFilter.rail(window.Store.vessels, App.filter, App.query);
  }

  /**
   * What the chart draws.
   *
   * The same list as the rail, and that is the whole rule: filter to Sentinel
   * and the chart is the Sentinel fleet, search for a name and the chart is
   * what you searched for. Two lists that narrow differently would be two
   * things to hold in your head, and the one on the chart is the one you cannot
   * read the labels of.
   *
   * With one exception. A vessel you have selected stays on the chart even when
   * the filter has just excluded her — you asked for her by name, her record is
   * open beside it, and a chart that dropped her the moment you clicked
   * "Underway" would be answering a question nobody had asked. The same rule
   * the clustering already follows: the selected yacht is never swallowed.
   */
  function chartVessels() {
    return window.FleetFilter.chart(window.Store.vessels, App.filter, App.query,
      App.selected);
  }

  /**
   * Say so, and offer the way out.
   *
   * A chart showing nine of sixty-one with nothing to say it is filtered is a
   * chart that has quietly stopped being the fleet — and this one is read over
   * somebody's shoulder. The chip carries the count and clears the narrowing
   * when it is clicked, so the way back is visible at the moment it is needed
   * rather than something you have to remember.
   */
  function renderChartFilter() {
    var chip = el('chart-filter');
    if (!chip) return;
    var label = window.FleetFilter.label(App.filter, App.query,
      chartVessels().length, window.Store.vessels.length);
    chip.hidden = !label;
    if (!label) return;
    chip.textContent = label;
    chip.title = 'Showing only these on the chart — click to show them all';
  }

  /**
   * The chip that says what is being shown, and takes it back.
   *
   * The same thing in the chart's header and at the head of this list, because
   * it answers the same question in both places — why are there three of them —
   * and because the way out should be wherever the question is asked.
   */
  function narrowingChip(label) {
    var chip = h('button', 'filter-chip', label);
    chip.type = 'button';
    chip.title = 'Showing only these — click to show them all';
    chip.addEventListener('click', function (event) {
      // The rows behind it select a vessel on click; this is not one of them.
      event.stopPropagation();
      clearNarrowing();
    });
    return chip;
  }

  function clearNarrowing() {
    App.filter = 'all';
    App.query = '';
    var search = el('search');
    if (search) search.value = '';
    renderFilters();
    renderRail(true);
    if (!App.selected) renderWork(true);
    window.Browse.release();
    aimChart();
    renderChartHome();
  }

  var lastRailRender = 0;

  function renderRail(force) {
    var now = Date.now();
    if (!force && now - lastRailRender < RAIL_MIN_INTERVAL_MS) return;
    lastRailRender = now;

    // Rebuilding the list throws away focus; put it back where it was.
    var focused = document.activeElement;
    var focusedId = focused && focused.dataset ? focused.dataset.yachtId : null;

    var host = el('rail-list');
    host.textContent = '';
    var list = visibleVessels();
    renderChartFilter();

    list.forEach(function (v) {
      var row = h('button', 'vessel-row');
      row.type = 'button';
      row.dataset.yachtId = v.yacht.id;
      if (App.selected === v.yacht.id) row.setAttribute('aria-current', 'true');

      var marker = h('span', 'marker');
      marker.style.background = statusVar(v.derived.status);
      if (v.derived.status === 'dark') {
        marker.style.background = 'transparent';
        marker.style.boxShadow = 'inset 0 0 0 2px ' + statusVar('dark');
      }
      row.appendChild(marker);
      var nameCell = h('span', 'v-name', v.yacht.name);
      if (v.yacht.sentinel) nameCell.appendChild(sentinelPip());
      if (v.yacht.addedLocally) nameCell.appendChild(h('span', 'local-dot'));
      row.appendChild(nameCell);

      row.appendChild(h('span', 'v-where', whereText(v)));
      host.appendChild(row);

      if (focusedId === v.yacht.id) row.focus();
    });

    if (!list.length) {
      host.appendChild(h('div', 'empty', App.query
        ? 'No vessel matches “' + App.query + '”.'
        : 'No vessel in this state.'));
    }

    el('rail-foot').textContent = '';
    el('rail-foot').appendChild(h('span', null,
      list.length + ' of ' + window.Store.vessels.length + ' vessels'));
    /**
     * Which build this is, in the corner.
     *
     * A bundled console is a file somebody was handed, and there is no address
     * bar to check and no way to tell one from another by looking. A week of
     * work went missing from one and the only symptom was that things quietly
     * did not happen — "it does not work on my tool" with nothing on the screen
     * able to say why. Now there is.
     */
    el('rail-foot').appendChild(h('span', 'build-stamp',
      window.CONFIG.buildStamp || 'from a folder'));
    renderFilters();
  }

  function whereText(v) {
    var d = v.derived;
    if (d.lat == null) return 'Position unknown';
    if (!d.port) return window.Fmt.latitude(d.lat) + '  ' + window.Fmt.longitude(d.lon);
    if (d.discreet) return 'In the area of ' + d.port.name;
    if (d.port.distanceNm < 1.2) return 'At ' + d.port.name;
    return window.Fmt.distance(d.port.distanceNm) + ' ' + d.port.compass + ' of ' + d.port.name;
  }

  /* --- Work column --------------------------------------------------------- */

  var lastWorkRender = 0;

  /**
   * Rebuild the work column.
   *
   * `force` for a selection change; without it this is throttled the way the
   * rail is, because it runs on every store change and a position feed is
   * chatty. It does have to run on them, though: an open record shows a live
   * position, a fix age and an AIS cross-check, and before this it refreshed
   * on none of them — a vessel underway sat frozen until you reselected her.
   *
   * Rebuilding throws away the scroll position, so put it back.
   */
  function renderWork(force) {
    var now = Date.now();
    if (!force && now - lastWorkRender < WORK_MIN_INTERVAL_MS) return;
    lastWorkRender = now;

    var host = el('work');
    var scroll = host.scrollTop;
    host.textContent = '';
    var v = selectedVessel();
    if (v) renderDetail(host, v); else renderOverview(host);
    host.scrollTop = scroll;
  }

  function selectedVessel() {
    if (!App.selected) return null;
    for (var i = 0; i < window.Store.vessels.length; i++) {
      if (window.Store.vessels[i].yacht.id === App.selected) return window.Store.vessels[i];
    }
    return null;
  }

  var OVERVIEW_STATES = [
    ['underway', 'Underway'],
    ['anchored', 'At anchor'],
    ['moored', 'Alongside'],
    ['dark', 'No signal']
  ];

  function countState(summary, key) {
    return (window.FleetFilter.BUCKETS[key] || [key]).reduce(function (sum, state) {
      return sum + (summary.counts[state] || 0);
    }, 0);
  }

  function renderOverview(host) {
    var summary = window.Store.summary();

    var tiles = h('div', 'tile-row');
    OVERVIEW_STATES.forEach(function (pair) {
      var count = countState(summary, pair[0]);
      tiles.appendChild(tile(pair[1], count,
        'of ' + summary.total, pair[0] === 'dark' && count ? 'warn' : ''));
    });
    tiles.appendChild(tile('Reporting', summary.tracked + ' of ' + summary.total,
      summary.tracked === summary.total ? 'all of them' : 'the rest are dark',
      summary.tracked < summary.total ? 'warn' : ''));

    // How the FEED is doing, which is a different question from where the fleet
    // is: "5 of 61" means one thing four minutes in and another after an hour.
    var r = window.Store.reception();
    if (window.Store.mode === 'live' && r.since) {
      tiles.appendChild(tile('Heard since', r.heard + ' of ' + r.total,
        'listening ' + window.Fmt.duration(r.since) +
        (r.settling ? ' · still assembling' : ''), ''));
    }
    host.appendChild(tiles);

    /**
     * Where each of them is, and how far off.
     *
     * Narrowed by the same chips and the same search box as the rail and the
     * chart — three views, one rule. The tiles above are deliberately NOT: they
     * are the fleet's state, they say "of 61" on their faces, and a filter that
     * changed them would leave nothing on the screen able to answer how many
     * yachts there are.
     */
    var narrowed = window.FleetFilter.label(App.filter, App.query,
      visibleVessels().length, window.Store.vessels.length);

    var panel = h('div', 'panel');
    var title = h('div', 'pane-title');
    title.appendChild(document.createTextNode(
      narrowed ? 'Where these are' : 'Where the fleet is'));
    if (narrowed) title.appendChild(narrowingChip(narrowed));
    panel.appendChild(title);
    var rows = h('div', 'rows');

    var byDistance = visibleVessels().sort(function (a, b) {
      var da = a.derived.fromOffice, db = b.derived.fromOffice;
      if (da == null && db == null) return a.yacht.name.localeCompare(b.yacht.name);
      if (da == null) return 1;
      if (db == null) return -1;
      return da - db;
    });

    if (!byDistance.length) {
      // Two different nothings, and telling somebody the fleet file is empty
      // when they have simply filtered to a state none of them are in would
      // send them looking in entirely the wrong place.
      rows.appendChild(h('div', 'empty', window.Store.vessels.length
        ? 'None of them match that.'
        : 'No vessels in fleet.js.'));
    }
    byDistance.forEach(function (v) {
      var d = v.derived;
      var row = h('div', 'row clickable');
      row.dataset.yachtId = v.yacht.id;

      var main = h('div', 'r-main', v.yacht.name);
      row.appendChild(main);

      var chip = h('span', 'state-pill');
      chip.style.color = statusVar(d.status);
      var swatch = h('span', 'swatch');
      swatch.style.background = statusVar(d.status);
      chip.appendChild(swatch);
      chip.appendChild(h('span', null, window.Fmt.statusLabel(d.status)));
      row.appendChild(chip);

      var sub = whereText(v);
      if (d.fromOffice != null) {
        sub += '  ·  ' + window.Fmt.distance(d.fromOffice) + ' from ' + window.CONFIG.office.label;
      }
      sub += '  ·  ' + fixAge(v);
      row.appendChild(h('div', 'r-sub', sub));
      rows.appendChild(row);
    });
    panel.appendChild(rows);
    host.appendChild(panel);
  }

  function tile(label, figure, note, variant) {
    var node = h('div', 'tile' + (variant ? ' ' + variant : ''));
    node.appendChild(h('div', 'label', label));
    node.appendChild(h('div', 'figure', String(figure)));
    if (note) node.appendChild(h('div', 'note', note));
    return node;
  }

  function vesselVisual(y) {
    var band = h('div', 'detail-profile');
    // A drawing knows its own proportions and the band takes them. A photograph
    // does not: cover-cropping one into the drawing's long, low frame would cut
    // the masthead off the top and the waterline off the bottom, so photographs
    // get an ordinary landscape band instead.
    band.style.aspectRatio = String(window.Photos.resolve(y)
      ? 16 / 9 : window.Profile.frameAspect(y));

    function drawn() {
      band.textContent = '';
      band.style.aspectRatio = String(window.Profile.frameAspect(y));
      band.appendChild(window.Profile.create(y));
      band.appendChild(h('div', 'detail-profile-note', 'Illustration — add a photo above'));
    }

    var source = window.Photos.resolve(y);
    if (source) {
      var img = document.createElement('img');
      img.src = source;
      img.alt = window.Fmt.text(y.prefix) + ' ' + y.name;
      img.addEventListener('error', drawn);
      band.appendChild(img);
    } else {
      drawn();
    }
    return band;
  }

  function renderDetail(host, v) {
    var y = v.yacht, d = v.derived;

    var head = h('div', 'detail-head');
    var titleBlock = h('div');
    titleBlock.appendChild(h('div', 'eyebrow',
      window.Fmt.text(y.prefix) + ' · ' + window.Fmt.text(y.flag)));
    titleBlock.appendChild(h('h1', null, y.name));
    head.appendChild(titleBlock);

    var pill = h('span', 'state-pill');
    pill.style.color = statusVar(d.status);
    var swatch = h('span', 'swatch');
    pill.appendChild(swatch);
    pill.appendChild(h('span', null, window.Fmt.statusLabel(d.status)));
    head.appendChild(pill);

    var editButton = h('button', 'button-quiet head-edit', 'Edit');
    editButton.type = 'button';
    editButton.addEventListener('click', function () { openVesselDialog(v); });
    head.appendChild(editButton);
    host.appendChild(head);

    var spec = h('div', 'detail-spec');
    [[window.Fmt.metres(y.loa), 'LOA'], [window.Fmt.metres(y.beam), 'beam'],
     [window.Fmt.tonnage(y.grossTonnage), ''],
     [window.Fmt.year(y.yearBuilt), 'built'], [window.Fmt.year(y.lastRefit), 'refit'],
     ['IMO ' + window.Fmt.text(y.imo), ''], ['MMSI ' + window.Fmt.text(y.mmsi), ''],
     [window.Fmt.text(y.classSociety), ''], [window.Fmt.text(y.builder), '']
    ].filter(function (pair) {
      // A sparse record otherwise reads as a row of em dashes. Show what is
      // known and say nothing about the rest.
      return pair[0] && pair[0].indexOf('—') === -1;
    }).forEach(function (pair) {
      var span = h('span');
      span.appendChild(h('b', null, pair[0]));
      if (pair[1]) span.appendChild(document.createTextNode(' ' + pair[1]));
      spec.appendChild(span);
    });
    host.appendChild(spec);
    host.appendChild(vesselVisual(y));

    // Where she is, in the record itself. The chart pane carries this too, but
    // narrow layouts drop that pane entirely, and a vessel record with no
    // position in it is not much of a record.
    var whereLine = h('div', 'detail-where');
    whereLine.appendChild(h('span', 'w-main', whereText(v)));
    var whereAge = h('span', 'w-age' + (d.dark ? ' dark' : d.stale ? ' stale' : ''));
    var bits = [window.Fmt.statusLabel(d.status)];
    if (d.status === 'underway' && v.fix && !d.discreet) {
      bits.push(window.Fmt.speed(v.fix.sog) + ' · ' + window.Fmt.bearing(v.fix.cog));
    }
    bits.push(fixAge(v));
    whereAge.textContent = bits.join('  ·  ');
    whereLine.appendChild(whereAge);
    host.appendChild(whereLine);

    // Where she is, then where she has been. Only behind the relay, because a
    // board opened from a single file has no record to ask — and never for a
    // discreet vessel, for the same reason her track is not drawn: a passage is
    // a movement pattern, and that is the whole thing being withheld.
    if (window.Passage.availability && window.Passage.availability.ok && !d.discreet) {
      host.appendChild(passagePanel(v));
    }

    if (y.addedLocally) {
      var localPanel = h('div', 'panel');
      var localHead = h('div', 'pane-title');
      localHead.appendChild(document.createTextNode('In this browser only '));
      localHead.appendChild(h('span', 'local-flag', 'not in fleet.js'));
      localPanel.appendChild(localHead);
      localPanel.appendChild(h('div', 'sheet-note',
        'This vessel was added here and is stored in this browser. It is not on ' +
        'the office display and not on anyone else\'s console until its entry is ' +
        'pasted into fleet.js.'));
      var snippet = h('pre', 'snippet', window.Vessel.toSnippet(y) + ',');
      localPanel.appendChild(snippet);
      var actions = h('div', 'sheet-actions');
      var copyButton = h('button', 'button-primary', 'Copy entry');
      copyButton.type = 'button';
      copyButton.addEventListener('click', function () {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(snippet.textContent);
        }
        copyButton.textContent = 'Copied';
        setTimeout(function () { copyButton.textContent = 'Copy entry'; }, 2000);
      });
      actions.appendChild(copyButton);
      localPanel.appendChild(actions);
      host.appendChild(localPanel);
    }

    // The position, in full. The chart pane shows the same fix as a picture and
    // narrow layouts drop that pane entirely, so the numbers live here.
    var posPanel = h('div', 'panel');
    posPanel.appendChild(h('div', 'pane-title', 'Position'));
    var posRows = h('div', 'rows');

    if (d.lat == null) {
      posRows.appendChild(h('div', 'empty', 'This vessel has never reported to this console.'));
    } else {
      posRows.appendChild(kvRow('Coordinates',
        d.discreet ? 'Withheld' : window.Fmt.latitude(d.lat) + '   ' + window.Fmt.longitude(d.lon),
        d.discreet ? 'discreet — set on this vessel, or on the whole board' : null));
      posRows.appendChild(kvRow('Nearest port', whereText(v), null));
      posRows.appendChild(kvRow('Last fix', window.Fmt.age(v.fix && v.fix.at),
        v.fix && v.fix.at ? window.Fmt.date(v.fix.at) : null));
      if (v.fix && !d.discreet) {
        posRows.appendChild(kvRow('Speed & course',
          v.fix.sog != null ? window.Fmt.speed(v.fix.sog) : '—',
          v.fix.cog != null ? 'course ' + window.Fmt.bearing(v.fix.cog) : null));
      }
      posRows.appendChild(kvRow('From ' + window.CONFIG.office.label,
        d.fromOffice != null ? window.Fmt.distance(d.fromOffice) : '—', null));
      posRows.appendChild(kvRow('Run, 24 h',
        d.distance24h > 0.5 ? window.Fmt.distance(d.distance24h) : '—', null));
      posRows.appendChild(kvRow('Run, 7 days',
        d.distance7d > 0.5 ? window.Fmt.distance(d.distance7d) : '—', null));
      if (d.setAndDrift) {
        posRows.appendChild(kvRow('Set and drift',
          d.setAndDrift.degrees + '° to ' + d.setAndDrift.side,
          'her head and her track disagree — wind, tide, or both'));
      }
      if (v.fix && v.fix.turning && v.fix.turning !== 'steady') {
        posRows.appendChild(kvRow('Turning', 'To ' + v.fix.turning, null));
      }
    }
    posPanel.appendChild(posRows);
    host.appendChild(posPanel);

    // Who the transponder says she is, and how well it knows where it is. The
    // cross-check at the top is the point of the panel: a mistyped MMSI puts
    // somebody else's yacht on the board and is otherwise completely silent.
    var a = v.ais;
    var aisPanel = h('div', 'panel');
    aisPanel.appendChild(h('div', 'pane-title', 'What AIS reports'));

    if (!a) {
      aisPanel.appendChild(h('div', 'empty',
        'No static message heard yet. They come round every few minutes.'));
    } else {
      // In demo mode this panel is the record reflected back at itself, which
      // looks exactly like a transponder agreeing with it. Say which it is.
      if (window.Store.connection === 'demo') {
        aisPanel.appendChild(h('div', 'sheet-note',
          'Demo mode: this is her own record read back, not a transponder. With ' +
          'live AIS it is what she is actually broadcasting, and the two are ' +
          'compared.'));
      }
      if (d.mismatches && d.mismatches.length) {
        var warn = h('div', 'mismatch');
        warn.appendChild(h('div', 'm-head',
          'This MMSI is reporting a different vessel'));
        d.mismatches.forEach(function (m) {
          var line = h('div', 'm-row');
          line.appendChild(h('span', 'm-field', m.field));
          line.appendChild(h('span', 'm-reported', m.reported));
          line.appendChild(h('span', 'm-expected', 'fleet.js says ' + m.expected));
          warn.appendChild(line);
        });
        warn.appendChild(h('div', 'm-note',
          'Check the MMSI against her certificate. Until it matches, this record ' +
          'is tracking whatever vessel does own ' + y.mmsi + '.'));
        aisPanel.appendChild(warn);
      }

      var aisRows = h('div', 'rows');
      aisRows.appendChild(kvRow('Name', a.name || '—', null));
      aisRows.appendChild(kvRow('IMO', a.imo ? String(a.imo) : '—', null));
      aisRows.appendChild(kvRow('Call sign', a.callSign || '—', null));
      aisRows.appendChild(kvRow('Ship type', window.Fmt.shipType(a.shipType),
        a.shipType != null ? 'code ' + a.shipType : null));
      aisRows.appendChild(kvRow('Reported size',
        a.loa ? a.loa + ' m' + (a.beam ? ' × ' + a.beam + ' m' : '') : '—',
        a.loa ? 'measured from the antenna, not the registry' : null));
      if (v.fix) {
        aisRows.appendChild(kvRow('Fix source', window.Fmt.fixType(a.fixType),
          v.fix.accurate == null ? null
            : v.fix.accurate ? 'differential — better than 10 m'
                             : 'plain GNSS — worse than 10 m'));
      }
      aisPanel.appendChild(aisRows);

      // Everything above is already known about her. Offer to keep it rather
      // than have somebody type it back in.
      var fillable = window.Vessel.autoFill(y, a);
      var keys = Object.keys(fillable);
      if (keys.length && !window.CONFIG.autoFillFromAis) {
        var offer = h('div', 'sheet-actions');
        var fill = h('button', 'button-quiet',
          'Fill ' + keys.length + ' blank ' + (keys.length === 1 ? 'field' : 'fields'));
        fill.type = 'button';
        fill.addEventListener('click', function () { applyAutoFill(v, fillable); });
        offer.appendChild(fill);
        offer.appendChild(h('span', 'sheet-foot-note',
          keys.map(function (k) { return FIELD_LABELS[k] || k; }).join(', ') +
          ' — from what she is broadcasting. Nothing already filled in is touched.'));
        aisPanel.appendChild(offer);
      }
    }
    host.appendChild(aisPanel);

    // What the crew have typed into the AIS static message, where they have.
    if (v.voyage && !d.discreet && (v.voyage.destination || v.voyage.eta || v.voyage.draught)) {
      var voyPanel = h('div', 'panel');
      voyPanel.appendChild(h('div', 'pane-title', 'Voyage, as reported'));
      var voyRows = h('div', 'rows');
      voyRows.appendChild(kvRow('Bound for', v.voyage.destination || '—', null));
      voyRows.appendChild(kvRow('ETA', v.voyage.eta || '—', null));
      voyRows.appendChild(kvRow('Draught',
        v.voyage.draught ? v.voyage.draught.toFixed(1) + ' m' : '—', null));
      voyPanel.appendChild(voyRows);
      voyPanel.appendChild(h('div', 'sheet-note',
        'Typed by the crew, not measured. Treat it as intent rather than fact.'));
      host.appendChild(voyPanel);
    }

    if (y.editedLocally) {
      var editedPanel = h('div', 'panel');
      var editedHead = h('div', 'pane-title');
      editedHead.appendChild(document.createTextNode('Edited here '));
      editedHead.appendChild(h('span', 'local-flag', 'not yet in fleet.js'));
      editedPanel.appendChild(editedHead);
      editedPanel.appendChild(h('div', 'sheet-note',
        'This record is shown over the top of what fleet.js says. Save the fleet ' +
        'file to make it the real one, or revert to drop the edit.'));
      var editedActions = h('div', 'sheet-actions');
      var revert = h('button', 'button-quiet', 'Revert to fleet.js');
      revert.type = 'button';
      revert.addEventListener('click', function () {
        window.Vessel.clearOverride(y.id);
        reloadFleet(y.id);
      });
      editedActions.appendChild(revert);
      editedPanel.appendChild(editedActions);
      host.appendChild(editedPanel);
    }

    var danger = h('div', 'danger-zone');
    danger.appendChild(h('span', 'note', y.addedLocally
      ? 'Added in this browser — removing deletes it outright.'
      : 'From fleet.js. Removing hides it here; the file still has the entry.'));
    var removeButton = h('button', 'button-quiet', 'Remove vessel');
    removeButton.type = 'button';
    removeButton.addEventListener('click', function () { askToRemove(v); });
    danger.appendChild(removeButton);
    host.appendChild(danger);
  }

  // Label first, value second. The other way round — value large on the left
  // with the field name as a chip on the right — reads as a tag on a thing
  // rather than as a field, and you cannot scan a column of them.
  function kvRow(key, value, sub) {
    var row = h('div', 'field');
    row.appendChild(h('div', 'f-key', key));
    row.appendChild(h('div', 'f-value', value));
    if (sub) row.appendChild(h('div', 'f-sub', sub));
    return row;
  }

  /* --- Chart pane ---------------------------------------------------------- */

  function aimChart() {
    // Somebody is browsing. Re-aiming here would pull the view out from under
    // them on the next fix, which arrives every few seconds.
    if (window.Browse.hasHold()) return;
    var v = selectedVessel();
    if (v && v.derived.lat != null) {
      var rect = el('chart-canvas').getBoundingClientRect();
      var degreesWanted = 420 / 60 / Math.max(0.2, Math.cos(v.derived.lat * Math.PI / 180));
      window.FleetMap.centreOn(v.derived.lon, v.derived.lat, 360 * rect.width / degreesWanted);
    } else {
      // Fitted to what is drawn, not to the fleet: filtering to three yachts
      // off Sardinia and being left looking at the whole Mediterranean is the
      // filter not having done anything you can see.
      var points = chartVessels()
        .filter(function (x) { return x.derived.lat != null; })
        .map(function (x) { return [x.derived.lon, x.derived.lat]; });
      // fit() declines an empty list and leaves the camera where it is, which
      // is right: a filter that matches nothing should not throw the view out
      // to the whole world as well.
      window.FleetMap.fit(points, 40);
    }
  }

  /**
   * The way back.
   *
   * A chart you can wander needs somewhere to wander back to, and it needs to
   * be visible the moment you start — otherwise the way out is a thing you have
   * to know rather than a thing you can see.
   */
  function renderChartHome() {
    var host = el('chart-home');
    if (!host) return;
    var held = window.Browse.hasHold();
    host.hidden = !held;
    // The hint has done its job once they are moving the chart.
    var holder = document.querySelector('.chart-holder');
    if (holder) holder.classList.toggle('browsing', held);
  }

  function chartHome() {
    window.Browse.release();
    aimChart();
    renderChartHome();
  }

  function renderReadout() {
    var host = el('chart-readout');
    host.textContent = '';
    var v = selectedVessel();

    if (!v) {
      var summary = window.Store.summary();
      var grid = h('div', 'readout-grid');
      grid.appendChild(readoutCell('Reporting', summary.tracked + ' of ' + summary.total));
      grid.appendChild(readoutCell('Underway', String(summary.counts.underway || 0)));
      grid.appendChild(readoutCell('Alongside', String(summary.counts.moored || 0)));
      grid.appendChild(readoutCell('Run, 7 days', window.Fmt.distance(summary.distance7d)));
      host.appendChild(grid);
      return;
    }

    var d = v.derived;
    host.appendChild(h('div', 'readout-line',
      d.lat == null ? 'No position'
        : d.discreet ? 'Position withheld'
        : window.Fmt.latitude(d.lat) + '   ' + window.Fmt.longitude(d.lon)));
    host.appendChild(h('div', 'readout-sub', whereText(v)));

    var age = h('div', 'readout-age' + (d.dark ? ' dark' : d.stale ? ' stale' : ''));
    var parts = [window.Fmt.statusLabel(d.status)];
    if (d.status === 'underway' && v.fix && !d.discreet) {
      parts.push(window.Fmt.speed(v.fix.sog) + ' · ' + window.Fmt.bearing(v.fix.cog));
    }
    parts.push(fixAge(v));
    age.textContent = parts.join('  ·  ');
    host.appendChild(age);

    var grid2 = h('div', 'readout-grid');
    var w = v.weather;
    if (w) {
      var beaufort = window.Weather.beaufort(w.windSpeed);
      grid2.appendChild(readoutCell('Wind', window.Fmt.windSpeed(w.windSpeed) +
        (beaufort ? ' F' + beaufort.force : '')));
      grid2.appendChild(readoutCell('Air', window.Fmt.temperature(w.airTemp)));
      if (w.marineAvailable) {
        grid2.appendChild(readoutCell('Sea', window.Fmt.waveHeight(w.waveHeight)));
        grid2.appendChild(readoutCell('Water', window.Fmt.temperature(w.seaTemp)));
      }
    } else if (!window.CONFIG.weather.enabled) {
      grid2.appendChild(readoutCell('Conditions', 'Lookup off'));
    } else {
      grid2.appendChild(readoutCell('Conditions', 'Loading…'));
    }
    if (d.localTime) grid2.appendChild(readoutCell('Local time', d.localTime.text));
    if (d.fromOffice != null) {
      grid2.appendChild(readoutCell('From ' + window.CONFIG.office.label, window.Fmt.distance(d.fromOffice)));
    }
    host.appendChild(grid2);
  }

  function readoutCell(key, value) {
    var cell = h('div');
    cell.appendChild(h('span', 'k', key));
    cell.appendChild(h('span', 'v', value));
    return cell;
  }

  var lastChartFrame = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    if (now - lastChartFrame < 1000 / CHART_FPS) return;
    lastChartFrame = now;
    // No ambient drift here — a tool that wanders under the pointer is a
    // nuisance, whatever it does for a wall.
    window.FleetMap.render(now, chartVessels(), {
      highlight: App.selected,
      noDrift: true
    });
  }

  /* --- Interaction --------------------------------------------------------- */

  function select(yachtId) {
    // A passage belongs to the vessel it was asked about. Left drawn, it would
    // read as the next one's.
    forgetPassage();
    App.selected = yachtId;
    el('chart-title').textContent = yachtId
      ? (selectedVessel() ? window.Fmt.fullName(selectedVessel().yacht) : 'Fleet')
      : 'Fleet';
    el('clear-selection').hidden = !yachtId;
    renderRail(true);
    renderWork(true);
    renderReadout();
    aimChart();
  }

  function onRailClick(event) {
    var row = event.target.closest('.vessel-row');
    if (row && row.dataset.yachtId) select(row.dataset.yachtId);
  }

  function onWorkClick(event) {
    var row = event.target.closest('[data-yacht-id]');
    if (row && row.dataset.yachtId) select(row.dataset.yachtId);
  }

  function onFilterClick(event) {
    var button = event.target.closest('.chip-filter');
    if (!button) return;
    App.filter = button.dataset.filter;
    renderRail(true);
    // The overview list narrows with it. Only when it is the thing on screen:
    // an open vessel record does not depend on the filter, and rebuilding it
    // would be work nobody asked for.
    if (!App.selected) renderWork(true);
    // The chart now holds a different set, so it is pointed at it. Released
    // first: having dragged the chart somewhere and then asked for Sentinel,
    // what you want is the Sentinel fleet, not wherever you happened to be.
    window.Browse.release();
    aimChart();
    renderChartHome();
  }

  // Browse owns the pointer now: it tells us when a press was a click rather
  // than the start of a drag, in canvas coordinates.
  function onChartClick(x, y) {
    window.Picker.handleClick(x, y, function (id) {
      // Choosing a vessel is an instruction to look at her, so the chart comes
      // back under the console's control.
      window.Browse.release();
      select(id);
    });
  }

  // Discretion here is a visible, deliberate act with an unmissable banner —
  // the opposite of the office display, where it is locked on at install.
  function toggleDiscreet() {
    window.CONFIG.discreetMode = !window.CONFIG.discreetMode;
    // Whatever is on the chart came from before the switch was thrown.
    forgetPassage();
    var button = el('discreet-toggle');
    button.setAttribute('aria-pressed', String(window.CONFIG.discreetMode));

    var existing = document.querySelector('.discreet-banner');
    if (window.CONFIG.discreetMode && !existing) {
      var banner = h('div', 'discreet-banner',
        'Discreet mode — positions shown as areas, tracks and destinations withheld');
      el('console').insertBefore(banner, el('console').children[1]);
    } else if (!window.CONFIG.discreetMode && existing) {
      existing.remove();
    }

    window.Store.recompute();
    renderRail(true);
    renderWork(true);
    renderReadout();
  }

  /* --- Adding a vessel ----------------------------------------------------- */


  /* --- Where she has been -------------------------------------------------- */

  /**
   * The passage panel is built once per vessel and kept.
   *
   * The work column rebuilds itself every three seconds — an open record shows
   * a live position and a fix age, and it has to. Rebuilding this with it would
   * take the date picker out from under whoever had just opened it, and throw
   * away what they had typed on the way.
   */
  var passageUi = null;

  function passagePanel(v) {
    if (passageUi && passageUi.yachtId === v.yacht.id) return passageUi.node;
    passageUi = buildPassagePanel(v);
    return passageUi.node;
  }

  function buildPassagePanel(v) {
    var ui = { yachtId: v.yacht.id, node: h('div', 'panel passage') };
    ui.node.appendChild(h('div', 'pane-title', 'Where she has been'));

    var presets = h('div', 'passage-presets');
    window.Passage.RANGES.forEach(function (preset) {
      var button = h('button', 'button-quiet', preset.label);
      button.type = 'button';
      button.addEventListener('click', function () {
        var range = window.Passage.rangeFor(preset.id);
        ui.from.value = isoDay(range.from);
        ui.to.value = isoDay(range.to);
        load(ui, v);
      });
      presets.appendChild(button);
    });
    ui.node.appendChild(presets);

    var row = h('div', 'passage-range');
    ui.from = dateField(row, 'From');
    ui.to = dateField(row, 'To');
    var show = h('button', 'button-primary', 'Show');
    show.type = 'button';
    show.addEventListener('click', function () { load(ui, v); });
    row.appendChild(show);
    ui.clear = h('button', 'button-quiet', 'Clear');
    ui.clear.type = 'button';
    ui.clear.hidden = true;
    ui.clear.addEventListener('click', function () {
      window.FleetMap.setPassage(null);
      ui.clear.hidden = true;
      say(ui, 'Nothing drawn.', null);
    });
    row.appendChild(ui.clear);
    ui.node.appendChild(row);

    var opening = window.Passage.rangeFor('30d');
    ui.from.value = isoDay(opening.from);
    ui.to.value = isoDay(opening.to);

    ui.status = h('div', 'passage-status');
    ui.node.appendChild(ui.status);
    say(ui, 'Pick a window and it is drawn on the chart.',
      'The record holds what the relay heard, and only from the day it was ' +
      'switched on — a window before that is empty rather than wrong.');
    return ui;
  }

  function dateField(row, label) {
    var wrap = h('label', 'passage-date');
    wrap.appendChild(h('span', null, label));
    var input = document.createElement('input');
    input.type = 'date';
    wrap.appendChild(input);
    row.appendChild(wrap);
    return input;
  }

  function isoDay(date) { return date.toISOString().slice(0, 10); }

  function say(ui, main, note) {
    ui.status.textContent = '';
    ui.status.appendChild(h('div', 'p-main', main));
    if (note) ui.status.appendChild(h('div', 'p-note', note));
  }

  function load(ui, v) {
    var from = new Date(ui.from.value + 'T00:00:00Z');
    var to = new Date(ui.to.value + 'T23:59:59Z');
    if (!isFinite(from.getTime()) || !isFinite(to.getTime()) || to <= from) {
      say(ui, 'Those dates do not make a window.',
        'The second one has to be after the first.');
      return;
    }

    say(ui, 'Reading the record…', null);
    window.Passage.load(v.yacht.mmsi, from, to).then(function (out) {
      // She may have been deselected, or discretion turned on, while the query
      // was running. Drawing it then would put a movement pattern on a chart
      // that has just been told not to show one.
      if (!passageUi || passageUi.yachtId !== v.yacht.id) return;
      if (v.derived.discreet) { say(ui, 'Withheld in discreet mode.', null); return; }

      if (!out.points.length) {
        window.FleetMap.setPassage(null);
        ui.clear.hidden = true;
        say(ui, 'Nothing recorded in that window.',
          'Either she was not heard, or the record does not go back that far.');
        return;
      }

      window.FleetMap.setPassage(out.points);
      ui.clear.hidden = false;
      // Padded a little more than the fleet view: a passage that runs to the
      // edge of the canvas loses the end mark that says where it finished.
      window.FleetMap.fit(out.points.map(function (p) { return [p.lon, p.lat]; }), 60);

      var s = out.summary;
      say(ui, [
        s.positions.toLocaleString('en-GB') + ' positions',
        Math.round(s.distanceNm).toLocaleString('en-GB') + ' nm',
        day(s.from) + ' – ' + day(s.to)
      ].join('  ·  '), passageCaveats(s, out.truncated));
    }, function (err) {
      if (!passageUi || passageUi.yachtId !== v.yacht.id) return;
      say(ui, 'The record could not be read.', (err && err.message) || String(err));
    });
  }

  /**
   * What the number does not say.
   *
   * The distance is the sum of the legs actually recorded, so a week nobody
   * heard her is a straight line across it — and the straight line is the part
   * that looks most like data. Said out loud, with the gap, so the figure is
   * read for what it is.
   */
  function passageCaveats(summary, truncated) {
    var notes = [];
    if (summary.longestGapHours >= 6) {
      notes.push('longest gap ' + Math.round(summary.longestGapHours) +
        ' hours — drawn straight across, which is a guess, not a course');
    }
    if (truncated) {
      notes.push('more positions than could be sent: this is the earliest part ' +
        'of the window, so narrow it to see the rest');
    }
    if (summary.topSpeed != null) {
      notes.push('fastest recorded ' + window.Fmt.speed(summary.topSpeed));
    }
    return notes.length ? notes.join('  ·  ') : null;
  }

  function day(date) {
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function forgetPassage() {
    passageUi = null;
    if (window.FleetMap.setPassage) window.FleetMap.setPassage(null);
  }

  /* --- Importing vessels from a spreadsheet -------------------------------- */

  var sheet = { rows: [], mapping: [], plan: [] };

  var FIELD_LABELS = {
    name: 'Name', prefix: 'Type (M/Y or S/Y)', mmsi: 'MMSI', imo: 'IMO',
    callSign: 'Call sign', flag: 'Flag', flagCode: 'Flag code',
    loa: 'LOA (m)', beam: 'Beam (m)', grossTonnage: 'Gross tonnage',
    builder: 'Builder', yearBuilt: 'Year built', lastRefit: 'Last refit',
    classSociety: 'Class society', photo: 'Photo path or URL', discreet: 'Discreet',
    demoStatus: 'State', demoPort: 'Port', demoLat: 'Latitude', demoLon: 'Longitude',
    demoDestination: 'Bound for', demoSpeed: 'Speed', demoEtaHours: 'ETA hours'
  };

  function wireSheetImport() {
    var input = el('sheet-file');
    // Opens on the template rather than straight into a file picker: somebody
    // starting from nothing has no CSV to choose yet, and that is the case the
    // template exists for.
    el('import-sheet').addEventListener('click', openSheetStart);
    el('sheet-choose').addEventListener('click', function () { input.click(); });
    el('sheet-template').addEventListener('click', downloadTemplate);
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) readSheetFile(input.files[0]);
      input.value = '';
    });
    el('sheet-close').addEventListener('click', function () { el('sheet-dialog').close(); });
    el('sheet-cancel').addEventListener('click', function () { el('sheet-dialog').close(); });
    el('sheet-apply').addEventListener('click', applySheet);
    el('file-csv').addEventListener('click', downloadCsv);
    renderColumnNotes();
  }

  function renderColumnNotes() {
    var host = el('column-notes');
    host.textContent = '';
    window.Csv.COLUMN_NOTES.forEach(function (pair) {
      var row = h('div', 'column-note');
      row.appendChild(h('div', 'n-head', pair[0]));
      row.appendChild(h('div', 'n-body', pair[1]));
      host.appendChild(row);
    });
  }

  function openSheetStart() {
    sheet = { rows: [], mapping: [], plan: [] };
    el('sheet-note').textContent = '';
    el('sheet-start').hidden = false;
    el('sheet-columns-panel').hidden = true;
    el('sheet-rows-title').textContent = 'Rows';
    el('sheet-rows').textContent = '';
    el('sheet-rows').appendChild(h('div', 'empty', 'Nothing loaded yet.'));
    el('sheet-status').textContent = '';
    el('sheet-template-status').textContent = '';
    el('sheet-apply').disabled = true;
    el('sheet-apply').textContent = 'Import';
    el('sheet-dialog').showModal();
  }

  function downloadTemplate() {
    saveText(window.Csv.template(), 'fleet-template.csv', 'text/csv',
      el('sheet-template-status'),
      'Saved. Fill it in, then Choose a CSV.');
  }

  /**
   * Hand a file to whoever can save one here. Served from a folder that is an
   * ordinary download; inside the artifact viewer the page cannot save anything
   * itself and has to ask the host, which prompts the viewer.
   */
  function saveText(text, filename, mime, status, doneMessage) {
    var blob = new Blob([text], { type: mime });
    var host = (window.claude && typeof window.claude.use === 'function')
      ? window.claude.use('downloads') : null;

    if (!host) {
      status.textContent = saveBlobDirect(blob, filename)
        ? doneMessage : 'Downloads are blocked here.';
      return;
    }
    status.textContent = 'Asking the viewer…';
    Promise.resolve(host).then(function (downloads) {
      if (!downloads) {
        status.textContent = saveBlobDirect(blob, filename) ? doneMessage : '';
        return;
      }
      return downloads.save({ filename: filename, data: blob })
        .then(function () { status.textContent = doneMessage; })
        .catch(function (error) {
          status.textContent = (error && error.code) === 'declined'
            ? 'Save cancelled.' : 'Could not save here.';
        });
    }).catch(function () { saveBlobDirect(blob, filename); });
  }

  function readSheetFile(file) {
    // .xlsx is a zip of XML and needs a megabyte of library to read. Saying so
    // beats failing at a file that looks perfectly reasonable to its owner.
    if (/\.(xlsx|xls|numbers|ods)$/i.test(file.name)) {
      el('sheet-note').textContent = '';
      el('sheet-start').hidden = false;
      el('sheet-columns-panel').hidden = true;
      el('sheet-rows').textContent = '';
      el('sheet-rows').appendChild(h('div', 'empty',
        file.name + ' is a spreadsheet, not a CSV. Open it and Save As (or Export) ' +
        'CSV, then drop that here. Reading .xlsx directly would mean a megabyte of ' +
        'library inlined into every copy of this, to save one Save As.'));
      el('sheet-status').textContent = '';
      el('sheet-apply').disabled = true;
      el('sheet-dialog').showModal();
      return;
    }

    var reader = new FileReader();
    reader.onload = function () { loadSheet(String(reader.result), file.name); };
    reader.onerror = function () {
      el('sheet-note').textContent = 'That file could not be read.';
      el('sheet-dialog').showModal();
    };
    reader.readAsText(file);
  }

  function loadSheet(text, filename) {
    el('sheet-start').hidden = true;
    el('sheet-columns-panel').hidden = false;
    var rows = window.Csv.parse(text);
    if (rows.length < 2) {
      sheet = { rows: [], mapping: [], plan: [] };
      el('sheet-note').textContent = filename + ' has no rows under its headings.';
      el('sheet-columns').textContent = '';
      el('sheet-rows').textContent = '';
      el('sheet-apply').disabled = true;
      el('sheet-dialog').showModal();
      return;
    }

    sheet.rows = rows;
    sheet.mapping = window.Csv.mapColumns(rows[0]);
    el('sheet-note').textContent = filename + ' — ' + (rows.length - 1) +
      (rows.length === 2 ? ' row' : ' rows') + ' under ' + rows[0].length + ' columns.';
    renderColumnMap();
    planSheet();
    el('sheet-dialog').showModal();
  }

  function renderColumnMap() {
    var host = el('sheet-columns');
    host.textContent = '';
    sheet.rows[0].forEach(function (heading, index) {
      var cell = h('div', 'sheet-column');
      cell.appendChild(h('div', 'c-head', heading || '(no heading)'));
      cell.appendChild(h('div', 'c-sample', sampleFor(index)));

      var select = document.createElement('select');
      select.className = 'import-pick';
      var ignore = document.createElement('option');
      ignore.value = '';
      ignore.textContent = 'Ignore';
      select.appendChild(ignore);
      window.Csv.FIELDS.forEach(function (field) {
        var option = document.createElement('option');
        option.value = field;
        option.textContent = FIELD_LABELS[field] || field;
        select.appendChild(option);
      });
      select.value = sheet.mapping[index];
      select.addEventListener('change', function () {
        // A field can only come from one column; taking it releases the other.
        if (select.value) {
          sheet.mapping = sheet.mapping.map(function (f, i) {
            return i !== index && f === select.value ? '' : f;
          });
        }
        sheet.mapping[index] = select.value;
        renderColumnMap();
        planSheet();
      });
      cell.appendChild(select);
      host.appendChild(cell);
    });
  }

  function sampleFor(index) {
    for (var i = 1; i < sheet.rows.length; i++) {
      var value = sheet.rows[i][index];
      if (value) return value.length > 28 ? value.slice(0, 27) + '…' : value;
    }
    return '—';
  }

  /**
   * Work out what each row would do, without doing any of it.
   *
   * A row matching a vessel already on the list updates her rather than adding
   * a second copy — re-importing a corrected spreadsheet is the normal case,
   * not the exception, and duplicates would be the result otherwise.
   */
  function planSheet() {
    var seenMmsi = {};
    sheet.plan = sheet.rows.slice(1).map(function (row, i) {
      var fields = window.Csv.rowToFields(row, sheet.mapping);
      var line = i + 2;
      var label = fields.name || '(row ' + line + ')';

      if (!fields.name) return { line: line, label: label, error: 'No name.' };

      var mmsi = window.Vessel.validateMmsi(fields.mmsi || '');
      if (!mmsi.ok) return { line: line, label: label, error: mmsi.error };

      if (seenMmsi[mmsi.value]) {
        return { line: line, label: label,
                 error: 'MMSI ' + mmsi.value + ' is on row ' + seenMmsi[mmsi.value] + ' too.' };
      }
      seenMmsi[mmsi.value] = line;

      // IMO is checked when given and left alone when not: plenty of yachts
      // under 300 GT have never been issued one.
      var imo = null;
      if (fields.imo) {
        var checked = window.Vessel.validateImo(fields.imo);
        if (!checked.ok) return { line: line, label: label, error: checked.error };
        imo = checked.value;
      }

      var existing = window.FLEET.filter(function (y) {
        return y.mmsi === mmsi.value || (imo && y.imo === imo);
      })[0];

      return {
        line: line, label: label, fields: fields, mmsi: mmsi.value, imo: imo,
        existing: existing || null, use: true
      };
    });
    renderSheetRows();
  }

  function renderSheetRows() {
    var host = el('sheet-rows');
    host.textContent = '';

    var good = sheet.plan.filter(function (p) { return !p.error; });
    var adds = good.filter(function (p) { return !p.existing; }).length;
    var updates = good.length - adds;
    var bad = sheet.plan.length - good.length;

    el('sheet-rows-title').textContent = 'Rows — ' + adds + ' new, ' + updates +
      ' updated' + (bad ? ', ' + bad + ' with a problem' : '');
    el('sheet-apply').disabled = good.length === 0;
    el('sheet-apply').textContent = good.length
      ? 'Import ' + good.length : 'Import';

    sheet.plan.forEach(function (item, i) {
      var row = h('div', 'sheet-row' + (item.error ? ' bad' : ''));

      var tick = document.createElement('input');
      tick.type = 'checkbox';
      tick.checked = !item.error && item.use !== false;
      tick.disabled = !!item.error;
      tick.addEventListener('change', function () {
        sheet.plan[i].use = tick.checked;
        renderSheetRows();
      });
      row.appendChild(tick);

      var meta = h('div', 'sheet-meta');
      meta.appendChild(h('div', 's-name', item.label));
      meta.appendChild(h('div', 's-sub', item.error
        ? 'Row ' + item.line + ' · ' + item.error
        : 'Row ' + item.line + ' · MMSI ' + item.mmsi +
          (item.imo ? ' · IMO ' + item.imo : ' · no IMO')));
      row.appendChild(meta);

      row.appendChild(h('div', 's-verdict ' + (item.error ? 'bad'
        : item.existing ? 'update' : 'new'),
        item.error ? 'Skipped' : item.existing ? 'Updates ' + item.existing.name : 'New'));
      host.appendChild(row);
    });
  }

  function applySheet() {
    var wanted = sheet.plan.filter(function (p) { return !p.error && p.use !== false; });
    if (!wanted.length) { el('sheet-dialog').close(); return; }

    var added = 0, updated = 0, failed = 0;
    wanted.forEach(function (item) {
      // An update starts from what is already known about her, so a spreadsheet
      // with four columns in it does not blank the other fourteen.
      var base = item.existing ? window.Vessel.toFields(item.existing) : {};
      var fields = Object.assign({}, base, item.fields, {
        mmsi: item.mmsi,
        imo: item.imo != null ? item.imo : (item.existing ? item.existing.imo : null),
        id: item.existing ? item.existing.id : null
      });
      if (item.existing) {
        fields.demoRoute = window.Vessel.toFields(item.existing).demoRoute;
      }
      var record = window.Vessel.buildRecord(fields);

      var ok;
      if (!item.existing) ok = window.Vessel.addAddition(record);
      else if (item.existing.addedLocally) ok = window.Vessel.updateAddition(record.id, record);
      else ok = window.Vessel.setOverride(record.id, record);

      if (!ok) failed++;
      else if (item.existing) updated++;
      else added++;
    });

    sheet = { rows: [], mapping: [], plan: [] };
    reloadFleet(App.selected);

    if (!failed) { el('sheet-dialog').close(); return; }
    el('sheet-status').textContent = added + ' added, ' + updated + ' updated, ' +
      failed + ' could not be stored — this browser is blocking or out of storage.';
  }

  function downloadCsv() {
    saveText(window.Csv.fromFleet(window.FLEET, window.Vessel.toFields),
      'fleet.csv', 'text/csv', el('file-status'),
      'Saved. Edit it and drop it back on the console.');
  }

  /* --- Importing a pile of photographs ------------------------------------- */

  // Each dropped file, once read: { file, dataUri, width, height, yachtId, error }
  var importQueue = [];

  function wirePhotoImport() {
    var input = el('import-file');
    el('import-photos').addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      if (input.files && input.files.length) beginImport(input.files);
      input.value = '';
    });
    el('import-close').addEventListener('click', function () { el('import-dialog').close(); });
    el('import-cancel').addEventListener('click', function () { el('import-dialog').close(); });
    el('import-apply').addEventListener('click', applyImport);

    // Dropping images anywhere on the console starts the same flow, except
    // while the vessel form is open — that has its own drop zone for one photo
    // of one boat, and stealing its files would be a surprise.
    ['dragenter', 'dragover'].forEach(function (type) {
      document.addEventListener(type, function (e) {
        if (!hasFiles(e) || el('add-dialog').open) return;
        e.preventDefault();
        document.body.classList.add('dropping');
      });
    });
    document.addEventListener('dragleave', function (e) {
      if (e.relatedTarget) return;            // still inside the window
      document.body.classList.remove('dropping');
    });
    document.addEventListener('drop', function (e) {
      document.body.classList.remove('dropping');
      if (!hasFiles(e) || el('add-dialog').open) return;
      // Without this the browser navigates to the dropped file and the console
      // is simply gone, unsaved changes and all.
      e.preventDefault();
      routeDroppedFiles(e.dataTransfer.files);
    });
  }

  // One drop target, two kinds of file. A spreadsheet among images is much more
  // likely to be a mis-drop than a deliberate mixture, so the two are separated
  // and whichever is present is handled.
  function routeDroppedFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    var sheets = files.filter(function (f) {
      return /\.(csv|tsv|xlsx|xls|numbers|ods)$/i.test(f.name) ||
             /csv|excel|spreadsheet/i.test(f.type || '');
    });
    if (sheets.length) { readSheetFile(sheets[0]); return; }
    beginImport(files);
  }

  function hasFiles(event) {
    var dt = event.dataTransfer;
    if (!dt) return false;
    if (dt.types && dt.types.indexOf) return dt.types.indexOf('Files') !== -1;
    return true;
  }

  function beginImport(fileList) {
    var files = Array.prototype.slice.call(fileList);
    importQueue = [];
    el('import-list').textContent = '';
    el('import-status').textContent = 'Reading ' + files.length + '…';
    el('import-note').textContent = '';
    el('import-apply').disabled = true;
    el('import-dialog').showModal();

    // Sequentially rather than all at once: decoding twenty camera JPEGs in
    // parallel locks the tab up for as long as it takes.
    var index = 0;
    function next() {
      if (index >= files.length) { finishReading(); return; }
      var file = files[index++];
      window.Photos.fromFile(file).then(function (result) {
        var match = window.Photos.matchFilename(file.name, window.FLEET);
        importQueue.push({
          name: file.name, dataUri: result.dataUri,
          width: result.width, height: result.height,
          yachtId: match ? match.yacht.id : '',
          confidence: match ? match.confidence : 'none'
        });
      }).catch(function (error) {
        importQueue.push({ name: file.name, error: error.message || 'Could not be read.' });
      }).then(function () {
        el('import-status').textContent = 'Reading ' + index + ' of ' + files.length + '…';
        next();
      });
    }
    next();
  }

  function finishReading() {
    var readable = importQueue.filter(function (item) { return !item.error; });
    var matched = readable.filter(function (item) { return item.yachtId; });

    el('import-note').textContent = readable.length
      ? matched.length + ' of ' + readable.length + ' matched to a vessel by filename. ' +
        'Check the guesses and change any that are wrong — nothing is stored until ' +
        'you say so. Anything left on "Skip" is ignored.'
      : 'None of those could be read as an image.';
    el('import-status').textContent = '';
    el('import-apply').disabled = readable.length === 0;
    renderImportList();
  }

  function renderImportList() {
    var host = el('import-list');
    host.textContent = '';

    importQueue.forEach(function (item, i) {
      var row = h('div', 'import-row' + (item.error ? ' bad' : ''));

      var thumb = h('div', 'import-thumb');
      if (item.dataUri) {
        var img = document.createElement('img');
        img.src = item.dataUri;
        img.alt = '';
        thumb.appendChild(img);
      }
      row.appendChild(thumb);

      var meta = h('div', 'import-meta');
      meta.appendChild(h('div', 'i-name', item.name));
      meta.appendChild(h('div', 'i-sub', item.error
        ? item.error
        : item.width + '×' + item.height + ' · ' +
          window.Photos.formatBytes(Math.round(item.dataUri.length * 0.75))));
      row.appendChild(meta);

      if (item.error) {
        row.appendChild(h('div', 'i-verdict bad', 'Skipped'));
      } else {
        var select = document.createElement('select');
        select.className = 'import-pick';
        var skip = document.createElement('option');
        skip.value = '';
        skip.textContent = 'Skip';
        select.appendChild(skip);
        window.FLEET.forEach(function (y) {
          var option = document.createElement('option');
          option.value = y.id;
          option.textContent = window.Fmt.fullName(y) +
            (window.Photos.has(y.id) ? '  (replaces)' : '');
          select.appendChild(option);
        });
        select.value = item.yachtId;
        select.addEventListener('change', function () {
          importQueue[i].yachtId = select.value;
          importQueue[i].confidence = select.value ? 'chosen' : 'none';
          renderImportList();
        });
        row.appendChild(select);
        row.appendChild(h('div', 'i-verdict ' + item.confidence, {
          sure: 'Matched', likely: 'Best guess', chosen: 'Chosen', none: 'No match'
        }[item.confidence] || ''));
      }
      host.appendChild(row);
    });
  }

  function applyImport() {
    var wanted = importQueue.filter(function (item) { return item.yachtId && !item.error; });
    if (!wanted.length) { el('import-dialog').close(); return; }

    // Two files aimed at one vessel would store one and silently lose the other.
    var seen = {}, clash = null;
    wanted.forEach(function (item) {
      if (seen[item.yachtId]) clash = item.yachtId;
      seen[item.yachtId] = true;
    });
    if (clash) {
      var y = window.FLEET.filter(function (v) { return v.id === clash; })[0];
      el('import-status').textContent = 'Two photographs are both set to ' +
        (y ? window.Fmt.fullName(y) : clash) + '. Only one can be hers.';
      return;
    }

    var saved = 0, failed = [];
    wanted.forEach(function (item) {
      var result = window.Photos.set(item.yachtId, item.dataUri);
      if (result.ok) saved++;
      else failed.push({ item: item, full: result.full });
    });

    importQueue = [];
    reloadFleet(App.selected);

    if (!failed.length) {
      el('import-dialog').close();
      return;
    }
    // Storage ran out partway. Say which ones did not make it rather than
    // closing on a job half done.
    el('import-status').textContent = saved + ' stored, ' + failed.length + ' did not fit — ' +
      'this browser is full at ' + window.Photos.formatBytes(window.Photos.usageBytes()) +
      '. Save the fleet file to write these out to assets/photos/, then remove them here.';
    el('import-apply').disabled = true;
  }

  /**
   * Take what the fleet is broadcasting into the fields their records have not
   * got, without being asked.
   *
   * This runs on every store change, which sounds expensive and is not: the
   * moment a field is filled it stops being fillable, so after the first pass
   * over a vessel there is nothing to do and nothing is written. A record that
   * never gets a static message is simply never touched.
   *
   * It writes an override, the same as an edit through the form, so what the
   * app learns ends up in fleet.js when the file is saved rather than living
   * only in one browser.
   */
  function adoptWhatWeHear() {
    if (!window.CONFIG.autoFillFromAis) return;
    var changed = 0;
    window.Store.vessels.forEach(function (v) {
      if (!v.ais) return;
      var patch = window.Vessel.autoFill(v.yacht, v.ais);
      if (!Object.keys(patch).length) return;
      applyAutoFill(v, patch, true);
      changed++;
    });
    if (changed) {
      reloadFleet(App.selected);
      renderSaveButton();
    }
  }

  // Adopt what AIS reports into the fields a record has not got. Stored the
  // same way an edit through the form is, so it goes into the file with
  // everything else.
  function applyAutoFill(v, patch, deferReload) {
    var y = v.yacht;
    var fields = Object.assign(window.Vessel.toFields(y), patch, { id: y.id });
    var record = window.Vessel.buildRecord(fields);
    if (y.addedLocally) window.Vessel.updateAddition(y.id, record);
    else window.Vessel.setOverride(y.id, record);
    if (!deferReload) reloadFleet(y.id);
  }

  /* --- The vessel form ----------------------------------------------------- */

  // One form does add and edit. Two forms drift: a field added to one and not
  // the other is invisible until someone tries to correct it and finds it gone.
  var FORM_FIELDS = [
    'name', 'prefix', 'mmsi', 'imo', 'callSign', 'flag', 'flagCode',
    'loa', 'beam', 'grossTonnage', 'builder', 'yearBuilt', 'lastRefit',
    'classSociety', 'photo',
    'demoStatus', 'demoPort', 'demoSpeed', 'demoLat', 'demoLon',
    'demoDestination', 'demoEtaHours'
  ];
  var ERROR_FIELDS = ['name', 'mmsi', 'imo', 'photo', 'photo-file',
                      'demoPort', 'demoLat', 'demoLon'];

  // Which vessel is being edited, or null when adding.
  var editing = null;
  // A photograph chosen in this sitting, not yet committed: null means "no
  // change", a data URI means "use this", and REMOVE_PHOTO means "drop the one
  // already stored". Undefined and null would otherwise have to mean different
  // things, which is how photographs get deleted by accident.
  var REMOVE_PHOTO = '\u0000remove';
  var pendingPhoto = null;

  function wireAddDialog() {
    var dialog = el('add-dialog');
    el('add-vessel').addEventListener('click', function () { openVesselDialog(null); });
    el('add-cancel').addEventListener('click', function () { dialog.close(); });
    el('add-cancel-2').addEventListener('click', function () { dialog.close(); });
    el('done-close').addEventListener('click', function () { dialog.close(); });
    el('add-form').addEventListener('submit', onAddSubmit);
    el('copy-snippet').addEventListener('click', onCopySnippet);
    el('done-save-file').addEventListener('click', function () {
      dialog.close();
      openFileDialog();
    });

    // Clear a field's error as soon as it is edited; nagging while someone types
    // is worse than saying nothing.
    ERROR_FIELDS.forEach(function (key) {
      var input = el('f-' + key);
      if (input) input.addEventListener('input', function () { setFieldError(key, ''); });
    });

    // The preview is the only honest test of a photo URL: plenty of hosts serve
    // it here and refuse it from the board, and both look identical in the field.
    el('f-photo').addEventListener('input', debounce(updatePhotoPreview, 400));

    // The flag is in the MMSI, so it fills itself as one is typed. Only into
    // empty boxes: somebody who has typed a flag meant it.
    el('f-mmsi').addEventListener('input', function () {
      var flag = window.Vessel.flagFromMmsi(el('f-mmsi').value);
      if (!flag) return;
      if (!el('f-flag').value.trim()) el('f-flag').value = flag.flag;
      if (!el('f-flagCode').value.trim()) el('f-flagCode').value = flag.flagCode;
    });

    wirePhotoUpload();
    fillPortList();
  }

  function wirePhotoUpload() {
    var input = el('f-photo-file');
    var drop = el('photo-drop');

    el('photo-choose').addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) takePhotoFile(input.files[0]);
      input.value = '';
    });
    el('photo-clear').addEventListener('click', function () {
      pendingPhoto = REMOVE_PHOTO;
      updatePhotoPreview();
    });

    // Dropping a file on the page navigates to it by default, which loses
    // everything typed into the form.
    ['dragenter', 'dragover'].forEach(function (type) {
      drop.addEventListener(type, function (e) {
        e.preventDefault();
        drop.classList.add('over');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      drop.addEventListener(type, function (e) {
        e.preventDefault();
        drop.classList.remove('over');
      });
    });
    drop.addEventListener('drop', function (e) {
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) takePhotoFile(file);
    });
  }

  function takePhotoFile(file) {
    setFieldError('photo-file', '');
    el('photo-meta').textContent = 'Reading…';
    window.Photos.fromFile(file).then(function (result) {
      pendingPhoto = result.dataUri;
      updatePhotoPreview(result);
    }).catch(function (error) {
      setFieldError('photo-file', error.message || 'That image could not be read.');
      updatePhotoPreview();
    });
  }

  function debounce(fn, ms) {
    var timer = null;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  function fillPortList() {
    var list = el('port-names');
    list.textContent = '';
    window.PORTS.slice()
      .sort(function (a, b) { return a[0].localeCompare(b[0]); })
      .forEach(function (p) {
        var option = document.createElement('option');
        option.value = p[0];
        option.label = p[0] + ' · ' + p[1];
        list.appendChild(option);
      });
  }

  function updatePhotoPreview(justRead) {
    var host = el('photo-preview');
    var actions = el('photo-actions');
    var meta = el('photo-meta');
    host.textContent = '';
    setFieldError('photo', '');

    // An uploaded image, whether chosen a moment ago or already in storage,
    // beats the URL — and the URL box is inert while one is in place.
    var stored = (editing && pendingPhoto !== REMOVE_PHOTO)
      ? window.Photos.get(editing.yacht.id) : null;
    var uploaded = pendingPhoto && pendingPhoto !== REMOVE_PHOTO ? pendingPhoto : stored;

    if (uploaded) {
      var shot = document.createElement('img');
      shot.alt = '';
      shot.src = uploaded;
      host.appendChild(shot);
      actions.hidden = false;
      meta.textContent = justRead
        ? justRead.width + '×' + justRead.height + ' · ' +
          window.Photos.formatBytes(Math.round(uploaded.length * 0.75))
        : 'In this browser · ' +
          window.Photos.formatBytes(Math.round(uploaded.length * 0.75));
      el('f-photo').disabled = true;
      el('photo-note').classList.add('muted');
      return;
    }

    actions.hidden = true;
    meta.textContent = '';
    el('f-photo').disabled = false;
    el('photo-note').classList.remove('muted');

    var url = el('f-photo').value.trim();
    if (!url) {
      host.appendChild(h('span', 'photo-preview-empty', 'No photo'));
      return;
    }
    host.appendChild(h('span', 'photo-preview-empty', 'Loading…'));
    var img = document.createElement('img');
    img.alt = '';
    img.addEventListener('load', function () {
      host.textContent = '';
      host.appendChild(img);
    });
    img.addEventListener('error', function () {
      host.textContent = '';
      host.appendChild(h('span', 'photo-preview-empty bad', 'Will not load'));
      setFieldError('photo', 'Nothing loaded from there. If the file is real, the ' +
        'host is probably refusing to serve it to another site — copy it into ' +
        'assets/photos/ instead.');
    });
    img.src = url;
  }

  function openVesselDialog(vessel) {
    editing = vessel || null;
    pendingPhoto = null;
    var form = el('add-form');
    form.reset();
    ERROR_FIELDS.forEach(function (k) { setFieldError(k, ''); });
    el('add-status').textContent = '';

    // Prefix is deliberately blank on a new vessel: AIS ship type 36 or 37 says
    // which she is, and defaulting to motor would leave every sloop wrong until
    // somebody noticed.
    var fields = vessel
      ? window.Vessel.toFields(vessel.yacht)
      : { prefix: '', demoStatus: 'moored' };

    FORM_FIELDS.forEach(function (key) {
      var input = el('f-' + key);
      if (!input) return;
      input.value = fields[key] != null ? String(fields[key]) : '';
    });
    el('f-discreet').checked = !!fields.discreet;
    el('f-sentinel').checked = !!fields.sentinel;

    // A hand-written route survives an edit; say so rather than appearing to
    // have lost it because the position boxes are empty.
    el('route-note').hidden = !(fields.demoRoute && fields.demoRoute.length >= 2);

    el('add-title').textContent = vessel
      ? 'Edit ' + window.Fmt.fullName(vessel.yacht)
      : 'Add a vessel';
    el('add-submit').textContent = vessel ? 'Save changes' : 'Add vessel';

    el('f-photo').disabled = false;
    updatePhotoPreview();
    form.hidden = false;
    el('add-done').hidden = true;
    el('add-dialog').showModal();
    el('add-body').scrollTop = 0;
    // preventScroll, or focusing the first field scrolls the section heading and
    // the note explaining MMSI straight off the top of the sheet.
    el('f-name').focus({ preventScroll: true });
  }

  function setFieldError(key, message) {
    var error = el('e-' + key), input = el('f-' + key);
    if (error) error.textContent = message || '';
    if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function readForm() {
    var out = {};
    FORM_FIELDS.forEach(function (key) {
      var input = el('f-' + key);
      out[key] = input ? input.value.trim() : '';
    });
    out.discreet = el('f-discreet').checked;
    out.sentinel = el('f-sentinel').checked;
    return out;
  }

  function onAddSubmit(event) {
    event.preventDefault();
    var raw = readForm();

    var mmsi = window.Vessel.validateMmsi(raw.mmsi);
    var name = raw.name;
    // Optional: plenty of yachts under 300 GT have never been issued one, and
    // she broadcasts it anyway. Checked when given, never demanded.
    var imo = raw.imo ? window.Vessel.validateImo(raw.imo) : { ok: true, value: null };

    setFieldError('imo', imo.ok ? '' : imo.error);
    setFieldError('mmsi', mmsi.ok ? '' : mmsi.error);
    setFieldError('name', name ? '' : 'Give the vessel a name.');

    if (!name) { el('f-name').focus(); return; }
    if (!mmsi.ok) { el('f-mmsi').focus(); return; }
    if (!imo.ok) { el('f-imo').focus(); return; }

    // A duplicate would quietly shadow an existing record. Editing a vessel
    // does not clash with herself.
    var clash = window.FLEET.filter(function (y) {
      if (editing && y.id === editing.yacht.id) return false;
      return y.mmsi === mmsi.value || (imo.value && y.imo === imo.value);
    })[0];
    if (clash) {
      setFieldError('mmsi', clash.name + ' is already on the list with that ' +
        (clash.mmsi === mmsi.value ? 'MMSI' : 'IMO') + '.');
      el('f-mmsi').focus();
      return;
    }

    if (!validateDemoPlacement(raw)) return;

    var fields = Object.assign({}, raw, {
      name: name, mmsi: mmsi.value, imo: imo.value,
      id: editing ? editing.yacht.id : null,
      demoRoute: editing ? window.Vessel.toFields(editing.yacht).demoRoute : null
    });
    var record = window.Vessel.buildRecord(fields);

    var stored, lede;
    if (!editing) {
      stored = window.Vessel.addAddition(record);
      lede = window.Fmt.fullName(record) + ' is on your list and, with live AIS ' +
        'running, is tracked from now. She lives in this browser only until ' +
        'fleet.js carries her.';
    } else if (editing.yacht.addedLocally) {
      stored = window.Vessel.updateAddition(record.id, record);
      lede = window.Fmt.fullName(record) + ' is updated in this browser. She is ' +
        'still not in fleet.js.';
    } else {
      stored = window.Vessel.setOverride(record.id, record);
      lede = window.Fmt.fullName(record) + ' is edited in this browser, over the ' +
        'top of what fleet.js says. Save the file to make it the real record.';
    }

    var photoWarning = commitPhoto(record.id);

    reloadFleet(record.id);

    el('done-title').textContent = editing ? 'Saved — now make it permanent'
                                           : 'Added — now make it permanent';
    el('done-lede').textContent = lede;
    el('done-snippet').textContent = window.Vessel.toSnippet(record) + ',';
    el('copy-status').textContent = photoWarning ? photoWarning : (stored ? ''
      : 'This browser is blocking storage, so the change will be gone on reload — ' +
        'the entry below is the only copy.');
    el('add-form').hidden = true;
    el('add-done').hidden = false;
    editing = null;
    pendingPhoto = null;
  }

  // Returns a message worth showing, or '' when there is nothing to say. A
  // photograph that silently failed to save is worse than one that plainly
  // refused, and the storage a browser gives a page runs out long before
  // anybody expects it to.
  function commitPhoto(id) {
    if (pendingPhoto === REMOVE_PHOTO) {
      window.Photos.remove(id);
      return '';
    }
    if (!pendingPhoto) return '';
    var result = window.Photos.set(id, pendingPhoto);
    if (result.ok) return '';
    return result.full
      ? 'The vessel saved but the photograph did not — this browser is out of ' +
        'storage (' + window.Photos.formatBytes(window.Photos.usageBytes()) +
        ' of photographs already). Save the fleet file to write the images out to ' +
        'assets/photos/, then remove them here.'
      : 'The vessel saved but the photograph did not — this browser is blocking storage.';
  }

  // A vessel demo mode cannot place never reaches the chart, which looks exactly
  // like a vessel that was never added. Catch it at the point of entry.
  function validateDemoPlacement(raw) {
    var hasLat = raw.demoLat !== '', hasLon = raw.demoLon !== '';
    setFieldError('demoLat', '');
    setFieldError('demoLon', '');
    setFieldError('demoPort', '');

    if (hasLat !== hasLon) {
      setFieldError(hasLat ? 'demoLon' : 'demoLat', 'Give both, or neither.');
      el('f-demo' + (hasLat ? 'Lon' : 'Lat')).focus();
      return false;
    }
    if (hasLat) {
      var lat = Number(raw.demoLat), lon = Number(raw.demoLon);
      if (!isFinite(lat) || Math.abs(lat) > 90) {
        setFieldError('demoLat', 'Latitude runs -90 to 90.');
        el('f-demoLat').focus();
        return false;
      }
      if (!isFinite(lon) || Math.abs(lon) > 180) {
        setFieldError('demoLon', 'Longitude runs -180 to 180.');
        el('f-demoLon').focus();
        return false;
      }
      return true;
    }
    if (raw.demoPort) {
      var known = window.PORTS.some(function (p) {
        return normalisePort(p[0]) === normalisePort(raw.demoPort);
      });
      if (!known) {
        setFieldError('demoPort', 'No port of that name in data/ports.js. Pick one ' +
          'from the list, or give a latitude and longitude instead.');
        el('f-demoPort').focus();
        return false;
      }
    }
    return true;
  }

  function normalisePort(name) {
    return String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().trim();
  }

  function reloadFleet(selectId) {
    window.FLEET = window.Vessel.mergedFleet(BASE_FLEET);
    window.Store.init(window.FLEET);
    restartFeed();

    window.Store.recompute();
    select(selectId || App.selected);
    renderRail(true);
    renderHiddenNote();
    renderSaveButton();
  }

  function onCopySnippet() {
    var text = el('done-snippet').textContent;
    var status = el('copy-status');
    function fallback() {
      // Clipboard access is refused in some embedded contexts; select it instead
      // so the keyboard still works.
      var range = document.createRange();
      range.selectNodeContents(el('done-snippet'));
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = 'Selected — press Ctrl+C (or Cmd+C) to copy.';
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(function () { status.textContent = 'Copied. Paste it into fleet.js.'; })
        .catch(fallback);
    } else {
      fallback();
    }
  }

  /* --- Removing a vessel --------------------------------------------------- */

  var pendingRemoval = null;

  function askToRemove(vessel) {
    pendingRemoval = vessel;
    var y = vessel.yacht;
    var snippet = el('remove-snippet');

    if (y.addedLocally) {
      el('remove-body').textContent =
        window.Fmt.fullName(y) + ' was added in this browser and is stored here only. ' +
        'Removing it deletes it outright — nothing else has a copy.';
      snippet.hidden = true;
    } else {
      // Be plain about what a browser can and cannot do to a file.
      el('remove-body').textContent =
        window.Fmt.fullName(y) + ' comes from fleet.js, which this page cannot edit. ' +
        'Removing it takes the vessel off this browser straight away, and then ' +
        'hands you the whole of fleet.js with it gone — save that over the file ' +
        'and it is off the office display and every other console too. Until you ' +
        'do, it can be restored from the bottom of the fleet list.';
      snippet.hidden = true;
    }
    el('remove-dialog').showModal();
    el('remove-cancel').focus();
  }

  function confirmRemoval() {
    if (!pendingRemoval) return;
    var y = pendingRemoval.yacht;
    if (y.addedLocally) window.Vessel.removeAddition(y.id);
    else window.Vessel.hideVessel(y.id);
    // Her photograph is the largest thing stored about her; leaving it behind
    // fills the browser with pictures of boats nobody can see.
    window.Photos.remove(y.id);
    window.Vessel.clearOverride(y.id);
    var wasFromFile = !y.addedLocally;
    pendingRemoval = null;
    el('remove-dialog').close();
    App.selected = null;
    reloadFleet(null);
    // Hiding is half the job; offer the half that makes it stick.
    if (wasFromFile) openFileDialog();
  }

  /* --- Writing fleet.js back out ------------------------------------------- */

  // Hiding takes a vessel off this browser; only the file takes it off
  // everything. So whenever there are local changes the console offers the whole
  // file with them applied, which is the one action that actually removes a
  // vessel for good.
  function localChangeCount() {
    return window.Vessel.loadAdditions().length +
           window.Vessel.hiddenIds().length +
           window.Vessel.overriddenIds().length +
           window.Photos.ids().length;
  }

  function renderSaveButton() {
    var count = localChangeCount();
    var button = el('save-file');
    button.hidden = count === 0;
    button.textContent = count === 1 ? 'Save fleet.js (1 change)' : 'Save fleet.js (' + count + ')';
  }

  function openFileDialog() {
    var added = window.Vessel.loadAdditions().length;
    var hidden = window.Vessel.hiddenIds().length;
    var edited = window.Vessel.overriddenIds().length;
    var parts = [];
    if (added) parts.push(added + (added === 1 ? ' vessel added' : ' vessels added'));
    if (edited) parts.push(edited + (edited === 1 ? ' vessel edited' : ' vessels edited'));
    if (hidden) parts.push(hidden + (hidden === 1 ? ' vessel removed' : ' vessels removed'));
    var shots = window.Photos.ids().length;
    if (shots) parts.push(shots + (shots === 1 ? ' photograph' : ' photographs'));
    el('file-summary').textContent = parts.length
      ? parts.join(', ') + ' in this browser.'
      : 'No local changes — this is the fleet exactly as the file already has it.';
    // The written file points at assets/photos/, never at the base64 held here:
    // thirty photographs inlined would make a fleet.js nobody can open.
    el('file-content').textContent = window.Vessel.toFleetFile(fleetForFile());
    el('file-status').textContent = '';
    renderPhotoExport();
    el('file-dialog').showModal();
    el('file-close').focus();
  }

  /**
   * The fleet as it should be written out: any vessel whose photograph lives in
   * this browser gets `photo` pointed at where that image is about to be saved.
   * The image itself is saved separately — see renderPhotoExport.
   */
  function fleetForFile() {
    var ids = window.Photos.ids();
    if (!ids.length) return window.FLEET;
    return window.FLEET.map(function (y) {
      if (ids.indexOf(y.id) === -1) return y;
      var copy = JSON.parse(JSON.stringify(y));
      copy.photo = window.Photos.exportName(y.id);
      return copy;
    });
  }

  function renderPhotoExport() {
    var panel = el('photo-export');
    var ids = window.Photos.ids().filter(function (id) {
      return window.FLEET.some(function (y) { return y.id === id; });
    });
    panel.hidden = ids.length === 0;
    if (!ids.length) return;

    el('photo-export-note').textContent =
      (ids.length === 1 ? 'One photograph is' : ids.length + ' photographs are') +
      ' held in this browser (' + window.Photos.formatBytes(window.Photos.usageBytes()) +
      '). The file above already points at them. Save them into assets/photos/ ' +
      'and the office display sees them too — until then only this console does.';

    var list = el('photo-export-list');
    list.textContent = '';
    ids.forEach(function (id) {
      var y = window.FLEET.filter(function (v) { return v.id === id; })[0];
      var row = h('div', 'row');
      row.appendChild(h('div', 'r-main', window.Fmt.fullName(y)));
      row.appendChild(h('div', 'r-sub', window.Photos.exportName(id)));
      list.appendChild(row);
    });
    el('photo-export-status').textContent = '';
  }

  // Saved one at a time: the artifact host prompts per file and refuses a second
  // prompt while one is open, so they have to be walked through in order.
  function savePhotosInTurn() {
    var ids = window.Photos.ids().filter(function (id) {
      return window.FLEET.some(function (y) { return y.id === id; });
    });
    var status = el('photo-export-status');
    if (!ids.length) return;

    var saved = 0;
    function next(i) {
      if (i >= ids.length) {
        status.textContent = saved === ids.length
          ? 'Saved ' + saved + '. Put them in assets/photos/.'
          : 'Saved ' + saved + ' of ' + ids.length + '.';
        return;
      }
      status.textContent = 'Saving ' + (i + 1) + ' of ' + ids.length + '…';
      savePhoto(ids[i]).then(function (ok) {
        if (ok) saved++;
        next(i + 1);
      });
    }
    next(0);
  }

  function savePhoto(id) {
    var dataUri = window.Photos.get(id);
    if (!dataUri) return Promise.resolve(false);
    var filename = id + '.jpg';
    var blob = dataUriToBlob(dataUri);
    if (!blob) return Promise.resolve(false);

    var host = (window.claude && typeof window.claude.use === 'function')
      ? window.claude.use('downloads') : null;
    if (!host) return Promise.resolve(saveBlobDirect(blob, filename));

    return Promise.resolve(host).then(function (downloads) {
      if (!downloads) return saveBlobDirect(blob, filename);
      return downloads.save({ filename: filename, data: blob })
        .then(function () { return true; })
        .catch(function () { return false; });
    }).catch(function () { return saveBlobDirect(blob, filename); });
  }

  function dataUriToBlob(dataUri) {
    try {
      var parts = dataUri.split(',');
      var mime = /:(.*?);/.exec(parts[0])[1];
      var binary = atob(parts[1]);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    } catch (e) { return null; }
  }

  function saveBlobDirect(blob, filename) {
    try {
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      return true;
    } catch (e) { return false; }
  }

  function wireFileDialog() {
    el('photo-export-save').addEventListener('click', savePhotosInTurn);
    el('save-file').addEventListener('click', openFileDialog);
    el('file-close').addEventListener('click', function () { el('file-dialog').close(); });
    el('file-copy').addEventListener('click', function () {
      var text = el('file-content').textContent;
      var status = el('file-status');
      function selectInstead() {
        var range = document.createRange();
        range.selectNodeContents(el('file-content'));
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        status.textContent = 'Selected — press Ctrl+C (or Cmd+C).';
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
          .then(function () { status.textContent = 'Copied. Save it over fleet.js.'; })
          .catch(selectInstead);
      } else {
        selectInstead();
      }
    });
    el('file-download').addEventListener('click', onDownloadFile);
  }

  // Saving a file works two different ways depending on where this is running.
  // Served from a folder, an ordinary download link writes fleet.js. Inside the
  // artifact viewer a page cannot download anything by itself — it has to ask
  // the host, which prompts the viewer and only allows certain extensions, .js
  // not among them. So there it saves as fleet.js.txt and says to rename it.
  function onDownloadFile() {
    var status = el('file-status');
    var text = el('file-content').textContent;

    var host = (window.claude && typeof window.claude.use === 'function')
      ? window.claude.use('downloads') : null;

    if (!host) { downloadDirect(text, status); return; }

    status.textContent = 'Asking the viewer…';
    Promise.resolve(host).then(function (downloads) {
      if (!downloads) { downloadDirect(text, status); return; }
      return downloads.save({ filename: 'fleet.js.txt', data: text }).then(function () {
        status.textContent = 'Saved as fleet.js.txt — rename it to fleet.js.';
      }).catch(function (error) {
        var code = error && error.code;
        status.textContent = code === 'declined' ? 'Save cancelled.'
          : code === 'rate_limited' ? 'A save prompt is already open.'
          : 'Could not save here — use Copy file instead.';
      });
    }).catch(function () { downloadDirect(text, status); });
  }

  function downloadDirect(text, status) {
    try {
      var blob = new Blob([text], { type: 'text/javascript' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = 'fleet.js';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      status.textContent = 'Saving fleet.js — if nothing arrives, use Copy file.';
    } catch (e) {
      status.textContent = 'Downloads are blocked here — use Copy file instead.';
    }
  }

  function wireRemoveDialog() {
    el('remove-cancel').addEventListener('click', function () { el('remove-dialog').close(); });
    el('remove-close').addEventListener('click', function () { el('remove-dialog').close(); });
    el('remove-confirm').addEventListener('click', confirmRemoval);
    el('restore-hidden').addEventListener('click', function () {
      window.Vessel.unhideAll();
      reloadFleet(App.selected);
    });
  }

  // Hidden vessels are never silently gone: the rail says how many and offers
  // them back.
  function renderHiddenNote() {
    var hidden = window.Vessel.hiddenVessels(BASE_FLEET);
    var strayCount = window.Vessel.hiddenIds().length;
    var note = el('hidden-note');
    if (!strayCount) { note.hidden = true; return; }
    note.hidden = false;
    el('hidden-count').textContent = strayCount === 1
      ? '1 vessel hidden' + (hidden.length ? ' — ' + hidden[0].name : '')
      : strayCount + ' vessels hidden';
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      if (document.activeElement === el('search') && App.query) {
        el('search').value = '';
        App.query = '';
        renderRail(true);
      } else if (App.selected) {
        select(null);
      }
      return;
    }
    // "/" focuses search, as it does everywhere else.
    if (event.key === '/' && document.activeElement !== el('search')) {
      event.preventDefault();
      el('search').focus();
    }
  }

  function tickClock() {
    el('clock').textContent = window.Fmt.clock(new Date(), window.CONFIG.office.timeZone);
  }

  function onStoreChange(store) {
    var pill = el('connection');
    pill.dataset.state = store.connection;
    el('connection-label').textContent = {
      demo: 'Demo data', open: 'Live AIS', connecting: 'Connecting',
      retrying: 'Reconnecting', listening: 'Listening',
      rejected: 'AIS refused', blocked: 'AIS unreachable',
      closed: 'Offline', starting: 'Starting'
    }[store.connection] || store.connection;

    adoptWhatWeHear();
    renderRail(false);
    renderWork(false);
    renderReadout();
    renderChartHome();
    if (App.selected) aimChart();
  }

  window.FleetConsole = App;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
