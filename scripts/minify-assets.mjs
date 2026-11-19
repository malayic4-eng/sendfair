// Minifies the browser scripts shipped in dist/assets/ (app.js, rank.js, build-cost.js, quote-check*.js).
// Used by scripts/build.mjs, which hashes the minified text for the ?v= cache-busting versions, so a page
// always names the exact bytes it gets.
//
// The sources are plain ES5 scripts (an IIFE each, no modules), and the output stays ES5 (target es5) so
// nothing newer than the source is introduced. Without a "format", esbuild keeps top-level names, so
// globals such as window.SF / window.SFRank and rank.js's `module.exports` branch for Node work as before.
// Licence comments (/*! ... */) are kept.
//
// esbuild is a devDependency. If it is not installed (a workflow that runs the build without
// `npm ci`), the scripts ship unminified with a warning instead of failing the build; the ?v= hashes
// still match because build.mjs hashes whatever text is shipped.
let transformSync = null;
try { ({ transformSync } = await import("esbuild")); }
catch { console.warn("minify: esbuild is not installed (run npm ci); browser scripts are shipped unminified."); }

export const MINIFIED_JS = new Set(["app.js", "rank.js", "build-cost.js", "quote-check.js", "quote-check-report.js"]);

export function minifyJs(code, name = "script.js") {
  if (!transformSync) return code;
  const out = transformSync(code, {
    loader: "js",
    minify: true,
    target: "es5",
    charset: "utf8",
    legalComments: "inline",
    sourcefile: name
  });
  for (const w of out.warnings) console.warn(`minify ${name}: ${w.text}`);
  return out.code;
}
