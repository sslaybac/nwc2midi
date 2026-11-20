import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, relative } from 'path';
import { convertNWCToMusicXML } from '../vendor/nwc2xml/index.js';
const [root, out, ...files] = process.argv.slice(2);
for (const f of files) { const o = join(out, relative(root, f).replace(/\.(nwc|BAK)$/, m => m === '.BAK' ? ' (backup).xml' : '.xml')); mkdirSync(dirname(o), {recursive:true}); writeFileSync(o, convertNWCToMusicXML(readFileSync(f))); }
