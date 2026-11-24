// 画面に出す文字列の整え方。GitHub の題と、利用者に見せる説明の両方で使う。

/** 改行や見えない文字を空白にまとめ、limit 文字を超えた分は「…」にする。絵文字の途中では切らない。 */
export function toOneLine(text: string, limit: number): string {
  const letters = Array.from(text.replace(/[\s\p{Cc}]+/gu, ' ').trim())
  if (letters.length <= limit) return letters.join('')
  letters.length = limit - 1
  return `${letters.join('')}…`
}
