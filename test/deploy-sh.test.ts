import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'

const DEPLOY_SH = fileURLToPath(new URL('../deploy.sh', import.meta.url))

type RunResult = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  /** argv of the recorded ssh invocation, or null if ssh never ran. */
  readonly sshArgs: readonly string[] | null
}

let stubDir: string

beforeEach(async () => {
  stubDir = await mkdtemp(join(tmpdir(), 'slopdeck-deploy-'))
  // Stub ssh: record argv NUL-separated (the remote command arg is
  // multi-line), exit with STUB_SSH_EXIT (default 0).
  const stub = [
    '#!/bin/sh',
    'printf \'%s\\0\' "$@" > "$STUB_SSH_LOG"',
    'exit "${STUB_SSH_EXIT:-0}"',
  ].join('\n')
  const stubPath = join(stubDir, 'ssh')
  await writeFile(stubPath, `${stub}\n`)
  await chmod(stubPath, 0o755)
})

function runDeploy(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  const logPath = join(stubDir, 'ssh-args.log')
  return new Promise((resolve) => {
    execFile(
      'bash',
      [DEPLOY_SH, ...args],
      {
        env: {
          PATH: `${stubDir}:${process.env.PATH}`,
          HOME: process.env.HOME ?? '',
          STUB_SSH_LOG: logPath,
          ...env,
        },
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? ((error as unknown as { code: number }).code)
            : error
              ? 1
              : 0
        readFile(logPath, 'utf8').then(
          (recorded) =>
            resolve({ code, stdout, stderr, sshArgs: recorded.replace(/\0$/, '').split('\0') }),
          () => resolve({ code, stdout, stderr, sshArgs: null }),
        )
      },
    )
  })
}

describe('deploy.sh', () => {
  it('fails with usage when no host is configured, without invoking ssh', async () => {
    const result = await runDeploy([])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('usage')
    expect(result.stderr).toContain('SLOPDECK_DEPLOY_HOST')
    expect(result.sshArgs).toBeNull()
  })

  it('deploys main over ssh to the host given as argument', async () => {
    const result = await runDeploy(['deploy@vps.example.com'])
    expect(result.code).toBe(0)
    expect(result.sshArgs).not.toBeNull()
    const args = result.sshArgs ?? []
    expect(args).toContain('deploy@vps.example.com')
    const remoteCommand = args[args.length - 1]
    expect(remoteCommand).toContain('git pull --ff-only origin main')
    expect(remoteCommand).toContain('docker compose up -d --build')
    // Compose file lives in deploy/, so the remote command must land there.
    expect(remoteCommand).toContain('deploy')
  })

  it('falls back to SLOPDECK_DEPLOY_HOST when no argument is given', async () => {
    const result = await runDeploy([], { SLOPDECK_DEPLOY_HOST: 'deploy@env.example.com' })
    expect(result.code).toBe(0)
    expect(result.sshArgs ?? []).toContain('deploy@env.example.com')
  })

  it('honors SLOPDECK_DEPLOY_PATH for the remote checkout location', async () => {
    const result = await runDeploy(['deploy@vps.example.com'], {
      SLOPDECK_DEPLOY_PATH: '/srv/apps/slopdeck',
    })
    expect(result.code).toBe(0)
    const remoteCommand = (result.sshArgs ?? []).at(-1) ?? ''
    expect(remoteCommand).toContain("cd '/srv/apps/slopdeck'")
  })

  it('layers the mps override and targets only the gateway in hosted mode', async () => {
    const result = await runDeploy(['deploy@vps.example.com'], {
      SLOPDECK_DEPLOY_MODE: 'hosted',
    })
    expect(result.code).toBe(0)
    const remoteCommand = (result.sshArgs ?? []).at(-1) ?? ''
    // Hosted layers the Caddy-free override and brings up only the gateway, so
    // the base Caddy never starts behind Dokploy's shared Traefik.
    expect(remoteCommand).toContain('-f docker-compose.yml -f docker-compose.mps.yml')
    expect(remoteCommand).toContain('up -d --build gateway')
  })

  it('stays on the base compose stack by default (no override, all services)', async () => {
    const result = await runDeploy(['deploy@vps.example.com'])
    const remoteCommand = (result.sshArgs ?? []).at(-1) ?? ''
    expect(remoteCommand).not.toContain('docker-compose.mps.yml')
    expect(remoteCommand).toContain('docker compose up -d --build')
  })

  it('propagates a remote failure as a non-zero exit', async () => {
    const result = await runDeploy(['deploy@vps.example.com'], { STUB_SSH_EXIT: '7' })
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toContain('Deployed.')
  })
})
