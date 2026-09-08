/* -----------------------------------------------------------------------------
 * app.js — bootstrap, the rotation, and the render loop.
 * -------------------------------------------------------------------------- */

(function () {
  'use strict';

  var App = { paused: false, scene: 0, sceneStartedAt: 0, scenes: [] };

  var MAP_FPS = 30;                 // ambient, not a game
  var RECOMPUTE_MS = 1000;
  var PERSIST_MS = 30000;

  var el = function (id) { return document.getElementById(id); };

  /* --- Boot -------------------------------------------------------------- */

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
   * fleet.js parsed and had vessels in it, but every one of them is hidden in
   * this browser. Reusing the fleet.js error would blame the wrong thing.
   */
  function everyVesselHidden() {
    document.body.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'boot-error';
    box.innerHTML =
      '<h1>Every vessel is hidden</h1>' +
      '<p>fleet.js loaded, but each yacht in it has been removed from view in ' +
      'this browser. Put them back from the console, under the vessel list.</p>';
    document.body.appendChild(box);
  }

  function boot() {
    if (!fleetLoaded('the board')) return;

    // The console keeps additions, edits and removals in this browser's
    // localStorage until they are written back into fleet.js. The board read
    // only fleet.js, so a yacht added in the console never appeared here at all
    // — which looks exactly like the add having failed. Same merge, same rules,
    // including hidden vessels staying hidden.
    window.FLEET = window.Vessel.mergedFleet(window.FLEET);
    if (!window.FLEET.length) { everyVesselHidden(); return; }

    // Decided before init, because restoring the cache depends on it: a cache of
    // real fixes must not be loaded into a simulation, nor a simulation's into a
    // live board, and init is where the restore happens.
    window.Store.mode = window.Settings.aisKey() ? 'live' : 'demo';
    window.Store.init(window.FLEET);
    window.FleetMap.init(el('chart-canvas'));

    renderBrand();
    el('brand-locations').textContent = window.CONFIG.brandLocations || '';
    el('brand-sub').textContent = window.CONFIG.subtitle || '';
    el('strapline').textContent = window.CONFIG.strapline || '';

    renderDiscreetFlag();
    buildScenes();
    window.FleetMap.fit(fleetPoints(), 90, null, chartInset());
    window.FleetMap.snap();

    startFeed();
    window.Weather.start();

    window.Store.subscribe(onStoreChange);

    // The pill already says "Demo data"; making it the way in means the person
    // standing at the screen does not have to know that K opens anything.
    el('connection').addEventListener('click', function () {
      window.Settings.openAisDialog();
    });
    window.Settings.onChange(restartFeed);

    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousemove', onPointer);
    document.addEventListener('keydown', noteActivity);
    document.addEventListener('mousemove', noteActivity);
    if (window.CONFIG.discreetLocked) {
      var key = document.getElementById('hint-discreet');
      if (key) key.remove();
    }
    if (window.CONFIG.anonymousLocked) {
      var akey = document.getElementById('hint-anonymous');
      if (akey) akey.remove();
    }
    // Down first, so the chart is standing still by the time the click that
    // follows is hit-tested against it.
    el('chart-canvas').addEventListener('pointerdown', onCanvasPointerDown);
    el('chart-canvas').addEventListener('click', onCanvasClick);
    el('rail-list').addEventListener('click', onRailClick);
    el('hint-close').addEventListener('click', function () {
      el('hint').classList.remove('visible');
    });
    el('view-prev').addEventListener('click', function () { stepView(-1); });
    el('view-next').addEventListener('click', function () { stepView(1); });
    el('view-pause').addEventListener('click', togglePause);

    setInterval(function () { window.Store.recompute(); }, RECOMPUTE_MS);
    setInterval(function () { window.Store.persist(); }, PERSIST_MS);
    setInterval(tickClock, 1000);
    setInterval(applyAmbientChrome, 60000);
    setInterval(checkAutoResume, 15000);

    // Shown once at start-up, then only when a pointer moves.
    showHint();

    tickClock();
    applyAmbientChrome();
    enterScene(0);
    requestAnimationFrame(frame);
  }

  // The wordmark, with the power symbol standing in for the first O the way the
  // logo does. Falls back to plain text if the name has no O, and is skipped
  // entirely when a logo image is configured.
  function renderBrand() {
    var host = el('brand');
    var cfg = window.CONFIG;
    host.textContent = '';

    if (cfg.brandLogo) {
      var img = document.createElement('img');
      img.src = cfg.brandLogo;
      img.alt = cfg.brand || '';
      // If the file isn't there, fall back to the wordmark rather than a broken image.
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

  // A ring open at the top with a bar rising through the gap — the mark from the
  // logo, drawn rather than embedded so it stays crisp at any panel size and
  // takes its colour from the stylesheet.
  function powerMark() {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'power-o');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('aria-hidden', 'true');

    var ring = document.createElementNS(NS, 'path');
    // Centre (50,55), radius 32. The gap is narrow and sits square at twelve
    // o'clock — just wide enough for the bar — so the O still reads as a letter.
    // The arc therefore runs the long way: from -74 degrees clockwise to 254.
    ring.setAttribute('d', 'M 59.1 22.9 A 33 33 0 1 1 40.9 22.9');
    svg.appendChild(ring);

    var bar = document.createElementNS(NS, 'line');
    // Rises just clear of the ring and drops about a third of the way into it.
    bar.setAttribute('x1', '50'); bar.setAttribute('y1', '8');
    bar.setAttribute('x2', '50'); bar.setAttribute('y2', '42');
    svg.appendChild(bar);

    return svg;
  }

  // Which provider, and the stop-before-start that keeps the demo from writing
  // invented fixes over real ones, both live in feed.js now — the console had
  // its own copy of this and the two had to be kept in step by hand.
  function startFeed() { window.Feed.start(); }
  function restartFeed() { window.Feed.restart(); }

  /* --- Scenes ------------------------------------------------------------ */

  // The rotation. Spotlight expands into one scene per yacht so every boat gets
  // its turn rather than the same one every cycle.
  function buildScenes() {
    var r = window.CONFIG.rotation;
    App.scenes = [{ view: 'chart', seconds: r.chartSeconds }];

    if (r.spotlightAllYachts) {
      window.Store.vessels.forEach(function (v) {
        App.scenes.push({ view: 'spotlight', seconds: r.spotlightSeconds, vesselId: v.yacht.id });
      });
    } else {
      App.scenes.push({ view: 'spotlight', seconds: r.spotlightSeconds, vesselId: null });
    }

    App.scenes.push({ view: 'stats', seconds: r.statsSeconds });

    var dots = el('rotation-dots');
    dots.textContent = '';
    // One dot per view, not per yacht — eight spotlight dots would be noise.
    ['chart', 'spotlight', 'stats'].forEach(function (name) {
      var dot = document.createElement('div');
      dot.className = 'rotation-dot';
      dot.dataset.view = name;
      var fill = document.createElement('span');
      fill.className = 'fill';
      dot.appendChild(fill);
      dots.appendChild(dot);
    });
  }

  var VIEW_TITLES = {
    chart: 'Fleet chart',
    spotlight: 'Vessel detail',
    stats: 'Fleet summary'
  };

  function enterScene(index) {
    // A list is anchored to a spot on the chart. The chart is about to go.
    window.Picker.close();
    App.scene = ((index % App.scenes.length) + App.scenes.length) % App.scenes.length;
    App.sceneStartedAt = performance.now();
    setViewTitle();
    var scene = App.scenes[App.scene];

    ['chart', 'spotlight', 'stats'].forEach(function (name) {
      el('view-' + name).classList.toggle('active', name === scene.view);
    });
    Array.prototype.forEach.call(el('rotation-dots').children, function (dot) {
      dot.classList.toggle('current', dot.dataset.view === scene.view);
      if (dot.dataset.view !== scene.view) dot.firstChild.style.width = '0%';
    });

    if (scene.view === 'chart') {
      chartTour.reset();
      window.FleetMap.fit(fleetPoints(), 90, null, chartInset());
      window.Views.renderRail(null);
    } else if (scene.view === 'spotlight') {
      var v = pickSpotlightVessel(scene);
      if (v) window.Views.renderSpotlight(v);
    } else if (scene.view === 'stats') {
      window.Views.renderStats();
    }
  }

  function pickSpotlightVessel(scene) {
    if (scene.vesselId) {
      for (var i = 0; i < window.Store.vessels.length; i++) {
        if (window.Store.vessels[i].yacht.id === scene.vesselId) return window.Store.vessels[i];
      }
    }
    return window.Store.vessels[Math.floor(Math.random() * window.Store.vessels.length)];
  }

  // The fleet rail is painted over the chart, so the camera has to treat that
  // strip as unusable. Measured rather than assumed: the rail is sized in rem.
  function width() {
    return document.getElementById('stage').getBoundingClientRect().width;
  }

  function chartInset() {
    var rail = document.querySelector('#view-chart .rail');
    var railWidth = rail ? rail.getBoundingClientRect().width : 0;
    return { left: railWidth * 0.86, right: 24 };
  }

  function fleetPoints() {
    return window.Store.vessels
      .filter(function (v) { return v.derived.lat != null; })
      .map(function (v) { return [v.derived.lon, v.derived.lat]; });
  }

  /* --- The chart's slow tour ---------------------------------------------- */

  // While the chart is up, hold the whole fleet for a while, then ease in on one
  // yacht at a time. It is the difference between a map and something worth
  // glancing at twice.
  var chartTour = {
    phase: 'fleet',
    index: 0,
    nextAt: 0,
    reset: function () {
      this.phase = 'fleet';
      this.index = 0;
      this.nextAt = performance.now() + 20000;
    },
    update: function (now) {
      if (now < this.nextAt) return;
      var visible = window.Store.vessels.filter(function (v) { return v.derived.lat != null; });
      if (!visible.length) return;

      if (this.phase === 'fleet') {
        this.phase = 'vessel';
        this.index = Math.floor(Math.random() * visible.length);
      } else {
        this.index = (this.index + 1) % visible.length;
        // Every few yachts, pull back out to the whole fleet for context.
        if (this.index % 3 === 0) this.phase = 'fleet';
      }

      if (this.phase === 'fleet') {
        window.FleetMap.fit(fleetPoints(), 90, null, chartInset());
        window.Views.renderRail(null);
        this.nextAt = now + 18000;
      } else {
        var v = visible[this.index];
        // Frame roughly 500 nm of sea across the free width. `scale` is the pixel
        // width of the whole world, so degrees on screen = 360 * width / scale.
        var free = width() - chartInset().left;
        var degreesWanted = 500 / 60 / Math.max(0.2, Math.cos(v.derived.lat * Math.PI / 180));
        window.FleetMap.centreOn(v.derived.lon, v.derived.lat,
          360 * free / degreesWanted, chartInset());
        window.Views.renderRail(v.yacht.id);
        this.nextAt = now + 14000;
      }
    },
    currentId: function () {
      if (this.phase !== 'vessel') return null;
      var visible = window.Store.vessels.filter(function (v) { return v.derived.lat != null; });
      var v = visible[this.index];
      return v ? v.yacht.id : null;
    }
  };

  /* --- Frame loop --------------------------------------------------------- */

  var lastMapFrame = 0;

  function frame(now) {
    requestAnimationFrame(frame);

    var scene = App.scenes[App.scene];

    if (scene.view === 'chart') {
      if (now - lastMapFrame >= 1000 / MAP_FPS) {
        lastMapFrame = now;
        if (!App.paused) chartTour.update(now);
        window.FleetMap.render(now, window.Store.vessels, {
          highlight: chartTour.currentId(),
          inset: chartInset()
        });
        // Belt and braces: pausing stops the tour, but a keypress or a refit
        // can still move the chart while a list is open over it.
        window.Picker.checkStillValid();
      }
    }

    if (!App.paused) {
      var elapsed = now - App.sceneStartedAt;
      var duration = scene.seconds * 1000;
      updateProgress(scene.view, Math.min(1, elapsed / duration));
      if (window.CONFIG.rotation.enabled && elapsed >= duration) enterScene(App.scene + 1);
    }
  }

  function updateProgress(view, fraction) {
    var dots = el('rotation-dots').children;
    for (var i = 0; i < dots.length; i++) {
      if (dots[i].dataset.view === view) {
        dots[i].firstChild.style.width = (fraction * 100).toFixed(1) + '%';
      }
    }
  }

  /* --- Chrome ------------------------------------------------------------- */

  /**
   * Say on the board that positions are approximate.
   *
   * This used to be set only by the D key, so a locked build — the case where
   * it matters most, since nobody is sitting there to explain it — showed a
   * 60 nm circle with nothing to say it was one. A visitor reading the centre of that circle as a position
   * would be wrong by up to sixty miles and have no way of knowing.
   *
   * Locked and unlocked read differently on purpose: the toggle is a state
   * someone chose and can undo, the lock is how this screen is built.
   */
  function renderDiscreetFlag() {
    var parts = [];
    if (window.CONFIG.anonymousMode) parts.push('Names withheld');
    if (window.CONFIG.discreetMode) {
      parts.push(window.CONFIG.discreetLocked ? 'Approximate positions' : 'Discreet mode');
    }
    el('discreet-flag').textContent = parts.join('  ·  ');
  }

  function tickClock() {
    var now = new Date();
    el('clock').textContent = window.Fmt.clock(now, window.CONFIG.office.timeZone);
    el('clock-zone').textContent = window.CONFIG.office.label;
  }

  function onStoreChange(store) {
    var pill = el('connection');
    pill.dataset.state = store.connection;
    var label = {
      demo: 'Demo data',
      open: 'Live AIS',
      connecting: 'Connecting',
      retrying: 'Reconnecting',
      listening: 'Listening',
      rejected: 'AIS refused',
      blocked: 'AIS unreachable',
      closed: 'Offline',
      starting: 'Starting'
    }[store.connection] || store.connection;
    el('connection-label').textContent = label;

    // Refresh whichever view is on screen, so a new fix is visible immediately
    // rather than at the next rotation.
    var scene = App.scenes[App.scene];
    if (!scene) return;
    if (scene.view === 'chart') {
      window.Views.renderRail(chartTour.currentId());
    } else if (scene.view === 'spotlight') {
      var v = pickSpotlightVessel(scene);
      if (v && scene.vesselId) window.Views.renderSpotlight(v);
    } else if (scene.view === 'stats') {
      window.Views.renderStats();
    }
  }

  // Burn-in shift and the after-hours dim.
  var shiftStep = 0;
  function applyAmbientChrome() {
    var d = window.CONFIG.display;
    var board = el('board');

    if (d.pixelShift) {
      var minutes = Date.now() / 60000;
      var step = Math.floor(minutes / d.pixelShiftMinutes);
      if (step !== shiftStep) {
        shiftStep = step;
        var dx = (step % 5) - 2, dy = (Math.floor(step / 5) % 5) - 2;
        board.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      }
    }

    if (d.nightDimming) {
      var hour = new Date().getHours();
      var isNight = d.nightDimFrom > d.nightDimTo
        ? (hour >= d.nightDimFrom || hour < d.nightDimTo)
        : (hour >= d.nightDimFrom && hour < d.nightDimTo);
      board.style.opacity = isNight ? String(d.nightDimOpacity) : '1';
    }
  }

  function onResize() {
    window.FleetMap.resize();
    window.FleetMap.readTheme();
  }

  /* --- Keyboard ----------------------------------------------------------- */

  var pointerTimer = null;
  var hintTimer = null;

  function onPointer() {
    document.body.classList.add('interactive');
    showHint();
    clearTimeout(pointerTimer);
    pointerTimer = setTimeout(function () {
      document.body.classList.remove('interactive');
    }, 4000);
  }

  // The shortcuts are invisible until something tells you about them. This costs
  // nothing on a wall — the pointer never moves there and the board only ever
  // shows it once, at boot — and it is the difference between someone opening a
  // link and watching one view, or actually finding the other three.
  function showHint() {
    var hint = el('hint');
    hint.classList.add('visible');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { hint.classList.remove('visible'); }, 5000);
  }

  /**
   * A hand on the chart stops it.
   *
   * The chart tour is always easing somewhere. Aiming at a yacht — or at a
   * disc standing for twenty of them — on a chart that is panning under the
   * pointer is a lottery, and the miss is silent: you click, and nothing at
   * all happens. So the press freezes the chart, and the click that follows
   * lands on the frame the pointer was aimed at.
   *
   * Held rather than snapped: snapping would jump to wherever the tour was
   * heading and take the mark with it. Nothing here is permanent — a board
   * touched and then walked away from starts moving again on its own after
   * five minutes.
   */
  function onCanvasPointerDown() {
    if (App.scenes[App.scene].view !== 'chart') return;
    noteActivity();
    if (!App.paused) {
      App.paused = true;
      setViewTitle();
    }
    window.FleetMap.hold();
  }

  function onCanvasClick(event) {
    var rect = el('chart-canvas').getBoundingClientRect();
    // Several yachts inside twenty pixels is normal in Port Hercule, and at
    // fleet zoom twenty of them draw as one disc. Picker selects outright when
    // there is only one under the pointer, and offers a list when there is a
    // crowd — otherwise the ones behind the nearest marker are unreachable.
    window.Picker.handleClick(event.clientX - rect.left, event.clientY - rect.top,
                              showVessel);
  }

  function onRailClick(event) {
    var row = event.target.closest('.rail-row');
    if (row && row.dataset.yachtId) showVessel(row.dataset.yachtId);
  }

  // A board paused by hand and then forgotten is a board showing yesterday. If
  // nobody has touched it for a while, start moving again on its own.
  var RESUME_AFTER_MS = 5 * 60 * 1000;
  var lastActivity = Date.now();

  function noteActivity() {
    lastActivity = Date.now();
  }

  function checkAutoResume() {
    if (App.paused && Date.now() - lastActivity > RESUME_AFTER_MS) {
      App.paused = false;
      App.sceneStartedAt = performance.now();
      setViewTitle();
    }
  }

  function togglePause() {
    App.paused = !App.paused;
    if (!App.paused) App.sceneStartedAt = performance.now();
    setViewTitle();
  }

  function setViewTitle() {
    var scene = App.scenes[App.scene];
    el('view-title').textContent =
      (App.paused ? 'Paused · ' : '') + (VIEW_TITLES[scene.view] || '');
    var pause = el('view-pause');
    pause.setAttribute('aria-pressed', String(App.paused));
    pause.setAttribute('aria-label', App.paused ? 'Resume rotation' : 'Pause rotation');
  }

  function onKey(event) {
    if (event.key === 'Escape' && window.Picker.isOpen()) {
      window.Picker.close();
      return;
    }
    switch (event.key) {
      case ' ':
        event.preventDefault();
        togglePause();
        break;
      case 'ArrowRight': stepView(1); break;
      case 'ArrowLeft': stepView(-1); break;
      case '1': jumpToView('chart'); break;
      case '2': jumpToView('spotlight'); break;
      case '3': jumpToView('stats'); break;
      case 'd': case 'D':
        /**
         * A locked screen's discretion is not up for discussion at the
         * keyboard — in either direction. The lock fixes whatever the build
         * decided; it does not itself decide anything. Yachts marked
         * `discreet` in fleet.js are withheld regardless of any of this, which
         * is the protection that does not depend on a person remembering.
         */
        if (window.CONFIG.discreetLocked) break;
        window.CONFIG.discreetMode = !window.CONFIG.discreetMode;
        renderDiscreetFlag();
        window.Store.recompute();
        enterScene(App.scene);
        break;
      case 'f': case 'F':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
        break;
      case 'r': case 'R': location.reload(); break;
      case 'k': case 'K': window.Settings.openAisDialog(); break;
      case 'a': case 'A':
        // Same reasoning as D: a locked screen is not argued with at the keyboard.
        if (window.CONFIG.anonymousLocked) break;
        window.CONFIG.anonymousMode = !window.CONFIG.anonymousMode;
        renderDiscreetFlag();
        window.Store.recompute();
        enterScene(App.scene);
        break;
    }
  }

  // Show one yacht now. Used by both click paths. The rotation is not paused —
  // a board that stops because somebody brushed the mouse is worse than one
  // that moves on — but the scene timer restarts, so there is a full dwell to
  // read it before the board carries on.
  function showVessel(yachtId) {
    for (var i = 0; i < App.scenes.length; i++) {
      var scene = App.scenes[i];
      if (scene.view === 'spotlight' && scene.vesselId === yachtId) {
        enterScene(i);
        return true;
      }
    }
    // Spotlight is configured to show a single yacht per cycle, so there is no
    // scene of its own to jump to — render it into the one that exists.
    for (var j = 0; j < App.scenes.length; j++) {
      if (App.scenes[j].view === 'spotlight') {
        App.scenes[j].vesselId = yachtId;
        enterScene(j);
        return true;
      }
    }
    return false;
  }

  function jumpToView(view) {
    for (var i = 0; i < App.scenes.length; i++) {
      if (App.scenes[i].view === view) { enterScene(i); return; }
    }
  }

  // Stepping moves between the three views, not through the eight spotlight
  // scenes behind one of them — the footer shows three dots, so back and forward
  // should mean what those dots mean.
  var VIEW_ORDER = ['chart', 'spotlight', 'stats'];

  function stepView(delta) {
    var current = App.scenes[App.scene].view;
    var index = VIEW_ORDER.indexOf(current);
    if (index < 0) index = 0;
    var next = (index + delta + VIEW_ORDER.length) % VIEW_ORDER.length;
    jumpToView(VIEW_ORDER[next]);
  }

  window.App = App;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
