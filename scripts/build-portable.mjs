/* Dependency-free fallback: serve dist/ on localhost without Vite.
 * With Vite installed, the standard `npm run build` remains preferred.
 */
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
await mkdir(dist, { recursive: true });
await copyFile(path.join(root, 'src/styles.css'), path.join(dist, 'styles.css'));
const html = (await readFile(path.join(root, 'index.html'), 'utf8'))
  .replace('/src/styles.css', './styles.css')
  .replace('/src/main.ts', './main.js');
await writeFile(path.join(dist, 'index.html'), html);
const main = (await readFile(path.join(dist, 'main.js'), 'utf8'))
  .replace(/import workletUrl from ['"]\.\/audio\/pedal-worklet\.ts\?worker&url['"];?/, "const workletUrl = new URL('./audio/pedal-worklet.js', import.meta.url).href;")
  .replace(/import matchWorkerUrl from ['"]\.\/audio\/match-worker\.ts\?worker&url['"];?/, "const matchWorkerUrl = new URL('./audio/match-worker.js', import.meta.url).href;");
if (main.includes('?worker&url')) throw new Error('Could not resolve worker URL in portable build');
await writeFile(path.join(dist, 'main.js'), main);
console.log('Portable static build ready in dist/. Serve with: python3 -m http.server 5173 -d dist');
