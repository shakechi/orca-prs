// GitHub の応答を読む。問い合わせの文と、応答から PullRequest への変換。
// 応答の形を信じない。知らない形の PR は、読めなかったものとして数える。

import type { PullRequest, Review, Reviewer } from './classify.ts'
import { toOneLine } from './text.ts'

export const PAGE_SIZE = 50
/** 題の長さの上限（文字）。数百行をまとめて送るため。 */
const TITLE_MAX = 120

export const QUERY = `query($q: String!, $after: String) {
  viewer { login }
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        id number title url headRefName isDraft updatedAt mergeable reviewDecision
        author { login }
        repository { name owner { login } }
        reviewRequests(first: 50) {
          totalCount
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Bot { login }
              ... on Mannequin { login }
              ... on Team { name }
            }
          }
        }
        latestOpinionatedReviews(first: 50) { totalCount nodes { state author { __typename login } } }
        latestReviews(first: 50) { totalCount nodes { state author { __typename login } } }
        reviewThreads(first: 100) { totalCount nodes { isResolved } }
        viewerLatestReview { state }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const objectOf = (value: unknown): Json => (isObject(value) ? value : {})
const listOf = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : [])
const stringOf = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null
const nodesOf = (value: unknown): Json[] => listOf(objectOf(value).nodes)

/** 一覧を全部読めたか。届かなかったものや、上限で切れたものを、空の一覧と混ぜない。 */
function complete(value: unknown): boolean {
  const { nodes, totalCount } = objectOf(value)
  return Array.isArray(nodes) && typeof totalCount === 'number' && totalCount <= nodes.length
}

function reviewStateOf(value: unknown): Review['state'] | null {
  switch (value) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes'
    case 'DISMISSED':
      return 'dismissed'
    case 'COMMENTED':
      return 'commented'
    default:
      // PENDING（まだ出していないレビュー）など
      return null
  }
}

function reviewsOf(value: unknown): Review[] {
  return nodesOf(value).flatMap((node) => {
    const state = reviewStateOf(node.state)
    if (state === null) return []
    const author = objectOf(node.author)
    return [{ login: stringOf(author.login) ?? 'ghost', bot: author.__typename === 'Bot', state }]
  })
}

function reviewersOf(value: unknown): Reviewer[] {
  const found = new Map<string, Reviewer>()
  nodesOf(value).forEach((node, index) => {
    const reviewer = objectOf(node.requestedReviewer)
    const name = stringOf(reviewer.login) ?? stringOf(reviewer.name)
    // 見る権限のないチームは null で届く。依頼中であることは変わらないので、数に入れる
    if (name === null) {
      found.set(`hidden:${index}`, { name: null, kind: 'team' })
      return
    }
    const kind =
      reviewer.__typename === 'Team' ? 'team' : reviewer.__typename === 'Bot' ? 'bot' : 'user'
    // 同じ人が 2 回届くことがある
    found.set(`${kind}:${name}`, { name, kind })
  })
  return [...found.values()]
}

function checksOf(commits: unknown): PullRequest['checks'] {
  const [last] = nodesOf(commits)
  switch (objectOf(objectOf(last?.commit).statusCheckRollup).state) {
    case 'SUCCESS':
      return 'passed'
    case 'FAILURE':
    case 'ERROR':
      return 'failed'
    case 'PENDING':
    case 'EXPECTED':
      return 'running'
    default:
      return 'none'
  }
}

function decisionOf(value: unknown): PullRequest['decision'] {
  if (value === 'APPROVED') return 'approved'
  if (value === 'CHANGES_REQUESTED') return 'changes'
  return value === 'REVIEW_REQUIRED' ? 'required' : null
}

function mergeableOf(value: unknown): PullRequest['mergeable'] {
  if (value === 'MERGEABLE') return 'yes'
  return value === 'CONFLICTING' ? 'conflict' : 'unknown'
}

/**
 * 応答の 1 件。行にできない形なら null。
 * failed は、この PR のどこかを読むのに GitHub が失敗したこと。
 */
export function pullRequestOf(node: Json, failed = false): PullRequest | null {
  const repository = objectOf(node.repository)
  const id = stringOf(node.id)
  const url = stringOf(node.url)
  const repo = stringOf(repository.name)
  const owner = stringOf(objectOf(repository.owner).login)
  const updatedAt = Date.parse(stringOf(node.updatedAt) ?? '')
  if (id === null || url === null || repo === null || owner === null) return null
  if (typeof node.number !== 'number' || !Number.isFinite(updatedAt)) return null
  // 押すとブラウザーで開くので、https 以外は受け付けない
  if (!url.startsWith('https://')) return null
  return {
    id,
    number: node.number,
    url,
    title: toOneLine(stringOf(node.title) ?? '', TITLE_MAX),
    branch: stringOf(node.headRefName),
    owner,
    repo,
    draft: node.isDraft === true,
    updatedAt,
    author: stringOf(objectOf(node.author).login),
    mergeable: mergeableOf(node.mergeable),
    checks: checksOf(node.commits),
    decision: decisionOf(node.reviewDecision),
    requested: reviewersOf(node.reviewRequests),
    opinions: reviewsOf(node.latestOpinionatedReviews),
    latest: reviewsOf(node.latestReviews),
    unresolved: nodesOf(node.reviewThreads).filter((thread) => thread.isResolved === false).length,
    moreUnresolved: !complete(node.reviewThreads),
    viewerReview: reviewStateOf(objectOf(node.viewerLatestReview).state),
    incomplete:
      failed ||
      !complete(node.reviewRequests) ||
      !complete(node.latestOpinionatedReviews) ||
      !complete(node.latestReviews),
  }
}

export interface Page {
  viewer: string
  total: number
  // 続きがあるときの目印
  next: string | null
  prs: PullRequest[]
  // 行にできなかった数（見る権限がない、など）
  unreadable: number
  // GitHub が伝えてきた失敗。応答の一部だけが読めたときにも入る
  errors: string[]
}

/**
 * GitHub が一部を読めなかった PR の、応答の中での位置。
 * 読めなかった項目は null で届き、もともと空のものと見分けがつかない。
 * 依頼中のレビュアーの名前だけは別で、見えないチームとして扱えるので数えない。
 */
function failedNodes(errors: Json[]): Set<number> {
  const failed = new Set<number>()
  for (const { path } of errors) {
    if (!Array.isArray(path) || path[0] !== 'search' || path[1] !== 'nodes') continue
    if (path.includes('requestedReviewer')) continue
    if (typeof path[2] === 'number') failed.add(path[2])
  }
  return failed
}

/** 応答の全文を読む。使えるものがなければ、理由を Error で投げる。 */
export function parsePage(text: string): Page {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error('GitHub answered with something that is not JSON')
  }
  const reported = listOf(objectOf(body).errors)
  const errors = reported.flatMap((error) => stringOf(error.message) ?? [])
  const data = objectOf(objectOf(body).data)
  const viewer = stringOf(objectOf(data.viewer).login)
  const search = objectOf(data.search)
  if (viewer === null || !Array.isArray(search.nodes)) {
    // トークンが無効なときなどは、errors ではなく message だけが届く
    const reason = errors[0] ?? stringOf(objectOf(body).message)
    throw new Error(reason === null ? 'GitHub answered in an unexpected form' : `GitHub: ${reason}`)
  }
  const prs: PullRequest[] = []
  let unreadable = 0
  const failed = failedNodes(reported)
  search.nodes.forEach((node: unknown, index) => {
    const pr = isObject(node) ? pullRequestOf(node, failed.has(index)) : null
    if (pr === null) unreadable += 1
    else prs.push(pr)
  })
  const info = objectOf(search.pageInfo)
  return {
    viewer,
    total: typeof search.issueCount === 'number' ? search.issueCount : prs.length,
    next: info.hasNextPage === true ? stringOf(info.endCursor) : null,
    prs,
    unreadable,
    errors,
  }
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?$/
const REPO = /^[A-Za-z0-9._-]+$/

export interface Targets {
  // 検索の文に足す指定。空なら、すべてが対象
  qualifiers: string[]
  // 読めなかった書き方
  invalid: string[]
}

/**
 * 設定に書かれた対象。「owner」「owner/*」「owner/repo」を、空白、改行、カンマで区切って並べる。
 * 検索の文にそのまま入るので、決まった文字だけを通す。
 */
export function parseTargets(text: string): Targets {
  const targets: Targets = { qualifiers: [], invalid: [] }
  for (const item of text.split(/[\s,]+/).filter((part) => part !== '')) {
    const [owner = '', repo, ...rest] = item.split('/')
    if (!OWNER.test(owner) || rest.length > 0) targets.invalid.push(item)
    else if (repo === undefined || repo === '*') targets.qualifiers.push(`user:${owner}`)
    else if (REPO.test(repo)) targets.qualifiers.push(`repo:${owner}/${repo}`)
    else targets.invalid.push(item)
  }
  return targets
}

const BASE = 'is:pr is:open archived:false sort:updated-desc'

/** 3 つの検索。自分の PR、自分に来ている依頼、自分がレビューした PR。 */
export function searchesFor(qualifiers: readonly string[]) {
  const of = (condition: string) => [BASE, condition, ...qualifiers].join(' ')
  return {
    mine: of('author:@me'),
    requested: of('review-requested:@me -author:@me'),
    reviewed: of('reviewed-by:@me -review-requested:@me -author:@me'),
  }
}
