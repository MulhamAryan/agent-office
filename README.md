# 🏢 agent-office

Un **bureau virtuel live** qui transforme tes sessions Claude Code en un petit jeu de gestion vu de dessus : chaque session devient un personnage qui arrive au bureau, s'assoit, tape au clavier, cherche dans des fichiers, collabore avec ses sous-agents, va boire un café ou dormir quand il a fini. Le tout avec **surveillance, contrôle, statistiques, replay et alertes**.

Zéro dépendance, **un seul fichier** (`server.js`), Node ≥ 18. Rendu **Canvas 2D** à 60 fps, données temps réel via **SSE**.

![node](https://img.shields.io/badge/node-%E2%89%A518-3fb950) ![deps](https://img.shields.io/badge/dependencies-0-4c9aff)

---

## 🚀 Lancer

```bash
node server.js            # → http://localhost:4519
PORT=8080 node server.js  # port personnalisé
```

Variables d'env optionnelles : `PORT`, `HOST`, `WEBHOOK_URL` (Slack/Discord), `STATE_FILE`, `JOURNAL_FILE`.

## 🔌 Brancher les hooks Claude Code

Le serveur reçoit les événements des hooks en `POST http://localhost:4519/event`. Dans `~/.claude/settings.json` :

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

**Contrôle (pause / blocage / approbation)** — nécessite en plus un hook `PreToolUse` de type `command` pointant sur `hooks/gate.ps1` (voir la section Contrôle) :

```json
"PreToolUse": [{ "matcher": "*", "hooks": [
  { "type": "http", "url": "http://localhost:4519/event", "timeout": 3 },
  { "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"%USERPROFILE%\\.claude\\hooks\\gate.ps1\"" }
]}]
```

**Mode équipe / multi-machine** : sur les autres machines, pointe les hooks vers `http://<ip-du-serveur>:4519/event`. Chaque session est étiquetée par son IP source (🖥️).

---

## 🧑‍💻 Le bureau

- **Un personnage par agent** (couleur unique par projet) qui **se téléporte** à un bureau libre.
- **Animations selon l'outil** : tape (Bash/Edit/Write), lit (Read/Grep/Search), réfléchit 💭.
- **Rôles de sous-agents** par icône/couleur : 🔭 Explore · 🗺️ Plan · 🔍 review · 🛡️ security · 🧪 test · 📚 doc · 🐛 debug.
- **Plaque de bureau** : projet + durée + nombre d'actions. **Badge d'activité** au-dessus de la tête.
- **Salle de réunion** : quand une session lance ≥ 2 sous-agents, l'équipe se rassemble autour d'une table (nom du projet affiché).
- **Coin détente** : en pause → ☕ café / 🏃 sport / 😌 canapé / 💧 fontaine ; terminé → 💤 lit puis départ.
- **Discussion** : traits animés + 💬 entre chef et sous-agents. **Confettis** 🎉 à une fin sans erreur.
- **Humeur du bureau** : ambiance visuelle calme / effervescente (ambre) / en feu 🔥 (rouge) selon activité et erreurs.
- **Relief 2.5D** (🧊) et **jour/nuit** (🌗, avec lampes de bureau) et **thème clair/sombre** (🌓).

## 🔍 Surveillance

- **Alertes** ⚠️ : boucle d'outil, échecs en série, attente de permission longue, inactivité, **durée dépassée** (seuil configurable).
- **Radar d'anomalies** 📡 : détection **vs baseline** (taux d'erreur anormal, session figée) — le bouton rougeoie s'il y a une anomalie.
- **Bulle d'erreur** 💥 · **attente** ❓ · **anneau rouge** (figé) · **📡** (anomalie).
- **Centre de notifications** 🛎️ : historique des événements importants + pastille de compteur.
- **Titre d'onglet** dynamique : `(2⚠) agent-office` pour voir les alertes en arrière-plan.
- **Aperçu au survol** : passe la souris sur un perso → tooltip (projet, tâche, action).
- **Projecteur** 🎯 : la caméra suit automatiquement l'agent actif.

## 🖱️ Clic sur un agent (panneau détail)

