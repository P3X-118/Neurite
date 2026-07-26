#---
# name: neurite
# group: code
# test: test.sh
#---

# ── Stage 1: build Vite frontend + install backend deps ───────────────────────
FROM node:20-slim AS builder
WORKDIR /build

# sqlite3 and other native modules need build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Frontend
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
# postbuild copies js/ resources/ wiki/ into dist/

# Backend main server
WORKDIR /build/localhost_servers
RUN npm install

# Sub-server deps (skip automation: requires heavyweight Playwright)
RUN for dir in webscrape wiki-search wolfram-alpha ai-proxy direct-access; do \
        npm install --prefix "$dir"; \
    done

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:20-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    nginx supervisor \
 && rm -rf /var/lib/apt/lists/*

# Serve built frontend via nginx on port 8080
COPY --from=builder /build/dist /var/www/neurite

# Backend servers with all dependencies pre-installed
COPY --from=builder /build/localhost_servers ./localhost_servers

# nginx: serve frontend and proxy backend paths to Node.js on port 7070
RUN cat > /etc/nginx/sites-available/default <<'EOF'
server {
    listen 8080;
    root /var/www/neurite;
    index index.html;

    location ~ ^/(check|aiproxy|webscrape|wikisearch|wolframalpha|directaccess|automation) {
        proxy_pass http://localhost:7070;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
EOF

# supervisord: manage nginx + node backend (both inherit container env vars)
RUN cat > /etc/supervisor/conf.d/neurite.conf <<'EOF'
[program:nginx]
command=nginx -g "daemon off;"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:neurite-servers]
command=node /app/localhost_servers/start_servers.js
directory=/app/localhost_servers
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
EOF

# /data is the user-accessible filesystem root for the DirectAccess server
VOLUME ["/app/localhost_servers/webscrape", "/data"]

EXPOSE 8080 7070

CMD ["supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
