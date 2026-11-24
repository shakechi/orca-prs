// PR のパネル（試作）。
//
// 自分の PR と、自分に来ているレビュー依頼を、何を待っているかの状態ごとに並べる。
// 行は決め打ちの見本で、GitHub にはまだ問い合わせない。
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
  Link,
  List,
  ListItem,
  Row,
  read,
  Stack,
  set,
  Tab,
  Tabs,
  Text,
  Toolbar,
  update,
} from 'orca'

/** 状態ごとに、はじめから出す行の数。 */
const LIMIT = 5

/** 古いものを隠さない、という選択。 */
const ANY_AGE = 'any'

/** 古いものを隠すときに選べる日数。これ以上の日数、更新がないものを隠す。 */
const AGE_CHOICES = [7, 14, 30]

/** Draft を隠すか。 */
const hideDrafts = atom('hideDrafts', false, { persist: 'plugin' })

/** 何日以上更新のないものを隠すか。日数の文字列か、隠さないなら ANY_AGE。 */
const hideOlderThan = atom('hideOlderThan', ANY_AGE, { persist: 'plugin' })

/** 「Show n more」でひらいてある状態の名前。 */
const expanded = atom<string[]>('expandedGroups', [])

type Tone = 'neutral' | 'success' | 'warning' | 'danger'

type SamplePr = {
  id: string
  place: string
  note: string
  age: string
  // 最後の更新からの日数
  days: number
  draft?: boolean
}

type Group = {
  label: string
  tone: Tone
  // 相手を待っている状態は、点を白抜きにする
  hollow: boolean
  prs: SamplePr[]
}

const MINE: Group[] = [
  {
    label: 'Todo',
    tone: 'neutral',
    hollow: false,
    // 新しい順。レビューを頼む前の PR は、たまりやすい
    prs: [
      { id: 'a501', place: 'acme/api #501', note: 'Draft', draft: true, age: '2h', days: 0 },
      { id: 'a498', place: 'acme/api #498', note: 'CI passed', age: '1d', days: 1 },
      { id: 'w97', place: 'acme/web #97', note: 'Draft', draft: true, age: '3d', days: 3 },
      {
        id: 'k11',
        place: 'notes #11',
        note: 'No checks',
        age: '8d',
        days: 8,
      },
      { id: 'd19', place: 'acme/docs #19', note: 'CI passed', age: '12d', days: 12 },
      { id: 'a455', place: 'acme/api #455', note: 'Draft', draft: true, age: '40d', days: 40 },
      { id: 'w60', place: 'acme/web #60', note: 'Draft', draft: true, age: '90d', days: 90 },
    ],
  },
  {
    label: 'Waiting',
    tone: 'neutral',
    hollow: true,
    prs: [{ id: 'a490', place: 'acme/api #490', note: 'kato', age: '1d', days: 1 }],
  },
  {
    label: 'Fix',
    tone: 'danger',
    hollow: false,
    // 直す理由は 3 つ。レビューの修正依頼、CI の失敗、コンフリクト。どれなのかは 2 行目に出す
    prs: [
      {
        id: 'a482',
        place: 'acme/api #482',
        note: 'Changes requested · 3 comments',
        age: '2d',
        days: 2,
      },
      { id: 'w95', place: 'acme/web #95', note: 'CI failed', age: '4h', days: 0 },
      { id: 'm3', place: 'dotfiles #3', note: 'Conflict', age: '30d', days: 30 },
    ],
  },
  {
    label: 'Merge',
    tone: 'success',
    hollow: false,
    prs: [{ id: 'd17', place: 'acme/docs #17', note: 'CI passed', age: '5d', days: 5 }],
  },
]

const FOR_ME: Group[] = [
  {
    label: 'Review',
    tone: 'warning',
    hollow: false,
    prs: [{ id: 'w91', place: 'acme/web #91', note: 'by kato', age: '3h', days: 0 }],
  },
  {
    label: 'Waiting',
    tone: 'neutral',
    hollow: true,
    prs: [
      { id: 'w88', place: 'acme/web #88', note: 'by sato', age: '2d', days: 2 },
      { id: 'd12', place: 'acme/docs #12', note: 'by mori', age: '45d', days: 45 },
    ],
  },
]

