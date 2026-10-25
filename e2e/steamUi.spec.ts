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

    await plexo.loginSteam()
    await page.getByRole('button', { name: 'Retry' }).click()
    await plexo.waitForSteamStatus('completed')
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
