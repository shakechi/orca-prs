// `orca plugin test .` が、Orca と同じ実行環境の Node でこのファイルを動かす。
import { assert, mount, test } from 'orca/testing'
import * as panel from './panel.tsx'

test('自分の PR と、自分に来ているレビュー依頼を、状態ごとに出す', async () => {
  const view = await mount(panel)

  for (const label of [
    'My PRs',
    'Not requested',
    'In review',
    'Changes requested',
    'Ready to merge',
    'Reviews for me',
    'Review requested',
    'Waiting for author',
  ]) {
    assert.ok(view.find({ text: label }), `${label} が出ていない`)
  }
  assert.ok(view.find({ text: 'acme/api #482' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('見本であることを断っている', async () => {
  const view = await mount(panel)
  assert.ok(view.find({ text: 'Sample rows. Nothing is fetched from GitHub yet.' }))
  await view.unmount()
})
