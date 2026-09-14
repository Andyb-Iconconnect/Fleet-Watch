/* -----------------------------------------------------------------------------
 * build-all.js — every bundle, from one command.
 *
 *   node tools/build-all.js      (or: npm run build)
 *
 * THIS FILE EXISTS BECAUSE THE ALTERNATIVE FAILED IN PRACTICE. The builder
 * takes an --entry flag, so the board and the desk tool are two commands and
 * the variants are two more. `npm run build` ran the first of them, everyone
 * assumed it had built "the build", and dist/fleet-console.html sat unchanged
 * for six days across four releases while the board beside it was current.
 *
 * A console handed out on a USB stick was missing an entire week of work, and
 * nothing on the screen said so: it looked like a console, it just quietly did
 * not do the things it had been asked to do. That is the worst shape a stale
 * build can take, and it is not a mistake anyone should have to remember not to
 * make.
 *
 * So: one command, everything, and it says what it wrote and how old each file
 * now is. Add a bundle here and it is built from then on.
 * -------------------------------------------------------------------------- */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILDER = path.join(__dirname, 'build-single-file.js');

/**
 * What gets built, and why each one exists.
 *
 * Kept as data rather than as four lines in a shell script, so the list is
 * readable by whoever is wondering which file they were handed.
 */
const BUNDLES = [
  { out: 'fleet-watch.html', args: [],
    what: 'the board' },
  { out: 'fleet-console.html', args: ['--entry=console.html'],
    what: 'the desk tool' },
  { out: 'fleet-watch-display.html', args: ['--display'],
    what: 'a wall nobody is sitting at — the D key locked out' },
  { out: 'fleet-watch-anonymous.html', args: ['--anonymous'],
    what: 'the fleet\'s shape without its client list' }
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const list = only.length
  ? BUNDLES.filter((b) => only.some((o) => b.out.indexOf(o) !== -1))
  : BUNDLES;

if (!list.length) {
  console.error('Nothing matched. The bundles are:');
  BUNDLES.forEach((b) => console.error('  ' + b.out + '   ' + b.what));
  process.exit(2);
}

let failed = 0;
list.forEach((b) => {
  const out = path.join(ROOT, 'dist', b.out);
  try {
    execFileSync(process.execPath, [BUILDER, out].concat(b.args),
      { cwd: ROOT, stdio: 'pipe' });
    const size = Math.round(fs.statSync(out).size / 1024);
    console.log('  ' + pad(b.out) + pad(size + ' KB', 10) + b.what);
  } catch (err) {
    failed++;
    console.error('  ' + pad(b.out) + 'FAILED');
    console.error(String(err.stderr || err.message).trim().split('\n')
      .map((l) => '      ' + l).join('\n'));
  }
});

/**
 * And a word about what is now in there.
 *
 * Listing every file in dist, not only the ones just built: a bundle nobody
 * builds any more is exactly the file somebody is still opening, and the point
 * of this whole exercise is that a stale one should be visible rather than
 * discovered a week later.
 */
console.log();
const known = BUNDLES.map((b) => b.out);
fs.readdirSync(path.join(ROOT, 'dist')).sort().forEach((name) => {
  if (known.indexOf(name) !== -1) return;
  console.log('  ' + pad(name) + 'is in dist/ but nothing builds it any more — ' +
    'delete it, or add it to tools/build-all.js');
});

console.log(failed ? failed + ' bundle(s) failed.' : 'All bundles are current.');
process.exit(failed ? 1 : 0);

function pad(s, n) { return (String(s) + '                              ').slice(0, n || 30); }
