package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gotd/td/tg"
)

// The 2048-bit safe prime Telegram serves in messages.getDhConfig (public, from the MTProto docs).
const tgPrimeHex = "C71CAEB9C6B1C9048E6C522F70F13F73980D40238E3E21C14934D037563D930F48198A0AA7C14058229493D22530F4DBFA336F6E0AC925139543AED44CCE7C3720FD51F69458705AC68CD4FE6B6B13ABDC9746512969328454F18FAF8C595F642477FE96BB2A941D5BCD1D4AC8CC49880708FA9B378E3C4F3A9060BEE67CF9A4A4A695811051907E162753B56B0F6B410DBA74D8A84B2A14B3144E0EF1284754FD17ED950D5965B4B9DD46582DB1178D169C6BC465B0D6FF9CA3928FEF5B9AE4E418FC15E83EBEA0F87FA9FF5EED70050DED2849F47BF959D956850CE929851F0D8115F635B105EE2E4E15D04B2454BF6F4FADF034B10403119CD8E3B92FCC5B"

func tgPrime(t *testing.T) ([]byte, int) {
	p, _ := hex.DecodeString(tgPrimeHex)
	for g := 2; g <= 7; g++ {
		if CheckDHConfig(g, p) == nil {
			return p, g
		}
	}
	t.Fatal("no generator passes the checks for the Telegram prime")
	return nil, 0
}

// dhPublic returns g^x mod p for a random x, padded to 256 bytes.
func dhPublic(g int, p []byte) []byte {
	x := make([]byte, 256)
	_, _ = rand.Read(x)
	v := new(big.Int).Exp(big.NewInt(int64(g)), new(big.Int).SetBytes(x), new(big.Int).SetBytes(p))
	return v.FillBytes(make([]byte, 256))
}

// ---------------------------------------------------------------- fake engine

type fakeEngine struct {
	mu        sync.Mutex
	cb        EngineCallbacks
	g         int
	p         []byte
	ops       []string
	connected []RTCServer
	p2p       bool
	audio     [][]byte
	signals   [][]byte
}

func (f *fakeEngine) log(s string) { f.mu.Lock(); f.ops = append(f.ops, s); f.mu.Unlock() }
func (f *fakeEngine) Available() error { return nil }
func (f *fakeEngine) Version() string  { return "fake" }
func (f *fakeEngine) Protocol() (EngineProtocol, error) {
	return EngineProtocol{MinLayer: 92, MaxLayer: 92, UDPP2P: true, UDPReflector: true, Versions: []string{"11.0.0"}}, nil
}
func (f *fakeEngine) SetCallbacks(cb EngineCallbacks) { f.cb = cb }
func (f *fakeEngine) CreateP2P(key int64) error       { f.log("create"); return nil }
func (f *fakeEngine) InitExchange(key int64, g int, p, random, gaHash []byte) ([]byte, error) {
	f.log("init")
	v := dhPublic(g, p)
	if gaHash == nil { // outgoing: return the commitment
		h := sha256.Sum256(v)
		return h[:], nil
	}
	return v, nil
}
func (f *fakeEngine) ExchangeKeys(key int64, peer []byte, fp int64) ([]byte, int64, error) {
	f.log("exchange")
	return dhPublic(f.g, f.p), 0x1234, nil
}
func (f *fakeEngine) SetExternalAudio(int64, int, int) error { f.log("audio"); return nil }
func (f *fakeEngine) SetExternalPlayback(int64, int, int) error { f.log("playback"); return nil }
func (f *fakeEngine) Connect(key int64, servers []RTCServer, versions []string, p2p bool) error {
	f.mu.Lock()
	f.connected, f.p2p = servers, p2p
	f.mu.Unlock()
	f.log("connect")
	return nil
}
func (f *fakeEngine) SendSignaling(key int64, data []byte) error {
	f.mu.Lock()
	f.signals = append(f.signals, data)
	f.mu.Unlock()
	return nil
}
func (f *fakeEngine) SendAudio(key int64, pcm []byte, ts int64) error {
	f.mu.Lock()
	f.audio = append(f.audio, pcm)
	f.mu.Unlock()
	return nil
}
func (f *fakeEngine) Mute(int64, bool) error { return nil }
func (f *fakeEngine) Stop(int64) error       { f.log("stop"); return nil }

// ---------------------------------------------------------------- fake MTProto

type fakeCallAPI struct {
	mu       sync.Mutex
	g        int
	p        []byte
	reqs     []string
	discards []tg.PhoneCallDiscardReasonClass
	signals  int
}

