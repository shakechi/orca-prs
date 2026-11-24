#!/usr/bin/env node
// gh のふりをする。`orca plugin check` と撮影で、決まった PR を返す。中身は架空のもの。

import { answer, checks, prNode, requested, reviewed } from './samples.ts'

const DAY = 24 * 60 * 60 * 1000
const ago = (days) => ({ updatedAt: new Date(Date.now() - days * DAY).toISOString() })

const MINE = [
  prNode('acme/api#501', { ...ago(0.1), isDraft: true }),
  prNode('acme/api#498', ago(1)),
  prNode('acme/web#97', { ...ago(3), isDraft: true, commits: checks('FAILURE') }),
  prNode('me/notes#11', { ...ago(8), commits: checks(null) }),
  prNode('acme/docs#19', { ...ago(12), commits: checks('PENDING') }),
  prNode('acme/api#455', { ...ago(40), isDraft: true }),
  prNode('acme/web#60', { ...ago(90), isDraft: true }),
  prNode('acme/api#490', {
    ...ago(1),
    reviewRequests: requested('sato'),
    latestOpinionatedReviews: reviewed('kato', 'APPROVED'),
  }),
  prNode('acme/api#482', {
    ...ago(2),
    reviewDecision: 'CHANGES_REQUESTED',
    latestOpinionatedReviews: reviewed('kato', 'CHANGES_REQUESTED'),
    reviewThreads: { nodes: [{ isResolved: false }, { isResolved: false }, { isResolved: true }] },
  }),
  prNode('acme/web#95', { ...ago(0.2), commits: checks('FAILURE') }),
  prNode('me/skills#3', { ...ago(30), mergeable: 'CONFLICTING' }),
  prNode('acme/docs#17', { ...ago(5), reviewDecision: 'APPROVED' }),
]
const REQUESTED = [prNode('acme/web#91', { ...ago(0.1), author: { login: 'kato' } })]
const REVIEWED = [
  prNode('acme/web#88', {
    ...ago(2),
    author: { login: 'sato' },
    latestOpinionatedReviews: reviewed('me', 'CHANGES_REQUESTED'),
  }),
]

let input = ''
for await (const chunk of process.stdin) input += chunk
const { q } = JSON.parse(input).variables
if (q.includes(' author:@me')) console.log(answer(MINE))
else console.log(answer(q.includes('reviewed-by:@me') ? REVIEWED : REQUESTED))
