/**
 * 生成原创提示音 → src/sounds.ts（base64 内嵌）。
 *
 * 全部由加法合成/扫频/噪声瞬态合成，不含任何第三方版权素材。
 * 运行：node scripts/make-sounds.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SR = 22050; // 与既有管线一致（单声道 16bit PCM）
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// DSP 小工具
// ---------------------------------------------------------------------------

/** 按 t(秒) 采样渲染；fn 返回单声道样本 */
function render(dur, fn) {
  const n = Math.round(SR * dur);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i / SR, i);
  return out;
}

const expDecay = (t, tau) => Math.exp(-t / tau);
const softAttack = (t, a) => (t < a ? t / a : 1); // 线性起音

/** 归一化到目标峰值 */
function normalize(buf, peak = 0.85) {
  let max = 0;
  for (const s of buf) max = Math.max(max, Math.abs(s));
  if (max === 0) return buf;
  const g = peak / max;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

/** 混入（同长度相加） */
function mixInto(dst, src, delaySec = 0) {
  const off = Math.round(delaySec * SR);
  for (let i = 0; i < src.length && off + i < dst.length; i++) {
    dst[off + i] += src[i];
  }
}

// ---------------------------------------------------------------------------
// 音色（每个都是原创合成）
// ---------------------------------------------------------------------------

/** 玻璃钟：非谐分音 + 不同衰减，清脆带尾韵 */
function bell() {
  const f0 = 1318.5; // E6
  const partials = [
    { r: 1.0, a: 1.0, tau: 1.1 },
    { r: 2.76, a: 0.5, tau: 0.65 },
    { r: 5.4, a: 0.28, tau: 0.35 },
    { r: 8.93, a: 0.14, tau: 0.22 },
  ];
  const buf = render(1.6, (t) => {
    const atk = softAttack(t, 0.004);
    let s = 0;
    for (const p of partials) s += p.a * Math.sin(2 * Math.PI * f0 * p.r * t) * expDecay(t, p.tau);
    return atk * s;
  });
  return normalize(buf);
}

/** 木琴：1:4:10 泛音 + 敲击瞬态，短促温润 */
function marimba() {
  const f0 = 523.25; // C5
  const buf = render(0.7, (t) => {
    const atk = softAttack(t, 0.003);
    const body =
      Math.sin(2 * Math.PI * f0 * t) * expDecay(t, 0.42) +
      0.35 * Math.sin(2 * Math.PI * f0 * 4 * t) * expDecay(t, 0.16) +
      0.1 * Math.sin(2 * Math.PI * f0 * 10 * t) * expDecay(t, 0.08);
    return atk * body;
  });
  // 敲击瞬态：前 8ms 指数衰减噪声
  const click = render(0.008, (t) => (Math.random() * 2 - 1) * expDecay(t, 0.002));
  mixInto(buf, click.map((x) => x * 0.25));
  return normalize(buf);
}

/** 水晶：高频分音 + 颤音，明亮 */
function crystal() {
  const f0 = 2093; // C7
  const buf = render(1.1, (t) => {
    const tremolo = 0.75 + 0.25 * Math.sin(2 * Math.PI * 6 * t);
    const atk = softAttack(t, 0.01);
    const s =
      Math.sin(2 * Math.PI * f0 * t) * expDecay(t, 0.55) +
      0.5 * Math.sin(2 * Math.PI * f0 * 2 * t) * expDecay(t, 0.35) +
      0.25 * Math.sin(2 * Math.PI * f0 * 3.02 * t) * expDecay(t, 0.22);
    return atk * tremolo * s;
  });
  return normalize(buf);
}

/** 和弦：C 大三和弦柔和铺底，适合作为“完成”音 */
function chord() {
  const freqs = [523.25, 659.26, 783.99, 1046.5]; // C5 E5 G5 C6
  const amps = [1, 0.8, 0.7, 0.4];
  const buf = render(1.4, (t) => {
    const atk = softAttack(t, 0.025);
    let s = 0;
    for (let i = 0; i < freqs.length; i++) {
      const detune = 1 + (i % 2 ? 0.0012 : -0.0012); // 轻微失谐做宽感
      s += amps[i] * Math.sin(2 * Math.PI * freqs[i] * detune * t);
    }
    return atk * s * expDecay(t, 0.75);
  });
  return normalize(buf);
}

/** Ping：两声上行扫频，轻快的“叮叮” */
function ping() {
  const chirp = (fStart, fEnd, dur) =>
    render(dur, (t) => {
      const k = t / dur;
      const f = fStart + (fEnd - fStart) * k;
      const atk = softAttack(t, 0.006);
      return atk * Math.sin(2 * Math.PI * (fStart * t + ((fEnd - fStart) * t * t) / (2 * dur))) * expDecay(t, dur * 0.55);
    });
  const a = chirp(880, 1320, 0.1);
  const b = chirp(1174.7, 1760, 0.13);
  const buf = new Float64Array(Math.round(SR * 0.45));
  mixInto(buf, a);
  mixInto(buf, b, 0.17);
  return normalize(buf);
}

/** 口哨：带揉弦的单音，柔和提醒 */
function whistle() {
  const f0 = 1567.98; // G6
  const buf = render(0.8, (t) => {
    const vib = 12 * Math.sin(2 * Math.PI * 5.5 * t); // ±12Hz 揉弦
    const env =
      (t < 0.02 ? t / 0.02 : 1) * (t > 0.3 ? expDecay(t - 0.3, 0.18) : 1);
    return env * (Math.sin(2 * Math.PI * f0 * t + (vib * t) / f0) + 0.2 * Math.sin(2 * Math.PI * 2 * f0 * t) * expDecay(t, 0.3));
  });
  return normalize(buf);
}

/** Drop：下行滑音，带一点俏皮 */
function drop() {
  const dur = 0.42;
  const buf = render(dur, (t) => {
    const k = t / dur;
    const f = 1046.5 * Math.pow(392 / 1046.5, k); // C6 → G4 指数下滑
    const atk = softAttack(t, 0.005);
    return atk * Math.sin(2 * Math.PI * f * t) * expDecay(t, 0.3);
  });
  return normalize(buf);
}

/** Sparkle：错落的高频星点，收到完成时的小惊喜 */
function sparkle() {
  const buf = new Float64Array(Math.round(SR * 1.0));
  const tones = [
    [1568, 0.0], [1975.5, 0.07], [2349.3, 0.14],
    [1760, 0.21], [2637, 0.28], [2093, 0.38],
  ];
  for (const [f, delay] of tones) {
    const seg = render(0.5, (t) =>
      softAttack(t, 0.004) *
      (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 2.51 * t)) *
      expDecay(t, 0.12),
    );
    mixInto(buf, seg.map((x) => x * 0.7), delay);
  }
  return normalize(buf);
}

