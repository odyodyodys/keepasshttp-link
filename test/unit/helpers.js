// Loads extension background files into a sandbox (no browser needed).
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SRC = path.resolve(here, '..', '..', 'src');

/**
 * @param {string[]} files paths relative to src/
 * @param {object} extra globals to add to the sandbox
 * @param {string[]} expose global names (declared with var/const) to return
 */
export function loadBackground(files, extra = {}, expose = []) {
  const ctx = { console, crypto: webcrypto, Uint8Array, Array, Number, Error, Math, TextEncoder, TextDecoder, ...extra };
  vm.createContext(ctx);
  for (const f of files) {
    vm.runInContext(readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  }
  const out = {};
  for (const name of expose) out[name] = vm.runInContext(name, ctx);
  return { ctx, ...out };
}
