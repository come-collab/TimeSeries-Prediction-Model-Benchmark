# Static website for benchmark.cometrisse.com — serves site/ with nginx.
# Coolify: Build Pack = Dockerfile, exposed port 80. The results are pre-computed locally
# (benchmark.py + build_site.py) and committed as site/data.json, so no Python runs here.
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY site/ /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/healthz || exit 1
