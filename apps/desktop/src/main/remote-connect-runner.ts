import { execFile, spawn } from 'node:child_process'

export interface ConnectConnector {
  stop(): Promise<void>
}

/** Detects the user's installed connector without downloading or installing anything. */
export function probeConnectConnector(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('cloudflared', ['--version'], { timeout: 5000, windowsHide: true }, (error) =>
      resolve(error === null),
    )
  })
}

/** Runs one outbound connector; credentials are environment-only and no connector output is logged. */
export function runConnectConnector(
  token: string,
  callbacks: { onReady(): void; onExit(): void },
): Promise<ConnectConnector> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, TUNNEL_TOKEN: token }
    delete env['ARI_CONTROL_TOKEN']
    const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', 'run'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    let ready = false
    let stopping = false
    let tail = ''
    const output = (data: Buffer): void => {
      tail = (tail + data.toString('utf8')).slice(-4096)
      if (!ready && tail.includes('Registered tunnel connection')) {
        ready = true
        callbacks.onReady()
      }
    }
    child.stdout.on('data', output)
    child.stderr.on('data', output)
    child.once('error', () => {
      reject(new Error('The Cloudflare connector could not start.'))
      if (!stopping) callbacks.onExit()
    })
    child.once('exit', () => {
      if (!stopping) callbacks.onExit()
    })
    child.once('spawn', () =>
      resolve({
        stop: () =>
          new Promise<void>((done) => {
            stopping = true
            if (child.exitCode !== null || child.signalCode !== null) {
              done()
              return
            }
            const timeout = setTimeout(() => {
              child.kill('SIGKILL')
              done()
            }, 3000)
            timeout.unref()
            child.once('exit', () => {
              clearTimeout(timeout)
              done()
            })
            child.kill()
          }),
      }),
    )
  })
}
