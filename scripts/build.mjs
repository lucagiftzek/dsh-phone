#!/usr/bin/env node
/**
 * dsh-phone: browser-half build (same shape as dsh-mail / dsh-hpc).
 *
 * Bundles src/client.jsx → lib/client.js wrapped in a ModuleLoader factory,
 * exactly like dsh-hpc does. The wrapper is what lets the harness inject
 * react/react-jsx-runtime without the plugin shipping them.
 *
 * format MUST be 'cjs': the factory returns module.exports. 'iife' wraps the
 * module in (()=>{...})(), module.exports stays {} and the WHOLE web UI fails
 * to boot ("invalid plugin, expect function or object with an apply method,
 * received object") : that shipped once, 2026-09-19.
 *
 * lib/client.js is live: dsh's HMR watcher re-hashes it on every write and
 * serves it to the next page load. So the bundle is built in memory, loaded
 * through a stub __ModuleLoader__ and checked for { apply, inject } first, and
 * only then written to a temp file and renamed over lib/client.js : a failed
 * or half-written build never reaches the UI.
 *
 * Run: node scripts/build.mjs        (or: pnpm run build)
 */
import { build } from 'esbuild'
import { writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const outfile = join(root, 'lib', 'client.js')
const ID = 'dsh-phone'

mkdirSync(join(root, 'lib'), { recursive: true })

const banner = [
  "window.__ModuleLoader__.load({",
  "  id: 'dsh-phone',",
  "  factory: function (require) {",
  "    var module = { exports: {} };",
  "    var exports = module.exports;",
].join('\n')

const footer = [
  "    return module.exports;",
  "  }",
  "});",
].join('\n')

/** Load the bundle the way the web shell does and return what the factory exported. */
export function loadClientBundle(source) {
  let loaded
  const window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }
  runInNewContext(source, { window, console })
  if (!loaded || typeof loaded.factory !== 'function') throw new Error('bundle never called window.__ModuleLoader__.load({ id, factory })')
  const stubs = { react: { useState() {}, useEffect() {}, useRef() {} }, 'react/jsx-runtime': { jsx() {}, jsxs() {}, Fragment: 'Fragment' }, 'react-dom/client': { createRoot() {} } }
  const exported = loaded.factory((name) => {
    if (!(name in stubs)) throw new Error('bundle requires ' + JSON.stringify(name) + ', which the shell does not provide')
    return stubs[name]
  })
  return { id: loaded.id, exported }
}

export function verifyClientBundle(source) {
  if (source.includes('@deepseek-ai/')) throw new Error('client bundle purity: @deepseek-ai value imports must not reach the client bundle')
  const { id, exported } = loadClientBundle(source)
  if (id !== ID) throw new Error('bundle registers id ' + JSON.stringify(id) + ', expected ' + JSON.stringify(ID))
  if (!exported || typeof exported.apply !== 'function') {
    throw new Error('factory exports ' + JSON.stringify(Object.keys(exported || {})) + ' with no apply() : the loader would reject it and the web UI would not boot')
  }
  if (JSON.stringify(exported.inject) !== '["betterSidebar","slots"]') throw new Error('inject is ' + JSON.stringify(exported.inject) + ', expected ["betterSidebar","slots"]')
}

async function main() {
  const result = await build({
    entryPoints: [join(root, 'src', 'client.jsx')],
    bundle: true,
    outfile,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: ['chrome110', 'firefox110', 'safari16'],
    jsx: 'automatic',
    banner: { js: banner },
    footer: { js: footer },
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
  })
  const source = result.outputFiles.find((f) => f.path === outfile)?.text
  if (!source) throw new Error('esbuild produced no ' + outfile)

  verifyClientBundle(source)

  const tmp = outfile + '.tmp-' + process.pid
  writeFileSync(tmp, source)
  renameSync(tmp, outfile)
  console.log('dsh-phone: bundle verified ({ apply, inject }) and written to lib/client.js')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('dsh-phone build failed, lib/client.js left untouched:', err.message || err)
    process.exit(1)
  })
}
