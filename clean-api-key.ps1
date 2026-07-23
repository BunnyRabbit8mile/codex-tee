# clean-api-key.ps1 — 清除 git 历史中暴露的所有 API 密钥
# 用法: powershell -ExecutionPolicy Bypass -File clean-api-key.ps1
#
# 此脚本会重写整个 git 历史，将密钥替换为 REDACTED。
# 运行前会自动创建备份分支。运行后需要 force-push 到远程。

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# 所有需要清除的密钥
$SECRET_KEYS = @(
    @{ Name = "Langfuse Public Key"; Value = "REDACTED" },
    @{ Name = "Langfuse Secret Key"; Value = "REDACTED" },
    @{ Name = "LLM API Key";         Value = "REDACTED" }
)
$REPLACEMENT = "REDACTED"
$TIMESTAMP = Get-Date -Format "yyyyMMdd_HHmmss"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Git 历史密钥清理工具" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "将清理以下密钥:" -ForegroundColor White
foreach ($k in $SECRET_KEYS) {
    Write-Host "  - $($k.Name): $($k.Value)" -ForegroundColor Gray
}
Write-Host "替换为:   $REPLACEMENT"
Write-Host "仓库路径: $root"
Write-Host ""

# ── 1. 检查是否为 git 仓库 ──────────────────────────────
if (-not (Test-Path ".git")) {
    Write-Host "[ERROR] 当前目录不是 git 仓库" -ForegroundColor Red
    exit 1
}

# ── 2. 检查是否有未提交的更改 ────────────────────────────
$status = git status --porcelain 2>&1
if ($status) {
    Write-Host "[ERROR] 工作区有未提交的更改，请先 commit 或 stash" -ForegroundColor Red
    Write-Host $status
    exit 1
}

# ── 3. 扫描哪些提交包含密钥 ──────────────────────────────
Write-Host "[1/5] 扫描包含密钥的提交..." -ForegroundColor Yellow
$totalFound = 0
foreach ($k in $SECRET_KEYS) {
    $commits = git log --all --oneline -S $k.Value 2>&1
    if ($commits) {
        $c = ($commits | Measure-Object -Line).Lines
        $totalFound += $c
        Write-Host "  $($k.Name): $c 个提交" -ForegroundColor Gray
        $commits | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    } else {
        Write-Host "  $($k.Name): 未找到（已清除或从未存在）" -ForegroundColor DarkGreen
    }
}

if ($totalFound -eq 0) {
    Write-Host ""
    Write-Host "[OK] 未在 git 历史中找到任何密钥，无需清理" -ForegroundColor Green
    exit 0
}
Write-Host ""

# ── 4. 创建备份 ──────────────────────────────────────────
$backupBranch = "backup/pre-clean-$TIMESTAMP"
Write-Host "[2/5] 创建备份分支: $backupBranch" -ForegroundColor Yellow
git branch $backupBranch 2>&1 | Out-Null
Write-Host "  备份已创建（可用 git checkout $backupBranch 恢复）" -ForegroundColor Gray
Write-Host ""

# ── 5. 选择清理方式 ──────────────────────────────────────
$useFilterRepo = $false
$filterRepo = Get-Command "git-filter-repo" -ErrorAction SilentlyContinue
if (-not $filterRepo) {
    $pip = Get-Command "pip" -ErrorAction SilentlyContinue
    if ($pip) {
        Write-Host "[3/5] 尝试安装 git-filter-repo..." -ForegroundColor Yellow
        try {
            pip install git-filter-repo 2>&1 | Out-Null
            $filterRepo = Get-Command "git-filter-repo" -ErrorAction SilentlyContinue
        } catch { }
    }
}

