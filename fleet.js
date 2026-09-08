/* -----------------------------------------------------------------------------
 * THE FLEET — the vessels this board tracks.
 *
 * Built from the Icon Connect fleet sheet. You do not have to edit it by hand:
 * the console adds, edits and removes vessels, imports a whole fleet from a
 * CSV, exports one back out for Excel, and writes this file for you to save
 * over the top.
 *
 * WHAT IS HERE, AND WHAT IS NOT
 *
 * Name, MMSI, gross tonnage, builder, year and refit came from the sheet.
 * Flag was derived from the MMSI — the first three digits are allocated by the
 * ITU to a flag administration, so it is not a guess (see data/mid.js).
 *
 * Left null on purpose, because nobody has told us and inventing it would be
 * worse than leaving it blank:
 *
 *   prefix        M/Y or S/Y. The transponder says which: AIS ship type 36 is
 *                 a sailing vessel, 37 a pleasure craft, and the console fills
 *                 the field in the first time she is heard. Guessing it from
 *                 the builder would draw a mast on the wrong boat.
 *   imo, callSign, loa, beam
 *                 all carried in the AIS static message; same treatment.
 *   classSociety  not broadcast. Type it in, or leave it.
 *   photo         the sheet's last column named where a picture might be found
 *                 ("Image search", "BOAT International"), which is a research
 *                 note rather than a file. Drag photographs onto the console
 *                 and it matches them to vessels by filename.
 *   demo          no starting position for anyone but Cloudbreak, because we do
 *                 not know where these yachts are. In demo mode they read
 *                 "Position unknown" and stay off the chart, which is true. Live
 *                 AIS places each one the first time she is heard.
 *
 * DISCRETION — read this before the board goes on a wall
 *
 * Every vessel below has `discreet: false`, which means her exact position is
 * shown on every screen. Set `discreet: true` on any yacht whose whereabouts
 * should not be public and she is shown as an area instead, her track is not
 * drawn, and her speed, course and destination are withheld — on every build,
 * with no key to press and no setting to remember. Nobody has told us which
 * yachts those are, and it was not ours to decide.
 *
 * FIELDS
 *   id            unique short slug, used internally
 *   name          without the M/Y or S/Y prefix
 *   prefix        'M/Y' or 'S/Y'
 *   mmsi          9-digit Maritime Mobile Service Identity  ← required for live AIS
 *   imo           7-digit IMO number
 *   callSign, flag, flagCode
 *   loa, beam     metres
 *   grossTonnage
 *   builder, yearBuilt, lastRefit, classSociety
 *   photo         path to an image, e.g. 'assets/photos/aviva.jpg'. Left null,
 *                 a drawn side profile stands in for her — derived from length,
 *                 tonnage and rig, so it is a plausible yacht of her size but
 *                 not a likeness. Drop a photograph in and it takes over.
 *   discreet      true → never show an exact position for this yacht, regardless
 *                 of any other setting
 *   demo          starting state for DEMO MODE only; ignored once live AIS is on.
 *                 Needs one of `route`, `position: [lon, lat]`, or `port` named
 *                 from data/ports.js, or she never reaches the chart.
 * -------------------------------------------------------------------------- */

