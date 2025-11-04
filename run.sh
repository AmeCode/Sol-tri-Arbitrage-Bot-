docker compose down --rmi all --volumes --remove-orphans
docker system prune -af --volumes
docker compose up -d --build
docker logs -f tri_arb
