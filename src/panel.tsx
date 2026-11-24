// PR のパネル。
//
// 自分の PR と、自分に来ているレビュー依頼を、次に自分がやることの状態ごとに並べる。
// 状態と 2 行目を決めるのはワーカー（classify.ts）で、ここで決めるのは並べ方と絞り込みだけ。
//
// 量が多い人のための絞り込み。数も、絞ったあとのものを出す。
// - Draft を隠す、決めた日数より長く更新のないものを隠す（My PRs のタブのすぐ下。
//   自分の PR の全部の状態に効く。レビュー依頼には効かない。選んだ内容は次に開いても残る）
// - 状態ごとに、新しいほうから LIMIT 件だけ出し、残りは「Show n more」でひらく
// 隠した数は、絞り込みのすぐ下に出す。黙って消えたようには見せない。

import {
  atom,
  Box,
  Button,
  Callout,
  IconButton,
  Link,
  List,
  ListItem,
  type PanelContext,
  plugin,
  RelativeTime,
  Row,
  read,
  Spinner,
  Stack,
  set,
  shell,
  Tab,
  Tabs,
  Text,
  Toolbar,
  update,
} from 'orca'
import {
  MINE_STATES,
  type MineState,
  type PrRow,
  type PrsState,
  REVIEW_STATES,
  type ReviewState,
} from './protocol.ts'

/** 状態ごとに、はじめから出す行の数。 */
const LIMIT = 5

/** 古いものを隠さない、という選択。 */
const ANY_AGE = 'any'

/** 古いものを隠すときに選べる日数。これ以上の日数、更新がないものを隠す。 */
const AGE_CHOICES = [7, 14, 30]

const DAY_MS = 24 * 60 * 60 * 1000
/** これより新しければ、取り直さない。 */
const MAX_AGE_MS = 5 * 60 * 1000
/** 取り直すかを確かめる間隔。取り直すのは、パネルが見えていて、MAX_AGE_MS を過ぎたときだけ。 */
const CHECK_MS = 60 * 1000
/** 取り終わるのを待つ長さの上限。過ぎても、結果は prs.changed で届く。 */
const REFRESH_TIMEOUT_MS = 120 * 1000

/** ワーカーから届いた、いちばん新しいもの。届くまでは null。 */
const prs = atom<PrsState | null>(null)

/** ワーカーに頼めなかった理由。 */
const failure = atom<string | null>(null)

/** ブラウザーで開けなかった理由。次に開けたら消す。 */
const openFailure = atom<string | null>(null)

/** Draft を隠すか。 */
const hideDrafts = atom('hideDrafts', false, { persist: 'plugin' })

/** 何日以上更新のないものを隠すか。日数の文字列か、隠さないなら ANY_AGE。 */
const hideOlderThan = atom('hideOlderThan', ANY_AGE, { persist: 'plugin' })

/** 「Show n more」でひらいてある状態の名前。 */
const expanded = atom<string[]>('expandedGroups', [])

type Tone = 'neutral' | 'success' | 'warning' | 'danger'

interface Look {
  label: string
  tone: Tone
  // 相手を待っている状態は、点を白抜きにする
  hollow: boolean
}

const MINE_LOOK: Record<MineState, Look> = {
  todo: { label: 'Todo', tone: 'neutral', hollow: false },
  waiting: { label: 'Waiting', tone: 'neutral', hollow: true },
  fix: { label: 'Fix', tone: 'danger', hollow: false },
  merge: { label: 'Merge', tone: 'success', hollow: false },
}

const REVIEW_LOOK: Record<ReviewState, Look> = {
  review: { label: 'Review', tone: 'warning', hollow: false },
  waiting: { label: 'Waiting', tone: 'neutral', hollow: true },
}

interface Group extends Look {
  id: string
  rows: PrRow[]
}

