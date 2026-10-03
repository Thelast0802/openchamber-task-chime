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
 * 回合去重：生命周期事件由会话状态映射（busy/retry → started、idle →
 * completed、其他 → failure），切换历史会话时宿主会重放其当前状态。
 * turn 计数（见 noteTurn/settleTurn）保证只有亲眼见过某轮开跑，才会为它的
 * 结束响一声；同一轮被两条推送路径各结算一次时，第二条认账不重响。
 * running 集合保留作“见过开跑”的快速标记（日志与上传预热用）。
 */
const running = new Set<string>();

// ---------------------------------------------------------------------------
// 回合记账（单会话事件 + 全会话快照共用）：开跑 → turn+1；完成/失败 →
// 结算该 turn。两条推送路径先后到达同一轮时，先到的响、后到的认账不重响。
// ---------------------------------------------------------------------------

type FeedRec = { activity: string; turn: number; chimedTurn: number };
const feed = new Map<string, FeedRec>();
let feedOn = false;
let feedDenied = false;
let feedProjects = 0;
const feedUnsubs: Array<() => void> = [];

function noteTurn(id: string) {
  let r = feed.get(id);
  if (!r) {
    r = { activity: "unknown", turn: 0, chimedTurn: 0 };
    feed.set(id, r);
  }
  r.turn++;
  running.add(id);
  markSeen(id);
}

/** 跨重载补救：面板 reload 会清空内存，持久化的“见过开跑”让 reload 后到达的
 * 完成照样结算；5 分钟窗口 + done 标记防止对陈年 completed 误响。 */
const CATCHUP_MS = 5 * 60 * 1000;
const SEEN_KEY = "chime:seen";
const DONE_KEY = "chime:done";
let seenMap: Record<string, number> = {};
let doneMap: Record<string, number> = {};
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const cutoff = Date.now() - 60 * 60 * 1000;
    const prune = (m: Record<string, number>) => {
      const out: Record<string, number> = {};
      const keys = Object.keys(m).sort((a, b) => m[b]! - m[a]!);
      for (const k of keys.slice(0, 100)) {
        if (m[k]! >= cutoff) out[k] = m[k]!;
      }
      return out;
    };
    seenMap = prune(seenMap);
    doneMap = prune(doneMap);
    host.storage.set(SEEN_KEY, seenMap).catch(() => {});
    host.storage.set(DONE_KEY, doneMap).catch(() => {});
  }, 500);
}

function markSeen(id: string) {
  seenMap[id] = Date.now();
  schedulePersist();
}

function markDone(id: string) {
  doneMap[id] = Date.now();
  schedulePersist();
}

function settleTurn(id: string, outcome: "completed" | "failed") {
  let r = feed.get(id);
  if (!r) {
    r = { activity: "unknown", turn: 0, chimedTurn: 0 };
    feed.set(id, r);
  }
  running.delete(id);
  if (r.turn <= 0) {
    // 内存里没见过开跑：可能是 reload 丢了状态，查持久化标记补救
    const fresh =
      (seenMap[id] ?? 0) > (doneMap[id] ?? 0) &&
      Date.now() - (seenMap[id] ?? 0) < CATCHUP_MS;
    if (!fresh) {
      dbg("suppress", `${outcome} · ${shortId(id)} · 未见过开跑`);
      return;
    }
    dbg("catchup", `${outcome} · ${shortId(id)} · reload 后补结算`);
    r.turn = 1;
  }
  if (r.chimedTurn === r.turn) {
    dbg("suppress", `${outcome} · ${shortId(id)} · 本轮已响过`);
    return;
  }
  r.chimedTurn = r.turn;
  markDone(id);
  if (outcome === "failed") {
    chime()
      .catch(() => {})
      .then(() => setLast("⚠️ 任务失败 " + new Date().toLocaleTimeString()));
  } else if (!onlyFailure) {
    chime();
  } else {
    dbg("suppress", `completed · ${shortId(id)} · 只失败模式`);
    setLast("任务完成（静音） " + new Date().toLocaleTimeString());
  }
}

// ---------------------------------------------------------------------------
// 全会话监听（sessions capability）：订阅各项目的会话快照，跟踪 activity
// 翻转（running/retrying → idle），后台会话完成也能响。面板每启动打开一次
// 即覆盖全部会话；未授权或宿主不支持时退回“仅当前会话”事件。
// ---------------------------------------------------------------------------

