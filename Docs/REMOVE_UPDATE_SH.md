## Removal of `update.sh`

### Why this file was removed

The project is distributed and operated as a Docker Compose stack. The `update.sh` helper duplicated behavior that is already provided by standard Docker commands (`docker compose pull` and `docker compose up -d`).

Keeping a custom update script introduces extra maintenance burden, can drift from the real deployment flow, and creates confusion for users who only need the Compose workflow.

### What changed

- Removed `update.sh` from the repository.
- Updated `README.md` to document the Docker Compose update path as the single supported approach.

### Operational impact

There is no impact on runtime behavior of the application. Deployment and updates remain fully supported via Docker Compose commands.