/** 状態ごとに分ける。空の状態も残す。 */
function groupsOf<S extends string>(
  tab: string,
  states: readonly S[],
  look: Record<S, Look>,
  rows: readonly PrRow<S>[],
): Group[] {
  return states.map((state) => ({
    ...look[state],
    id: `${tab}:${state}`,
    rows: rows.filter((row) => row.state === state),
  }))
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** ワーカーから届いたものを出す。 */
function receive(next: PrsState): void {
  const current = read(prs)
  // 休んでいたワーカーが起き直すと、空から始まる。取り終わるまでは、前の行を出しておく
  const restarted = next.status === 'starting' && current !== null && current.fetchedAt !== null
  set(prs, restarted ? { ...current, fetching: next.fetching } : next)
  // 届いたのなら、ワーカーは動いている
  set(failure, null)
}

let requests = 0

async function refresh(maxAgeMs: number): Promise<void> {
  const mine = ++requests
  const startedAt = Date.now()
  try {
    const next = await plugin.request(
      'prs.refresh',
      { maxAgeMs },
      { timeoutMs: REFRESH_TIMEOUT_MS },
    )
    receive(next)
  } catch (error) {
    const current = read(prs)
    // あとから頼んだものがあるか、待つのをやめたあとに取れていたら、この失敗はもう古い
    if (mine !== requests) return
    if (current !== null && (current.fetchedAt ?? 0) >= startedAt) return
    // ワーカーが途中で止まったときに、「取得中」のまま、押し直せなくならないようにする
    if (current !== null) set(prs, { ...current, fetching: false })
    set(failure, messageOf(error))
  }
}

async function openInBrowser(url: string): Promise<void> {
  try {
    await shell.openExternal(url)
    set(openFailure, null)
  } catch (error) {
    set(openFailure, messageOf(error))
  }
}

export function setup(ctx: PanelContext): () => void {
  ctx.subscriptions.push(plugin.on('prs.changed', receive))
  // ワーカーが前に取ったものがあれば、先に出す
  plugin
    .request('prs.get')
    .then((next) => {
      if (read(prs) === null) set(prs, next)
    })
    // 続けて頼む refresh も同じ理由で失敗し、そちらが理由を出す
    .catch(() => undefined)
  void refresh(MAX_AGE_MS)
  const timer = setInterval(() => {
    if (read(ctx.visible)) void refresh(MAX_AGE_MS)
  }, CHECK_MS)
  return () => clearInterval(timer)
}

function toggle(id: string): void {
  update(expanded, (open) => (open.includes(id) ? open.filter((x) => x !== id) : [...open, id]))
}

function GroupRows({ group }: { group: Group }) {
  const open = read(expanded).includes(group.id)
  const shown = open ? group.rows : group.rows.slice(0, LIMIT)
  const hidden = group.rows.length - shown.length
  return (
    <Stack gap="none">
      <Row justify="between" align="center">
        <Text size="xs" tone={group.tone} weight="semibold" muted={group.tone === 'neutral'}>
          {group.label}
        </Text>
        <Text size="xs" muted>
          {String(group.rows.length)}
        </Text>
      </Row>
      {shown.length === 0 ? null : (
        <List label={group.label}>
          {shown.map((row) => (
            <ListItem key={row.id} onPress={() => openInBrowser(row.url)}>
              <Row gap="xs" align="start">
                {/* 丸は縮めない。縮むと、長い題の行で文字に重なる */}
                <Box shrink={false}>
                  <Text tone={group.tone} muted={group.tone === 'neutral'} size="xs">
                    {group.hollow ? '○' : '●'}
                  </Text>
                </Box>
                <Box grow shrink minWidth={0} direction="column" gap="none">
                  <Text truncate size="xs" weight="semibold" muted={group.hollow}>
                    {row.place}
                  </Text>
                  <Text truncate muted size="xs">
                    {/* 理由が先。題は長いことがあり、先に置くと理由が切れて見えなくなる */}
                    {row.title === '' ? row.note : `${row.note} · ${row.title}`}
                  </Text>
                </Box>
                <Box shrink={false} direction="row" gap="xs" align="center">
                  <Text muted size="xs">
                    {/* 外の Text の muted は効かないので、ここにも付ける */}
                    <RelativeTime at={row.updatedAt} format="duration" muted />
                  </Text>
                </Box>
              </Row>
            </ListItem>
          ))}
        </List>
      )}
      {group.rows.length > LIMIT ? (
        <Text size="xs">
          <Link onPress={() => toggle(group.id)}>{open ? 'Show less' : `Show ${hidden} more`}</Link>
        </Text>
      ) : null}
    </Stack>
  )
}

/** maxDays は、これ以上の日数、更新がないものを隠す境目。隠さないなら null。 */
interface Filters {
  drafts: boolean
  maxDays: number | null
}

/** Draft か古さで隠す行か。 */
function hiddenByFilters(row: PrRow, filters: Filters, now: number): boolean {
  if (filters.drafts && row.draft) return true
  return filters.maxDays !== null && now - row.updatedAt >= filters.maxDays * DAY_MS
}

/** 自分が動く番の PR の数。相手を待っている状態は数えない。 */
function onMe(groups: Group[]): number {
  return groups.reduce((sum, group) => sum + (group.hollow ? 0 : group.rows.length), 0)
}

/** Draft と古さの絞り込み。自分の PR の全部の状態に効く。 */
function MineFilters({ filters, hidden }: { filters: Filters; hidden: number }) {
  return (
    <Stack gap="xs">
      {/* 文字の大きさを変えられる部品は Text と Button だけ。Select と Checkbox は大きいまま
          なので、絞り込みは小さいボタンで組む。入っているものは濃い塗りで示す。
          tone を付けない塗りは、明るいテーマで薄い灰色になり、見分けにくい */}
      <Row gap="sm" align="center" wrap>
        <Button
          size="xs"
          variant={filters.drafts ? 'solid' : 'outline'}
          tone={filters.drafts ? 'accent' : 'neutral'}
          icon={filters.drafts ? 'check' : undefined}
          onPress={() => set(hideDrafts, !filters.drafts)}
        >
          Hide drafts
        </Button>
        <Row gap="xs" align="center" wrap>
          {/* 見出しは縮めない。縮むと、狭い幅で 2 行に割れる */}
          <Box shrink={false}>
            <Text size="xs" muted>
              Hide older than
            </Text>
          </Box>
          {/* 選んである日数をもう一度押すと、古さでは隠さなくなる */}
          <Toolbar label="Hide older than" gap="none">
            {AGE_CHOICES.map((days) => (
              <Button
                key={days}
                size="xs"
                variant={filters.maxDays === days ? 'solid' : 'ghost'}
                tone={filters.maxDays === days ? 'accent' : 'neutral'}
                onPress={() =>
                  set(hideOlderThan, filters.maxDays === days ? ANY_AGE : String(days))
                }
              >
                {`${days}d`}
              </Button>
            ))}
          </Toolbar>
        </Row>
      </Row>
      {hidden > 0 ? (
        <Text size="xs" muted>
          {`${hidden} hidden by filters`}
        </Text>
      ) : null}
    </Stack>
  )
}

/** 多すぎて取らなかったものがあること。 */
function Omitted({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <Text size="xs" muted>
      {`Only the most recent were checked. ${count} more on GitHub`}
    </Text>
  )
}

function Header({ state }: { state: PrsState }) {
  return (
    <Row justify="between" align="center" gap="xs">
      <Text size="xs" muted>
        {state.fetchedAt === null ? 'Not updated yet' : 'Updated '}
        {/* 既定の形は Orca の言語で出て、英語の文と混ざる。duration はどの言語でも 6s のように出る */}
        {state.fetchedAt === null ? null : (
          <RelativeTime at={state.fetchedAt} format="duration" muted />
        )}
        {state.fetchedAt === null ? null : ' ago'}
      </Text>
      {state.fetching ? (
        <Spinner label="Updating" labelHidden />
      ) : (
        <IconButton
          icon="refresh"
          label="Refresh"
          variant="ghost"
          size="xs"
          onPress={() => refresh(0)}
        />
      )}
    </Row>
  )
}

export default function PrsPanel() {
  const state = read(prs)
  const failed = read(failure)
  const notOpened = read(openFailure)
  const age = Number(read(hideOlderThan))
  const filters: Filters = {
    drafts: read(hideDrafts),
    // 前の版で選べた日数が残っていても、いまのボタンで解除できないものは使わない
    maxDays: AGE_CHOICES.includes(age) ? age : null,
  }

  if (state === null) {
    return failed === null ? (
      <Spinner label="Loading pull requests" />
    ) : (
      <Callout tone="danger" title="Could not load" icon="error">
        <Text size="xs">{failed}</Text>
      </Callout>
    )
  }

  const now = Date.now()
  const kept = state.mine.filter((row) => !hiddenByFilters(row, filters, now))
  const mine = groupsOf('mine', MINE_STATES, MINE_LOOK, kept)
  const reviews = groupsOf('reviews', REVIEW_STATES, REVIEW_LOOK, state.reviews)
  const problem = state.problem ?? failed

  return (
    <Stack gap="sm">
      <Header state={state} />
      {problem === null ? null : (
        <Callout tone="danger" title="Could not update" icon="error">
          <Text size="xs">{problem}</Text>
        </Callout>
      )}
      {notOpened === null ? null : (
        <Callout tone="danger" title="Could not open in the browser" icon="error">
          <Text size="xs">{notOpened}</Text>
        </Callout>
      )}
      {state.warning === null ? null : (
        <Text size="xs" tone="warning">
          {state.warning}
        </Text>
      )}
      {/* まだ 1 回も取れていないときに、空の一覧を「0 件」と見せない */}
      {state.fetchedAt === null ? (
        problem === null ? (
          <Spinner label="Loading pull requests" />
        ) : null
      ) : (
        // 自分の PR と、自分に来ているレビュー依頼は、タブで切り替える。数は自分が動く番のもの
        <Tabs label="Pull requests" defaultValue="mine">
          <Tab value="mine" label={`My PRs ${onMe(mine)}`}>
            <Stack gap="sm">
              <MineFilters filters={filters} hidden={state.mine.length - kept.length} />
              {mine.map((group) => (
                <GroupRows key={group.id} group={group} />
              ))}
              <Omitted count={state.omitted.mine} />
            </Stack>
          </Tab>
          <Tab value="reviews" label={`Reviews ${onMe(reviews)}`}>
            <Stack gap="sm">
              {reviews.map((group) => (
                <GroupRows key={group.id} group={group} />
              ))}
              <Omitted count={state.omitted.reviews} />
            </Stack>
          </Tab>
        </Tabs>
      )}
    </Stack>
  )
}
