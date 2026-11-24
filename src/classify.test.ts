import { assert, test } from 'orca/testing'
import {
  mineVerdict,
  type PullRequest,
  type Review,
  type Reviewer,
  requestedVerdict,
  reviewedVerdict,
} from './classify.ts'

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'PR_1',
    number: 1,
    url: 'https://github.com/acme/api/pull/1',
    owner: 'acme',
    repo: 'api',
    draft: false,
    updatedAt: 0,
    author: 'me',
    mergeable: 'yes',
    checks: 'passed',
    decision: null,
    requested: [],
    opinions: [],
    latest: [],
    unresolved: 0,
    moreUnresolved: false,
    viewerReview: null,
    incomplete: false,
    ...overrides,
  }
}
const user = (name: string): Reviewer => ({ name, kind: 'user' })
const team = (name: string): Reviewer => ({ name, kind: 'team' })
const review = (login: string, state: Review['state'], bot = false): Review => ({
  login,
  state,
  bot,
})

const CASES: [string, Partial<PullRequest>, string, string][] = [
  // Todo
  ['依頼もレビューもない', {}, 'todo', 'CI passed'],
  ['チェックがない', { checks: 'none' }, 'todo', 'No checks'],
  ['チェックが実行中', { checks: 'running' }, 'todo', 'CI running'],
  ['Draft', { draft: true }, 'todo', 'Draft'],
  ['Draft は CI が落ちても Todo', { draft: true, checks: 'failed' }, 'todo', 'Draft · CI failed'],
  [
    'Draft はコンフリクトしても Todo',
    { draft: true, mergeable: 'conflict' },
    'todo',
    'Draft · Conflict',
  ],
  ['Draft は依頼中でも Todo', { draft: true, requested: [user('kato')] }, 'todo', 'Draft'],
  [
    '必須の人数に足りず、次の人に頼んでいない',
    { decision: 'required', opinions: [review('kato', 'approved')] },
    'todo',
    'kato approved · More reviews needed',
  ],
  ['取り下げられたレビューだけ', { opinions: [review('kato', 'dismissed')] }, 'todo', 'CI passed'],
  [
    'ボットのコメントは、レビューに数えない',
    { latest: [review('copilot', 'commented', true)] },
    'todo',
    'CI passed',
  ],
  ['自分のコメントは、数えない', { latest: [review('me', 'commented')] }, 'todo', 'CI passed'],
  // Waiting
  ['1 人に依頼中', { requested: [user('kato')] }, 'waiting', 'kato'],
  ['2 人に依頼中', { requested: [user('kato'), team('core')] }, 'waiting', 'kato, core'],
  [
    '3 人以上は数で出す',
    { requested: [user('a'), user('b'), user('c')] },
    'waiting',
    '3 reviewers',
  ],
  [
    '見えないチームは、名前のある人の後ろに出す',
    { requested: [{ name: null, kind: 'team' }, user('kato')] },
    'waiting',
    'kato, a team',
  ],
  [
    '見えないチームが 2 つ',
    {
      requested: [
        { name: null, kind: 'team' },
        { name: null, kind: 'team' },
      ],
    },
    'waiting',
    '2 teams',
  ],
  [
    '依頼中で CI も実行中',
    { requested: [user('kato')], checks: 'running' },
    'waiting',
    'kato · CI running',
  ],
  [
    '1 人は Approve 済み',
    { requested: [user('sato')], opinions: [review('kato', 'approved')] },
    'waiting',
    'kato approved · sato',
  ],
  ['コメントだけ付いた', { latest: [review('kato', 'commented')] }, 'waiting', 'kato commented'],
  [
    '修正依頼のあとに再依頼した（まとめの値は残る）',
    { decision: 'changes', opinions: [review('kato', 'changes')], requested: [user('kato')] },
    'waiting',
    'kato',
  ],
  [
    'Approve した人に再依頼した',
    { opinions: [review('kato', 'approved')], requested: [user('kato')] },
    'waiting',
    'kato',
  ],
  // Fix
  [
    '修正依頼',
    { decision: 'changes', opinions: [review('kato', 'changes')], unresolved: 3 },
    'fix',
    'Changes requested · 3 unresolved',
  ],
  [
    '必須レビューがなくても、修正依頼は Fix',
    { opinions: [review('kato', 'changes')] },
    'fix',
    'Changes requested',
  ],
  [
    'ほかの人に依頼中でも、修正依頼が残れば Fix',
    { opinions: [review('kato', 'changes')], requested: [user('sato')] },
    'fix',
    'Changes requested',
  ],
  [
    'チームの名前は、人のログイン名と混ぜない',
    { opinions: [review('core', 'changes')], requested: [team('core')] },
    'fix',
    'Changes requested',
  ],
  ['まとめの値だけが修正依頼', { decision: 'changes' }, 'fix', 'Changes requested'],
  ['Draft でも、修正依頼は Fix', { draft: true, decision: 'changes' }, 'fix', 'Changes requested'],
  ['CI 失敗', { checks: 'failed' }, 'fix', 'CI failed'],
  ['コンフリクト', { mergeable: 'conflict' }, 'fix', 'Conflict'],
  [
    '理由が複数',
    { decision: 'changes', checks: 'failed', mergeable: 'conflict', unresolved: 3 },
    'fix',
    'Changes requested · CI failed · Conflict',
  ],
  [
    'Approve 済みでも CI 失敗なら Fix',
    { decision: 'approved', checks: 'failed' },
    'fix',
    'CI failed',
  ],
  // Merge
  [
    'Approve 済み',
    { decision: 'approved', opinions: [review('kato', 'approved')] },
    'merge',
    'CI passed',
  ],
  [
    '必須レビューがないリポジトリの Approve',
    { opinions: [review('kato', 'approved')], checks: 'none' },
    'merge',
    'No checks',
  ],
  [
    '必要な Approve がそろえば、依頼中の人がいても Merge',
    { decision: 'approved', requested: [user('sato')] },
    'merge',
    'CI passed',
  ],
  [
    '読めていないところがあれば、Merge にしない',
    { opinions: [review('kato', 'approved')], incomplete: true },
    'todo',
    'kato approved · Not fully read',
  ],
  [
    'まとめの値が Approve でも、読めていないところがあれば Merge にしない',
    { decision: 'approved', checks: 'none', incomplete: true },
    'todo',
    'Not fully read',
  ],
  [
    '読めていないところがあっても、分かっている直すものは Fix に出す',
    { checks: 'failed', incomplete: true },
    'fix',
    'CI failed · Not fully read',
  ],
  [
    '指摘を全部は読めていないときは、下限と分かるように出す',
    { decision: 'changes', unresolved: 100, moreUnresolved: true },
    'fix',
    'Changes requested · 100+ unresolved',
  ],
  [
    'コンフリクトか不明なうちは、止めない',
    { decision: 'approved', mergeable: 'unknown' },
    'merge',
    'CI passed',
  ],
]

