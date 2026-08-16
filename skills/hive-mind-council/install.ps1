param(
    [string]$InstallPath = ".agents\skills\hive-mind-council"
)

Write-Host "Installing The Hive Skill to $InstallPath..."

# Create the directory if it doesn't exist
if (!(Test-Path -Path $InstallPath)) {
    New-Item -ItemType Directory -Force -Path $InstallPath | Out-Null
}

# Copy the skill files
# Assuming this script is run from the root of the repository
$SourcePath = "skills\hive-mind-council"
if (Test-Path -Path $SourcePath) {
    Copy-Item -Path "$SourcePath\*" -Destination $InstallPath -Recurse -Force
    Write-Host "Installation complete." -ForegroundColor Green
} else {
    Write-Host "Error: Directory '$SourcePath' not found." -ForegroundColor Red
    Write-Host "Please run this script from the root of the the-hive-skill repository." -ForegroundColor Yellow
    exit 1
}
