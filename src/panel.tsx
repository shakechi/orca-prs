// PR のパネル（試作）。
//
// 自分の PR と、自分に来ているレビュー依頼を、何を待っているかの状態ごとに並べる。
// 行は決め打ちの見本で、GitHub にはまだ問い合わせない。

import { Box, List, ListItem, Row, Stack, Text } from 'orca'

type Tone = 'neutral' | 'success' | 'warning' | 'danger'

type SamplePr = {
  id: string
  place: string
  note: string
  age: string
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
    label: 'Not requested',
    tone: 'neutral',
    hollow: false,
    prs: [
      { id: 'k11', place: 'notes #11', note: 'sample', age: '8d' },
      { id: 'm3', place: 'dotfiles #3', note: 'conflict', age: '30d' },
    ],
  },
  {
    label: 'In review',
    tone: 'neutral',
    hollow: true,
    prs: [{ id: 'a490', place: 'acme/api #490', note: 'kato', age: '1d' }],
  },
  {
    label: 'Changes requested',
    tone: 'danger',
    hollow: false,
    prs: [{ id: 'a482', place: 'acme/api #482', note: '3 comments', age: '2d' }],
  },
  {
    label: 'Ready to merge',
    tone: 'success',
    hollow: false,
    prs: [{ id: 'd17', place: 'acme/docs #17', note: 'CI passed', age: '5d' }],
  },
]

const FOR_ME: Group[] = [
  {
    label: 'Review requested',
    tone: 'warning',
    hollow: false,
    prs: [{ id: 'w91', place: 'acme/web #91', note: 'by kato', age: '3h' }],
  },
  {
    label: 'Waiting for author',
    tone: 'neutral',
    hollow: true,
    prs: [{ id: 'w88', place: 'acme/web #88', note: 'by sato', age: '2d' }],
  },
]

function GroupRows({ group }: { group: Group }) {
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
      <List label={group.label}>
        {group.prs.map((pr) => (
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
    </Stack>
  )
}

export default function PrsPanel() {
  return (
    <Stack gap="sm">
      <Text size="xs" muted>
        Sample rows. Nothing is fetched from GitHub yet.
      </Text>
      <Text size="sm" weight="semibold">
        My PRs
      </Text>
      {MINE.map((group) => (
        <GroupRows key={group.label} group={group} />
      ))}
      <Text size="sm" weight="semibold">
        Reviews for me
      </Text>
      {FOR_ME.map((group) => (
        <GroupRows key={group.label} group={group} />
      ))}
    </Stack>
  )
}
