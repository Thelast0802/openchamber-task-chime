/**
 * 【个人使用】把本机 macOS 系统音效（/System/Library/Sounds）重新嵌入 src/sounds.ts。
 *
 * ⚠️ macOS 系统音效是 Apple 版权资产：
 *   - 本脚本仅用于你个人本地构建，**不要把产物提交到公开仓库/发布版**；
 *   - 公开发布请保持 scripts/make-sounds.mjs 生成的原创音效。
 *
 * 运行：node scripts/embed-system-sounds.mjs
 * 之后：node build.mjs 重新打包。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = "/System/Library/Sounds";

if (!fs.existsSync(SRC)) {
  console.error("✗ 未找到 /System/Library/Sounds，本脚本仅适用于 macOS。");
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chime-sys-"));
const entries = [];

for (const f of fs.readdirSync(SRC).sort()) {
  if (!f.endsWith(".aiff")) continue;
  const name = path.basename(f, ".aiff");
  const wav = path.join(tmp, name + ".wav");
  try {
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@22050", "-c", "1", path.join(SRC, f), wav]);
    entries.push([name, fs.readFileSync(wav).toString("base64")]);
  } catch (err) {
    console.warn(`  跳过 ${f}: ${err.message}`);
  }
}

if (entries.length === 0) {
  console.error("✗ 没有转换出任何音效。");
  process.exit(1);
}

const ts =
  `// ⚠️ 本文件当前嵌入的是 Apple macOS 系统音效——仅限个人本地使用，\n` +
  `//    请勿提交到公开仓库（版权）。发布版请运行 scripts/make-sounds.mjs 恢复原创音效。\n` +
  `export const SOUNDS: Record<string, string> = {\n` +
  entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n") +
  `\n};\n`;

fs.writeFileSync(path.join(ROOT, "src", "sounds.ts"), ts);
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`✓ 已嵌入 ${entries.length} 个系统音效 → src/sounds.ts`);
console.log("⚠️  请勿公开提交此产物；发布前运行 node scripts/make-sounds.mjs 恢复原创音效。");
console.log("下一步：node build.mjs");
