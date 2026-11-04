# 已部署：Cloudflare Workers + Durable Objects

线上地址：<https://pool-lan.wjp888.dpdns.org/>
健康检查：`{"ok":true,"protocol":2,"backend":"cloudflare-do"}`

## 为什么最终是 Cloudflare 而不是 Vercel

Vercel 必须注册账号才能部署，而当前没有可用账号。Cloudflare 这边账号已登录、域名 NS 本来就在同一账号下，不需要新注册任何东西。

更关键的是架构更合适：Vercel 函数是无状态的，两个玩家可能落到不同实例、互相看不见，官方文档明确写了这个限制。Cloudflare 用 Durable Object 按房间号路由，**同一个房间必然落在同一个实例**，从根上消除了这个问题。

## 部署命令

```powershell
$w = 'C:\Users\pc\Documents\ChatGPT\金融\ego\billiards-deploy-20261104\cli-tmp\node_modules\.bin\wrangler.cmd'
$base = 'C:\Users\pc\Documents\ChatGPT\金融\ego\billiards-deploy-20261104\pool-lan'
$env:NO_PROXY = '*'
& $w deploy --config "$base\wrangler.toml"
```

本地联调：`& $w dev --config "$base\wrangler.toml" --port 8787 --local`

## 结构

- `worker/index.mjs` — Worker 入口（静态资源 + WebSocket 路由）和 `RoomDO` 类
- `lib/room.mjs` / `lib/protocol.mjs` — 游戏逻辑，Vercel 版和 Cloudflare 版共用
- `wrangler.toml` — 绑定 `ASSETS`、`ROOMS`，自定义域名 `pool-lan.wjp888.dpdns.org`

## 免费额度

每天 10 万请求、1.3 万 GB-s。WebSocket 空闲连接可休眠不计时，两人对战远用不完。

## 实测（2026-11-04）

| 指标 | Render（旧） | Cloudflare（新） |
|---|---|---|
| WebSocket RTT 中位数 | 378 ms | **267 ms** |
| 前端延迟显示 | — | 178 ms |

双端联机：座位 0/1 正确、开场球位逐字节一致、出杆后 `sameSig=true`、轮次一致且始终有一方能出杆。

## 修的 bug

非出杆方本地结算时又推进了一次 `turn`，覆盖了服务端广播的权威值，表现是**双方都出不了杆**。单测测不到，两个真实标签连打才暴露。修复方式：记住结算前的 `turn`，非出杆方以服务端值为准。

## 绑定新域名时注意

Worker 的 custom domain 要求该 hostname 上没有外部管理的 DNS 记录。切换前必须先删掉旧的 CNAME，否则报错 `100117`。