FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
# Les fichiers copiés depuis un NAS (ACL Synology…) peuvent être illisibles pour l'utilisateur « node » :
# on rend /app lisible par tous, sans droit d'écriture.
RUN chmod -R a+rX,go-w /app
USER node
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "server.js"]
