import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { SteamAppDetails } from './SteamAppDetails'
import { SteamLibrary } from './SteamLibrary'
import { SteamLogin } from './SteamLogin'

/** Steam: logging in, the account's library, and one game's choices, ending in a download. Opened
 * from the downloads list; it is the only place Plexo reaches out to Steam from. */
export function SteamDialog(): React.JSX.Element {
  const steam = useAppStore((store) => store.steam)
  const close = useAppStore((store) => store.closeSteam)

  return (
    <Dialog open={steam.open} disablePointerDismissal onOpenChange={(next) => !next && close()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100%-2rem)] flex-col gap-0 p-0 sm:max-w-[720px]"
      >
        {/* Mounted only while open, so each opening starts from the library. */}
        {steam.open && <SteamPanel initialAppId={steam.appId} onClose={close} />}
      </DialogContent>
    </Dialog>
  )
}

function SteamPanel({
  initialAppId,
  onClose
}: {
  initialAppId?: number
  onClose: () => void
}): React.JSX.Element {
  const login = useAppStore((store) => store.steamLogin)
  const receive = useAppStore((store) => store.receiveSteamLogin)
  const setView = useAppStore((store) => store.setView)
  const [appId, setAppId] = useState(initialAppId)

  // Asking is what logs in with a remembered login, the first time; changes are pushed after.
  useEffect(() => {
    void window.plexo
      .steamLoginState()
      .then(receive)
      .catch(() => {})
  }, [receive])

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b-[0.5px] border-border py-3 pr-3 pl-5">
        <DialogTitle className="flex-1 py-1 text-[16px] font-semibold">Steam</DialogTitle>
        {login?.status === 'logged-in' && (
          <>
            <span className="max-w-48 truncate text-[12.5px] text-muted-foreground">
              {login.accountName}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void window.plexo.steamLogout().catch(() => {})}
            >
              Log out
            </Button>
          </>
        )}
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-5 py-4">
        {login?.status !== 'logged-in' ? (
          <SteamLogin state={login} />
        ) : appId === undefined ? (
          <SteamLibrary onPick={setAppId} />
        ) : (
          <SteamAppDetails
            appId={appId}
            onBack={() => setAppId(undefined)}
            onStarted={(id, queued) => {
              // Its own screen opens, unless it was only added to the queue.
              if (!queued) setView({ name: 'download', id })
              onClose()
            }}
          />
        )}
      </div>
    </div>
  )
}
