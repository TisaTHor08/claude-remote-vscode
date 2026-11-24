# Installer le relais sur un NAS (mode « projet » Docker Compose)

Valable pour Synology Container Manager, QNAP Container Station, UGREEN, Portainer, ou tout `docker compose`.

## 1. Le dossier à copier sur le NAS

Seuls ces fichiers sont nécessaires (l'extension, les tests et la doc ne servent pas au relais) :

```
claude-remote/                 ← par ex. /volume1/docker/claude-remote
├── docker-compose.yml
├── .env                       ← à créer (voir ci-dessous) — ne le partage jamais
└── relay/
    ├── Dockerfile
    ├── package.json
    ├── package-lock.json
    └── server.js
```

Contenu de `.env` (copie de [`.env.example`](../.env.example)) :

```ini
RELAY_TOKEN=<64 caractères hex aléatoires>
RELAY_PORT=47821
RELAY_BIND=127.0.0.1
```

Générer le token : `openssl rand -hex 32` (Linux/macOS/NAS en SSH) ou, sous Windows PowerShell :
`-join ((1..32) | % { '{0:x2}' -f (Get-Random -Max 256) })`.

> Si ton interface de projet n'utilise pas le fichier `.env`, remplace directement dans `docker-compose.yml`
> `${RELAY_TOKEN:?…}` par la valeur du token.

## 2. Créer le projet

* **Synology** : Container Manager → **Projet** → **Créer** → chemin = le dossier `claude-remote` →
  source « Utiliser le docker-compose.yml existant » → Suivant → Terminé. L'image est construite sur le NAS.
* **Ligne de commande** : `cd claude-remote && docker compose up -d --build`

Vérification sur le NAS : `curl http://127.0.0.1:47821/healthz` → `ok`.

## 3. Exposer en HTTPS (reverse proxy)

Le relais écoute sur **`127.0.0.1:47821`** (port exotique, uniquement local). Publie-le en TLS :

* **Synology** : Panneau de configuration → Portail de connexion → Avancé → **Proxy inversé** → Créer :
  * Source : `HTTPS`, nom d'hôte `remote.ton-domaine.fr`, port `443`
  * Destination : `HTTP`, `localhost`, port `47821`
  * Onglet **En-tête personnalisé** → Créer → **WebSocket** (ajoute `Upgrade` / `Connection`)
  * Certificat : associe un certificat Let's Encrypt au nom d'hôte.
  * URL pour l'extension : **`wss://remote.ton-domaine.fr/ws`**
* **nginx** : bloc prêt à l'emploi dans [`nginx.conf.example`](../nginx.conf.example) →
  URL `wss://ton-domaine/claude-remote/ws`.

* **Nginx Proxy Manager** (souvent en conteneur) : Proxy Host → domaine `vs.ton-domaine.fr`, scheme `http`,
  IP du NAS (ex. `192.168.1.26`), port `47821`, cocher **Websockets Support**, onglet SSL → Let's Encrypt.
  URL pour l'extension : **`wss://vs.ton-domaine.fr/ws`**.

⚠ Si le reverse proxy contacte le relais via l'IP du NAS (Nginx Proxy Manager en conteneur, autre machine…),
mets **`RELAY_BIND=0.0.0.0`** dans `.env`, sinon il obtient **502 Bad Gateway**. Dans ce cas, n'ouvre/ne redirige
**pas** le port 47821 sur ta box : seul le reverse proxy (443) doit être exposé à Internet.

## 4. Mettre à jour le relais

Remplace les fichiers de `relay/` par ceux de la nouvelle version, puis : Container Manager → Projet → **Action → Construire**
(ou `docker compose up -d --build`). Les machines hôtes et clients se reconnectent toutes seules.
