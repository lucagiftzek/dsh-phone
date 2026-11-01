/**
 * dsh-phone daemon: the error catalog bound to its own copy of plugin-errors
 * (daemon/ never imports from ../lib, so it can be deployed on its own).
 */
import { defineErrors } from './plugin-errors.mjs'
import { PREFIX, CATALOG, scrub, errorBody } from './catalog.mjs'

export const E = defineErrors(PREFIX, CATALOG, { scrub })
export { errorBody, scrub }
