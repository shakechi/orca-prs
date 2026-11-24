// PR の状態を決める。GitHub にも Orca にも触らない、入力から出力が決まるだけの関数。
//
// GitHub のまとめの値（reviewDecision）だけでは決めない。
// - 必須レビューのないリポジトリでは空になる
// - 修正依頼のあとに再依頼しても CHANGES_REQUESTED のまま残る
// ので、レビュアーごとの最新の意見と、依頼中の一覧から決める。

import type { MineState, ReviewState } from './protocol.ts'

export interface Reviewer {
  // 見る権限のないチームは null
  name: string | null
  // チームの名前は、人のログイン名と同じ文字列になりうる。比べるときに混ぜない
  kind: 'user' | 'team' | 'bot'
}

export interface Review {
  login: string
  bot: boolean
  state: 'approved' | 'changes' | 'dismissed' | 'commented'
}

/** GitHub の応答から、判定に使うものだけを取り出した PR。 */
export interface PullRequest {
  id: string
  number: number
  url: string
  owner: string
  repo: string
  draft: boolean
  // 最後の更新（ミリ秒）
  updatedAt: number
  // 退会した人の PR では null
  author: string | null
  mergeable: 'yes' | 'conflict' | 'unknown'
  checks: 'none' | 'passed' | 'failed' | 'running'
  decision: 'approved' | 'changes' | 'required' | null
  // 依頼中のレビュアー
  requested: Reviewer[]
  // 人ごとの最新の意見。コメントだけのレビューは入らない
  opinions: Review[]
  // 人ごとの最新のレビュー。コメントだけのものも入る
  latest: Review[]
  // 解決していない指摘の数。多すぎて全部は読めていないなら、moreUnresolved が真
  unresolved: number
  moreUnresolved: boolean
  // 自分の最新のレビュー
  viewerReview: Review['state'] | null
  // 状態を決めるのに要るもののうち、読めなかったものや、読み切れなかったものがある
  incomplete: boolean
}

const SEPARATOR = ' · '
/** これより多い人数は、名前を並べずに数で出す。 */
const MAX_NAMES = 2

const join = (parts: (string | null)[]) => parts.filter((part) => part !== null).join(SEPARATOR)

/** 「kato approved」「2 approved」。誰もいなければ null。 */
function did(people: Review[], verb: string): string | null {
  const [first] = people
  if (first === undefined) return null
  return `${people.length === 1 ? first.login : people.length} ${verb}`
}

/** 「kato」「kato, core」「3 reviewers」。名前の分からないチームは、後ろに数で出す。 */
function namesOf(reviewers: Reviewer[]): string | null {
  if (reviewers.length === 0) return null
  if (reviewers.length > MAX_NAMES) return `${reviewers.length} reviewers`
  const names = reviewers.flatMap((reviewer) => reviewer.name ?? [])
  const hidden = reviewers.length - names.length
  if (hidden > 0) names.push(hidden === 1 ? 'a team' : `${hidden} teams`)
  return names.join(', ')
}

/** 読めていないものがあるときの注記。 */
const NOT_FULLY_READ = 'Not fully read'
const doubt = (pr: PullRequest) => (pr.incomplete ? NOT_FULLY_READ : null)

/** チェックの結果。読めていないものがあるときは、ないと言い切らない。 */
const checksNote = (pr: PullRequest) => doubt(pr) ?? CHECKS_NOTE[pr.checks]

/** マージを止めている、直すもの。 */
function blockers(pr: PullRequest): string[] {
  const found: string[] = []
  if (pr.checks === 'failed') found.push('CI failed')
  if (pr.mergeable === 'conflict') found.push('Conflict')
  return found
}

const CHECKS_NOTE: Record<PullRequest['checks'], string> = {
  none: 'No checks',
  passed: 'CI passed',
  running: 'CI running',
  failed: 'CI failed',
}

export interface Verdict<S> {
  state: S
  note: string
}

