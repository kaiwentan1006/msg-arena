#!/usr/bin/env node
'use strict';

// Rewrite every static-asset cache-bust query (?v=…) to the current
// package.json version, across the files that carry them by hand.
//
// Why this exists: the client has no bundler. Each ES-module import specifier
// in public/js/app.js and each <script>/<link> tag in the HTML carries its own
// ?v= string, edited by hand. They had drifted wildly (3.16.12 … 3.51.5 while
// the app was 4.2.0), and — crucially — EACH import specifier is its own cache
// key, so editing a module without bumping its ?v= ships a stale copy to
// returning browsers. Run this after touching any client asset:
//     npm run bump   (or: node scripts/bump-assets.js)
// It sets them all to the package version, so a normal version bump busts every
// cache in one place.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;

const targets = [
  'public/js/app.js',
  'public/app.html',
  'public/index.html',
];

const re = /\?v=[0-9][0-9A-Za-z.\-]*/g;
let totalFiles = 0, totalReplacements = 0;

for (const rel of targets) {
  const file = path.join(root, rel);
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
  let count = 0;
  const out = src.replace(re, () => { count++; return `?v=${version}`; });
  if (count && out !== src) {
    fs.writeFileSync(file, out);
    totalFiles++;
    totalReplacements += count;
    console.log(`  ${rel}: ${count} cache-bust marker(s) → ?v=${version}`);
  } else {
    console.log(`  ${rel}: no change`);
  }
}

console.log(`Done: ${totalReplacements} marker(s) across ${totalFiles} file(s) set to v${version}.`);
