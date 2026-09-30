import { connectHost } from "@openchamber/sdk";

import { SOUNDS } from "./sounds";

const host = connectHost();

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/** 内置音效不存在时的回落项（取列表第一个，不硬编码具体名字） */
const DEFAULT_BUILTIN = "builtin:" + (Object.keys(SOUNDS)[0] ?? "");

/** 选中的音效，"builtin:名字" 或 "imp:我的音效" */
let sound = DEFAULT_BUILTIN;
let onlyFailure = false;
let volume = 80;

/** 导入音效清单：name → 分块元数据（真实数据存在 storage 的分块键里） */
type ImpSound = { chunks: number; bytes: number; mime: string; duration: number };
type Library = Record<string, ImpSound>;

let library: Library = {};

const LIB_KEY = "chime:library"; // 清单
const chunkKey = (name: string, i: number) => `chime:snd:${name}:${i}`;

// storage 单键上限 65,536 字节（JSON.stringify 后计），留余量按 60,000 分块
const CHUNK = 60_000;
const MAX_FILE = 4 * 1024 * 1024;
const MAX_DUR = 15;

/**
 * 问题 2 的修复核心：生命周期事件由会话状态映射（busy/retry → started、
 * idle → completed、其他 → failure），切换历史会话时宿主会重放其当前状态。
 * 只有先见过该会话 started（真的在跑）之后到达的 completed/failure 才响。
 */
const running = new Set<string>();

// ---------------------------------------------------------------------------
// DOM 小工具
// ---------------------------------------------------------------------------

const d = (id: string) => document.getElementById(id) as HTMLElement | null;

function setStatus(msg: string) {
  const el = d("status");
  if (el) el.textContent = msg;
}

function setMsg(msg: string, isError = false) {
  const el = d("msg");
  if (el) {
    el.textContent = msg;
    el.style.color = isError ? "#ff453a" : "";
  }
}

function setLast(msg: string) {
  const el = d("last");
  if (el) el.textContent = msg;
}

// ---------------------------------------------------------------------------
// 音频内核：AudioContext + 主增益（音量调节）+ AudioBuffer 缓存
// ---------------------------------------------------------------------------

const AudioCtxCtor =
  (window as any).AudioContext || (window as any).webkitAudioContext;
const audioCtx: AudioContext | null = AudioCtxCtor ? new AudioCtxCtor() : null;
const master: GainNode | null = audioCtx ? audioCtx.createGain() : null;
if (audioCtx && master) master.connect(audioCtx.destination);

function applyVolume() {
  if (master) master.gain.value = Math.max(0, Math.min(1, volume / 100));
}
applyVolume();

const bufferCache = new Map<string, AudioBuffer>();

// base64 ⇄ 字节（分块版，避免大数组爆调用栈）
function b64encode(bytes: Uint8Array): string {
  let s = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    s += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + STEP) as unknown as number[],
    );
  }
  return btoa(s);
}

function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function ensureCtx(): Promise<boolean> {
  if (!audioCtx) return false;
  try {
    if (audioCtx.state === "suspended") await audioCtx.resume();
  } catch {
    /* 无音频设备时保持 suspended，后续调用会再试 */
  }
  return true;
}

/** 从 storage 拼回导入音效的 base64 */
async function loadImpB64(name: string): Promise<string | null> {
  const meta = library[name];
  if (!meta) return null;
  try {
    const parts = await Promise.all(
      Array.from({ length: meta.chunks }, (_, i) =>
        host.storage.get(chunkKey(name, i)),
      ),
    );
    let s = "";
    for (const p of parts) {
      if (typeof p !== "string") return null;
      s += p;
    }
    return s;
  } catch {
    return null;
  }
}

async function decodeToBuffer(cacheKey: string, b64: string): Promise<AudioBuffer | null> {
  const cached = bufferCache.get(cacheKey);
  if (cached) return cached;
  if (!(await ensureCtx())) return null;
  try {
    const buf = await audioCtx!.decodeAudioData(b64decode(b64).buffer);
    bufferCache.set(cacheKey, buf);
    return buf;
  } catch {
    return null;
  }
}

/** 播放选中的音效；value 形如 "builtin:Bell" / "imp:名字" */
async function playSound(value: string): Promise<boolean> {
  let b64: string | null = null;
  let cacheKey = value;
  if (value.startsWith("imp:")) {
    const name = value.slice(4);
    b64 = await loadImpB64(name);
  } else if (value.startsWith("builtin:")) {
    b64 = SOUNDS[value.slice(8)] ?? null;
  }
  if (!b64) return false;

  const buf = await decodeToBuffer(cacheKey, b64);
  if (!buf || !audioCtx || !master) return false;
  try {
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(master); // 经主增益 → 受音量滑杆控制
    src.start();
    return true;
  } catch {
    return false;
  }
}

