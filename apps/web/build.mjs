import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'dist');
await mkdir(join(output, 'public'), { recursive: true });
await Promise.all([
  copyFile(join(root, 'server.mjs'), join(output, 'server.mjs')),
  copyFile(join(root, 'public', 'index.html'), join(output, 'public', 'index.html')),
  copyFile(join(root, 'public', 'app.js'), join(output, 'public', 'app.js')),
  copyFile(join(root, 'public', 'styles.css'), join(output, 'public', 'styles.css')),
]);
console.log('RetailOS local app built to apps/web/dist');
