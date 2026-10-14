import type { DownloadState, FinishedDownload, WhenDone } from '@shared/types'
import {
  ArrowDownUp,
  ChevronDown,
  ChevronUp,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Menu as MenuIcon,
  Package,
  Plus,
  Power,
  Search,
  X,
  type LucideIcon
} from 'lucide-react'
import { cn } from 'cn'
import { Fragment, memo, useCallback, useEffect, useState } from 'react'
import { DownloadContextMenu } from '../components/DownloadContextMenu'
import { useDownloadActions, useDownloadActionsState } from '../components/downloadActionsContext'
import { ACTION_META, toolbarLabel } from '../components/downloadActionMeta'
import { MoreActionsMenu } from '../components/MoreActionsMenu'
import { DownloadFilterMenu } from '../components/DownloadFilterMenu'
import { CombineDiagram } from '../components/CombineDiagram'
import { LimitsDialog } from '../components/LimitsDialog'
import { ScheduleIndicator } from '../components/ScheduleIndicator'
import { networkStatusText } from '../components/NetworkRow'
import { scheduleMessage, scheduleWindow } from '@shared/downloadSchedule'
import { NetworksMenu } from '../components/NetworksMenu'
import { TorrentBadge } from '../components/TorrentBadge'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '../components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { useNetworkVisuals, type ResolveNetworkVisual } from '../hooks/useNetworkVisuals'
import {
  useAppStore,
  type DownloadFilter,
  type DownloadSort,
  type TypeFilter
} from '../store/useAppStore'
import {
  describeError,
  fileCategory,
  formatAdded,
  formatBytes,
  formatEta,
  formatPercent,
  isFolder,
  wantedBytes,
  type FileCategory
} from '../utils/format'
import { useFormatSpeed } from '../hooks/useFormatSpeed'
import {
  availableActions,
  isFinished,
  rowAction,
  splitToolbar,
  type ActionId
} from '../utils/downloadActions'

type Item = DownloadState | FinishedDownload

function filterOf(item: Item): Exclude<DownloadFilter, 'all'> {
  if ('unitsWritten' in item || item.status === 'completed') return 'finished'
  return item.status === 'error' ? 'failed' : 'progress'
}

function categoryOf(item: Item): FileCategory | 'folder' {
  return isFolder(item) ? 'folder' : fileCategory(item.fileName)
}

const SORTS: { value: DownloadSort; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Size' }
]

const COMPARE: Record<DownloadSort, (a: Item, b: Item) => number> = {
  newest: (a, b) => b.startedAt - a.startedAt,
  oldest: (a, b) => a.startedAt - b.startedAt,
  name: (a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true }),
  size: (a, b) => wantedBytes(b) - wantedBytes(a)
}

const WHEN_DONE_LABEL: Record<WhenDone, string> = {
  nothing: 'Do nothing',
  quit: 'Quit Plexo',
  sleep: 'Sleep',
  shutdown: 'Shut down'
}

/** Says, while it's set, what happens once downloads finish; a click calls it off. */
function WhenDoneIndicator(): React.JSX.Element | null {
  const whenDone = useAppStore((store) => store.whenDone)
  const setWhenDone = useAppStore((store) => store.setWhenDone)
  if (whenDone === 'nothing') return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-label={`${WHEN_DONE_LABEL[whenDone]} when done. Cancel`}
            className="text-primary"
            onClick={() => setWhenDone('nothing')}
          >
            <Power data-icon="inline-start" />
            <span className="hidden lg:inline">{WHEN_DONE_LABEL[whenDone]} when done</span>
            <X data-icon="inline-end" />
          </Button>
        }
      />
      <TooltipContent>Cancel</TooltipContent>
    </Tooltip>
  )
}

const CATEGORY_ICON: Record<FileCategory | 'folder', LucideIcon> = {
  folder: Folder,
  video: FileVideo,
  audio: FileAudio,
  image: FileImage,
  document: FileText,
  archive: FileArchive,
  program: Package,
  other: File
}

