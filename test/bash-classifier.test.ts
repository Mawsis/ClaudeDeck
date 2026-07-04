import { describe, expect, it } from 'vitest'
import { classifyBash } from '../src/gateway/bash-classifier.ts'

describe('bash classifier', () => {
  // D15: the approval card's hold-to-fill scales with risk — destructive
  // deletes, force-pushes, migrations, and deploys demand the long hold.
  it.each([
    ['rm -rf node_modules', 'destructive-delete'],
    ['sudo rm -r /var/www', 'destructive-delete'],
    ['rm --recursive --force build', 'destructive-delete'],
    ['cd /tmp && rm -f lockfile', 'destructive-delete'],
    // POSIX allows flags after the paths, and -R is the BSD/GNU recursive
    // alias — neither ordering nor case may shorten the hold.
    ['rm dist coverage -rf', 'destructive-delete'],
    ['rm -R build', 'destructive-delete'],
    ['git push --force origin main', 'force-push'],
    ['git push origin main --force-with-lease', 'force-push'],
    ['git push -f', 'force-push'],
    ['npx prisma migrate deploy', 'migration'],
    ['rails db:migrate', 'migration'],
    ['npm run migrate', 'migration'],
    ['npm run deploy', 'deploy'],
    ['kubectl apply -f manifest.yaml', 'deploy'],
    ['terraform destroy -auto-approve', 'deploy'],
  ] as const)('rates %s high-risk as %s', (command, category) => {
    expect(classifyBash(command)).toEqual({ category, risk: 'high' })
  })

  // The ticker's contract (D7): installs, docker, and pushes are highlighted;
  // a plain push rewrites nothing, so it stays below the high-risk tier.
  it.each([
    ['npm install hono', 'package-install'],
    ['cd app && pnpm add -D vitest', 'package-install'],
    ['pip install -r requirements.txt', 'package-install'],
    ['brew install caddy', 'package-install'],
    ['docker compose up -d --build', 'docker'],
    ['docker build -t slopdeck .', 'docker'],
    ['git push origin main', 'git-push'],
    ['git commit -m "wip" && git push', 'git-push'],
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
    // A bare single-file rm keeps the standard hold — "destructive" means
    // recursive or forced (D15), not every delete.
    'rm build.log',
  ])('classifies %s as routine', (command) => {
    expect(classifyBash(command)).toEqual({ category: 'routine', risk: 'routine' })
  })

  it('classifies an empty command as routine', () => {
    expect(classifyBash('')).toEqual({ category: 'routine', risk: 'routine' })
  })
})
