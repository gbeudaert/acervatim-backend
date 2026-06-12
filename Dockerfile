# Image de production multi-stage sur base Red Hat UBI 9.
# Cible de déploiement : Raspberry Pi 4 (linux/arm64) sous Docker.
#
# - Builder : ubi9/nodejs-24 (npm + toolchain) — même famille OS que le runtime,
#   donc le client Prisma généré ici (engine rhel-openssl-3.0.x) est directement
#   utilisable dans l'image finale.
# - Runtime : ubi9/nodejs-24-minimal, non-root (uid 1001), uniquement
#   dist/ + node_modules de prod.
# Les deux images sont multi-arch (amd64 + arm64).
#
# Build local (validation) : docker build -t acervatim-api .
# Build pour le RPi 4     : docker buildx build --platform linux/arm64 -t acervatim-api .
#   (Prisma génère l'engine de la plateforme du build : toujours builder pour
#    l'architecture de déploiement, pas de copie d'image cross-arch.)
# Run : docker run --init -p 3000:3000 --env-file .env acervatim-api
#       (--init recommandé : main.ts n'enregistre pas de handler SIGTERM,
#        sans init Node en PID 1 ignore le signal et docker stop attend le SIGKILL)
#
# Migrations : non incluses dans l'image runtime (le CLI prisma est une devDep).
# Utiliser la cible dédiée :
#   docker build --target migrate -t acervatim-migrate .
#   docker run --rm --env-file .env acervatim-migrate

# ---------- Étape 1 : build (deps complètes + compilation) ----------
FROM registry.access.redhat.com/ubi9/nodejs-24:latest AS build

WORKDIR /opt/app-root/src

COPY --chown=1001:0 package.json package-lock.json ./
# --ignore-scripts : évite le `prepare: husky` (pas de .git dans le contexte).
# Les postinstall utiles (prisma generate) sont relancés explicitement.
RUN npm ci --ignore-scripts

COPY --chown=1001:0 prisma ./prisma
RUN npx prisma generate

COPY --chown=1001:0 tsconfig.json tsconfig.build.json nest-cli.json ./
COPY --chown=1001:0 src ./src
RUN npm run build

# ---------- Étape 2 : dépendances de production uniquement ----------
FROM registry.access.redhat.com/ubi9/nodejs-24:latest AS deps-prod

WORKDIR /opt/app-root/src

COPY --chown=1001:0 package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Le client Prisma généré (node_modules/.prisma + @prisma/client patché)
# vient du builder : pas de `prisma generate` ici (le CLI est une devDep).
COPY --from=build /opt/app-root/src/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /opt/app-root/src/node_modules/@prisma/client ./node_modules/@prisma/client

# ---------- Cible optionnelle : exécution des migrations ----------
# Contient le CLI prisma (devDep) + schéma + migrations. À lancer en one-shot
# avant le déploiement d'une nouvelle version de l'API.
FROM build AS migrate

CMD ["npx", "prisma", "migrate", "deploy"]

# ---------- Étape finale : runtime minimal ----------
FROM registry.access.redhat.com/ubi9/nodejs-24-minimal:latest AS runtime

ENV NODE_ENV=production \
    PORT=3000

# main.ts écrit ./openapi.json au bootstrap (y compris en prod) : le WORKDIR
# doit être inscriptible par l'utilisateur non-root (convention UBI : uid 1001,
# groupe racine 0).
USER 0
RUN mkdir -p /app && chown 1001:0 /app && chmod g+w /app
USER 1001

WORKDIR /app

COPY --from=deps-prod --chown=1001:0 /opt/app-root/src/node_modules ./node_modules
COPY --from=build --chown=1001:0 /opt/app-root/src/dist ./dist
COPY --chown=1001:0 package.json ./

EXPOSE 3000

# /health est hors préfixe /v1 (cf. main.ts). fetch natif Node, pas besoin
# de curl dans l'image minimale.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/health`).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/main"]
