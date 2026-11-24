# Claude Remote for VS Code

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

## Installation

### 1. Relais (sur ton serveur)

```bash
git clone https://github.com/TisaTHor08/claude-remote-vscode && cd claude-remote-vscode
cp .env.example .env && sed -i "s/^RELAY_TOKEN=.*/RELAY_TOKEN=$(openssl rand -hex 32)/" .env
docker compose up -d --build
```

Puis ajoute le bloc de [`nginx.conf.example`](nginx.conf.example) dans ton `server { listen 443 ssl; … }` et recharge nginx.
L'URL à utiliser dans l'extension est alors `wss://ton-domaine/claude-remote/ws`. Le conteneur n'écoute que sur `127.0.0.1:8787`.

### 2. Extension (sur chaque poste)

```bash
cd extension && npm install && npm run package   # produit claude-remote-vscode-0.1.0.vsix
code --install-extension claude-remote-vscode-0.1.0.vsix
```

Commande **Claude Remote: Configurer le relais** : URL `wss://…` + `RELAY_TOKEN` (stocké dans le trousseau de VS Code).

### 3. Utilisation

* **Sur la machine du projet** : ouvre le dossier → barre d'état « Synchroniser » (ou commande *Synchroniser ce projet*) →
  choisis un **mot de passe fort** (12 caractères minimum). La synchronisation reprend toute seule au redémarrage de VS Code.
* **Sur l'autre poste** : icône *Claude Remote* de la barre d'activité → **Projets connectés** → clic sur le projet →
  mot de passe (demandé une fois par poste) → le projet s'ouvre dans une nouvelle fenêtre. Le panneau **Chat Claude** permet de
  reprendre un chat existant ou d'en créer d'autres.

## Sécurité

| Couche | Rôle |
|---|---|
| `RELAY_TOKEN` | Sans lui, impossible même de lister les projets. Comparaison à temps constant. |
| Mot de passe du projet | scrypt (N=2¹⁵) → deux clés HKDF distinctes : `authKey` (preuve HMAC par challenge, jamais le mot de passe) et `encKey` (jamais envoyée au relais). |
| Chiffrement | AES-256-GCM sur toutes les requêtes/réponses/évènements, AAD par direction, horodatage + identifiant anti-rejeu. |
| Anti brute-force | 5 échecs → verrouillage 10 min par (IP, projet). Re-synchroniser avec un autre mot de passe invalide les anciens clients. |
| Chemins | Toute opération est confinée à la racine du projet (`..`, liens symboliques sortants et suppression de la racine refusés). |

⚠ **Qui connaît le mot de passe peut piloter Claude sur la machine hôte.** Les permissions des chats distants se règlent dans
`claudeRemote.claude.permissionMode` (défaut `acceptEdits`) et `claudeRemote.claude.allowedTools` ; n'utilise `bypassPermissions` qu'en connaissance de cause.
Il n'y a pas encore de validation interactive des outils depuis le client : ce qui n'est pas autorisé est refusé.

## Limites actuelles (v0.1)

* Ce n'est **pas** un Remote-SSH complet : l'éditeur lit/écrit les fichiers à distance, mais **pas de terminal, de git, de
  débogage, ni de recherche dans tous les fichiers** ; les extensions de langage (TypeScript, Python…) tournent sur le poste
  client, sans accès au projet complet.
* Fichiers lus jusqu'à 12 Mo. Le chat s'appuie sur le CLI `claude` (`-p --output-format stream-json`) déjà installé et connecté sur l'hôte
  (sous Windows, renseigne `claudeRemote.claude.path` vers `claude.exe` si la détection échoue).
* L'extension n'a pas encore été éprouvée longuement dans VS Code même ; le relais et le cœur du protocole sont couverts par un test d'intégration.

## Développement

```bash
cd extension && npm install
npm run typecheck
npm test            # lance un vrai relais + hôte + client (24 vérifications)
```

Licence MIT.
