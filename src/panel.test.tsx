// パネルを、ワーカーの代わりの答えで動かして確かめる。

import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel.tsx'
import type { MineState, PrRow, PrsState, ReviewState } from './protocol.ts'

const DAY = 24 * 60 * 60 * 1000

function row<S extends string>(place: string, state: S, days = 0, extra: Partial<PrRow<S>> = {}) {
  return {
    id: place,
    url: `https://github.com/${place.replace(' #', '/pull/')}`,
    place,
    note: 'CI passed',
    // 境目ちょうどの行が、動かす速さで揺れないように、少しだけ古くする
    updatedAt: Date.now() - days * DAY - 1000,
    draft: false,
    state,
    ...extra,
  }
}

const MINE: PrRow<MineState>[] = [
  row('acme/api #501', 'todo', 0, { draft: true, note: 'Draft' }),
  row('acme/api #498', 'todo', 1),
  row('acme/web #97', 'todo', 3, { draft: true, note: 'Draft' }),
  row('notes #11', 'todo', 8),
  row('acme/docs #19', 'todo', 12),
  row('acme/api #455', 'todo', 40, { draft: true, note: 'Draft' }),
  row('acme/web #60', 'todo', 90, { draft: true, note: 'Draft' }),
  row('acme/api #490', 'waiting', 1, { note: 'kato' }),
  row('acme/api #482', 'fix', 2, { note: 'Changes requested · 3 unresolved' }),
  row('acme/skills #3', 'fix', 30, { note: 'Conflict' }),
  row('acme/docs #17', 'merge', 5),
]
const REVIEWS: PrRow<ReviewState>[] = [
  row('acme/web #91', 'review', 0, { note: 'by kato' }),
  row('acme/docs #12', 'waiting', 45, { note: 'by mori' }),
]

function ready(overrides: Partial<PrsState> = {}): PrsState {
  return {
    status: 'ready',
    problem: null,
    warning: null,
    mine: MINE,
    reviews: REVIEWS,
    omitted: { mine: 0, reviews: 0 },
    fetchedAt: Date.now(),
    fetching: false,
    ...overrides,
  }
}

const STARTING = ready({ status: 'starting', mine: [], reviews: [], fetchedAt: null })

async function open(state: PrsState = ready(), persisted: Record<string, unknown> = {}) {
  const asked: number[] = []
  const host = mockHost({
    requests: {
      'prs.get': () => state,
      'prs.refresh': ({ maxAgeMs }: { maxAgeMs: number }) => {
        asked.push(maxAgeMs)
        return state
      },
    },
    results: { 'shell.openExternal': { opened: true } },
  })
  const view = await mount(panel, { host, persisted: { plugin: persisted } })
  const shows = (text: string) => view.find({ text }) !== null
  const close = async () => {
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    await view.unmount()
  }
  return { view, host, asked, shows, close }
}

test('はじめは自分の PR を、状態ごとに出す', async () => {
  const { shows, close } = await open()
  for (const label of ['Todo', 'Waiting', 'Fix', 'Merge']) assert.ok(shows(label), label)
  assert.ok(shows('acme/api #482'))
  assert.ok(shows('Changes requested · 3 unresolved'))
  assert.ok(!shows('acme/web #91'))
  await close()
})

test('状態は、空でも出す', async () => {
  const { shows, close } = await open(ready({ mine: [], reviews: [] }))
  for (const label of ['Todo', 'Waiting', 'Fix', 'Merge']) assert.ok(shows(label), label)
  assert.ok(shows('My PRs 0'))
  await close()
})

test('タブを切り替えると、自分に来ているレビュー依頼を出す', async () => {
  const { view, shows, close } = await open()
  await view.select({ label: 'Pull requests' }, 'reviews')
  for (const label of ['Review', 'Waiting']) assert.ok(shows(label), label)
  assert.ok(shows('acme/web #91'))
  assert.ok(!shows('acme/api #482'))
  await close()
})

test('タブには、自分が動く番の数を出す', async () => {
  const { shows, close } = await open()
  assert.ok(shows('My PRs 10'))
  assert.ok(shows('Reviews 1'))
  await close()
})

test('行を押すと、その PR をブラウザーで開く', async () => {
  const { view, host, close } = await open()
  await view.press({ testId: 'acme/api #482' })
  assert.deepEqual(host.callsOf('shell.openExternal'), [
    { url: 'https://github.com/acme/api/pull/482' },
  ])
  await close()
})

test('ブラウザーで開けなければ、理由を出す。次に開けたら消す', async () => {
  const { view, host, shows, close } = await open()
  host.respond('shell.openExternal', () => {
    throw hostError('action_failed', 'no browser')
  })
  await view.press({ testId: 'acme/api #482' })
  assert.ok(shows('no browser'))
  assert.ok(view.find({ label: 'Could not open in the browser' }))
  host.respond('shell.openExternal', { opened: true })
  await view.press({ testId: 'acme/api #482' })
  assert.ok(!shows('no browser'))
  await close()
})

