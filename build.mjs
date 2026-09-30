import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: "panel/main.js",
  target: "es2020",
  charset: "utf8", // 保留中文原文（index.html 为 utf-8）
  logLevel: "info",
});

console.log("built panel/main.js");

// service 入口：宿主以 ELECTRON_RUN_AS_NODE（纯 Node）拉起，必须是编译好的
// CJS JS（package.json 无 "type" 字段 → .js 即 CJS）。
await build({
  entryPoints: ["src/service.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "service/main.js",
  target: "node18",
  logLevel: "info",
});

console.log("built service/main.js");
