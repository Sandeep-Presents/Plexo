import { rmdir } from 'node:fs/promises'
import { shell } from 'electron'
import type { DownloadState, FinishedDownload } from '../../shared/types'
import { ownedTorrentFiles } from './torrent/ownedFiles'

/** Trash only owned torrent files; never move unrelated files added to its folder. A Steam
 * install goes to the Trash whole, as uninstalling would take it, saves and all — unless it was
 * installed into a folder that was there before, which is never trashed. */
export async function trashDownload(
  download: DownloadState | FinishedDownload,
  ownedFiles?: readonly string[]
): Promise<void> {
  if (download.kind === 'steam' && download.adopted) {
    throw new Error(
      'This game was installed into a folder that was already there, so Plexo won’t move it to the Trash. Remove it from the list, then manage the folder in your file browser.'
    )
  }
  if (download.kind !== 'torrent' || !download.folder) {
    await shell.trashItem(download.destinationPath)
    return
  }
  const files = ownedFiles ?? ('downloadedFiles' in download ? download.downloadedFiles : undefined)
  if (!files?.length) {
    throw new Error(
      'Plexo can’t identify the files in this older torrent. Remove it from the list or manage its files in your file browser.'
    )
  }
  const { targets, folders } = await ownedTorrentFiles(download.destinationPath, files)
  for (const target of targets) await shell.trashItem(target)
  for (const folder of folders) await rmdir(folder).catch(() => {})
}
