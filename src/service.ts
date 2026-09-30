// 宿主侧提示音服务（contributes.service 入口，编译产物 service/main.js）。
// 协议：GUEST_SERVICES.md —— 仅绑 127.0.0.1（端口由宿主分配），每个请求带
// Authorization: Bearer <OPENCHAMBER_SERVICE_TOKEN>，GET /health 就绪信号。
// 播放用 afplay（permissions.exec 已声明），面板不可见/关闭时也能系统级出声。
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SOUNDS } from "./sounds";

// ---------------------------------------------------------------------------
// 环境与临时目录
// ---------------------------------------------------------------------------

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535 || !TOKEN) {
  console.error("[chime-service] missing OPENCHAMBER_SERVICE_PORT / OPENCHAMBER_SERVICE_TOKEN");
  process.exit(1);
}

const TMP = mkdtempSync(join(tmpdir(), "oc-chime-"));

function cleanup() {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 退出时尽力清理 */
  }
}
process.on("exit", cleanup);
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

// ---------------------------------------------------------------------------
// 音频文件解析：内置音效随包分发（WAV base64），导入音效由面板分块上传
// ---------------------------------------------------------------------------

/** name → 已落盘的临时文件（进程内存态；服务重启后由面板按 404 重传） */
const builtinFiles = new Map<string, string>();
const uploadedFiles = new Map<string, string>();
/** name → 正在拼装的分块 */
const assembling = new Map<
  string,
  { mime: string; total: number; parts: Array<string | null> }
>();
let seq = 0;

function extFor(mime: string, buf: Buffer): string {
  const m = mime.toLowerCase();
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  if (m.includes("wav")) return ".wav";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("m4b")) return ".m4a";
  if (m.includes("aac")) return ".aac";
  if (m.includes("ogg") || m.includes("opus") || m.includes("vorbis")) return ".ogg";
  if (m.includes("flac")) return ".flac";
  if (m.includes("aiff") || m.includes("aifc")) return ".aiff";
  if (m.includes("caf")) return ".caf";
  // mime 缺失/笼统时嗅探魔数，帮 afplay（CoreAudio）认出格式
  if (buf.length >= 12) {
    const head = buf.subarray(0, 12).toString("latin1");
    if (head.startsWith("RIFF")) return ".wav";
    if (head.startsWith("OggS")) return ".ogg";
    if (head.startsWith("fLaC")) return ".flac";
    if (head.startsWith("FORM")) return ".aiff";
    if (head.startsWith("ID3") || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)) return ".mp3";
    if (head.includes("ftyp")) return ".m4a";
  }
  return ".bin";
}