/** maxDays は、これ以上の日数、更新がないものを隠す境目。隠さないなら null。 */
type Filters = { drafts: boolean; maxDays: number | null }

/** Draft か古さで隠す行か。 */
function hiddenByFilters(pr: SamplePr, filters: Filters): boolean {
  return (
    (filters.drafts && pr.draft === true) ||
    (filters.maxDays !== null && pr.days >= filters.maxDays)
  )
}

/** Draft と古さで絞った並び。状態は、空になっても残す。自分の PR だけ、これを通す。 */
function narrow(groups: Group[], filters: Filters): Group[] {
  return groups.map((group) => ({
    ...group,
    prs: group.prs.filter((pr) => !hiddenByFilters(pr, filters)),
  }))
}

function count(groups: Group[]): number {
  return groups.reduce((sum, group) => sum + group.prs.length, 0)
}

function toggle(id: string): void {
  update(expanded, (open) => (open.includes(id) ? open.filter((x) => x !== id) : [...open, id]))
}

function GroupRows({ group, id }: { group: Group; id: string }) {
  const open = read(expanded).includes(id)
  const shown = open ? group.prs : group.prs.slice(0, LIMIT)
  const hidden = group.prs.length - shown.length
  return (
    <Stack gap="none">
      <Row justify="between" align="center">
        <Text size="xs" tone={group.tone} weight="semibold" muted={group.tone === 'neutral'}>
          {group.label}
        </Text>
        <Text size="xs" muted>
          {String(group.prs.length)}
        </Text>
      </Row>
      {shown.length === 0 ? null : (
        <List label={group.label}>
          {shown.map((pr) => (
            <ListItem key={pr.id}>
              <Row gap="xs" align="start">
                <Text tone={group.tone} muted={group.tone === 'neutral'} size="xs">
                  {group.hollow ? '○' : '●'}
                </Text>
                <Box grow shrink minWidth={0} direction="column" gap="none">
                  <Text truncate size="xs" weight="semibold" muted={group.hollow}>
                    {pr.place}
                  </Text>
                  <Text truncate muted size="xs">
                    {pr.note}
                  </Text>
                </Box>
                <Box shrink={false} direction="row" gap="xs" align="center">
                  <Text muted size="xs">
                    {pr.age}
                  </Text>
                </Box>
              </Row>
            </ListItem>
          ))}
        </List>
      )}
      {group.prs.length > LIMIT ? (
        <Text size="xs">
          <Link onPress={() => toggle(id)}>{open ? 'Show less' : `Show ${hidden} more`}</Link>
        </Text>
      ) : null}
    </Stack>
  )
}

/** 自分が動く番の PR の数。相手を待っている状態は数えない。 */
function onMe(groups: Group[]): number {
  return count(groups.filter((group) => !group.hollow))
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

export default function PrsPanel() {
  const age = read(hideOlderThan)
  const filters: Filters = {
    drafts: read(hideDrafts),
    maxDays: age === ANY_AGE ? null : Number(age),
  }
  const mine = narrow(MINE, filters)
  const hidden = count(MINE) - count(mine)
  return (
    <Stack gap="sm">
      <Text size="xs" muted>
        Sample rows. Nothing is fetched from GitHub yet.
      </Text>
      {/* 自分の PR と、自分に来ているレビュー依頼は、タブで切り替える。数は自分が動く番のもの */}
      <Tabs label="Pull requests" defaultValue="mine">
        <Tab value="mine" label={`My PRs ${onMe(mine)}`}>
          <Stack gap="sm">
            <MineFilters filters={filters} hidden={hidden} />
            {mine.map((group) => (
              <GroupRows key={group.label} group={group} id={`mine:${group.label}`} />
            ))}
          </Stack>
        </Tab>
        <Tab value="reviews" label={`Reviews ${onMe(FOR_ME)}`}>
          <Stack gap="sm">
            {FOR_ME.map((group) => (
              <GroupRows key={group.label} group={group} id={`reviews:${group.label}`} />
            ))}
          </Stack>
        </Tab>
      </Tabs>
    </Stack>
  )
}