const isLiveActivity = (a: string) => a === "running" || a === "retrying";

type FeedSession = {
  id: string;
  activity?: unknown;
  outcome?: unknown;
  archivedAt?: unknown;
};

/** 每个项目首个快照记一笔（看得见订阅到底覆盖了谁），之后只记翻转 */
const feedSeenProjects = new Set<string>();

function onFeedSnapshot(pid: string, snap: { sessions?: FeedSession[] }) {
  const list = snap?.sessions;
  if (!Array.isArray(list)) return;
  if (!feedSeenProjects.has(pid)) {
    feedSeenProjects.add(pid);
    const live: string[] = [];
    let total = 0;
    for (const s of list) {
      if (!s || typeof s.id !== "string" || s.archivedAt) continue;
      total++;
      if (
        typeof s.activity === "string" &&
        s.activity !== "idle" &&
        s.activity !== "unknown"
      ) {
        live.push(shortId(s.id));
      }
    }
    dbg(
      "feed",
      `项目快照 ${total} 会话${live.length ? ` · 跑着：${live.join(",")}` : ""}`,
    );
  }
  for (const s of list) {
    if (!s || typeof s.id !== "string" || s.archivedAt) continue;
    const cur = typeof s.activity === "string" ? s.activity : "unknown";
    let r = feed.get(s.id);
    if (!r) {
      // 首见即基线；打开面板时已经在跑的任务也算见过开跑，完成时要响
      r = { activity: cur, turn: isLiveActivity(cur) ? 1 : 0, chimedTurn: 0 };
      feed.set(s.id, r);
      if (r.turn > 0) running.add(s.id);
      continue;
    }
    const prev = r.activity;
    r.activity = cur;
    if (prev === cur) continue;
    if (isLiveActivity(cur) && !isLiveActivity(prev)) {
      r.turn++;
      running.add(s.id);
      dbg("event", `feed ${cur} · ${shortId(s.id)}`);
    } else if (
      cur === "idle" &&
      prev !== "idle" &&
      (prev !== "unknown" || r.turn > 0)
    ) {
      // prev unknown + turn>0：另一条通道见过开跑（如事件先到），照样结算
      const outcome = s.outcome === "failed" ? "failed" : "completed";
      dbg("event", `feed idle(${outcome}) · ${shortId(s.id)}`);
      settleTurn(s.id, outcome);
    }
  }
}

const feedProjectIds = new Set<string>();
let projectsWatched = false;
let feedSyncing = false;

async function subscribeProject(pid: string) {
  const off = await host.onSessions(pid, (s) => onFeedSnapshot(pid, s));
  if (typeof off !== "function") throw new Error("no-unsubscribe");
  feedUnsubs.push(off);
  feedProjectIds.add(pid);
}

async function ensureFeed() {
  if (feedSyncing) return;
  if (
    typeof host.listProjects !== "function" ||
    typeof host.onSessions !== "function"
  ) {
    feedDenied = true;
    dbg("feed", "宿主不支持会话订阅，仅当前会话");
    renderStatus();
    return;
  }
  feedSyncing = true;
  try {
    // 订阅项目名单本身：之后新建的项目自动补订阅
    if (!projectsWatched && typeof host.onProjects === "function") {
      projectsWatched = true;
      try {
        const off = await host.onProjects(() => {
          void ensureFeed();
        });
        if (typeof off === "function") feedUnsubs.push(off);
      } catch {
        projectsWatched = false; // 下次重试
      }
    }
    const snap = await host.listProjects();
    for (const p of snap.projects) {
      if (feedProjectIds.has(p.id)) continue;
      try {
        await subscribeProject(p.id);
      } catch {
        dbg("feed", `订阅项目失败`);
      }
    }
    feedProjects = feedProjectIds.size;
    if (feedProjects > 0) {
      feedOn = true;
      feedDenied = false;
    }
    dbg("feed", `会话订阅 ${feedProjects}/${snap.projects.length} 个项目`);
  } catch (err) {
    if ((err as { code?: string })?.code === "NOT_GRANTED") {
      feedDenied = true;
      dbg("feed", "NOT_GRANTED：设置里允许会话访问后覆盖全部会话");
    } else {
      dbg("feed", "不可用，仅当前会话");
    }
  } finally {
    feedSyncing = false;
  }
  renderStatus();
}