/** Checkbox · Name · Size · Status · Download · (Upload, with a torrent listed) · Added, as CSS
 * variables for the grid: a narrow window leaves out Upload and Added, so Name keeps its room. */
function columns(upload: boolean): React.CSSProperties {
  const narrow = '28px minmax(0,1fr) 76px 200px 88px'
  return {
    '--cols': narrow,
    '--cols-wide': `${narrow} ${upload ? '84px ' : ''}112px`
  } as React.CSSProperties
}

const gridClass = 'grid grid-cols-[var(--cols)] gap-x-3 lg:grid-cols-[var(--cols-wide)]'
const wideOnly = 'hidden lg:block'

const headClass =
  'flex h-full items-center gap-1 text-left text-[11.5px] font-semibold text-muted-foreground'

function SortHeader({
  label,
  sorts,
  className
}: {
  label: string
  /** What a click sorts by; a second click flips between the two, when there are two. */
  sorts: DownloadSort[]
  className?: string
}): React.JSX.Element {
  const sort = useAppStore((store) => store.downloadSort)
  const setSort = useAppStore((store) => store.setDownloadSort)
  const active = sorts.includes(sort)
  return (
    <button
      type="button"
      onClick={() =>
        setSort(active && sorts.length > 1 ? sorts[1 - sorts.indexOf(sort)] : sorts[0])
      }
      className={cn(headClass, 'hover:text-foreground', active && 'text-foreground', className)}
    >
      {label}
      {active &&
        (sort === 'oldest' || sort === 'name' ? (
          <ChevronUp aria-hidden className="size-3" />
        ) : (
          <ChevronDown aria-hidden className="size-3" />
        ))}
    </button>
  )
}

