/**
 * Managed OpenCode runtime: locate, download and supervise the isolated
 * `opencode serve` process this plugin talks to.
 *
 * Why a real process is required (verified 2026-09-29): OpenCode Zen answers a
 * direct call to its free models with
 * `FreeTierError: OpenCode's free tier can only be used from within OpenCode`.
 * No header or User-Agent change lifts that gate; only traffic originating from
 * a genuine OpenCode runtime is accepted. So this plugin ships no protocol
 * trick — it runs the vendor's own binary and speaks to it locally.
 *
 * Isolation: a dedicated XDG root under the plugin's data directory, a fresh
 * random server password per start, autoupdate/share/project-config disabled,
 * and only ordinary OS/network variables forwarded. The user's own OpenCode
 * configuration, credentials and sessions are never read or written.
 *
 * @module dsh-opencode-xdbridge/runtime
 */

import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { runtimePackage, VERSION_PATTERN } from './platform.js'
import { Backend, SESSION_PERMISSION_POLICY } from './backend.js'

const exec = promisify(execFile)

/**
 * Permission policy that keeps the free-tier gate open.
 *
 * Load-bearing, not cosmetic. Measured 2026-10-15 against a live
 * `opencode serve`: `{'*':'ask'}` is served, and setting *any* entry to
 * 'deny' produces FreeTierError 403 on the next turn.
 *
 * The value lives in backend.js so that this file and the per-session policy
 * in `complete()` cannot drift apart again — they did once, and the session
 * copy alone was enough to trip the gate.
 */
export const nativePermissions = SESSION_PERMISSION_POLICY

/**
 * Agents installed into the isolated runtime.
 *
 * `buddy-bridge` turns a request into a JSON envelope instead of acting.
 * `buddy-chat` is the text-only twin used for chat-only models.
 */
export const isolatedAgents = {
  'buddy-bridge': {
    mode: 'primary',
    description: 'External client inference only',
    prompt: 'You are the reasoning component of an external assistant. Never invoke native OpenCode tools. Describe external tool calls only in the requested JSON response. The external client owns execution and supplies tool results on the next request.',
    permission: nativePermissions,
  },
  'buddy-chat': {
    mode: 'primary',
    description: 'Text-only external conversation',
    prompt: 'Reply in plain text to the external conversation. No tool use or local actions. Never claim to have executed an action.',
    permission: nativePermissions,
  },
}

/** Environment variables safe to forward into the isolated runtime. */
const FORWARDED_ENV = [
  'PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC',
]

/** Node's XDG roots the runtime should use, all under the plugin data dir. */
const XDG_ROOTS = ['config', 'data', 'cache', 'state']

async function binaryVersion(file) {
  const { stdout } = await exec(file, ['--version'], { timeout: 15000, windowsHide: true })
  return stdout.trim()
}

/**
 * Lowest OpenCode version the Zen free tier still accepts.
 *
 * Below this the credential gate rejects every request with "OpenCode 1.18.0
 * or newer is required", so picking such a binary produces a gateway that
 * looks healthy but fails every call. An old `npm i -g opencode-ai`
 * installation is exactly this trap, which is why candidates are version-checked.
 */
const MIN_FREE_TIER_VERSION = '1.18.0'

