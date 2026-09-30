import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: "panel/main.js",
  target: "es2020",
  logLevel: "info",
});

console.log("built panel/main.js");
