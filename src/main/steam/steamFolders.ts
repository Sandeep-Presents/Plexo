import { execFile } from 'node:child_process'
import { lstat, readFile, realpath, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { promisify } from 'node:util'
import type { SteamLibraryFolder } from '../../shared/steam'
import { sanitizeFileName } from '../download/paths'
import { testSteamRoot } from '../testKnobs'
import { libraryPaths, parseVdf } from './libraryFolders'

// Where the Steam client keeps games on this computer: its own folder, found where each system
// puts it, and every other library its libraryfolders.vdf lists (another drive, usually). A game
// goes in a library's steamapps/common, in a folder named as Steam would name it. Only local
// files are read; nothing is asked of Steam.

const REGISTRY_TIMEOUT_MS = 3000

/** A value of the Windows registry, by `reg query`, which every Windows has. */
async function registryValue(key: string, name: string): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)('reg', ['query', key, '/v', name], {
      timeout: REGISTRY_TIMEOUT_MS,
      windowsHide: true
    })
    const match = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'im').exec(stdout)
    return match ? win32.normalize(match[1]) : null
  } catch {
    return null
  }
}

/** Where the Steam client may be installed, most likely first. */
async function rootCandidates(): Promise<string[]> {
  const testRoot = testSteamRoot()
  if (testRoot !== undefined) return [testRoot]
  const home = homedir()
  if (process.platform === 'win32') {
    const fromRegistry = await Promise.all([
      registryValue('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
      registryValue('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
      registryValue('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath')
    ])
    const programFiles = [process.env['ProgramFiles(x86)'], process.env['ProgramFiles']]
    return [
      ...fromRegistry.filter((path): path is string => path !== null),
      ...programFiles.filter((dir): dir is string => !!dir).map((dir) => join(dir, 'Steam'))
    ]
  }
  if (process.platform === 'darwin') return [join(home, 'Library', 'Application Support', 'Steam')]
  return [
    join(home, '.steam', 'steam'),
    join(home, '.local', 'share', 'Steam'),
    // Flatpak and Snap keep Steam inside their own sandboxes.
    join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
    join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam')
  ]
}

const isDirectory = (path: string): Promise<boolean> =>
  lstat(path).then(
    (info) => info.isDirectory(),
    () => false
  )

async function freeSpace(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

/**
 * The Steam libraries on this computer, as folders a game can be saved to: each one's
 * steamapps/common. With `installDir`, whether the game is already in each, and those that have
 * it first. Empty when Steam isn't installed.
 */
export async function findLibraryFolders(installDir?: string): Promise<SteamLibraryFolder[]> {
  const libraries: string[] = []
  for (const root of await rootCandidates()) {
    if (!(await isDirectory(join(root, 'steamapps')))) continue
    libraries.push(root)
    const listed = await readFile(join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8').then(
      (text) => libraryPaths(parseVdf(text)),
      () => []
    )
    libraries.push(...listed)
  }

  const folder = installDir === undefined ? undefined : sanitizeFileName(installDir)
  const seen = new Set<string>()
  const found: SteamLibraryFolder[] = []
  for (const library of libraries) {
    const steamapps = join(library, 'steamapps')
    if (!(await isDirectory(steamapps))) continue
    // The same library reached two ways (~/.steam/steam is a link, Windows ignores case).
    const real = await realpath(library).catch(() => library)
    const identity = process.platform === 'win32' ? real.toLowerCase() : real
    if (seen.has(identity)) continue
    seen.add(identity)
    const common = join(real, 'steamapps', 'common')
    const hasCommon = await isDirectory(common)
    found.push({
      path: common,
      freeBytes: await freeSpace(hasCommon ? common : steamapps),
      hasGame: folder !== undefined && hasCommon && (await isDirectory(join(common, folder)))
    })
  }
  // Stable: libraries that have the game first, the rest in Steam's own order.
  return found.sort((a, b) => Number(b.hasGame) - Number(a.hasGame))
}
