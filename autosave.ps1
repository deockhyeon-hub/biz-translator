# 자동 저장 — 이 저장소의 바뀐 것을 깃허브(원격)에 올린다.
#
#   내려받기(pull --rebase) → 바뀐 것 전부 담기 → 커밋 → 올리기(push)
#   바뀐 것이 없으면 아무 일도 안 한다. 충돌이 나면 rebase 를 되돌리고 autosave_log.txt 에 «충돌» 을 적는다.
#
# 쓰는 곳: 윈도우 작업 스케줄러가 10분마다 부른다 (작업 이름 program_trans-autosave).
#   직접 한 번 돌려 보기:  powershell -NoProfile -ExecutionPolicy Bypass -File .\autosave.ps1
# 기록: 저장소 바깥 %LOCALAPPDATA%\edenfarm-lab\autosave_log.txt (저장소 안에 두면 자기 기록이 자꾸 커밋된다)

$ErrorActionPreference = 'Continue'
$repo = $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA 'program_trans'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'autosave_log.txt'
function L($m) { $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m; Add-Content -Path $log -Value $line -Encoding utf8; Write-Host $line }

# git 이 PATH 에 없을 때 찾는다 (aside/sync.ps1 과 같은 요령)
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  foreach ($g in @("$env:ProgramFiles\Git\cmd", "${env:ProgramFiles(x86)}\Git\cmd", "$env:LOCALAPPDATA\Programs\Git\cmd")) {
    if (Test-Path (Join-Path $g 'git.exe')) { $env:Path = "$g;$env:Path"; break }
  }
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { L '★ git 없음'; exit 1 }

Set-Location $repo
if (Test-Path (Join-Path $repo '.git\rebase-merge')) { L '★ 지난번 rebase 가 끝나지 않은 채 남아 있음 — 사람이 봐야 한다'; exit 1 }

$changed = git status --porcelain
if ($changed) {
  git add -A 2>$null | Out-Null
  $n = ($changed | Measure-Object -Line).Lines
  git commit -q -m ("자동 저장 {0} ({1}) - 파일 {2}개" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $env:COMPUTERNAME, $n) 2>&1 | Out-Null
  L ("커밋: 파일 {0}개" -f $n)
}

# 다른 컴퓨터가 올린 것을 먼저 받는다
$pull = git pull --rebase --quiet 2>&1
if ($LASTEXITCODE -ne 0) {
  git rebase --abort 2>$null | Out-Null
  L ("★ 충돌 — 받기 실패, 되돌림. 같은 파일을 두 컴퓨터에서 고쳤을 수 있다: " + ($pull -join ' ' ).Substring(0, [Math]::Min(300, ($pull -join ' ').Length)))
  exit 1
}

# 올릴 것이 있으면 올린다
$ahead = git rev-list --count '@{u}..HEAD' 2>$null
if ($ahead -and [int]$ahead -gt 0) {
  $push = git push --quiet 2>&1
  if ($LASTEXITCODE -eq 0) { L ("올림: 커밋 {0}개" -f $ahead) } else { L ('★ 올리기 실패: ' + ($push -join ' ')) ; exit 1 }
}
