// テストと見本で使う、GitHub の応答の形。中身は架空のもの。

export type Node = Record<string, unknown>

/** 検索に出てくる PR の 1 件。 */
export function prNode(place: string, overrides: Node = {}): Node {
  const [path = '', number = '1'] = place.split('#')
  const [owner = '', name = ''] = path.split('/')
  return {
    id: `PR_${place}`,
    number: Number(number),
    url: `https://github.com/${path}/pull/${number}`,
    isDraft: false,
    updatedAt: new Date().toISOString(),
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    author: { login: 'me' },
    repository: { name, owner: { login: owner } },
    reviewRequests: { nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    latestReviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    viewerLatestReview: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    ...overrides,
  }
}

export interface AnswerOptions {
  total?: number
  next?: string | null
  errors?: string[]
}

/** 検索の応答の全文。 */
export function answer(nodes: unknown[], options: AnswerOptions = {}): string {
  return JSON.stringify({
    data: {
      viewer: { login: 'me' },
      search: {
        issueCount: options.total ?? nodes.length,
        pageInfo: { hasNextPage: options.next != null, endCursor: options.next ?? null },
        nodes,
      },
    },
    ...(options.errors ? { errors: options.errors.map((message) => ({ message })) } : {}),
  })
}

export const requested = (...logins: string[]) => ({
  nodes: logins.map((login) => ({ requestedReviewer: { __typename: 'User', login } })),
})

export const reviewed = (login: string, state: string, __typename = 'User') => ({
  nodes: [{ state, author: { __typename, login } }],
})

export const checks = (state: string | null) => ({
  nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }],
})
