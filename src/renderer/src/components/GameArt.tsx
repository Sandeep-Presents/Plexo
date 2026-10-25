import { cn } from 'cn'
import { useState } from 'react'

// A game's pictures, as the main process keeps them (see main/steam/art.ts). Not every game has
// every picture: an old one may have no portrait capsule, a small one no banner. Each falls back
// to what there is, and failing everything to the game's name on a color of its own.

type ArtKind = 'capsule' | 'header' | 'hero'

const artUrl = (appId: number, kind: ArtKind): string => `game-art://steam/${appId}/${kind}`

/** A color for a game with no picture, the same every time for the same game. */
function placeholderHue(appId: number): number {
  return (appId * 47) % 360
}

function Placeholder({
  appId,
  name,
  small
}: {
  appId: number
  name: string
  small?: boolean
}): React.JSX.Element {
  const hue = placeholderHue(appId)
  return (
    <div
      className="flex size-full items-end p-3"
      style={{
        background: `linear-gradient(160deg, hsl(${hue} 45% 38%), hsl(${(hue + 40) % 360} 50% 22%))`
      }}
    >
      {/* Too small to read: the name is beside it. */}
      {!small && (
        <span className="line-clamp-4 text-left text-[15px] leading-tight font-bold text-white/95">
          {name}
        </span>
      )}
    </div>
  )
}

/** The portrait picture a library shows; a landscape header, over a blur of itself, when the
 * game has no portrait one. */
export function GameCapsule({
  appId,
  name,
  small,
  className
}: {
  appId: number
  name: string
  /** A thumbnail beside the game's name. */
  small?: boolean
  className?: string
}): React.JSX.Element {
  const [kind, setKind] = useState<ArtKind | null>('capsule')
  return (
    <div className={cn('relative size-full overflow-hidden', className)}>
      {kind === 'capsule' && (
        <img
          src={artUrl(appId, 'capsule')}
          alt=""
          draggable={false}
          onError={() => setKind('header')}
          className="size-full object-cover"
        />
      )}
      {kind === 'header' && (
        <>
          <img
            src={artUrl(appId, 'header')}
            alt=""
            aria-hidden
            draggable={false}
            className="absolute inset-0 size-full scale-125 object-cover opacity-80 blur-xl"
          />
          <img
            src={artUrl(appId, 'header')}
            alt=""
            draggable={false}
            onError={() => setKind(null)}
            className="relative size-full object-contain"
          />
        </>
      )}
      {kind === null && <Placeholder appId={appId} name={name} small={small} />}
    </div>
  )
}

/** The wide banner across the top of a game's page; its header, blurred, when it has none. */
export function GameHero({ appId }: { appId: number }): React.JSX.Element {
  const [kind, setKind] = useState<ArtKind | null>('hero')
  const hue = placeholderHue(appId)
  return (
    <div
      aria-hidden
      className="absolute inset-0 overflow-hidden"
      style={{
        background: `linear-gradient(120deg, hsl(${hue} 40% 30%), hsl(${(hue + 40) % 360} 45% 16%))`
      }}
    >
      {kind !== null && (
        <img
          src={artUrl(appId, kind)}
          alt=""
          draggable={false}
          onError={() => setKind(kind === 'hero' ? 'header' : null)}
          className={cn(
            'size-full object-cover',
            kind === 'header' && 'scale-110 opacity-70 blur-2xl'
          )}
        />
      )}
    </div>
  )
}
