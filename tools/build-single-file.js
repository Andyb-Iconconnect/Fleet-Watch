/* -----------------------------------------------------------------------------
 * Bundles the whole board into one self-contained .html file.
 *
 *   node tools/build-single-file.js [out.html] [--display] [--offline] [--fragment]
 *
 * Useful when the board has to travel: one file to email, drop on a USB stick,
 * or open straight off disk with no server at all.
 *
 *   --anonymous     no vessel names, builders, years, identifiers or
 *                   photographs — the fleet's shape without its client list.
 *                   For a screen visitors see, or for showing a prospect.
 *   --display       for a screen nobody is sitting at: the D key is locked
 *                   out, so it shows what this build decided and nobody
 *                   passing it can change that. Yachts marked `discreet` in fleet.js
 *                   are withheld regardless. Add --blur-all for a board where
 *                   every position is approximate.
 *   --offline       force demo mode and switch the weather lookup off, for
 *                   sandboxes that block outbound requests
 *   --fragment      emit body content only (no doctype/html/head/body), for
 *                   hosts that supply their own document shell
 *   --entry=FILE    which page to bundle (default index.html; console.html for
 *                   the desk tool)
 * -------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const outPath = args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'dist', 'fleet-watch.html');

// Which page to bundle. Both entry points share every script and stylesheet
// they need, so the same inliner serves them.
const entryFlag = args.find((a) => a.startsWith('--entry='));
const entry = entryFlag ? entryFlag.split('=')[1] : 'index.html';

const offline = flags.has('--offline');
const display = flags.has('--display');
const blurAll = flags.has('--blur-all');
const anonymous = flags.has('--anonymous');
const fragment = flags.has('--fragment');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Script order matters and is defined once, in index.html. Read it from there
// rather than keeping a second list in sync by hand.
const html = read(entry);
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
if (!scripts.length) throw new Error(`No <script src> tags found in ${entry}`);

const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);

// A closing script tag inside inlined JS would end the block early. None of our
// source contains one today; guard anyway so a future edit can't break the build.
const guard = (js) => js.replace(/<\/script/gi, '<\\/script');

let config = read('config.js');

/**
 * Stamp the build with its date and commit.
 *
 * Iterating over files somebody downloads means the question "which build is
 * that?" comes up constantly, and a diagnostic report pasted back is worthless
 * without the answer — a stale report reads exactly like a current one and
 * sends everybody after a cause that was fixed two commits ago.
 */
const stamp = (() => {
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  let commit = '';
  try {
    commit = require('child_process')
      .execSync('git -C ' + JSON.stringify(ROOT) + ' rev-parse --short HEAD',
                { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch (e) { /* built outside a checkout; the date alone still helps */ }
  return when + (commit ? ' · ' + commit : '');
})();
config = config.replace(/buildStamp: ''/, "buildStamp: '" + stamp + "'");

// The key never travels with the bundle, offline or not. A single file gets
// emailed, dropped on a USB stick and published as a page, and a credential
// baked into it goes wherever the file goes. The board asks for a key at the
// screen instead (js/settings.js) and keeps it in that browser's localStorage.
/**
 * A single file has no relay behind it.
 *
 * The board is normally served by the Web App that reads the feed, and asks it
 * for positions on the same origin — which is the whole reason there is no key
 * in a browser any more. A bundle is the opposite case: one file on a stick, a
 * machine with no server, nothing to ask. Left as 'relay' it would poll a path
 * that does not exist and show an empty sea for ever, which looks exactly like
 * a quiet Tuesday.
 *
 * So a bundle goes back to talking to the provider directly, with a key typed
 * at the screen.
 */
if (/provider: 'relay'/.test(config)) {
  config = config.replace(/provider: 'relay'/, "provider: 'aisstream'");
  console.warn('  ! this bundle has no relay behind it, so it talks to ' +
               'AISstream directly.\n' +
               '    Enter a key at the screen — click the status pill, or press K.');
}

const hadKey = /aisStreamApiKey: '.+'/.test(config);
config = config.replace(/aisStreamApiKey: '[^']*'/, "aisStreamApiKey: ''");
if (hadKey) {
  console.warn('  ! config.js has an AIS key; it has been left out of the bundle.\n' +
               '    Enter it at the screen instead — click the status pill, or press K.');
}

if (offline) {
  config = config.replace(/(weather: \{\s*\n\s*)enabled: true/, '$1enabled: false');
  if (!/enabled: false/.test(config)) throw new Error('--offline could not disable the weather block');
}

/**
 * The build for a screen nobody is sitting at — reception, an ops wall, a
 * boardroom, a stand at a show.
 *
 * The lock takes the D key away, so the screen shows what this build decided
 * and a visitor cannot change it in either direction. It does not itself
 * withhold anything: that is `discreet: true` on the yachts that need it, which
 * applies on every screen and does not depend on anyone remembering to press a
 * key when guests arrive.
 *
 * --blur-all is the heavier option, for a board where no position at all should
 * be legible: every yacht rounded to a region, permanently.
 *
 * Both are done here rather than by editing config.js, so that the desk
 * console, built from the same repository a minute earlier, keeps its toggle.
 */
if (display) {
  config = rewriteConfig(config, /discreetLocked: false/, 'discreetLocked: true',
                         '--display', 'discreetLocked');
}
if (blurAll) {
  config = rewriteConfig(config, /discreetMode: false/, 'discreetMode: true',
                         '--blur-all', 'discreetMode');
}

// The sales copy, and the one for a screen a visitor can read. Names off from
// start-up, and the A key locked so nobody turns them back on mid-conversation.
if (anonymous) {
  config = rewriteConfig(config, /anonymousMode: false/, 'anonymousMode: true',
                         '--anonymous', 'anonymousMode');
  config = rewriteConfig(config, /anonymousLocked: false/, 'anonymousLocked: true',
                         '--anonymous', 'anonymousLocked');
}

// A silent no-op here ships an unlocked board to a public screen, which is the
// one outcome worth crashing the build over.
function rewriteConfig(text, pattern, replacement, flag, setting) {
  const out = text.replace(pattern, replacement);
  if (out === text) {
    throw new Error(flag + ' could not find ' + setting + ' in config.js');
  }
  return out;
}

// Fonts are referenced from the stylesheet by relative path, which means
// nothing once the CSS is inlined into a file that may live anywhere. Embed
// them, so the bundle really is one self-contained file.
function inlineFonts(css, cssFile) {
  const cssDir = path.dirname(path.join(ROOT, cssFile));
  return css.replace(/url\(['"]?([^'")]+\.woff2?)['"]?\)/g, (whole, ref) => {
    const file = path.resolve(cssDir, ref);
    if (!fs.existsSync(file)) {
      console.warn(`  ! font not found, left as a URL: ${ref}`);
      return whole;
    }
    const mime = file.endsWith('.woff2') ? 'font/woff2' : 'font/woff';
    return `url(data:${mime};base64,${fs.readFileSync(file).toString('base64')})`;
  });
}

const inlinedStyles = styles
  .map((f) => `<style>\n${inlineFonts(read(f), f)}\n</style>`)
  .join('\n');

// Yacht photographs are referenced from fleet.js by relative path, which means
// nothing once the bundle is opened off a USB stick — and a published artifact
// blocks external images outright, so a remote URL will not render there at all.
// Embed the local files; leave remote URLs alone but say so.
let photoBytes = 0;
function inlinePhotos(js) {
  return js.replace(/photo:\s*'([^']+)'/g, (whole, ref) => {
    if (/^data:/.test(ref)) return whole;
    if (/^(https?:)?\/\//.test(ref)) {
      console.warn(`  ! photo left as a remote URL: ${ref}\n` +
                   '    A published artifact will not load it. ' +
                   'node tools/fetch-photos.js --from-fleet copies it down.');
      return whole;
    }
    const file = path.join(ROOT, ref);
    if (!fs.existsSync(file)) {
      console.warn(`  ! photo not found, left as a path: ${ref}`);
      return whole;
    }
    const mime = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.webp': 'image/webp', '.avif': 'image/avif'
    }[path.extname(file).toLowerCase()];
    if (!mime) {
      console.warn(`  ! photo is not an image type we embed, left as a path: ${ref}`);
      return whole;
    }
    const data = fs.readFileSync(file);
    photoBytes += data.length;
    return `photo: 'data:${mime};base64,${data.toString('base64')}'`;
  });
}

