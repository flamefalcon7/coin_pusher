dev:
	pnpm dev

# docker compose locally
up_local:
	docker compose -f docker-compose.dev.yml up --build

down_local:
	docker compose -f docker-compose.dev.yml down

build_local:
	docker compose -f docker-compose.dev.yml build

rtp_sim:
	docker compose -f docker-compose.dev.yml run --rm game pnpm dlx tsx game/src/rtp_sim.ts

# Backend targets
backend-run:
	cd backend && go run ./app/services/api

backend-test:
	cd backend && go test -v -race -count=1 ./...

backend-migrate:
	cd backend && go run ./app/tooling/admin migrate

backend-seed:
	cd backend && go run ./app/tooling/admin seed