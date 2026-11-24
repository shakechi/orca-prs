// ワーカーを、偽物の GitHub と、Orca の代わりのホストで動かして確かめる。

import { assert, type MockHost, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { answer, prNode } from '../fixtures/samples.ts'
import type { PrsState } from './protocol.ts'
import { createWorker, type Worker } from './worker.ts'

interface Fake {
  commands: string[]
  queries: string[]
  disposes: number
  reply: (q: string) => string | Promise<string>
}

async function start(
  options: { settings?: Record<string, string>; reply?: Fake['reply']; host?: MockHost } = {},
) {
  const fake: Fake = {
    commands: [],
    queries: [],
    disposes: 0,
    reply: options.reply ?? (() => answer([])),
  }
  let worker: Worker | null = null
  let api: OrcaWorkerApi | null = null
  const mounted = await mountWorker(
    {
      default(orca: OrcaWorkerApi) {
        api = orca
        worker = createWorker(
          orca,
          (command) => {
            fake.commands.push(command)
            return {
              async graphql(_query, { q }) {
                fake.queries.push(q ?? '')
                return fake.reply(q ?? '')
              },
              dispose() {
                fake.disposes += 1
              },
            }
          },
          { settleMs: 5 },
        )
      },
      deactivate: () => worker?.dispose(),
    },
    { host: options.host ?? mockHost({ settings: options.settings ?? {} }) },
  )
  return {
    fake,
    mounted,
    refresh: (maxAgeMs = 0) => mounted.request('prs.refresh', { maxAgeMs }),
    change: async (key: string, value: string) =>
      (api as OrcaWorkerApi | null)?.settings.set(key, value),
    states: () => mounted.posts.map((post) => post.payload as PrsState),
  }
}

/** 起きるまで待つ。起きなければ、テストを失敗させる（待ち続けない）。 */
async function until(happened: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !happened(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.ok(happened(), '待っていたことが起きなかった')
}

const isMine = (q: string) => q.includes(' author:@me')
const oneOfMine =
  (overrides = {}) =>
  (q: string) =>
    answer(isMine(q) ? [prNode('a/b#1', overrides)] : [])

test('パネルに頼まれるまで、GitHub に問い合わせない', async () => {
  const { fake, mounted } = await start()
  const state = await mounted.request('prs.get')
  assert.equal(state.status, 'starting')
  assert.equal(fake.queries.length, 0)
  await mounted.deactivate()
})

test('取りに行き、途中と結果をパネルに知らせる', async () => {
  const { mounted, refresh, states } = await start({ reply: oneOfMine() })
  const state = await refresh()
  assert.equal(state.status, 'ready')
  assert.equal(state.mine[0]?.place, 'a/b #1')
  assert.equal(state.fetching, false)
  assert.ok(state.fetchedAt !== null)
  assert.deepEqual(
    states().map((posted) => [posted.status, posted.fetching]),
    [
      ['starting', true],
      ['ready', true],
      ['ready', false],
    ],
  )
  await mounted.deactivate()
})

test('新しければ取りに行かない。頼みが重なっても、1 回だけ取る', async () => {
  const { fake, mounted, refresh } = await start()
  await Promise.all([refresh(), refresh(), refresh(60_000)])
  assert.equal(fake.queries.length, 3)
  await refresh(60_000)
  assert.equal(fake.queries.length, 3)
  await refresh(0)
  assert.equal(fake.queries.length, 6)
  await mounted.deactivate()
})

test('失敗しても、前に取れた行を残す。次に成功すれば直る', async () => {
  const { fake, mounted, refresh } = await start({ reply: oneOfMine() })
  await refresh()
  fake.reply = () => {
    throw new Error('GitHub did not answer in time')
  }
  const failed = await refresh()
  assert.equal(failed.status, 'problem')
  assert.equal(failed.problem, 'GitHub did not answer in time')
  assert.equal(failed.mine.length, 1)
  assert.equal(failed.fetching, false)

  // 失敗のあとは、新しくても取り直す
  fake.reply = oneOfMine()
  const fixed = await refresh(60_000)
  assert.equal(fixed.status, 'ready')
  assert.equal(fixed.problem, null)
  await mounted.deactivate()
})

test('コンフリクトの計算待ちがあれば、1 回だけ聞き直す', async () => {
  const { fake, mounted, refresh } = await start({ reply: oneOfMine({ mergeable: 'UNKNOWN' }) })
  await refresh()
  assert.equal(fake.queries.length, 6)
  await mounted.deactivate()
})

test('設定の対象とコマンドを使う。読めない対象は伝える', async () => {
  const { fake, mounted, refresh } = await start({
    settings: { targets: 'acme/* a/b/c', command: '/opt/gh' },
  })
  const state = await refresh()
  assert.deepEqual(fake.commands, ['/opt/gh'])
  assert.ok(fake.queries.every((q) => q.endsWith(' user:acme')))
  assert.equal(state.warning, 'Ignored targets: a/b/c')
  await mounted.deactivate()
})

test('対象が 1 つも読めなければ、全部を出さずに止める', async () => {
  const { fake, mounted, refresh } = await start({ settings: { targets: '"x"' } })
  const state = await refresh()
  assert.equal(state.status, 'problem')
  assert.match(state.problem ?? '', /targets setting: "x"/)
  assert.equal(fake.queries.length, 0)
  await mounted.deactivate()
})

test('取っている間に止められたら、何も知らせない', async () => {
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const { fake, mounted, refresh, states } = await start({
    reply: async () => {
      await held
      return answer([])
    },
  })
  const asking = refresh().catch(() => null)
  await until(() => fake.queries.length === 3)
  const before = states().length
  await mounted.deactivate()
  release()
  await asking
  assert.equal(fake.disposes, 1)
  assert.equal(states().length, before)
})

test('設定が変わったら、前の設定で取ったものを捨てて取り直す', async () => {
  const held: (() => void)[] = []
  const { fake, mounted, refresh, change, states } = await start({
    reply: async (q) => {
      if (!q.includes('user:acme')) await new Promise<void>((resolve) => held.push(resolve))
      return answer(isMine(q) ? [prNode(q.includes('user:acme') ? 'acme/api#1' : 'old/old#1')] : [])
    },
  })
  const first = refresh()
  await until(() => held.length === 3)
  await change('targets', 'acme')
  await until(() => states().at(-1)?.status === 'ready' && states().at(-1)?.fetching === false)
  // 前の設定で取りに行ったものが、遅れて届く
  for (const release of held) release()
  await first
  const last = states().at(-1)
  assert.deepEqual(
    last?.mine.map((row) => row.place),
    ['acme/api #1'],
  )
  assert.ok(states().every((posted) => posted.mine.every((row) => row.place !== 'old/old #1')))
  assert.equal(fake.disposes, 1)
  await mounted.deactivate()
})
