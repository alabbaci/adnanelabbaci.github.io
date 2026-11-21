# citytwin API image — build once, run the service, mount the artefacts
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# OS packages needed by the geo stack at runtime (wheels bundle GDAL/PROJ)
RUN apt-get update \
    && apt-get install -y --no-install-recommends libexpat1 libsqlite3-0 curl \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md LICENSE ./
COPY src ./src
RUN pip install .

COPY web ./web
COPY docs ./docs
COPY configs ./configs

# artefacts are produced by `citytwin build` (or mounted from the host)
VOLUME ["/app/build"]

RUN useradd --create-home --uid 10001 citytwin \
    && chown -R citytwin:citytwin /app
USER citytwin

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1

CMD ["uvicorn", "citytwin.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
