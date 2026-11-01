package main

// Event hub: NDJSON events to phone-hookd (GET /events?since=N). A ring of
// the last ringSize events lets a reconnecting hookd catch up without a
// full resync; a slow subscriber is dropped rather than blocking Telegram.

import (
	"encoding/json"
	"sync"
	"time"
)

const ringSize = 1000

type Event struct {
	Seq  int64  `json:"seq"`
	Type string `json:"type"`
	At   int64  `json:"at"`
	Data any    `json:"data"`
}

type Hub struct {
	mu   sync.Mutex
	seq  int64
	ring []Event
	subs map[chan Event]struct{}
}

func NewHub() *Hub { return &Hub{subs: map[chan Event]struct{}{}} }

func (h *Hub) Emit(typ string, data any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seq++
	ev := Event{Seq: h.seq, Type: typ, At: time.Now().UnixMilli(), Data: data}
	h.ring = append(h.ring, ev)
	if len(h.ring) > ringSize {
		h.ring = h.ring[len(h.ring)-ringSize:]
	}
	for ch := range h.subs {
		select {
		case ch <- ev:
		default:
			// Slow reader: drop it; it reconnects with ?since and catches up.
			delete(h.subs, ch)
			close(ch)
		}
	}
}

// Subscribe returns the backlog after since (gap=true when the ring no longer
// holds it) and a channel for new events.
func (h *Hub) Subscribe(since int64) (backlog []Event, gap bool, ch chan Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	ch = make(chan Event, 256)
	h.subs[ch] = struct{}{}
	if since > 0 {
		if len(h.ring) > 0 && h.ring[0].Seq > since+1 {
			gap = true
		}
		for _, ev := range h.ring {
			if ev.Seq > since {
				backlog = append(backlog, ev)
			}
		}
	}
	return
}

func (h *Hub) Unsubscribe(ch chan Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.subs[ch]; ok {
		delete(h.subs, ch)
		close(ch)
	}
}

func (h *Hub) Seq() int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.seq
}

func encodeEvent(ev Event) []byte {
	b, _ := json.Marshal(ev)
	return append(b, '\n')
}