window.FLEET = [
  {
    // Damen SX6001
    id: 'after-you-0300',
    name: 'After You',
    prefix: null,
    mmsi: 319320300,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 1160,
    builder: 'Damen Yachting',
    yearBuilt: 2025, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'alaiya-5800',
    name: 'Alaiya',
    prefix: null,
    mmsi: 319165800,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 4699,
    builder: 'Lürssen',
    yearBuilt: 2019, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'alisa-0900',
    name: 'Alisa',
    prefix: null,
    mmsi: 319220900,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 499,
    builder: 'Overmarine Group (Mangusta)',
    yearBuilt: 2021, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'anawa-9000',
    name: 'Anawa',
    prefix: null,
    mmsi: 310799000,
    imo: null,
    callSign: null,
    flag: 'Bermuda',
    flagCode: 'BM',
    loa: null, beam: null, grossTonnage: 1843,
    builder: 'Damen Yachting',
    yearBuilt: 2020, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'ares-1900',
    name: 'Ares',
    prefix: null,
    mmsi: 319071900,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 467,
    builder: 'Heesen Yachts',
    yearBuilt: 2014, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'arkadia-8800',
    name: 'Arkadia',
    prefix: null,
    mmsi: 319178800,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 498,
    builder: 'Heesen Yachts',
    yearBuilt: 2021, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'asia-7400',
    name: 'Asia',
    prefix: null,
    mmsi: 319187400,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 1268,
    builder: 'Royal Hakvoort Shipyard',
    yearBuilt: 2024, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'asya-4000',
    name: 'Asya',
    prefix: null,
    mmsi: 319564000,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 499,
    builder: 'Heesen Yachts',
    yearBuilt: 2015, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    // ex Gatsby
    id: 'aurora-0715',
    name: 'Aurora',
    prefix: null,
    mmsi: 533110715,
    imo: null,
    callSign: null,
    flag: 'Malaysia',
    flagCode: 'MY',
    loa: null, beam: null, grossTonnage: 2113,
    builder: 'Lürssen',
    yearBuilt: 2017, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    // San Lorenzo
    id: 'avantage-0000',
    name: 'Avantage',
    prefix: null,
    mmsi: 248070000,
    imo: null,
    callSign: null,
    flag: 'Malta',
    flagCode: 'MT',
    loa: null, beam: null, grossTonnage: 290,
    builder: 'Sanlorenzo',
    yearBuilt: 2026, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'aviva-3000',
    name: 'Aviva',
    prefix: null,
    mmsi: 319763000,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 2047,
    builder: 'Abeking & Rasmussen',
    yearBuilt: 2007, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false,
    // Sentinel: the out-of-hours package. Set in the console, or here.
    sentinel: true
  },
  {
    // formerly Sibelle
    id: 'bijin-1700',
    name: 'Bijin',
    prefix: null,
    mmsi: 319341700,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 497,
    builder: 'Heesen Yachts',
    yearBuilt: 2015, lastRefit: 2022,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'casino-royale-9400',
    name: 'Casino Royale',
    prefix: null,
    mmsi: 319129400,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 1719,
    builder: 'Amels',
    yearBuilt: 2017, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    // ex Thunderball
    id: 'cerulean-4300',
    name: 'Cerulean',
    prefix: null,
    mmsi: 319364300,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 1100,
    builder: 'CRN Yachts',
    yearBuilt: 2026, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'cloudbreak-5800',
    name: 'Cloudbreak',
    prefix: null,
    mmsi: 319095800,
    // As entered in the console. Seven digits beginning 1 are IMO
    // company and owner numbers rather than ship numbers, so this is
    // worth checking against her paperwork. Tracking is unaffected:
    // AIS identifies her by MMSI alone.
    imo: 1012763,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: 72.25, beam: null, grossTonnage: 2308,
    builder: 'Abeking & Rasmussen',
    yearBuilt: 2016, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false,
    // Sentinel: the out-of-hours package. Set in the console, or here.
    sentinel: true,
    // The one demo position we have, because you told us. Ignored the
    // moment an AIS key is in.
    demo: { status: 'moored', port: 'Göcek' }
  },
  {
    // ex Amare II
    id: 'danica-8700',
    name: 'Danica',
    prefix: null,
    mmsi: 319288700,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 499,
    builder: 'Heesen Yachts',
    yearBuilt: 2020, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'ela-1605',
    name: 'Ela',
    prefix: null,
    mmsi: 538071605,
    imo: null,
    callSign: null,
    flag: 'Marshall Islands',
    flagCode: 'MH',
    loa: null, beam: null, grossTonnage: 499,
    builder: 'Heesen Yachts',
    yearBuilt: 2021, lastRefit: 2026,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    // Damen YS5303
    id: 'emotional-1850',
    name: 'Emotional',
    prefix: null,
    mmsi: 538071850,
    imo: null,
    callSign: null,
    flag: 'Marshall Islands',
    flagCode: 'MH',
    loa: null, beam: null, grossTonnage: 499,
    builder: 'Damen Yachting',
    yearBuilt: 2025, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    // ex Daisy D
    id: 'fan-too-1000',
    name: 'Fan Too',
    prefix: null,
    mmsi: 248771000,
    imo: null,
    callSign: null,
    flag: 'Malta',
    flagCode: 'MT',
    loa: null, beam: null, grossTonnage: 499,
    builder: 'Heesen Yachts',
    yearBuilt: 2019, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'felicita-6300',
    name: 'Felicita',
    prefix: null,
    mmsi: 319326300,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 499,
    builder: 'Overmarine Group (Mangusta)',
    yearBuilt: 2025, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'five-oceans-1849',
    name: 'Five Oceans',
    prefix: null,
    mmsi: 538071849,
    imo: null,
    callSign: null,
    flag: 'Marshall Islands',
    flagCode: 'MH',
    loa: null, beam: null, grossTonnage: 497,
    builder: 'Damen Yachting',
    yearBuilt: 2024, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'galaxy-5900',
    name: 'Galaxy',
    prefix: null,
    mmsi: 319055900,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 893,
    builder: 'Benetti',
    yearBuilt: 2005, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'ije-1332',
    name: 'IJE',
    prefix: null,
    mmsi: 538071332,
    imo: null,
    callSign: null,
    flag: 'Marshall Islands',
    flagCode: 'MH',
    loa: null, beam: null, grossTonnage: 3367,
    builder: 'Benetti',
    yearBuilt: 2019, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'jas-5700',
    name: 'Jas',
    prefix: null,
    mmsi: 319305700,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 1294,
    builder: 'Admiral (The Italian Sea Group)',
    yearBuilt: 2025, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'jems-4700',
    name: 'Jems',
    prefix: null,
    mmsi: 319004700,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 458,
    builder: 'Heesen Yachts',
    yearBuilt: 2009, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    // ex Just J's
    id: 'jubilee-8500',
    name: 'Jubilee',
    prefix: null,
    mmsi: 319088500,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 1219,
    builder: 'Royal Hakvoort Shipyard',
    yearBuilt: 2016, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'kadimos-1000',
    name: 'Kadimos',
    prefix: null,
    mmsi: 248271000,
    imo: null,
    callSign: null,
    flag: 'Malta',
    flagCode: 'MT',
    loa: null, beam: null, grossTonnage: 849,
    builder: 'Codecasa',
    yearBuilt: 2015, lastRefit: 2022,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'kaos-2000',
    name: 'Kaos',
    prefix: null,
    mmsi: 339302000,
    imo: null,
    callSign: null,
    flag: 'Jamaica',
    flagCode: 'JM',
    loa: null, beam: null, grossTonnage: 4523,
    builder: 'Oceanco',
    yearBuilt: 2017, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false,
    // Sentinel: the out-of-hours package. Set in the console, or here.
    sentinel: true
  },
  {
    // Admiral 584
    id: 'kensho-2300',
    name: 'Kensho',
    prefix: null,
    mmsi: 319242300,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 1989,
    builder: 'Admiral (The Italian Sea Group)',
    yearBuilt: 2022, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'l-oursin-7000',
    name: 'L\'Oursin',
    prefix: null,
    mmsi: 248597000,
    imo: null,
    callSign: null,
    flag: 'Malta',
    flagCode: 'MT',
    loa: null, beam: null, grossTonnage: 499,
    builder: 'Heesen Yachts',
    yearBuilt: 2018, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'la-gatta-9000',
    name: 'La Gatta',
    prefix: null,
    mmsi: 215789000,
    imo: null,
    callSign: null,
    flag: 'Malta',
    flagCode: 'MT',
    loa: null, beam: null, grossTonnage: 76,
    builder: 'Lagoon',
    yearBuilt: 2019, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'lady-beatrice-9000',
    name: 'Lady Beatrice',
    prefix: null,
    mmsi: 233219000,
    imo: null,
    callSign: null,
    flag: 'United Kingdom',
    flagCode: 'GB',
    loa: null, beam: null, grossTonnage: 970,
    builder: 'Feadship',
    yearBuilt: 1993, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'lady-maxine-4000',
    name: 'Lady Maxine',
    prefix: null,
    mmsi: 319394000,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 703,
    builder: 'Royal Hakvoort Shipyard',
    yearBuilt: 2010, lastRefit: 2026,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'laurentia-1251',
    name: 'Laurentia',
    prefix: null,
    mmsi: 538071251,
    imo: null,
    callSign: null,
    flag: 'Marshall Islands',
    flagCode: 'MH',
    loa: null, beam: null, grossTonnage: 740,
    builder: 'Heesen Yachts',
    yearBuilt: 2017, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'lazy-me-8000',
    name: 'Lazy Me',
    prefix: null,
    mmsi: 319508000,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 313,
    builder: 'Cantieri di Pisa',
    yearBuilt: 2008, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'lemon-tree-7100',
    name: 'Lemon Tree',
    prefix: null,
    mmsi: 319197100,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 1280,
    builder: 'Sanlorenzo',
    yearBuilt: 2021, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'life-saga-3300',
    name: 'Life Saga',
    prefix: null,
    mmsi: 319173300,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 1188,
    builder: 'Admiral (The Italian Sea Group)',
    yearBuilt: 2019, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    // Reflagged Cayman -> Marshall Islands. Found by the chase: a Limerence
    // was broadcasting on 538072789, one number below our own Nero at
    // 538072790, while this record still listened on her old Cayman number.
    // Confirmed against MarineTraffic before the change was made.
    id: 'limerence-2789',
    name: 'Limerence',
    prefix: null,
    mmsi: 538072789,
    imo: null,
    callSign: null,
    flag: 'Marshall Islands',
    flagCode: 'MH',
    loa: null, beam: null, grossTonnage: 499,
    builder: 'Alia Yachts',
    yearBuilt: 2025, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'lusine-2700',
    name: 'Lusine',
    prefix: null,
    mmsi: 319222700,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 1060,
    builder: 'Heesen Yachts',
    yearBuilt: 2022, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'mary-jean-ii-0247',
    name: 'Mary Jean II',
    prefix: null,
    mmsi: 235080247,
    imo: null,
    callSign: null,
    flag: 'United Kingdom',
    flagCode: 'GB',
    loa: null, beam: null, grossTonnage: 1238,
    builder: 'ISA Yachts',
    yearBuilt: 2010, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    // Adur
    id: 'milele-2700',
    name: 'Milele',
    prefix: null,
    mmsi: 319252700,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 499,
    builder: 'Royal Hakvoort Shipyard',
    yearBuilt: 2023, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'nero-2790',
    name: 'Nero',
    prefix: null,
    mmsi: 538072790,
    imo: null,
    callSign: null,
    flag: 'Marshall Islands',
    flagCode: 'MH',
    loa: null, beam: null, grossTonnage: 1413,
    builder: 'Corsair Yachts',
    yearBuilt: 2007, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    // ex New Secret
    id: 'new-dream-1225',
    name: 'New Dream',
    prefix: null,
    mmsi: 538071225,
    imo: null,
    callSign: null,
    flag: 'Marshall Islands',
    flagCode: 'MH',
    loa: null, beam: null, grossTonnage: 1790,
    builder: 'Amels',
    yearBuilt: 2019, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'no-rush-8397',
    name: 'No Rush',
    prefix: null,
    mmsi: 232058397,
    imo: null,
    callSign: null,
    flag: 'United Kingdom',
    flagCode: 'GB',
    loa: null, beam: null, grossTonnage: 100,
    builder: 'Southern Wind',
    yearBuilt: 2021, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'opus-4500',
    name: 'Opus',
    prefix: null,
    mmsi: 319284500,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 265,
    builder: 'Benetti',
    yearBuilt: 2023, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'pamela-v-0000',
    name: 'Pamela V',
    prefix: null,
    mmsi: 256090000,
    imo: null,
    callSign: null,
    flag: 'Malta',
    flagCode: 'MT',
    loa: null, beam: null, grossTonnage: 461,
    builder: 'Royal Hakvoort Shipyard',
    yearBuilt: 2011, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'parati-2817',
    name: 'Parati',
    prefix: null,
    mmsi: 538072817,
    imo: null,
    callSign: null,
    flag: 'Marshall Islands',
    flagCode: 'MH',
    loa: null, beam: null, grossTonnage: 499,
    builder: 'Cantiere delle Marche',
    yearBuilt: 2025, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    // ex My Sky
    id: 'pearl-1400',
    name: 'Pearl',
    prefix: null,
    mmsi: 319071400,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 648,
    builder: 'Heesen Yachts',
    yearBuilt: 2014, lastRefit: 2023,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    // Damen SX55/58
    id: 'pink-shadow-4800',
    name: 'Pink Shadow',
    prefix: null,
    mmsi: 319364800,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 1091,
    builder: 'Damen Yachting',
    yearBuilt: 2023, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'plus-ultra-1955',
    name: 'Plus Ultra',
    prefix: null,
    mmsi: 352001955,
    imo: null,
    callSign: null,
    flag: 'Panama',
    flagCode: 'PA',
    loa: null, beam: null, grossTonnage: 1787,
    builder: 'Amels',
    yearBuilt: 2016, lastRefit: 2023,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'promise-4900',
    name: 'Promise',
    prefix: null,
    mmsi: 319144900,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 902,
    builder: 'Feadship',
    yearBuilt: 2018, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'radiant-2900',
    name: 'Radiant',
    prefix: null,
    mmsi: 319012900,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 5027,
    builder: 'Lürssen',
    yearBuilt: 2010, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    // Damen YS5304
    id: 'rafter-2426',
    name: 'Rafter',
    prefix: null,
    mmsi: 538072426,
    imo: null,
    callSign: null,
    flag: 'Marshall Islands',
    flagCode: 'MH',
    loa: null, beam: null, grossTonnage: 499,
    builder: 'Damen Yachting',
    yearBuilt: 2026, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'samurai-9400',
    name: 'Samurai',
    prefix: null,
    mmsi: 319099400,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 1029,
    builder: 'Alia Yachts',
    yearBuilt: 2016, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'silver-angel-0865',
    name: 'Silver Angel',
    prefix: null,
    mmsi: 235070865,
    imo: null,
    callSign: null,
    flag: 'United Kingdom',
    flagCode: 'GB',
    loa: null, beam: null, grossTonnage: 1407,
    builder: 'Benetti',
    yearBuilt: 2009, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'siren-0000',
    name: 'Siren',
    prefix: null,
    mmsi: 319060000,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 1585,
    builder: 'Nobiskrug',
    yearBuilt: 2008, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'soprano-5800',
    name: 'Soprano',
    prefix: null,
    mmsi: 319115800,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 360,
    builder: 'Royal Hakvoort Shipyard',
    yearBuilt: 2017, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'sorrento-1354',
    name: 'Sorrento',
    prefix: null,
    mmsi: 538071354,
    imo: null,
    callSign: null,
    flag: 'Marshall Islands',
    flagCode: 'MH',
    loa: null, beam: null, grossTonnage: 1026,
    builder: 'Benetti',
    yearBuilt: 2010, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    // Project Sidney
    id: 'top-five-ii-2900',
    name: 'Top Five II',
    prefix: null,
    mmsi: 319212900,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 1291,
    builder: 'Royal Hakvoort Shipyard',
    yearBuilt: 2021, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'vanta-5400',
    name: 'Vanta',
    prefix: null,
    mmsi: 319295400,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 22,
    builder: 'Vandal Marine',
    yearBuilt: 2025, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  },
  {
    id: 'yalla-2000',
    name: 'Yalla',
    prefix: null,
    mmsi: 319002000,
    imo: null,
    callSign: null,
    flag: 'Cayman Islands',
    flagCode: 'KY',
    loa: null, beam: null, grossTonnage: 498,
    builder: 'Heesen Yachts',
    yearBuilt: 2004, lastRefit: null,
    classSociety: null,
    photo: null,
    discreet: false
  }
];
