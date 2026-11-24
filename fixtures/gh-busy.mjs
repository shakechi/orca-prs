#!/usr/bin/env node
// gh のふりをする。`orca plugin check` と撮影で、決まった PR を返す。中身は架空のもの。

import { answer, checks, prNode, requested, reviewed } from './samples.ts'

const DAY = 24 * 60 * 60 * 1000
const ago = (days) => ({ updatedAt: new Date(Date.now() - days * DAY).toISOString() })

/** 架空の PR。組織も人も実在しない。 */
const pr = (place, days, headRefName, title, overrides = {}) =>
  prNode(place, { ...ago(days), headRefName, title, ...overrides })
const by = (login) => ({ author: { login } })
const DRAFT = { isDraft: true }

const MINE = [
  // Fix
  pr('acme/web#95', 0.2, 'me/fix-date-picker', 'Fix the date picker on small screens', {
    commits: checks('FAILURE'),
  }),
  pr('acme/api#482', 2, 'me/retry-webhooks', 'Retry failed webhooks with backoff', {
    reviewDecision: 'CHANGES_REQUESTED',
    latestOpinionatedReviews: reviewed('mika', 'CHANGES_REQUESTED'),
    reviewThreads: {
      totalCount: 3,
      nodes: [{ isResolved: false }, { isResolved: false }, { isResolved: true }],
    },
  }),
  pr('me/dotfiles#3', 30, 'me/zsh-startup', 'Speed up shell startup', { mergeable: 'CONFLICTING' }),
  // Todo
  pr('acme/api#501', 0.1, 'me/rate-limit', 'Add a rate limit to the public API', DRAFT),
  pr('acme/api#498', 1, 'me/audit-log', 'Write an audit log for admin actions'),
  pr('acme/web#97', 3, 'me/dark-mode', 'Support dark mode in the settings page', {
    ...DRAFT,
    commits: checks('FAILURE'),
  }),
  pr('me/notes#11', 8, 'me/search', 'Search notes by tag', { commits: checks(null) }),
  pr('acme/docs#19', 12, 'me/quick-start', 'Rewrite the quick start', {
    commits: checks('PENDING'),
  }),
  pr('acme/api#455', 40, 'me/grpc-spike', 'Try gRPC for internal calls', DRAFT),
  pr('acme/web#60', 90, 'me/new-editor', 'Prototype a new editor', DRAFT),
  // Waiting
  pr('acme/api#490', 1, 'me/cache-headers', 'Send cache headers for static files', {
    reviewRequests: requested('jordan'),
    latestOpinionatedReviews: reviewed('mika', 'APPROVED'),
  }),
  // Merge
  pr('acme/docs#17', 5, 'me/fix-typos', 'Fix typos in the install guide', {
    reviewDecision: 'APPROVED',
  }),
]
const REQUESTED = [
  pr('acme/web#91', 0.1, 'mika/upload-progress', 'Show progress while uploading', by('mika')),
  pr('acme/api#488', 1, 'jordan/split-config', 'Split the config by environment', {
    ...by('jordan'),
    commits: checks('FAILURE'),
  }),
]
const REVIEWED = [
  pr('acme/web#88', 2, 'alex/lazy-images', 'Load images lazily', {
    ...by('alex'),
    latestOpinionatedReviews: reviewed('me', 'CHANGES_REQUESTED'),
  }),
]

let input = ''
for await (const chunk of process.stdin) input += chunk
const { q } = JSON.parse(input).variables
if (q.includes(' author:@me')) console.log(answer(MINE))
else console.log(answer(q.includes('reviewed-by:@me') ? REVIEWED : REQUESTED))