/** 纯合成兜底（万一解码失败），同样过主增益 */
function synthDing() {
  if (!audioCtx || !master) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = 1318;
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.35, audioCtx.currentTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 1.2);
    osc.connect(gain).connect(master);
    osc.start();
    osc.stop(audioCtx.currentTime + 1.3);
  } catch {
    /* 无音频设备时静默 */
  }
}

async function chime() {
  const ok = await playSound(sound);
  if (!ok) synthDing();
  setLast("🔔 " + new Date().toLocaleTimeString() + " · " + displayName(sound));
}

function displayName(value: string): string {
  if (value.startsWith("imp:")) return value.slice(4);
  if (value.startsWith("builtin:")) return value.slice(8);
  return value;
}

// ---------------------------------------------------------------------------
// 音效下拉框（系统 + 导入）
// ---------------------------------------------------------------------------

function rebuildSelect() {
  const snd = d("sound") as HTMLSelectElement | null;
  if (!snd) return;
  snd.innerHTML = "";

  const sys = document.createElement("optgroup");
  sys.label = "系统音效";
  for (const name of Object.keys(SOUNDS)) {
    const opt = document.createElement("option");
    opt.value = "builtin:" + name;
    opt.textContent = name;
    sys.appendChild(opt);
  }
  snd.appendChild(sys);

  const names = Object.keys(library).sort((a, b) => a.localeCompare(b));
  if (names.length > 0) {
    const imp = document.createElement("optgroup");
    imp.label = "我的音效";
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = "imp:" + name;
      const dur = library[name].duration.toFixed(1);
      opt.textContent = `${name}（${dur}s）`;
      imp.appendChild(opt);
    }
    snd.appendChild(imp);
  }

  // 当前值失效时（音效被删/清单变化）回落到默认
  if (!Array.from(snd.options).some((o) => o.value === sound)) {
    sound = DEFAULT_BUILTIN;
  }
  snd.value = sound;
  const del = d("del") as HTMLButtonElement | null;
  if (del) del.disabled = !sound.startsWith("imp:");
}

// ---------------------------------------------------------------------------
// 导入 / 删除
// ---------------------------------------------------------------------------

function sanitizeName(raw: string): string {
  const base = raw.replace(/\.[^.]+$/, "");
  const cleaned = base.replace(/[^\w\u4e00-\u9fa5\-]/g, "_").slice(0, 40);
  return cleaned || "imported";
}

async function importFile(file: File) {
  if (!(await ensureCtx())) {
    setMsg("✗ 当前环境无可用音频设备", true);
    return;
  }
  if (file.size > MAX_FILE) {
    setMsg("✗ 文件超过 4MB 上限", true);
    return;
  }
  setMsg("正在解码 " + file.name + " …");

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    setMsg("✗ 读取文件失败", true);
    return;
  }

  // 用真实解码验证格式；副本传入，避免 ArrayBuffer 被 detach
  let decoded: AudioBuffer;
  try {
    decoded = await audioCtx!.decodeAudioData(bytes.buffer.slice(0));
  } catch {
    setMsg("✗ 无法解码该格式（支持 mp3 / wav / m4a / aac / ogg / flac）", true);
    return;
  }
  if (decoded.duration > MAX_DUR) {
    setMsg(
      `✗ 提示音过长（${decoded.duration.toFixed(1)}s，上限 ${MAX_DUR}s）`,
      true,
    );
    return;
  }

  // 起名（系统音与导入音都不重名）
  const base = sanitizeName(file.name);
  let name = base;
  for (let i = 2; library[name] || SOUNDS[name]; i++) name = `${base}-${i}`;

  const b64 = b64encode(bytes);
  const n = Math.ceil(b64.length / CHUNK);
  const written: string[] = [];
  try {
    for (let c = 0; c < n; c++) {
      const key = chunkKey(name, c);
      await host.storage.set(key, b64.slice(c * CHUNK, (c + 1) * CHUNK));
      written.push(key);
    }
    library[name] = {
      chunks: n,
      bytes: b64.length,
      mime: file.type || "application/octet-stream",
      duration: decoded.duration,
    };
    await host.storage.set(LIB_KEY, library);
  } catch (err) {
    // 回滚分块，避免留下孤儿键
    await Promise.all(written.map((k) => host.storage.delete(k).catch(() => {})));
    delete library[name];
    setMsg(
      "✗ 存储失败：" + (err instanceof Error ? err.message : String(err)),
      true,
    );
    return;
  }

  bufferCache.set("imp:" + name, decoded);
  sound = "imp:" + name;
  await host.storage.set("sound", sound);
  rebuildSelect();
  setMsg(`✓ 已导入「${name}」（${decoded.duration.toFixed(1)}s，${n} 块）`);
  playSound(sound); // 导入成功即试听
}

let pendingDelete: string | null = null;
let deleteTimer: ReturnType<typeof setTimeout> | null = null;

