# Installs the same released code as install.sh, using native Windows tools.
$ErrorActionPreference = 'Stop'
$installArgs = @($args)
$published = 'https://github.com/KKKKhazix/agent-autoloop.git'
$repository = if ($env:AGENT_AUTOLOOP_REPO) { $env:AGENT_AUTOLOOP_REPO } else { $published }
$installRoot = if ($env:AGENT_AUTOLOOP_HOME) { [IO.Path]::GetFullPath($env:AGENT_AUTOLOOP_HOME) } else { Join-Path $env:USERPROFILE '.agent-autoloop' }
$app = Join-Path $installRoot 'app'
$program = Join-Path $app 'bin\agent-autoloop.ts'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$git = (Get-Command git.exe -ErrorAction Stop).Source
$nodeVersion = & $node -p process.versions.node
if ($LASTEXITCODE -ne 0 -or [int]$nodeVersion.Split('.')[0] -lt 24) { throw '需要 Node.js 24 或更新，装好后再运行安装命令。' }

function Invoke-RepoGit {
    & $git @args
    if ($LASTEXITCODE -ne 0) { throw "Git 没成功：$($args[0])" }
}

[IO.Directory]::CreateDirectory($installRoot) | Out-Null
$from = $repository
if (Test-Path (Join-Path $app '.git')) { $from = Invoke-RepoGit -C $app config --get remote.origin.url }
$release = $null
if ($from -eq $published) {
    $tags = Invoke-RepoGit ls-remote --refs --tags $published 'v*'
    $versions = @($tags | ForEach-Object { if ($_ -match 'refs/tags/(v\d+\.\d+\.\d+)$') { $Matches[1] } } | Sort-Object { [version]$_.Substring(1) })
    if ($versions.Count) { $release = $versions[-1] }
}
if (!(Test-Path (Join-Path $app '.git'))) {
    $clone = @('-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1')
    if ($release) { $clone += @('--branch', $release) }
    Invoke-RepoGit @clone -- $repository $app
} elseif ($release) {
    Invoke-RepoGit -C $app fetch --quiet --depth 1 origin "refs/tags/${release}:refs/tags/${release}"
    Invoke-RepoGit -C $app checkout --quiet --detach $release
} else {
    Invoke-RepoGit -C $app pull --ff-only --quiet
}

$bin = Join-Path $app 'bin'
if (!$env:AGENT_AUTOLOOP_HOME) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($bin -notin ($userPath -split ';')) {
        [Environment]::SetEnvironmentVariable('Path', ((([string]$userPath).TrimEnd(';'), $bin) -join ';'), 'User')
    }
    if ($bin -notin ($env:Path -split ';')) { $env:Path += ";$bin" }
}

if ($installArgs.Count -and $installArgs[0] -eq 'join') {
    & $node --disable-warning=ExperimentalWarning $program @installArgs
} elseif (Test-Path (Join-Path $installRoot 'config.json')) {
    Write-Host '更新好了。'
    if ('--no-service' -notin $installArgs) { & $node --disable-warning=ExperimentalWarning $program service install }
} else {
    & $node --disable-warning=ExperimentalWarning $program init @installArgs
}
if ($LASTEXITCODE -ne 0) { throw '安装没有完成，请按上面的原因处理。' }
