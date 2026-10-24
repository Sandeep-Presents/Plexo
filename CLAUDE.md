# Plexo

Electron, TypeScript and React desktop app. One download is spread across several networks at once (Wi-Fi, Ethernet, a tethered phone). It handles HTTP links (range requests) and torrents. Read `CONTRIBUTING.md` first; its rules apply.

## Commands

- `npm ci`: install. Needs Node 22.13+. `postinstall` runs patch-package (`patches/`), install-electron and electron-builder's native rebuild.
- `npm run dev`: run the app.
- Before every commit:
  - `npm run lint`
  - `npm run typecheck` (node, web, e2e and extension)
  - `npm run format:check`
  - `npm run test:e2e:smoke`
- On headless Linux, Electron needs a display:

  ```bash
  xvfb-run --auto-servernum --server-args="-screen 0 1280x1024x24 -noreset" npm run test:e2e:smoke
  ```

- `npm run test:e2e`: everything, including `@disk` and `@chaos`.
- Run one file with `npx playwright test e2e/<name>.spec.ts`.
- Tests build the app first with `electron-vite build`, with no typecheck. Set `PLEXO_E2E_SKIP_BUILD=1` when `out/` is already fresh.
- Chaos runs: `PLEXO_CHAOS_RUNS=50` runs more random sequences; `PLEXO_CHAOS_SEED=<seed>` replays a failure.
- `npm run format` rewrites the whole repo. Prefer `npx prettier --write <files you touched>`.

## Conventions

- Match the surrounding style. Comments explain _why_, in plain sentences, and say what a thing is for rather than restating the code.
- Keep changes focused. No reformatting or refactoring of unrelated code.
- `src/main/download/` and `src/main/network/` hold resume, retry and stall logic that prevents data corruption. Changes there need their reasoning written in the PR description.
- Never push to `main`; it takes changes by pull request only.
- Electron security settings stay as they are: context isolation on, no node integration in the renderer. Every renderer-to-main call goes through the typed contract:
  - `src/shared/ipc-contract.ts`
  - `src/shared/ipc-channels.ts`
  - `src/main/ipc/handlers.ts`
  - `src/preload/index.ts`

  Handlers check their arguments at runtime; the types are compile-time only.

- Torrent libraries are pinned to exact versions because Plexo relies on their behaviour, and webtorrent is patched. New protocol libraries are pinned the same way.

## Architecture

- **`src/main/download/downloadManager.ts`** owns a download's lifecycle: queue, pause and resume, per-download networks, persistence, history, and updates to the window. The fetching itself is handed to a `Transfer` (`transfer.ts`), whose implementations are `httpTransfer.ts` and `torrent/torrentTransfer.ts`.
  - Many branches switch on `kind`, and some treat "not http" as torrent. A new kind must make them explicit.
  - `restoreOne` discards a saved download whose kind it doesn't recognise.
  - `history.ts` drops unknown kinds.
- **Pinning.** Every socket is pinned to a network through `StreamConnection` and `connectRoute` (`src/main/network/routes.ts`, `deviceBinding.ts`). Loopback addresses skip device binding, which is how the tests run.
- **Limits.** Every received byte goes through `Limits.take(networkId, bytes)` (`src/main/network/limits.ts`), which applies the speed limits and data allowances.
- **`scheduler.ts`** (`pickWork`) and **`concurrency.ts`** (`ConcurrencyController`, `DiskWatch`) are pure functions of a snapshot.
- **Window updates** carry only the work units that changed (`takeUpdate`, `shared/downloadUpdate.ts`), at most once every 200 ms.
- **Persistence** lives under `userData/downloads/<id>/manifest.json` (format version 7). A checkpoint every 15 s calls `file.sync()` before saving progress.
- **Secrets.** Browser cookies are saved only through `safeStorage`, and never on Linux's `basic_text` backend (see `sealBrowser`).
- **`src/main/testKnobs.ts`** reads `PLEXO_E2E_*` and `PLEXO_USER_DATA`, and only in an unpackaged app.

## Tests

- Playwright drives the real built app through `window.plexo` (`e2e/fixtures.ts`), against `e2e/origin.ts`. That test server can drop, stall or hold a response at an exact byte, return any status, or redirect.
- **Automatic checks** run after every test:
  - a `completed` download matches its source byte for byte (`treeSha` for a folder);
  - anything else leaves no file, part file or open handle (`lsof`);
  - the event history follows the invariants in `checkEvents`.
- Retries are deliberately off. Known bugs are marked `test.fail(...)`.
- Tags (`@smoke`, `@disk`, `@chaos`) are plain text in the test title.
- **Pure-module specs** (for example `scheduler.spec.ts`) import `src/main/...` directly and launch no app. They must not import `electron`, or any module that imports `testKnobs`, because those load Electron's `app`.
- **Fake networks.** `PLEXO_E2E_INTERFACES=a=127.0.0.1,b=<LAN address>` replaces the interface list. Tests change it while a download runs through `evaluateMain`.

## Steam downloads (in progress)

Design: `docs/steam/DESIGN.md`. Work is on the `feature/steam-downloads` branch.

- **Owned content only.** Only apps and depots the logged-in account is licensed for. No license bypass, no DRM circumvention, no anonymous download of paid content.
- **Credentials.**
  - Passwords and Steam Guard codes are never stored or logged.
  - Only the refresh token is kept, encrypted with `safeStorage`, and not at all without a real keychain.
  - The renderer only ever sees the login state.
  - Every Steam error goes through `redact()`.
- **Network calls.** Only to Steam endpoints and the content servers Steam hands out. Manifests and chunks go through `StreamConnection` and `Limits`.
- **Pure Steam modules** (crypto, codecs, manifest, layout, scheduler, cells) stay free of `electron` and `testKnobs`, so they can be unit-tested.
