import { assert, test } from 'orca/testing'
import { answer, prNode, requested, reviewed } from '../fixtures/samples.ts'
import { collect, MAX_ROWS } from './collect.ts'
import type { GitHub } from './gh.ts'
import type { PrRow } from './protocol.ts'

/** 「owner/name #番号」。どの PR の行かを確かめるため。 */
const placeOf = (row: PrRow) => row.url.replace('https://github.com/', '').replace('/pull/', ' #')

type Kind = 'mine' | 'requested' | 'reviewed'

function kindOf(q: string | null | undefined): Kind {
  if (q?.includes(' author:@me')) return 'mine'
  return q?.includes('reviewed-by:@me') ? 'reviewed' : 'requested'
}

/** 検索ごとに決まった答えを返す、偽物の GitHub。 */
function fake(answers: Partial<Record<Kind, (after: string | null, q: string) => string>>) {
  const asked: { kind: Kind; after: string | null; q: string }[] = []
  const github: GitHub = {
    async graphql(_query, { q, after }) {
      const call = { kind: kindOf(q), after: after ?? null, q: q ?? '' }
      asked.push(call)
      return answers[call.kind]?.(call.after, call.q) ?? answer([])
    },
    dispose() {},
  }
  return { github, asked }
}

const at = (day: number) => ({ updatedAt: `2026-11-${String(day).padStart(2, '0')}T00:00:00Z` })

test('自分の PR とレビュー依頼を、新しい順の行にする', async () => {
  const { github } = fake({
    mine: () =>
      answer([
        prNode('me/notes#11', at(1)),
        prNode('acme/api#482', { ...at(3), reviewRequests: requested('kato') }),
      ]),
    requested: () => answer([prNode('acme/web#91', { ...at(2), author: { login: 'kato' } })]),
    reviewed: () =>
      answer([
        prNode('acme/web#88', {
          ...at(4),
          author: { login: 'sato' },
          latestOpinionatedReviews: reviewed('me', 'CHANGES_REQUESTED'),
        }),
        prNode('acme/web#80', { latestOpinionatedReviews: reviewed('me', 'APPROVED') }),
      ]),
  })
  const found = await collect(github, [])
  assert.deepEqual(
    found.mine.map((row) => [placeOf(row), row.state, row.note]),
    [
      ['acme/api #482', 'waiting', 'kato'],
      ['me/notes #11', 'todo', 'CI passed'],
    ],
  )
  assert.deepEqual(
    found.reviews.map((row) => [placeOf(row), row.state, row.note]),
    [
      ['acme/web #88', 'waiting', 'by sato'],
      ['acme/web #91', 'review', 'by kato'],
    ],
  )
  assert.equal(found.warning, null)
  assert.equal(found.unsettled, false)
})

test('対象は、3 つの検索のすべてに入る', async () => {
  const { github, asked } = fake({})
  await collect(github, ['user:acme'])
  assert.equal(asked.length, 3)
  assert.ok(asked.every((call) => call.q.endsWith(' user:acme')))
})

test('続きを読む。同じ PR が 2 回届いても 1 行にする', async () => {
  const { github, asked } = fake({
    mine: (after) =>
      after === null
        ? answer([prNode('a/b#1'), prNode('a/b#2')], { total: 3, next: 'C1' })
        : answer([prNode('a/b#2'), prNode('a/b#3')], { total: 3 }),
  })
  const found = await collect(github, [])
  assert.deepEqual(found.mine.map((row) => placeOf(row)).sort(), ['a/b #1', 'a/b #2', 'a/b #3'])
  assert.deepEqual(
    asked.filter((call) => call.kind === 'mine').map((call) => call.after),
    [null, 'C1'],
  )
  assert.equal(found.omitted.mine, 0)
})

