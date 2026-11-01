package main

// Telegram 1:1 voice calls.
//
// Signalling is MTProto (phone.requestCall / acceptCall / confirmCall /
// discardCall / sendSignalingData, updates updatePhoneCall and
// updatePhoneCallSignalingData); the Diffie-Hellman values are checked here
// (dh.go) and the key exchange and the media run in the MediaEngine
// (libntgcalls). Audio reaches phone-hookd through calls.sock (callaudio.go).
// Media goes through Telegram's relays only (p2p off): the other side never
// learns this server's address. Which calls ring, are declined or ignored is
// phone-hookd's decision (it knows the Phone mode and the open tabs).

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gotd/td/tg"
)

// callAPI is the part of tg.Client the calls need (a fake in tests).
type callAPI interface {
	MessagesGetDhConfig(ctx context.Context, req *tg.MessagesGetDhConfigRequest) (tg.MessagesDhConfigClass, error)
	PhoneRequestCall(ctx context.Context, req *tg.PhoneRequestCallRequest) (*tg.PhonePhoneCall, error)
	PhoneAcceptCall(ctx context.Context, req *tg.PhoneAcceptCallRequest) (*tg.PhonePhoneCall, error)
	PhoneConfirmCall(ctx context.Context, req *tg.PhoneConfirmCallRequest) (*tg.PhonePhoneCall, error)
	PhoneDiscardCall(ctx context.Context, req *tg.PhoneDiscardCallRequest) (tg.UpdatesClass, error)
	PhoneReceivedCall(ctx context.Context, peer tg.InputPhoneCall) (bool, error)
	PhoneSendSignalingData(ctx context.Context, req *tg.PhoneSendSignalingDataRequest) (bool, error)
}

type tgCall struct {
	Local      string
	ID         int64
	AccessHash int64
	User       Peer
	Out        bool
	State      string // requesting | ringing | incoming | accepting | connecting | active | ended
	Emojis     string
	Video      bool
	Created    time.Time
	Started    time.Time
	audioKey   string
	key        int64 // engine key: the peer's user id
	gaHash     []byte
	p          []byte
	audio      *callAudio
	ended      bool
}

func (c *tgCall) input() *tg.InputPhoneCall { return &tg.InputPhoneCall{ID: c.ID, AccessHash: c.AccessHash} }

func (c *tgCall) dir() string {
	if c.Out {
		return "out"
	}
	return "in"
}

func (c *tgCall) view() map[string]any {
	v := map[string]any{"callId": c.Local, "direction": c.dir(), "state": c.State, "chat": c.User.ID, "title": c.User.Title, "created": c.Created.Unix()}
	if c.Emojis != "" {
		v["emojis"] = c.Emojis
	}
	if !c.Started.IsZero() {
		v["started"] = c.Started.Unix()
		v["seconds"] = int(time.Since(c.Started).Seconds())
	}
	return v
}

type Calls struct {
	s       *Service
	eng     MediaEngine
	apiFn   func() (callAPI, error)
	mu      sync.Mutex
	byLocal map[string]*tgCall
	byTG    map[int64]*tgCall
	byKey   map[int64]*tgCall
	dhP     []byte
	dhG     int
	dhVer   int
	placed  []time.Time // outgoing calls in the last 24 h (daily cap)
	now     func() time.Time
}

func newCalls(s *Service, eng MediaEngine, apiFn func() (callAPI, error)) *Calls {
	c := &Calls{s: s, eng: eng, apiFn: apiFn, byLocal: map[string]*tgCall{}, byTG: map[int64]*tgCall{}, byKey: map[int64]*tgCall{}, now: time.Now}
	eng.SetCallbacks(EngineCallbacks{Signal: c.onEngineSignal, Frames: c.onEngineFrames, Connection: c.onEngineConnection, Emojis: c.onEngineEmojis})
	return c
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (c *Calls) emit(typ string, call *tgCall, extra map[string]any) {
	c.mu.Lock()
	v := call.view()
	c.mu.Unlock()
	for k, x := range extra {
		v[k] = x
	}
	c.s.hub.Emit(typ, v)
}

// List returns the calls in progress.
func (c *Calls) List() []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []map[string]any{}
	for _, x := range c.byLocal {
		out = append(out, x.view())
	}
	return out
}

