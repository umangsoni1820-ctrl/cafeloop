import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const build = path.join(root, '..', 'dist');
const output = path.join(root, '..', 'public');

if (!fs.existsSync(path.join(build, 'index.html'))) {
  throw new Error('Vite output is missing. Run the Vite build before copying static files.');
}

fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(build, output, { recursive: true });
