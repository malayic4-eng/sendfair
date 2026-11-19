// Minifies the browser scripts shipped in dist/assets/ (app.js, rank.js, build-cost.js, quote-check*.js).
// Used by scripts/build.mjs, which hashes the minified text for the ?v= cache-busting versions, so a page
// always names the exact bytes it gets.
//
// The sources are plain ES5 scripts (an IIFE each, no modules), and the output stays ES5 (target es5) so
// nothing newer than the source is introduced. Without a "format", esbuild keeps top-level names, so
// globals such as window.SF / window.SFRank and rank.js's `module.exports` branch for Node work as before.
// Licence comments (/*! ... */) are kept.
import { transformSync } from "esbuild";

export const MINIFIED_JS = new Set(["app.js", "rank.js", "build-cost.js", "quote-check.js", "quote-check-report.js"]);

export function minifyJs(code, name = "script.js") {
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
