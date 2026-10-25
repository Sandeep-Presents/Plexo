import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, test, type PlexoApp } from './fixtures'
import { ACCOUNT, gradientPng, GUARD_CODE } from './steamOrigin'

// The window, driven as a person would: logging in on the screen it opens on, the library, a
// game's page and its choices, ending on the download's own screen. What it downloads is checked
// by the automatic checks, as for the API-level specs.

/** The folder picker is native OS UI: it answers with the test's folder. */
async function stubFolderPicker(plexo: PlexoApp, destination: string): Promise<void> {
  await plexo.evaluateMain(({ dialog }, dest) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dest] })) as never
  }, destination)
}

const library = (plexo: PlexoApp): Locator =>
  plexo.page.getByRole('list', { name: 'Your Steam library' })
const nav = (plexo: PlexoApp, name: string): Locator =>
  plexo.page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true })

/** Opens a game's page from the library, as clicking its picture does. */
async function openGame(plexo: PlexoApp, name: string): Promise<void> {
  await library(plexo).getByRole('button', { name }).click()
  await expect(plexo.page.getByRole('heading', { name })).toBeVisible()
}

test.describe('the window', () => {
  test('logs in with a Guard code, picks a game from the library and downloads it @smoke', async ({
    plexo,
    serveSteam,
    dirs
  }) => {
    const steam = await serveSteam(undefined, { guard: 'email' })
    await stubFolderPicker(plexo, dirs.dest)
    const page = plexo.page

    // Logged out, the window opens on the login and nothing else.
    const login = page.getByRole('region', { name: 'Steam login' })
    await expect(login).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
    await login.getByLabel('Account name', { exact: true }).fill(ACCOUNT.name)
    await login.getByLabel('Password').fill('not it')
    await login.getByRole('button', { name: 'Log in' }).click()
    await expect(login.getByRole('alert')).toHaveText('The account name or password is wrong.')
    // The password field is cleared as soon as it's handed over.
    await expect(login.getByLabel('Password')).toHaveValue('')

    await login.getByLabel('Password').fill(ACCOUNT.password)
    await login.getByRole('button', { name: 'Log in' }).click()
    await expect(login.getByText('Steam sent a code to your email at …@example.com.')).toBeVisible()
    await login.getByLabel('Steam Guard code').fill('WRONG')
    await login.getByRole('button', { name: 'Continue' }).click()
    await expect(login.getByRole('alert')).toHaveText(/Steam Guard code isn’t right/)
    await login.getByLabel('Steam Guard code').fill(GUARD_CODE)
    await login.getByRole('button', { name: 'Continue' }).click()

    // Logged in: the library, with the account at the foot of the sidebar.
    await expect(library(plexo)).toBeVisible()
    await expect(page.getByRole('button', { name: `Steam account ${ACCOUNT.name}` })).toBeVisible()
    await page.getByLabel('Search your library').fill('test game')
    await openGame(plexo, 'Plexo Test Game')

    const depots = page.getByRole('group', { name: 'Depots' })
    await expect(
      depots.getByRole('checkbox', { name: /^Plexo Test Game Content Depot/ })
    ).toBeChecked()
    await expect(depots.getByRole('checkbox', { name: /^Plexo Test Game DLC Depot/ })).toBeChecked()
    // Not owned: offered as such, and not picked.
    await expect(
      depots.getByRole('checkbox', { name: /^Plexo Test Game Soundtrack Depot/ })
    ).toBeDisabled()
    await expect(depots.getByText(/Not owned by this account/)).toBeVisible()
    await expect(
      page.getByText(/3 of 4 depots · .* installed · .* to download · .* free/)
    ).toBeVisible()

    await page.getByRole('button', { name: 'Change' }).click()
    await plexo.expectNextDownload(steam.expectedSha())
    await page.getByRole('button', { name: 'Download', exact: true }).click()

    // Started: its own screen opens.
    await expect(page.getByRole('table', { name: 'Networks' })).toBeVisible()
    await plexo.waitForSteamStatus('completed')
    await expect(page.getByText('Plexo Test Game').first()).toBeVisible()

    // Back in the library, the game says it's installed, and on its page where.
    await nav(plexo, 'Steam').click()
    await page.getByLabel('Search your library').fill('')
    await expect(library(plexo).getByRole('listitem').first()).toContainText('Installed')
    await openGame(plexo, 'Plexo Test Game')
    await expect(page.getByRole('region', { name: 'Installed' })).toContainText(
      join(dirs.dest, 'Plexo Test Game')
    )
    await expect(page.getByRole('heading', { name: 'Install again' })).toBeVisible()
  })

  test('a download from before a relaunch is kept, and resumes from Downloads once logged in', async ({
    plexo,
    serveSteam
  }) => {
    const steam = await serveSteam()
    let seen = 0
    const held = steam.hold((request) => request.kind === 'chunk' && ++seen > 2)
    await plexo.startSteam(steam)
    await held
    await plexo.quit()
    steam.release()
    await plexo.launch()

    const login = plexo.page.getByRole('region', { name: 'Steam login' })
    await expect(login).toBeVisible()
    await login.getByLabel('Account name', { exact: true }).fill(ACCOUNT.name)
    await login.getByLabel('Password').fill(ACCOUNT.password)
    await login.getByRole('button', { name: 'Log in' }).click()
    await expect(library(plexo)).toBeVisible()
    // The library says where it got to.
    await expect(library(plexo).getByRole('listitem').first()).toContainText(/Paused at \d+%/)

    await nav(plexo, 'Downloads').click()
    await plexo.page.getByRole('button', { name: 'Resume Plexo Test Game' }).click()
    await plexo.waitForSteamStatus('completed')
  })

  test('the library searches, filters, and draws only the games in view', async ({
    plexo,
    serveSteam
  }) => {
    const otherApps = Array.from({ length: 400 }, (_, index) => ({
      appId: 10_000 + index * 10,
      name: `Game ${String(index).padStart(3, '0')}`,
      borrowed: index === 0
    }))
    const steam = await serveSteam(undefined, { otherApps })
    // One game with only a landscape header, as old games have.
    steam.art.set('/10010/header.jpg', gradientPng(92, 43, [40, 120, 90], [10, 30, 20]))
    await plexo.loginSteam()
    const page = plexo.page
    await expect(library(plexo).getByRole('button', { name: 'Game 000' })).toBeVisible()
    // Hundreds owned, a screenful drawn.
    expect(await library(plexo).getByRole('listitem').count()).toBeLessThan(80)
    await expect(library(plexo).getByRole('listitem').first()).toContainText('Family Sharing')

    // A picture comes from Steam once: going away and back asks for none again.
    await expect
      .poll(() => steam.artRequests.filter((path) => path.startsWith('/10010/')))
      .toEqual(['/10010/library_600x900.jpg', '/10010/header.jpg'])
    await nav(plexo, 'Downloads').click()
    await nav(plexo, 'Steam').click()
    await expect(library(plexo).getByRole('button', { name: 'Game 000' })).toBeVisible()
    expect(steam.artRequests.filter((path) => path.startsWith('/10010/'))).toHaveLength(2)

    await page.getByLabel('Search your library').fill('game 39')
    await expect(library(plexo).getByRole('listitem')).toHaveCount(10)
    await page.getByLabel('Search your library').fill('')
    await page
      .getByRole('group', { name: 'Show' })
      .getByRole('button', { name: 'Installed', exact: true })
      .click()
    await expect(page.getByText('Nothing in your library matches')).toBeVisible()
    await page.getByRole('button', { name: 'Show every game' }).click()
    await expect(library(plexo).getByRole('button', { name: 'Game 000' })).toBeVisible()
  })

  test('Auto-detect finds the Steam libraries, and installs into the one that has the game', async ({
    plexo,
    serveSteam,
    dirs
  }) => {
    const steam = await serveSteam()
    // A Steam client with two libraries; the second already has part of the game.
    const root = join(dirname(dirs.dest), 'Steam')
    const other = join(dirname(dirs.dest), 'SteamLibrary')
    const game = join(other, 'steamapps', 'common', 'Plexo Test Game')
    await mkdir(join(root, 'steamapps', 'common'), { recursive: true })
    await mkdir(join(game, 'bin'), { recursive: true })
    const binGame = steam.app.depots[0].files.find((file) => file.name === 'bin/game')!.data!
    await writeFile(join(game, 'bin', 'game'), binGame)
    // Steam lists it as installed there.
    await writeFile(join(other, 'steamapps', 'appmanifest_4000.acf'), '"AppState" {}')
    const vdfPath = (path: string): string => path.replaceAll('\\', '\\\\')
    await writeFile(
      join(root, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${vdfPath(root)}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${vdfPath(other)}"\n\t}\n}\n`
    )
    await plexo.evaluateMain((_electron, value) => {
      process.env.PLEXO_E2E_STEAM_ROOT = value
    }, root)

    await plexo.loginSteam()
    const page = plexo.page
    await expect(library(plexo).getByRole('listitem').first()).toContainText('Installed in Steam')
    await openGame(plexo, 'Plexo Test Game')
    await page.getByRole('button', { name: 'Auto-detect' }).click()

    const libraries = page.getByRole('group', { name: 'Steam libraries' }).getByRole('button')
    await expect(libraries).toHaveCount(2)
    // The one that has the game comes first.
    await expect(libraries.first()).toContainText('Has this game')
    await expect(libraries.nth(1)).not.toContainText('Has this game')
    await libraries.first().click()
    await expect(page.getByRole('checkbox', { name: /^Install over the existing/ })).toBeChecked()
    await expect(page.getByText(/is already in this Steam library/)).toBeVisible()

    const common = await realpath(join(other, 'steamapps', 'common'))
    plexo.nextDownload = {
      expectedSha: steam.expectedSha(),
      destBefore: await readdir(common),
      destinationDir: common
    }
    await page.getByRole('button', { name: 'Download', exact: true }).click()
    const done = await plexo.waitForSteamStatus('completed')
    expect(done.destinationPath).toBe(join(common, 'Plexo Test Game'))
    expect(done.adopted).toBe(true)
    // What was there already was kept, not fetched again.
    expect(steam.chunkRequests().length).toBeLessThan(steam.uniqueChunks().length)
    // The next game goes there too.
    const settings = async (): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(join(dirs.userData, 'app-settings.json'), 'utf8'))
    await expect.poll(async () => (await settings()).destinationDir).toBe(common)
  })

  test('Auto-detect says so when Steam isn’t on this computer', async ({
    plexo,
    serveSteam,
    dirs
  }) => {
    await serveSteam()
    await plexo.evaluateMain(
      (_electron, value) => {
        process.env.PLEXO_E2E_STEAM_ROOT = value
      },
      join(dirname(dirs.dest), 'no Steam here')
    )
    await plexo.loginSteam()
    await openGame(plexo, 'Plexo Test Game')
    await plexo.page.getByRole('button', { name: 'Auto-detect' }).click()
    await expect(
      plexo.page.getByText('Plexo couldn’t find Steam on this computer.', { exact: false })
    ).toBeVisible()
  })

  test('a password-protected branch is listed, but can’t be picked; logging out goes back to the login', async ({
    plexo,
    serveSteam
  }) => {
    await serveSteam()
    await plexo.loginSteam()
    const page = plexo.page
    await openGame(plexo, 'Plexo Test Game')
    await page.getByRole('button', { name: 'Branch' }).click()
    const beta = page.getByRole('menuitemradio', { name: /beta/ })
    await expect(beta).toBeVisible()
    await expect(beta).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: `Steam account ${ACCOUNT.name}` }).click()
    await page.getByRole('menuitem', { name: 'Log out of Steam' }).click()
    await expect(page.getByRole('region', { name: 'Steam login' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
  })
})
