#!/bin/bash
docker compose build --no-cache
docker compose up -d
docker logs -f tri_arb