func (a *fakeCallAPI) rec(s string) { a.mu.Lock(); a.reqs = append(a.reqs, s); a.mu.Unlock() }
func (a *fakeCallAPI) MessagesGetDhConfig(ctx context.Context, r *tg.MessagesGetDhConfigRequest) (tg.MessagesDhConfigClass, error) {
	a.rec("dh")
	return &tg.MessagesDhConfig{G: a.g, P: a.p, Version: 1, Random: make([]byte, 256)}, nil
}
func (a *fakeCallAPI) PhoneRequestCall(ctx context.Context, r *tg.PhoneRequestCallRequest) (*tg.PhonePhoneCall, error) {
	a.rec("request")
	if len(r.GAHash) != 32 || r.Protocol.MaxLayer != 92 {
		panic("bad request")
	}
	return &tg.PhonePhoneCall{PhoneCall: &tg.PhoneCallWaiting{ID: 555, AccessHash: 777}}, nil
}
func (a *fakeCallAPI) PhoneAcceptCall(ctx context.Context, r *tg.PhoneAcceptCallRequest) (*tg.PhonePhoneCall, error) {
	a.rec("accept")
	return &tg.PhonePhoneCall{PhoneCall: &tg.PhoneCallWaiting{ID: r.Peer.ID, AccessHash: r.Peer.AccessHash}}, nil
}
func (a *fakeCallAPI) PhoneConfirmCall(ctx context.Context, r *tg.PhoneConfirmCallRequest) (*tg.PhonePhoneCall, error) {
	a.rec("confirm")
	return &tg.PhonePhoneCall{PhoneCall: &tg.PhoneCall{ID: r.Peer.ID, AccessHash: r.Peer.AccessHash, Protocol: r.Protocol, P2PAllowed: true,
		Connections: []tg.PhoneConnectionClass{&tg.PhoneConnection{ID: 1, IP: "192.0.2.1", Port: 530, PeerTag: []byte("tag")}, &tg.PhoneConnectionWebrtc{ID: 2, IP: "192.0.2.2", Port: 3478, Turn: true, Username: "u", Password: "p"}}}}, nil
}
func (a *fakeCallAPI) PhoneDiscardCall(ctx context.Context, r *tg.PhoneDiscardCallRequest) (tg.UpdatesClass, error) {
	a.mu.Lock()
	a.discards = append(a.discards, r.Reason)
	a.mu.Unlock()
	return &tg.Updates{}, nil
}
func (a *fakeCallAPI) PhoneReceivedCall(ctx context.Context, p tg.InputPhoneCall) (bool, error) {
	a.rec("received")
	return true, nil
}
func (a *fakeCallAPI) PhoneSendSignalingData(ctx context.Context, r *tg.PhoneSendSignalingDataRequest) (bool, error) {
	a.mu.Lock()
	a.signals++
	a.mu.Unlock()
	return true, nil
}

func callFixture(t *testing.T) (*Service, *fakeEngine, *fakeCallAPI, chan Event) {
	s := newTestService(t)
	p, g := tgPrime(t)
	eng := &fakeEngine{g: g, p: p}
	api := &fakeCallAPI{g: g, p: p}
	s.calls = newCalls(s, eng, func() (callAPI, error) { return api, nil })
	s.store.PutPeer(Peer{ID: 4242, Kind: "user", RawID: 4242, AccessHash: 99, Title: "Alice"})
	s.store.MarkDialog(4242, time.Now().Unix())
	_, _, ch := s.hub.Subscribe(0)
	t.Cleanup(func() { s.hub.Unsubscribe(ch) })
	return s, eng, api, ch
}

func waitEvent(t *testing.T, ch chan Event, typ string, pred func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case e := <-ch:
			if e.Type != typ {
				continue
			}
			m, _ := e.Data.(map[string]any)
			if pred == nil || pred(m) {
				return m
			}
		case <-deadline:
			t.Fatalf("no %s event", typ)
		}
	}
}

func TestTelegramPrimePassesChecks(t *testing.T) {
	p, g := tgPrime(t)
	if g < 2 || len(p) != 256 {
		t.Fatal("prime")
	}
	if CheckDHConfig(g, append([]byte{}, p[:255]...)) == nil {
		t.Fatal("short prime accepted")
	}
	ga := dhPublic(g, p)
	if CheckDHValue(ga, p) != nil {
		t.Fatal("valid g_a refused")
	}
	if CheckDHValue([]byte{1}, p) == nil {
		t.Fatal("g_a = 1 accepted")
	}
	h := sha256.Sum256(ga)
	if CheckGAHash(ga, h[:]) != nil || CheckGAHash(ga, make([]byte, 32)) == nil {
		t.Fatal("ga hash")
	}
}

