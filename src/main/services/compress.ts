import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import { sanitizeFilePart } from '@shared/types'

/** 压缩参数:等比缩至 maxWidth 内,PNG/JPEG 双编码取更小者(文字界面 PNG 通常更小且无损) */
const MAX_WIDTH = 1600
const JPEG_QUALITY = 85

export interface SaveResult {
  path: string
  bytes: number
  format: 'png' | 'jpg'
  width: number
  height: number
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * 原始 PNG → 等比缩放 → 双编码取小落盘。
 * 文件名:应用名_窗口标题_yyyyMMdd-HHmmss[.jpg|.png];
 * sameTitleIndex > 0 时(同应用同轮多窗口同名)追加 -N 序号防覆盖。
 */
export function compressAndSave(
  srcPngPath: string,
  destDir: string,
  ownerName: string,
  title: string,
  now = new Date(),
  sameTitleIndex = 0
): SaveResult {
  let img = nativeImage.createFromPath(srcPngPath)
  const { width, height } = img.getSize()
  if (width === 0 || height === 0) {
    throw new Error(`截图读取失败(空图像): ${srcPngPath}`)
  }
  if (width > MAX_WIDTH) {
    img = img.resize({ width: MAX_WIDTH, quality: 'good' })
  }

  const png = img.toPNG()
  const jpg = img.toJPEG(JPEG_QUALITY)
  const useJpeg = jpg.byteLength < png.byteLength

  mkdirSync(destDir, { recursive: true })
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const owner = sanitizeFilePart(ownerName) || 'app'
  const titlePart = sanitizeFilePart(title)
  const suffix = sameTitleIndex > 0 ? `-${sameTitleIndex + 1}` : ''
  const base = (titlePart ? `${owner}_${titlePart}_${ts}` : `${owner}_${ts}`).replace(/\s+/g, '_')
  const outPath = join(destDir, `${base}${suffix}.${useJpeg ? 'jpg' : 'png'}`)

  writeFileSync(outPath, useJpeg ? jpg : png)
  const finalSize = img.getSize()
  return {
    path: outPath,
    bytes: (useJpeg ? jpg : png).byteLength,
    format: useJpeg ? 'jpg' : 'png',
    width: finalSize.width,
    height: finalSize.height
  }
}
