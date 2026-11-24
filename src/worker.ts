// プラグインのワーカー。GitHub から集めたものを覚えておき、パネルに渡す。
// いつ取りに行くかは、パネルが頼む（見えていない間は取らない）。

import type { OrcaWorkerApi } from 'orca/worker'
import { type Collected, collect } from './collect.ts'
import { createGh, type GitHub } from './gh.ts'
import { parseTargets } from './github.ts'
import type { PrsState } from './protocol.ts'

/** 利用者に見せる説明の長さの上限。 */
const MESSAGE_MAX = 300
/** コンフリクトの計算が終わっていないときに、1 回だけ聞き直すまでの待ち時間（ミリ秒）。 */
const DEFAULT_SETTLE_MS = 4000

/** パネルに一度に送れる大きさ（Orca の上限は 256 KiB）。 */
const POST_MAX_BYTES = 240 * 1024

const STARTING: PrsState = {
  status: 'starting',
  problem: null,
  warning: null,
  mine: [],
  reviews: [],
  omitted: { mine: 0, reviews: 0 },
  fetchedAt: null,
  fetching: false,
}

export type Connect = (command: string) => GitHub

export interface Worker {
  dispose(): void
}

export interface WorkerOptions {
  settleMs?: number
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MESSAGE_MAX ? `${flat.slice(0, MESSAGE_MAX - 1)}…` : flat
}

const messageOf = (error: unknown) =>
  shorten(error instanceof Error ? error.message : String(error))

export function createWorker(
  orca: OrcaWorkerApi,
  connect: Connect,
  options: WorkerOptions = {},
): Worker {
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
  let state = STARTING
  let disposed = false
  // 設定が変わるたびに増やす番号。前の設定で取ったものを、これで見分けて捨てる
  let generation = 0
  let github: GitHub | null = null
  let running: Promise<void> | null = null
  let known: Collected['mergeable'] = new Map()
  let stopWaiting: () => void = () => undefined

  const publish = (next: Partial<PrsState>) => {
    state = { ...state, ...next }
    // 大きすぎるときは送らない。パネルは prs.refresh の答え（上限 1 MiB）でも受け取る
    if (Buffer.byteLength(JSON.stringify(state)) > POST_MAX_BYTES) return
    orca.panels.post('prs.changed', state)
  }

  const setting = async (key: string): Promise<string> => {
    const value = await orca.settings.get(key)
    return typeof value === 'string' ? value : ''
  }

  const wait = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, settleMs)
      // 止めるときは、待つのをやめて、取りに行かずに終わる
      stopWaiting = () => {
        clearTimeout(timer)
        resolve()
      }
    })

  /** 1 回取って、出す。コンフリクトの計算待ちがあれば true。 */
  const fetchOnce = async (current: () => boolean): Promise<boolean> => {
    const { qualifiers, invalid } = parseTargets(await setting('targets'))
    // 1 つも読めないときに「すべて」を出すと、絞ったつもりの人を驚かせる
    if (invalid.length > 0 && qualifiers.length === 0) {
      throw new Error(`Could not read the targets setting: ${invalid.join(', ')}`)
    }
    const command = await setting('command')
    if (command.includes('\0')) throw new Error('The path of the gh command is invalid')
    if (!current()) return false
    github ??= connect(command)
    const { mergeable, unsettled, ...found } = await collect(github, qualifiers, known)
    if (!current()) return false
    known = mergeable
    const ignored = invalid.length > 0 ? `Ignored targets: ${invalid.join(', ')}` : null
    const warnings = [ignored, found.warning].filter((text) => text !== null)
    publish({
      ...found,
      status: 'ready',
      problem: null,
      warning: warnings.length > 0 ? shorten(warnings.join('. ')) : null,
      fetchedAt: Date.now(),
    })
    return unsettled
  }

  const run = async (): Promise<void> => {
    const mine = generation
    const current = () => !disposed && generation === mine
    publish({ fetching: true })
    try {
      if (await fetchOnce(current)) {
        await wait()
        if (current()) await fetchOnce(current)
      }
    } catch (error) {
      if (!current()) return
      orca.log(`Could not fetch: ${messageOf(error)}`)
      // 前に取れた行は残す。古いことは、パネルが problem を見て知らせる
      publish({ status: 'problem', problem: messageOf(error) })
    } finally {
      if (current()) publish({ fetching: false })
    }
  }

  /** 取りに行く。もう取りに行っていれば、それを待つ。 */
  const refresh = (): Promise<void> => {
    if (running !== null) return running
    const started: Promise<void> = run().finally(() => {
      if (running === started) running = null
    })
    running = started
    return started
  }

  const stopCurrent = () => {
    generation += 1
    stopWaiting()
    github?.dispose()
    github = null
    running = null
  }

  const disposables = [
    orca.panels.handle('prs.get', () => state),
    orca.panels.handle('prs.refresh', async (input) => {
      const maxAgeMs = Number(input?.maxAgeMs)
      const age = state.fetchedAt === null ? Number.POSITIVE_INFINITY : Date.now() - state.fetchedAt
      // 時計が戻ったときは、新しいとみなさない
      const fresh = state.status === 'ready' && age >= 0 && age < maxAgeMs
      if (!fresh || running !== null) await refresh()
      return state
    }),
    orca.settings.onDidChange(() => {
      // 前の設定で取ったものは出さない
      stopCurrent()
      known = new Map()
      state = STARTING
      void refresh()
    }),
  ]

  return {
    dispose() {
      disposed = true
      for (const disposable of disposables) disposable.dispose()
      stopCurrent()
    },
  }
}

let active: Worker | null = null

export default function activate(orca: OrcaWorkerApi): void {
  active = createWorker(orca, (command) => createGh({ command }))
}

export function deactivate(): void {
  active?.dispose()
  active = null
}
