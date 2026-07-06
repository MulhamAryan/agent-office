# 🏢 agent-office

Un **bureau virtuel live** qui visualise en temps réel tes sessions Claude Code comme un petit jeu de gestion vu de dessus (à la *pixel-art office*). Chaque session devient un personnage qui arrive au bureau, s'assoit, tape au clavier, cherche dans des fichiers, discute avec ses sous-agents, va boire un café ou dormir quand il a fini.

Zéro dépendance, un seul fichier (`server.js`), Node ≥ 18. État **en mémoire** (redémarrer = reset).

![office](https://img.shields.io/badge/node-%E2%89%A518-3fb950) ![deps](https://img.shields.io/badge/dependencies-0-4c9aff)

## Lancer

```bash
node server.js            # → http://localhost:4519
PORT=8080 node server.js  # port personnalisé
```

Puis ouvre **http://localhost:4519**.

## Brancher tes hooks Claude Code

Le serveur reçoit les événements des hooks Claude Code en `POST http://localhost:4519/event`.
Dans ton `~/.claude/settings.json`, ajoute un hook `http` sur chaque événement voulu :

```json
{
  "hooks": {
    "SessionStart":       [{ "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "UserPromptSubmit":   [{ "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "PreToolUse":         [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "SubagentStart":      [{ "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "SubagentStop":       [{ "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "Stop":               [{ "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "SessionEnd":         [{ "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }]
  }
}
```

## Ce que tu vois

- **Un personnage par agent** (couleur unique par projet), qui **arrive par la porte** et s'installe à un bureau libre.
- **Animations selon l'activité** : tape au clavier (Bash/Edit/Write), lit un document (Read/Grep/Search), réfléchit 💭.
- **Plaque de bureau** avec le **nom du projet**, la **durée** ⏱ et le **nombre d'actions** ⚙.
- **Badge d'icône** au-dessus de la tête indiquant l'outil en cours.
- **Discussion** : traits pointillés animés + bulles 💬 entre un chef et ses sous-agents.
- **💥 Bulle d'erreur rouge** quand un outil échoue.
- **Coin détente** : en pause l'agent va au ☕ café / 🏃 sport / 😌 canapé / 💧 fontaine ; terminé, il **dort au lit** 💤 puis quitte le bureau.
- **Clic sur un agent** → panneau détaillé (tâche, action en cours, coéquipiers, durée, actions).
- **🔍 Filtre** par projet et **🔊 sons** (activables) dans la barre du haut.

## Endpoints

| Méthode | Chemin        | Rôle                                  |
|---------|---------------|---------------------------------------|
| `POST`  | `/event`      | Ingestion des hooks (JSON)            |
| `GET`   | `/events`     | Flux SSE (temps réel)                 |
| `GET`   | `/api/state`  | Snapshot JSON de l'état               |
| `GET`   | `/`           | Le bureau virtuel                     |

## Limite connue

Claude Code ne fait pas remonter les appels d'outils **internes** de chaque sous-agent avec une attribution fiable. Les sous-agents apparaissent donc bien (arrivée/départ, collaboration) mais leur action précise n'est pas toujours détaillée.

---

Fait avec [Claude Code](https://claude.com/claude-code).
