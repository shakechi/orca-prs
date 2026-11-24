// `orca plugin check` と `orca plugin shot --scenario` が描く場面。
// ワーカーも一緒に動くので、設定で偽物の gh（fixtures/）を指して、決まった PR を出させる。

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineCheck } from 'orca/testing'

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const using = (name: string) => ({ settings: { command: join(FIXTURES, name) } })

export default defineCheck({
  // 全部の状態に PR がある
  busy: using('gh-busy.mjs'),
  // 絞り込みが入っている
  filtered: {
    ...using('gh-busy.mjs'),
    persisted: { plugin: { hideDrafts: true, hideOlderThan: '30' } },
  },
  // PR が 1 つもない
  empty: using('gh-empty.mjs'),
  // gh がログインしていない
  signedOut: using('gh-signed-out.mjs'),
  // gh が見つからない
  missing: using('no-such-gh'),
})
