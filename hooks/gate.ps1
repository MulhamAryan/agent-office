# agent-office — hook PreToolUse : contrôle + approbation humaine (human-in-the-loop).
# - Interroge le serveur avant chaque outil.
# - decision=deny  → refuse l'outil.
# - decision=pending → MET L'AGENT EN ATTENTE : sonde jusqu'à ta décision depuis le bureau.
# - decision=allow → laisse passer.
# Fail-open : si le serveur est injoignable, on ne bloque jamais.

$ErrorActionPreference = 'SilentlyContinue'
$raw = [Console]::In.ReadToEnd()
if (-not $raw) { exit 0 }

function Deny($reason) {
    $payload = @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = [string]$reason } } | ConvertTo-Json -Compress -Depth 5
    Write-Output $payload
    exit 0
}

try {
    $resp = Invoke-RestMethod -Uri 'http://localhost:4519/gate-check' -Method Post -Body $raw -ContentType 'application/json' -TimeoutSec 3
} catch { exit 0 }

if (-not $resp) { exit 0 }

if ($resp.decision -eq 'deny') { Deny $resp.reason }

if ($resp.decision -eq 'pending') {
    $id = $resp.id
    $maxLoops = 150   # ~5 min (150 × 2 s)
    for ($i = 0; $i -lt $maxLoops; $i++) {
        Start-Sleep -Seconds 2
        try {
            $d = Invoke-RestMethod -Uri "http://localhost:4519/gate-decision?id=$id" -Method Get -TimeoutSec 3
        } catch { exit 0 }   # serveur perdu → fail-open
        if ($d.decision -eq 'allow') { exit 0 }
        if ($d.decision -eq 'deny')  { Deny 'Refusé depuis le bureau agent-office.' }
    }
    exit 0   # timeout → fail-open (on ne bloque pas l'agent indéfiniment)
}

exit 0
