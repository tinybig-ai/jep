// Work started on purpose without waiting for it: a stamp written in the
// background, an abort sent to a server that may never answer, a queue pump.
// Nobody is there to hear if it fails, and Node's answer to a rejection that
// nobody handles is to end the process. That is how one hung opencode server
// took the whole daemon down (Telegram and every other harness with it): the
// adapter sent it an abort, the abort timed out, and nothing was listening.
// So a detached promise is named, and its failure is a log line, never a crash.
// The lint (eslint.config.mjs) refuses any promise left floating without this.
export function detach(what: string, work: Promise<unknown> | undefined): void {
  work?.catch((err: unknown) => {
    console.error(`[detached] ${what} failed: ${(err as Error)?.stack ?? err}`)
  })
}
