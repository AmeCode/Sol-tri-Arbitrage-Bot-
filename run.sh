#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Define cleanup function
cleanup() {
  echo -e "\n\n🧹 Cleaning up Docker resources..."
  docker compose down --rmi all --volumes --remove-orphans
  echo "✅ Cleanup complete."
}

# Trap Ctrl+C (SIGINT) and call cleanup
trap cleanup INT

# Optionally, trap SIGTERM too (e.g. if the script is killed by another process)
trap cleanup TERM

# Main execution
docker compose down --rmi all --volumes --remove-orphans
docker system prune -af --volumes
docker compose up -d --build
docker logs -f tri_arb

# If docker logs exits normally, run cleanup as well
cleanup