func (c *Calls) active() int {
	n := 0
	for _, x := range c.byLocal {
		if !x.ended {
			n++
		}
	}
	return n
}

func (c *Calls) get(local string) (*tgCall, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	x := c.byLocal[local]
	if x == nil || x.ended {
		return nil, errf("TELEGRAM_CALL_NOT_FOUND", 404, "no Telegram call %s in progress", local)
	}
	return x, nil
}

func (c *Calls) protocol() (*tg.PhoneCallProtocol, error) {
	p, err := c.eng.Protocol()
	if err != nil {
		return nil, err
	}
	return &tg.PhoneCallProtocol{UDPP2P: p.UDPP2P, UDPReflector: p.UDPReflector, MinLayer: p.MinLayer, MaxLayer: p.MaxLayer, LibraryVersions: p.Versions}, nil
}

// dhConfig fetches (and caches) the DH prime; returns g, p and 256 random bytes.
func (c *Calls) dhConfig(ctx context.Context, api callAPI) (int, []byte, []byte, error) {
	c.mu.Lock()
	ver := c.dhVer
	c.mu.Unlock()
	r, err := api.MessagesGetDhConfig(ctx, &tg.MessagesGetDhConfigRequest{Version: ver, RandomLength: 256})
	if err != nil {
		return 0, nil, nil, err
	}
	var random []byte
	switch d := r.(type) {
	case *tg.MessagesDhConfig:
		if err := CheckDHConfig(d.G, d.P); err != nil {
			return 0, nil, nil, fmt.Errorf("Telegram sent a DH configuration that fails the checks: %w", err)
		}
		c.mu.Lock()
		c.dhG, c.dhP, c.dhVer = d.G, d.P, d.Version
		c.mu.Unlock()
		random = d.Random
	case *tg.MessagesDhConfigNotModified:
		random = d.Random
	}
	c.mu.Lock()
	g, p := c.dhG, c.dhP
	c.mu.Unlock()
	if len(p) == 0 {
		return 0, nil, nil, errors.New("no DH configuration")
	}
	// Mix our own randomness with the server's, as the official clients do.
	own := make([]byte, 256)
	_, _ = rand.Read(own)
	for i := range own {
		if i < len(random) {
			own[i] ^= random[i]
		}
	}
	return g, p, own, nil
}

func asTgErr(err error, code string, status int, prefix string) error {
	var te *TgErr
	if errors.As(err, &te) {
		return te
	}
	return errf(code, status, "%s: %s", prefix, err.Error())
}

