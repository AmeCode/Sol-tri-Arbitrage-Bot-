#!/bin/bash
docker builder prune -af
docker compose build --no-cache
docker compose up -d
docker logs -f tri_arb
