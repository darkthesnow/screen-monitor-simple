import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { groupByApp } from '@shared/types'
import type { PlatformAdapter } from '../platform/types'
import type { ConfigService } from './config'
import type { MonitorService, RoundSummary } from './monitor'
import { listCaptures, readAllowedImage } from '../ipc'

/**
 * 本地 HTTP API:让外部程序(curl/Python/脚本等)主动调用截图与查询能力。
 *
 * 安全边界:
 * - 只绑定 127.0.0.1,本机之外不可达;无鉴权(本机信任环境)
 * - /image 的 path 经 safeImagePath 校验,只放行输出目录内的图片
 * - 请求体上限 64KB,JSON only
 */

const BODY_LIMIT = 64 * 1024

interface ApiServerDeps {
  adapter: PlatformAdapter
  cfg: ConfigService
  monitor: MonitorService
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...corsHeaders()
  })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 解析 JSON body;空 body 返回空对象 */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  if (raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw.toString('utf-8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

export class ApiServer {
  private server: Server | null = null

  constructor(private deps: ApiServerDeps) {}

  start(port: number): void {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        sendJson(res, 500, { ok: false, message: err instanceof Error ? err.message : String(err) })
      })
    })
    // 端口被占用等服务错误只记日志,不影响 GUI 主功能
    this.server.on('error', (err) => {
      console.error(`[api] HTTP 服务启动失败(外部接口不可用): ${err instanceof Error ? err.message : err}`)
    })
    this.server.listen(port, '127.0.0.1', () => {
      console.log(`[api] 外部接口已启动: http://127.0.0.1:${port} (仅本机可访问)`)
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders())
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const method = req.method ?? 'GET'
    const path = url.pathname.replace(/\/+$/, '') || '/'

    const { adapter, cfg, monitor } = this.deps

    // ---------- 健康检查 ----------
    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true, app: 'screen-monitor-simple', api: 'v1' })
      return
    }

    // ---------- 窗口枚举(外部选择 app 用) ----------
    if (method === 'GET' && path === '/windows') {
      const windows = await adapter.listWindows()
      sendJson(res, 200, { ok: true, windows, groups: groupByApp(windows) })
      return
    }

    // ---------- 监控状态/配置 ----------
    if (method === 'GET' && path === '/status') {
      sendJson(res, 200, { ok: true, running: monitor.running, config: cfg.monitor })
      return
    }

    if (method === 'POST' && path === '/config') {
      const body = await readJson(req)
      const config = cfg.updateMonitor({
        appKey: typeof body.appKey === 'string' ? body.appKey : undefined,
        ownerName: typeof body.ownerName === 'string' ? body.ownerName : undefined,
        intervalSec: typeof body.intervalSec === 'number' ? body.intervalSec : undefined,
        outputDir: typeof body.outputDir === 'string' ? body.outputDir : undefined
      })
      monitor.restartIfRunning()
      sendJson(res, 200, { ok: true, config })
      return
    }

    // ---------- 启停定时监控 ----------
    if (method === 'POST' && path === '/start') {
      sendJson(res, 200, { ok: true, result: monitor.start() })
      return
    }
    if (method === 'POST' && path === '/stop') {
      monitor.stop()
      sendJson(res, 200, { ok: true })
      return
    }

    // ---------- 主动截图(核心外部接口) ----------
    if ((method === 'GET' || method === 'POST') && path === '/capture') {
      // 目标应用:查询参数 app / 请求体 appKey 均可;都缺省 = 当前配置的应用
      let appKey = url.searchParams.get('app') ?? url.searchParams.get('appKey') ?? ''
      let ownerName = url.searchParams.get('owner') ?? ''
      if (method === 'POST') {
        const body = await readJson(req)
        if (typeof body.appKey === 'string' && body.appKey.trim()) appKey = body.appKey
        if (typeof body.app === 'string' && body.app.trim()) appKey = body.app
        if (typeof body.ownerName === 'string' && body.ownerName.trim()) ownerName = body.ownerName
      }
      let summary: RoundSummary
      if (appKey) {
        summary = await monitor.captureApp(appKey, ownerName)
      } else {
        summary = await monitor.captureApp(cfg.monitor.appKey, cfg.monitor.ownerName)
      }
      sendJson(res, summary.ok ? 200 : 409, { ...summary, outputDir: cfg.outputDir })
      return
    }

    // ---------- 截图列表 ----------
    if (method === 'GET' && path === '/shots') {
      const limitRaw = Number(url.searchParams.get('limit') ?? 50)
      const limit = Number.isFinite(limitRaw) ? Math.min(300, Math.max(1, Math.floor(limitRaw))) : 50
      const all = listCaptures(cfg.outputDir)
      sendJson(res, 200, { ok: true, total: all.length, files: all.slice(0, limit) })
      return
    }

    // ---------- 读取单张图片内容 ----------
    if (method === 'GET' && path === '/image') {
      const p = url.searchParams.get('path') ?? ''
      const result = await readAllowedImage(p, cfg.outputDir)
      if (!result) {
        sendJson(res, 403, { ok: false, message: '路径无效或不在输出目录内' })
        return
      }
      res.writeHead(200, { 'content-type': result.mime, ...corsHeaders() })
      res.end(new Uint8Array(result.data))
      return
    }

    sendJson(res, 404, { ok: false, message: `未知接口: ${method} ${path}` })
  }
}