test('状態ごとに、新しいほうから 5 件だけ出し、残りは押すとひらく', async () => {
  const { view, shows, close } = await open()
  assert.ok(shows('acme/docs #19'))
  assert.ok(!shows('acme/web #60'))
  await view.press({ text: 'Show 2 more' })
  assert.ok(shows('acme/web #60'))
  await view.press({ text: 'Show less' })
  assert.ok(!shows('acme/web #60'))
  await close()
})

test('Draft を隠すと、Draft の行が消え、隠した数が出る', async () => {
  const { view, shows, close } = await open()
  await view.press({ text: 'Hide drafts' })
  assert.ok(!shows('acme/api #501'))
  assert.ok(shows('acme/api #498'))
  assert.ok(shows('4 hidden by filters'))
  assert.ok(shows('My PRs 6'))
  await view.press({ text: 'Hide drafts' })
  assert.ok(shows('acme/api #501'))
  await close()
})

test('古さは日数を選んで隠す。自分の PR の全部の状態に効く', async () => {
  const { view, shows, close } = await open()
  await view.press({ text: '30d' })
  // 30 日ちょうどの行も隠す。Todo の 40 日と 90 日、Fix の 30 日
  assert.ok(!shows('acme/skills #3'))
  assert.ok(shows('3 hidden by filters'))
  await view.press({ text: '7d' })
  assert.ok(!shows('acme/docs #19'))
  assert.ok(shows('acme/docs #17'))
  assert.ok(shows('5 hidden by filters'))
  // 選んである日数をもう一度押すと、古さでは隠さなくなる
  await view.press({ text: '7d' })
  assert.ok(shows('acme/skills #3'))
  await close()
})

test('Draft と古さの絞り込みは、レビュー依頼には効かない', async () => {
  const { view, shows, close } = await open()
  await view.press({ text: '30d' })
  await view.select({ label: 'Pull requests' }, 'reviews')
  assert.ok(shows('acme/docs #12'))
  assert.ok(!shows('Hide drafts'))
  await close()
})

test('選んだ絞り込みは、次に開いても残る。選べなくなった日数は使わない', async () => {
  const kept = await open(ready(), { hideDrafts: true, hideOlderThan: '30' })
  assert.ok(kept.shows('5 hidden by filters'))
  assert.ok(!kept.shows('acme/skills #3'))
  await kept.close()

  const gone = await open(ready(), { hideOlderThan: '60' })
  await gone.view.press({ text: 'Show 2 more' })
  assert.ok(gone.shows('acme/web #60'))
  await gone.close()
})

test('開いたときは古ければ取り、ボタンを押したときは必ず取る', async () => {
  const { view, asked, close } = await open()
  assert.deepEqual(asked, [300_000])
  await view.press({ label: 'Refresh' })
  assert.deepEqual(asked, [300_000, 0])
  await close()
})

test('ワーカーが知らせてきたら、出し直す', async () => {
  const { view, shows, close } = await open()
  await view.post('prs.changed', ready({ mine: [row('new/one #1', 'merge')] }))
  assert.ok(shows('new/one #1'))
  assert.ok(!shows('acme/api #482'))
  await close()
})

test('まだ取れていない間は、0 件と見せない', async () => {
  const { view, shows, close } = await open({ ...STARTING, fetching: true })
  assert.ok(!shows('My PRs 0'))
  assert.ok(view.find({ label: 'Loading pull requests' }))
  await close()
})

test('取れなければ理由を出す。前に取れた行は残す', async () => {
  const first = await open({ ...STARTING, status: 'problem', problem: 'gh is not signed in' })
  assert.ok(first.shows('gh is not signed in'))
  assert.ok(!first.shows('My PRs 0'))
  await first.close()

  const later = await open(ready({ status: 'problem', problem: 'GitHub did not answer in time' }))
  assert.ok(later.shows('GitHub did not answer in time'))
  assert.ok(later.shows('acme/api #482'))
  await later.close()
})

test('ワーカーが動いていなければ、その理由を出す', async () => {
  const host = mockHost({
    requests: {
      'prs.get': () => {
        throw hostError('unavailable', 'no worker')
      },
      'prs.refresh': () => {
        throw hostError('unavailable', 'no worker')
      },
    },
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: /no worker/ }))
  await view.unmount()
})

test('読めなかったものや、取らなかったものがあれば伝える', async () => {
  const { shows, close } = await open(
    ready({
      warning: '1 pull request could not be read',
      omitted: { mine: 30, reviews: 0 },
    }),
  )
  assert.ok(shows('1 pull request could not be read'))
  assert.ok(shows('Only the most recent were checked. 30 more on GitHub'))
  await close()
})
