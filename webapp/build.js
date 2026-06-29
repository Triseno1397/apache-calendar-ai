const fs = require('fs');
const path = require('path');

const SCRATCH = __dirname;
const SRC = 'C:/Users/trist/ARG Calender/src/Index.html';

const src = fs.readFileSync(SRC, 'utf8');
const shim = fs.readFileSync(path.join(SCRATCH, 'shim.js'), 'utf8');

const tag = '<script>';
const i = src.indexOf(tag);
if (i < 0) { console.error('ERROR: no <script> tag found'); process.exit(1); }

// Insert the shim right after the opening <script> so `google` is defined first.
const out = src.slice(0, i + tag.length) + '\n' + shim + src.slice(i + tag.length);

const outDir = path.join(SCRATCH, 'apache-web');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), out);

console.log('Built apache-web/index.html:', out.length, 'bytes');
console.log('Shim present:', out.includes('APPS_SCRIPT_API'));
console.log('google.script.run shim:', out.includes("Object.defineProperty(google.script,'run'"));
console.log('UI present (renderMonth):', out.includes('function renderMonth'));
console.log('Real google.script.run leftover calls:', (out.match(/google\.script\.run/g) || []).length);
