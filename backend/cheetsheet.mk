test-alerts:
	cd ../deploy/prometheus && promtool check rules rules/alerts.yml && promtool test rules tests/alerts_test.yml

set-admin:
	BACKEND_DB_DISABLE_TLS=true go run ./app/tooling/admin set-role b22d1782-e45f-4202-b418-75345f74748e admin

set-token:
	TOKEN=$(curl -s -X POST http://localhost:4000/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"provider_type":"wallet", "provider_uid":"0x31483D8f0191B94E4e016C292adfC98fb994ea85"}' | jq -r '.token')

set-new-progress:
	curl -s -X POST http://localhost:4000/v1/admin/progress \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "title": "Insert 500 coins",
      "description": "Insert 500 coins to get 1000 play coins",
      "metric_type": "game_insert_count",
      "threshold": "500",
      "reward_type": "play_coin",
      "reward_amount": "1000",
      "disburse_delay_sec": 60,
      "claim_deadline_sec": 120
    }' | jq .


