/**
 * dual-settings: one settings store for a DSH host plugin that must run on
 * both DSH 0.1.5 (registrable namespaces, `ctx.settings.register`) and
 * DSH 0.2.x (forms over the plugin's exported `Config`, values stored in the
 * profile's cordis.patch.yml row, `ctx.settings.update(entryId, patch)`).
 *
 * Vendored verbatim into every plugin that uses it (single source:
 * dsh-migrate-0.2/shared/dual-settings.js, synced by bin/sync-shared). Only node
 * builtins are imported statically; schemastery and yaml are resolved from the
 * RUNNING harness at call time, so a plugin never pins its own copy (a private
 * schemastery copy would not wrap volatile fields the way the host Loader
 * expects, and the plugin would silently keep stale values).
 *
 *   const z = loadHostSchemastery(import.meta.url)
 *   export const Config = z ? liveObject(z, { enabled: z.boolean().default(true) }) : undefined
 *   export const inject = ['settings', ...]
 *   export function apply(ctx, config) {
 *     const store = createDualSettings(ctx, config, { ns: 'my-plugin', packageName: 'my-plugin', schema: Config, base: DEFAULTS })
 *     store.get()            // current resolved value, read at the moment of use
 *     await store.update(p)  // merge a patch (0.1.5: settings.yaml section; 0.2: profile row)
 *   }
 *
 * Mode detection is by capability, never by version string:
 *   'register'  ctx.settings.register exists (0.1.5 line)
 *   'forms'     ctx.settings.update + describe exist (0.1.7 and later, incl. 0.2.1)
 *   'config'    neither (headless or tests): read-only over the apply() config
 */

import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const DUAL_SETTINGS_VERSION = '1.0.0'

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Whether a value is a cosmokit volatile reference (works across module copies). */
export function isRef(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/** Deep copy with every volatile reference replaced by its current value. */
export function plain(value) {
  if (isRef(value)) return plain(value.get())
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = plain(v)
    return out
  }
  return value
}

/** Candidate require bases for the running harness, most specific first. */
function harnessBases(metaUrl) {
  const bases = []
  const prefixBase = (prefix) => join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  // An explicit prefix wins (tests, exotic installs), then the running entry
  // script (the dsh binary in production), then the usual global prefixes.
  if (process.env.DSH_GLOBAL_PREFIX) bases.push(prefixBase(process.env.DSH_GLOBAL_PREFIX))
  if (process.argv && process.argv[1]) {
    try { bases.push(realpathSync(process.argv[1])) } catch { bases.push(process.argv[1]) }
  }
  for (const prefix of [dirname(dirname(process.execPath)), join(homedir(), '.local')]) bases.push(prefixBase(prefix))
  if (metaUrl) bases.push(metaUrl)
  return bases
}

/** Resolve a module the way the running harness sees it; null when absent. */
export function requireFromHarness(id, metaUrl, envOverride) {
  if (envOverride && process.env[envOverride]) {
    try { const p = process.env[envOverride]; return createRequire(p)(p) } catch {}
  }
  for (const base of harnessBases(metaUrl)) {
    try {
      if (!base.startsWith('file:') && !existsSync(base)) continue
      return createRequire(base)(id)
    } catch {}
  }
  return null
}

/** The harness's schemastery (default export unwrapped), or null. */
export function loadHostSchemastery(metaUrl) {
  const mod = requireFromHarness('@deepseek-ai/schemastery', metaUrl, 'DSH_SCHEMASTERY_ENTRY')
  return mod ? (mod.default || mod) : null
}

/** Mark a schema live where the host supports it (schemastery >= 3.18.5). */
export function live(schema) {
  return schema && typeof schema.volatile === 'function' ? schema.volatile() : schema
}

/**
 * z.object over `dict` with every listed top-level field live. Fields named in
 * `fixed` stay ordinary config (a change remounts the plugin and is editable
 * only in the YAML), which is also how a field is kept out of form writes and
 * out of the core's one-time settings.yaml import.
 */
export function liveObject(z, dict, { fixed = [] } = {}) {
  const out = {}
  for (const [key, field] of Object.entries(dict)) out[key] = fixed.includes(key) ? field : live(field)
  return z.object(out)
}