async function deleteImported(name: string) {
  const meta = library[name];
  if (!meta) return;
  try {
    for (let c = 0; c < meta.chunks; c++) {
      await host.storage.delete(chunkKey(name, c));
    }
    delete library[name];
    await host.storage.set(LIB_KEY, library);
    bufferCache.delete("imp:" + name);
    setMsg(`✓ 已删除「${name}」`);
  } catch (err) {
    setMsg(
      "✗ 删除失败：" + (err instanceof Error ? err.message : String(err)),
      true,
    );
    return;
  }
  if (sound === "imp:" + name) {
    sound = DEFAULT_BUILTIN;
    await host.storage.set("sound", sound);
  }
  rebuildSelect();
}

/** 删除按钮：沙箱 iframe 里 confirm() 可能被拦，用两步确认 */
function handleDeleteClick() {
  const del = d("del") as HTMLButtonElement | null;
  if (!del || !sound.startsWith("imp:")) return;
  const name = sound.slice(4);

  if (pendingDelete !== name) {
    pendingDelete = name;
    del.textContent = "确认删除?";
    if (deleteTimer) clearTimeout(deleteTimer);
    deleteTimer = setTimeout(() => {
      pendingDelete = null;
      del.textContent = "🗑 删除";
    }, 3000);
    return;
  }

  pendingDelete = null;
  if (deleteTimer) clearTimeout(deleteTimer);
  del.textContent = "🗑 删除";
  deleteImported(name);
}

// ---------------------------------------------------------------------------
// 就绪 / 生命周期
// ---------------------------------------------------------------------------

host.onReady((ctx) => {
  document.body.dataset.theme = ctx.theme.mode;

  rebuildSelect();

  const snd = d("sound") as HTMLSelectElement | null;
  const fail = d("onlyFailure") as HTMLInputElement | null;
  const vol = d("volume") as HTMLInputElement | null;
  const volLabel = d("volLabel");
  const test = d("test");
  const imp = d("importBtn");
  const file = d("import") as HTMLInputElement | null;
  const del = d("del");

  if (snd)
    snd.onchange = () => {
      sound = snd.value;
      host.storage.set("sound", sound);
      playSound(sound); // 切换即试听
    };

  if (fail)
    fail.onchange = () => {
      onlyFailure = fail.checked;
      host.storage.set("onlyFailure", onlyFailure);
    };

  if (vol) {
    vol.value = String(volume);
    if (volLabel) volLabel.textContent = volume + "%";
    vol.oninput = () => {
      volume = Number(vol.value);
      if (volLabel) volLabel.textContent = volume + "%";
      applyVolume(); // 拖动实时生效
    };
    vol.onchange = () => host.storage.set("volume", volume);
  }

  if (test) test.onclick = () => playSound(sound);
  if (del) del.onclick = handleDeleteClick;
  if (imp && file) {
    imp.onclick = () => file.click();
    file.onchange = () => {
      const f = file.files?.[0];
      if (f) importFile(f);
      file.value = ""; // 允许重复选择同一文件
    };
  }

  setStatus("监听已连接 ✓");
});

// 核心：只对「我们见过它 started」的会话响应完成/失败。
host.onSessionLifecycle((event) => {
  const { sessionId, phase } = event;
  if (phase === "started") {
    running.add(sessionId);
    return;
  }
  if (phase === "completed" || phase === "failure") {
    if (!running.delete(sessionId)) {
      // 没见过 started：这是切换会话时重放的历史空闲状态，忽略。
      return;
    }
    if (phase === "completed") {
      if (!onlyFailure) chime();
      else setLast("任务完成（静音） " + new Date().toLocaleTimeString());
    } else {
      chime();
      setLast("⚠️ 任务失败 " + new Date().toLocaleTimeString());
    }
  }
});

// 恢复已保存的偏好与导入清单
Promise.all([
  host.storage.get("sound"),
  host.storage.get("onlyFailure"),
  host.storage.get("volume"),
  host.storage.get(LIB_KEY),
]).then(([s, f, v, lib]) => {
  if (typeof f === "boolean") onlyFailure = f;
  if (typeof v === "number" && v >= 0 && v <= 100) volume = v;
  if (lib && typeof lib === "object") library = lib as Library;
  // 先恢复清单再定音效，避免 rebuildSelect 把合法的导入项误判为失效
  if (typeof s === "string") {
    if (s.startsWith("imp:")) {
      if (library[s.slice(4)]) sound = s;
    } else if (s.startsWith("builtin:") && SOUNDS[s.slice(8)]) {
      sound = s;
    }
  }
  applyVolume();
  rebuildSelect();

  const fail = d("onlyFailure") as HTMLInputElement | null;
  if (fail) fail.checked = onlyFailure;
  const vol = d("volume") as HTMLInputElement | null;
  if (vol) {
    vol.value = String(volume);
    const volLabel = d("volLabel");
    if (volLabel) volLabel.textContent = volume + "%";
  }
  const cnt = Object.keys(library).length;
  if (cnt > 0) setMsg(`已加载 ${cnt} 个导入音效`);
});
