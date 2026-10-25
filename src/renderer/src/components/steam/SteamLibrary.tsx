import type { SteamOwnedApp } from '@shared/steam'
import { AlertTriangle, RefreshCw, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { describeError } from '../../utils/format'
import { Button } from '../ui/button'

// The games and apps the account owns, by name, searched as they're typed. A library can run to
// thousands, so only the rows in view are drawn.

const ROW_HEIGHT = 40
const LIST_HEIGHT = 360
/** Rows drawn beyond the visible ones, so a quick scroll doesn't show blanks. */
const OVERSCAN = 6

type Load =
  | { status: 'loading' }
  | { status: 'ready'; apps: SteamOwnedApp[] }
  | { status: 'error'; message: string }

export function SteamLibrary({ onPick }: { onPick: (appId: number) => void }): React.JSX.Element {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [refreshes, setRefreshes] = useState(0)

  useEffect(() => {
    let stale = false
    window.plexo
      .steamOwnedApps(refreshes > 0)
      .then((apps) => !stale && setLoad({ status: 'ready', apps }))
      .catch((error: unknown) => {
        if (!stale) setLoad({ status: 'error', message: describeError(error) })
      })
    return () => {
      stale = true
    }
  }, [refreshes])

  const refresh = (): void => {
    setLoad({ status: 'loading' })
    setRefreshes((count) => count + 1)
  }

  const needle = query.trim().toLowerCase()
  const apps =
    load.status === 'ready'
      ? load.apps.filter(
          (app) =>
            !needle || app.name.toLowerCase().includes(needle) || String(app.appId) === needle
        )
      : []
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(apps.length, Math.ceil((scrollTop + LIST_HEIGHT) / ROW_HEIGHT) + OVERSCAN)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-[var(--input-bg)] px-2.5">
          <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setScrollTop(0)
            }}
            placeholder="Search your library"
            aria-label="Search your library"
            spellCheck={false}
            className="min-w-0 flex-1 border-none bg-transparent text-[13px] outline-none"
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label="Refresh library"
          disabled={load.status === 'loading'}
          onClick={refresh}
        >
          <RefreshCw />
        </Button>
      </div>

      {load.status === 'loading' && (
        <div className="py-6 text-center text-[12.5px] text-muted-foreground">
          Loading your library…
        </div>
      )}
      {load.status === 'error' && (
        <div
          role="alert"
          className="flex items-start gap-2 text-[12.5px] text-[var(--color-danger)]"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {load.message}
        </div>
      )}
      {load.status === 'ready' && apps.length === 0 && (
        <div className="py-6 text-center text-[12.5px] text-muted-foreground">
          {load.apps.length === 0
            ? 'This account owns nothing Plexo can download.'
            : 'Nothing in your library matches.'}
        </div>
      )}
      {apps.length > 0 && (
        <div
          role="list"
          aria-label="Your Steam library"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          className="overflow-y-auto rounded-lg border-[0.5px] border-border"
          // The border's pixel on top of the rows, or a short list scrolls.
          style={{ height: Math.min(LIST_HEIGHT, apps.length * ROW_HEIGHT) + 1 }}
        >
          <div className="relative" style={{ height: apps.length * ROW_HEIGHT }}>
            {apps.slice(first, last).map((app, offset) => (
              <div
                key={app.appId}
                role="listitem"
                className="absolute inset-x-0"
                style={{ top: (first + offset) * ROW_HEIGHT, height: ROW_HEIGHT }}
              >
                <button
                  type="button"
                  onClick={() => onPick(app.appId)}
                  className="flex h-full w-full cursor-default items-center gap-2 border-b-[0.5px] border-border px-3 text-left text-[13px] hover:bg-secondary"
                >
                  <span className="min-w-0 flex-1 truncate">{app.name}</span>
                  {app.type !== 'game' && (
                    <span className="font-mono text-[10.5px] text-muted-foreground uppercase">
                      {app.type}
                    </span>
                  )}
                  {app.borrowed && <FamilySharing />}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** A license borrowed through Steam Family Sharing. */
export function FamilySharing(): React.JSX.Element {
  return (
    <span className="rounded-full border-[0.5px] border-border px-2 py-0.5 text-[10.5px] text-[var(--text-secondary)]">
      Family Sharing
    </span>
  )
}