// Place starts an outgoing call to a user.
func (c *Calls) Place(ctx context.Context, chat int64, origin string) (*tgCall, error) {
	if err := c.eng.Available(); err != nil {
		return nil, errf("TELEGRAM_CALLS_UNAVAILABLE", 501, "%s", err.Error())
	}
	cfg := c.s.Config().Calls
	p, ok := c.s.store.PeerByID(chat)
	if !ok {
		return nil, errf("TELEGRAM_CHAT_NOT_FOUND", 404, "chat %d is not known; list chats first", chat)
	}
	if p.Kind != "user" || p.Bot || p.Self || p.Deleted {
		return nil, errf("TELEGRAM_BAD_REQUEST", 400, "%s cannot be called (only people)", p.Title)
	}
	if origin != "ui" {
		if !c.s.Config().AgentSend {
			return nil, errf("TELEGRAM_AGENT_SEND_OFF", 403, "agent actions are switched off in Settings")
		}
		if !c.s.store.IsDialog(p.ID) && !c.s.policy.allowListed(p) {
			return nil, errf("TELEGRAM_CHAT_NOT_ALLOWED", 403, "agents may only call existing conversations or allowlisted chats")
		}
	}
	c.mu.Lock()
	if c.active() > 0 {
		c.mu.Unlock()
		return nil, errf("TELEGRAM_CALL_BUSY", 409, "a Telegram call is already in progress")
	}
	now := c.now()
	kept := c.placed[:0]
	for _, t := range c.placed {
		if now.Sub(t) < 24*time.Hour {
			kept = append(kept, t)
		}
	}
	c.placed = kept
	if len(c.placed) >= cfg.DailyCap {
		c.mu.Unlock()
		return nil, errf("TELEGRAM_RATE_LIMITED", 429, "at most %d outgoing Telegram calls a day (Settings)", cfg.DailyCap)
	}
	c.placed = append(c.placed, now)
	call := &tgCall{Local: "tc-" + randHex(6), User: p, Out: true, State: "requesting", Created: now, audioKey: randHex(16), key: p.RawID}
	c.byLocal[call.Local] = call
	c.byKey[call.key] = call
	c.mu.Unlock()
	c.s.audit.Log(map[string]any{"action": "call.place", "origin": origin, "chat": p.ID})

	fail := func(err error) (*tgCall, error) {
		c.finish(call, "failed", err.Error())
		return nil, asTgErr(err, "TELEGRAM_RPC", 502, "call setup failed")
	}
	api, err := c.apiFn()
	if err != nil {
		return fail(err)
	}
	g, prime, random, err := c.dhConfig(ctx, api)
	if err != nil {
		return fail(err)
	}
	proto, err := c.protocol()
	if err != nil {
		return fail(err)
	}
	if err := c.eng.CreateP2P(call.key); err != nil {
		return fail(err)
	}
	if err := c.eng.SetExternalAudio(call.key, engineSampleRate, 1); err != nil {
		return fail(err)
	}
	gaHash, err := c.eng.InitExchange(call.key, g, prime, random, nil)
	if err != nil {
		return fail(err)
	}
	c.mu.Lock()
	call.p = prime
	c.mu.Unlock()
	var rid [4]byte
	_, _ = rand.Read(rid[:])
	res, err := api.PhoneRequestCall(ctx, &tg.PhoneRequestCallRequest{UserID: InputUser(p), RandomID: int(binary.BigEndian.Uint32(rid[:]) >> 1), GAHash: gaHash, Protocol: *proto})
	if err != nil {
		return fail(err)
	}
	c.mu.Lock()
	if w, ok := res.PhoneCall.(*tg.PhoneCallWaiting); ok {
		call.ID, call.AccessHash = w.ID, w.AccessHash
		c.byTG[w.ID] = call
		if call.State == "requesting" {
			call.State = "ringing"
		}
	}
	c.mu.Unlock()
	c.emit("call.state", call, nil)
	ring := time.Duration(cfg.RingSeconds) * time.Second
	go func() {
		time.Sleep(ring)
		c.mu.Lock()
		waiting := !call.ended && (call.State == "ringing" || call.State == "requesting")
		c.mu.Unlock()
		if waiting {
			_ = c.discard(call, &tg.PhoneCallDiscardReasonMissed{}, "no answer")
		}
	}()
	return call, nil
}

// Answer accepts an incoming call.
func (c *Calls) Answer(ctx context.Context, local string) (*tgCall, error) {
	call, err := c.get(local)
	if err != nil {
		return nil, err
	}
	if err := c.eng.Available(); err != nil {
		return nil, errf("TELEGRAM_CALLS_UNAVAILABLE", 501, "%s", err.Error())
	}
	c.mu.Lock()
	if call.Out || call.State != "incoming" {
		st := call.State
		c.mu.Unlock()
		return nil, errf("TELEGRAM_BAD_REQUEST", 409, "call %s is not ringing (%s)", local, st)
	}
	call.State = "accepting"
	c.mu.Unlock()
	fail := func(err error) (*tgCall, error) {
		_ = c.discard(call, &tg.PhoneCallDiscardReasonDisconnect{}, err.Error())
		return nil, asTgErr(err, "TELEGRAM_RPC", 502, "answering failed")
	}
	api, err := c.apiFn()
	if err != nil {
		return fail(err)
	}
	g, prime, random, err := c.dhConfig(ctx, api)
	if err != nil {
		return fail(err)
	}
	proto, err := c.protocol()
	if err != nil {
		return fail(err)
	}
	if err := c.eng.CreateP2P(call.key); err != nil {
		return fail(err)
	}
	if err := c.eng.SetExternalAudio(call.key, engineSampleRate, 1); err != nil {
		return fail(err)
	}
	gb, err := c.eng.InitExchange(call.key, g, prime, random, call.gaHash)
	if err != nil {
		return fail(err)
	}
	c.mu.Lock()
	call.p = prime
	c.mu.Unlock()
	res, err := api.PhoneAcceptCall(ctx, &tg.PhoneAcceptCallRequest{Peer: *call.input(), GB: gb, Protocol: *proto})
	if err != nil {
		return fail(err)
	}
	c.emit("call.state", call, nil)
	// The final PhoneCall (g_a, fingerprint, relays) comes as an update, or right here.
	if pc, ok := res.PhoneCall.(*tg.PhoneCall); ok {
		go c.onPhoneCall(context.Background(), pc)
	}
	return call, nil
}

