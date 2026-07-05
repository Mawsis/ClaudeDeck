/**
 * An arrow-key select menu (↑/↓ to move, Enter to pick), like `create-next-app`
 * and the Laravel installer. Returns the chosen value. Falls back to a typed
 * `(a/b)` prompt when stdin is not an interactive TTY (piped input, CI), so
 * scripted installs still work.
 */

export type MenuChoice = { readonly value: string; readonly label: string }

/** The terminal surface the menu drives; injectable so it can be tested without
 * a real TTY. Mirrors the slice of stdin/stdout the menu actually uses. */
export type MenuIo = {
  readonly isTty: boolean
  setRawMode(enabled: boolean): void
  onKey(listener: (key: string) => void): void
  offKey(listener: (key: string) => void): void
  resume(): void
  pause(): void
  write(chunk: string): void
  /** The typed-prompt fallback used when `isTty` is false. */
  ask(question: string): Promise<string>
  /** Restore the terminal and terminate on Ctrl-C, like a normal interrupt. */
  onInterrupt(): void
}

/** Escape sequences kept in one place so render/parse stay legible. */
const ESC = {
  cursorUp: (n: number) => `\x1b[${n}A`,
  clearBelow: '\x1b[J',
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
}

const UP_KEYS = new Set(['\x1b[A', 'k'])
const DOWN_KEYS = new Set(['\x1b[B', 'j'])
const ENTER_KEYS = new Set(['\r', '\n'])
const CTRL_C = '\x03'

export function selectMenu(
  question: string,
  choices: readonly MenuChoice[],
  io: MenuIo,
): Promise<string> {
  if (!io.isTty) {
    // Non-interactive: keep the typed contract — match a choice value, else the
    // first choice (a bare Enter defaults to the first, like the arrow menu).
    return io.ask(`${question} (${choices.map((c) => c.value).join('/')})`).then((answer) => {
      const match = choices.find((c) => c.value.toLowerCase() === answer.trim().toLowerCase())
      return match?.value ?? choices[0]!.value
    })
  }

  return new Promise((resolve) => {
    let selected = 0

    const render = (first: boolean) => {
      // After the first paint, move the cursor back up over the list to redraw
      // in place rather than scrolling a fresh copy each keystroke.
      if (!first) io.write(ESC.cursorUp(choices.length + 1))
      io.write(`${ESC.clearBelow}${question}\n`)
      choices.forEach((choice, i) => {
        const active = i === selected
        const pointer = active ? `${ESC.cyan('❯')} ` : '  '
        const text = active ? ESC.cyan(choice.label) : choice.label
        io.write(`${pointer}${text}\n`)
      })
    }

    const cleanup = () => {
      io.setRawMode(false)
      io.pause()
      io.offKey(onKey)
    }

    const onKey = (key: string) => {
      if (key === CTRL_C) {
        cleanup()
        io.write('\n')
        io.onInterrupt()
      } else if (ENTER_KEYS.has(key)) {
        cleanup()
        resolve(choices[selected]!.value)
      } else if (UP_KEYS.has(key)) {
        selected = (selected - 1 + choices.length) % choices.length
        render(false)
      } else if (DOWN_KEYS.has(key)) {
        selected = (selected + 1) % choices.length
        render(false)
      }
    }

    io.setRawMode(true)
    io.resume()
    io.onKey(onKey)
    render(true)
  })
}