/** This plugin row's Loader entry id (fiber identity first, then package name). */
export function ownEntryId(ctx, packageName) {
  let fallback
  try {
    for (const entry of ctx.loader.entries()) {
      const id = entry.options && entry.options.id
      if (typeof id !== 'string' || id === '') continue
      if (entry.fiber === ctx.fiber) return id
      if (packageName && entry.options.name === packageName && entry.disabled !== true && fallback === undefined) fallback = id
    }
  } catch {}
  return fallback
}

/** Harness home holding the retired settings.yaml. */
function harnessHome(ctx) {
  try { if (ctx.profileContext && typeof ctx.profileContext.home === 'string') return ctx.profileContext.home } catch {}
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * Read the first usable legacy section out of settings.yaml.imported or
 * settings.yaml. `names` are tried in order inside each document.
 * @returns {Promise<{section: object, file: string, name: string} | undefined>}
 */
export async function readLegacySection(home, names, metaUrl) {
  const yaml = requireFromHarness('yaml', metaUrl)
  if (!yaml || typeof yaml.parse !== 'function') return undefined
  for (const file of ['settings.yaml.imported', 'settings.yaml']) {
    let text
    try { text = await readFile(join(home, file), 'utf8') } catch { continue }
    let doc
    try { doc = yaml.parse(text) } catch { continue }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue
    for (const name of names) {
      const section = doc[name]
      if (section && typeof section === 'object' && !Array.isArray(section)) return { section, file, name }
    }
  }
  return undefined
}

/** Keep only the top-level keys a schema declares (a form write rejects unknown keys). */
export function filterDeclared(schema, section) {
  const declared = new Set(Object.keys((schema && schema.dict) || {}))
  const out = {}
  for (const [k, v] of Object.entries(section || {})) if (declared.has(k)) out[k] = v
  return out
}

/** Keep only top-level keys that are live in `schema` (form writes accept nothing else). */
export function filterLive(schema, section) {
  const dict = (schema && schema.dict) || {}
  const out = {}
  for (const [k, v] of Object.entries(section || {})) if (dict[k] && dict[k].meta && dict[k].meta.volatile) out[k] = v
  return out
}

/**
 * Create the store.
 * @param ctx plugin context (must `inject` 'settings' to use either service)
 * @param config the apply() config (0.2: carries volatile references)
 * @param opts.ns          legacy settings.yaml section name (0.1.5 namespace)
 * @param opts.packageName package name, for the entry id fallback
 * @param opts.schema      the exported Config schema (null = config mode only)
 * @param opts.base        composition defaults for the 0.1.5 register call
 * @param opts.legacy      { sections?: string[], transform?: (section, info) => patch|Promise<patch> }
 *                         sections default to [ns]; transform runs before the
 *                         0.2 import write and may drop or relocate fields
 *                         (e.g. move a secret into a 0600 file); return {} to skip
 * @param opts.log / opts.warn  loggers
 * @param opts.metaUrl     import.meta.url of the plugin (resolution fallback)
 */
export function createDualSettings(ctx, config = {}, opts = {}) {
  const ns = opts.ns
  const schema = opts.schema || null
  const log = opts.log || ((m) => console.log(`${ns}: ${m}`))
  const warn = opts.warn || ((m) => console.error(`${ns}: ${m}`))
  const legacy = opts.legacy || {}
  let settings = null
  try { settings = ctx.settings } catch { settings = null }

  const state = { mode: 'config', entryId: undefined, importOutcome: 'not-run', scope: null, forms: null }
  let resolveReady
  const ready = new Promise((r) => { resolveReady = r })

  if (settings && typeof settings.register === 'function' && schema) {
    try {
      state.scope = settings.register(ns, schema, { base: opts.base ? JSON.parse(JSON.stringify(opts.base)) : undefined, applies: 'live' })
      state.mode = 'register'
    } catch (e) {
      warn(`settings register failed: ${e && e.message}`)
    }
    state.importOutcome = 'not-needed'
    resolveReady()
  } else if (settings && typeof settings.register !== 'function' && typeof settings.update === 'function' && typeof settings.describe === 'function') {
    state.mode = 'forms'
    state.forms = settings
    state.entryId = ownEntryId(ctx, opts.packageName)
    if (state.entryId === undefined) warn('no loader row found for this plugin; settings stay read-only')
    if (schema && typeof settings.configure === 'function' && opts.autoForm === false) {
      try { ctx.effect(() => settings.configure({ auto: false }, ctx.fiber), `${ns}: settings page policy`) } catch (e) { warn(`settings page policy: ${e && e.message}`) }
    }
    // The loader must settle first: describe() lists only ACTIVE rows, and
    // this runs while the loader is still mounting (same wait as the core's
    // own settings.yaml import).
    let settled
    try { settled = ctx.loader && typeof ctx.loader.await === 'function' ? ctx.loader.await() : undefined } catch { settled = undefined }
    Promise.resolve(settled)
      .then(() => importLegacy())
      .then((outcome) => {
        state.importOutcome = outcome
        if (outcome === 'imported' || outcome === 'already-configured' || outcome === 'no-legacy-section') log(`legacy settings import: ${outcome}`)
        else warn(`legacy settings import could not run (${outcome})`)
      })
      .catch((e) => { state.importOutcome = 'rejected'; warn(`legacy settings import was rejected: ${e && e.message}`) })
      .finally(() => resolveReady())
  } else {
    state.importOutcome = 'not-needed'
    resolveReady()
  }

  async function importLegacy() {
    if (!state.entryId) return 'no-entry'
    if (!schema) return 'no-schema'
    const row = state.forms.describe().find((d) => d.ns === state.entryId)
    if (!row) {
      // The Loader reads `Config` from the plugin runtime, which is the DEFAULT
      // export when a module has one: a Config only on the named export is
      // invisible to it (no form, no live fields).
      let runtimeConfig
      try { runtimeConfig = ctx.fiber && ctx.fiber.runtime && ctx.fiber.runtime.Config } catch {}
      return runtimeConfig ? 'no-form' : 'config-not-visible-to-loader (export Config on the default export too)'
    }
    if (row.user && typeof row.user === 'object' && Object.keys(row.user).length > 0) return 'already-configured'
    const found = await readLegacySection(harnessHome(ctx), legacy.sections || [ns], opts.metaUrl)
    if (!found) return 'no-legacy-section'
    let patch = filterDeclared(schema, found.section)
    if (typeof legacy.transform === 'function') patch = await legacy.transform(patch, found)
    patch = filterLive(schema, patch || {})
    if (Object.keys(patch).length === 0) return 'no-legacy-section'
    await state.forms.update(state.entryId, patch)
    return 'imported'
  }

  return {
    /** 'register' | 'forms' | 'config' */
    get mode() { return state.mode },
    get entryId() { return state.entryId },
    get importOutcome() { return state.importOutcome },
    /** Resolves once the 0.2 legacy import settled (immediately otherwise). */
    ready,
    /** Current resolved value. Call at the moment of use; never cache. */
    get() {
      if (state.mode === 'register') {
        try { return state.scope.get() } catch { return plain(config) }
      }
      return plain(config)
    },
    /** Whether update() can persist. */
    writable() {
      if (state.mode === 'register') return Boolean(state.scope && typeof state.scope.update === 'function')
      if (state.mode === 'forms') return Boolean(state.entryId)
      return false
    },
    /** Merge a JSON patch into the stored user layer. */
    async update(patch, expectedRevision) {
      if (state.mode === 'register') return state.scope.update(patch)
      if (state.mode === 'forms') {
        if (!state.entryId) throw new Error('settings not writable: no loader row for this plugin')
        return state.forms.update(state.entryId, patch, expectedRevision)
      }
      throw new Error('settings not writable: no settings service')
    },
    /**
     * Observe changes of the resolved value. 0.1.5: the scope's own watch.
     * 0.2.x: live fields change in place without any event a plugin can
     * observe, so the value is compared every `intervalMs` (default 2000).
     * Returns a disposer; pass it to ctx.effect.
     */
    watch(callback, { intervalMs = 2000 } = {}) {
      if (state.mode === 'register' && state.scope && typeof state.scope.watch === 'function') {
        return state.scope.watch((next, prev) => callback(next, prev))
      }
      let last = JSON.stringify(this.get())
      let prevValue = JSON.parse(last)
      const timer = setInterval(() => {
        let now
        try { now = JSON.stringify(this.get()) } catch { return }
        if (now === last) return
        const next = JSON.parse(now)
        const prev = prevValue
        last = now; prevValue = next
        try { Promise.resolve(callback(next, prev)).catch((e) => warn(`settings watcher: ${e && e.message}`)) } catch (e) { warn(`settings watcher: ${e && e.message}`) }
      }, intervalMs)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    },
    /** Short description for status routes and logs (no values). */
    describeStore() {
      return { mode: state.mode, entryId: state.entryId || null, legacyImport: state.importOutcome, helper: DUAL_SETTINGS_VERSION }
    },
  }
}