/** Numeric semver compare; true when `version` >= `min`. */
function atLeastVersion(version, min) {
  const a = version.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

/**
 * Find a usable OpenCode binary, downloading the official one when needed.
 *
 * Resolution order: an already-managed installation under `<dataDir>/runtime`,
 * then an explicit path, then the user's own `opencode` on PATH (copied in, so
 * the managed runtime is always self-contained), and finally a download from
 * the vendor's npm package.
 *
 * @param {string} dataDir plugin data directory
 * @param {(message: string) => void} [status] progress reporter
 * @param {{candidates?: string[], version?: string}} [options]
 * @returns {Promise<string>} absolute path to the binary
 */
export async function findRuntime(dataDir, status = () => {}, options = {}) {
  const pkg = runtimePackage()
  const root = path.join(dataDir, 'runtime')

  // 1. A version-named directory we installed previously.
  const installed = (await fs.readdir(root, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && VERSION_PATTERN.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }))
  for (const entry of installed) {
    const file = path.join(root, entry.name, pkg.binary)
    try {
      if (!atLeastVersion(entry.name, MIN_FREE_TIER_VERSION)) {
        status(`忽略过旧的 OpenCode ${entry.name}（免费层要求 ≥ ${MIN_FREE_TIER_VERSION}）`)
        continue
      }
      if (await binaryVersion(file) === entry.name) return file
    } catch { /* stale directory: fall through and re-resolve */ }
  }

  // 2. A binary the user already has. Copying it in keeps the managed runtime
  //    independent of wherever the user's own installation lives.
  const candidates = options.candidates ?? [
    process.env.OPENCODE_BINARY_PATH,
    path.join(os.homedir(), '.opencode', 'bin', pkg.binary),
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
  ].filter(Boolean)
  for (const file of candidates) {
    try {
      const found = await binaryVersion(file)
      if (!VERSION_PATTERN.test(found)) continue
      // An outdated install cannot pass the free-tier gate, so selecting it
      // would only produce a gateway that fails every request. Skip and
      // let the download step fetch a current one.
      if (!atLeastVersion(found, MIN_FREE_TIER_VERSION)) {
        status(`跳过过旧的 OpenCode ${found}（免费层要求 ≥ ${MIN_FREE_TIER_VERSION}）`)
        continue
      }
      const target = path.join(root, found, pkg.binary)
      await fs.mkdir(path.dirname(target), { recursive: true })
      status('正在准备独立 OpenCode 运行时')
      await fs.copyFile(file, `${target}.tmp`)
      await fs.chmod(`${target}.tmp`, 0o755)
      await fs.rename(`${target}.tmp`, target)
      return target
    } catch { /* not this candidate */ }
  }

  // 3. Download the official package.
  status('正在获取 OpenCode 官方运行时')
  return downloadRuntime(dataDir, pkg, options, status)
}

/**
 * Download and verify the official OpenCode binary.
 *
 * The tarball is checked against the registry's `sha512` integrity value before
 * extraction, so a corrupted or substituted download cannot be executed.
 */
async function downloadRuntime(dataDir, pkg, options, status) {
  const root = path.join(dataDir, 'runtime')
  const wanted = options.version
  const metaURL = wanted
    ? `https://registry.npmjs.org/${pkg.name}/${wanted}`
    : `https://registry.npmjs.org/${pkg.name}/latest`
  const metaResponse = await fetch(metaURL, { signal: AbortSignal.timeout(30000) })
  if (!metaResponse.ok) throw new Error(`OpenCode 安装信息读取失败：HTTP ${metaResponse.status}`)
  const metadata = await metaResponse.json()
  const dist = metadata.dist
  if (metadata.name !== pkg.name || !VERSION_PATTERN.test(metadata.version ?? '')
    || !dist?.integrity?.startsWith('sha512-')
    || !dist?.tarball?.startsWith(`https://registry.npmjs.org/${pkg.name}/-/`)) {
    throw new Error('OpenCode 官方包元数据异常，已中止下载')
  }

  const target = path.join(root, metadata.version, pkg.binary)
  await fs.mkdir(path.dirname(target), { recursive: true })
  status(`正在下载 OpenCode ${metadata.version}，首次启动可能需要几分钟`)
  const archive = path.join(path.dirname(target), 'download.tgz')
  const download = await fetch(dist.tarball, { signal: AbortSignal.timeout(300000) })
  if (!download.ok || !download.body) throw new Error(`OpenCode 下载失败：HTTP ${download.status}`)
  await pipeline(Readable.fromWeb(download.body), createWriteStream(archive))

  const hash = createHash('sha512')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  if (`sha512-${hash.digest('base64')}` !== dist.integrity) {
    await fs.unlink(archive).catch(() => {})
    throw new Error('OpenCode 下载校验失败（sha512 不匹配）')
  }

  await extractBinary(archive, `package/bin/${pkg.binary}`, target)
  await fs.chmod(target, 0o755)
  if (await binaryVersion(target) !== metadata.version) {
    throw new Error('下载的 OpenCode 版本与元数据不符')
  }
  await fs.unlink(archive).catch(() => {})
  return target
}