// Hangup ends a call (declines it while it is still ringing in).
func (c *Calls) Hangup(local string, busy bool) error {
	call, err := c.get(local)
	if err != nil {
		return err
	}
	c.mu.Lock()
	st, out := call.State, call.Out
	c.mu.Unlock()
	var reason tg.PhoneCallDiscardReasonClass = &tg.PhoneCallDiscardReasonHangup{}
	why := "hangup"
	switch {
	case busy || (!out && st == "incoming"):
		reason, why = &tg.PhoneCallDiscardReasonBusy{}, "declined"
	case out && st != "active" && st != "connecting":
		reason, why = &tg.PhoneCallDiscardReasonMissed{}, "cancelled"
	}
	return c.discard(call, reason, why)
}

func (c *Calls) discard(call *tgCall, reason tg.PhoneCallDiscardReasonClass, why string) error {
	c.mu.Lock()
	if call.ended {
		c.mu.Unlock()
		return nil
	}
	dur := 0
	if !call.Started.IsZero() {
		dur = int(time.Since(call.Started).Seconds())
	}
	id := call.ID
	c.mu.Unlock()
	var err error
	if id != 0 {
		if api, e := c.apiFn(); e == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			_, err = api.PhoneDiscardCall(ctx, &tg.PhoneDiscardCallRequest{Peer: *call.input(), Duration: dur, Reason: reason})
			cancel()
		}
	}
	c.finish(call, why, "")
	return err
}

// finish tears the call down locally and tells phone-hookd.
func (c *Calls) finish(call *tgCall, reason, detail string) {
	c.mu.Lock()
	if call.ended {
		c.mu.Unlock()
		return
	}
	call.ended = true
	call.State = "ended"
	delete(c.byLocal, call.Local)
	if call.ID != 0 {
		delete(c.byTG, call.ID)
	}
	if c.byKey[call.key] == call {
		delete(c.byKey, call.key)
	}
	audio := call.audio
	call.audio = nil
	c.mu.Unlock()
	_ = c.eng.Stop(call.key)
	if audio != nil {
		audio.Close()
	}
	extra := map[string]any{"reason": reason}
	if detail != "" {
		extra["detail"] = redactLong(detail)
	}
	if !call.Started.IsZero() {
		extra["duration"] = int(time.Since(call.Started).Seconds())
	}
	c.emit("call.ended", call, extra)
	c.s.audit.Log(map[string]any{"action": "call.ended", "chat": call.User.ID, "direction": call.dir(), "reason": reason})
}

// ---------------------------------------------------------------- updates from Telegram

func (s *Service) registerCallHandlers(d tg.UpdateDispatcher) {
	d.OnPhoneCall(func(ctx context.Context, e tg.Entities, u *tg.UpdatePhoneCall) error {
		s.store.AbsorbEntities(e)
		if s.calls != nil {
			go s.calls.onUpdate(context.Background(), u.PhoneCall)
		}
		return nil
	})
	d.OnPhoneCallSignalingData(func(ctx context.Context, e tg.Entities, u *tg.UpdatePhoneCallSignalingData) error {
		if s.calls != nil {
			s.calls.onSignaling(u.PhoneCallID, u.Data)
		}
		return nil
	})
}

func (c *Calls) onSignaling(tgID int64, data []byte) {
	c.mu.Lock()
	call := c.byTG[tgID]
	c.mu.Unlock()
	if call == nil {
		return
	}
	if err := c.eng.SendSignaling(call.key, data); err != nil {
		log.Printf("call %s: signalling in: %v", call.Local, err)
	}
}

