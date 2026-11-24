// パネルとワーカーの間の約束。両方がこのファイルを読む。

/** 自分の PR の状態。並べる順。Todo がたまっても、直すものが下に隠れないようにする。 */
export const MINE_STATES = ['fix', 'todo', 'waiting', 'merge'] as const
export type MineState = (typeof MINE_STATES)[number]

/** 自分に来ているレビュー依頼の状態。並べる順。 */
export const REVIEW_STATES = ['review', 'waiting'] as const
export type ReviewState = (typeof REVIEW_STATES)[number]

/** パネルに出す 1 行。 */
export interface PrRow<S extends string = string> {
  id: string
  url: string
  // 「owner/name #番号」。自分のリポジトリなら owner を省く
  place: string
  title: string
  // 状態の理由や、誰を待っているか
  note: string
  // 最後の更新（ミリ秒）
  updatedAt: number
  draft: boolean
  state: S
}

export interface PrsState {
  // starting: まだ 1 回も取れていない。ready: 取れている。problem: 最後の取得に失敗した
  status: 'starting' | 'ready' | 'problem'
  // problem のとき、利用者に見せる説明。前に取れた行は残っている
  problem: string | null
  // 取れたが、伝えることがあるとき（一部が読めなかった、など）
  warning: string | null
  mine: PrRow<MineState>[]
  reviews: PrRow<ReviewState>[]
  // 多すぎて取らなかった数
  omitted: { mine: number; reviews: number }
  // 最後に取れた時刻（ミリ秒）
  fetchedAt: number | null
  // いま取りに行っているか
  fetching: boolean
}

declare module 'orca' {
  interface PluginRequests {
    /** いま分かっているもの。取りには行かない。 */
    'prs.get': { output: PrsState }
    /** GitHub から取る。maxAgeMs より新しければ、取らずに今のものを返す。 */
    'prs.refresh': { input: { maxAgeMs: number }; output: PrsState }
  }
  interface PluginPanelEvents {
    /** 変わるたびに、開いているパネルに届く。 */
    'prs.changed': PrsState
  }
}