test('多すぎるときは途中でやめて、残りの数を伝える', async () => {
  let page = 0
  const { github } = fake({
    mine: () => {
      page += 1
      const nodes = Array.from({ length: 50 }, (_, i) => prNode(`a/b#${page * 100 + i}`))
      return answer(nodes, { total: 230, next: `C${page}` })
    },
  })
  const found = await collect(github, [])
  assert.equal(found.mine.length, MAX_ROWS)
  assert.equal(found.omitted.mine, 30)
})

test('2 つの検索の両方に出た PR は、レビューの番として 1 行だけ出す', async () => {
  const node = prNode('acme/web#91', {
    author: { login: 'kato' },
    latestOpinionatedReviews: reviewed('me', 'CHANGES_REQUESTED'),
  })
  const { github } = fake({ requested: () => answer([node]), reviewed: () => answer([node]) })
  const found = await collect(github, [])
  assert.deepEqual(
    found.reviews.map((row) => row.state),
    ['review'],
  )
})

test('コンフリクトの計算が終わっていなければ、前に分かっていた値を使う', async () => {
  const of = (mergeable: string) =>
    fake({ mine: () => answer([prNode('a/b#1', { mergeable })]) }).github

  const first = await collect(of('UNKNOWN'), [])
  assert.equal(first.mine[0]?.state, 'todo')
  assert.equal(first.unsettled, true)

  const second = await collect(of('CONFLICTING'), [], first.mergeable)
  assert.equal(second.mine[0]?.state, 'fix')
  assert.equal(second.unsettled, false)

  const third = await collect(of('UNKNOWN'), [], second.mergeable)
  assert.equal(third.mine[0]?.state, 'fix')
  assert.equal(third.unsettled, true)
})

test('読めなかった PR があれば、数と理由を伝える', async () => {
  const { github } = fake({
    mine: () => answer([prNode('a/b#1'), null], { errors: [{ message: 'SAML が要る' }] }),
  })
  const found = await collect(github, [])
  assert.equal(found.mine.length, 1)
  assert.equal(found.warning, '1 pull request could not be read. SAML が要る')
})

test('1 つの検索が失敗したら、全体を失敗にする（欠けた一覧を、全部だと見せない）', async () => {
  const { github } = fake({ reviewed: () => '{"message":"Bad credentials"}' })
  await assert.rejects(collect(github, []), /Bad credentials/)
})

test('1 つの検索が失敗したら、ほかの検索の続きは読まず、終わるのを待ってから失敗する', async () => {
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const asked: string[] = []
  const github: GitHub = {
    async graphql(_query, { q, after }) {
      const kind = kindOf(q)
      asked.push(`${kind}:${after ?? ''}`)
      if (kind === 'reviewed') throw new Error('だめ')
      await held
      return answer([prNode('a/b#1')], { total: 99, next: 'C1' })
    },
    dispose() {},
  }
  let settled = false
  const collecting = collect(github, []).finally(() => {
    settled = true
  })
  const rejected = assert.rejects(collecting, /だめ/)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(settled, false)
  release()
  await rejected
  assert.deepEqual(asked.sort(), ['mine:', 'requested:', 'reviewed:'])
})

test('行の見出しは、ブランチとリポジトリ。分かりきった名前は省く', async () => {
  const { github } = fake({
    mine: () =>
      answer([
        prNode('me/notes#1', { ...at(9), headRefName: 'me/fix-login' }),
        prNode('acme/api#2', { ...at(8), headRefName: 'fix/login' }),
        // 読めなければ番号を出す
        prNode('acme/api#3', { ...at(7), headRefName: null }),
        prNode('acme/api#4', { ...at(6), headRefName: 'fix', author: null }),
      ]),
    requested: () =>
      answer([prNode('acme/web#5', { headRefName: 'kato/retry', author: { login: 'kato' } })]),
  })
  const found = await collect(github, [])
  assert.deepEqual(
    [...found.mine, ...found.reviews].map((row) => [row.branch, row.repo]),
    [
      ['fix-login', 'notes'],
      ['fix/login', 'acme/api'],
      ['#3', 'acme/api'],
      ['fix', 'acme/api'],
      ['retry', 'acme/web'],
    ],
  )
})
