import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { serve } from '@hono/node-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateHookSettings } from '../src/config-generator/generate.ts'
import { buildApp, DECK_TOKEN, HOOK_TOKEN } from './helpers.ts'

/**
 * CANARY — the AskUserQuestion hack rides on UNDOCUMENTED Claude Code
 * behavior (D3): a PreToolUse `deny` whose reason carries the tapped choice,
 * which Claude reads as the answer. This test drives a REAL Claude Code
 * session end-to-end (via the Agent SDK, which runs the claude binary; plain
 * `claude -p` cannot host AskUserQuestion) and must be re-run after every
 * Claude Code upgrade:
 *
 *     npm run canary
 *
 * It is skipped in the normal suite (gated by CLAUDEDECK_CANARY=1) because it
 * spawns a live session — slow, needs working Claude Code credentials, and
 * consumes tokens. Occasional terminal re-asks (the "ask" fallback racing the
 * deck's answer) are expected behavior, not bugs; a genuine failure is Claude
 * no longer treating the deny reason as the answer.
 *
 * Regression signal: if the PreToolUse hook stops resolving the question, the
 * SDK's canUseTool fallback fires instead and answers "Crimson" — so a
 * "crimson" result means the undocumented mechanism broke, while "teal"
 * proves the deck's tap was the answer the session proceeded with.
 */
describe.runIf(process.env.CLAUDEDECK_CANARY === '1')(
  'canary: AskUserQuestion via real Claude Code',
  () => {
    let server: ReturnType<typeof serve>
    let baseUrl: string
    let settingsDir: string

    beforeAll(async () => {
      const { app } = buildApp()
      await new Promise<void>((resolve) => {
        server = serve({ fetch: app.fetch, port: 0 }, (info) => {
          baseUrl = `http://127.0.0.1:${info.port}`
          resolve()
        })
      })
      settingsDir = await mkdtemp(join(tmpdir(), 'claudedeck-canary-'))
    })

    afterAll(async () => {
      server.close()
      await rm(settingsDir, { recursive: true, force: true })
    })

    it('a real session proceeds with the choice the deck tapped', { timeout: 240_000 }, async () => {
      const settingsPath = join(settingsDir, 'settings.json')
      await writeFile(
        settingsPath,
        JSON.stringify(generateHookSettings({ gatewayUrl: baseUrl, interceptQuestions: true })),
      )

      // The deck side: watch the SSE stream and tap "Teal" when the card lands.
      const controller = new AbortController()
      const deckAnswered = (async () => {
        const streamResponse = await fetch(`${baseUrl}/api/stream?token=${DECK_TOKEN}`, {
          signal: controller.signal,
        })
        const reader = streamResponse.body!.getReader()
        const decoder = new TextDecoder()
        let frames = ''
        while (!frames.includes('event: question')) {
          frames += decoder.decode((await reader.read()).value)
        }
        const promptId = /"promptId":"([^"]+)"/.exec(frames)![1]!
        const answer = await fetch(`${baseUrl}/api/questions/${promptId}/answer`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${DECK_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ choice: 'Teal' }),
        })
        expect(answer.status).toBe(200)
      })()

      // The workstation side: a real Claude Code session instructed to ask.
      // canUseTool is the regression detector — it only fires if the PreToolUse
      // hook did NOT resolve the question, and it answers the other color.
      let hookWasBypassed = false
      let resultText = ''
      for await (const message of query({
        prompt:
          'Use the AskUserQuestion tool exactly once to ask me which color to use, ' +
          'with exactly two options labeled "Crimson" and "Teal". ' +
          'Then reply with exactly the chosen color in lowercase and nothing else.',
        options: {
          // No allowedTools: a bare entry would auto-approve AskUserQuestion
          // ahead of canUseTool and blind the regression detector below.
          extraArgs: { settings: settingsPath },
          // The generated settings carry `Bearer $CLAUDEDECK_HOOK_TOKEN`;
          // Claude Code interpolates it from the environment at hook time.
          env: { ...process.env, CLAUDEDECK_HOOK_TOKEN: HOOK_TOKEN },
          canUseTool: async (toolName, input) => {
            if (toolName === 'AskUserQuestion') {
              hookWasBypassed = true
              const questions = (input as { questions?: readonly { question: string }[] })
                .questions
              return {
                behavior: 'allow',
                updatedInput: {
                  questions,
                  answers: Object.fromEntries(
                    (questions ?? []).map((q) => [q.question, 'Crimson']),
                  ),
                },
              }
            }
            return { behavior: 'allow', updatedInput: input }
          },
        },
      })) {
        if (message.type === 'result' && message.subtype === 'success') {
          resultText = message.result
        }
      }

      await deckAnswered
      controller.abort()

      // The deny-with-reason path answered — the terminal dialog never ran.
      expect(hookWasBypassed).toBe(false)
      // The selection made on the deck is the one the session proceeded with.
      expect(resultText.toLowerCase()).toContain('teal')
      expect(resultText.toLowerCase()).not.toContain('crimson')
    })
  },
)
