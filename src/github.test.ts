import { assert, test } from 'orca/testing'
import { answer, checks, prNode, reviewed } from '../fixtures/samples.ts'
import { parsePage, parseTargets, pullRequestOf, searchesFor } from './github.ts'

test('応答の 1 件から、判定に使うものを取り出す', () => {
  const pr = pullRequestOf(
    prNode('acme/api#482', {
      isDraft: true,
      updatedAt: '2026-11-24T00:00:00Z',
      mergeable: 'CONFLICTING',
      reviewDecision: 'CHANGES_REQUESTED',
      reviewRequests: {
        nodes: [
          { requestedReviewer: { __typename: 'User', login: 'kato' } },
          { requestedReviewer: { __typename: 'User', login: 'kato' } },
          { requestedReviewer: { __typename: 'Team', name: 'kato' } },
          { requestedReviewer: { __typename: 'Bot', login: 'copilot' } },
          { requestedReviewer: null },
        ],
      },
      latestOpinionatedReviews: reviewed('sato', 'CHANGES_REQUESTED'),
      latestReviews: reviewed('bot', 'COMMENTED', 'Bot'),
      reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] },
      viewerLatestReview: { state: 'APPROVED' },
      commits: checks('ERROR'),
    }),
  )
  assert.deepEqual(pr as unknown, {
    id: 'PR_acme/api#482',
    number: 482,
    url: 'https://github.com/acme/api/pull/482',
    owner: 'acme',
    repo: 'api',
    draft: true,
    updatedAt: Date.parse('2026-11-24T00:00:00Z'),
    author: 'me',
    mergeable: 'conflict',
    checks: 'failed',
    decision: 'changes',
    requested: [
      { name: 'kato', kind: 'user' },
      { name: 'kato', kind: 'team' },
      { name: 'copilot', kind: 'bot' },
      { name: null, kind: 'team' },
    ],
    opinions: [{ login: 'sato', bot: false, state: 'changes' }],
    latest: [{ login: 'bot', bot: true, state: 'commented' }],
    unresolved: 1,
    viewerReview: 'approved',
  })
})

test('チェックの結果を読む', () => {
  const of = (state: string | null) => pullRequestOf(prNode('a/b#1', { commits: checks(state) }))
  assert.equal(of('SUCCESS')?.checks, 'passed')
  assert.equal(of('FAILURE')?.checks, 'failed')
  assert.equal(of('PENDING')?.checks, 'running')
  assert.equal(of('EXPECTED')?.checks, 'running')
  assert.equal(of(null)?.checks, 'none')
})

test('欠けていても困らないものは、ないものとして読む', () => {
  const pr = pullRequestOf({
    id: 'x',
    number: 1,
    url: 'https://github.com/a/b/pull/1',
    updatedAt: '2026-11-24T00:00:00Z',
    author: null,
    repository: { name: 'b', owner: { login: 'a' } },
    latestReviews: { nodes: [{ state: 'COMMENTED', author: null }, { state: 'PENDING' }, null] },
  })
  assert.equal(pr?.author, null)
  assert.equal(pr?.mergeable, 'unknown')
  assert.deepEqual(pr?.requested, [])
  assert.deepEqual(pr?.latest as unknown, [{ login: 'ghost', bot: false, state: 'commented' }])
})

test('行にできない形は読まない', () => {
  assert.equal(pullRequestOf({}), null)
  assert.equal(pullRequestOf(prNode('a/b#1', { number: '1' })), null)
  assert.equal(pullRequestOf(prNode('a/b#1', { updatedAt: 'いつか' })), null)
  assert.equal(pullRequestOf(prNode('a/b#1', { repository: null })), null)
  // 押すとブラウザーで開くので、https だけ
  assert.equal(pullRequestOf(prNode('a/b#1', { url: 'javascript:alert(1)' })), null)
})

test('一部だけ読めた応答は、読めたものと失敗の両方を返す', () => {
  const page = parsePage(
    answer([prNode('a/b#1'), null, {}], { total: 9, next: 'C1', errors: ['SAML が要る'] }),
  )
  assert.equal(page.prs.length, 1)
  assert.equal(page.unreadable, 2)
  assert.equal(page.total, 9)
  assert.equal(page.next, 'C1')
  assert.deepEqual(page.errors, ['SAML が要る'])
})

test('使えない応答は、理由を投げる', () => {
  assert.throws(() => parsePage('<html>'), /not JSON/)
  assert.throws(() => parsePage('{"errors":[{"message":"だめ"}]}'), /GitHub: だめ/)
  assert.throws(() => parsePage('{"message":"Bad credentials"}'), /GitHub: Bad credentials/)
  assert.throws(() => parsePage('[]'), /unexpected form/)
  assert.throws(() => parsePage('{"data":{"viewer":{"login":"me"},"search":null}}'), /unexpected/)
})

test('対象の設定を読む。決まった文字だけを検索の文に入れる', () => {
  assert.deepEqual(parseTargets('') as unknown, { qualifiers: [], invalid: [] })
  assert.deepEqual(parseTargets(' acme, shakechi/*\nacme/web.js ') as unknown, {
    qualifiers: ['user:acme', 'user:shakechi', 'repo:acme/web.js'],
    invalid: [],
  })
  assert.deepEqual(parseTargets('a/b/c -x "a" author:evil a/ /b acme/w:b').invalid, [
    'a/b/c',
    '-x',
    '"a"',
    'author:evil',
    'a/',
    '/b',
    'acme/w:b',
  ])
})

test('検索の文', () => {
  const { mine, requested, reviewed: done } = searchesFor(['user:acme', 'repo:a/b'])
  assert.match(mine, /^is:pr is:open .*author:@me user:acme repo:a\/b$/)
  assert.match(requested, / review-requested:@me -author:@me /)
  assert.match(done, / reviewed-by:@me -review-requested:@me -author:@me /)
})
