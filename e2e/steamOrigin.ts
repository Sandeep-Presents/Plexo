import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import {
  buildManifest,
  seeded,
  type Compression,
  type FixtureChunk,
  type FixtureFile,
  type FixtureManifest,
  sha256
} from './steamContent'

/**
 * Steam, as the e2e tests stand it up: the control plane steam/fakeBackend.ts talks to (login,
 * licenses, appinfo, depot keys, request codes, content servers, CDN tokens), and content servers
 * that send depot manifests and chunks built the way Steam's own tools build them. A Steam
 * download runs against it from login to the last chunk, over Plexo's own pinned connections.
 *
 * Each content server can be told to misbehave per request, and to hold a response until the
 * test lets it go.
 */

export const ACCOUNT = { name: 'plexo_tester', password: 'correct horse battery staple' }
export const GUARD_CODE = 'K7PQ2'

/** What a content server does with one request. */
export type SteamFault =
  | 'ok'
  | 'stallHeaders'
  | 'stallBody'
  /** One byte more than the body. */
  | 'overlong'
  | { status: number; headers?: Record<string, string> }
  | { cutAfter: number }
  | { endAfter: number }
  | { crawl: number }
  /** The right length, one byte flipped: a damaged copy. */
  | { corruptAt: number }

export interface SteamRequest {
  /** 1-based, across every content server. */
  n: number
  /** Which content server: 0 or 1. */
  server: number
  kind: 'chunk' | 'manifest' | 'other'
  depotId: number
  /** A chunk's SHA-1, hex. */
  sha?: string
  /** Source address: which "network" it came in on. */
  from: string
  token: string | null
}

export interface LoggedSteamRequest extends SteamRequest {
  at: number
  fault: SteamFault
  status: number
  bytesSent: number
}

export interface SteamDepotFixture {
  depotId: number
  name: string
  manifestId: string
  key: Buffer
  files: FixtureFile[]
  owned: boolean
  dlcAppId?: number
  encryptNames?: boolean
  compression?: (index: number) => Compression
}

export interface SteamAppFixture {
  appId: number
  name: string
  installDir: string
  depots: SteamDepotFixture[]
}

const CHUNK = 64 * 1024

/**
 * A small game with everything a real one can have that matters to an install: chunks compressed
 * all three ways, the same chunk in several places, an empty file, nested folders, an
 * executable, a symbolic link, encrypted file names, a DLC depot, and a depot the account isn't
 * licensed for. `scale` multiplies the big files, for tests that need more chunks.
 */
export function syntheticApp(seed = 1, scale = 1): SteamAppFixture {
  const block = seeded(CHUNK, seed + 3)
  const level = Buffer.concat([
    block,
    block,
    seeded(CHUNK * scale, seed + 4),
    block,
    seeded(20_000, seed + 5)
  ])
  return {
    appId: 4000,
    name: 'Plexo Test Game',
    installDir: 'Plexo Test Game',
    depots: [
      {
        depotId: 4001,
        name: 'Plexo Test Game Content',
        manifestId: '7000000000000000001',
        key: keyFor(seed, 1),
        owned: true,
        encryptNames: true,
        files: [
          { name: 'bin', flags: 64 },
          { name: 'bin/game', data: seeded(200_000 * scale, seed + 1), flags: 32 },
          { name: 'data/level1.pak', data: level },
          { name: 'data/empty.txt', data: Buffer.alloc(0) },
          { name: 'data/nested/deep/readme.txt', data: seeded(20_000, seed + 6, true) },
          { name: 'game.sh', flags: 512, linkTarget: 'bin/game' }
        ]
      },
      {
        depotId: 4002,
        name: 'Plexo Test Game Extras',
        manifestId: '7000000000000000002',
        key: keyFor(seed, 2),
        owned: true,
        files: [
          { name: 'extras/manual.txt', data: seeded(150_000, seed + 7, true) },
          { name: 'extras/art.bin', data: seeded(130_000 * scale, seed + 8) }
        ]
      },
      {
        depotId: 4003,
        name: 'Plexo Test Game Soundtrack',
        manifestId: '7000000000000000003',
        key: keyFor(seed, 3),
        owned: false,
        files: [{ name: 'soundtrack/track.bin', data: seeded(50_000, seed + 9) }]
      },
      {
        depotId: 4004,
        name: 'Plexo Test Game DLC',
        manifestId: '7000000000000000004',
        key: keyFor(seed, 4),
        owned: true,
        dlcAppId: 4100,
        files: [{ name: 'dlc/pack.bin', data: seeded(90_000, seed + 10) }]
      }
    ]
  }
}

