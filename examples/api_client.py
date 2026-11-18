"""screen-monitor-simple 外部通信示例(Python 标准库,零依赖)"""
import json
import urllib.parse
import urllib.request

BASE = 'http://127.0.0.1:8765'

def call(method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else b''
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

# 1) 列出应用,找目标 appKey
groups = call('GET', '/windows')['groups']
target = next(g for g in groups if 'TradingView' in g['ownerName'])
print('目标应用:', target['key'], f"({len(target['windows'])} 窗口)")

# 2) 主动截一轮(全部窗口),拿到落盘文件路径
r = call('POST', '/capture', {'appKey': target['key'], 'ownerName': target['ownerName']})
print('截图结果:', r['message'])
for f in r['files']:
    print('  文件:', f['path'], f['bytes'], 'B')

# 3) 通过 HTTP 直接取图片二进制(不读文件系统)
path = urllib.parse.quote(r['files'][0]['path'])
with urllib.request.urlopen(f'{BASE}/image?path={path}', timeout=30) as resp:
    img = resp.read()
print('取回图片:', len(img), '字节, JPEG 头 =', img[:3] == b'\xff\xd8\xff')

# 4) 查询与控制
print('监控状态:', call('GET', '/status')['running'])
print('最近截图数:', call('GET', '/shots?limit=5')['total'])
