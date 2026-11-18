import { execSync } from 'node:child_process'
import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform !== 'darwin') {
  console.log(`[build-native] 当前平台 ${process.platform},跳过 Swift 助手编译(Windows 原生实现预留中)`)
  process.exit(0)
}

const outDir = join(root, 'resources', 'bin')
mkdirSync(outDir, { recursive: true })

const src = join(root, 'native', 'mac-helper', 'main.swift')
// dmg 要分发给其他 Mac:必须出 universal 双架构(arm64 + x86_64),单架构助手在异构机器上无法执行
const slices = [
  { arch: 'arm64', target: 'arm64-apple-macos14.0' },
  { arch: 'x86_64', target: 'x86_64-apple-macos14.0' }
]
const slicePaths = slices.map(({ arch, target }) => join(tmpdir(), `mac-helper.${process.pid}.${arch}`))

try {
  slices.forEach(({ arch, target }, i) => {
    execSync(`swiftc -O -target ${target} ${src} -o ${slicePaths[i]}`, { stdio: 'inherit', cwd: root })
  })
  execSync(`lipo -create ${slicePaths.join(' ')} -output ${join(outDir, 'mac-helper')}`, {
    stdio: 'inherit',
    cwd: root
  })
  console.log('[build-native] 已编译 resources/bin/mac-helper (universal: arm64 + x86_64)')
} catch (err) {
  if (existsSync(join(outDir, 'mac-helper'))) {
    console.warn('[build-native] universal 编译失败,但存在旧的编译产物,继续使用旧产物:', err)
  } else {
    console.error('[build-native] swiftc 编译失败。请安装 Xcode 或 Command Line Tools:xcode-select --install')
    process.exitCode = 1
  }
} finally {
  for (const p of slicePaths) rmSync(p, { force: true })
}
