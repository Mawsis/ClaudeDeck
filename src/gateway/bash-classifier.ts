export type BashRisk = 'highlighted' | 'routine'

export type BashCategory = 'package-install' | 'migration' | 'docker' | 'git-push' | 'deploy' | 'routine'

export type BashClassification = {
  readonly category: BashCategory
  readonly risk: BashRisk
}

// First match wins, so more specific intents sit above broader ones —
// `prisma migrate deploy` is a migration, not a deploy. Patterns match
// anywhere in the string: compound commands (`cd app && npm install`) and
// env prefixes must not slip through as routine. A quoted mention of a
// keyword may over-highlight; for an audit ticker a false highlight is
// cheaper than a silent high-impact action.
const HIGHLIGHT_TABLE: ReadonlyArray<{ readonly category: BashCategory; readonly pattern: RegExp }> = [
  { category: 'package-install', pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b/ },
  { category: 'package-install', pattern: /\bpip3?\s+install\b/ },
  { category: 'package-install', pattern: /\b(?:brew|apt|apt-get|gem|cargo)\s+install\b/ },
  { category: 'package-install', pattern: /\bcomposer\s+(?:require|install)\b/ },
  { category: 'migration', pattern: /\bmigrate\b/ },
  { category: 'migration', pattern: /\balembic\s+(?:upgrade|downgrade)\b/ },
  { category: 'git-push', pattern: /\bgit\s+push\b/ },
  { category: 'docker', pattern: /\bdocker(?:-compose)?\b/ },
  { category: 'deploy', pattern: /\bdeploy\b/ },
  { category: 'deploy', pattern: /\bkubectl\s+(?:apply|delete|rollout)\b/ },
  { category: 'deploy', pattern: /\bterraform\s+(?:apply|destroy)\b/ },
]

const ROUTINE: BashClassification = Object.freeze({ category: 'routine', risk: 'routine' })

export function classifyBash(command: string): BashClassification {
  const match = HIGHLIGHT_TABLE.find((entry) => entry.pattern.test(command))
  return match === undefined ? ROUTINE : { category: match.category, risk: 'highlighted' }
}
