// Bundles src/knowledge/ (Tiptap + Sigma.js + Graphology) into
// dist/knowledge.bundle.js. This is the ONLY part of Snackable that goes
// through a build step — everything else (dashboard.js, background.js,
// vendored Shoelace) loads unbundled, straight from disk, same as always.
// The built output is committed to the repo, same treatment as the
// vendored Shoelace files, since there's no CI to run this automatically.
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/knowledge/index.js"],
  bundle: true,
  outfile: "dist/knowledge.bundle.js",
  format: "esm",
  target: "chrome110",
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching src/knowledge/ for changes...");
} else {
  await esbuild.build(options);
}
