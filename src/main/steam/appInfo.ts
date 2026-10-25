import type {
  SteamAppDetails,
  SteamArch,
  SteamBranch,
  SteamDepot,
  SteamDepotManifest,
  SteamOs,
  SteamSelection
} from '../../shared/steam'

// An app's PICS appinfo, as steam-user hands it over: Valve's KeyValues text, parsed into nested
// objects of strings. Its shape isn't documented and has changed over the years (a manifest id
// used to be a bare string, now it is an object with sizes), and it comes from the network, so
// this reads it defensively: whatever is missing or malformed is left out, never trusted.

type Node = Record<string, unknown>

const asNode = (value: unknown): Node | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Node) : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined

const asId = (value: unknown): number | undefined => {
  const text = asString(value)
  if (!text || !/^\d{1,10}$/.test(text)) return undefined
  const id = Number(text)
  return id > 0 && id <= 0xffffffff ? id : undefined
}

const asSize = (value: unknown): number | undefined => {
  const text = asString(value)
  if (!text || !/^\d{1,16}$/.test(text)) return undefined
  const size = Number(text)
  return Number.isSafeInteger(size) ? size : undefined
}

const asFlag = (value: unknown): boolean => asString(value) === '1'

const OS_NAMES: Record<string, SteamOs> = { windows: 'windows', macos: 'macos', linux: 'linux' }

function osList(value: unknown): SteamOs[] {
  const list = (asString(value) ?? '')
    .split(',')
    .map((entry) => OS_NAMES[entry.trim().toLowerCase()])
    .filter((os): os is SteamOs => os !== undefined)
  return [...new Set(list)]
}

/** A manifest id: a decimal uint64. */
const isGid = (value: string | undefined): value is string =>
  !!value && /^\d{1,20}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn

function manifestOf(value: unknown): SteamDepotManifest | undefined {
  // Old appinfo gives the id itself; current appinfo an object with sizes.
  const bare = asString(value)
  if (isGid(bare)) return { gid: bare }
  const node = asNode(value)
  const gid = asString(node?.gid)
  if (!node || !isGid(gid)) return undefined
  const manifest: SteamDepotManifest = { gid }
  const size = asSize(node.size)
  const download = asSize(node.download)
  if (size !== undefined) manifest.size = size
  if (download !== undefined) manifest.download = download
  return manifest
}

/** Branch names are short identifiers; anything else is refused rather than shown or sent. */
export const isBranchName = (name: string): boolean => /^[\w.-]{1,64}$/.test(name)

function readDepot(depotId: number, node: Node): SteamDepot {
  const config = asNode(node.config) ?? {}
  const manifests: Record<string, SteamDepotManifest> = {}
  for (const [branch, value] of Object.entries(asNode(node.manifests) ?? {})) {
    const manifest = manifestOf(value)
    if (manifest && isBranchName(branch)) manifests[branch] = manifest
  }
  const arch = asString(config.osarch)
  const language = asString(config.language)?.trim().toLowerCase()
  const depot: SteamDepot = {
    depotId,
    name: (asString(node.name) ?? '').slice(0, 200) || `Depot ${depotId}`,
    oslist: osList(config.oslist),
    lowViolence: asFlag(config.lowviolence),
    sharedInstall: asFlag(node.sharedinstall),
    manifests,
    encryptedBranches: Object.keys(asNode(node.encryptedmanifests) ?? {}).filter(isBranchName),
    owned: false
  }
  if (arch === '32' || arch === '64') depot.osarch = arch as SteamArch
  if (language && /^[a-z_-]{1,40}$/.test(language)) depot.language = language
  const dlcAppId = asId(node.dlcappid)
  if (dlcAppId !== undefined) depot.dlcAppId = dlcAppId
  const sharedFrom = asId(node.depotfromapp)
  if (sharedFrom !== undefined) depot.sharedFrom = sharedFrom
  // China's realm has depots of its own, which a global account can't install: with no manifest
  // on any branch, it is never offered.
  const realm = asString(config.realm)
  if (realm && realm !== 'steamglobal') depot.manifests = {}
  return depot
}

