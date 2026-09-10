/* -----------------------------------------------------------------------------
 * Fleet Watch — settings
 *
 * Everything an office is likely to want to change lives in this one file.
 * The fleet itself is in fleet.js.
 * -------------------------------------------------------------------------- */

window.CONFIG = {

  /* --- Identity ---------------------------------------------------------- */

  // Shown top-left. The O is drawn as the power symbol from the logo when
  // `brandPowerMark` is on, matching the way the wordmark is set in the brand
  // book. Set `brandLogo` to an image path to use the real artwork instead —
  // a transparent PNG of the horizontal logotype, light or cyan on transparent,
  // sized around 600 px wide. That replaces the wordmark entirely.
  brand: 'ICON CONNECT',
  brandPowerMark: true,
  brandLogo: null,              // e.g. 'assets/logo-iconconnect.png'
  // Set beneath the wordmark, as the lockup does. Left as board ink rather than
  // the artwork's black, which would disappear against a dark ground.
  // Stamped by tools/build-single-file.js with the date and commit it was built
  // from, and left empty when running from a folder. It exists because a
  // diagnostic report is worth nothing if nobody can tell which build produced
  // it — three similarly named files in a downloads folder is all it takes.
  buildStamp: '',

  brandLocations: 'London  -  Monaco',
  subtitle: 'Fleet Watch',
  strapline: 'Technologies to enhance your life',

  /* --- Live AIS ---------------------------------------------------------- */

  // Free API key from https://aisstream.io (sign in with GitHub, generate a key).
  // Leave empty and the board runs in DEMO MODE with simulated movement, so you
  // can see exactly how it will look before you sign up for anything.
  //
  // WHILE THIS IS EMPTY NOTHING ON THE BOARD IS REAL. Every position, every
  // track, every figure is generated from the `demo` block in each fleet.js
  // record. The "Demo data" chip in the corner is the only thing saying so.
  //
  // Filling it in changes three things worth expecting:
  //   - Positions become real, keyed on MMSI. AIS broadcasts MMSI, never IMO,
  //     so a wrong MMSI silently tracks a stranger. The console now checks the
  //     name, IMO and size the transponder reports against each record and says
  //     so when they disagree.
  //   - Tracks start from empty. AISstream is a live stream with no history and
  //     no backfill: the board draws a trail from the moment it first hears a
  //     yacht, keeps it in this browser, and knows nothing of last week.
  //   - Gaps become normal. Terrestrial receivers reach perhaps 40 nm offshore,
  //     and a yacht crossing an ocean or running dark for the owner's privacy
  //     simply stops reporting. The board ages the last fix rather than
  //     pretending.
  aisStreamApiKey: '',

  // AISstream delivers terrestrial AIS. Mid-ocean gaps are normal and expected:
  // a yacht crossing the Atlantic will simply go quiet for days. So will one
  // whose captain has switched the transponder off. Both are handled as
  // "last known position" rather than as errors.
  /**
   * Which AIS provider the board listens to.
   *
   *   'aisstream'     free, a WebSocket that pushes. Measured over a
   *                   fortnight: it carried thirty-five of our sixty-one, and
   *                   its busiest vessel out of twenty-six thousand was heard
   *                   nine times in four minutes. Its receiver network is what
   *                   it is; no setting at this end changes that.
   *   'marinetraffic' paid, an HTTP endpoint you poll. Where this fleet was
   *                   validated in the first place, so it is known to have all
   *                   sixty-one, and it says whether a position came from a
   *                   shore receiver or a satellite. No tier reaches sixty
   *                   vessels, so it is on the shelf.
   *   'relay'         our own Web App, which reads one of the below once for
   *                   the whole company and serves the board from the same
   *                   origin. No key at this end, no CORS, and a metered
   *                   provider billed once however many screens there are.
   *                   This is what a wall board should be set to.
   *   'vesselapi'     paid, and a STREAM rather than a snapshot: reports
   *                   newest first, a page at a time, with a cursor. All
   *                   sixty-one for one request, and the first real answer
   *                   contained nothing but ours — the MMSI filter works,
   *                   which AISstream's did not.
   */
  provider: 'relay',

  /**
   * MarineTraffic, when `provider` names it.
   *
   * `endpoint` exists because this is a SERVER-side API: a browser calling
   * services.marinetraffic.com will very likely be refused by CORS, and the
   * key would be sitting in a page in any case. Point it at the relay and both
   * problems go away.
   *
   * The two intervals are what it costs. Every poll is one request covering
   * the whole fleet; `timespanMinutes` is how far back the answer may reach,
   * and wants to be comfortably longer than the gap between polls or a vessel
   * that reported just after the last one falls between them.
   */
  marineTraffic: {
    endpoint: 'https://services.marinetraffic.com/api/exportvessels',
    pollMinutes: 15,
    // Their ceiling, not ours: 60 minutes on terrestrial coverage, 180 with
    // satellite. Set `satellite` only if the plan actually includes it —
    // asking for 180 without it is asking for a refusal.
    timespanMinutes: 60,
    satellite: false
  },

  /**
   * VesselAPI, when `provider` names it.
   *
   * A STREAM, and every setting here follows from that. Reading a stream costs
   * a request per page of reports however often you look, so `pollMinutes` is
   * very nearly free to lower — the board can be two minutes fresh for what it
   * costs to be twenty — while `pageSize` divides the bill directly. At the
   * rate the fleet was observed talking, twenty reports a page is about ten
   * thousand requests a month and two hundred a page is about a thousand.
   *
   * `endpoint` exists because this is a server-side API. A page calling it is
   * refused by CORS, and a key in an Authorization header makes the browser ask
   * permission first with an OPTIONS request that api.vesselapi.com has no
   * reason to answer. Point it at the relay, which holds the key as well.
   *
   * TWO OF THESE ARE GUESSES AND ARE HERE SO THEY CAN BE CORRECTED WITHOUT
   * TOUCHING CODE. A response names its cursor `nextToken` but says nothing
   * about what to call it going back, and nothing about how to ask for a bigger
   * page. If `cursorParam` is wrong the adapter notices — page two comes back
   * as page one — and stops rather than re-reading one page down the allowance.
   */
  /**
   * The relay, when `provider` names it.
   *
   * `endpoint` is a path rather than a URL on purpose: the board is served by
   * the relay, so it asks the origin it was loaded from and there is nothing to
   * keep in step when the Web App is renamed or moved behind a new hostname.
   *
   * `pollSeconds` is nearly free — this is our own server on the same origin,
   * about eight kilobytes an answer, not a metered API. It is what decides how
   * fresh the wall looks.
   */
  relay: {
    endpoint: '/api/fleet',
    pollSeconds: 30
  },

  vesselApi: {
    endpoint: 'https://api.vesselapi.com/v1/vessels/positions',
    pollMinutes: 3,
    // How many pages a routine poll may spend. A ceiling, not a target: a
    // caught-up board usually reads one. It exists so that something upstream
    // repeating itself cannot empty a month's allowance in an afternoon.
    pagesPerPoll: 4,
    // The first look has an empty board to fill and no watermark to stop at,
    // so it is allowed to reach further back.
    backfillPages: 12,
    // Their default page is twenty. Anything larger divides the monthly cost by
    // the same factor — worth knowing exactly what they will serve.
    pageSize: null,
    pageParam: 'limit',
    cursorParam: 'nextToken'
  },

  ais: {
    endpoint: 'wss://stream.aisstream.io/v0/stream',

    /**
     * Ask the server for only our own vessels?
     *
     * No, and this was learned the hard way. Subscribing with FiltersShipMMSI
     * reached thirty-one of sixty-one after a full day and stopped there, while
     * a second provider had every one of the silent ones reporting within
     * minutes. The same key with no filter floods — five and a half thousand
     * frames in under a minute — and aisstream's own issue tracker carries the
     * same complaint from other people more than once.
     *
     * So the board takes everything and picks its own fleet out of it. That
     * costs bandwidth, which the AIS panel measures and shows in MB per hour
     * rather than leaving to anyone's judgement. Turn this on to go back to
     * asking the server, if a metered connection ever makes that the lesser
     * problem.
     */
    filterAtServer: false,

    reconnectBaseMs: 2000,      // exponential backoff, capped below
    reconnectMaxMs: 60000,
    // A position older than this is drawn faded and labelled with its age.
    stalePositionMinutes: 90,
    // Older than this and the yacht is treated as dark: last known position
    // only, no speed or course shown.
    darkPositionHours: 12
  },

  /* --- Weather ----------------------------------------------------------- */

  // Open-Meteo needs no key and no account. Set enabled:false to run the board
  // with no outbound requests at all beyond AIS.
  weather: {
    enabled: true,
    refreshMinutes: 30,
    // Requests are staggered so eight yachts don't all fire at once.
    staggerMs: 1500
  },

  /* --- Units ------------------------------------------------------------- */

  units: {
    distance: 'nm',            // 'nm' | 'km'
    speed: 'kn',               // 'kn' | 'kmh'
    temperature: 'C',          // 'C' | 'F'
    windSpeed: 'kn'            // 'kn' | 'ms' | 'kmh'
  },

  // Office location — used for the "nearest to us" line and the header clock.
  //
  // Letchworth Garden City: the UK headquarters. This was set to central London
  // because London was the nearest of the three options I offered, none of which
  // was Letchworth — thirty-five miles, which is nothing against a distance
  // measured in hundreds, but the label was wrong and the label is what people
  // read. Same time zone either way.
  office: {
    label: 'Letchworth',
    lat: 51.9781,
    lon: -0.2296,
    timeZone: 'Europe/London'   // any IANA zone; used for the header clock
  },

  /* --- Our own places on the chart ---------------------------------------- */

  /**
   * Icon Connect's own locations, drawn on the chart alongside the fleet.
   *
   *   kind: 'hq'    a headquarters — drawn as the company's own mark
   *   kind: 'yard'  a yard where a yacht is being built — drawn as a diamond
   *
   * Coordinates are town-level, which is the right precision for a mark on a
   * world chart: a yard's exact berth would be false accuracy at any zoom the
   * board ever shows, and would move as often as the yachts do.
   *
   * These are shown whatever else is hidden. Anonymous mode withholds the
   * CLIENTS' identities; these are ours, and on a board being shown to a
   * prospect they are rather the point.
   */
  sites: [
    // The short form, and the same one the header clock uses, so the board
    // never calls one place by two names.
    //
    // Not for legibility, though it was offered as that: measured across
    // thirty-three framings the office is on screen for, the long name and the
    // short one both label twenty-seven times. Length mattered when a site had
    // exactly one position to try — 9 against 15 — but it now has eight, and
    // that absorbed the difference. A name is a naming decision; the layout
    // was the layout's problem and is fixed in the layout.
    { name: 'Letchworth', kind: 'hq',   lat: 51.9781, lon: -0.2296 },
    { name: 'Monaco',     kind: 'hq',   lat: 43.7384, lon: 7.4246 },
    { name: 'Antalya',    kind: 'yard', lat: 36.8969, lon: 30.7133 },
    { name: 'Istanbul',   kind: 'yard', lat: 41.0082, lon: 28.9784 },
    { name: 'Amsterdam',  kind: 'yard', lat: 52.3676, lon: 4.9041 }
  ],

  /* --- Rotation ---------------------------------------------------------- */

  // How long each view holds, in seconds. The chart gets the longest dwell
  // because it is the one people actually look up at.
  rotation: {
    enabled: true,
    chartSeconds: 75,
    spotlightSeconds: 24,       // per yacht
    statsSeconds: 40,
    // Spotlight steps through every yacht before moving on. Set false to show
    // a single random yacht per rotation instead.
    spotlightAllYachts: true
  },

  /* --- Discretion -------------------------------------------------------- */

  // Superyacht owners pay for privacy. If this screen is visible to visitors,
  // reception, or through a window, consider turning this on: positions are
  // rounded to the nearest `discreetRoundingNm` and shown as a region rather
  // than a fix. Individual yachts can also be marked `discreet: true` in
  // fleet.js, which applies the same treatment regardless of this setting.
  // Press D on the keyboard to toggle it for everyone at any time.
  discreetMode: false,
  discreetRoundingNm: 60,

  // For any screen nobody is sitting at. When locked, the D key stops working, so
  // whatever this build decided is what the screen shows — nobody passing it
  // can change the setting in either direction.
  //
  // The lock does not itself turn discretion on. With `discreetMode: false`
  // below, a locked board shows exact positions for the fleet and withholds
  // only the yachts marked `discreet: true` in fleet.js. That marking is the
  // protection that does not depend on anyone remembering, and it applies on
  // every screen, locked or not. Set `discreetMode: true` as well if the whole
  // board should be approximate.
  //
  // Set this true on the office display. Leave it false on the console, where
  // there is somebody present to work the toggle and to put it back.
  discreetLocked: false,

  /* --- Anonymity ---------------------------------------------------------- */

  // A different protection from discretion above, for a different risk.
  //
  // Discretion hides WHERE a yacht is. Anonymity hides WHOSE she is — that this
  // fleet is our client list. Positions are public: every vessel broadcasts hers
  // in clear, and anyone with an AIS receiver or a free website can read them.
  // The association between Icon Connect and a particular yacht is not public,
  // and that is what a visitor in reception, or a prospect being shown the
  // breadth of the fleet, should not be able to read off the screen.
  //
  // On, the board keeps its shape — how many yachts, how large, where they are
  // — and drops every field that identifies one: name, MMSI, IMO, call sign,
  // builder, year, and photographs. Length stays, because length is the point of
  // the demonstration.
  //
  // Press A to toggle, unless anonymousLocked is set. Build with --anonymous to
  // ship a screen that is anonymous from start-up and cannot be talked out of it.
  anonymousMode: false,
  anonymousLocked: false,

  /* --- Demo mode --------------------------------------------------------- */

  // Only used while aisStreamApiKey is empty. Time is compressed so movement is
  // actually visible: 30 means one real second of watching is thirty seconds of
  // simulated passage. Set to 1 for true real-time (and near-motionless) demo.
  demo: {
    timeScale: 30
  },

  /* --- Console ----------------------------------------------------------- */

  // Settings for console.html, the desk tool. The office display ignores these.
  // When a vessel broadcasts something her record has not got — her IMO, call
  // sign, length, beam, or whether she is motor or sail — take it. Only ever
  // fills a blank: a value somebody typed stays, and goes on being compared
  // with what she broadcasts, which is what catches a wrong MMSI.
  //
  // Turn it off and the console offers the same fields on a button instead.
  autoFillFromAis: true,

  /* --- Look -------------------------------------------------------------- */

  display: {
    // Slow drift keeps an OLED panel happy and stops the image feeling frozen.
    ambientMotion: true,
    // Light off the north-west of every landmass, shade off the south-east, and
    // a glow where the coast meets the water. Without it the chart is two flat
    // colours with a line between them.
    landShading: true,
    // Nudge the whole layout a few pixels every few minutes (burn-in insurance).
    pixelShift: true,
    pixelShiftMinutes: 7,
    // Draw the last N hours of each yacht's track behind it.
    trackHours: 24,
    // Dim the whole board outside office hours so it isn't glaring at night.
    // This is an evening dim, not a blackout: it should take the edge off a
    // bright panel in a dark room while leaving the board perfectly readable.
    nightDimming: true,
    nightDimFrom: 19,          // local hour
    nightDimTo: 7,
    nightDimOpacity: 0.78
  }
};
