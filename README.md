# OpenChamber Task Chime 🔔

A minimal-permission OpenChamber extension that plays a chime when your agent finishes a task — so you can stop watching the progress bar. Works with the panel **closed**: playback goes through a host-side local service using macOS `afplay`.

任务完成提示音 —— OpenChamber 桌面端/网页端扩展，智能体跑完“叮”一声提醒你。面板关闭也照响（宿主侧 `afplay` 系统播放）。

**中文说明在下方（[中文](#中文)）。**

## Features

- 🔔 **Chime on completion** — plays a sound when a session completes or fails, with a **deduplicated lifecycle listener**: switching between idle sessions in history does *not* trigger false chimes (only sessions whose `started` phase was actually observed can chime).
- 🔊 **Chimes with the panel closed** — completion events are handed to a bundled **local service** (`contributes.service`) that plays through macOS `afplay` at the system level. If the service is unavailable (not yet approved, failed to start, or `afplay` can't play the format), it **falls back to the panel's Web Audio engine** automatically.
- 🎵 **8 built-in original sounds** — Bell, Marimba, Crystal, Chord, Ping, Whistle, Drop, Sparkle. All synthesized from scratch (additive synthesis / sweeps / transients) by [`scripts/make-sounds.mjs`](scripts/make-sounds.mjs) — no third-party or Apple-copyrighted audio. Built-ins ship inside the service bundle too, so they never cross the request-size limit.
- 📥 **Import your own sounds** — drop in any audio file (mp3 / wav / m4a / aac / ogg / flac, ≤ 4 MB, ≤ 15 s). Decoded and validated up front, stored chunked across extension storage keys, with rollback on partial writes. For system playback they are uploaded to the service once (chunked, 64 KB request cap) and cached there.
- 🔊 **Volume slider** — live gain control through a master `GainNode`, persisted; the same value drives `afplay -v`.
- ⚙️ **Failure-only mode** — optional “only chime on failure”.
- 🧰 **One capability** — the package requests `service` (declaring `exec: ["afplay"]`) so the host may spawn the playback helper. No network, filesystem, or model capabilities.

## Install

Open **Settings → Extensions** in OpenChamber and paste one of the following into the *Folder, ZIP, or URL* field:

```
https://github.com/<you>/openchamber-task-chime.git
```

Then choose **Add**. Git-URL installs check for updates automatically (or use **Check for updates**), and you can pin a version with `#v1.1.0` on the end of the URL.

> Requires OpenChamber **≥ 1.24.0**. Web & desktop only (VS Code / mobile don't load extensions yet).

### Approving the local service (v1.1.0+)

Declaring a service adds a **`service`** capability to what the extension requests. Approve it once in **Settings → Extensions** (the card shows the pending request; the dialog lists `afplay` as the declared command). **After updating from ≤ 1.0.0 you must re-approve** — until then the extension still works, but plays only through the panel (first `serviceRequest` is refused with `NO_SERVICE` and falls back). The panel's status line shows which path is active:

| Status line | Meaning |
|---|---|
| `系统播放就绪：面板关闭也会响` | Service approved & running — system-level `afplay` playback. |
| `系统播放未授权…` | Not approved (yet) — panel Web Audio only; approve to enable. |
| `系统服务异常，回退面板播放` | Service failed to start — panel Web Audio only. |

## Usage

1. Open the **Task Chime** panel from the left rail once (the panel hosts the lifecycle listener; the first open also warms up the service so the first chime doesn't pay the spawn cost).
2. Pick a sound (switching previews it), drag the volume slider, import your own if you like.
3. Send a task to your agent — you'll hear the chime when it completes, **even if you close the panel afterwards**.

### Known limitations

- The **lifecycle listener lives in the panel page**, so the panel must have been opened at least once in the current app session (closing it afterwards is fine — the page stays mounted). This is a platform constraint: no other extension surface receives session events.
- Imported **ogg** files can't be played by `afplay` (CoreAudio has no Vorbis decoder); the service answers "playback-failed" and the panel falls back to Web Audio. Convert to mp3/m4a/wav for reliable system playback.
- On non-macOS hosts there is no `afplay`; the same fallback applies.

## Build from source

```bash
npm install
node build.mjs          # panel/main.js (browser IIFE) + service/main.js (Node CJS)
```

Regenerate the built-in sounds (or embed your local macOS system sounds **for personal use only**):

```bash
node scripts/make-sounds.mjs          # original synthesized sounds (safe to publish)
node scripts/embed-system-sounds.mjs  # ⚠️ Apple system sounds — do NOT commit/publish
node build.mjs
```

Smoke-test the service standalone (binds a test port, plays one quiet chime):

```bash
node scripts/smoke-service.mjs
```

`panel/main.js` and `service/main.js` are committed build artifacts — OpenChamber installs extensions by running the packaged scripts directly, no build step on install.

### Architecture

```
package.json            manifest (panel id, icon, engines, contributes.service)
panel/index.html        UI
panel/main.js           ← build output, committed (IIFE bundle, browser)
service/main.js         ← build output, committed (CJS bundle, Node — host-spawned)
src/main.ts             source: lifecycle dedupe, service-first playback + Web Audio fallback,
                        import/chunking (storage + service upload)
src/service.ts          source: loopback HTTP service (Bearer auth, /health, /chime, /audio) → afplay
src/sounds.ts           ← generated base64 sound bank (bundled into both entries)
scripts/make-sounds.mjs sound synthesizer (source of truth for src/sounds.ts)
scripts/smoke-service.mjs standalone service test
```

```
panel ──serviceRequest──▶ host ──HTTP 127.0.0.1:port──▶ service ──▶ afplay
  │ (NO_SERVICE / failure / unsupported format)
  └──▶ Web Audio fallback (panel engine)
```

Key implementation notes:

- **Lifecycle dedupe**: `onSessionLifecycle` replays the current phase of a session when you open it (the host maps `busy/retry → started`, `idle → completed`). The extension keeps a `running` set and only chimes for `completed`/`failure` events of sessions it has seen `started` for.
- **Playback ladder**: `serviceRequest POST /chime` → on `NO_SERVICE`/`DISABLED` the panel marks the service *denied* (single hint, no hammering); on `SERVICE_FAILED` it marks *broken* (retried only when you press 试听); on HTTP 404 after a service restart it re-uploads an imported sound once; on any other failure it plays via Web Audio (`playSound` → synthesized ding as last resort).
- **Service contract**: bound to the host-allocated `127.0.0.1` port only; every request (including `/health`) needs `Authorization: Bearer <OPENCHAMBER_SERVICE_TOKEN>`; the panel warms it with `GET /health` on ready so spawn (Electron-as-Node, few hundred ms) happens before the first task finishes. `afplay` exit is awaited (≤ 16 s cap) so format failures surface as HTTP 422 and trigger the fallback.
- **Size limits**: `serviceRequest` bodies cap at 64,000 chars — built-in sounds live in the service bundle, imported sounds are uploaded in 63,500-char chunks (`POST /audio`) once and cached (a 404 tells the panel the service restarted and to re-upload). Extension storage caps values at 65,536 bytes, so imports are also stored chunked (`chime:snd:<name>:<i>`, manifest `chime:library`).
- **MIME constraint**: the panel asset router only serves `html/js/css/svg/json/png`, which is why audio ships as base64 inside the bundles rather than as files.

## License

[MIT](LICENSE)

---

## 中文

**任务完成提示音**：OpenChamber 扩展，智能体任务完成/失败时播放提示音，**面板关闭也照响**。

### 安装

打开 OpenChamber **设置 → 扩展**，在输入框粘贴本仓库的 git URL，点「添加」即可。git URL 安装支持自动更新，可用 `#v1.1.0` 锁定版本。要求 OpenChamber ≥ 1.24.0（桌面端 / 网页端）。

### 允许本地服务（v1.1.0 起）

1.1.0 起扩展声明了 `contributes.service`（`exec: ["afplay"]`），请求列表新增 **`service`** 能力，需要在 **设置 → 扩展** 里点一次允许（审批卡片会列出 `afplay`）。**从 ≤1.0.0 更新上来的必须重新审批**；未审批也能用——只是走面板内播放（`serviceRequest` 返回 `NO_SERVICE` 后自动回退）。面板状态行会显示当前路径：

| 状态行 | 含义 |
|---|---|
| `系统播放就绪：面板关闭也会响` | 服务已批准并运行，`afplay` 系统级播放。 |
| `系统播放未授权…` | 尚未批准，仅面板内播放；批准后生效。 |
| `系统服务异常，回退面板播放` | 服务启动失败，回退面板播放。 |

### 功能

- 完成/失败提示音，**只对真正跑过的任务响**——切换历史会话不会误响
- **面板关闭也响**：完成事件交给随包的本地 service，用 macOS `afplay` 系统级播放；服务不可用时自动回退面板 Web Audio
- 内置 **8 款原创音效**（全部由加法合成本地生成，无版权风险），音效同时打进服务包，不受请求体大小限制
- **导入自己的音频**（mp3/wav/m4a/aac/ogg/flac，≤4MB、≤15s），自动校验解码；系统播放时分块上传给服务缓存
- **音量滑杆**实时生效、持久化（同一数值同时作用于 `afplay -v`）
- 可选「只在失败时响」

### 已知限制

- **生命周期监听在面板页面里**，因此本次会话内需至少打开过一次面板（关掉没关系，页面会保持挂载）。这是平台约束：其它扩展表面收不到会话事件。
- 导入的 **ogg** 无法被 `afplay` 播放（CoreAudio 无 Vorbis 解码），会回退面板播放；想要稳定系统播放请转成 mp3/m4a/wav。
- 非 macOS 宿主没有 `afplay`，同样回退面板播放。

### 从源码构建

```bash
npm install && node build.mjs     # 产出 panel/main.js + service/main.js
node scripts/smoke-service.mjs    # service 独立冒烟测试（会轻声播一记）
```

音效生成见上文 Build from source；`scripts/embed-system-sounds.mjs` 生成的 Apple 系统音效产物**仅供个人使用，请勿公开提交**。

## License

MIT