for (const [name, overrides, state, note] of CASES) {
  test(`自分の PR: ${name}`, () => {
    assert.deepEqual(mineVerdict(pr(overrides)) as unknown, { state, note })
  })
}

test('依頼が来ている PR は、状態を変えずに注記だけ出す', () => {
  const other = { author: 'kato' }
  assert.deepEqual(requestedVerdict(pr(other)) as unknown, { state: 'review', note: 'by kato' })
  assert.equal(
    requestedVerdict(pr({ ...other, draft: true, checks: 'failed', mergeable: 'conflict' })).note,
    'by kato · Draft · CI failed · Conflict',
  )
  assert.equal(requestedVerdict(pr({ author: null })).note, 'by ghost')
})

test('自分がレビューした PR は、作者の番のときだけ出す', () => {
  const verdict = (overrides: Partial<PullRequest>) =>
    reviewedVerdict(pr({ author: 'kato', ...overrides }), 'me')
  const waiting: unknown = { state: 'waiting', note: 'by kato' }

  assert.deepEqual(verdict({ opinions: [review('me', 'changes')] }) as unknown, waiting)
  assert.deepEqual(verdict({ viewerReview: 'commented' }) as unknown, waiting)
  assert.equal(verdict({ opinions: [review('me', 'approved')] }), null)
  // Approve したあとにコメントしても、自分の仕事は終わっている
  assert.equal(verdict({ opinions: [review('me', 'approved')], viewerReview: 'commented' }), null)
  // 修正依頼のあとのコメントは、まだ作者の番
  assert.deepEqual(
    verdict({ opinions: [review('me', 'changes')], viewerReview: 'commented' }) as unknown,
    waiting,
  )
  assert.equal(verdict({ opinions: [review('me', 'dismissed')] }), null)
  assert.equal(verdict({ opinions: [review('sato', 'changes')] }), null)
})
