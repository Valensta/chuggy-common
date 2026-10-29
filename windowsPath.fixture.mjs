/**
 * Windows' path rules on any machine. Loaded with `--import`, this module
 * answers for `node:path` wherever a module imports it, so a suite can see
 * what a module derives on a Windows runner.
 */
import { registerHooks } from "node:module";
import { win32 } from "node:path";

export default win32;
export const {
  basename,
  delimiter,
  dirname,
  extname,
  format,
  isAbsolute,
  join,
  normalize,
  parse,
  posix,
  relative,
  resolve,
  sep,
  toNamespacedPath,
} = win32;

registerHooks({
  resolve(specifier, context, nextResolve) {
    return (specifier === "node:path" || specifier === "path") &&
      context.parentURL !== import.meta.url
      ? { url: import.meta.url, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
