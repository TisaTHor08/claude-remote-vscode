# Publier une nouvelle version

Les extensions installées vérifient les [Releases GitHub](https://github.com/TisaTHor08/claude-remote-vscode/releases)
et proposent la mise à jour d'elles-mêmes. Publier = pousser un tag.

1. **Version** : mets à jour `"version"` dans `extension/package.json` ([SemVer](https://semver.org/lang/fr/) :
   correctif → `0.2.1`, nouveauté → `0.3.0`, rupture de protocole → `1.0.0`), puis `npm install` dans `extension/`
   pour répercuter la version dans `package-lock.json`.
2. **Changelog** : ajoute une section `## [X.Y.Z] - AAAA-MM-JJ` en haut de `CHANGELOG.md`.
   Son contenu devient le texte de la release.
3. **Vérifie** en local : `npm run typecheck && npm test && npm run test:e2e` (dans `extension/`).
4. **Publie** :
   ```bash
   git commit -am "vX.Y.Z"
   git tag vX.Y.Z
   git push && git push --tags
   ```
5. Le workflow [Release](../.github/workflows/release.yml) vérifie que le tag correspond à `package.json`,
   relance tous les tests, construit le `.vsix` et crée la release avec le fichier attaché.
   Suis-le dans l'onglet **Actions** du dépôt.

En cas d'échec du workflow : corrige, supprime le tag (`git tag -d vX.Y.Z && git push --delete origin vX.Y.Z`) et recommence.

**Rupture de protocole** (hôte et client incompatibles) : signale-le en tête de la section du changelog ;
tous les postes doivent être mis à jour.

**Relais** : il n'est pas mis à jour automatiquement ; sur le serveur, `git pull && docker compose up -d --build`.
