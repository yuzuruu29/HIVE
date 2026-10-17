# Temporary CI diagnostic: where does the DPAPI helper's PowerShell spend its time on this runner?
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$psHome51 = "$env:SystemRoot\System32\WindowsPowerShell\v1.0"
function T([string]$label, [string]$script, [hashtable]$vars, [string]$stdin) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  $psi = [Diagnostics.ProcessStartInfo]::new($ps, "-NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded")
  $psi.UseShellExecute = $false; $psi.RedirectStandardError = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardInput = $true
  $psi.EnvironmentVariables.Clear(); foreach ($k in $vars.Keys) { $psi.EnvironmentVariables[$k] = $vars[$k] }
  $sw = [Diagnostics.Stopwatch]::StartNew(); $p = [Diagnostics.Process]::Start($psi)
  if ($stdin) { $p.StandardInput.WriteLine($stdin) }; $p.StandardInput.Close()
  $errTask = $p.StandardError.ReadToEndAsync(); $outTask = $p.StandardOutput.ReadToEndAsync()
  if (-not $p.WaitForExit(45000)) { $p.Kill(); Write-Host ("{0,-28} TIMEOUT >45000 ms" -f $label); return }
  $err = $errTask.Result; if ($err.Length -gt 300) { $err = $err.Substring(0, 300) }
  Write-Host ("{0,-28} {1,6} ms  exit {2}  out={3}  err={4}" -f $label, $sw.ElapsedMilliseconds, $p.ExitCode, $outTask.Result.Length, ($err -replace "`r?`n", ' | '))
}
$bare = @{ SystemRoot = $env:SystemRoot; PSModulePath = "$psHome51\Modules" }
$rich = @{ SystemRoot = $env:SystemRoot; PSModulePath = "$psHome51\Modules"; USERPROFILE = $env:USERPROFILE; APPDATA = $env:APPDATA; LOCALAPPDATA = $env:LOCALAPPDATA; TEMP = $env:TEMP; TMP = $env:TMP; PATH = $env:PATH }
$import = "Import-Module (Join-Path `$PSHOME 'Modules\Microsoft.PowerShell.Utility')"
$protect = "`$ErrorActionPreference='Stop'; $import; Add-Type -AssemblyName System.Security; `$b=[Text.Encoding]::UTF8.GetBytes('x'); `$r=[Security.Cryptography.ProtectedData]::Protect(`$b,`$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write(`$r.Length)"
$readline = "`$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new(`$false); `$l=[Console]::ReadLine(); [Console]::Write(`$l.Length)"
Write-Host "whoami: $(whoami)  session: $([Environment]::UserInteractive)"
foreach ($pair in @(@('bare', $bare), @('rich', $rich))) {
  $n = $pair[0]; $v = $pair[1]
  T "$n exit" 'exit 0' $v
  T "$n import" $import $v
  T "$n addtype" "$import; Add-Type -AssemblyName System.Security" $v
  T "$n readline-stdin" $readline $v '{"operation":"encrypt","data":"eA=="}'
  T "$n protect" $protect $v
}
