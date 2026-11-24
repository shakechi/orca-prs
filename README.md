# orca-prs

[Orca](https://github.com/stablyai/orca) のプラグイン。自分の PR と、自分に来ているレビュー依頼を、状態ごとに右サイドバーへ出す。

## 要るもの

- Orca 1.4.259 以上
- [GitHub CLI](https://cli.github.com/)（`gh`）。`gh auth login` でログインしておく

ログインの情報は `gh` が持つ。プラグインは受け取らず、保存もしない。GitHub へは読み取りの問い合わせだけをする。

## 出す状態

上から順に当てはめ、最初に合ったものにする。決まりは [src/classify.ts](src/classify.ts)、例は [src/classify.test.ts](src/classify.test.ts) にある。

My PRs（自分が作った、開いている PR）

| 状態 | 条件 | 誰を待っているか |
| --- | --- | --- |
| Fix | 修正依頼が残っている、CI が失敗している、コンフリクトしている、のどれか | 自分 |
| Merge | 必要な Approve がそろっている | 自分 |
| Waiting | レビューを頼んでいる、またはコメントだけのレビューが付いた | 相手 |
| Todo | それ以外（レビューをまだ頼んでいない、など） | 自分 |

- Draft は、CI の失敗やコンフリクトがあっても Todo に置く。修正依頼が残っていれば Fix。
- 修正依頼を出した人に再依頼すると、Waiting に移る。

Reviews（他人の PR）

| 状態 | 条件 | 誰を待っているか |
| --- | --- | --- |
| Review | 自分か、自分のチームに依頼が来ている | 自分 |
| Waiting | 自分が修正依頼かコメントを出し、再依頼がまだ来ていない | 相手 |

自分が Approve した PR は出さない。

## 動き

- My PRs は Fix、Todo、Waiting、Merge の順に並べる。
- 1 行目はリポジトリと番号、2 行目は理由と題。
- 行を押すと、その PR をブラウザーで開く。
- パネルを開いたときと、見えている間は、5 分より古ければ取り直す。右上のボタンで、すぐに取り直す。
- 1 つの検索で新しいほうから 200 件まで読む。それより多ければ、残りの数を出す。
- 取れなかったときは理由を出し、前に取れた行を残す。
- 一部しか読めなかった PR は `Not fully read` と出し、Merge には置かない。

## 設定

| 名前 | 意味 |
| --- | --- |
| Repositories to show | 対象。`acme`、`acme/api` のように、空白、カンマ、改行で区切って並べる。空なら全部 |
| Path to the gh command | `gh` の場所。空なら PATH から探す |

## 作り

```
panel.tsx ──(prs.refresh)──> worker.ts ──> collect.ts ──> gh.ts ──> gh api graphql
    ^                            |            |
    └──────(prs.changed)─────────┘            ├─ github.ts    検索の文と、応答の読み取り
                                              └─ classify.ts  状態と 2 行目を決める
```

## 開発

ビルドはない。Orca が `src/` のファイルを読み込むときに変換する。

```sh
npm install
orca plugin dev load .     # このフォルダーを開発用のプラグインとして Orca に読み込む（承認が要る）
npm run check              # 型、書式、マニフェスト、テスト、パネルの検査
orca plugin shot local.prs # パネルを Orca が描くとおりに PNG で保存する
```

`fixtures/` は、テストと検査で使う偽物の `gh`。GitHub には問い合わせない。

画面の文は英語、コメントとこの文書は日本語で書く。
