import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default: repo `public/maps` (two levels up from adapter/). */
export function resolveMapsDir() {
  const env = process.env.MAPS_DIR;
  if (env) return path.resolve(env);
  return path.resolve(__dirname, '../../../public/maps');
}

/**
 * Sorted basenames of `*.json` map files (e.g. E1M1.json).
 * @returns {Promise<string[]>}
 */
export async function listMapJsonFiles(mapsDir) {
  const entries = await fs.readdir(mapsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort();
}

/**
 * @param {string} mapsDir
 * @param {string} basename e.g. E1M1.json
 * @returns {Promise<object>}
 */
export async function loadMapJson(mapsDir, basename) {
  const full = path.join(mapsDir, basename);
  const raw = await fs.readFile(full, 'utf8');
  return JSON.parse(raw);
}
