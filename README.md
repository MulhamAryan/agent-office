# 🏢 agent-office

Un **bureau virtuel live** qui transforme tes sessions Claude Code en un petit jeu de gestion vu de dessus : chaque session devient un personnage qui arrive, s'assoit, tape au clavier, cherche dans des fichiers, collabore avec ses sous-agents, va boire un café ou dormir quand il a fini. Avec **surveillance, contrôle (human-in-the-loop), statistiques, replay, radar d'anomalies, notifications Discord, vue isométrique** et une **bibliothèque de sessions** pour reprendre un travail.

**Un seul fichier** (`server.js`), **zéro dépendance npm**, Node ≥ 22 (utilise le module intégré `node:sqlite`). Rendu **Canvas 2D** à 60 fps, temps réel via **SSE**, persistance **SQLite**.

![node](https://img.shields.io/badge/node-%E2%89%A522-3fb950) ![deps](https://img.shields.io/badge/npm%20deps-0-4c9aff) ![db](https://img.shields.io/badge/db-SQLite-blue)

---

## 🚀 Lancer

```bash
node server.js            # → http://localhost:4519
PORT=8080 node server.js  # port personnalisé
```

Env optionnelles : `PORT`, `HOST`, `WEBHOOK_URL` (Discord/Slack), `DB_FILE`.

## 🔌 Brancher les hooks Claude Code

`POST http://localhost:4519/event`. Dans `~/.claude/settings.json` :

```json
{
  "hooks": {
    "SessionStart":       [{ "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "UserPromptSubmit":   [{ "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "PreToolUse":         [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "Notification":       [{ "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "SubagentStart":      [{ "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "SubagentStop":       [{ "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "Stop":               [{ "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }],
    "SessionEnd":         [{ "hooks": [{ "type": "http", "url": "http://localhost:4519/event", "timeout": 3 }] }]
  }
}
```

**Contrôle (Pause / Blocage / Approbation)** — ajoute un hook `PreToolUse` de type `command` sur `hooks/gate.ps1` :

```json
"PreToolUse": [{ "matcher": "*", "hooks": [
  { "type": "http", "url": "http://localhost:4519/event", "timeout": 3 },
  { "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"%USERPROFILE%\\.claude\\hooks\\gate.ps1\"" }
]}]
```

**Mode équipe** : sur d'autres machines, pointe les hooks vers `http://<ip-serveur>:4519/event` — chaque session est étiquetée par son IP (🖥️).

---

## 🧑‍💻 Le bureau
- 1 personnage par agent (couleur par projet) qui se **téléporte** à un bureau libre.
- Animations selon l'outil : tape (Bash/Edit/Write), lit (Read/Grep), réfléchit 💭.
- **Rôles de sous-agents** : 🔭 Explore · 🗺️ Plan · 🔍 review · 🛡️ security · 🧪 test · 📚 doc · 🐛 debug.
- **Salle de réunion** (workflows ≥ 2 sous-agents) : cercle dynamique autour d'une table.
- **Coin détente** : ☕ / 🏃 / 😌 / 💧 en pause ; 💤 lit puis départ quand terminé.
- **Anti-chevauchement** par séparation de forces (aucun agent superposé).
- **Vue isométrique** 🧊 (sol en losanges, volumes), **rotation** 🔄 (touche `r`), **relief 3D**.
- **Humeur** (calme / effervescent / 🔥), **jour/nuit** ☀️🌙, **thème clair/sombre** 🌓.

## 🧭 Navigation
Molette = zoom · glisser = déplacer · double-clic sur un agent = focus · **`z`** = recentrer · 🎯 = projecteur auto.

## 🔍 Surveillance
Alertes ⚠️ (boucle, échecs en série, attente, inactivité, durée dépassée) · **Radar d'anomalies** 📡 (vs baseline) · **Centre de notifications** 🛎️ · titre d'onglet `(2⚠)` · tooltip au survol · badges d'activité.

## 🖱️ Clic sur un agent
Tâche · action réelle · **historique d'outils** · **sparkline** · **fichiers travaillés** (liens `vscode://`) · **métriques par outil** + taux d'échec · **coéquipiers cliquables** · **💬 Conversation** (transcript) · **🔎 Sous-agents** (activité extraite des sidechains) · contrôle.

## 🎛️ Contrôle (human-in-the-loop)
Via `hooks/gate.ps1` (fail-open) : **⏸ Pause**, **🚫 Bloquer un outil**, **🖐️ Exiger OK** (l'agent attend ; une carte apparaît près de lui avec la commande + **✅/⛔**).

## 📈 Statistiques 📊
Uptime · total actions · **histogramme horaire** · **Gantt** · **classement projets** · **score & badges** · **heatmap calendrier**.

## 🕘 Historique & ⏪ Replay
Journal SQL persistant + **recherche** + **diff des éditions** · **Replay** : rejoue le bureau à n'importe quel instant (scrub) ou en ×60.

## 📚 Bibliothèque de sessions (reprise)
Mémoire locale de toutes tes sessions (actives + archivées). Bouton **⤴ Reprendre** → copie `cd "<cwd>" ; claude --resume <id>` à coller dans le terminal du projet. **🕘 Historique** par session.

## 🔔 Notifications Discord (configurables · ⚙️)
Webhook Discord/Slack (persisté). Toggles par type (échec / tâche / pipeline / session / approbation / règles / sous-agent / bloqué) · **heures silencieuses** · **@ping rôle** sur erreur · **digest quotidien** · **webhook par projet** · **moteur de règles** (« N erreurs », « fichier modifié »). Sons distincts : 💥 erreur · 🎵 fin · 🔔 approbation.

## 🧰 Confort
Vue **liste** ☰ · **plein écran / TV** 📺 · **command palette Ctrl+K** · **export MD** 📄 · **nettoyage** 🧹 (+ auto-purge) · panneau Équipe déplaçable/repliable, **groupé par projet** · **PWA installable** · responsive mobile.
Raccourcis : `f` TV · `t` équipe · `l` thème · `m` liste · `s` stats · `h` historique · `r` rotation iso · `/` recherche · `z` recentrer · `Ctrl+K` palette · `Échap` fermer.

## 💾 Persistance — SQLite (`office.db`)
| Table | Contenu |
|-------|---------|
| `sessions` | 1 ligne par session (id, project, cwd, model, status, dates, host, transcriptPath, lastPrompt, summary + agents/toolCounts/toolFails/files en JSON), index `project`/`status` |
| `journal` | tous les events (index `ts`/`session`, + diff des éditions) |
| `kv` | réglages : feed, stats, rules, notifCfg, webhookUrl, archive |

Base créée automatiquement au 1er lancement. Zéro dépendance (module intégré `node:sqlite`, Node ≥ 22).

## 🌐 Endpoints
| Méthode | Chemin | Rôle |
|---------|--------|------|
| `POST` | `/event` | Ingestion des hooks |
| `GET`  | `/events` | Flux SSE |
| `GET`  | `/api/state` | Snapshot JSON |
| `GET`  | `/api/journal?session=&q=&limit=` | Historique (SQL) |
| `GET`  | `/api/transcript?session=` | Conversation |
| `GET`  | `/api/subagents?session=` | Activité des sous-agents |
| `POST` | `/control` | pause / resume / block / approvalOn-Off |
| `POST` | `/gate-check`, `GET /gate-decision`, `POST /approve` | Approbation (hook) |
| `POST` | `/rules`, `/webhook`, `/notifcfg`, `/prune` | Config / nettoyage |
| `GET`  | `/manifest.json`, `/sw.js`, `/icon.svg` | PWA |
| `GET`  | `/` | Le bureau |

## ⚠️ Limites
- Les sous-agents remontent via hooks (type/statut/durée/collaboration) ; leur activité détaillée est reconstruite **au mieux** depuis les sidechains du transcript.
- Le **% réel du plan Anthropic** (`/usage`) n'est pas accessible hors ligne — non affiché.
- L'installation **PWA** marche sur Chrome/Edge (et Firefox Android) ; Firefox desktop = onglet épinglé.

---

Fait avec [Claude Code](https://claude.com/claude-code).