func (c *Calls) onUpdate(ctx context.Context, pc tg.PhoneCallClass) {
	switch x := pc.(type) {
	case *tg.PhoneCallRequested:
		c.onRequested(ctx, x)
	case *tg.PhoneCallAccepted:
		c.onAccepted(ctx, x)
	case *tg.PhoneCall:
		c.onPhoneCall(ctx, x)
	case *tg.PhoneCallWaiting:
		c.mu.Lock()
		if call := c.byTG[x.ID]; call != nil && call.Out && call.State == "requesting" {
			call.State = "ringing"
		}
		c.mu.Unlock()
	case *tg.PhoneCallDiscarded:
		c.mu.Lock()
		call := c.byTG[x.ID]
		var st string
		if call != nil {
			st = call.State
		}
		c.mu.Unlock()
		if call != nil {
			why := "remote hangup"
			switch x.Reason.(type) {
			case *tg.PhoneCallDiscardReasonBusy:
				why = "busy"
			case *tg.PhoneCallDiscardReasonMissed:
				why = "missed"
			case *tg.PhoneCallDiscardReasonDisconnect:
				why = "disconnected"
			}
			if !call.Out && st == "incoming" && why == "remote hangup" {
				why = "missed"
			}
			c.finish(call, why, "")
		}
	}
}

func (c *Calls) onRequested(ctx context.Context, x *tg.PhoneCallRequested) {
	from := userMarked(x.AdminID)
	p, _ := c.s.store.PeerByID(from)
	if p.ID == 0 {
		p = Peer{ID: from, Kind: "user", RawID: x.AdminID, Title: fmt.Sprint(from)}
	}
	call := &tgCall{Local: "tc-" + randHex(6), ID: x.ID, AccessHash: x.AccessHash, User: p, State: "incoming", Video: x.Video, Created: c.now(), audioKey: randHex(16), key: x.AdminID, gaHash: x.GAHash}
	c.mu.Lock()
	if c.byTG[x.ID] != nil {
		c.mu.Unlock()
		return
	}
	busy := c.active() > 0
	if !busy {
		c.byLocal[call.Local] = call
		c.byTG[x.ID] = call
		c.byKey[call.key] = call
	}
	c.mu.Unlock()
	if api, err := c.apiFn(); err == nil {
		rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		_, _ = api.PhoneReceivedCall(rctx, *call.input())
		cancel()
		if busy {
			dctx, cancel2 := context.WithTimeout(ctx, 10*time.Second)
			_, _ = api.PhoneDiscardCall(dctx, &tg.PhoneDiscardCallRequest{Peer: *call.input(), Reason: &tg.PhoneCallDiscardReasonBusy{}})
			cancel2()
			c.s.hub.Emit("call.ended", map[string]any{"callId": call.Local, "direction": "in", "chat": p.ID, "title": p.Title, "reason": "busy (another call)"})
			return
		}
	}
	c.emit("call.incoming", call, map[string]any{"audioKey": call.audioKey, "video": x.Video, "supported": c.eng.Available() == nil})
}

func (c *Calls) onAccepted(ctx context.Context, x *tg.PhoneCallAccepted) {
	c.mu.Lock()
	call := c.byTG[x.ID]
	var prime []byte
	if call != nil {
		prime = call.p
	}
	c.mu.Unlock()
	if call == nil || !call.Out {
		return
	}
	if err := CheckDHValue(x.GB, prime); err != nil {
		_ = c.discard(call, &tg.PhoneCallDiscardReasonDisconnect{}, "bad g_b: "+err.Error())
		return
	}
	ga, fp, err := c.eng.ExchangeKeys(call.key, x.GB, 0)
	if err != nil {
		_ = c.discard(call, &tg.PhoneCallDiscardReasonDisconnect{}, err.Error())
		return
	}
	proto, err := c.protocol()
	if err != nil {
		_ = c.discard(call, &tg.PhoneCallDiscardReasonDisconnect{}, err.Error())
		return
	}
	api, err := c.apiFn()
	if err != nil {
		c.finish(call, "failed", err.Error())
		return
	}
	c.mu.Lock()
	call.State = "connecting"
	c.mu.Unlock()
	res, err := api.PhoneConfirmCall(ctx, &tg.PhoneConfirmCallRequest{Peer: *call.input(), GA: ga, KeyFingerprint: fp, Protocol: *proto})
	if err != nil {
		_ = c.discard(call, &tg.PhoneCallDiscardReasonDisconnect{}, err.Error())
		return
	}
	if pc, ok := res.PhoneCall.(*tg.PhoneCall); ok {
		c.connect(call, pc)
	}
}

