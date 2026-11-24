// gh コマンドで GitHub に問い合わせる。Node.js の仕組みを使うのは、このファイルだけ。
// ログインの情報は gh が持つ。このプラグインは受け取らず、保存もしない。
//
// Orca を Finder から起動すると、ワーカーの PATH にはシェルで足した場所が入らない。
// 見つからなかったときは、ログインシェルに PATH を聞いてやり直す。

import { type ChildProcess, execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** ワーカーが GitHub に頼むこと。テストでは、偽物に差し替える。 */
export interface GitHub {
  /** GraphQL の応答の全文。使える応答がなければ、利用者に見せる説明を Error で投げる。 */
  graphql(query: string, variables: Record<string, string | null>): Promise<string>
  /** 実行の途中のコマンドを終わらせる。 */
  dispose(): void
}

export interface GhOptions {
  // 設定に書かれたコマンドの場所。空なら、PATH から gh を探す
  command: string
  env?: NodeJS.ProcessEnv
  // ログインシェルに PATH を聞く。テストで差し替える
  askShellPath?: () => Promise<string | null>
  timeoutMs?: number
}

interface Outcome {
  code: number | string
  stdout: string
  stderr: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
/** gh が「ログインしていない」で終わるときの値。 */
const NOT_SIGNED_IN = 4
const MARK_BEGIN = '__PRS_PATH_BEGIN__'
const MARK_END = '__PRS_PATH_END__'

/** ログインシェルが持っている PATH。聞けなければ null。 */
export function askLoginShellPath(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return new Promise((resolve) => {
    // 設定ファイルが余計な文字を出しても取り出せるように、目印で挟む
    const script = `printf '${MARK_BEGIN}%s${MARK_END}' "$PATH"`
    const shell = env.SHELL ?? '/bin/zsh'
    execFile(shell, ['-ilc', script], { timeout: 5000, env }, (_error, stdout) => {
      const begin = stdout.indexOf(MARK_BEGIN)
      const end = stdout.indexOf(MARK_END)
      if (begin < 0 || end < begin) resolve(null)
      else resolve(stdout.slice(begin + MARK_BEGIN.length, end) || null)
    })
  })
}

function mergePath(...parts: (string | null | undefined)[]): string {
  const all = parts.flatMap((part) => (part ?? '').split(':')).filter((dir) => dir !== '')
  return [...new Set(all)].join(':')
}

/** 応答の JSON が標準出力にあるか。gh は、GitHub が一部だけ失敗を返したときも 1 で終わる。 */
const hasAnswer = (outcome: Outcome) => outcome.stdout.trimStart().startsWith('{')

function explain(command: string, outcome: Outcome, timedOut: boolean): string {
  if (timedOut) return 'GitHub did not answer in time'
  if (outcome.code === 'ENOENT') {
    return `The gh command (${command}) was not found. Install GitHub CLI, or set its path in the plugin settings`
  }
  if (outcome.code === 'EACCES') return `No permission to run the gh command (${command})`
  if (outcome.code === NOT_SIGNED_IN) {
    return 'gh is not signed in to GitHub. Run gh auth login in a terminal'
  }
  const last = outcome.stderr.trim().split('\n').at(-1) ?? ''
  return last.replace(/^gh: /, '') || `gh stopped (${outcome.code})`
}

export function createGh(options: GhOptions): GitHub {
  const command = options.command.trim() === '' ? 'gh' : options.command.trim()
  const baseEnv = options.env ?? process.env
  const askShellPath = options.askShellPath ?? (() => askLoginShellPath(baseEnv))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const running = new Set<ChildProcess>()
  let disposed = false
  // よくある置き場所を、最初から足しておく
  let path = mergePath(
    baseEnv.PATH,
    '/opt/homebrew/bin:/usr/local/bin',
    join(homedir(), '.local', 'bin'),
  )
  // 同時に何件か失敗しても、聞くのは 1 回だけ
  let widening: Promise<boolean> | null = null

  function widenPath(): Promise<boolean> {
    widening ??= askShellPath().then((shellPath) => {
      const next = mergePath(shellPath, path)
      if (shellPath === null || next === path) return false
      path = next
      return true
    })
    return widening
  }

  function runOnce(input: string): Promise<Outcome & { timedOut: boolean }> {
    return new Promise((resolve) => {
      const child = execFile(
        command,
        ['api', 'graphql', '--input', '-'],
        {
          env: {
            ...baseEnv,
            PATH: path,
            // 端末に聞きに行かせない。色や更新の知らせも出させない
            GH_PROMPT_DISABLED: '1',
            GH_NO_UPDATE_NOTIFIER: '1',
            NO_COLOR: '1',
          },
          timeout: timeoutMs,
          // 終わるように頼んでも聞かないコマンドを、残さない
          killSignal: 'SIGKILL',
          maxBuffer: MAX_OUTPUT_BYTES,
        },
        (error, stdout, stderr) => {
          running.delete(child)
          const code = error === null ? 0 : (error.code ?? error.signal ?? 'unknown')
          // 出力が長すぎて終わらせたときは、killed にならない
          resolve({ code, stdout, stderr, timedOut: error?.killed === true })
        },
      )
      running.add(child)
      // 起動できなかったときの書き込みの失敗で、ワーカーごと落ちないようにする
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(input)
    })
  }

  return {
    async graphql(query, variables) {
      const stopped = () => new Error('The plugin was stopped')
      if (disposed) throw stopped()
      const input = JSON.stringify({ query, variables })
      let outcome = await runOnce(input)
      // 127 は、gh が使うもの（ラッパーの中身など）が見つからないとき
      if ((outcome.code === 'ENOENT' || outcome.code === 127) && (await widenPath())) {
        if (disposed) throw stopped()
        outcome = await runOnce(input)
      }
      if (disposed) throw stopped()
      if (outcome.code === 0 || (outcome.code === 1 && hasAnswer(outcome))) return outcome.stdout
      throw new Error(explain(command, outcome, outcome.timedOut))
    },

    dispose() {
      disposed = true
      for (const child of running) child.kill('SIGKILL')
      running.clear()
    },
  }
}
