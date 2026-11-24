# orca-prs

[Orca](https://github.com/stablyai/orca) のプラグイン。自分の PR と、自分に来ているレビュー依頼を、状態ごとに右サイドバーへ出す。

## いまの状態

**見本の行を出すだけの試作。** GitHub にはまだ問い合わせていない。

## 出す状態

| まとまり | 状態 | 誰を待っているか |
| --- | --- | --- |
| My PRs | Not requested（レビューをまだ頼んでいない） | 自分 |
| My PRs | In review | 相手 |
| My PRs | Changes requested | 自分 |
| My PRs | Ready to merge | 自分 |
| Reviews for me | Review requested | 自分 |
| Reviews for me | Waiting for author | 相手 |

## 開発

ビルドはない。Orca が `src/panel.tsx` を読み込むときに変換する。

```sh
npm install
orca plugin dev load .     # このフォルダーを開発用のプラグインとして Orca に読み込む
npm run check              # 型、書式、マニフェスト、テスト、パネルの検査
orca plugin shot local.prs # パネルを Orca が描くとおりに PNG で保存する
```

画面の文は英語、コメントとこの文書は日本語で書く。
