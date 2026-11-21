# citytwin — reproducible build, service and checks
# Usage: make <target>   (override the interpreter with PYTHON=...)

PYTHON ?= python
CITYTWIN = $(PYTHON) -m citytwin
PORT ?= 8000
COMPOSE ?= docker compose

.PHONY: help install build fetch verify test lint format serve api agent eval figures all docker-build docker-up docker-down clean

help:
	@echo "install      editable install with dev extras"
	@echo "build        full pipeline (Overture extract cached after the first run)"
	@echo "fetch        re-download the Overture extract"
	@echo "verify       re-hash artefacts, validate CityJSON shells and the GLB"
	@echo "test         pytest"
	@echo "lint         ruff check"
	@echo "serve        OGC API + viewer at http://127.0.0.1:$(PORT)"
	@echo "agent Q=...  ask the tool-using agent a question"
	@echo "eval         golden-question evaluation -> docs/agent_eval.md"
	@echo "figures      re-render docs/assets screenshots and charts"
	@echo "all          build + verify + eval + figures"
	@echo "docker-*     build / start / stop the containerised API + PostGIS"

install:
	$(PYTHON) -m pip install -e ".[dev]"

build:
	$(CITYTWIN) build --draws 200

fetch:
	$(CITYTWIN) fetch --refresh

verify:
	$(CITYTWIN) verify

test:
	$(PYTHON) -m pytest -q

lint:
	$(PYTHON) -m ruff check src tests

format:
	$(PYTHON) -m ruff format src tests

serve:
	$(CITYTWIN) serve --port $(PORT)

api:
	$(PYTHON) -m uvicorn citytwin.api.main:app --host 127.0.0.1 --port $(PORT)

agent:
	$(CITYTWIN) agent "$(Q)"

eval:
	$(CITYTWIN) eval

figures:
	bash scripts/figures.sh

all: build verify eval figures

docker-build:
	docker build -t citytwin:0.5.0 .

docker-up:
	$(COMPOSE) up -d --build

docker-down:
	$(COMPOSE) down

clean:
	rm -rf build .pytest_cache .ruff_cache
	find . -name "__pycache__" -type d -prune -exec rm -rf {} +
