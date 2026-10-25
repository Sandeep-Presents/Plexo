// What the window is told about Steam: who is logged in, what they own, and what an app is made
// of. Nothing here is a secret — never a password, token, code or depot key (see main/steam).

export type SteamOs = 'windows' | 'macos' | 'linux'
export type SteamArch = '32' | '64'

export interface SteamBranch {
  name: string
  buildId: string
  description?: string
  /** A password-protected (private) branch: listed, but Plexo doesn't download those. */
  passwordRequired: boolean
  /** Seconds since the epoch. */
  updatedAt?: number
}

export interface SteamDepotManifest {
  /** The manifest's id, in decimal. */
  gid: string
  /** Bytes on disk, when appinfo says. */
  size?: number
  /** Bytes to download, when appinfo says. */
  download?: number
}

export interface SteamDepot {
  depotId: number
  name: string
  /** The systems it is for; empty means every one. */
  oslist: SteamOs[]
  osarch?: SteamArch
  /** The language it is for; undefined means every one. */
  language?: string
  lowViolence: boolean
  /** It belongs to this DLC: installed only with the DLC owned. */
  dlcAppId?: number
  /** Its content comes from another app's depot (a shared redistributable, usually). */
  sharedFrom?: number
  /** Steam installs it once for every game that uses it (a redistributable). */
  sharedInstall: boolean
  /** By branch name. */
  manifests: Record<string, SteamDepotManifest>
  /** Branches whose manifest id is encrypted with the branch password. */
  encryptedBranches: string[]
  /** The account holds a license for it; set by the library, not appinfo. */
  owned: boolean
  /** That license is borrowed through Steam Family Sharing. */
  borrowed?: boolean
}

export interface SteamAppDetails {
  appId: number
  name: string
  type: string
  /** The folder Steam would install it in, as appinfo names it. */
  installDir: string
  branches: SteamBranch[]
  depots: SteamDepot[]
  /** Every language some depot is for, sorted. */
  languages: string[]
}

export interface SteamOwnedApp {
  appId: number
  name: string
  /** As appinfo has it, lower-cased: game, application, tool, demo, dlc, … */
  type: string
  /** The license is borrowed through Steam Family Sharing. */
  borrowed: boolean
}

/** What the user chose for an app: the default depots follow from it (see defaultDepots). */
export interface SteamSelection {
  branch: string
  os: SteamOs
  arch: SteamArch
  language: string
  lowViolence?: boolean
}
