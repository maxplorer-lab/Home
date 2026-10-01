/**
 * Node runs TypeScript directly (type stripping), but it resolves import
 * specifiers literally: the Worker's source uses the bundler convention
 *
 *   import { Geofence } from './geofence'   // Wrangler resolves this
 *
 * and Node would look for a file named exactly `geofence`, so importing
 * `src/way/lib/state-machine.ts` straight from a test fails with
 * ERR_MODULE_NOT_FOUND. This preload (see the `test` script in package.json)
 * adds the one rule Wrangler has and Node does not: a relative specifier with
 * no extension resolves to the `.ts` file beside it.
 *
 * Test-only, and inert for Home's other test files (they import with explicit
 * extensions). The Worker never loads this file -- Wrangler bundles src/ itself.
 *
 * Mirror of `../W.A.Y/tests/ts-hooks.mjs`; keep the two in step.
 */
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HAS_EXTENSION = /\.(ts|mts|cts|js|mjs|cjs|json)$/i

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !HAS_EXTENSION.test(specifier)
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  },
})
