/**
 * Platform facts: where this plugin keeps its data, and which official OpenCode
 * package matches the running host.
 *
 * @module dsh-opencode-xdbridge/platform
 */

import os from 'node:os'
import path from 'node:path'

/** The Harness home directory, matching the host's own convention. */
export function dshHome(env = process.env, home = os.homedir()) {
  return env.DSH_HOME || path.join(home, '.dsh')
}

/**
 * Where this plugin stores its managed runtime, logs and status.
 *
 * Resolution order: an explicit `dataDir` from plugin config, then the
 * `OPENCODE_XDBRIDGE_DATA_DIR` environment variable, then a directory inside the
 * Harness home.
 *
 * The managed OpenCode binary is large (tens of MB), so `dataDir` exists to let
 * an installation keep that payload on a different volume.
 */
export function dataDirectory(options = {}, env = process.env, home = os.homedir()) {
  return options.dataDir || env.OPENCODE_XDBRIDGE_DATA_DIR || path.join(dshHome(env, home), 'opencode-xdbridge')
}

const OS_NAME = { win32: 'windows', darwin: 'darwin', linux: 'linux' }

/**
 * The official npm package that ships the OpenCode binary for this host.
 *
 * These are the same packages `opencode upgrade` itself installs, so the
 * download is the vendor's own artifact rather than a mirror.
 */
export function runtimePackage(platform = process.platform, arch = process.arch) {
  const osName = OS_NAME[platform]
  if (osName === undefined) throw new Error(`dsh-opencode-xdbridge: unsupported platform "${platform}"`)
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null
  if (cpu === null) throw new Error(`dsh-opencode-xdbridge: unsupported architecture "${arch}"`)
  return {
    name: `opencode-${osName}-${cpu}`,
    binary: platform === 'win32' ? 'opencode.exe' : 'opencode',
  }
}

/** Release-version shape the runtime directory names must follow. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