const inlinedScripts = scripts.map((f) => {
  const source = f === 'config.js' ? config : read(f);
  // Only the data file. Applied to every script it rewrites any `photo: '...'`
  // it finds in ordinary code — a field label, a comment, a form key — which at
  // best warns about a file that was never meant to exist and at worst corrupts
  // the source.
  return `<script>\n${guard(f === 'fleet.js' ? inlinePhotos(source) : source)}\n</script>`;
}).join('\n');

// Take the markup between <body> and </body>, minus the script tags we've just
// inlined and the stylesheet link.
let body = html
  .replace(/^[\s\S]*?<body>/, '')
  .replace(/<\/body>[\s\S]*$/, '')
  .replace(/<script src="[^"]+"><\/script>\n?/g, '')
  .trim();

const title = (html.match(/<title>([^<]*)<\/title>/) || [, 'Fleet Watch'])[1];
const note = offline
  ? '<!-- Built with --offline: demo data, no outbound requests. -->\n'
  : '';

let out;
if (fragment) {
  out = `${note}<title>${title}</title>\n${inlinedStyles}\n\n${body}\n\n${inlinedScripts}\n`;
} else {
  const head = html
    .match(/<head>([\s\S]*?)<\/head>/)[1]
    .replace(/<link rel="stylesheet"[^>]*>\n?/g, '')
    .trim();
  out = `<!doctype html>\n<html lang="en">\n<head>\n${note}${head}\n${inlinedStyles}\n</head>\n<body>\n\n${body}\n\n${inlinedScripts}\n\n</body>\n</html>\n`;
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out);
console.log(`${entry}: ${scripts.length} scripts + ${styles.length} stylesheets inlined -> ` +
            `${path.relative(process.cwd(), outPath)} (${Math.round(out.length / 1024)} KB)` +
            (photoBytes ? ` [${Math.round(photoBytes / 1024)} KB of photos]` : '') +
            (display ? ' [display: D key locked]' : '') +
            (blurAll ? ' [every position approximate]' : '') +
            (anonymous ? ' [names withheld]' : '') +
            (offline ? ' [offline]' : '') + (fragment ? ' [fragment]' : ''));

// The artifact host refuses anything over 16 MB, and photographs are the only
// thing here big enough to get near it.
if (out.length > 15 * 1024 * 1024) {
  console.warn(`  ! ${Math.round(out.length / (1024 * 1024))} MB is close to the 16 MB artifact ` +
               'limit. Resize the photographs to about 1600 px on the long edge.');
}