export function DownloadsScreen(): React.JSX.Element {
  const downloadsById = useAppStore((store) => store.downloads)
  const history = useAppStore((store) => store.history)
  const setView = useAppStore((store) => store.setView)
  const openNewDownload = useAppStore((store) => store.openNewDownload)
  const filter = useAppStore((store) => store.downloadFilter)
  const setFilter = useAppStore((store) => store.setDownloadFilter)
  const typeFilter = useAppStore((store) => store.typeFilter)
  const setTypeFilter = useAppStore((store) => store.setTypeFilter)
  const sort = useAppStore((store) => store.downloadSort)
  const setSort = useAppStore((store) => store.setDownloadSort)
  const whenDone = useAppStore((store) => store.whenDone)
  const setWhenDone = useAppStore((store) => store.setWhenDone)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const { perform, askClearFinished } = useDownloadActions()
  const { busy } = useDownloadActionsState()
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [showSchedule, setShowSchedule] = useState(false)
  const [limitsPage, setLimitsPage] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [])

  const downloads = Object.values(downloadsById).filter(
    (download) => download.status !== 'cancelled'
  )
  const allItems: Item[] = [...downloads, ...history]
  const counts: Record<DownloadFilter, number> = {
    all: allItems.length,
    progress: 0,
    finished: 0,
    failed: 0
  }
  for (const item of allItems) counts[filterOf(item)]++
  const typeCounts: Record<TypeFilter, number> = {
    all: allItems.length,
    video: 0,
    audio: 0,
    image: 0,
    document: 0,
    archive: 0,
    program: 0,
    other: 0
  }
  for (const item of allItems) typeCounts[isFolder(item) ? 'other' : fileCategory(item.fileName)]++
  const needle = query.trim().toLowerCase()
  const items = allItems
    .filter(
      (item) =>
        (filter === 'all' || filterOf(item) === filter) &&
        (typeFilter === 'all' ||
          (isFolder(item) ? 'other' : fileCategory(item.fileName)) === typeFilter) &&
        (!needle ||
          item.fileName.toLowerCase().includes(needle) ||
          item.url.toLowerCase().includes(needle))
    )
    .sort(COMPARE[sort])
  const upload = items.some((item) => item.kind === 'torrent')
  const template = columns(upload)
  // Only what's still listed counts: one that finished or went is no longer selected.
  const chosen = items.filter((item) => selected.has(item.id))
  const allChosen = items.length > 0 && chosen.length === items.length

  const toggle = useCallback(
    (ids: string[], on: boolean): void =>
      setSelected((previous) => {
        const next = new Set(previous)
        for (const id of ids) {
          if (on) next.add(id)
          else next.delete(id)
        }
        return next
      }),
    []
  )
  // Stable, with the colors resolved once here, so a finished row skips every progress push.
  const networkVisual = useNetworkVisuals()
  const selectRow = useCallback((id: string, on: boolean) => toggle([id], on), [toggle])
  const openRow = useCallback((id: string) => setView({ name: 'download', id }), [setView])
  // Keys for the selection: Esc clears it, Select all, Space pauses or resumes, and Delete takes
  // the selected off the list (with Cmd/Ctrl, moves their files to the Trash), each asking first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      if (
        event.defaultPrevented ||
        (target instanceof HTMLElement &&
          (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) ||
        document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')
      )
        return
      const command = window.plexo.platform === 'darwin' ? event.metaKey : event.ctrlKey
      if (event.key === 'Escape') setSelected(new Set())
      else if (command && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setSelected(new Set(items.map((item) => item.id)))
      } else if (command && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        document.getElementById('download-search')?.focus()
      } else if (
        event.key === ' ' &&
        !(target instanceof HTMLElement && target.closest('button, [role="checkbox"], a'))
      ) {
        // Pause what's running in the selection; with nothing running, resume what's paused.
        const actions = availableActions(chosen).flat()
        const action =
          actions.find((available) => available.id === 'pause') ??
          actions.find((available) => available.id === 'resume')
        if (!action) return
        event.preventDefault()
        void perform(action.id, action.targets)
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        const id = command ? 'trash' : 'remove'
        const action = availableActions(chosen)
          .flat()
          .find((available) => available.id === id)
        if (!action) return
        event.preventDefault()
        void perform(id, action.targets)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [items, chosen, perform])

  // What the toolbar offers: the two actions most needed for what's selected as buttons, and
  // the rest of what the menu does for the selection behind More, so six never need more room.
  const { buttons: toolbarButtons, more: moreActions } = splitToolbar(availableActions(chosen))

  const openSchedule = (): void => {
    setLimitsPage(null)
    setShowSchedule(true)
    setLimitsOpen(true)
  }
  const openLimits = (page: string | null): void => {
    setShowSchedule(false)
    setLimitsPage(page)
    setLimitsOpen(true)
  }

  const selectAll = (
    <Checkbox
      aria-label="Select all downloads"
      checked={allChosen}
      indeterminate={chosen.length > 0 && !allChosen}
      disabled={items.length === 0}
      onCheckedChange={(on) => setSelected(on ? new Set(items.map((item) => item.id)) : new Set())}
    />
  )

  return (
    <div className="flex h-full flex-col bg-background">
      {chosen.length === 0 ? (
        <div className="flex h-14 shrink-0 items-center gap-2 border-b-[0.5px] border-border px-4">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Sort downloads"
                  className="flex h-8 items-center gap-2 rounded-lg border-[0.5px] border-border bg-card px-2.5 text-[13px] font-semibold outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ArrowDownUp aria-hidden className="size-3.5 text-muted-foreground" />
                  {SORTS.find((option) => option.value === sort)!.label}
                  <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
                </button>
              }
            />
            <DropdownMenuContent align="start" className="min-w-40">
              <DropdownMenuRadioGroup
                value={sort}
                onValueChange={(value) => setSort(value as DownloadSort)}
              >
                {SORTS.map((option) => (
                  <DropdownMenuRadioItem key={option.value} value={option.value}>
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DownloadFilterMenu
            value={filter}
            counts={counts}
            onChange={(next) => {
              setFilter(next)
              setSelected(new Set())
            }}
            type={typeFilter}
            typeCounts={typeCounts}
            onTypeChange={(next) => {
              setTypeFilter(next)
              setSelected(new Set())
            }}
          />
          <div className="flex-1" />
          <WhenDoneIndicator />
          <ScheduleIndicator onClick={openSchedule} />
          <NetworksMenu onOpenLimits={openLimits} />
          <Button type="button" aria-label="Add download" onClick={() => openNewDownload()}>
            <Plus data-icon="inline-start" />
            <span className="hidden lg:inline">Add download</span>
          </Button>
          <label className="flex h-8 w-40 items-center gap-2 rounded-lg lg:w-60 border-[0.5px] border-border bg-card px-2.5 focus-within:ring-2 focus-within:ring-ring">
            <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              id="download-search"
              type="search"
              aria-label="Search downloads"
              placeholder="Search in downloads…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button type="button" size="icon" variant="ghost" aria-label="Main menu">
                  <MenuIcon />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuItem onClick={() => openNewDownload()}>
                <Plus aria-hidden />
                Add download
              </DropdownMenuItem>
              <DropdownMenuItem onClick={openSchedule}>Download schedule</DropdownMenuItem>
              <DropdownMenuItem onClick={() => openLimits(null)}>Speed limits</DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>When downloads finish</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-36">
                  <DropdownMenuRadioGroup
                    value={whenDone}
                    onValueChange={(value) => setWhenDone(value as WhenDone)}
                  >
                    {(Object.keys(WHEN_DONE_LABEL) as WhenDone[]).map((action) => (
                      <DropdownMenuRadioItem key={action} value={action}>
                        {WHEN_DONE_LABEL[action]}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem disabled={history.length === 0} onClick={askClearFinished}>
                Clear finished list
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : (
        <div
          role="toolbar"
          aria-label="Selected downloads"
          aria-busy={busy}
          className="flex h-14 shrink-0 items-center gap-3 border-b-[0.5px] border-border px-4"
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Deselect all"
                  disabled={busy}
                  onClick={() => setSelected(new Set())}
                >
                  <X />
                </Button>
              }
            />
            <TooltipContent>Deselect all</TooltipContent>
          </Tooltip>
          <span className="shrink-0 whitespace-nowrap text-[13px] font-semibold">
            {chosen.length} selected
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy || chosen.length === items.length}
            onClick={() => setSelected(new Set(items.map((item) => item.id)))}
          >
            Select all
          </Button>
          <div className="flex-1" />
          <div className="flex min-w-0 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {toolbarButtons.map(({ id, targets }) => (
              <Button
                key={id}
                type="button"
                size="sm"
                variant={ACTION_META[id].destructive ? 'destructive' : 'secondary'}
                disabled={busy}
                onClick={() => void perform(id, targets)}
              >
                {toolbarLabel(id, targets.length)}
              </Button>
            ))}
            <MoreActionsMenu groups={moreActions} disabled={busy} />
          </div>
          <ScheduleIndicator onClick={openSchedule} />
        </div>
      )}

      {allItems.length > 0 && (
        <div
          className={cn(
            gridClass,
            'h-9 shrink-0 items-center border-b-[0.5px] border-border pr-6 pl-4'
          )}
          style={template}
        >
          {selectAll}
          <SortHeader label="Name" sorts={['name']} />
          <SortHeader label="Size" sorts={['size']} />
          <span className={headClass}>Status</span>
          <span className={headClass}>Download</span>
          {upload && <span className={cn(headClass, 'hidden lg:flex')}>Upload</span>}
          <SortHeader label="Added" sorts={['newest', 'oldest']} className="hidden lg:flex" />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {allItems.length === 0 && <EmptyState />}
        {allItems.length > 0 && items.length === 0 && (
          <div role="status" className="flex flex-col items-center gap-2 px-5 py-16 text-center">
            <p className="text-[16px] font-semibold">
              {needle
                ? `Nothing matches “${query.trim()}”`
                : filter === 'progress'
                  ? 'No downloads in progress'
                  : filter === 'finished'
                    ? 'No finished downloads'
                    : filter === 'failed'
                      ? 'No downloads need attention'
                      : 'No downloads of this type'}
            </p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setFilter('all')
                setTypeFilter('all')
                setQuery('')
              }}
            >
              Show all downloads
            </Button>
          </div>
        )}
        {items.map((item) => (
          <DownloadContextMenu
            key={item.id}
            item={item}
            selected={selected.has(item.id)}
            chosen={chosen}
          >
            <DownloadRow
              item={item}
              now={now}
              template={template}
              upload={upload}
              selected={selected.has(item.id)}
              networkVisual={
                isFinished(item) || item.status === 'completed' ? undefined : networkVisual
              }
              onSelect={selectRow}
              onOpen={openRow}
              onPerform={perform}
            />
          </DownloadContextMenu>
        ))}
      </div>

      <LimitsDialog
        open={limitsOpen}
        showSchedule={showSchedule}
        onOpenChange={setLimitsOpen}
        page={limitsPage}
        onPageChange={setLimitsPage}
      />
    </div>
  )
}

