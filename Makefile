# docker compose locally
up_local:
	docker compose -f docker-compose.dev.yml up --build

down_local:
	docker compose -f docker-compose.dev.yml down

build_local:
	docker compose -f docker-compose.dev.yml build
