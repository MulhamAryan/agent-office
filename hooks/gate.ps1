# agent-office — hook PreToolUse de contrôle.
# Interroge le serveur : la session est-elle en pause / l'outil bloqué ?
# Si oui, refuse l'exécution de l'outil (permissionDecision = deny).
# Ne bloque JAMAIS si le serveur est injoignable (fail-open).

$ErrorActionPreference = 'SilentlyContinue'
$raw = [Console]::In.ReadToEnd()
if (-not $raw) { exit 0 }

try {
    $resp = Invoke-RestMethod -Uri 'http://localhost:4519/gate-check' -Method Post -Body $raw -ContentType 'application/json' -TimeoutSec 2
} catch {
    exit 0   # serveur down → on laisse passer
}

if ($resp -and $resp.block) {
    $payload = @{
        hookSpecificOutput = @{
            hookEventName            = 'PreToolUse'
            permissionDecision       = 'deny'
            permissionDecisionReason = [string]$resp.reason
        }
    } | ConvertTo-Json -Compress -Depth 5
    Write-Output $payload
}
exit 0