function readBranches(node: Node | undefined): SteamBranch[] {
  const branches: SteamBranch[] = []
  for (const [name, value] of Object.entries(node ?? {})) {
    const branch = asNode(value)
    if (!branch || !isBranchName(name)) continue
    const entry: SteamBranch = {
      name,
      buildId: asString(branch.buildid) ?? '',
      passwordRequired: asFlag(branch.pwdrequired)
    }
    const description = asString(branch.description)
    if (description) entry.description = description.slice(0, 200)
    const updatedAt = asSize(branch.timeupdated)
    if (updatedAt !== undefined) entry.updatedAt = updatedAt
    branches.push(entry)
  }
  // Public first, then the rest by name.
  return branches.sort((a, b) =>
    a.name === 'public' ? -1 : b.name === 'public' ? 1 : a.name.localeCompare(b.name)
  )
}

/** An app's details from its appinfo. Depots come out unowned: the library marks the owned ones. */
export function readAppInfo(appId: number, appinfo: unknown): SteamAppDetails {
  const root = asNode(appinfo) ?? {}
  const common = asNode(root.common) ?? {}
  const config = asNode(root.config) ?? {}
  const depotsNode = asNode(root.depots) ?? {}
  const depots: SteamDepot[] = []
  for (const [key, value] of Object.entries(depotsNode)) {
    // Among the depots sit a few other keys (branches, baselanguages, …).
    const depotId = asId(key)
    const node = asNode(value)
    if (depotId !== undefined && node) depots.push(readDepot(depotId, node))
  }
  const name = (asString(common.name) ?? '').slice(0, 200) || `App ${appId}`
  const languages = [
    ...new Set(depots.flatMap((depot) => (depot.language ? [depot.language] : [])))
  ].sort()
  return {
    appId,
    name,
    type: (asString(common.type) ?? '').toLowerCase(),
    installDir: (asString(config.installdir) ?? '').trim(),
    branches: readBranches(asNode(depotsNode.branches)),
    depots,
    languages
  }
}

/** The manifest a depot installs on `branch`, if it has one for it. */
export function manifestFor(depot: SteamDepot, branch: string): SteamDepotManifest | undefined {
  return depot.manifests[branch]
}

/** Why a depot can't be downloaded on `branch`, or null when it can. */
export function depotUnavailable(depot: SteamDepot, branch: string): string | null {
  if (!depot.owned) return 'Not owned by this account'
  if (depot.encryptedBranches.includes(branch) && !depot.manifests[branch]) {
    return 'Password-protected branches aren’t supported'
  }
  if (!manifestFor(depot, branch)) return 'Not part of this branch'
  return null
}

/**
 * The depots Steam itself would install for `selection`: owned, on the branch, for this system,
 * architecture and language (or for any), without low-violence versions unless asked for, and
 * without shared redistributables, which Steam installs on its own.
 */
export function defaultDepots(details: SteamAppDetails, selection: SteamSelection): number[] {
  return details.depots
    .filter((depot) => depotUnavailable(depot, selection.branch) === null)
    .filter((depot) => depot.oslist.length === 0 || depot.oslist.includes(selection.os))
    .filter((depot) => !depot.osarch || depot.osarch === selection.arch)
    .filter((depot) => !depot.language || depot.language === selection.language)
    .filter((depot) => !depot.lowViolence || selection.lowViolence === true)
    .filter((depot) => !depot.sharedInstall && depot.sharedFrom === undefined)
    .map((depot) => depot.depotId)
}

/** The language to start with: English, else whichever comes first. */
export function defaultLanguage(details: SteamAppDetails): string {
  return details.languages.includes('english') ? 'english' : (details.languages[0] ?? 'english')
}

/** This computer, as Steam names systems and architectures. */
export function currentSystem(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): { os: SteamOs; arch: SteamArch } {
  const os: SteamOs = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux'
  return { os, arch: arch === 'ia32' || arch === 'arm' ? '32' : '64' }
}
