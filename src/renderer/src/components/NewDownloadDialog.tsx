import type { ProbeResult, StartDownloadRequest } from '@shared/types'
import { cn } from 'cn'
import { AlertTriangle, ChevronLeft, ChevronRight, FolderOpen, Globe, Lock, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useFormatSpeedLimit } from '../hooks/useFormatSpeed'
import { useNetworkUsage } from '../hooks/useNetworks'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useDownloadSchedule } from '../hooks/useDownloadSchedule'
import { useAppStore } from '../store/useAppStore'
import {
  acceptedLink,
  acceptedLinks,
  describeError,
  describeFileCount,
  fileExtensionBadge,
  formatBytes,
  sourceOf,
  toDisplayPath
} from '../utils/format'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { TorrentFileList } from './TorrentFiles'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

type ProbeState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'ready'; result: ProbeResult }
  | { status: 'error'; message: string }

const PROBE_DEBOUNCE_MS = 600
/** Links checked at once; many links pasted together don't all open a connection at the same time. */
const PROBE_CONCURRENCY = 4

interface LinkEntry {
  url: string
  accepted: boolean
}

/** One link per line, so a batch starts from what the user pasted. */
function linkEntries(text: string): LinkEntry[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((url) => ({ url, accepted: acceptedLink(url) !== null }))
}

/** A link can be split across connections and has a size to divide. */
function splittable(result: ProbeResult): boolean {
  return result.supportsRanges && result.totalBytes !== null
}

type StreamsChoice = 'auto' | number
/** Streams per network the user can pick instead of Auto. */
const STREAMS_CHOICES: StreamsChoice[] = ['auto', 4, 8, 16, 32]

const labelClass = 'w-16 shrink-0 text-[12.5px] text-[var(--text-secondary)]'

/** New download: one or more links, then only what differs from one download to the next — its
 * name (or a torrent's files), where it goes, over which networks, and how many streams each runs.
 * Everything set once for every download lives in Speed & data limits and the networks menu. */
export function NewDownloadDialog(): React.JSX.Element {
  const open = useAppStore((store) => store.newDownloadOpen)
  const close = useAppStore((store) => store.closeNewDownload)
  const formKey = useAppStore((store) => store.formKey)

  return (
    <Dialog open={open} disablePointerDismissal onOpenChange={(next) => !next && close()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100%-2rem)] flex-col gap-0 p-0 sm:max-w-[560px]"
      >
        {/* Mounted only while open, and keyed by what it shows, so each opening and each
            download stacked in it starts fresh. */}
        {open && <NewDownloadForm key={formKey} onDone={close} />}
      </DialogContent>
    </Dialog>
  )
}

function NewDownloadForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { schedule, window: scheduleWindow } = useDownloadSchedule()
  const scheduledWait = schedule?.enabled && !scheduleWindow.allowed
  const interfaces = useAppStore((store) => store.interfaces)
  const homeDir = useAppStore((store) => store.homeDir)
  const url = useAppStore((store) => store.draftUrl)
  const setUrl = useAppStore((store) => store.setDraftUrl)
  const links = useAppStore((store) => store.links)
  const shownId = useAppStore((store) => store.shownId)
  const showLink = useAppStore((store) => store.showLink)
  const finishLink = useAppStore((store) => store.finishLink)
  const dropLink = useAppStore((store) => store.dropLink)
  const shownLink = links.find((link) => link.id === shownId)
  const position = shownLink ? links.indexOf(shownLink) : -1
  const destinationDir = useAppStore((store) => store.destinationDir)
  const setDestinationDir = useAppStore((store) => store.setDestinationDir)
  const full = useAppStore(
    (store) =>
      Object.values(store.downloads).filter((download) => download.status === 'downloading')
        .length >= store.downloadsAtOnce
  )
  const networkVisual = useNetworkVisuals()
  const networkPreferences = useAppStore((store) => store.networkPreferences)
  const setNetworkPreference = useAppStore((store) => store.setNetworkPreference)
  const usage = useNetworkUsage(true)
  const formatSpeedLimit = useFormatSpeedLimit()
  const linkInput = useRef<HTMLTextAreaElement>(null)

  const [probes, setProbes] = useState<Record<string, ProbeState>>({})
  // Kept current for the probing effect, which must not re-run whenever a probe changes.
  const probesRef = useRef(probes)
  probesRef.current = probes
  // Tracks deselections rather than selections, so a newly-detected interface starts selected.
  // Starts from the last download's pick: the networks it left out are saved as `off`.
  const [deselectedInterfaceIds, setDeselectedInterfaceIds] = useState<string[]>(() =>
    Object.entries(useAppStore.getState().networkPreferences)
      .filter(([, preference]) => preference.off)
      .map(([id]) => id)
  )
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [fileNameOverride, setFileNameOverride] = useState<string | null>(null)
  // A torrent's files left out, by index: every file is downloaded unless unticked.
  const [skippedFiles, setSkippedFiles] = useState<number[]>([])
  // For this download only: the next one starts on Auto again.
  const [streamsChoice, setStreamsChoice] = useState<StreamsChoice>('auto')

  // Opened with nothing in it: a link on the clipboard is most likely what it's for, as download
  // managers have long assumed. Anything else on the clipboard is left alone.
  useEffect(() => {
    if (useAppStore.getState().draftUrl) return
    void window.plexo
      .readClipboardText()
      .then((text) => {
        const links = acceptedLinks(text)
        const { draftUrl, startedUrl } = useAppStore.getState()
        const draft = links.join('\n')
        if (draft && draft !== startedUrl && !draftUrl) setUrl(draft)
      })
      .catch(() => {})
  }, [setUrl])

  useEffect(() => {
    const trimmed = url.trim()
    if (!trimmed) {
      // Resetting derived probe state when its trigger (the URL) is cleared.
      setProbes({})
      setFileNameOverride(null)
      setSkippedFiles([])
      return
    }

    // Checking here would go without the browser's sign-in, and could spend a single-use link.
    const { links: stacked, shownId: shown } = useAppStore.getState()
    const given = stacked.find((link) => link.id === shown)
    if (given && given.url !== trimmed) dropLink(given.id, false)
    setFileNameOverride(null)
    setSkippedFiles([])
    const entries = linkEntries(trimmed)
    if (given?.url === trimmed && given.probe && entries.length === 1) {
      setProbes({ ...probesRef.current, [trimmed]: { status: 'ready', result: given.probe } })
      return
    }

    const current = probesRef.current
    const missing = entries.filter(
      (entry) =>
        entry.accepted &&
        (current[entry.url] === undefined || current[entry.url].status === 'probing')
    )
    if (missing.length === 0) return

    // Set once the links change, cleared included: a magnet can take a while to answer, and its
    // answer is no longer wanted then.
    let stale = false
    setProbes((previous) => {
      const next = { ...previous }
      for (const entry of missing) next[entry.url] = { status: 'probing' }
      return next
    })
    const timer = setTimeout(async () => {
      const queue = missing.map((entry) => entry.url)
      const probeNext = async (): Promise<void> => {
        while (queue.length > 0 && !stale) {
          const url = queue.shift()!
          try {
            const result = await window.plexo.probeUrl(url)
            if (stale) return
            setProbes((previous) => ({ ...previous, [url]: { status: 'ready', result } }))
          } catch (error) {
            if (stale) return
            setProbes((previous) => ({
              ...previous,
              [url]: { status: 'error', message: describeError(error) }
            }))
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, () => probeNext())
      )
    }, PROBE_DEBOUNCE_MS)

    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [url, dropLink])

  const entries = linkEntries(url)
  const many = entries.length > 1
  const entryViews = entries.map((entry) => ({
    ...entry,
    probe: entry.accepted
      ? (probes[entry.url] ?? { status: 'idle' as const })
      : ({ status: 'error', message: 'Not a link Plexo can download.' } as const)
  }))
  // The full form for one link: its name, a torrent's files, and streams.
  const single = entries.length === 1 ? entryViews[0] : null
  const probe: ProbeState = single?.probe ?? { status: 'idle' }
  const ready = probe.status === 'ready' ? probe.result : null
  const torrent = ready?.kind === 'torrent' ? ready.torrent : null
  const chosenFiles = torrent
    ? torrent.files.flatMap((_, index) => (skippedFiles.includes(index) ? [] : [index]))
    : []
  // What will be downloaded: a torrent's chosen files, or the whole file.
  const sizeToFetch = torrent
    ? chosenFiles.reduce((sum, index) => sum + torrent.files[index].length, 0)
    : (ready?.totalBytes ?? null)
  const multiChunkAllowed = ready !== null && splittable(ready)
  const isSingleStreamOnly = ready !== null && !multiChunkAllowed

  const detectedIds = interfaces.map((iface) => iface.id)
  // A network that has used up its data limit can't carry anything, so it can't be picked.
  const isReached = (id: string): boolean => {
    const dataLimit = networkPreferences[id]?.dataLimit
    return dataLimit !== undefined && (usage[id] ?? 0) >= dataLimit
  }
  const availableIds = detectedIds.filter((id) => !isReached(id))
  const pickedIds = availableIds.filter((id) => !deselectedInterfaceIds.includes(id))
  // The last pick may be all used up. Then nothing is picked, rather than what was left out: a
  // network left out is often left out on purpose (a phone's metered data), so it's chosen here
  // by hand, never stood in for the one that ran out.
  const selectedInterfaceIds = isSingleStreamOnly ? pickedIds.slice(0, 1) : pickedIds
  // The networks of the last pick that have used up their data, to say why nothing is picked.
  const usedUpPick =
    pickedIds.length === 0 && availableIds.length > 0
      ? interfaces.filter(
          (iface) => isReached(iface.id) && !deselectedInterfaceIds.includes(iface.id)
        )
      : []

  // Every link has to be checked before the batch starts: one still being looked at would be
  // silently left out.
  const allReady =
    entryViews.length > 0 && entryViews.every((view) => view.probe.status === 'ready')
  const canStart =
    allReady &&
    (!torrent || chosenFiles.length > 0) &&
    selectedInterfaceIds.length > 0 &&
    Boolean(destinationDir) &&
    !starting
  const startLabel = starting
    ? 'Starting'
    : entryViews.some((view) => view.probe.status === 'probing')
      ? 'Checking'
      : scheduledWait
        ? 'Add to scheduled queue'
        : full
          ? 'Add to queue'
          : many
            ? `Download ${entryViews.length}`
            : 'Download'
  const showStreams =
    (ready !== null && !torrent && !isSingleStreamOnly) ||
    entryViews.some(
      (view) =>
        view.probe.status === 'ready' &&
        view.probe.result.kind === 'http' &&
        splittable(view.probe.result)
    )

  // Two networks on one subnet: the OS sends both down one route, so there's nothing to combine.
  let subnetConflict: { subnet: string; names: string[] } | null = null
  if (selectedInterfaceIds.length > 1) {
    const subnets = new Map<string, string[]>()
    for (const id of selectedInterfaceIds) {
      const iface = interfaces.find((i) => i.id === id)
      const subnet = iface?.addresses.find((address) => address.family === 4)?.subnet
      if (subnet && iface) {
        const names = subnets.get(subnet) ?? []
        names.push(networkVisual(iface.id, iface.kind, iface.displayName).name)
        subnets.set(subnet, names)
      }
    }
    for (const [subnet, names] of subnets.entries()) {
      if (names.length > 1) {
        subnetConflict = { subnet, names }
        break
      }
    }
  }

  const handleToggleInterface = (id: string): void => {
    if (isReached(id)) return
    if (isSingleStreamOnly) {
      // Single-stream mode can only download through 1 interface at a time
      setDeselectedInterfaceIds(detectedIds.filter((otherId) => otherId !== id))
      return
    }
    setDeselectedInterfaceIds((prev) => {
      if (prev.includes(id)) return prev.filter((entry) => entry !== id)
      // Keep at least 1 interface selected
      const remaining = availableIds.filter((other) => !prev.includes(other) && other !== id)
      return remaining.length === 0 ? prev : [...prev, id]
    })
  }

  const handleBrowse = async (): Promise<void> => {
    const chosen = await window.plexo.chooseDestinationFolder(destinationDir)
    if (chosen) setDestinationDir(chosen)
  }

  // A .torrent file goes in the link field as its path; the probe reads it from there. With links
  // already in it, it joins them as another one.
  const handleOpenTorrent = async (): Promise<void> => {
    const path = await window.plexo.chooseTorrentFile()
    if (!path) return
    setUrl(shownLink || !url.trim() ? path : `${url.trimEnd()}\n${path}`)
  }

  const removeEntry = (index: number): void => {
    setStartError(null)
    setUrl(entryViews.flatMap((entry, at) => (at === index ? [] : [entry.url])).join('\n'))
  }

  const handleResume = async (): Promise<void> => {
    const link = shownLink
    const resumes = link?.resumes
    if (!link || !resumes) return
    setStarting(true)
    setStartError(null)
    try {
      await window.plexo.resumeFromLink(link.id, resumes.id)
      useAppStore.setState({ view: { name: 'download', id: resumes.id } })
      finishLink(link.id, true)
    } catch (error) {
      setStartError(describeError(error))
      setStarting(false)
    }
  }

  const requestFor = (result: ProbeResult): StartDownloadRequest => {
    const common = {
      url: result.finalUrl,
      destinationDir,
      suggestedFileName: single
        ? fileNameOverride?.trim() || result.suggestedFileName
        : result.suggestedFileName,
      totalBytes: result.totalBytes ?? 0,
      supportsRanges: splittable(result),
      // A file that can't be split runs on one network: the first one picked.
      interfaceIds:
        result.kind === 'http' && !splittable(result)
          ? selectedInterfaceIds.slice(0, 1)
          : selectedInterfaceIds,
      etag: result.etag,
      lastModified: result.lastModified
    }
    return result.kind === 'torrent'
      ? {
          ...common,
          kind: 'torrent',
          infoHash: result.torrent.infoHash,
          selectedFiles: single && skippedFiles.length > 0 ? chosenFiles : undefined
        }
      : {
          ...common,
          kind: 'http',
          streamsPerNetwork: streamsChoice === 'auto' ? undefined : streamsChoice
        }
  }

  const handleStart = async (): Promise<void> => {
    if (!canStart) return
    // Captured now: links can arrive and change what's shown while this starts.
    const linkId = many ? undefined : shownLink?.id
    const form = useAppStore.getState().formKey
    const started: string[] = []
    const failures: { url: string; message: string }[] = []
    setStarting(true)
    setStartError(null)
    try {
      for (const view of entryViews) {
        if (view.probe.status !== 'ready') continue
        try {
          started.push(await window.plexo.startDownload(requestFor(view.probe.result), linkId))
        } catch (error) {
          failures.push({ url: view.url, message: describeError(error) })
        }
      }
      // Remembered for the next download, like the folder. Not a single-stream pick: that's one
      // network because the file allows no more, not because the others were unwanted.
      if (!isSingleStreamOnly) {
        for (const id of availableIds) {
          const off = !selectedInterfaceIds.includes(id)
          if (off !== Boolean(networkPreferences[id]?.off)) {
            setNetworkPreference(id, { off: off || undefined })
          }
        }
      }
      // What was started is still on the clipboard: not offered again on the next opening.
      useAppStore.setState({
        startedUrl: entryViews.map((entry) => entry.url).join('\n')
      })

      if (failures.length > 0) {
        setStartError(
          failures.length === entryViews.length
            ? `Couldn’t start: ${failures[0].message}`
            : `${failures.length} of ${entryViews.length} couldn’t start: ${failures[0].message}`
        )
        // Only the ones to try again stay: the rest are under way.
        setUrl(failures.map((failure) => failure.url).join('\n'))
        setStarting(false)
        return
      }

      // Started: the link is spent, so the next download starts from an empty one. Its own
      // screen opens for one, unless it was only added to the queue; a batch leaves the list.
      useAppStore.setState({
        ...(!many && !full && !scheduledWait && started[0]
          ? { view: { name: 'download', id: started[0] } as const }
          : {})
      })
      if (linkId) {
        finishLink(linkId, true)
      } else if (useAppStore.getState().formKey === form) {
        // Only while this form is still the one shown: closing would dismiss a link that arrived.
        useAppStore.setState({ draftUrl: '' })
        onDone()
      }
    } catch (error) {
      setStartError(describeError(error))
      setStarting(false)
    }
  }

  const fileName = ready ? (fileNameOverride ?? ready.suggestedFileName) : ''

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        void handleStart()
      }}
    >
      <div className="flex items-center gap-2 border-b-[0.5px] border-border py-3 pr-3 pl-5">
        <DialogTitle className="flex-1 py-1 text-[16px] font-semibold">
          {many ? 'New downloads' : 'New download'}
        </DialogTitle>
        {shownLink && links.length > 1 && (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Previous download"
              disabled={position === 0}
              onClick={() => showLink(links[position - 1].id)}
            >
              <ChevronLeft />
            </Button>
            <span className="min-w-12 text-center font-mono text-[11.5px] text-muted-foreground tabular-nums">
              {position + 1} of {links.length}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Next download"
              disabled={position === links.length - 1}
              onClick={() => showLink(links[position + 1].id)}
            >
              <ChevronRight />
            </Button>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-5 py-4">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-[9px] border bg-[var(--input-bg)] px-3 py-1',
              entryViews.some((view) => view.probe.status === 'error')
                ? 'border-destructive'
                : 'border-input'
            )}
          >
            <textarea
              ref={linkInput}
              autoFocus
              rows={Math.min(6, Math.max(1, entries.length))}
              value={url}
              onChange={(event) => {
                setStartError(null)
                setUrl(event.target.value)
              }}
              onKeyDown={(event) => {
                // Enter still starts one link, as it always has; Shift+Enter adds a line. With
                // several, Enter is a line break and Ctrl/Cmd+Enter starts them.
                const command = event.metaKey || event.ctrlKey
                if (event.key === 'Enter' && !event.shiftKey && (command || entries.length <= 1)) {
                  event.preventDefault()
                  void handleStart()
                }
              }}
              placeholder="Paste links, one per line: https:// or magnet:"
              spellCheck={false}
              aria-label="Link"
              className="min-w-0 flex-1 resize-none border-none bg-transparent py-1 font-mono text-[13px] leading-[1.5] text-foreground outline-none"
            />
            {url && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => {
                        setUrl('')
                        linkInput.current?.focus()
                      }}
                      aria-label="Clear link"
                      className="flex size-5 shrink-0 cursor-default items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      <X aria-hidden className="size-3.5" />
                    </button>
                  }
                />
                <TooltipContent>Clear link</TooltipContent>
              </Tooltip>
            )}
          </div>
          <Button type="button" variant="secondary" onClick={handleOpenTorrent} className="h-9">
            <FolderOpen data-icon="inline-start" />
            Open .torrent
          </Button>
        </div>

        {shownLink?.from && (
          <div className="flex h-6 items-center gap-1.5 self-start rounded-full border-[0.5px] border-[var(--color-wifi-border)] bg-[var(--color-wifi-bg)] px-2.5 text-[12px] font-medium text-[var(--color-wifi-text)]">
            {shownLink.signedInTo ? (
              <Lock aria-hidden className="size-3" />
            ) : (
              <Globe aria-hidden className="size-3" />
            )}
            {[
              `From ${shownLink.from}`,
              shownLink.signedInTo && `with your ${shownLink.signedInTo} sign-in`
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        )}

        {shownLink?.resumes && (
          <div className="flex items-center gap-3 rounded-lg border-[0.5px] border-border bg-card px-3 py-2 text-[12.5px]">
            <span className="min-w-0 flex-1">
              Same file as <span className="font-medium">{shownLink.resumes.fileName}</span>, which
              failed. Resume that instead?
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={starting}
              onClick={() => void handleResume()}
            >
              Resume it
            </Button>
          </div>
        )}

        {many && (
          <div role="list" aria-label="Links" className="flex flex-col gap-1">
            {entryViews.map((entry, index) => {
              const result = entry.probe.status === 'ready' ? entry.probe.result : null
              const name = result?.suggestedFileName ?? sourceOf(entry.url)
              const detail =
                entry.probe.status === 'probing'
                  ? 'Checking…'
                  : entry.probe.status === 'error'
                    ? entry.probe.message
                    : result
                      ? [
                          result.kind === 'torrent' &&
                            `${describeFileCount(result.torrent.files.length, result.torrent.files.length)} (all)`,
                          result.totalBytes !== null
                            ? formatBytes(result.totalBytes)
                            : 'size unknown',
                          result.kind === 'http' && !splittable(result) ? 'one connection' : null
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : 'Waiting to be checked'
              return (
                <div
                  role="listitem"
                  key={`${index}-${entry.url}`}
                  className="flex items-center gap-2 rounded-[9px] border-[0.5px] border-border bg-card px-2.5 py-1.5"
                >
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-md border-[0.5px] border-border bg-background font-mono text-[9px] font-semibold text-muted-foreground">
                    {result?.kind === 'torrent'
                      ? 'TOR'
                      : result
                        ? fileExtensionBadge(result.suggestedFileName)
                        : '…'}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="truncate text-[12.5px] font-medium">{name}</div>
                    <div
                      className={cn(
                        'truncate font-mono text-[11px]',
                        entry.probe.status === 'error'
                          ? 'text-[var(--color-danger)]'
                          : 'text-muted-foreground'
                      )}
                    >
                      {detail}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${name}`}
                    onClick={() => removeEntry(index)}
                    className="flex size-5 shrink-0 cursor-default items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {probe.status === 'probing' && (
          <div className="font-mono text-[11.5px] text-muted-foreground">Checking the link…</div>
        )}
        {probe.status === 'error' && (
          <div className="flex items-center gap-2 text-[12.5px] text-[var(--color-danger)]">
            <AlertTriangle className="size-4 shrink-0" />
            {probe.message}
          </div>
        )}

        {ready && (
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border-[0.5px] border-border bg-card font-mono text-[10px] font-semibold text-muted-foreground">
              {torrent && torrent.files.length > 1 ? 'DIR' : fileExtensionBadge(fileName)}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {torrent ? (
                <div className="truncate text-[14px] font-medium">{ready.suggestedFileName}</div>
              ) : (
                <input
                  type="text"
                  value={fileName}
                  onChange={(event) => setFileNameOverride(event.target.value)}
                  aria-label="File name"
                  spellCheck={false}
                  className="min-w-0 rounded-md border border-transparent bg-transparent px-1 -ml-1 text-[14px] font-medium outline-none hover:border-input focus:border-input"
                />
              )}
              <div className="font-mono text-[11.5px] text-muted-foreground">
                {[
                  torrent && describeFileCount(chosenFiles.length, torrent.files.length),
                  sizeToFetch !== null ? formatBytes(sizeToFetch) : 'size unknown',
                  !torrent &&
                    (isSingleStreamOnly
                      ? ready.supportsRanges
                        ? 'Uses one connection. The file size is unknown.'
                        : 'Uses one connection. This server doesn’t support parallel downloads.'
                      : 'resumable')
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
          </div>
        )}

        {torrent && (
          <TorrentFileList
            files={torrent.files}
            skipped={skippedFiles}
            onChange={setSkippedFiles}
          />
        )}

        <div className="flex items-center gap-3">
          <div className={labelClass}>Save to</div>
          <div className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
            {toDisplayPath(destinationDir, homeDir)}
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={handleBrowse}>
            Change
          </Button>
        </div>

        <div className="flex items-start gap-3">
          <div className={cn(labelClass, 'pt-1.5')} id="new-download-networks">
            Networks
          </div>
          <div
            role="group"
            aria-labelledby="new-download-networks"
            className="flex min-w-0 flex-1 flex-wrap gap-1.5"
          >
            {interfaces.map((iface) => {
              const visual = networkVisual(iface.id, iface.kind, iface.displayName)
              const selected = selectedInterfaceIds.includes(iface.id)
              const reached = isReached(iface.id)
              const speedLimit = networkPreferences[iface.id]?.speedLimit
              // What's worth knowing before it's picked: it can't be, or it's capped.
              const note = reached
                ? 'Data limit reached'
                : speedLimit !== undefined
                  ? `Limited to ${formatSpeedLimit(speedLimit)}`
                  : null
              const chip = (
                <button
                  key={iface.id}
                  type="button"
                  aria-pressed={selected}
                  // Not `disabled`: a disabled button never gets the hover that says why.
                  aria-disabled={reached || undefined}
                  onClick={() => handleToggleInterface(iface.id)}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition-colors',
                    selected
                      ? 'border-transparent'
                      : 'border-border text-[var(--text-secondary)] opacity-70',
                    reached && 'cursor-not-allowed line-through opacity-50'
                  )}
                  style={
                    selected ? { background: visual.bg, borderColor: visual.border } : undefined
                  }
                >
                  <span className="size-2 rounded-full" style={{ background: visual.solid }} />
                  {visual.name}
                </button>
              )
              return note === null ? (
                chip
              ) : (
                <Tooltip key={iface.id}>
                  <TooltipTrigger render={chip} />
                  <TooltipContent>{note}</TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        </div>

        {/* A torrent's speed comes from its peers, and an unsplittable file has one stream. */}
        {showStreams && (
          <div className="flex items-center gap-3">
            <div className={labelClass} id="new-download-streams">
              Streams
            </div>
            <ToggleGroup
              value={[String(streamsChoice)]}
              onValueChange={(values) => {
                if (values.length === 0) return
                setStreamsChoice(values[0] === 'auto' ? 'auto' : Number(values[0]))
              }}
              aria-labelledby="new-download-streams"
              variant="pill"
              size="xs"
              spacing={1}
            >
              {STREAMS_CHOICES.map((choice) => (
                // h-6/min-w-6: WCAG 2.5.8's 24px floor — the xs toggle size is 20px.
                <ToggleGroupItem key={choice} value={String(choice)} className="h-6 min-w-6 px-2">
                  {choice === 'auto' ? 'Auto' : choice}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="font-mono text-[11px] text-muted-foreground">per network</div>
          </div>
        )}

        {subnetConflict && (
          <div className="flex items-start gap-2 text-[12px] leading-snug text-[var(--color-usb-text)]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {subnetConflict.names.join(' and ')} share a subnet ({subnetConflict.subnet}), so the
            computer sends both down one route and they can’t be combined.
          </div>
        )}
        {usedUpPick.length > 0 && (
          <div className="flex items-start gap-2 text-[12px] leading-snug text-[var(--color-usb-text)]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {usedUpPick
              .map((iface) => networkVisual(iface.id, iface.kind, iface.displayName).name)
              .join(' and ')}{' '}
            {usedUpPick.length === 1 ? 'has' : 'have'} reached{' '}
            {usedUpPick.length === 1 ? 'its' : 'their'} data limit. Choose another network for this
            download.
          </div>
        )}
        {interfaces.length > 0 && availableIds.length === 0 && (
          <div className="flex items-start gap-2 text-[12px] leading-snug text-[var(--color-usb-text)]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            Every network has reached its data limit. Raise one in Speed &amp; data limits.
          </div>
        )}
        {isSingleStreamOnly && selectedInterfaceIds.length === 1 && interfaces.length > 1 && (
          <div className="text-[12px] text-muted-foreground">
            This download uses one connection on one network.
          </div>
        )}
        {many &&
          entryViews.some(
            (view) =>
              view.probe.status === 'ready' &&
              view.probe.result.kind === 'http' &&
              !splittable(view.probe.result)
          ) && (
            <div className="text-[12px] text-muted-foreground">
              Links that can’t be split use one connection each.
            </div>
          )}
      </div>

      <div className="flex items-center gap-2 border-t-[0.5px] border-border px-4 py-2">
        {startError ? (
          <div className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-danger)]">
            {startError}
          </div>
        ) : (
          <div className="flex-1" />
        )}
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canStart}>
          {startLabel}
        </Button>
      </div>
    </form>
  )
}
