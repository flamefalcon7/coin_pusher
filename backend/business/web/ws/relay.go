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
