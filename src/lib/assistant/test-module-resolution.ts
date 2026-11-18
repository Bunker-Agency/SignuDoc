import { registerHooks } from "node:module";

// For DB tests that load the app's own auth server, routes and pages under
// plain Node: they import with the app's "@/" paths, and next/* without a
// file name, both of which Next.js resolves at build time.

const SRC = new URL("../../", import.meta.url);

let registered = false;

/**
 * Teaches Node the app's "@/" paths and next/* imports. Call it at the top
 * of a test file, before anything imports the auth server or a route.
 */
export function registerAppModuleResolution(): void {
  if (registered) {
    return;
  }

  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (/^next\/[a-z-]+$/.test(specifier)) {
        return nextResolve(`${specifier}.js`, context);
      }

      if (specifier.startsWith("@/")) {
        const path = specifier.slice(2);

        return nextResolve(
          new URL(/\.[a-z]+$/.test(path) ? path : `${path}.ts`, SRC).href,
          context,
        );
      }

      return nextResolve(specifier, context);
    },
  });
}
