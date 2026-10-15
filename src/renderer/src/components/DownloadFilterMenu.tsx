import { Menu } from '@base-ui/react/menu'
import { Check, ChevronDown, Filter } from 'lucide-react'
import type { DownloadFilter, TypeFilter } from '../store/useAppStore'

const DOWNLOAD_FILTERS: { value: DownloadFilter; label: string }[] = [
  { value: 'all', label: 'All downloads' },
  { value: 'progress', label: 'In progress' },
  { value: 'finished', label: 'Finished' },
  { value: 'failed', label: 'Needs attention' }
]

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All files' },
  { value: 'video', label: 'Video' },
  { value: 'audio', label: 'Audio' },
  { value: 'image', label: 'Images' },
  { value: 'document', label: 'Documents' },
  { value: 'archive', label: 'Archives' },
  { value: 'program', label: 'Programs' },
  { value: 'other', label: 'Other' }
]

const itemClass =
  'flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] outline-none data-checked:bg-muted data-highlighted:bg-muted'
const groupLabelClass =
  'px-2 pt-1.5 pb-1 font-mono text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase'

function RadioItems<T extends string>({
  options,
  counts
}: {
  options: { value: T; label: string }[]
  counts: Record<T, number>
}): React.JSX.Element[] {
  return options.map((option) => (
    <Menu.RadioItem
      key={option.value}
      value={option.value}
      label={option.label}
      closeOnClick
      className={itemClass}
    >
      <span className="size-4 shrink-0">
        <Menu.RadioItemIndicator>
          <Check aria-hidden className="size-4 text-primary" />
        </Menu.RadioItemIndicator>
      </span>
      <span className="flex-1">{option.label}</span>
      <span className="font-mono text-[11.5px] text-muted-foreground tabular-nums">
        {counts[option.value]}
      </span>
    </Menu.RadioItem>
  ))
}

/** The list's filter: by where a download is, and by what kind of file it is. */
export function DownloadFilterMenu({
  value,
  counts,
  onChange,
  type,
  typeCounts,
  onTypeChange
}: {
  value: DownloadFilter
  counts: Record<DownloadFilter, number>
  onChange: (value: DownloadFilter) => void
  type: TypeFilter
  typeCounts: Record<TypeFilter, number>
  onTypeChange: (value: TypeFilter) => void
}): React.JSX.Element {
  const label = [
    value !== 'all' && DOWNLOAD_FILTERS.find((filter) => filter.value === value)!.label,
    TYPE_FILTERS.find((filter) => filter.value === type)!.label
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <Menu.Root>
      <h1>
        <Menu.Trigger className="flex h-8 items-center gap-2 rounded-lg border-[0.5px] border-border bg-card px-2.5 font-sans text-[13px] leading-none font-semibold outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring">
          <Filter aria-hidden className="size-3.5 text-muted-foreground" />
          {label}
          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
        </Menu.Trigger>
      </h1>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={8} className="isolate z-50">
          <Menu.Popup className="w-56 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none">
            <div className={groupLabelClass}>Status</div>
            <Menu.RadioGroup
              value={value}
              onValueChange={onChange}
              aria-label="Filter downloads"
              className="flex flex-col gap-0.5"
            >
              {RadioItems({ options: DOWNLOAD_FILTERS, counts })}
            </Menu.RadioGroup>
            <Menu.Separator className="mx-1 my-1.5 h-px bg-border" />
            <div className={groupLabelClass}>File type</div>
            <Menu.RadioGroup
              value={type}
              onValueChange={onTypeChange}
              aria-label="Filter by file type"
              className="flex flex-col gap-0.5"
            >
              {RadioItems({ options: TYPE_FILTERS, counts: typeCounts })}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
