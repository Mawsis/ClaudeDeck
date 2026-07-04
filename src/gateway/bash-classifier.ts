/** D7 highlights the ticker row; D15's `high` additionally stretches the
 * approval card's hold-to-fill — the tiers are ordered, not parallel. */
export type BashRisk = 'high' | 'highlighted' | 'routine'

export type BashCategory =
  | 'destructive-delete'
  | 'force-push'
  | 'migration'
  | 'deploy'
  | 'package-install'
  | 'docker'
  | 'git-push'
  | 'routine'

export type BashClassification = {
  readonly category: BashCategory
  readonly risk: BashRisk
}

// First match wins, so more specific intents sit above broader ones —
// a force-push is not a plain git-push, and `prisma migrate deploy` is a
// migration, not a deploy. Patterns match anywhere in the string: compound
// commands (`cd app && npm install`) and env prefixes must not slip through
// as routine. A quoted mention of a keyword may over-classify; both a false
// highlight and a false long-hold are cheaper than a silent high-impact
// action or a tap-speed destructive one.
const CLASSIFICATION_TABLE: ReadonlyArray<{
  readonly category: BashCategory
  readonly risk: BashRisk
  readonly pattern: RegExp
}> = [
  // D15's high-risk tier: destructive means recursive or forced — a bare
  // single-file rm keeps the standard hold. POSIX accepts flags after the
  // paths and -R as recursive, so the flag may sit anywhere in the same
  // command — but the word-eating group stops at separators, keeping a later
  // command's flags from marking an innocent rm.
  { category: 'destructive-delete', risk: 'high', pattern: /\brm\b(?:\s+[^\s|;&]+)*\s+(?:-\w*[rfR]|--(?:recursive|force))\b/ },
  { category: 'force-push', risk: 'high', pattern: /\bgit\s+push\b.*(?:--force(?:-with-lease)?\b|\s-\w*f\b)/ },
  { category: 'migration', risk: 'high', pattern: /\bmigrate\b/ },
  { category: 'migration', risk: 'high', pattern: /\balembic\s+(?:upgrade|downgrade)\b/ },
  { category: 'package-install', risk: 'highlighted', pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b/ },
  { category: 'package-install', risk: 'highlighted', pattern: /\bpip3?\s+install\b/ },
  { category: 'package-install', risk: 'highlighted', pattern: /\b(?:brew|apt|apt-get|gem|cargo)\s+install\b/ },
  { category: 'package-install', risk: 'highlighted', pattern: /\bcomposer\s+(?:require|install)\b/ },
  { category: 'git-push', risk: 'highlighted', pattern: /\bgit\s+push\b/ },
  { category: 'docker', risk: 'highlighted', pattern: /\bdocker(?:-compose)?\b/ },
  { category: 'deploy', risk: 'high', pattern: /\bdeploy\b/ },
  { category: 'deploy', risk: 'high', pattern: /\bkubectl\s+(?:apply|delete|rollout)\b/ },
  { category: 'deploy', risk: 'high', pattern: /\bterraform\s+(?:apply|destroy)\b/ },
]

const ROUTINE: BashClassification = Object.freeze({ category: 'routine', risk: 'routine' })

export function classifyBash(command: string): BashClassification {
  const match = CLASSIFICATION_TABLE.find((entry) => entry.pattern.test(command))
  return match === undefined ? ROUTINE : { category: match.category, risk: match.risk }
}