function keyFor(seed: number, depot: number): Buffer {
  return seeded(32, seed * 100 + depot)
}

/** The owned depots, as a download picks them by default. */
export const OWNED_DEPOTS = [4001, 4002, 4004]

/** The treeSha (see fixtures.ts) of the regular files `depots` install, later depots winning. */
export function installedTree(
  app: SteamAppFixture,
  depots: number[]
): { path: string; data: Buffer }[] {
  const files = new Map<string, Buffer>()
  for (const depot of app.depots) {
    if (!depots.includes(depot.depotId)) continue
    for (const file of depot.files) {
      if ((file.flags ?? 0) & (64 | 512)) continue
      files.set(file.name, file.data ?? Buffer.alloc(0))
    }
  }
  return [...files].map(([path, data]) => ({ path, data }))
}

interface Attempt {
  accountName: string
  done: boolean
  scanned: boolean
  needsCode: boolean
  qr: boolean
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const parts: Buffer[] = []
    req.on('data', (part: Buffer) => parts.push(part))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

export interface SteamOriginOptions {
  /** How a login is confirmed: no second step, a code by email, or a code from the mobile app. */
  guard?: 'none' | 'email' | 'device'
  /** Per-response speed limit, so a download lasts long enough to be interrupted. */
  bytesPerSecond?: number
  /** Content servers refuse (403) any request without a CDN token from /cm/token. */
  requireToken?: boolean
}

export class SteamOrigin {
  readonly log: LoggedSteamRequest[] = []
  /** The refresh tokens handed out: what must never reach the window, a log or a file. */
  readonly refreshTokens: string[] = []
  /** Every manifest request code and CDN token handed out, which must not either. */
  readonly grants: string[] = []
  readonly manifests = new Map<number, FixtureManifest>()
  private readonly chunks = new Map<string, FixtureChunk>()
  private readonly attempts = new Map<string, Attempt>()
  private readonly sessions = new Set<string>()
  private readonly revoked = new Set<string>()
  private readonly requestCodes = new Set<string>()
  private readonly cdnTokens = new Set<string>()
  private rule: (request: SteamRequest) => SteamFault | undefined = () => 'ok'
  private holding: ((request: SteamRequest) => boolean) | null = null
  private holdReached: (() => void) | null = null
  private holdRelease: (() => void) | null = null
  private releasePromise: Promise<void> = Promise.resolve()
  private readonly control = createServer((req, res) => void this.answer(req, res))
  private readonly content: Server[]
  private readonly sockets = new Set<Socket>()
  private controlPort = 0
  private contentPorts: number[] = []

  constructor(
    readonly app: SteamAppFixture = syntheticApp(),
    readonly options: SteamOriginOptions = {}
  ) {
    for (const depot of app.depots) {
      const manifest = buildManifest({
        depotId: depot.depotId,
        manifestId: depot.manifestId,
        key: depot.key,
        files: depot.files,
        chunkSize: CHUNK,
        encryptNames: depot.encryptNames,
        compression: depot.compression
      })
      this.manifests.set(depot.depotId, manifest)
      for (const [sha, chunk] of manifest.chunks) this.chunks.set(`${depot.depotId}/${sha}`, chunk)
    }
    this.content = [0, 1].map((index) =>
      createServer((req, res) => void this.serve(index, req, res))
    )
    for (const server of [this.control, ...this.content]) {
      server.on('connection', (socket) => {
        this.sockets.add(socket)
        socket.on('close', () => this.sockets.delete(socket))
      })
    }
  }

  async start(): Promise<this> {
    const listen = (server: Server, host: string): Promise<number> =>
      new Promise((resolve) =>
        server.listen(0, host, () => resolve((server.address() as AddressInfo).port))
      )
    this.controlPort = await listen(this.control, '127.0.0.1')
    // 0.0.0.0, so that requests bound to the second test network's address still arrive.
    this.contentPorts = await Promise.all(this.content.map((server) => listen(server, '0.0.0.0')))
    return this
  }

