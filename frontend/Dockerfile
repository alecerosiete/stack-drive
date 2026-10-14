# Panel web: Vite compila a estáticos y nginx los sirve.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Vite incrusta la URL de la API al compilar: cambiarla exige reconstruir la
# imagen (`docker compose build web`), no basta con reiniciar el contenedor.
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