const SOUNDS = {
  Bell: bell(),
  Marimba: marimba(),
  Crystal: crystal(),
  Chord: chord(),
  Ping: ping(),
  Whistle: whistle(),
  Drop: drop(),
  Sparkle: sparkle(),
};

// ---------------------------------------------------------------------------
// WAV 编码（16bit PCM 单声道）+ base64
// ---------------------------------------------------------------------------

function encodeWav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// 输出 src/sounds.ts
// ---------------------------------------------------------------------------

const entries = Object.entries(SOUNDS).map(([name, samples]) => [
  name,
  encodeWav(samples).toString("base64"),
]);

const header = `// 原创提示音（由 scripts/make-sounds.mjs 加法合成生成，无第三方版权素材）。
// 面板资源路由只服务 html/js/css/svg/json/png，音频以 base64 随包分发。
// 需要本机 macOS 系统音效的个人版：node scripts/embed-system-sounds.mjs（请勿公开提交其产物）。
export const SOUNDS: Record<string, string> = {
`;
const body = entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
const ts = header + body + "\n};\n";

fs.writeFileSync(path.join(ROOT, "src", "sounds.ts"), ts);

const kb = (b) => (b.length / 1024).toFixed(1) + "KB";
console.log(`生成 ${entries.length} 个原创音效 → src/sounds.ts`);
for (const [k, v] of entries) console.log(`  ${k.padEnd(9)} ${kb(Buffer.from(v, "base64"))} WAV → ${kb(v)} b64`);
console.log(`  合计 ${kb(ts)}`);
