import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Keeps the Steam login the window shows as main says it is. Listening reaches out to no one:
 * Steam is only contacted once the Steam dialog asks for the login (see steamLoginState). */
export function useSteamEvents(): void {
  const receive = useAppStore((store) => store.receiveSteamLogin)
  useEffect(() => window.plexo.onSteamLoginState(receive), [receive])
}
