# screen-monitor-simple(屏幕监控 · 简化版)

参考 `tradingviewMonitor` 制作的简化版窗口监控截图工具:选择应用 → 可调频率定时截取该应用**全部窗口** → 截图按时间索引预览。

```
npm install        # 首次(或直接从参考项目复制 node_modules)
npm run build:native  # 编译 Swift 助手(已在 resources/bin 预编译)
npm run dev        # 开发运行
npm run build && npx electron .  # 正式运行
SMOKE=1 npx electron .           # 无头冒烟:截一张最大窗口后退出
npm run typecheck
```

- 截图输出:`~/Pictures/screenMonitor/`(可在界面更改)
- 配置:`~/Library/Application Support/screen-monitor-simple/config.json`(可改 `apiPort`,默认 8765)
- 需要「屏幕录制」权限(界面横幅可一键跳转授权)

## 本地 HTTP API(外部程序调用)

应用启动后在本机 `127.0.0.1:8765` 开放 HTTP 接口(端口可在 config.json 的 `apiPort` 改),**仅本机可访问**,供 curl / Python / 脚本等外部程序主动调用。

### 1. 主动截图(核心接口)

```bash
# 截当前配置的应用(界面里选的那个),一轮截它全部窗口
curl -X POST http://127.0.0.1:8765/capture

# 临时指定应用(GET,app = bundleId 或应用名,不改变界面配置)
curl "http://127.0.0.1:8765/capture?app=com.tradingview.tradingviewapp.desktop"
curl "http://127.0.0.1:8765/capture?app=Safari"

# POST JSON 方式,ownerName 可选(bundle 变化时的兜底匹配)
curl -X POST http://127.0.0.1:8765/capture \
  -H 'content-type: application/json' \
  -d '{"appKey":"com.apple.Safari","ownerName":"Safari"}'
```

成功返回(200):

```json
{
  "ok": true,
  "saved": 2,
  "failed": 0,
  "totalWindows": 2,
  "message": "本轮 2/2 个窗口已保存 (22:53:44)",
  "outputDir": "/Users/yy/Pictures/screenMonitor",
  "files": [
    { "path": "/Users/yy/Pictures/screenMonitor/Safari_xx_20261118-225344.png",
      "bytes": 183421, "format": "png", "windowId": 501, "title": "xx — Safari" }
  ]
}
```

失败(窗口不可见/上一轮未完成等)返回 409 + `message`。与界面共用串行闸:同一时刻只跑一轮。

### 2. 查询接口

| 接口 | 说明 |
|---|---|
| `GET /health` | 存活检查 `{"ok":true,"app":"screen-monitor-simple","api":"v1"}` |
| `GET /windows` | 当前可见窗口 + 按应用聚合(找 appKey 用) |
| `GET /status` | 监控运行状态 + 当前配置 |
| `GET /shots?limit=50` | 已有截图列表(新→旧,limit ≤ 300) |
| `GET /image?path=<url编码的绝对路径>` | 读单张图片内容(仅限输出目录内) |

### 3. 控制/配置接口

```bash
curl -X POST http://127.0.0.1:8765/start          # 启动定时监控
curl -X POST http://127.0.0.1:8765/stop           # 停止定时监控
curl -X POST http://127.0.0.1:8765/config \
  -H 'content-type: application/json' \
  -d '{"appKey":"com.tradingview.tradingviewapp.desktop","ownerName":"TradingView","intervalSec":15}'
```

`/config` 字段均可选,只传要改的;运行中改间隔立即生效(与界面操作等价)。

### 4. Python 调用示例

```python
import json, urllib.request

BASE = 'http://127.0.0.1:8765'

def capture(app: str | None = None) -> dict:
    url = f'{BASE}/capture' + (f'?app={app}' if app else '')
    req = urllib.request.Request(url, method='POST', data=b'')
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

result = capture('com.tradingview.tradingviewapp.desktop')
for f in result['files']:
    print(f['path'], f['bytes'])          # 直接读文件,或走 /image 取内容
```
