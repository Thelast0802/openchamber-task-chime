# OpenChamber Task Chime 🔔

A zero-permission OpenChamber extension that plays a chime when your agent finishes a task — so you can stop watching the progress bar.

任务完成提示音 —— OpenChamber 桌面端/网页端扩展，智能体跑完“叮”一声提醒你。

**中文说明在下方（[中文](#中文)）。**

## Features

- 🔔 **Chime on completion** — plays a sound when a session completes or fails, with a **deduplicated lifecycle listener**: switching between idle sessions in history does *not* trigger false chimes (only sessions whose `started` phase was actually observed can chime).
- 🎵 **8 built-in original sounds** — Bell, Marimba, Crystal, Chord, Ping, Whistle, Drop, Sparkle. All synthesized from scratch (additive synthesis / sweeps / transients) by [`scripts/make-sounds.mjs`](scripts/make-sounds.mjs) — no third-party or Apple-copyrighted audio.
- 📥 **Import your own sounds** — drop in any audio file (mp3 / wav / m4a / aac / ogg / flac, ≤ 4 MB, ≤ 15 s). Decoded and validated up front, stored chunked across extension storage keys, with rollback on partial writes.
- 🔊 **Volume slider** — live gain control, applied through a master `GainNode`, persisted across restarts.
- ⚙️ **Failure-only mode** — optional “only chime on failure”.
- 🧰 **No permissions required** — the extension declares no capabilities; it only listens to session lifecycle events and stores its own settings.

## Install

Open **Settings → Extensions** in OpenChamber and paste one of the following into the *Folder, ZIP, or URL* field:

```
https://github.com/<you>/openchamber-task-chime.git
```

Then choose **Add**. Git-URL installs check for updates automatically (or use **Check for updates**), and you can pin a version with `#v1.0.0` on the end of the URL.

> Requires OpenChamber **≥ 1.24.0**. Web & desktop only (VS Code / mobile don't load extensions yet).

## Usage

1. Open the **Task Chime** panel from the left rail once (the panel hosts the audio engine).
2. Pick a sound (switching previews it), drag the volume slider, import your own if you like.
3. Send a task to your agent — you'll hear the chime when it completes.

### Known limitation

Sound is played by the panel's Web Audio engine, so the panel must have been opened at least once in the current app session. A future `service`-based build (host-side `afplay`) would chime even when the panel is closed.

## Build from source

```bash
npm install
node build.mjs          # bundles src/main.ts → panel/main.js
```

Regenerate the built-in sounds (or embed your local macOS system sounds **for personal use only**):

```bash
node scripts/make-sounds.mjs          # original synthesized sounds (safe to publish)
node scripts/embed-system-sounds.mjs  # ⚠️ Apple system sounds — do NOT commit/publish
node build.mjs
```

`panel/main.js` is a committed build artifact — OpenChamber installs extensions by running the packaged scripts directly, no build step on install.

### Architecture

```
package.json            manifest (panel id, icon, engines)
panel/index.html        UI
panel/main.js           ← build output, committed (IIFE bundle)
src/main.ts             source: Web Audio engine, lifecycle dedupe, import/chunking
src/sounds.ts           ← generated base64 sound bank
scripts/make-sounds.mjs sound synthesizer (source of truth for src/sounds.ts)
```

Key implementation notes:

- **Lifecycle dedupe**: `onSessionLifecycle` replays the current phase of a session when you open it (the host maps `busy/retry → started`, `idle → completed`). The extension keeps a `running` set and only chimes for `completed`/`failure` events of sessions it has seen `started` for.
- **Storage chunking**: extension storage caps values at 65,536 bytes, so imported sounds are base64-split into 60,000-char chunks under `chime:snd:<name>:<i>` with a manifest at `chime:library`.
- **MIME constraint**: the panel asset router only serves `html/js/css/svg/json/png`, which is why audio ships as base64 inside the bundle rather than as files.

## License

[MIT](LICENSE)

---

## 中文

**任务完成提示音**：OpenChamber 扩展，智能体任务完成/失败时播放提示音。

### 安装

打开 OpenChamber **设置 → 扩展**，在输入框粘贴本仓库的 git URL，点「添加」即可。git URL 安装支持自动更新，可用 `#v1.0.0` 锁定版本。要求 OpenChamber ≥ 1.24.0（桌面端 / 网页端）。

### 功能

- 完成/失败提示音，**只对真正跑过的任务响**——切换历史会话不会误响
- 内置 **8 款原创音效**（全部由加法合成本地生成，无版权风险）
- **导入自己的音频**（mp3/wav/m4a/aac/ogg/flac，≤4MB、≤15s），自动校验解码
- **音量滑杆**实时生效、持久化
- 可选「只在失败时响」
- **零权限**：不申请任何 capabilities

### 已知限制

声音由面板内 Web Audio 播放，当前会话内需至少打开过一次面板。后续计划提供 `service` 版本（宿主侧 `afplay`），面板关闭也能响。

### 从源码构建

```bash
npm install && node build.mjs
```

音效生成见上文 Build from source；`scripts/embed-system-sounds.mjs` 生成的 Apple 系统音效产物**仅供个人使用，请勿公开提交**。

## License

MIT