// Colors are irrelevant here — the diagram is rendered `muted`, which overrides them all to
// var(--icon-muted) — these are just three placeholder rows to draw the illustration with.
const PLACEHOLDER_NETWORKS = [
  { solid: 'var(--icon-muted)', label: 'Wi-Fi' },
  { solid: 'var(--icon-muted)', label: 'USB' },
  { solid: 'var(--icon-muted)', label: 'Ethernet' }
]
const PASTE_SHORTCUT = window.plexo.platform === 'darwin' ? '⌘V' : 'Ctrl+V'
const NEW_SHORTCUT = window.plexo.platform === 'darwin' ? '⌘N' : 'Ctrl+N'

/** Nothing listed yet: how to start one — or, with no network connected, how to get one. */
function EmptyState(): React.JSX.Element {
  const noNetworks = useAppStore(
    (store) => store.interfacesStatus === 'ready' && store.interfaces.length === 0
  )
  const loadInterfaces = useAppStore((store) => store.loadInterfaces)
  const openNewDownload = useAppStore((store) => store.openNewDownload)

  return (
    <div className="flex flex-col items-center gap-4 px-5 pt-16 pb-10 text-center">
      <CombineDiagram networks={PLACEHOLDER_NETWORKS} muted />
      {noNetworks ? (
        <>
          <div className="font-sans text-[16px] leading-[1.2] font-bold">No networks connected</div>
          <div className="max-w-[380px] text-[12.5px] leading-[1.6] text-[var(--text-secondary)]">
            Plexo needs at least one active network. Join a Wi-Fi network, plug in Ethernet, or
            connect your phone using USB tethering.
          </div>
          <div className="mt-1 flex gap-2">
            <Button type="button" variant="secondary" onClick={() => loadInterfaces()}>
              Scan again
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => window.plexo.openNetworkSettings()}
            >
              Network settings
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="font-sans text-[16px] leading-[1.2] font-bold">No downloads yet</div>
          <div className="max-w-[380px] text-[12.5px] leading-[1.6] text-[var(--text-secondary)]">
            Paste a link ({PASTE_SHORTCUT}) or drop a .torrent anywhere in this window.
          </div>
          <Button type="button" className="mt-1" onClick={() => openNewDownload()}>
            <Plus data-icon="inline-start" />
            New download
            <span className="ml-1 font-mono text-[11px] opacity-70">{NEW_SHORTCUT}</span>
          </Button>
        </>
      )}
    </div>
  )
}

