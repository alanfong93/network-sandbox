FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY ui ./ui
RUN npm run ui:build

FROM nginx:1.27-alpine
COPY --from=build /app/ui/dist /usr/share/nginx/html
EXPOSE 80
