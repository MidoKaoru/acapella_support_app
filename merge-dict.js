'use strict';

const fs = require('fs');
const path = require('path');

const DICT_PATH = path.join(__dirname, 'js', 'dict.js');
const EXPORT_PATH = path.join(__dirname, 'gas-export.json');

const exportRaw = fs.readFileSync(EXPORT_PATH, 'utf8').trim();
const incoming = JSON.parse(exportRaw || '{}');

if (Object.keys(incoming).length === 0) {
  console.log('gas-export.json is empty — nothing to merge.');
  process.exit(0);
}

const dictSrc = fs.readFileSync(DICT_PATH, 'utf8');

const match = dictSrc.match(/const _DEFAULT_DICT\s*=\s*(\{[\s\S]*?\});/);
if (!match) {
  console.error('_DEFAULT_DICT not found in js/dict.js');
  process.exit(1);
}

// eslint-disable-next-line no-new-func
const existing = new Function('return ' + match[1])();

const merged = { ...incoming, ...existing };

const jsonStr = JSON.stringify(merged, null, 2)
  .replace(/"/g, "'");

const newDictBlock = `const _DEFAULT_DICT = ${jsonStr};`;

const newSrc = dictSrc.replace(
  /const _DEFAULT_DICT\s*=\s*\{[\s\S]*?\};/,
  newDictBlock
);

fs.writeFileSync(DICT_PATH, newSrc, 'utf8');
console.log(`Merged ${Object.keys(incoming).length} new entries → js/dict.js`);

fs.writeFileSync(EXPORT_PATH, '{}', 'utf8');
console.log('gas-export.json reset to {}');
