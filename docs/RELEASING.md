# Publier une nouvelle version

Les extensions installées consultent les [Releases GitHub](https://github.com/TisaTHor08/claude-remote-vscode/releases)
(au démarrage puis toutes les 12 h) et proposent la mise à jour d'elles-mêmes. Publier une version = créer une release
contenant le `.vsix`.

## Étapes

1. **Version** : mets à jour `"version"` dans `extension/package.json` ([SemVer](https://semver.org/lang/fr/) :
   correctif → `0.2.1`, nouveauté → `0.3.0`, rupture de protocole → `1.0.0`), puis `npm install` dans `extension/`
   pour répercuter la version dans `package-lock.json`.
2. **Changelog** : ajoute une section `## [X.Y.Z] - AAAA-MM-JJ` en haut de `CHANGELOG.md`.
   Son contenu devient le texte de la release.
3. **Commite** : `git commit -am "vX.Y.Z"`.
4. **Publie depuis ton poste** (dans `extension/`, avec `gh` connecté) :
   ```bash
   npm run release              # tests (intégration + E2E), build du .vsix, tag, push, release GitHub
   npm run release -- --skip-e2e  # si tu ne peux pas lancer de VS Code (serveur sans écran…)
   ```
   Le script refuse de publier si l'arbre git n'est pas propre, si le tag existe déjà ou si le changelog n'a pas
   de section pour cette version.

Optionnel, avant de publier : `npm run test:claude` vérifie le chat avec le vrai Claude Code de ta machine.

## Avec GitHub Actions (optionnel)

Les workflows [CI](../.github/workflows/ci.yml) et [Release](../.github/workflows/release.yml) existent mais sont en
**déclenchement manuel** (onglet Actions → *Run workflow*) pour ne pas consommer de minutes. Pour Release : pousse
d'abord le tag (`git tag vX.Y.Z && git push origin vX.Y.Z`), puis lance le workflow avec ce tag.

## En cas de problème

* Release ratée : `gh release delete vX.Y.Z --cleanup-tag`, corrige, recommence.
* **Rupture de protocole** (hôte et client incompatibles) : signale-le en tête de la section du changelog ;
  tous les postes doivent être mis à jour.
* **Relais** : il n'est pas mis à jour automatiquement ; sur le serveur, `git pull && docker compose up -d --build`.
