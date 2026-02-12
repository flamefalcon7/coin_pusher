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
	docker compose -f docker-compose.dev.yml run --rm server pnpm dlx tsx server/src/rtp_sim.ts