import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import {
  currentSystem,
  defaultDepots,
  defaultLanguage,
  depotUnavailable,
  readAppInfo
} from '../src/main/steam/appInfo'
import type { SteamAppDetails } from '../src/shared/steam'

// An app's appinfo, as steam-user parses Valve's KeyValues text: nested objects of strings, with
// a shape that has changed over the years and comes from the network.

const APPINFO = {
  appid: '480',
  common: { name: 'Spacewar', type: 'Game', oslist: 'windows,macos,linux' },
  config: { installdir: 'Spacewar' },
  depots: {
    '481': {
      name: 'Spacewar Content',
      config: { oslist: 'windows' },
      manifests: { public: { gid: '3183503801510301321', size: '1000', download: '400' } }
    },
    '482': {
      name: 'Spacewar Mac',
      config: { oslist: 'macos', osarch: '64' },
      manifests: { public: { gid: '1', size: '10', download: '5' } }
    },
    '483': {
      config: { oslist: 'windows', language: 'german' },
      manifests: { public: '2' }
    },
    '484': {
      config: { oslist: 'windows', language: 'english' },
      manifests: { public: { gid: '3' }, beta: { gid: '4' } }
    },
    '485': { config: { oslist: 'windows', lowviolence: '1' }, manifests: { public: { gid: '5' } } },
    '486': { dlcappid: '999', manifests: { public: { gid: '6' } } },
    '487': { depotfromapp: '228980', sharedinstall: '1' },
    '488': { config: { oslist: 'windows', osarch: '32' }, manifests: { public: { gid: '8' } } },
    '489': {
      encryptedmanifests: { secret: { encrypted_gid_2: 'abcd' } },
      manifests: { public: { gid: '9' } }
    },
    '490': { config: { realm: 'steamchina' }, manifests: { public: { gid: '10' } } },
    branches: {
      public: { buildid: '100', timeupdated: '1700000000' },
      beta: { buildid: '101', description: 'Beta', timeupdated: '1700000001' },
      secret: { buildid: '102', pwdrequired: '1' },
      'bad name!': { buildid: '1' }
    },
    baselanguages: 'english'
  }
}

const owned = (details: SteamAppDetails, ids: number[]): SteamAppDetails => ({
  ...details,
  depots: details.depots.map((depot) => ({ ...depot, owned: ids.includes(depot.depotId) }))
})

test.describe('steam appinfo', () => {
  test('reads depots, branches, filters and sizes, both appinfo formats alike', () => {
    const details = readAppInfo(480, APPINFO)
    expect(details.name).toBe('Spacewar')
    expect(details.type).toBe('game')
    expect(details.installDir).toBe('Spacewar')
    expect(details.languages).toEqual(['english', 'german'])
    expect(details.branches.map((branch) => [branch.name, branch.passwordRequired])).toEqual([
      ['public', false],
      ['beta', false],
      ['secret', true]
    ])
    const byId = new Map(details.depots.map((depot) => [depot.depotId, depot]))
    expect(byId.get(481)!.manifests.public).toEqual({
      gid: '3183503801510301321',
      size: 1000,
      download: 400
    })
    // The old format: a bare manifest id.
    expect(byId.get(483)!.manifests.public).toEqual({ gid: '2' })
    expect(byId.get(482)!.osarch).toBe('64')
    expect(byId.get(486)!.dlcAppId).toBe(999)
    expect(byId.get(487)!.sharedFrom).toBe(228980)
    expect(byId.get(487)!.sharedInstall).toBe(true)
    expect(byId.get(489)!.encryptedBranches).toEqual(['secret'])
    // Another realm's depot is never offered.
    expect(byId.get(490)!.manifests).toEqual({})
    expect(byId.get(483)!.name).toBe('Depot 483')
  })

  test('the default depots are the ones Steam would install here', () => {
    const details = owned(readAppInfo(480, APPINFO), [481, 482, 483, 484, 485, 486, 487, 488, 489])
    const windows = { branch: 'public', os: 'windows', arch: '64', language: 'english' } as const
    expect(defaultDepots(details, windows)).toEqual([481, 484, 486, 489])
    expect(defaultDepots(details, { ...windows, language: 'german' })).toEqual([481, 483, 486, 489])
    expect(defaultDepots(details, { ...windows, arch: '32' })).toEqual([481, 484, 486, 488, 489])
    expect(defaultDepots(details, { ...windows, lowViolence: true })).toEqual([
      481, 484, 485, 486, 489
    ])
    expect(defaultDepots(details, { ...windows, os: 'macos' })).toEqual([482, 486, 489])
    // On a branch, only depots with a manifest for it.
    expect(defaultDepots(details, { ...windows, branch: 'beta' })).toEqual([484])
  })

  test('what isn’t owned, isn’t on the branch or is behind a password says so', () => {
    const details = owned(readAppInfo(480, APPINFO), [481, 489])
    const byId = new Map(details.depots.map((depot) => [depot.depotId, depot]))
    expect(depotUnavailable(byId.get(482)!, 'public')).toBe('Not owned by this account')
    expect(depotUnavailable(byId.get(489)!, 'secret')).toMatch(/Password-protected/)
    expect(depotUnavailable(byId.get(481)!, 'beta')).toBe('Not part of this branch')
    expect(depotUnavailable(byId.get(481)!, 'public')).toBeNull()
  })

  test('anything at all in place of appinfo gives details, never a throw or a bad value', () => {
    const value = fc.letrec((tie) => ({
      node: fc.oneof(
        { depthSize: 'small' },
        fc.string(),
        fc.integer(),
        fc.constant(null),
        fc.array(tie('node'), { maxLength: 3 }),
        fc.dictionary(
          fc.oneof(
            fc.string(),
            fc.constantFrom('depots', 'manifests', 'public', 'gid', 'config', '481', 'branches')
          ),
          tie('node'),
          { maxKeys: 4 }
        )
      )
    })).node
    fc.assert(
      fc.property(value, (appinfo) => {
        const details = readAppInfo(1, appinfo)
        for (const depot of details.depots) {
          expect(Number.isInteger(depot.depotId)).toBe(true)
          for (const manifest of Object.values(depot.manifests))
            expect(manifest.gid).toMatch(/^\d+$/)
        }
      }),
      { numRuns: 500 }
    )
  })

  test('English is the language to start with when there is one; this computer maps to Steam’s names', () => {
    expect(defaultLanguage(readAppInfo(480, APPINFO))).toBe('english')
    expect(currentSystem('win32', 'x64')).toEqual({ os: 'windows', arch: '64' })
    expect(currentSystem('darwin', 'arm64')).toEqual({ os: 'macos', arch: '64' })
    expect(currentSystem('linux', 'ia32')).toEqual({ os: 'linux', arch: '32' })
  })
})
