// `orca plugin test .` が、Orca と同じ実行環境の Node でこのファイルを動かす。
import { assert, mount, test } from 'orca/testing'
import * as panel from './panel.tsx'

test('はじめは自分の PR を、状態ごとに出す', async () => {
  const view = await mount(panel)

  for (const label of ['Todo', 'Waiting', 'Fix', 'Merge']) {
    assert.ok(view.find({ text: label }), `${label} が出ていない`)
  }
  assert.ok(view.find({ text: 'acme/api #482' }))
  // 直す理由は、レビューでも CI でもコンフリクトでも、2 行目に出る
  for (const reason of ['Changes requested · 3 comments', 'CI failed', 'Conflict']) {
    assert.ok(view.find({ text: reason }), `${reason} が出ていない`)
  }
  assert.equal(view.find({ text: 'acme/web #91' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('タブを切り替えると、自分に来ているレビュー依頼を出す', async () => {
  const view = await mount(panel)

  await view.select({ label: 'Pull requests' }, 'reviews')
  for (const label of ['Review', 'Waiting']) {
    assert.ok(view.find({ text: label }), `${label} が出ていない`)
  }
  assert.ok(view.find({ text: 'acme/web #91' }))
  assert.equal(view.find({ text: 'acme/api #482' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('タブには、自分が動く番の数を出す', async () => {
  const view = await mount(panel)
  assert.ok(view.find({ text: 'My PRs 11' }))
  assert.ok(view.find({ text: 'Reviews 1' }))
  await view.unmount()
})

test('見本であることを断っている', async () => {
  const view = await mount(panel)
  assert.ok(view.find({ text: 'Sample rows. Nothing is fetched from GitHub yet.' }))
  await view.unmount()
})

test('状態ごとに、新しいほうから 5 件だけ出し、残りは押すとひらく', async () => {
  const view = await mount(panel)

  assert.ok(view.find({ text: 'acme/api #501' }))
  assert.ok(view.find({ text: 'acme/web #97' }))
  assert.equal(view.find({ text: 'acme/web #60' }), null)

  await view.press({ text: 'Show 2 more' })
  assert.ok(view.find({ text: 'acme/web #60' }))

  await view.press({ text: 'Show less' })
  assert.equal(view.find({ text: 'acme/web #60' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Draft を隠すと、Draft の行が消え、隠した数が出る', async () => {
  const view = await mount(panel)
  assert.equal(view.find({ text: '4 hidden by filters' }), null)

  await view.press({ text: 'Hide drafts' })
  assert.equal(view.find({ text: 'acme/api #501' }), null)
  assert.ok(view.find({ text: 'acme/api #498' }))
  assert.ok(view.find({ text: '4 hidden by filters' }))
  // Todo は 7 件から 3 件に。Fix 3 件と Merge 1 件はそのまま
  assert.ok(view.find({ text: 'My PRs 7' }))

  await view.press({ text: 'Hide drafts' })
  assert.ok(view.find({ text: 'acme/api #501' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('古さは日数を選んで隠す。自分の PR の全部の状態に効く', async () => {
  const view = await mount(panel)
  assert.ok(view.find({ text: 'dotfiles #3' }))

  await view.press({ text: '30d' })
  // 30 日ちょうどの行も隠す。Todo の 40 日と 90 日、Fix の 30 日
  assert.equal(view.find({ text: 'dotfiles #3' }), null)
  assert.ok(view.find({ text: 'acme/docs #17' }))
  assert.ok(view.find({ text: '3 hidden by filters' }))
  assert.ok(view.find({ text: 'My PRs 8' }))

  await view.press({ text: '7d' })
  // Todo の 8 日、12 日、40 日、90 日と、Fix の 30 日
  assert.equal(view.find({ text: 'acme/docs #19' }), null)
  assert.ok(view.find({ text: 'acme/docs #17' }))
  assert.ok(view.find({ text: '5 hidden by filters' }))
  assert.ok(view.find({ text: 'My PRs 6' }))

  // 選んである日数をもう一度押すと、古さでは隠さなくなる
  await view.press({ text: '7d' })
  assert.ok(view.find({ text: 'dotfiles #3' }))
  assert.equal(view.find({ text: '5 hidden by filters' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Draft と古さの絞り込みは、レビュー依頼には効かない', async () => {
  const view = await mount(panel)

  await view.press({ text: '30d' })
  await view.select({ label: 'Pull requests' }, 'reviews')
  // 45 日前のレビューは、そのまま出る。絞り込みの部品も、このタブにはない
  assert.ok(view.find({ text: 'acme/docs #12' }))
  assert.equal(view.find({ text: 'Hide drafts' }), null)
  assert.equal(view.find({ text: '3 hidden by filters' }), null)

  await view.select({ label: 'Pull requests' }, 'mine')
  await view.press({ text: '30d' })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
