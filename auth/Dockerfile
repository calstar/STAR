FROM python:3.12-slim

WORKDIR /app

# Env, not CLI flags: pip installs an sdist's build dependencies by spawning a
# fresh subprocess that inherits no command-line options, so --timeout/--retries
# there would silently fall back to the stock 15s. Env vars reach it.
ENV PIP_RETRIES=10 \
    PIP_TIMEOUT=120 \
    PIP_DEFAULT_TIMEOUT=120 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INPUT=1

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt

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