// ---------------------------------------------------------------------------
// 诊断环形日志：记录最近 40 条事件与播放决策，存 storage `chime:debug` 键。
// 出问题时读这个文件就知道是事件没送达、去重吞了，还是播放失败。
// ---------------------------------------------------------------------------

type DbgEntry = { t: string; kind: string; info: string };
const DBG_KEY = "chime:debug";
const dbgBuf: DbgEntry[] = [];
let dbgTimer: ReturnType<typeof setTimeout> | null = null;

function shortId(id: string): string {
  return id.length > 12 ? "…" + id.slice(-8) : id;
}

function dbg(kind: string, info: string) {
  dbgBuf.push({ t: new Date().toLocaleTimeString(), kind, info });
  while (dbgBuf.length > 40) dbgBuf.shift();
  // 合并写，避免高频事件刷 storage
  if (dbgTimer) return;
  dbgTimer = setTimeout(() => {
    dbgTimer = null;
    host.storage.set(DBG_KEY, dbgBuf).catch(() => {});
  }, 500);
}

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
  setLast("🔔 " + new Date().toLocaleTimeString() + " · " + displayName(sound));
  await playSelected();
}

function displayName(value: string): string {
  if (value.startsWith("imp:")) return value.slice(4);
  if (value.startsWith("builtin:")) return value.slice(8);
  return value;
}

// ---------------------------------------------------------------------------
// 系统播放（service / afplay）：完成提示优先让宿主侧服务出声，面板关闭/
// 不可见时照样响；服务未授权、故障或播放失败则回退上面的 Web Audio 路径。
// ---------------------------------------------------------------------------

type SvcState = "unknown" | "ready" | "denied" | "broken";
let svcState: SvcState = "unknown";
/** 已上传到服务的导入音效名（服务进程重启后靠 404 触发重传） */
const svcUploaded = new Set<string>();
const svcUploading = new Map<string, Promise<boolean>>();
/** service 请求体上限 64,000 字符，留 JSON 信封余量 */
const SVC_CHUNK = 63_500;

function renderStatus() {
  const svcTail =
    svcState === "ready"
      ? " · 系统播放就绪：面板关闭也会响"
      : svcState === "denied"
        ? " · 系统播放未授权（Settings → Extensions 允许本地服务后生效），当前仅面板内播放"
        : svcState === "broken"
          ? " · 系统服务异常，回退面板播放"
          : "";
  const feedTail = feedOn
    ? ` · 全会话监听开（${feedProjects} 个项目）`
    : feedDenied
      ? " · 全会话监听未授权（允许会话访问后后台任务也响），当前仅正在看的会话"
      : "";
  setStatus("监听已连接 ✓" + svcTail + feedTail);
}