func (c *Calls) onPhoneCall(ctx context.Context, x *tg.PhoneCall) {
	c.mu.Lock()
	call := c.byTG[x.ID]
	if call == nil || call.Out || call.State != "accepting" {
		c.mu.Unlock()
		return // outgoing calls connect from the confirmCall answer
	}
	call.State = "connecting"
	gaHash, prime := call.gaHash, call.p
	c.mu.Unlock()
	if err := CheckGAHash(x.GAOrB, gaHash); err != nil {
		_ = c.discard(call, &tg.PhoneCallDiscardReasonDisconnect{}, "g_a does not match its hash")
		return
	}
	if err := CheckDHValue(x.GAOrB, prime); err != nil {
		_ = c.discard(call, &tg.PhoneCallDiscardReasonDisconnect{}, "bad g_a: "+err.Error())
		return
	}
	if _, _, err := c.eng.ExchangeKeys(call.key, x.GAOrB, x.KeyFingerprint); err != nil {
		_ = c.discard(call, &tg.PhoneCallDiscardReasonDisconnect{}, err.Error())
		return
	}
	c.connect(call, x)
}

func rtcServers(conns []tg.PhoneConnectionClass) []RTCServer {
	out := []RTCServer{}
	for _, cc := range conns {
		switch x := cc.(type) {
		case *tg.PhoneConnectionWebrtc:
			out = append(out, RTCServer{ID: x.ID, IPv4: x.IP, IPv6: x.Ipv6, Port: x.Port, Username: x.Username, Password: x.Password, Turn: x.Turn, Stun: x.Stun})
		case *tg.PhoneConnection:
			out = append(out, RTCServer{ID: x.ID, IPv4: x.IP, IPv6: x.Ipv6, Port: x.Port, Turn: true, TCP: x.TCP, PeerTag: x.PeerTag})
		}
	}
	return out
}

func (c *Calls) connect(call *tgCall, pc *tg.PhoneCall) {
	// Relay only, whatever the call allows: the peer must not learn our address.
	if err := c.eng.Connect(call.key, rtcServers(pc.Connections), pc.Protocol.LibraryVersions, false); err != nil {
		_ = c.discard(call, &tg.PhoneCallDiscardReasonDisconnect{}, err.Error())
		return
	}
	c.emit("call.state", call, nil)
}

// ---------------------------------------------------------------- engine callbacks

func (c *Calls) byEngineKey(key int64) *tgCall {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.byKey[key]
}

func (c *Calls) onEngineSignal(key int64, data []byte) {
	call := c.byEngineKey(key)
	if call == nil {
		return
	}
	c.mu.Lock()
	id := call.ID
	c.mu.Unlock()
	if id == 0 {
		return
	}
	api, err := c.apiFn()
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := api.PhoneSendSignalingData(ctx, &tg.PhoneSendSignalingDataRequest{Peer: *call.input(), Data: data}); err != nil {
		log.Printf("call %s: signalling out: %v", call.Local, err)
	}
}

func (c *Calls) onEngineConnection(key int64, state string) {
	call := c.byEngineKey(key)
	if call == nil {
		return
	}
	switch state {
	case "connected":
		c.mu.Lock()
		first := call.Started.IsZero()
		if first {
			call.Started = c.now()
		}
		call.State = "active"
		if call.audio != nil {
			call.audio.live.Store(true)
		}
		c.mu.Unlock()
		if first {
			if err := c.eng.SetExternalPlayback(key, engineSampleRate, 1); err != nil {
				log.Printf("call %s: far-end audio: %v", call.Local, err)
			}
		}
		c.emit("call.state", call, nil)
	case "failed", "timeout":
		_ = c.discard(call, &tg.PhoneCallDiscardReasonDisconnect{}, "media "+state)
	case "closed":
		_ = c.discard(call, &tg.PhoneCallDiscardReasonHangup{}, "media closed")
	}
}