if ($filterRepo) {
    $useFilterRepo = $true
    Write-Host "[3/5] 使用 git-filter-repo（推荐，速度快）" -ForegroundColor Yellow

    # 创建替换规则文件（每行一个替换规则）
    $replacementsFile = Join-Path $env:TEMP "git-filter-replacements.txt"
    $lines = @()
    foreach ($k in $SECRET_KEYS) {
        $lines += "literal:$($k.Value)==>$REPLACEMENT"
    }
    $lines -join "`n" | Out-File -FilePath $replacementsFile -Encoding utf8 -NoNewline

    Write-Host "  正在重写历史（可能需要一些时间）..." -ForegroundColor Gray
    git filter-repo --replace-text $replacementsFile --force 2>&1 | ForEach-Object {
        Write-Host "  $_" -ForegroundColor DarkGray
    }

    Remove-Item $replacementsFile -ErrorAction SilentlyContinue
} else {
    Write-Host "[3/5] git-filter-repo 不可用，回退到 git filter-branch" -ForegroundColor Yellow
    Write-Host "  （速度较慢，大型仓库可能需要较长时间）" -ForegroundColor Gray
    Write-Host "  正在重写历史..." -ForegroundColor Gray

    $env:FILTER_BRANCH_SQUELCH_WARNING = "1"

    # 为每个密钥生成 sed 替换命令
    $sedCmds = ($SECRET_KEYS | ForEach-Object { "s/$($_.Value)/$REPLACEMENT/g" }) -join "; "
    $filterCmd = "git grep -l -- '$($SECRET_KEYS[0].Value)' -- . ':(exclude).git' 2>/dev/null | while IFS= read -r f; do sed -i '$sedCmds' `"`$f`"; done || true"

    git filter-branch --tree-filter $filterCmd --prune-empty -- --all 2>&1 | ForEach-Object {
        Write-Host "  $_" -ForegroundColor DarkGray
    }
}
Write-Host ""

# ── 6. 验证清理结果 ──────────────────────────────────────
Write-Host "[4/5] 验证清理结果..." -ForegroundColor Yellow
$allClean = $true
foreach ($k in $SECRET_KEYS) {
    $remaining = git log --all --oneline -S $k.Value 2>&1
    if ($remaining) {
        $allClean = $false
        Write-Host "  [WARNING] $($k.Name) 仍有残留:" -ForegroundColor Red
        Write-Host $remaining -ForegroundColor DarkRed
    } else {
        Write-Host "  [OK] $($k.Name) 已清除" -ForegroundColor Green
    }
}

if (-not $allClean) {
    Write-Host ""
    Write-Host "  建议尝试 BFG Repo-Cleaner: https://rtyley.github.io/bfg-repo-cleaner/" -ForegroundColor Yellow
}

# 检查当前工作区
$workDirClean = $true
foreach ($k in $SECRET_KEYS) {
    $workingTree = Select-String -Path "$root\*","$root\sinks\*","$root\viewer\src\*" -Pattern $k.Value -ErrorAction SilentlyContinue
    if ($workingTree) {
        $workDirClean = $false
        Write-Host "  [WARNING] 工作区文件中仍有 $($k.Name):" -ForegroundColor Red
        $workingTree | ForEach-Object { Write-Host "    $($_.Path):$($_.LineNumber)" -ForegroundColor DarkRed }
    }
}
if ($workDirClean) {
    Write-Host "  [OK] 当前工作区文件中无密钥残留" -ForegroundColor Green
}
Write-Host ""

# ── 7. 后续操作提示 ──────────────────────────────────────
Write-Host "[5/5] 后续操作" -ForegroundColor Yellow
Write-Host ""
Write-Host "  1. 检查重写结果:" -ForegroundColor White
Write-Host "     git log --oneline -10" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  2. 强制推送到远程（覆盖历史）:" -ForegroundColor White
Write-Host "     git push origin --force --all" -ForegroundColor DarkGray
Write-Host "     git push origin --force --tags" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  3. 通知协作者重新 clone 仓库（旧 clone 包含密钥）" -ForegroundColor White
Write-Host ""
Write-Host "  4. 确认无误后删除备份分支:" -ForegroundColor White
Write-Host "     git branch -D $backupBranch" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  5. 吊销并重新生成所有泄露的密钥:" -ForegroundColor White
Write-Host "     - Langfuse: https://cloud.langfuse.com → Project Settings → API Keys" -ForegroundColor DarkGray
Write-Host "     - LLM API Key: 在对应平台控制台吊销" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  6. 设置环境变量（使用新密钥）:" -ForegroundColor White
Write-Host "     setx QIANFAN_KEY <新LLM密钥>" -ForegroundColor DarkGray
Write-Host "     setx LANGFUSE_PUBLIC_KEY <新Langfuse公钥>" -ForegroundColor DarkGray
Write-Host "     setx LANGFUSE_SECRET_KEY <新Langfuse私钥>" -ForegroundColor DarkGray
Write-Host ""

# 清理 filter-branch 产生的备份引用
if (-not $useFilterRepo) {
    Write-Host "  清理 filter-branch 备份引用..." -ForegroundColor Gray
    git for-each-ref --format="%(refname)" refs/original/ 2>&1 | ForEach-Object {
        git update-ref -d $_ 2>&1 | Out-Null
    }
    git reflog expire --expire=now --all 2>&1 | Out-Null
    git gc --prune=now --aggressive 2>&1 | Out-Null
    Write-Host "  已清理" -ForegroundColor Green
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  清理完成" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
