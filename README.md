# Claude Remote for VS Code

[![Release](https://img.shields.io/github/v/release/TisaTHor08/claude-remote-vscode)](https://github.com/TisaTHor08/claude-remote-vscode/releases/latest)

Un « vrai remote » **VS Code → VS Code** passant par **ton propre serveur** (Docker + nginx) :
tu synchronises un projet depuis ta machine, puis tu l'ouvres depuis n'importe quel autre poste comme un
dossier normal (arborescence, lecture/édition de fichiers) avec un **chat Claude Code** intégré.

Conçu pour survivre aux connexions instables (box 5G / CGNAT, changement d'IP, veille réseau) :
la machine hôte et les clients **se connectent en sortie** au relais et se reconnectent seuls ;
tout l'état (chats, runs Claude en cours) vit sur l'hôte et se resynchronise après chaque coupure.

```
 PC maison (VS Code + extension)           Ton serveur                     Autre poste (VS Code + extension)
 ┌──────────────────────────┐   wss    ┌────────────────────┐   wss    ┌──────────────────────────────┐
 │ « Synchroniser »  (hôte) │ ───────► │ nginx ─► relais    │ ◄─────── │ Projets connectés ─► Ouvrir  │
 │ fichiers + CLI claude    │ ◄─────── │ (Docker, Node/ws)  │ ───────► │ claude-remote://projet/ + chat│
 └──────────────────────────┘          └────────────────────┘          └──────────────────────────────┘
        chiffrement de bout en bout (AES-256-GCM, clé dérivée du mot de passe) — le relais ne voit que du chiffré
```

**Sommaire** — [Installation](#installation) · [Utilisation](#utilisation) · [Mises à jour](#mises-à-jour) ·
[Réglages](#réglages) · [Sécurité](#sécurité) · [Limites](#limites-actuelles) · [Dépannage](#dépannage) · [Développement](#développement)

---

## Installation

### 1. Relais (une fois, sur ton serveur ou ton NAS)

**Sur un NAS (Synology Container Manager « Projet », QNAP, Portainer…)** : suis [docs/NAS.md](docs/NAS.md)
(liste exacte des fichiers à copier, reverse proxy DSM, mise à jour).

**Sur un serveur Linux** (Docker + Docker Compose, nginx avec TLS) :

```bash
git clone https://github.com/TisaTHor08/claude-remote-vscode && cd claude-remote-vscode
cp .env.example .env && sed -i "s/^RELAY_TOKEN=.*/RELAY_TOKEN=$(openssl rand -hex 32)/" .env
docker compose up -d --build
curl http://127.0.0.1:47821/healthz   # → ok
cat .env    # note le RELAY_TOKEN : il sera demandé dans l'extension
```

Ajoute ensuite le bloc de [`nginx.conf.example`](nginx.conf.example) dans ton `server { listen 443 ssl; … }` puis `nginx -s reload`.
Le conteneur n'écoute que sur **`127.0.0.1:47821`** (port exotique pour éviter les conflits, modifiable via `RELAY_PORT` dans `.env`) ;
c'est le reverse proxy qui l'expose en TLS.

➡ URL à utiliser dans l'extension : **`wss://ton-domaine/claude-remote/ws`** (nginx) ou **`wss://ton-domaine/ws`** (proxy DSM).

> Sans reverse proxy, pour un essai en local : `ws://127.0.0.1:47821/ws` (le chemin **`/ws`** est obligatoire).

### 2. Extension (sur chaque poste : machine hôte et clients)

1. Télécharge le fichier **`.vsix`** de la [dernière release](https://github.com/TisaTHor08/claude-remote-vscode/releases/latest).
2. Installe-le : `code --install-extension claude-remote-vscode-X.Y.Z.vsix`
   (ou, dans VS Code : vue Extensions → `…` → *Install from VSIX…*).
3. Commande **Claude Remote: Configurer le relais** : URL `wss://…/claude-remote/ws` + `RELAY_TOKEN`
   (le token est rangé dans le trousseau sécurisé de VS Code, pas dans les réglages).

Sur la machine **hôte**, le [CLI Claude Code](https://docs.claude.com/claude-code) doit être installé et connecté (`claude` dans le PATH).

## Utilisation

**Sur la machine du projet (hôte)**
1. Ouvre le dossier du projet dans VS Code.
2. Clique sur **« Synchroniser »** dans la barre d'état (ou commande *Claude Remote: Synchroniser ce projet*).
3. Choisis un nom et un **mot de passe fort** (12 caractères minimum).

La synchronisation reprend toute seule au redémarrage de VS Code (sans ressaisir le mot de passe).
Pour arrêter : clic sur l'indicateur de la barre d'état, ou *Claude Remote: Arrêter la synchronisation*.

**Sur l'autre poste (client)**
1. Icône **Claude Remote** de la barre d'activité → **Projets connectés**.
2. Clic sur le projet → mot de passe (demandé une fois par poste).
3. Le projet s'ouvre dans une nouvelle fenêtre : édite les fichiers normalement, et utilise le panneau
   **Chat Claude** pour reprendre un chat existant ou en créer un nouveau (Claude s'exécute sur l'hôte).

## Mises à jour

### Extension : automatique

Au démarrage de VS Code puis toutes les 12 h, l'extension consulte les
[Releases GitHub](https://github.com/TisaTHor08/claude-remote-vscode/releases). Si une version plus récente existe,
une notification propose **Mettre à jour** (téléchargement + installation du `.vsix`, puis rechargement de la fenêtre),
**Notes de version** ou **Ignorer cette version**.

* Vérification manuelle : commande **Claude Remote: Rechercher des mises à jour**.
* Désactiver : réglage `claudeRemote.updates.check` à `false`.
* Fork : pointe `claudeRemote.updates.repo` vers ton dépôt (`propriétaire/nom`, qui doit être **public**).

> Mets à jour l'extension **sur tous les postes** (hôte et clients) : ils doivent parler la même version du protocole.

### Relais

```bash
cd claude-remote-vscode && git pull && docker compose up -d --build   # NAS : voir docs/NAS.md §4
```

Les machines hôtes et les clients se reconnectent automatiquement après le redémarrage du relais.

### Publier une nouvelle version (mainteneur)

Bump de `version` dans `extension/package.json`, section dans [CHANGELOG.md](CHANGELOG.md), commit, puis dans `extension/` :
`npm run release` (tests, build du `.vsix`, tag et release GitHub depuis ton poste). Détails : [docs/RELEASING.md](docs/RELEASING.md).
Les extensions installées proposent ensuite la nouvelle version d'elles-mêmes.

## Réglages

| Réglage | Défaut | Rôle |
|---|---|---|
| `claudeRemote.relayUrl` | — | URL WebSocket du relais (`wss://…/claude-remote/ws`). |
| `claudeRemote.autoResume` | `true` | Reprendre le partage des projets au démarrage de VS Code. |
| `claudeRemote.claude.path` | auto | Chemin du binaire `claude` (sous Windows : `claude.exe`, ou un `cli.js` lancé via Node). |
| `claudeRemote.claude.permissionMode` | `acceptEdits` | Mode de permissions des chats lancés à distance. |
| `claudeRemote.claude.allowedTools` | lecture, édition, `git status/diff/log` | Outils autorisés sans confirmation dans les chats distants. |
| `claudeRemote.updates.check` | `true` | Vérifier automatiquement les nouvelles versions. |
| `claudeRemote.updates.repo` | `TisaTHor08/claude-remote-vscode` | Dépôt GitHub source des mises à jour. |

Variable d'environnement `CLAUDE_REMOTE_RELAY_TOKEN` : token de repli si aucun n'est enregistré (tests, CI, postes scriptés).

## Sécurité

| Couche | Rôle |
|---|---|
| `RELAY_TOKEN` | Sans lui, impossible même de lister les projets. Comparaison à temps constant. |
| Mot de passe du projet | scrypt (N=2¹⁵) → deux clés HKDF distinctes : `authKey` (preuve HMAC par challenge, jamais le mot de passe) et `encKey` (jamais envoyée au relais). |
| Chiffrement | AES-256-GCM sur toutes les requêtes/réponses/évènements, AAD par direction, horodatage + identifiant anti-rejeu. |
| Anti brute-force | 5 échecs → verrouillage 10 min par (IP, projet). Re-synchroniser avec un autre mot de passe invalide les anciens clients. |
| Chemins | Toute opération est confinée à la racine du projet (`..`, liens symboliques sortants et suppression de la racine refusés). |
| Mises à jour | Téléchargées uniquement en HTTPS depuis `github.com` (assets de release), installées par VS Code. |

⚠ **Qui connaît le mot de passe peut piloter Claude sur la machine hôte.** Les permissions des chats distants se règlent dans
`claudeRemote.claude.permissionMode` et `claudeRemote.claude.allowedTools` ; n'utilise `bypassPermissions` qu'en connaissance de cause.
Il n'y a pas encore de validation interactive des outils depuis le client : ce qui n'est pas autorisé est refusé.

## Limites actuelles

* Ce n'est **pas** un Remote-SSH complet : l'éditeur lit/écrit les fichiers à distance, mais **pas de terminal, de git, de
  débogage, ni de recherche dans tous les fichiers** ; les extensions de langage (TypeScript, Python…) tournent sur le poste
  client, sans accès au projet complet.
* Fichiers lus jusqu'à 12 Mo.
* Le chat s'appuie sur le CLI `claude` (détecté automatiquement : `~/.local/bin`, extension Claude Code pour VS Code, PATH) (`-p --output-format stream-json`) déjà installé et connecté sur l'hôte.

## Dépannage

| Symptôme | Piste |
|---|---|
| « Aucun projet trouvé » | Vérifie l'URL (elle doit finir par `/ws`) et le token : *Configurer le relais*. Journaux : *Claude Remote: Afficher les journaux*. |
| « token refusé » dans la barre d'état | Le `RELAY_TOKEN` saisi ne correspond pas au `.env` du serveur. |
| « trop d'essais » | 5 mauvais mots de passe : attends 10 min. |
| Le chat ne démarre pas | Sur l'hôte, `claude --version` doit fonctionner ; sinon renseigne `claudeRemote.claude.path`. |
| Pas de notification de mise à jour | Commande *Rechercher des mises à jour* ; le dépôt doit être public et avoir une release avec un `.vsix`. |

## Développement

```bash
cd relay && npm ci && cd ../extension && npm ci
npm run typecheck
npm test            # relais + hôte + client réels, sans VS Code (24 vérifications)
npm run test:e2e    # relais + DEUX vrais VS Code (hôte et client) pilotés automatiquement
npm run test:claude # avec le VRAI Claude Code de l'hôte, piloté depuis un client distant (consomme quelques tokens)
npm run package     # produit claude-remote-vscode-X.Y.Z.vsix
```

`npm run test:e2e` télécharge VS Code au premier lancement ; `CODE_EXE=/chemin/vers/Code.exe` utilise celui déjà installé.
Sous Linux sans écran : `xvfb-run -a npm run test:e2e`. Les workflows GitHub (CI, Release) sont en déclenchement manuel.

Structure :

```
relay/                 serveur relais (Node + ws), image Docker
extension/src/core/    protocole, chiffrement, hôte, client, lanceur Claude — sans dépendance à VS Code
extension/src/         intégration VS Code (FileSystemProvider, vues, commandes, mises à jour)
extension/test/        test d'intégration du cœur + test E2E dans de vrais VS Code
.github/workflows/     CI et Release GitHub Actions (déclenchement manuel)
extension/scripts/     release.mjs : publication d'une release depuis ton poste
```

Licence MIT.
