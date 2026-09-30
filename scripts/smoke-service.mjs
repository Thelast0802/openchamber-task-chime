// service/main.js 冒烟测试：鉴权、/health、/chime、/audio 上传、错误路径
import { spawn } from "node:child_process";

const PORT = 47831;
const TOKEN = "test-token-abc";

const child = spawn(process.execPath, ["service/main.js"], {
  env: { ...process.env, OPENCHAMBER_SERVICE_PORT: String(PORT), OPENCHAMBER_SERVICE_TOKEN: TOKEN },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stdout.write("[svc] " + d));
child.stderr.on("data", (d) => process.stderr.write("[svc err] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${PORT}`;
const H = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log("  ✓ " + name);
  else {
    failed++;
    console.log("  ✗ " + name + (detail ? " — " + detail : ""));
  }
}

async function main() {
  await sleep(600);

  // 1. 无鉴权 / 错鉴权
  let r = await fetch(`${base}/health`);
  check("health 无鉴权 → 401", r.status === 401, `got ${r.status}`);
  r = await fetch(`${base}/health`, { headers: { Authorization: "Bearer wrong" } });
  check("health 错 token → 401", r.status === 401, `got ${r.status}`);

  // 2. 就绪
  r = await fetch(`${base}/health`, { headers: H });
  const health = await r.json();
  check("health 正确鉴权 → 200", r.status === 200 && health.ok === true, JSON.stringify(health));

  // 3. chime 参数校验
  r = await fetch(`${base}/chime`, { method: "POST", headers: H, body: JSON.stringify({ sound: "x" }) });
  check("chime 缺 volume → 400", r.status === 400, `got ${r.status}`);
  r = await fetch(`${base}/chime`, { method: "POST", headers: H, body: "not json" });
  check("chime 坏 JSON → 400", r.status === 400, `got ${r.status}`);

  // 4. 未知音效 → 404
  r = await fetch(`${base}/chime`, { method: "POST", headers: H, body: JSON.stringify({ sound: "builtin:Nope", volume: 80 }) });
  check("chime 未知内置音 → 404", r.status === 404, `got ${r.status}`);
  r = await fetch(`${base}/chime`, { method: "POST", headers: H, body: JSON.stringify({ sound: "imp:ghost", volume: 80 }) });
  check("chime 未上传导入音 → 404", r.status === 404, `got ${r.status}`);

  // 5. 静音跳过（volume 0，不 spawn afplay）
  r = await fetch(`${base}/chime`, { method: "POST", headers: H, body: JSON.stringify({ sound: "builtin:Bell", volume: 0 }) });
  const muted = await r.json();
  check("chime volume=0 → 200 muted", r.status === 200 && muted.skipped === "muted", JSON.stringify(muted));

  // 6. 真实播放：内置音效 volume=8（约 8%，很轻的一声）
  const t0 = Date.now();
  r = await fetch(`${base}/chime`, { method: "POST", headers: H, body: JSON.stringify({ sound: "builtin:Bell", volume: 8 }) });
  const played = await r.json();
  check("chime 内置音真实播放 → 200 ok", r.status === 200 && played.ok === true, JSON.stringify(played));
  console.log(`    （播放耗时 ${Date.now() - t0}ms）`);

  // 7. 导入音上传（4 分块）→ 播放
  const b64 = Buffer.from("dummy").toString("base64");
  const chunk = b64.slice(0, 3);
  const parts = [b64.slice(0, 3), b64.slice(3)];
  for (let i = 0; i < parts.length; i++) {
    r = await fetch(`${base}/audio`, { method: "POST", headers: H, body: JSON.stringify({ name: "my-snd", mime: "audio/wav", index: i, total: parts.length, data: parts[i] }) });
    if (i === 0) check("audio 上传首块 → 200 ready:false", r.status === 200, `got ${r.status}`);
  }
  const up = await r.json();
  check("audio 上传尾块 → 200 ready:true", up.ready === true, JSON.stringify(up));
  r = await fetch(`${base}/chime`, { method: "POST", headers: H, body: JSON.stringify({ sound: "imp:my-snd", volume: 0 }) });
  check("chime 已上传导入音 → 200", r.status === 200, `got ${r.status}`);

  // 8. 分块参数校验
  r = await fetch(`${base}/audio`, { method: "POST", headers: H, body: JSON.stringify({ name: "", mime: "", index: 0, total: 0, data: "" }) });
  check("audio 非法参数 → 400", r.status === 400, `got ${r.status}`);

  // 9. 未知路由
  r = await fetch(`${base}/nope`, { headers: H });
  check("未知路由 → 404", r.status === 404, `got ${r.status}`);

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  child.kill("SIGTERM");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  child.kill("SIGKILL");
  process.exit(1);
});