const DownloadRow = memo(function DownloadRow({
  item,
  now,
  template,
  upload,
  selected,
  networkVisual,
  onSelect,
  onOpen,
  onPerform
}: {
  item: Item
  now: number
  /** The table's columns, so the row lines up with the header. */
  template: React.CSSProperties
  upload: boolean
  selected: boolean
  /** Colors its progress bar and network dots; a finished row has none. */
  networkVisual?: ResolveNetworkVisual
  onSelect: (id: string, on: boolean) => void
  onOpen: (id: string) => void
  /** Does what the row's button says, the way the menu, the toolbar and its screen do. */
  onPerform: (id: ActionId, targets: Item[]) => Promise<boolean>
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const schedule = useAppStore((store) => store.downloadSchedule)
  const [working, setWorking] = useState(false)
  const finished = isFinished(item) || item.status === 'completed'
  const wanted = wantedBytes(item)
  const percent = formatPercent(item.bytesDownloaded, wanted)
  const actionGroups = availableActions([item])
  const TypeIcon = CATEGORY_ICON[categoryOf(item)]

  let status: string
  let tone = 'text-muted-foreground'
  if (isFinished(item) || item.status === 'completed') {
    status = isFinished(item) && item.missing ? 'Moved or deleted' : 'Completed'
  } else {
    switch (item.status) {
      case 'downloading':
        status = wanted > 0 ? `${percent}%` : formatBytes(item.bytesDownloaded)
        tone = 'text-foreground'
        break
      case 'queued':
        status =
          schedule?.enabled && !scheduleWindow(schedule, now).allowed
            ? (scheduleMessage(schedule, now) ?? 'Queued')
            : 'Queued'
        break
      case 'paused':
        status = wanted > 0 ? `Paused · ${percent}%` : 'Paused'
        break
      default:
        status = describeError(item.error ?? 'Something went wrong')
        tone = 'text-[var(--color-danger)]'
    }
  }

  // Its next step, if it has one; a finished one shows where it is instead.
  const actionId: ActionId | null =
    rowAction(item) ??
    (actionGroups.flat().some((action) => action.id === 'reveal') ? 'reveal' : null)
  const action = actionId ? ACTION_META[actionId] : null

  // The bar shows each network's share of the file in its color; a failed one shows in red.
  const segments =
    finished || isFinished(item) || !networkVisual
      ? []
      : item.status === 'error'
        ? [
            {
              id: 'error',
              share: item.bytesDownloaded / (wanted || 1),
              color: 'var(--color-danger)'
            }
          ]
        : item.networks
            .filter((network) => network.bytesDownloaded > 0)
            .map((network) => ({
              id: network.id,
              share: network.bytesDownloaded / (wanted || 1),
              color: networkVisual(network.id, network.kind, network.label).solid
            }))

  // Which networks it's on, at a glance, when it isn't on all of them. One on every network says
  // nothing new, so it shows none.
  const dots =
    !finished &&
    networkVisual &&
    !isFinished(item) &&
    item.networks.some((network) => !network.enabled)
      ? item.networks.map((network) => {
          const visual = networkVisual(network.id, network.kind, network.label)
          return {
            id: network.id,
            on: network.enabled,
            color: visual.solid,
            name: visual.name,
            // Its speed while it runs; otherwise whether it's on, or what's stopping it.
            state: !network.enabled
              ? 'Off'
              : network.status !== 'on'
                ? networkStatusText(network.status, network.transfer)
                : item.status === 'downloading'
                  ? formatSpeed(network.speedBytesPerSec)
                  : 'On'
          }
        })
      : null
  const running = !finished && !isFinished(item) && item.status === 'downloading'
  const uploading =
    item.kind === 'torrent' && !isFinished(item) && item.status !== 'paused'
      ? item.uploadSpeedBytesPerSec
      : 0
  const muted = 'font-mono text-[12px] text-muted-foreground/60 tabular-nums'

  return (
    <div
      data-selected={selected || undefined}
      onDoubleClick={() => onOpen(item.id)}
      className={cn(
        gridClass,
        'group/download-row h-11 items-center border-b-[0.5px] border-border/50 pr-6 pl-4 transition-colors',
        selected
          ? 'bg-primary/10 hover:bg-primary/15 focus-within:bg-primary/15'
          : 'hover:bg-secondary focus-within:bg-secondary'
      )}
      style={template}
    >
      <Checkbox
        aria-label={`Select ${item.fileName}`}
        checked={selected}
        onCheckedChange={(on) => onSelect(item.id, on)}
      />

      {/* Name */}
      <div className="flex min-w-0 items-center gap-2">
        {action ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`${action.label} ${item.fileName}`}
                  aria-busy={working}
                  disabled={working}
                  onClick={() => {
                    setWorking(true)
                    void onPerform(actionId!, [item]).finally(() => setWorking(false))
                  }}
                  className={cn(
                    'shrink-0',
                    actionId === 'reveal' ? 'text-primary' : 'text-foreground'
                  )}
                >
                  {actionId === 'reveal' ? <FolderOpen className="size-4" /> : <action.icon />}
                </Button>
              }
            />
            <TooltipContent>
              {working && action.working ? action.working : action.label}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
            <TypeIcon className="size-4" />
          </span>
        )}
        <button
          type="button"
          aria-label={`Open ${item.fileName}`}
          title={item.fileName}
          onClick={() => onOpen(item.id)}
          className="min-w-0 truncate rounded-sm text-left text-[13.5px] font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {item.fileName}
        </button>
        {item.kind === 'torrent' && <TorrentBadge />}
        {dots && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  role="img"
                  aria-label={dots.map((dot) => `${dot.name} ${dot.state}`).join(', ')}
                  className="flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-1"
                >
                  {dots.map((dot) => (
                    <span
                      key={dot.id}
                      className={cn('size-1.5 rounded-full', !dot.on && 'bg-muted-foreground/30')}
                      style={dot.on ? { background: dot.color } : undefined}
                    />
                  ))}
                </span>
              }
            />
            <TooltipContent>
              <div className="grid grid-cols-[auto_auto_auto] items-center gap-x-2 gap-y-1">
                {dots.map((dot) => (
                  <Fragment key={dot.id}>
                    <span
                      className={cn(
                        'size-2 rounded-full',
                        !dot.on && 'border border-current opacity-60'
                      )}
                      style={dot.on ? { background: dot.color } : undefined}
                    />
                    <span>{dot.name}</span>
                    <span className="pl-3 text-right font-mono tabular-nums opacity-80">
                      {dot.state}
                    </span>
                  </Fragment>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Size */}
      <span className="truncate font-mono text-[12px] tabular-nums">
        {wanted > 0 || finished ? formatBytes(wanted || item.bytesDownloaded) : '—'}
      </span>

      {/* Status, with everything else that can be done to it behind ⋮ */}
      <div className="flex min-w-0 items-center gap-2">
        {segments.length > 0 && (
          <div
            className={cn(
              'flex h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted',
              // Not moving: the colors stay, faded, so it doesn't read as running.
              !isFinished(item) &&
                (item.status === 'paused' || item.status === 'queued') &&
                'opacity-40'
            )}
          >
            {segments.map((segment) => (
              <div
                key={segment.id}
                style={{
                  width: `${Math.min(100, segment.share * 100)}%`,
                  background: segment.color
                }}
              />
            ))}
          </div>
        )}
        <span
          title={status}
          className={cn('min-w-0 flex-1 truncate font-mono text-[12px] tabular-nums', tone)}
        >
          {status}
        </span>
        <MoreActionsMenu
          groups={actionGroups}
          label={`Actions for ${item.fileName}`}
          variant="ghost"
          vertical
        />
      </div>

      {/* Download */}
      <span className={running ? 'font-mono text-[12px] font-medium tabular-nums' : muted}>
        {running ? formatSpeed(item.speedBytesPerSec) : '—'}
      </span>

      {upload && (
        <span
          className={cn(wideOnly, uploading > 0 ? 'font-mono text-[12px] tabular-nums' : muted)}
        >
          {uploading > 0 ? formatSpeed(uploading) : '—'}
        </span>
      )}

      {/* Added, or while it downloads, how long is left */}
      <span
        className={cn(
          wideOnly,
          'truncate font-mono text-[12px] text-muted-foreground tabular-nums'
        )}
      >
        {running && item.timeLeftSeconds !== undefined
          ? formatEta(item.timeLeftSeconds)
          : formatAdded(item.startedAt, now)}
      </span>
    </div>
  )
})