/**
 * Extract a single member from a .tgz without a tar dependency.
 *
 * Only the one expected file is read; the archive never decides where anything
 * is written, so a malicious entry name cannot escape the target directory.
 */
async function extractBinary(archive, member, target) {
  const { spawn: spawnChild } = await import('node:child_process')
  const temp = `${target}.extract`
  await fs.mkdir(path.dirname(target), { recursive: true })
  await new Promise((resolve, reject) => {
    // `tar` is present on Windows 10+ and every supported Unix; reading through
    // a pipe keeps the archive path out of any shell.
    const child = spawnChild('tar', ['-xzOf', archive, member], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = createWriteStream(temp)
    let err = ''
    child.stdout.pipe(out)
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('close', code => {
      out.end()
      if (code === 0) resolve()
      else reject(new Error(`OpenCode 解包失败（tar 退出码 ${code}）${err ? `: ${err.slice(0, 300)}` : ''}`))
    })
  })
  await fs.rename(temp, target)
}

/** Pick a free loopback port. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * Start an isolated `opencode serve` and wait until it reports healthy.
 *
 * @returns {Promise<{backend: Backend, stop: () => Promise<void>, child: import('node:child_process').ChildProcess, version: string}>}
 */
export async function startBackend(binary, dataDir, logStream, proxyEnv = {}) {
  const actualVersion = await binaryVersion(binary)
  const root = path.join(dataDir, 'opencode')
  for (const dir of XDG_ROOTS) {
    await fs.mkdir(path.join(root, dir), { recursive: true, mode: 0o700 })
  }

  // Build the child environment explicitly: only ordinary OS/network settings
  // are forwarded, never another provider's key or an OpenCode auth override.
  const env = {}
  for (const key of FORWARDED_ENV) {
    if (process.env[key]) env[key] = process.env[key]
  }
  for (const dir of XDG_ROOTS) {
    env[`XDG_${dir.toUpperCase()}_HOME`] = path.join(root, dir)
  }
  Object.assign(env, proxyEnv)

  const password = randomBytes(24).toString('hex')
  Object.assign(env, {
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: nativePermissions,
      autoupdate: false,
      share: 'disabled',
      agent: isolatedAgents,
    }),
  })

  const projectDir = path.join(root, 'project')
  await fs.mkdir(projectDir, { recursive: true })

  const port = await freePort()
  const child = spawn(binary, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: projectDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(logStream, { end: false })
  child.stderr.pipe(logStream, { end: false })

  let spawnFailure
  child.on('error', error => { spawnFailure = error })

  const backend = new Backend(`http://127.0.0.1:${port}`, password, undefined, message => {
    logStream.write(`${new Date().toISOString()} ${message}\n`)
  })

  const stop = async () => {
    backend.stopEvents()
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 4000)),
    ])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }

  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (spawnFailure || child.exitCode !== null) {
        throw spawnFailure || new Error(`OpenCode 启动即退出（退出码 ${child.exitCode}）`)
      }
      try {
        const health = await backend.request('/global/health', 'GET', undefined, undefined, 1000)
        if (health.healthy) {
          if (health.version !== actualVersion) throw new Error('OpenCode 服务版本与二进制不一致')
          return { backend, stop, child, version: health.version }
        }
      } catch (error) {
        if (error.message === 'OpenCode 服务版本与二进制不一致') throw error
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error('OpenCode 启动超时')
  } catch (error) {
    await stop()
    throw error
  }
}