  async stop(): Promise<void> {
    this.release()
    for (const socket of this.sockets) socket.destroy()
    await Promise.all(
      [this.control, ...this.content].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve()))
      )
    )
  }

  /** Where fakeBackend reaches the control plane (PLEXO_E2E_STEAM). */
  get url(): string {
    return `http://127.0.0.1:${this.controlPort}`
  }

  /** The treeSha the install of `depots` must have. */
  expectedSha(depots: number[] = OWNED_DEPOTS): string {
    const lines = installedTree(this.app, depots)
      .map((file) => `${file.path}\0${sha256(file.data)}\n`)
      .sort()
      .join('')
    return sha256(Buffer.from(lines))
  }

  /** Decides each content request's fault. Returning undefined means 'ok'. */
  setRule(rule: (request: SteamRequest) => SteamFault | undefined): void {
    this.rule = rule
  }

  /** Holds every content response `matches` picks before its first byte, until release().
   * Resolves once the first one arrives. */
  hold(matches: (request: SteamRequest) => boolean): Promise<void> {
    this.release()
    this.holding = matches
    const reached = new Promise<void>((resolve) => (this.holdReached = resolve))
    this.releasePromise = new Promise((resolve) => (this.holdRelease = resolve))
    return reached
  }

  release(): void {
    this.holding = null
    this.holdRelease?.()
    this.holdRelease = null
  }

  /** Revokes every login, as Steam does when the password changes. */
  revokeLogins(): void {
    for (const token of this.refreshTokens) this.revoked.add(token)
  }

  /** CDN tokens handed out so far stop working, as they do when they expire. */
  expireCdnTokens(): void {
    this.cdnTokens.clear()
  }

  /** The QR login under way was scanned, and then approved on the phone. */
  scanQr(approve: boolean): void {
    for (const attempt of this.attempts.values()) {
      if (!attempt.qr) continue
      attempt.scanned = true
      if (approve) attempt.done = true
    }
  }

  chunkRequests(): LoggedSteamRequest[] {
    return this.log.filter((entry) => entry.kind === 'chunk')
  }

  /** The unique chunks of `depots`, by depot and SHA-1. */
  uniqueChunks(depots: number[] = OWNED_DEPOTS): string[] {
    return [...this.chunks.keys()].filter((key) => depots.includes(Number(key.split('/')[0])))
  }

  // --- the control plane -------------------------------------------------------------------------

  private appinfo(): unknown {
    const depots: Record<string, unknown> = {}
    for (const depot of this.app.depots) {
      const manifest = this.manifests.get(depot.depotId)!
      const size = depot.files.reduce((sum, file) => sum + (file.data?.length ?? 0), 0)
      const download = [...manifest.chunks.values()].reduce(
        (sum, chunk) => sum + chunk.body.length,
        0
      )
      depots[String(depot.depotId)] = {
        name: depot.name,
        manifests: {
          public: { gid: depot.manifestId, size: String(size), download: String(download) }
        },
        ...(depot.dlcAppId ? { dlcappid: String(depot.dlcAppId) } : {})
      }
    }
    depots.branches = {
      public: { buildid: '1000', timeupdated: '1700000000' },
      beta: { buildid: '1001', pwdrequired: '1', description: 'Testers only' }
    }
    return {
      appid: String(this.app.appId),
      common: { name: this.app.name, type: 'Game', oslist: 'windows,macos,linux' },
      config: { installdir: this.app.installDir },
      depots
    }
  }

  private loggedIn(req: IncomingMessage): string | null {
    const token = req.headers['x-steam-token']
    return typeof token === 'string' && this.sessions.has(token) && !this.revoked.has(token)
      ? token
      : null
  }

  private newRefreshToken(): string {
    // Shaped like Steam's: a JWT, which redact() knows to take out of any message.
    const claims = Buffer.from(JSON.stringify({ sub: ACCOUNT.name, jti: randomUUID() }))
    const token = `eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.${claims.toString('base64url')}.${randomBytes(32).toString('base64url')}`
    this.refreshTokens.push(token)
    return token
  }

  private async answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url)
    const send = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    }
    const refuse = (error: string, eresult: number): void => send({ error, eresult })
    const body = (req.method === 'POST' ? await readBody(req) : {}) as Record<string, unknown>
    const path = url.pathname
    const param = (name: string): string => url.searchParams.get(name) ?? ''

    if (path === '/cm/login') {
      if (body.accountName !== ACCOUNT.name || body.password !== ACCOUNT.password) {
        return refuse('Invalid password', 5)
      }
      const id = randomUUID()
      const guard = this.options.guard ?? 'none'
      this.attempts.set(id, {
        accountName: ACCOUNT.name,
        done: guard === 'none',
        scanned: false,
        needsCode: guard !== 'none',
        qr: false
      })
      return send({
        attempt: id,
        guard:
          guard === 'none'
            ? null
            : guard === 'email'
              ? { code: 'email', emailDomain: 'example.com', confirm: null }
              : { code: 'device', confirm: 'device' }
      })
    }
    if (path === '/cm/code') {
      const attempt = this.attempts.get(String(body.attempt))
      if (!attempt?.needsCode) return refuse('No such login', 2)
      if (body.code !== GUARD_CODE) return refuse('Invalid code', 65)
      attempt.done = true
      return send({ ok: true })
    }
    if (path === '/cm/qr') {
      const id = randomUUID()
      this.attempts.set(id, {
        accountName: ACCOUNT.name,
        done: false,
        scanned: false,
        needsCode: false,
        qr: true
      })
      return send({ attempt: id, url: `https://s.team/q/1/${randomBytes(8).toString('hex')}` })
    }
    if (path.startsWith('/cm/attempt/')) {
      const attempt = this.attempts.get(path.slice('/cm/attempt/'.length))
      if (!attempt) return refuse('No such login', 2)
      if (!attempt.done) return send({ done: false, scanned: attempt.scanned })
      this.attempts.delete(path.slice('/cm/attempt/'.length))
      const refreshToken = this.newRefreshToken()
      return send({ done: true, refreshToken, accountName: attempt.accountName })
    }
    if (path === '/cm/logon') {
      const token = req.headers['x-steam-token']
      if (
        typeof token !== 'string' ||
        !this.refreshTokens.includes(token) ||
        this.revoked.has(token)
      ) {
        return refuse('Access denied', 26)
      }
      this.sessions.add(token)
      return send({ ok: true })
    }

    // Everything below is for a logged-in session.
    const session = req.headers['x-steam-token']
    if (typeof session === 'string' && this.revoked.has(session)) {
      return refuse('Logged off', 26)
    }
    if (!this.loggedIn(req)) return refuse('Not logged on', 21)
    if (path === '/cm/alive') return send({ ok: true })
    if (path === '/cm/licenses') return send([{ packageId: 5000, borrowed: false }])
    if (path === '/cm/productinfo') {
      const apps = (body.apps as number[] | undefined) ?? []
      const packages = (body.packages as number[] | undefined) ?? []
      return send({
        apps: Object.fromEntries(
          apps
            .filter((appId) => appId === this.app.appId)
            .map((appId) => [String(appId), { appinfo: this.appinfo(), missingToken: false }])
        ),
        packages: Object.fromEntries(
          packages
            .filter((packageId) => packageId === 5000)
            .map((packageId) => [
              String(packageId),
              {
                packageinfo: {
                  packageid: packageId,
                  appids: { 0: this.app.appId },
                  depotids: Object.fromEntries(
                    this.app.depots
                      .filter((depot) => depot.owned)
                      .map((depot, index) => [index, depot.depotId])
                  )
                },
                missingToken: false
              }
            ])
        )
      })
    }
    if (path === '/cm/depotkey') {
      const depot = this.app.depots.find((entry) => entry.depotId === Number(param('depot')))
      if (!depot?.owned) return refuse('Access denied', 15)
      return send({ key: depot.key.toString('hex') })
    }
    if (path === '/cm/requestcode') {
      const code = String(BigInt.asUintN(64, randomBytes(8).readBigUInt64LE()))
      this.requestCodes.add(`${param('depot')}/${param('manifest')}/${code}`)
      this.grants.push(code)
      return send({ code })
    }
    if (path === '/cm/servers') {
      return send(
        this.contentPorts.map((port, index) => ({
          type: 'CDN',
          host: `127.0.0.1:${port}`,
          weightedLoad: index + 1
        }))
      )
    }
    if (path === '/cm/token') {
      const token = `token=${randomBytes(16).toString('hex')}`
      this.cdnTokens.add(token)
      this.grants.push(token)
      return send({ token, expiresAt: Date.now() + 3600_000 })
    }
    refuse('Unknown request', 2)
  }

  // --- the content servers -----------------------------------------------------------------------

  private async serve(server: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://content')
    const chunkPath = /^\/depot\/(\d+)\/chunk\/([0-9a-f]{40})$/.exec(url.pathname)
    const manifestPath = /^\/depot\/(\d+)\/manifest\/(\d+)\/5\/(\d+)$/.exec(url.pathname)
    const request: SteamRequest = {
      n: this.log.length + 1,
      server,
      kind: chunkPath ? 'chunk' : manifestPath ? 'manifest' : 'other',
      depotId: Number((chunkPath ?? manifestPath)?.[1] ?? 0),
      sha: chunkPath?.[2],
      from: (req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''),
      token: url.search ? url.search.slice(1) : null
    }
    const fault = this.rule(request) ?? 'ok'
    const entry: LoggedSteamRequest = { ...request, at: Date.now(), fault, status: 0, bytesSent: 0 }
    this.log.push(entry)
    const end = (status: number, headers?: Record<string, string>): void => {
      entry.status = status
      res.writeHead(status, headers).end()
    }

    if (this.options.requireToken && (!request.token || !this.cdnTokens.has(request.token))) {
      return end(403)
    }
    let body: Buffer | undefined
    if (chunkPath) {
      body = this.chunks.get(`${chunkPath[1]}/${chunkPath[2]}`)?.body
    } else if (manifestPath) {
      const [, depot, manifest, code] = manifestPath
      const fixture = this.manifests.get(Number(depot))
      if (!this.requestCodes.has(`${depot}/${manifest}/${code}`)) return end(401)
      if (fixture?.manifestId === manifest) body = fixture.zipped
    }
    if (!body) return end(404)

    if (this.holding?.(request)) {
      this.holdReached?.()
      await this.releasePromise
    }
    if (fault === 'stallHeaders') return
    if (typeof fault === 'object' && 'status' in fault) return end(fault.status, fault.headers)

    let sent = body
    if (typeof fault === 'object' && 'corruptAt' in fault) {
      sent = Buffer.from(body)
      sent[Math.min(fault.corruptAt, sent.length - 1)] ^= 0xff
    }
    if (fault === 'overlong') sent = Buffer.concat([body, Buffer.from([0])])
    if (typeof fault === 'object' && 'endAfter' in fault) sent = body.subarray(0, fault.endAfter)
    const cutAfter = typeof fault === 'object' && 'cutAfter' in fault ? fault.cutAfter : null
    const crawl = typeof fault === 'object' && 'crawl' in fault ? fault.crawl : null
    const rate = crawl ?? this.options.bytesPerSecond

    entry.status = 200
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      ...(cutAfter === null ? { 'content-length': String(sent.length) } : {})
    })
    if (fault === 'stallBody') {
      res.flushHeaders()
      return
    }
    const piece = crawl ? 256 : 16 * 1024
    for (let position = 0; position < sent.length;) {
      if (res.destroyed) return
      if (cutAfter !== null && position >= cutAfter) {
        req.socket.destroy()
        return
      }
      let next = Math.min(sent.length, position + piece)
      if (cutAfter !== null) next = Math.min(next, cutAfter)
      const part = sent.subarray(position, next)
      entry.bytesSent += part.length
      position = next
      if (!res.write(part)) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            res.off('drain', done)
            res.off('close', done)
            resolve()
          }
          res.on('drain', done)
          res.on('close', done)
        })
      } else {
        await new Promise((resolve) => setImmediate(resolve))
      }
      if (rate) await new Promise((resolve) => setTimeout(resolve, (part.length / rate) * 1000))
    }
    if (cutAfter !== null) {
      req.socket.destroy()
      return
    }
    res.end()
  }
}
