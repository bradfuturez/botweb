// Renders the PNG app icons from icon.svg (run once after changing the icon): node build-icons.mjs
let sharp; try { sharp = (await import('sharp')).default; } catch (_) { sharp = (await import('/tmp/pw/node_modules/sharp/lib/index.js')).default; }
import { readFileSync, mkdirSync } from 'fs';
const svg = readFileSync('icon.svg', 'utf8');
const scaled = s => svg.replace('<g id="art">', `<g id="art" transform="translate(256 256) scale(${s}) translate(-256 -256)">`);
mkdirSync('icons', { recursive: true });
for (const [name, size, s] of [['icon-512', 512, 1], ['icon-192', 192, 1], ['icon-maskable-512', 512, 0.74], ['apple-touch-icon', 180, 0.9]])
  await sharp(Buffer.from(scaled(s)), { density: 72 * size / 512 }).resize(size, size).png().toFile(`icons/${name}.png`);
console.log('icons done');
