# API de StackDrive. Dos etapas: `build` compila y conserva el CLI de Prisma
# (lo usa el servicio `migrate` del compose); la final solo lleva lo que hace
# falta para ejecutar.

# Node 22 y no 24: es la versión con la que se prueba `@nestjs/bullmq` 11
# (ver la nota sobre ESM en AGENTS.md). Alpine necesita openssl para Prisma.
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
# `postinstall` ejecuta `prisma generate`: por eso el schema se copia antes.
RUN npm ci

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY prisma ./prisma
# `--ignore-scripts`: el `postinstall` (`prisma generate`) necesita el CLI de
# Prisma, que es de desarrollo. El cliente ya generado (con el motor para
# Alpine) se trae de la etapa `build`. Ninguna dependencia de producción
# compila nada al instalarse.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