Tâche en cours · action réelle · **historique d'outils** (pulse-lane) · **sparkline** d'activité · **fichiers travaillés** (liens `vscode://` pour ouvrir) · **métriques par outil** + taux d'échec · **coéquipiers** (cliquables) · boutons de contrôle · **💬 Conversation** (prose de l'agent lue dans le transcript) · **🔎 Sous-agents** (activité réelle des sous-agents extraite des sidechains du transcript).

## 🎛️ Contrôle (human-in-the-loop)

Via le hook `hooks/gate.ps1` (interroge le serveur avant chaque outil, **fail-open** si serveur down) :

- **⏸ Pause / ▶ Reprendre** une session.
- **🚫 Bloquer** un outil précis.
- **🖐️ Exiger OK (approbation)** : l'agent **attend** sur les outils sensibles (Bash/Write/Edit/PowerShell/Notebook) ; une **carte apparaît près du perso** avec la commande exacte et **✅ Autoriser / ⛔ Refuser** — l'agent reprend ou est refusé.

## 📈 Statistiques (📊, persistantes)

Uptime · 1er lancement · total actions · **histogramme horaire** · **Gantt** des sessions · **classement projets** · **score & achievements** (séries de jours, badges) · **heatmap calendrier** (~15 semaines).

## 🕘 Historique & Replay

- **Historique** 🕘 : journal persistant (`office-journal.jsonl`), **recherche** plein-texte, **diff des éditions** (déplie old/new).
- **Replay** ⏪ : barre temporelle pour **rejouer le bureau à n'importe quel instant** passé (scrub) ou en **accéléré ×60**.

## 🔔 Alertes & règles

- **Webhook** Slack/Discord/Teams (🔔 ou panneau ⚙️) : notifie sur **échec**, **attente de permission**, **fin de session**, **approbation requise**.
- **Moteur de règles** (⚙️) : « prévenir si un projet atteint N erreurs », « si un fichier contenant X est modifié ».
- **Notifications navigateur** quand un agent attend une action.

## ⌨️ Raccourcis & command palette

- **Ctrl/⌘ + K** : palette de commandes — `pause <projet>`, `focus <projet>`, `search <texte>`, `night`/`day`, `light`/`dark`, `tv`, `stats`, `team`, `list`, `radar`, `replay`, `iso`, `clear`.
- **f** plein écran (TV) · **t** équipe · **l** thème · **m** liste · **s** stats · **h** historique · **/** recherche · **z** reset zoom · **Échap** fermer.
- **Double-clic** sur un agent → zoom caméra.

## 🧰 Confort

Vue **liste compacte** (☰) · **plein écran / TV** (📺) · **export rapport Markdown** (📄) · **nettoyage** des sessions inactives (🧹, + auto-purge) · **panneau Équipe** déplaçable/repliable, **groupé par projet** · responsive mobile.

## 🌐 Endpoints

| Méthode | Chemin | Rôle |
|---------|--------|------|
| `POST` | `/event` | Ingestion des hooks |
| `GET`  | `/events` | Flux SSE temps réel |
| `GET`  | `/api/state` | Snapshot JSON |
| `GET`  | `/api/journal?session=&q=&limit=` | Historique (recherche) |
| `GET`  | `/api/transcript?session=` | Conversation (prose) |
| `GET`  | `/api/subagents?session=` | Activité réelle des sous-agents |
| `POST` | `/control` | pause / resume / block / approvalOn-Off |
| `POST` | `/gate-check`, `GET /gate-decision`, `POST /approve` | Approbation (hook) |
| `POST` | `/rules`, `/webhook`, `/prune` | Règles / webhook / nettoyage |
| `GET`  | `/` | Le bureau virtuel |

## ⚠️ Limites

- L'**état est en mémoire + `office-state.json`** (persisté). Le **journal** (`office-journal.jsonl`) garde l'historique complet.
- Les sous-agents : type / statut / durée / collaboration remontent via les hooks. Leur **activité détaillée** (outils, commandes) est reconstruite **au mieux** depuis les sidechains du transcript.
- Le **% réel du plan Anthropic** (celui de `/usage`) n'est pas accessible hors ligne — non affiché.

---

Fait avec [Claude Code](https://claude.com/claude-code).
