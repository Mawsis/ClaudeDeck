import { describe, expect, it } from 'vitest'
import { selectMenu, type MenuChoice, type MenuIo } from '../src/cli/select-menu.ts'

const CHOICES: MenuChoice[] = [
  { value: 'local', label: 'local — this machine' },
  { value: 'hosted', label: 'hosted — always-on' },
]

/** A fake TTY: feed it keystrokes, capture what the menu writes. */
function fakeTty() {
  let listener: ((key: string) => void) | undefined
  const writes: string[] = []
  let interrupted = false
  const io: MenuIo = {
    isTty: true,
    setRawMode: () => {},
    onKey: (l) => {
      listener = l
    },
    offKey: () => {
      listener = undefined
    },
    resume: () => {},
    pause: () => {},
    write: (chunk) => writes.push(chunk),
    ask: async () => {
      throw new Error('ask() must not be called on a TTY')
    },
    onInterrupt: () => {
      interrupted = true
    },
  }
  return {
    io,
    writes,
    press: (key: string) => listener?.(key),
    get interrupted() {
      return interrupted
    },
    get hasListener() {
      return listener !== undefined
    },
  }
}

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const ENTER = '\r'

describe('selectMenu — interactive TTY', () => {
  it('returns the first choice on a bare Enter (default)', async () => {
    const tty = fakeTty()
    const p = selectMenu('pick', CHOICES, tty.io)
    tty.press(ENTER)
    expect(await p).toBe('local')
  })

  it('moves down with the arrow key and selects the second choice', async () => {
    const tty = fakeTty()
    const p = selectMenu('pick', CHOICES, tty.io)
    tty.press(DOWN)
    tty.press(ENTER)
    expect(await p).toBe('hosted')
  })

  it('wraps around: up from the first choice lands on the last', async () => {
    const tty = fakeTty()
    const p = selectMenu('pick', CHOICES, tty.io)
    tty.press(UP)
    tty.press(ENTER)
    expect(await p).toBe('hosted')
  })

  it('supports vim keys j/k', async () => {
    const tty = fakeTty()
    const p = selectMenu('pick', CHOICES, tty.io)
    tty.press('j')
    tty.press('k')
    tty.press('j')
    tty.press(ENTER)
    expect(await p).toBe('hosted')
  })

  it('renders the active choice with a pointer and cleans up its key listener on select', async () => {
    const tty = fakeTty()
    const p = selectMenu('pick', CHOICES, tty.io)
    expect(tty.writes.join('')).toContain('❯')
    tty.press(ENTER)
    await p
    // Listener removed so a later stray keystroke can't fire into a resolved menu.
    expect(tty.hasListener).toBe(false)
  })

  it('routes Ctrl-C to the interrupt handler', async () => {
    const tty = fakeTty()
    // Never resolves on Ctrl-C; just assert the interrupt hook fired.
    void selectMenu('pick', CHOICES, tty.io)
    tty.press('\x03')
    expect(tty.interrupted).toBe(true)
  })
})

describe('selectMenu — non-TTY fallback', () => {
  function fallbackIo(answer: string): { io: MenuIo; asked: string[] } {
    const asked: string[] = []
    return {
      asked,
      io: {
        isTty: false,
        setRawMode: () => {},
        onKey: () => {},
        offKey: () => {},
        resume: () => {},
        pause: () => {},
        write: () => {},
        ask: async (q) => {
          asked.push(q)
          return answer
        },
        onInterrupt: () => {},
      },
    }
  }

  it('matches a typed choice value', async () => {
    const { io, asked } = fallbackIo('hosted')
    expect(await selectMenu('pick', CHOICES, io)).toBe('hosted')
    // The typed prompt still lists the values so a scripted user knows the options.
    expect(asked[0]).toContain('(local/hosted)')
  })

  it('is case-insensitive and trims whitespace', async () => {
    const { io } = fallbackIo('  HOSTED ')
    expect(await selectMenu('pick', CHOICES, io)).toBe('hosted')
  })

  it('defaults to the first choice on a bare Enter (empty answer)', async () => {
    const { io } = fallbackIo('')
    expect(await selectMenu('pick', CHOICES, io)).toBe('local')
  })

  it('defaults to the first choice on an unrecognized answer', async () => {
    const { io } = fallbackIo('nonsense')
    expect(await selectMenu('pick', CHOICES, io)).toBe('local')
  })
})