/** 自分の PR の状態。上から順に当てはめ、最初に合ったものにする。 */
export function mineVerdict(pr: PullRequest): Verdict<MineState> {
  const asked = new Set(pr.requested.filter((r) => r.kind !== 'team').map((r) => r.name))
  const notAsked = (review: Review) => !asked.has(review.login)

  // 直し終わって再依頼した相手の修正依頼は、もう自分の番ではない
  const objections = pr.opinions.filter((r) => r.state === 'changes' && notAsked(r))
  // まとめの値だけが修正依頼で、依頼中の人もいないとき（レビュアーが多すぎて全員は読めなかった、など）
  const changes = objections.length > 0 || (pr.decision === 'changes' && pr.requested.length === 0)
  const found = blockers(pr)

  if (changes) {
    const threads = `${pr.unresolved}${pr.moreUnresolved ? '+' : ''} unresolved`
    const detail = found.length === 0 && pr.unresolved > 0 ? threads : null
    return { state: 'fix', note: join(['Changes requested', ...found, detail, doubt(pr)]) }
  }
  // 作業中の PR は、CI が落ちていたりコンフリクトしていたりするのが普通なので、Fix にしない
  if (pr.draft) return { state: 'todo', note: join(['Draft', ...found, doubt(pr)]) }
  if (found.length > 0) return { state: 'fix', note: join([...found, doubt(pr)]) }

  const approvals = pr.opinions.filter((r) => r.state === 'approved' && notAsked(r))
  const approved =
    pr.decision === 'approved' ||
    // 必須レビューのないリポジトリ。依頼中の人が残っていれば、まだ待つ
    (pr.decision === null && approvals.length > 0 && pr.requested.length === 0)
  // 読めていないところに修正依頼や失敗があるかもしれないうちは、マージできると言わない
  if (approved && !pr.incomplete) return { state: 'merge', note: CHECKS_NOTE[pr.checks] }

  const running = pr.checks === 'running' ? CHECKS_NOTE.running : null
  const opined = new Set(pr.opinions.map((r) => r.login))
  // コメントだけのレビュー。ボットは、依頼しなくても書くので数えない
  const comments = pr.latest.filter(
    (r) =>
      r.state === 'commented' &&
      !r.bot &&
      r.login !== pr.author &&
      notAsked(r) &&
      !opined.has(r.login),
  )
  if (pr.requested.length > 0) {
    const names = namesOf(pr.requested)
    const progress = did(approvals, 'approved')
    const note = progress ? [progress, names] : [names, running]
    return { state: 'waiting', note: join([...note, doubt(pr)]) }
  }
  if (comments.length > 0) {
    return { state: 'waiting', note: join([did(comments, 'commented'), running, doubt(pr)]) }
  }
  // Approve はあるが、必須の人数に足りず、次の人にまだ頼んでいない
  if (approvals.length > 0) {
    return {
      state: 'todo',
      note: join([did(approvals, 'approved'), doubt(pr) ?? 'More reviews needed']),
    }
  }
  return { state: 'todo', note: checksNote(pr) }
}

/** 他人の PR の 2 行目。直すのは作者なので、状態は変えずに注記だけ出す。 */
function reviewNote(pr: PullRequest): string {
  return join([`by ${pr.author ?? 'ghost'}`, pr.draft ? 'Draft' : null, ...blockers(pr), doubt(pr)])
}

/** 自分（またはチーム）にレビューの依頼が来ている PR。 */
export function requestedVerdict(pr: PullRequest): Verdict<ReviewState> {
  return { state: 'review', note: reviewNote(pr) }
}

/**
 * 自分がレビューした他人の PR。作者の番なら waiting。
 * 自分の仕事が終わっている（Approve した、など）なら null。
 */
export function reviewedVerdict(pr: PullRequest, viewer: string): Verdict<ReviewState> | null {
  const opinion = pr.opinions.find((r) => r.login === viewer)?.state ?? pr.viewerReview
  if (opinion !== 'changes' && opinion !== 'commented') return null
  return { state: 'waiting', note: reviewNote(pr) }
}
