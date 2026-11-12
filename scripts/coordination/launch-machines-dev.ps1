$ErrorActionPreference = 'Stop'
$env:ARI_DEV_INSTANCE = 'machines'
$env:ARI_DEV_USER_DATA = 'D:/Projects/.ari-cache/machines-dev-profile'
$env:ARI_DEV_RENDERER_PORT = '5197'
$taskWorktree = 'D:/Projects/Ari-machines'
$taskPnpm = 'C:/Users/user/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs'
$runner = Start-Process -FilePath 'node.exe' -WorkingDirectory $taskWorktree `
  -ArgumentList @('scripts/coordination/run-heavy.mjs', 'machines-dev', $taskWorktree,
    '--', 'node', $taskPnpm, '--filter', '@ari/desktop', 'dev', '--watch') `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput 'D:/Projects/.ari-cache/machines-dev-reload.log' `
  -RedirectStandardError 'D:/Projects/.ari-cache/machines-dev-reload.err.log'
@{ runnerPid = $runner.Id; app = 'Ari Dev Machines'; profile = $env:ARI_DEV_USER_DATA;
   rendererPort = 5197; gatewayPort = 8797; hostingEnabled = $false } | ConvertTo-Json -Compress