func TestOutgoingCallFlowAndAudio(t *testing.T) {
	s, eng, api, ch := callFixture(t)
	call, err := s.calls.Place(context.Background(), 4242, "ui")
	if err != nil {
		t.Fatal(err)
	}
	if call.State != "ringing" || call.ID != 555 {
		t.Fatalf("state %s id %d", call.State, call.ID)
	}
	if _, err := s.calls.Place(context.Background(), 4242, "ui"); err == nil || !strings.Contains(err.Error(), "already") {
		t.Fatalf("second call: %v", err)
	}
	// The callee accepts.
	s.calls.onUpdate(context.Background(), &tg.PhoneCallAccepted{ID: 555, AccessHash: 777, GB: dhPublic(eng.g, eng.p)})
	eng.mu.Lock()
	p2p, n := eng.p2p, len(eng.connected)
	eng.mu.Unlock()
	if n != 2 || p2p {
		t.Fatalf("connect: %d servers, p2p %v (must be relay only)", n, p2p)
	}
	if !eng.connected[0].Turn || string(eng.connected[0].PeerTag) != "tag" || eng.connected[1].Username != "u" {
		t.Fatalf("servers %+v", eng.connected)
	}
	eng.cb.Connection(4242, "connected")
	waitEvent(t, ch, "call.state", func(m map[string]any) bool { return m["state"] == "active" })
	eng.mu.Lock()
	ops := strings.Join(eng.ops, ",")
	eng.mu.Unlock()
	if !strings.Contains(ops, "connect,playback") || strings.Count(ops, "playback") != 1 {
		t.Fatalf("playback must be set once, after connect: %s", ops)
	}
	eng.cb.Emojis(4242, "abcd")
	waitEvent(t, ch, "call.state", func(m map[string]any) bool { return m["emojis"] == "abcd" })
	eng.cb.Signal(4242, []byte("sig"))
	s.calls.onSignaling(555, []byte("in"))
	if api.signals != 1 || len(eng.signals) != 1 {
		t.Fatalf("signalling: out %d in %d", api.signals, len(eng.signals))
	}

	// Audio through calls.sock: wrong key refused, right key carries audio both ways.
	sock := filepath.Join(t.TempDir(), "calls.sock")
	ln, err := s.serveCallAudio(sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	bad, _ := net.Dial("unix", sock)
	_, _ = bad.Write([]byte(`{"callId":"` + call.Local + `","key":"nope"}` + "\n"))
	if l, _ := bufio.NewReader(bad).ReadString('\n'); !strings.Contains(l, "false") {
		t.Fatalf("bad key answer %q", l)
	}
	bad.Close()
	conn, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	hello, _ := json.Marshal(map[string]string{"callId": call.Local, "key": call.audioKey})
	_, _ = conn.Write(append(hello, '\n'))
	br := bufio.NewReader(conn)
	if l, _ := br.ReadString('\n'); !strings.Contains(l, "true") {
		t.Fatalf("hello answer %q", l)
	}
	block := make([]byte, 160)
	for i := range block {
		block[i] = ulawEncode(int16(8000 * ((i % 20) - 10) / 10))
	}
	for i := 0; i < 5; i++ {
		_, _ = conn.Write(block)
	}
	time.Sleep(200 * time.Millisecond)
	eng.mu.Lock()
	frames := len(eng.audio)
	frameLen := 0
	if frames > 0 {
		frameLen = len(eng.audio[0])
	}
	eng.mu.Unlock()
	if frames < 8 || frameLen != 960 {
		t.Fatalf("to engine: %d frames of %d bytes (want 10 of 960)", frames, frameLen)
	}
	pcm := make([]byte, 960)
	for i := 0; i < 10; i++ {
		eng.cb.Frames(4242, pcm, 1)
	}
	got := make([]byte, 160)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := br.Read(got); err != nil {
		t.Fatalf("from engine: %v", err)
	}

	if err := s.calls.Hangup(call.Local, false); err != nil {
		t.Fatal(err)
	}
	ev := waitEvent(t, ch, "call.ended", nil)
	if ev["reason"] != "hangup" {
		t.Fatalf("ended %v", ev)
	}
	if _, ok := api.discards[0].(*tg.PhoneCallDiscardReasonHangup); !ok {
		t.Fatalf("discard reason %T", api.discards[0])
	}
	if len(s.calls.List()) != 0 {
		t.Fatal("call kept")
	}
}

func TestIncomingCallAnswerAndDecline(t *testing.T) {
	s, eng, api, ch := callFixture(t)
	ga := dhPublic(eng.g, eng.p)
	h := sha256.Sum256(ga)
	s.calls.onUpdate(context.Background(), &tg.PhoneCallRequested{ID: 900, AccessHash: 901, AdminID: 4242, GAHash: h[:]})
	in := waitEvent(t, ch, "call.incoming", nil)
	if in["audioKey"] == "" || in["chat"] != int64(4242) || in["title"] != "Alice" {
		t.Fatalf("incoming %v", in)
	}
	local := in["callId"].(string)
	if _, err := s.calls.Answer(context.Background(), local); err != nil {
		t.Fatal(err)
	}
	// A g_a that does not match the commitment ends the call.
	s.calls.onUpdate(context.Background(), &tg.PhoneCall{ID: 900, AccessHash: 901, GAOrB: dhPublic(eng.g, eng.p), KeyFingerprint: 1})
	ev := waitEvent(t, ch, "call.ended", nil)
	if ev["callId"] != local {
		t.Fatalf("ended %v", ev)
	}
	if _, ok := api.discards[len(api.discards)-1].(*tg.PhoneCallDiscardReasonDisconnect); !ok {
		t.Fatal("bad g_a should disconnect")
	}

	// Second call: the right g_a connects (relay only).
	s.calls.onUpdate(context.Background(), &tg.PhoneCallRequested{ID: 902, AccessHash: 903, AdminID: 4242, GAHash: h[:]})
	in = waitEvent(t, ch, "call.incoming", nil)
	if _, err := s.calls.Answer(context.Background(), in["callId"].(string)); err != nil {
		t.Fatal(err)
	}
	s.calls.onUpdate(context.Background(), &tg.PhoneCall{ID: 902, AccessHash: 903, GAOrB: ga, KeyFingerprint: 1, Connections: []tg.PhoneConnectionClass{&tg.PhoneConnection{ID: 3, IP: "192.0.2.3", Port: 1}}})
	waitEvent(t, ch, "call.state", func(m map[string]any) bool { return m["state"] == "connecting" })
	eng.mu.Lock()
	connected := len(eng.connected)
	eng.mu.Unlock()
	if connected != 1 {
		t.Fatal("not connected")
	}
	// The caller hangs up.
	s.calls.onUpdate(context.Background(), &tg.PhoneCallDiscarded{ID: 902, Reason: &tg.PhoneCallDiscardReasonHangup{}})
	waitEvent(t, ch, "call.ended", func(m map[string]any) bool { return m["reason"] == "remote hangup" })

	// Third call: declined while ringing (busy, as DND and voicemail modes do).
	s.calls.onUpdate(context.Background(), &tg.PhoneCallRequested{ID: 904, AccessHash: 905, AdminID: 4242, GAHash: h[:]})
	in = waitEvent(t, ch, "call.incoming", nil)
	if err := s.calls.Hangup(in["callId"].(string), true); err != nil {
		t.Fatal(err)
	}
	waitEvent(t, ch, "call.ended", func(m map[string]any) bool { return m["reason"] == "declined" })
	if _, ok := api.discards[len(api.discards)-1].(*tg.PhoneCallDiscardReasonBusy); !ok {
		t.Fatal("decline should be busy")
	}
	// Missed: the caller gives up while it rings.
	s.calls.onUpdate(context.Background(), &tg.PhoneCallRequested{ID: 906, AccessHash: 907, AdminID: 4242, GAHash: h[:]})
	waitEvent(t, ch, "call.incoming", nil)
	s.calls.onUpdate(context.Background(), &tg.PhoneCallDiscarded{ID: 906, Reason: &tg.PhoneCallDiscardReasonHangup{}})
	waitEvent(t, ch, "call.ended", func(m map[string]any) bool { return m["reason"] == "missed" })
}

func TestCallPolicy(t *testing.T) {
	s, _, _, _ := callFixture(t)
	s.store.PutPeer(Peer{ID: 5151, Kind: "user", RawID: 5151, AccessHash: 1, Title: "Stranger"})
	if _, err := s.calls.Place(context.Background(), 5151, "agent"); err == nil || !strings.Contains(err.Error(), "existing conversations") {
		t.Fatalf("agent to a stranger: %v", err)
	}
	s.store.PutPeer(Peer{ID: -1001, Kind: "group", RawID: 1001, Title: "Group"})
	if _, err := s.calls.Place(context.Background(), -1001, "ui"); err == nil {
		t.Fatal("group call accepted")
	}
	c := s.Config()
	c.Calls.DailyCap = 1
	if err := s.SetConfig(c); err != nil {
		t.Fatal(err)
	}
	call, err := s.calls.Place(context.Background(), 4242, "agent")
	if err != nil {
		t.Fatal(err)
	}
	_ = s.calls.Hangup(call.Local, false)
	if _, err := s.calls.Place(context.Background(), 4242, "ui"); err == nil || !strings.Contains(err.Error(), "a day") {
		t.Fatalf("daily cap: %v", err)
	}
	d := DefaultConfig().Calls
	if d.DND != "decline" || d.Voicemail != "decline_text" || d.LiveNoTab != "ignore" {
		t.Fatalf("defaults %+v", d)
	}
	bad := Config{Calls: CallsCfg{DND: "x", Voicemail: "y"}}
	bad.normalise()
	if bad.Calls.DND != "decline" || bad.Calls.Voicemail != "decline_text" || bad.Calls.VoicemailText == "" {
		t.Fatalf("normalise %+v", bad.Calls)
	}
}
