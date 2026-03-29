package ws

import (
	"encoding/json"

	"github.com/nats-io/nats.go"
	"github.com/vmihailenco/msgpack/v5"
	"go.uber.org/zap"
)

// Relay subscribes to NATS topics and relays messages to WebSocket clients.
type Relay struct {
	log  *zap.SugaredLogger
	nc   *nats.Conn
	hub  *Hub
	room string
	subs []*nats.Subscription
}

// NewRelay constructs a Relay.
func NewRelay(log *zap.SugaredLogger, nc *nats.Conn, hub *Hub, room string) *Relay {
	return &Relay{
		log:  log,
		nc:   nc,
		hub:  hub,
		room: room,
	}
}

// Start subscribes to state_delta, despawn, snapshot, and reward topics.
func (rl *Relay) Start() error {
	// state_delta: broadcast raw protobuf bytes to all WS clients.
	sub, err := rl.nc.Subscribe(TopicStateDelta(rl.room), func(msg *nats.Msg) {
		rl.hub.Broadcast(msg.Data)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// despawn: broadcast raw protobuf bytes to all WS clients.
	sub, err = rl.nc.Subscribe(TopicDespawn(rl.room), func(msg *nats.Msg) {
		rl.hub.Broadcast(msg.Data)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// snapshot: cache in hub for new connections.
	sub, err = rl.nc.Subscribe(TopicSnapshot(rl.room), func(msg *nats.Msg) {
		rl.hub.SetSnapshot(msg.Data)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// reward: log for now (future: process via game.Core).
	sub, err = rl.nc.Subscribe(TopicReward(rl.room), func(msg *nats.Msg) {
		rl.log.Infow("reward event received", "data_len", len(msg.Data))
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// reward_notify: JSON from backend → re-encode as msgpack for target user.
	sub, err = rl.nc.Subscribe(TopicRewardNotify(rl.room), func(msg *nats.Msg) {
		var notify struct {
			Op     string  `json:"op"      msgpack:"op"`
			UserID string  `json:"user_id" msgpack:"user_id"`
			Amount float64 `json:"amount"  msgpack:"amount"`
		}
		if err := json.Unmarshal(msg.Data, &notify); err != nil {
			rl.log.Errorw("reward_notify json decode error", "error", err)
			return
		}
		packed, err := msgpack.Marshal(notify)
		if err != nil {
			rl.log.Errorw("reward_notify msgpack encode error", "error", err)
			return
		}
		rl.hub.SendToUser(notify.UserID, packed)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// slot_spin: broadcast raw protobuf bytes to all WS clients.
	sub, err = rl.nc.Subscribe(TopicSlotSpin(rl.room), func(msg *nats.Msg) {
		rl.hub.Broadcast(msg.Data)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// slot_counter: broadcast raw protobuf bytes to all WS clients.
	sub, err = rl.nc.Subscribe(TopicSlotCounter(rl.room), func(msg *nats.Msg) {
		rl.hub.Broadcast(msg.Data)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// ability: broadcast raw protobuf bytes to all WS clients.
	sub, err = rl.nc.Subscribe(TopicAbility(rl.room), func(msg *nats.Msg) {
		rl.hub.Broadcast(msg.Data)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// heat_update: broadcast heat shares to all WS clients.
	sub, err = rl.nc.Subscribe(TopicHeatUpdate(rl.room), func(msg *nats.Msg) {
		rl.hub.Broadcast(msg.Data)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// coin_spawn: broadcast coin spawn events to all WS clients.
	sub, err = rl.nc.Subscribe(TopicCoinSpawn(rl.room), func(msg *nats.Msg) {
		rl.hub.Broadcast(msg.Data)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// queue_update: broadcast queue updates to all WS clients.
	sub, err = rl.nc.Subscribe(TopicQueueUpdate(rl.room), func(msg *nats.Msg) {
		rl.hub.Broadcast(msg.Data)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// wheel_spin: broadcast raw protobuf bytes to all WS clients.
	sub, err = rl.nc.Subscribe(TopicWheelSpin(rl.room), func(msg *nats.Msg) {
		rl.hub.Broadcast(msg.Data)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// wheel_counter: broadcast raw protobuf bytes to all WS clients.
	sub, err = rl.nc.Subscribe(TopicWheelCounter(rl.room), func(msg *nats.Msg) {
		rl.hub.Broadcast(msg.Data)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// slot_status: JSON from game server → re-encode as msgpack for WS clients.
	sub, err = rl.nc.Subscribe(TopicSlotStatus(rl.room), func(msg *nats.Msg) {
		var status struct {
			Op     string `json:"op"     msgpack:"op"`
			Counts []int  `json:"counts" msgpack:"counts"`
			Tick   int    `json:"tick"   msgpack:"tick"`
		}
		if err := json.Unmarshal(msg.Data, &status); err != nil {
			rl.log.Errorw("slot_status json decode error", "error", err)
			return
		}
		packed, err := msgpack.Marshal(status)
		if err != nil {
			rl.log.Errorw("slot_status msgpack encode error", "error", err)
			return
		}
		rl.hub.Broadcast(packed)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// key_coin_draw: JSON from backend → re-encode as msgpack for WS clients.
	sub, err = rl.nc.Subscribe(TopicKeyCoinDraw(rl.room), func(msg *nats.Msg) {
		var draw struct {
			Op         string `json:"op"          msgpack:"op"`
			WinnerID   string `json:"winner_id"   msgpack:"winner_id"`
			WinnerName string `json:"winner_name" msgpack:"winner_name"`
			Count      int    `json:"count"        msgpack:"count"`
		}
		if err := json.Unmarshal(msg.Data, &draw); err != nil {
			rl.log.Errorw("key_coin_draw json decode error", "error", err)
			return
		}
		packed, err := msgpack.Marshal(draw)
		if err != nil {
			rl.log.Errorw("key_coin_draw msgpack encode error", "error", err)
			return
		}
		rl.hub.Broadcast(packed)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// sponsor_config: JSON from backend → re-encode as msgpack for WS clients.
	sub, err = rl.nc.Subscribe(TopicSponsorConfig(rl.room), func(msg *nats.Msg) {
		var cfg struct {
			Op       string `json:"op"        msgpack:"op"`
			Sponsors []struct {
				ID          string `json:"id"           msgpack:"id"`
				BrandName   string `json:"brand_name"   msgpack:"brand_name"`
				BrandColor  string `json:"brand_color"  msgpack:"brand_color"`
				TokenSymbol string `json:"token_symbol" msgpack:"token_symbol"`
				LogoURL     string `json:"logo_url"     msgpack:"logo_url"`
				AdImageURL  string `json:"ad_image_url" msgpack:"ad_image_url"`
			} `json:"sponsors" msgpack:"sponsors"`
		}
		if err := json.Unmarshal(msg.Data, &cfg); err != nil {
			rl.log.Errorw("sponsor_config json decode error", "error", err)
			return
		}
		packed, err := msgpack.Marshal(cfg)
		if err != nil {
			rl.log.Errorw("sponsor_config msgpack encode error", "error", err)
			return
		}
		rl.hub.Broadcast(packed)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// sponsor_bonus: broadcast sponsor bonus drop announcements to all WS clients.
	sub, err = rl.nc.Subscribe(TopicSponsorBonusDrop(rl.room), func(msg *nats.Msg) {
		var drop struct {
			Op          string `json:"op"           msgpack:"op"`
			SponsorID   string `json:"sponsor_id"   msgpack:"sponsor_id"`
			SponsorName string `json:"sponsor_name" msgpack:"sponsor_name"`
			TokenSymbol string `json:"token_symbol" msgpack:"token_symbol"`
			CoinCount   int    `json:"coin_count"   msgpack:"coin_count"`
		}
		if err := json.Unmarshal(msg.Data, &drop); err != nil {
			rl.log.Errorw("sponsor_bonus json decode error", "error", err)
			return
		}
		packed, err := msgpack.Marshal(drop)
		if err != nil {
			rl.log.Errorw("sponsor_bonus msgpack encode error", "error", err)
			return
		}
		rl.hub.Broadcast(packed)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	// sponsor_reward: JSON from backend → re-encode as msgpack for target user.
	sub, err = rl.nc.Subscribe("game."+rl.room+".sponsor_reward", func(msg *nats.Msg) {
		var incoming struct {
			Op          string `json:"op"`
			UserID      string `json:"user_id"`
			CampaignID  string `json:"campaign_id"`
			TokenSymbol string `json:"token_symbol"`
			Amount      string `json:"amount"`
		}
		if err := json.Unmarshal(msg.Data, &incoming); err != nil {
			rl.log.Errorw("sponsor_reward json decode error", "error", err)
			return
		}
		// Re-encode as msgpack matching client SponsorRewardMessage type.
		packed, err := msgpack.Marshal(struct {
			Op          string `msgpack:"op"`
			CampaignID  string `msgpack:"campaign_id"`
			TokenSymbol string `msgpack:"token_symbol"`
			Amount      string `msgpack:"amount"`
			TotalBalance string `msgpack:"total_balance"`
		}{
			Op:           "sponsor_reward",
			CampaignID:   incoming.CampaignID,
			TokenSymbol:  incoming.TokenSymbol,
			Amount:       incoming.Amount,
			TotalBalance: incoming.Amount, // v1: total_balance equals amount per flush
		})
		if err != nil {
			rl.log.Errorw("sponsor_reward msgpack encode error", "error", err)
			return
		}
		rl.hub.SendToUser(incoming.UserID, packed)
	})
	if err != nil {
		return err
	}
	rl.subs = append(rl.subs, sub)

	rl.log.Infow("nats relay started", "room", rl.room)
	return nil
}

// Stop unsubscribes from all NATS topics.
func (rl *Relay) Stop() {
	for _, sub := range rl.subs {
		sub.Unsubscribe()
	}
	rl.subs = nil
	rl.log.Infow("nats relay stopped", "room", rl.room)
}
