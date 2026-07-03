import { describe, expect, it } from 'vitest'
import { classifyBash } from '../src/gateway/bash-classifier.ts'

describe('bash classifier', () => {
  // The ticker's contract (D7): installs, migrations, docker, deploys, and
  // pushes are highlighted; everything else renders as a dim routine row.
  it.each([
    ['npm install hono', 'package-install'],
    ['cd app && pnpm add -D vitest', 'package-install'],
    ['pip install -r requirements.txt', 'package-install'],
    ['brew install caddy', 'package-install'],
    ['npx prisma migrate deploy', 'migration'],
    ['rails db:migrate', 'migration'],
    ['npm run migrate', 'migration'],
    ['docker compose up -d --build', 'docker'],
    ['docker build -t claudedeck .', 'docker'],
    ['git push --force origin main', 'git-push'],
    ['git commit -m "wip" && git push', 'git-push'],
    ['npm run deploy', 'deploy'],
    ['kubectl apply -f manifest.yaml', 'deploy'],
  ] as const)('highlights %s as %s', (command, category) => {
    expect(classifyBash(command)).toEqual({ category, risk: 'highlighted' })
  })

  it.each([
    'ls -la',
    'npm test',
    'git status',
    'git commit -m "feat: ticker"',
    'grep -r classifyBash src',
    'cat package.json',
  ])('classifies %s as routine', (command) => {
    expect(classifyBash(command)).toEqual({ category: 'routine', risk: 'routine' })
  })

  it('classifies an empty command as routine', () => {
    expect(classifyBash('')).toEqual({ category: 'routine', risk: 'routine' })
  })
})
