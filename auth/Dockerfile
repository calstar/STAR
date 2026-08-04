FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
# Retries/timeout: a single slow PyPI read should not fail a deploy build.
RUN pip install --no-cache-dir --retries 5 --timeout 120 -r requirements.txt

COPY . .

# Don't run as root.
RUN useradd --system --no-create-home auth && chown -R auth:auth /app
USER auth

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/healthz')"

# gunicorn, not `flask run`: the Flask dev server is single-threaded and
# explicitly not for production, and bare `flask run` cannot find main.py
# anyway (it looks for app.py / wsgi.py unless --app is given).
#
# Caddy terminates TLS and sets X-Forwarded-*; --forwarded-allow-ips lets
# gunicorn trust them so request.is_secure and the host checks are right.
CMD ["gunicorn", \
     "--bind", "0.0.0.0:5000", \
     "--workers", "2", \
     "--forwarded-allow-ips", "*", \
     "--access-logfile", "-", \
     "main:app"]
