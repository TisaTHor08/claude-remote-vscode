# Changelog

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), versions [SemVer](https://semver.org/lang/fr/).
La section d'une version sert de notes de release sur GitHub.

## [0.2.0] - 2026-11-24

### Ajouté
- Mises à jour automatiques : vérification des Releases GitHub au démarrage puis toutes les 12 h, installation en un clic.
- Commande *Claude Remote: Rechercher des mises à jour* et réglages `claudeRemote.updates.check` / `claudeRemote.updates.repo`.
- Test E2E lançant un relais et deux vrais VS Code (hôte et client).
- Test `npm run test:claude` avec le vrai Claude Code de l'hôte (outil Read, reprise de chat, liste des chats).
- CI GitHub Actions et publication automatique du `.vsix` sur tag.
- Repli du token relais sur la variable d'environnement `CLAUDE_REMOTE_RELAY_TOKEN`.

### Corrigé
- L'ouverture d'un projet distant échouait toujours (le résultat de connexion était écrasé par l'arrêt de la connexion de test).
- Windows : tous les fichiers étaient refusés « hors du projet » quand le chemin contenait un nom court 8.3 (`EXPLOI~1`).
- `claudeRemote.claude.path` pointant vers un fichier `.js` est désormais lancé via Node.

## [0.1.0] - 2026-11-24

- Première version : relais chiffré de bout en bout, partage de projet, système de fichiers distant, chat Claude Code.
