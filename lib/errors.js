/**
 * dsh-phone host half: the error catalog bound to the vendored plugin-errors.
 * The catalog data lives in daemon/catalog.mjs (shared with the daemon).
 */
import { defineErrors } from './plugin-errors.js'
import { PREFIX, CATALOG, scrub, errorBody } from '../daemon/catalog.mjs'

export const E = defineErrors(PREFIX, CATALOG, { scrub })
export { errorBody }
