# 部署到 Vercel（待执行）

代码状态：分支 `codex/vercel`，提交 `ae8f82c`，已推送。
`main` 未改动，现有 Render 站点不受影响。

## 阻塞点

`vercel login` 需要真人点 OAuth 授权（Google 账号）。CLI 三次尝试均为 `Logged out`。

## 授权后执行

```powershell
$v = 'C:\Users\pc\Documents\ChatGPT\金融\ego\billiards-deploy-20261104\cli-tmp\node_modules\.bin\vercel.cmd'
$base = 'C:\Users\pc\Documents\ChatGPT\金融\ego\billiards-deploy-20261104\pool-lan'

& $v login                 # 打印设备码，浏览器里点确认
& $v whoami                # 必须显示账号名

& $v link --yes --cwd $base
& $v deploy --prod --yes --cwd $base
```

## 绑定域名

`pool-lan.wjp888.dpdns.org` 现在是 CNAME 到 `pool-lan.onrender.com`（DigitalPlat/Cloudflare 管理）。
部署后改成指向 Vercel：

- 若用 CNAME：目标改成 `cname.vercel-dns.com`
- 或 A 记录：`76.76.21.21`

然后在 Vercel 项目 Settings → Domains 添加该域名。

## 部署后必测

1. `curl https://<域名>/health` → `{"ok":true,"protocol":2,"rooms":N}`
2. 两个真实浏览器标签进同一 `?room=` 码 → 座位分别为 0 和 1、16 球坐标一致
3. 谁都没有出杆时两边都停在 aim 阶段，出不出现「对手未出现」提示
4. 实测 WS RTT 对比 397ms 基线

## 已知风险

Vercel 新连接可能落到不同实例，房间状态在内存里。客户端已加 10s 检测提示。
若实测不通，改用 Upstash Redis（免费 500K 命令/月）做共享房间表，不需要付费。

## 已完成并验证

- 106 项测试全绿（physics 13 / eightball 51 / net.det 13 / server.int 12 / place.net 17）
- 两个真实浏览器标签：座位分离、开场球位逐字节一致、出杆后 `sameSig=true`、轮次正确切换
- token 改为每标签独立随机（修同名抢座位）
- 物理按真实时间补算固定步长（修后台标签节流导致的分叉）
- 函数区域固定 `hkg1`（香港），Hobby 单区域