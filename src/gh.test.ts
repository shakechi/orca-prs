// gh の呼び出しを、gh のふりをするスクリプトで確かめる。GitHub には問い合わせない。

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { assert, test } from 'orca/testing'
import { createGh } from './gh.ts'

const NO_SHELL = async () => null

/** gh のふりをするスクリプトを置いたフォルダー。 */
function fakeGh(body: string, name = 'gh'): { dir: string; command: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-prs-gh-'))
  const command = join(dir, name)
  writeFileSync(command, `#!/bin/sh\n${body}\n`)
  chmodSync(command, 0o755)
  return { dir, command }
}

const ask = (command: string, timeoutMs?: number) =>
  createGh({ command, askShellPath: NO_SHELL, timeoutMs }).graphql('query', { q: 'x', after: null })

test('問い合わせは標準入力で渡し、引数には入れない', async () => {
  const { dir, command } = fakeGh(
    'cd "$(dirname "$0")"; echo "$@" > args; cat > input; env > env; echo "{\\"data\\":1}"',
  )
  assert.equal(await ask(command), '{"data":1}\n')
  assert.equal(readFileSync(join(dir, 'args'), 'utf8'), 'api graphql --input -\n')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'input'), 'utf8')) as unknown, {
    query: 'query',
    variables: { q: 'x', after: null },
  })
  assert.match(readFileSync(join(dir, 'env'), 'utf8'), /^GH_PROMPT_DISABLED=1$/m)
})

test('GitHub が一部だけ失敗を返したときは、応答をそのまま返す', async () => {
  const { command } = fakeGh(
    'cat > /dev/null; echo "{\\"errors\\":[]}"; echo "gh: だめ" >&2; exit 1',
  )
  assert.equal(await ask(command), '{"errors":[]}\n')
})

test('失敗の理由を、利用者に分かる言葉にする', async () => {
  await assert.rejects(ask('/no/such/gh'), /was not found\. Install GitHub CLI/)
  await assert.rejects(ask(fakeGh('exit 4').command), /not signed in to GitHub/)
  await assert.rejects(
    ask(fakeGh('echo "gh: first" >&2; echo "gh: HTTP 502" >&2; exit 1').command),
    /^Error: HTTP 502$/,
  )
  await assert.rejects(ask(fakeGh('exit 3').command), /gh stopped \(3\)/)

  const blocked = fakeGh('exit 0').command
  chmodSync(blocked, 0o644)
  await assert.rejects(ask(blocked), /No permission to run/)
})

test('答えないコマンドは、時間切れで終わらせる', async () => {
  // 終わるように頼んでも聞かないコマンド
  const { command } = fakeGh('trap "" TERM; while :; do sleep 0.05; done')
  await assert.rejects(ask(command, 200), /did not answer in time/)
})

test('出力が長すぎるときを、時間切れと言わない', async () => {
  const { command } = fakeGh('cat > /dev/null; head -c 20000000 /dev/zero')
  await assert.rejects(ask(command), /MAXBUFFER/)
})

test('見つからないときは、ログインシェルの PATH を 1 回だけ聞いてやり直す', async () => {
  const name = `gh-${Date.now()}`
  const { dir } = fakeGh('cat > /dev/null; echo "{}"', name)
  let asked = 0
  const gh = createGh({
    command: name,
    askShellPath: async () => {
      asked += 1
      return dir
    },
  })
  const all = await Promise.all([1, 2, 3].map(() => gh.graphql('q', {})))
  assert.deepEqual(all, ['{}\n', '{}\n', '{}\n'])
  assert.equal(asked, 1)
})

test('止めると、実行の途中のコマンドも終わる', async () => {
  const { dir, command } = fakeGh(
    'cd "$(dirname "$0")"; echo $$ > pid; trap "" TERM; while :; do sleep 0.05; done',
  )
  const gh = createGh({ command, askShellPath: NO_SHELL })
  const asking = gh.graphql('q', {})
  const pidFile = join(dir, 'pid')
  const started = () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== ''
  for (let i = 0; i < 500 && !started(); i += 1) await sleep(10)
  gh.dispose()
  await assert.rejects(asking, /was stopped/)
  await assert.rejects(gh.graphql('q', {}), /was stopped/)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.throws(() => process.kill(pid, 0), /ESRCH/)
})
