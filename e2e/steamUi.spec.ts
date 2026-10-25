import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, test, type PlexoApp } from './fixtures'
import { ACCOUNT, GUARD_CODE } from './steamOrigin'

// The Steam dialog, driven through the real window: logging in with a Steam Guard code, finding
// the game in the library, its choices, and the start, ending on the download's own screen. What
// it downloads is checked by the automatic checks, as for the API-level specs.

/** The folder picker is native OS UI: it answers with the test's folder. */
async function stubFolderPicker(plexo: PlexoApp, destination: string): Promise<void> {
  await plexo.evaluateMain(({ dialog }, dest) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dest] })) as never
  }, destination)
}

test.describe('the Steam dialog', () => {
  test('logs in with a Guard code, picks a game and downloads it @smoke', async ({
    plexo,
    serveSteam,
    dirs
  }) => {
    const steam = await serveSteam(undefined, { guard: 'email' })
    await stubFolderPicker(plexo, dirs.dest)
    const page = plexo.page

    await page.getByRole('button', { name: 'Steam', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Steam' })
    await dialog.getByLabel('Account name', { exact: true }).fill(ACCOUNT.name)
    await dialog.getByLabel('Password').fill('not it')
    await dialog.getByRole('button', { name: 'Log in' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('The account name or password is wrong.')
    // The password field is cleared as soon as it's handed over.
    await expect(dialog.getByLabel('Password')).toHaveValue('')

    await dialog.getByLabel('Password').fill(ACCOUNT.password)
    await dialog.getByRole('button', { name: 'Log in' }).click()
    await expect(
      dialog.getByText('Steam sent a code to your email at …@example.com.')
    ).toBeVisible()
    await dialog.getByLabel('Steam Guard code').fill('WRONG')
    await dialog.getByRole('button', { name: 'Continue' }).click()
    await expect(dialog.getByRole('alert')).toHaveText(/Steam Guard code isn’t right/)
    await dialog.getByLabel('Steam Guard code').fill(GUARD_CODE)
    await dialog.getByRole('button', { name: 'Continue' }).click()

    await expect(dialog.getByText(ACCOUNT.name)).toBeVisible()
    await dialog.getByLabel('Search your library').fill('test game')
    await dialog.getByRole('button', { name: 'Plexo Test Game' }).click()

    const depots = dialog.getByRole('group', { name: 'Depots' })
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
      dialog.getByText(/3 of 4 depots · .* installed · .* to download · .* free/)
    ).toBeVisible()

    await dialog.getByRole('button', { name: 'Change' }).click()
    await plexo.expectNextDownload(steam.expectedSha())
    await dialog.getByRole('button', { name: 'Download' }).click()

    // Started: the dialog closes on the download's own screen.
    await expect(dialog).toBeHidden()
    await plexo.waitForSteamStatus('completed')
    await expect(page.getByText('Plexo Test Game').first()).toBeVisible()
  })

  test('a download that needs a login offers one from its own screen', async ({
    plexo,
    serveSteam
  }) => {
    const steam = await serveSteam()
    let seen = 0
    const held = steam.hold((request) => request.kind === 'chunk' && ++seen > 2)
    const id = await plexo.startSteam(steam)
    await held
    await plexo.quit()
    steam.release()
    await plexo.launch()
    await plexo.api.resumeDownload(id)
    await plexo.waitForSteamStatus('error')

    const page = plexo.page
    await page.getByText('Plexo Test Game').first().click()
    await expect(page.getByText('Log in to Steam to continue.')).toBeVisible()
    await page.getByRole('button', { name: 'Log in to Steam' }).click()
    const dialog = page.getByRole('dialog', { name: 'Steam' })
    await expect(dialog.getByRole('button', { name: 'Log in' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Close' }).click()

    // Logged in, it goes on by itself.
    await plexo.loginSteam()
    await plexo.waitForSteamStatus('completed')
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
    await page.getByRole('button', { name: 'Steam', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Steam' })
    await dialog.getByRole('button', { name: 'Plexo Test Game' }).click()
    await dialog.getByRole('button', { name: 'Auto-detect' }).click()

    const libraries = dialog.getByRole('group', { name: 'Steam libraries' }).getByRole('button')
    await expect(libraries).toHaveCount(2)
    // The one that has the game comes first.
    await expect(libraries.first()).toContainText('Has this game')
    await expect(libraries.nth(1)).not.toContainText('Has this game')
    await libraries.first().click()
    await expect(dialog.getByRole('checkbox', { name: /^Install over the existing/ })).toBeChecked()
    await expect(dialog.getByText(/is already in this Steam library/)).toBeVisible()

    const common = await realpath(join(other, 'steamapps', 'common'))
    plexo.nextDownload = {
      expectedSha: steam.expectedSha(),
      destBefore: await readdir(common),
      destinationDir: common
    }
    await dialog.getByRole('button', { name: 'Download' }).click()
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
    const page = plexo.page
    await page.getByRole('button', { name: 'Steam', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Steam' })
    await dialog.getByRole('button', { name: 'Plexo Test Game' }).click()
    await dialog.getByRole('button', { name: 'Auto-detect' }).click()
    await expect(
      dialog.getByText('Plexo couldn’t find Steam on this computer.', { exact: false })
    ).toBeVisible()
  })

  test('a password-protected branch is listed, but can’t be picked', async ({
    plexo,
    serveSteam
  }) => {
    await serveSteam()
    await plexo.loginSteam()
    const page = plexo.page
    await page.getByRole('button', { name: 'Steam', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Steam' })
    await dialog.getByRole('button', { name: 'Plexo Test Game' }).click()
    await dialog.getByRole('button', { name: 'Branch' }).click()
    const beta = page.getByRole('menuitemradio', { name: /beta/ })
    await expect(beta).toBeVisible()
    await expect(beta).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')

    // Logging out from the dialog goes back to the login.
    await dialog.getByRole('button', { name: 'Log out' }).click()
    await expect(dialog.getByRole('button', { name: 'Log in' })).toBeVisible()
  })
})
