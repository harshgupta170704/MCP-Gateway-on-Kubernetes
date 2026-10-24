FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY public ./public
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
RUN cat <<'EOF' > /etc/nginx/conf.d/default.conf
server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location /healthz {
        default_type text/plain;
        return 200 "ok\n";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
EOF
EXPOSE 8080
USER 101