/** 解析面板选中的音效 → 临时文件路径；未知返回 null（404 unknown-sound） */
function resolveSound(value: string): string | null {
  if (value.startsWith("builtin:")) {
    const name = value.slice(8);
    const b64 = SOUNDS[name];
    if (!b64) return null;
    let file = builtinFiles.get(name);
    if (!file) {
      file = join(TMP, `builtin-${seq++}.wav`);
      writeFileSync(file, Buffer.from(b64, "base64"));
      builtinFiles.set(name, file);
    }
    return file;
  }
  if (value.startsWith("imp:")) {
    return uploadedFiles.get(value.slice(4)) ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// afplay 播放
// ---------------------------------------------------------------------------

type PlayResult = { code: number | null; error?: string; stderr: string };

/** 等 afplay 播完再应答（≤16s 强制收尾，留出宿主 20s 超时余量） */
function afplay(file: string, volume: number): Promise<PlayResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("afplay", ["-v", volume.toFixed(3), file], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      resolve({ code: -1, error: String(err), stderr: "" });
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 2000) stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    }, 16_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, error: String(err), stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP：鉴权 + 路由
// ---------------------------------------------------------------------------

const MAX_BODY = 70_000; // 宿主请求体上限 64,000，余量兜底

function bearerOk(header: string | undefined): boolean {
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  const got = Buffer.from(header ?? "");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function send(res: import("node:http").ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

type Json = Record<string, unknown> | null;
const TOO_LARGE = Symbol("too-large");

async function readJson(
  req: import("node:http").IncomingMessage,
): Promise<Json | typeof TOO_LARGE> {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) return resolve(TOO_LARGE);
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" ? (parsed as Json) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

async function handleChime(body: Json, res: import("node:http").ServerResponse) {
  if (!body || typeof body.sound !== "string" || !Number.isFinite(Number(body.volume))) {
    send(res, 400, { ok: false, error: "bad-request" });
    return;
  }
  const file = resolveSound(body.sound);
  if (!file) {
    send(res, 404, { ok: false, error: "unknown-sound" });
    return;
  }
  const volume = Number(body.volume);
  if (volume <= 0) {
    send(res, 200, { ok: true, skipped: "muted" });
    return;
  }
  const result = await afplay(file, Math.min(1, volume / 100));
  if (result.error !== undefined && result.code === null) {
    send(res, 500, { ok: false, error: "spawn-failed", detail: result.error.slice(0, 200) });
    return;
  }
  if (result.code !== 0) {
    // afplay 播不了的格式（如 ogg）→ 422，面板回退 Web Audio
    send(res, 422, {
      ok: false,
      error: "playback-failed",
      detail: (result.error ?? result.stderr).slice(0, 200),
    });
    return;
  }
  send(res, 200, { ok: true });
}

async function handleAudio(body: Json, res: import("node:http").ServerResponse) {
  if (
    !body ||
    typeof body.name !== "string" ||
    body.name.length < 1 ||
    body.name.length > 64 ||
    typeof body.data !== "string" ||
    !isInt(body.index) ||
    !isInt(body.total) ||
    body.total < 1 ||
    body.total > 400 ||
    body.index < 0 ||
    body.index >= body.total
  ) {
    send(res, 400, { ok: false, error: "bad-request" });
    return;
  }
  const name = body.name;
  const mime = typeof body.mime === "string" && body.mime.length <= 64 ? body.mime : "";
  let rec = assembling.get(name);
  if (!rec || rec.total !== body.total) {
    rec = { mime, total: body.total, parts: new Array(body.total).fill(null) };
    assembling.set(name, rec);
  }
  rec.parts[body.index] = body.data;

  if (rec.parts.some((p) => p === null)) {
    send(res, 200, { ok: true, ready: false });
    return;
  }
  const buf = Buffer.concat(rec.parts.map((p) => Buffer.from(p as string, "base64")));
  const file = join(TMP, `up-${seq++}${extFor(rec.mime, buf)}`);
  writeFileSync(file, buf);
  uploadedFiles.set(name, file);
  assembling.delete(name);
  send(res, 200, { ok: true, ready: true, bytes: buf.length });
}

const server = createServer((req, res) => {
  void (async () => {
    if (!bearerOk(req.headers.authorization)) {
      send(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /health") {
      send(res, 200, { ok: true, service: "task-chime" });
      return;
    }
    if (route === "POST /chime") {
      const body = await readJson(req);
      if (body === TOO_LARGE) {
        send(res, 413, { ok: false, error: "body-too-large" });
        return;
      }
      await handleChime(body, res);
      return;
    }
    if (route === "POST /audio") {
      const body = await readJson(req);
      if (body === TOO_LARGE) {
        send(res, 413, { ok: false, error: "body-too-large" });
        return;
      }
      await handleAudio(body, res);
      return;
    }
    send(res, 404, { ok: false, error: "not-found" });
  })().catch((err) => {
    try {
      send(res, 500, { ok: false, error: String(err).slice(0, 200) });
    } catch {
      /* 应答已发出 */
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[chime-service] listening on 127.0.0.1:${PORT}`);
});
server.on("error", (err) => {
  console.error("[chime-service] listen failed:", err);
  process.exit(1);
});