func (c *Calls) onEngineEmojis(key int64, emojis string) {
	call := c.byEngineKey(key)
	if call == nil {
		return
	}
	c.mu.Lock()
	call.Emojis = emojis
	c.mu.Unlock()
	c.emit("call.state", call, nil)
}

func (c *Calls) onEngineFrames(key int64, pcm []byte, channels int) {
	call := c.byEngineKey(key)
	if call == nil {
		return
	}
	c.mu.Lock()
	a := call.audio
	c.mu.Unlock()
	if a != nil {
		a.FromEngine(pcm, channels)
	}
}

// attachAudio binds an audio connection from phone-hookd to a call (key checked).
func (c *Calls) attachAudio(local, key string, a *callAudio) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	call := c.byLocal[local]
	if call == nil || call.ended {
		return errors.New("no such call")
	}
	if subtle.ConstantTimeCompare([]byte(key), []byte(call.audioKey)) != 1 {
		return errors.New("bad key")
	}
	if call.audio != nil {
		call.audio.Close()
	}
	call.audio = a
	a.live.Store(call.State == "active")
	ek := call.key
	a.send = func(pcm []byte) error { return c.eng.SendAudio(ek, pcm, time.Now().UnixMilli()) }
	return nil
}

func (c *Calls) detachAudio(a *callAudio) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, x := range c.byLocal {
		if x.audio == a {
			x.audio = nil
		}
	}
}

// ---------------------------------------------------------------- routes

func (s *Service) registerCallRoutes(mux *http.ServeMux) {
	type req struct {
		Chat   int64  `json:"chat"`
		CallID string `json:"callId"`
		Busy   bool   `json:"busy"`
		Origin string `json:"origin"`
	}
	read := func(w http.ResponseWriter, r *http.Request) (req, bool) {
		var b req
		if err := readJSON(r, &b); err != nil {
			writeErr(w, errf("TELEGRAM_BAD_REQUEST", 400, "bad JSON body"))
			return b, false
		}
		if s.calls == nil {
			writeErr(w, errf("TELEGRAM_CALLS_UNAVAILABLE", 501, "calls are not set up"))
			return b, false
		}
		return b, true
	}
	mux.HandleFunc("POST /call/place", func(w http.ResponseWriter, r *http.Request) {
		b, ok := read(w, r)
		if !ok {
			return
		}
		call, err := s.calls.Place(r.Context(), b.Chat, b.Origin)
		if err != nil {
			writeErr(w, err)
			return
		}
		s.calls.mu.Lock()
		v := call.view()
		s.calls.mu.Unlock()
		v["audioKey"] = call.audioKey
		writeJSON(w, 200, map[string]any{"ok": true, "call": v})
	})
	mux.HandleFunc("POST /call/answer", func(w http.ResponseWriter, r *http.Request) {
		b, ok := read(w, r)
		if !ok {
			return
		}
		call, err := s.calls.Answer(r.Context(), b.CallID)
		if err != nil {
			writeErr(w, err)
			return
		}
		s.calls.mu.Lock()
		v := call.view()
		s.calls.mu.Unlock()
		writeJSON(w, 200, map[string]any{"ok": true, "call": v})
	})
	mux.HandleFunc("POST /call/hangup", func(w http.ResponseWriter, r *http.Request) {
		b, ok := read(w, r)
		if !ok {
			return
		}
		if err := s.calls.Hangup(b.CallID, b.Busy); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	})
	mux.HandleFunc("GET /call/status", func(w http.ResponseWriter, r *http.Request) {
		if s.calls == nil {
			writeJSON(w, 200, map[string]any{"ok": true, "available": false, "calls": []any{}})
			return
		}
		avail := s.calls.eng.Available()
		v := map[string]any{"ok": true, "available": avail == nil, "engine": s.calls.eng.Version(), "calls": s.calls.List()}
		if avail != nil {
			v["reason"] = avail.Error()
		}
		writeJSON(w, 200, v)
	})
}