/** 面板永远拿不到 service token，只能经宿主代理；错误按 code 归类状态 */
async function svcCall(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string } | null> {
  if (typeof host.serviceRequest !== "function") return null;
  try {
    return await host.serviceRequest({
      method,
      path,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "NO_SERVICE" || code === "DISABLED") svcState = "denied";
    else if (code === "SERVICE_FAILED") svcState = "broken";
    dbg("svc", `${path} err=${code ?? "unknown"}`);
    renderStatus();
    return null;
  }
}

/** onReady 时提前拉起服务（首次 spawn 约几百毫秒），避免第一声迟到 */
async function warmService() {
  dbg("svc", "warm /health …");
  const r = await svcCall("GET", "/health");
  if (r && r.status === 200) {
    svcState = "ready";
    renderStatus();
    warmUploadCurrent();
  }
}

function warmUploadCurrent() {
  if (svcState === "ready" && sound.startsWith("imp:")) {
    void ensureUpload(sound.slice(4));
  }
}

/** 把导入音效分块 POST 给服务缓存（64KB 请求体上限所致），带去重 */
function ensureUpload(name: string): Promise<boolean> {
  if (svcUploaded.has(name)) return Promise.resolve(true);
  let pending = svcUploading.get(name);
  if (!pending) {
    pending = (async () => {
      const meta = library[name];
      if (!meta) return false;
      const b64 = await loadImpB64(name);
      if (!b64) return false;
      const total = Math.ceil(b64.length / SVC_CHUNK);
      for (let i = 0; i < total; i++) {
        const r = await svcCall("POST", "/audio", {
          name,
          mime: meta.mime,
          index: i,
          total,
          data: b64.slice(i * SVC_CHUNK, (i + 1) * SVC_CHUNK),
        });
        if (!r || r.status !== 200) return false;
      }
      svcUploaded.add(name);
      return true;
    })().finally(() => svcUploading.delete(name));
    svcUploading.set(name, pending);
  }
  return pending;
}

/** 服务端 afplay 播放；true = 已由系统出声（含静音跳过） */
async function playViaService(value: string): Promise<boolean> {
  if (svcState === "broken") return false;
  if (value.startsWith("imp:") && !(await ensureUpload(value.slice(4)))) {
    return false;
  }
  let r = await svcCall("POST", "/chime", { sound: value, volume });
  if (!r) return false;
  if (r.status === 200) {
    if (svcState !== "ready") {
      svcState = "ready";
      renderStatus();
    }
    return true;
  }
  // 404 = 服务重启过、导入音缓存丢失 → 重传一次再试
  if (r.status === 404 && value.startsWith("imp:")) {
    const name = value.slice(4);
    if (svcUploaded.delete(name) && (await ensureUpload(name))) {
      r = await svcCall("POST", "/chime", { sound: value, volume });
      if (r && r.status === 200) return true;
    }
  }
  // 其余 4xx/5xx（如 afplay 不支持的格式）→ 回退 Web Audio
  return false;
}

/** 播放选中音效：系统播放优先，失败回退面板 Web Audio，再不行合成兜底 */
async function playSelected() {
  if (await playViaService(sound)) {
    dbg("play", `service ok · ${displayName(sound)} · vol ${volume}`);
    return;
  }
  const ok = await playSound(sound);
  dbg("play", ok ? `webaudio ok · ${displayName(sound)}` : "webaudio fail → synth");
  if (!ok) synthDing();
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
  svcUploaded.delete(name); // 同名重导入时服务端缓存作废
  warmUploadCurrent();
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
    svcUploaded.delete(name);
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
      warmUploadCurrent(); // 换成导入音时预热上传，第一声不迟到
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

  if (test) test.onclick = () => {
    void ensureFeed(); // 审批通过后点试听即补上订阅，无需重开面板
    playSelected();
  };
  if (del) del.onclick = handleDeleteClick;
  if (imp && file) {
    imp.onclick = () => file.click();
    file.onchange = () => {
      const f = file.files?.[0];
      if (f) importFile(f);
      file.value = ""; // 允许重复选择同一文件
    };
  }

  renderStatus();
  void warmService(); // 提前 spawn 服务，任务完成那声不用等冷启动
  void ensureFeed(); // 订阅全会话快照，后台任务完成也能响
});

// 双推送路径共用回合记账：当前会话事件（快）+ 全会话快照（全），先到先响。
host.onSessionLifecycle((event) => {
  const { sessionId, phase } = event;
  dbg("event", `${phase} · ${shortId(sessionId)} · turn=${feed.get(sessionId)?.turn ?? 0}`);
  if (phase === "started") {
    noteTurn(sessionId);
    return;
  }
  if (phase === "completed" || phase === "failure") {
    settleTurn(sessionId, phase === "failure" ? "failed" : "completed");
  }
});

// 恢复已保存的偏好、导入清单与回合标记（seen/done 让 reload 不丢轮次）
Promise.all([
  host.storage.get("sound"),
  host.storage.get("onlyFailure"),
  host.storage.get("volume"),
  host.storage.get(LIB_KEY),
  host.storage.get(SEEN_KEY),
  host.storage.get(DONE_KEY),
]).then(([s, f, v, lib, seen, done]) => {
  if (typeof f === "boolean") onlyFailure = f;
  if (typeof v === "number" && v >= 0 && v <= 100) volume = v;
  if (lib && typeof lib === "object") library = lib as Library;
  if (seen && typeof seen === "object") seenMap = seen as Record<string, number>;
  if (done && typeof done === "object") doneMap = done as Record<string, number>;
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
  warmUploadCurrent(); // 选中的是导入音且服务已就绪 → 预传

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
