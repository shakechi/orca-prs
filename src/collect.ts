// GitHub から集めて、パネルに出す行にする。

import { mineVerdict, type PullRequest, requestedVerdict, reviewedVerdict } from './classify.ts'
import type { GitHub } from './gh.ts'
import { PAGE_SIZE, parsePage, QUERY, searchesFor } from './github.ts'
import type { MineState, PrRow, PrsState, ReviewState } from './protocol.ts'

/** 1 つの検索で読むページの数。これより古いものは取らず、数だけを伝える。 */
const MAX_PAGES = 4
export const MAX_ROWS = MAX_PAGES * PAGE_SIZE

export interface Collected extends Pick<PrsState, 'mine' | 'reviews' | 'omitted' | 'warning'> {
  // コンフリクトしているかを、GitHub がまだ計算していないものがあるか
  unsettled: boolean
  // 次に集めるとき、まだ計算されていないものの代わりに使う
  mergeable: Map<string, PullRequest['mergeable']>
}

interface Found {
  viewer: string
  prs: PullRequest[]
  omitted: number
  unreadable: number
  errors: string[]
}

async function search(github: GitHub, q: string, stop: AbortSignal): Promise<Found> {
  const found: Found = { viewer: '', prs: [], omitted: 0, unreadable: 0, errors: [] }
  const seen = new Set<string>()
  let after: string | null = null
  let total = 0
  let read = 0
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = parsePage(await github.graphql(QUERY, { q, after }))
    // ほかの検索が失敗していたら、続きは使われない
    if (stop.aborted) return found
    found.viewer = result.viewer
    found.unreadable += result.unreadable
    found.errors.push(...result.errors)
    read += result.prs.length + result.unreadable
    total = result.total
    // ページの間に更新があると、同じ PR が 2 回届くことがある
    for (const pr of result.prs) {
      if (seen.has(pr.id)) continue
      seen.add(pr.id)
      found.prs.push(pr)
    }
    after = result.next
    if (after === null) return found
  }
  found.omitted = Math.max(0, total - read)
  return found
}

function rowOf<S extends string>(
  pr: PullRequest,
  viewer: string,
  verdict: { state: S; note: string },
): PrRow<S> {
  const place = pr.owner === viewer ? pr.repo : `${pr.owner}/${pr.repo}`
  return {
    id: pr.id,
    url: pr.url,
    place: `${place} #${pr.number}`,
    title: pr.title,
    note: verdict.note,
    updatedAt: pr.updatedAt,
    draft: pr.draft,
    state: verdict.state,
  }
}

function warningOf(all: Found[]): string | null {
  const unreadable = all.reduce((sum, found) => sum + found.unreadable, 0)
  const reason = all.flatMap((found) => found.errors)[0] ?? null
  if (unreadable === 0) return reason
  const count = `${unreadable} pull request${unreadable === 1 ? '' : 's'} could not be read`
  return reason === null ? count : `${count}. ${reason}`
}

const newestFirst = (a: PrRow, b: PrRow) => b.updatedAt - a.updatedAt

export async function collect(
  github: GitHub,
  qualifiers: readonly string[],
  known: ReadonlyMap<string, PullRequest['mergeable']> = new Map(),
): Promise<Collected> {
  const queries = searchesFor(qualifiers)
  const stop = new AbortController()
  const searching = [queries.mine, queries.requested, queries.reviewed].map((q) =>
    search(github, q, stop.signal).catch((error: unknown) => {
      stop.abort()
      throw error
    }),
  )
  // 失敗しても、ほかの検索が終わるのを待つ。先に戻ると、次の取り直しと重なる
  await Promise.allSettled(searching)
  const [mine, requested, reviewed] = (await Promise.all(searching)) as [Found, Found, Found]

  const mergeable: Collected['mergeable'] = new Map()
  let unsettled = false
  // GitHub は、聞かれてからコンフリクトを計算する。計算が終わるまでは、前に分かっていた値を使う
  const settle = (pr: PullRequest): PullRequest => {
    if (pr.mergeable === 'unknown') unsettled = true
    const value = pr.mergeable === 'unknown' ? (known.get(pr.id) ?? 'unknown') : pr.mergeable
    mergeable.set(pr.id, value)
    return { ...pr, mergeable: value }
  }

  const mineRows: PrRow<MineState>[] = mine.prs
    .map(settle)
    .map((pr) => rowOf(pr, mine.viewer, mineVerdict(pr)))
  const reviewRows: PrRow<ReviewState>[] = requested.prs
    .map(settle)
    .map((pr) => rowOf(pr, requested.viewer, requestedVerdict(pr)))
  const asked = new Set(reviewRows.map((row) => row.id))
  for (const raw of reviewed.prs) {
    // 2 つの検索の間に再依頼されると、両方に出る
    if (asked.has(raw.id)) continue
    const verdict = reviewedVerdict(raw, reviewed.viewer)
    if (verdict === null) continue
    const pr = settle(raw)
    reviewRows.push(rowOf(pr, reviewed.viewer, reviewedVerdict(pr, reviewed.viewer) ?? verdict))
  }

  return {
    mine: mineRows.sort(newestFirst),
    reviews: reviewRows.sort(newestFirst),
    omitted: { mine: mine.omitted, reviews: requested.omitted + reviewed.omitted },
    warning: warningOf([mine, requested, reviewed]),
    unsettled,
    mergeable,
  }
}
