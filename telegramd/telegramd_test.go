package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"image/png"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gotd/td/telegram/auth/qrlogin"
	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"
)

func newTestService(t *testing.T) *Service {
	t.Helper()
	dir := t.TempDir()
	s, err := NewService(MakePaths(dir, "", ""))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func TestVaultRoundTripAndLabels(t *testing.T) {
	dir := t.TempDir()
	v, err := OpenVault(filepath.Join(dir, "k"), "")
	if err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(filepath.Join(dir, "k"))
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("key mode %v", st.Mode())
	}
	p := filepath.Join(dir, "f")
	if err := v.WriteSealed(p, "a", []byte("secret-session")); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(p)
	if strings.Contains(string(raw), "secret-session") {
		t.Fatal("plaintext on disk")
	}
	got, err := v.ReadSealed(p, "a")
	if err != nil || string(got) != "secret-session" {
		t.Fatalf("roundtrip %q %v", got, err)
	}
	if _, err := v.ReadSealed(p, "b"); err == nil {
		t.Fatal("label swap must fail")
	}
	v2, _ := OpenVault(filepath.Join(dir, "k"), "")
	if got, err := v2.ReadSealed(p, "a"); err != nil || string(got) != "secret-session" {
		t.Fatal("reopen with same key failed")
	}
	v3, _ := OpenVault(filepath.Join(t.TempDir(), "other"), "")
	if _, err := v3.ReadSealed(p, "a"); err == nil {
		t.Fatal("other key must fail")
	}
	if b, err := v.ReadSealed(filepath.Join(dir, "missing"), "a"); b != nil || err != nil {
		t.Fatal("missing file should be nil,nil")
	}
}

func TestStateStoragePersists(t *testing.T) {
	dir := t.TempDir()
	v, _ := OpenVault(filepath.Join(dir, "k"), "")
	s, err := OpenStore(v, filepath.Join(dir, "state"), filepath.Join(dir, "sess"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	var _ updates.StateStorage = s
	var _ updates.ChannelAccessHasher = s
	var _ updates.UserAccessHasher = s
	if _, found, _ := s.GetState(ctx, 7); found {
		t.Fatal("no state yet")
	}
	_ = s.SetState(ctx, 7, updates.State{Pts: 10, Qts: 1, Date: 100, Seq: 3})
	_ = s.SetPts(ctx, 7, 11)
	_ = s.SetChannelPts(ctx, 7, 99, 500)
	_ = s.SetChannelAccessHash(ctx, 7, 99, 12345)
	s.PutPeer(Peer{ID: 42, Kind: "user", RawID: 42, AccessHash: 777, Title: "Alice", Username: "alice"})
	s.PutPeer(Peer{ID: 42, Kind: "user", RawID: 42, AccessHash: 1, Title: "", Min: true})
	s.MarkDialog(42, 1000)
	_ = s.Session().StoreSession(ctx, []byte("sess-bytes"))
	_ = s.Close()

	s2, err := OpenStore(v, filepath.Join(dir, "state"), filepath.Join(dir, "sess"))
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	st, found, _ := s2.GetState(ctx, 7)
	if !found || st.Pts != 11 || st.Seq != 3 {
		t.Fatalf("state %+v %v", st, found)
	}
	if pts, ok, _ := s2.GetChannelPts(ctx, 7, 99); !ok || pts != 500 {
		t.Fatal("channel pts")
	}
	if h, ok, _ := s2.GetChannelAccessHash(ctx, 7, 99); !ok || h != 12345 {
		t.Fatal("channel hash")
	}
	p, ok := s2.PeerByID(42)
	if !ok || p.AccessHash != 777 || p.Min || p.Title != "Alice" {
		t.Fatalf("min record must not replace full one: %+v", p)
	}
	if q, ok := s2.PeerByUsername("@ALICE"); !ok || q.ID != 42 {
		t.Fatal("username lookup")
	}
	if !s2.IsDialog(42) || s2.IsDialog(43) {
		t.Fatal("dialogs")
	}
	if b, err := s2.Session().LoadSession(ctx); err != nil || string(b) != "sess-bytes" {
		t.Fatal("session")
	}
	if _, found, _ := s2.GetState(ctx, 8); found {
		t.Fatal("state of another user must not be returned")
	}
}

func TestMarkedIDs(t *testing.T) {
	cases := []struct {
		id   int64
		kind string
		raw  int64
	}{{123, "user", 123}, {-456, "group", 456}, {channelMarked(789), "channel", 789}}
	for _, c := range cases {
		k, r := SplitMarked(c.id)
		if k != c.kind || r != c.raw {
			t.Fatalf("%d -> %s %d", c.id, k, r)
		}
	}
	if channelMarked(1234567890) != -1001234567890 {
		t.Fatal("channel mark is Bot API style")
	}
}

func TestConvertMessages(t *testing.T) {
	s := newTestService(t)
	s.store.AbsorbEntities(tg.Entities{Users: map[int64]*tg.User{5: {ID: 5, FirstName: "Bob", AccessHash: 9}}})
	m := &tg.Message{ID: 77, PeerID: &tg.PeerUser{UserID: 5}, Date: 1700000000, Message: "hi there",
		Media: &tg.MessageMediaDocument{Document: &tg.Document{ID: 1, MimeType: "audio/ogg", Size: 3000, Attributes: []tg.DocumentAttributeClass{&tg.DocumentAttributeAudio{Voice: true, Duration: 4}}}}}
	m.SetReplyTo(&tg.MessageReplyHeader{ReplyToMsgID: 70})
	out, ok := s.store.ConvertMessage(m)
	if !ok || out.Chat != 5 || out.FromName != "Bob" || out.Media == nil || out.Media.Kind != "voice" || out.Media.Duration != 4 || out.ReplyTo != 70 {
		t.Fatalf("%+v %+v", out, out.Media)
	}
	svc := &tg.MessageService{ID: 3, PeerID: &tg.PeerChannel{ChannelID: 10}, Action: &tg.MessageActionPhoneCall{Reason: &tg.PhoneCallDiscardReasonMissed{}}}
	o2, _ := s.store.ConvertMessage(svc)
	if o2.Chat != channelMarked(10) || o2.Service != "call, missed" {
		t.Fatalf("%+v", o2)
	}
	ph := &tg.MessageMediaPhoto{Photo: &tg.Photo{Sizes: []tg.PhotoSizeClass{&tg.PhotoSize{Type: "m", W: 320, H: 240, Size: 10}, &tg.PhotoSize{Type: "y", W: 1280, H: 960, Size: 99}}}}
	md := ConvertMedia(ph)
	if md.Kind != "photo" || md.W != 1280 || !md.File {
		t.Fatalf("%+v", md)
	}
	if sz, _ := bestPhotoSize(ph.Photo.(*tg.Photo).Sizes, 400); sz.typ != "m" {
		t.Fatalf("thumb pick %+v", sz)
	}
	if sz, _ := bestPhotoSize([]tg.PhotoSizeClass{&tg.PhotoSize{Type: "y", W: 1280, H: 960}}, 400); sz.typ != "y" {
		t.Fatal("fallback to smallest")
	}
}

func TestChannelPeerRights(t *testing.T) {
	ch := &tg.Channel{ID: 1, Title: "News", Broadcast: true}
	p, _ := PeerFromChat(ch)
	if p.CanPost {
		t.Fatal("plain subscriber cannot post")
	}
	ch2 := &tg.Channel{ID: 2, Title: "Mine", Broadcast: true, Creator: true}
	p2, _ := PeerFromChat(ch2)
	if !p2.CanPost || p2.ID != channelMarked(2) {
		t.Fatal("creator can post")
	}
	sg := &tg.Channel{ID: 3, Title: "Group", Megagroup: true}
	p3, _ := PeerFromChat(sg)
	if !p3.CanPost {
		t.Fatal("supergroup member can write")
	}
}

func TestPolicy(t *testing.T) {
	dir := t.TempDir()
	cfg := DefaultConfig()
	cfg.Limits.PerHour = 3
	pol := NewPolicy(func() Config { return cfg }, filepath.Join(dir, "off"), filepath.Join(dir, "trip"))
	now := time.Unix(1_700_000_000, 0)
	pol.now = func() time.Time { return now }
	known := Peer{ID: 1, Title: "Known"}
	stranger := Peer{ID: 2, Title: "Stranger", Username: "strange"}
	if e := pol.Check("agent", stranger, false); e == nil || e.Code != "TELEGRAM_CHAT_NOT_ALLOWED" {
		t.Fatalf("stranger: %v", e)
	}
	cfg.AgentAllow = []string{"@Strange"}
	if e := pol.Check("agent", stranger, false); e != nil {
		t.Fatalf("allowlisted: %v", e)
	}
	if e := pol.Check("agent", known, true); e != nil {
		t.Fatal(e)
	}
	pol.Record("agent", known)
	if e := pol.Check("agent", known, true); e == nil || e.Code != "TELEGRAM_RATE_LIMITED" {
		t.Fatal("per chat interval")
	}
	if e := pol.Check("ui", known, true); e != nil {
		t.Fatal("ui is separate")
	}
	for i := 0; i < 2; i++ {
		now = now.Add(10 * time.Second)
		pol.Record("agent", known)
	}
	now = now.Add(10 * time.Second)
	if e := pol.Check("agent", known, true); e == nil || !strings.Contains(e.Msg, "hourly") {
		t.Fatalf("hourly: %v", e)
	}
	now = now.Add(2 * time.Hour)
	if e := pol.Check("agent", known, true); e != nil {
		t.Fatalf("window slides: %v", e)
	}
	_ = os.WriteFile(filepath.Join(dir, "off"), nil, 0o600)
	if e := pol.Check("agent", known, true); e == nil || e.Code != "TELEGRAM_AGENT_SEND_OFF" {
		t.Fatal("flag file")
	}
	_ = os.Remove(filepath.Join(dir, "off"))
	pol.Trip(24*time.Hour, "PEER_FLOOD")
	if e := pol.Check("agent", known, true); e == nil || e.Code != "TELEGRAM_AGENT_SEND_OFF" || e.RetryAfter <= 0 {
		t.Fatal("trip")
	}
	pol2 := NewPolicy(func() Config { return cfg }, filepath.Join(dir, "off"), filepath.Join(dir, "trip"))
	pol2.now = pol.now
	if e := pol2.Check("agent", known, true); e == nil {
		t.Fatal("trip persists across restarts")
	}
	pol.Untrip()
	if e := pol.Check("agent", known, true); e != nil {
		t.Fatal(e)
	}
	cfg.AgentSend = false
	if e := pol.Check("agent", known, true); e == nil || e.Code != "TELEGRAM_AGENT_SEND_OFF" {
		t.Fatal("switch")
	}
}

func TestMediaCacheTrim(t *testing.T) {
	dir := t.TempDir()
	c := NewMediaCache(dir, func() int64 { return 25 })
	for i, k := range []string{"1_1_full", "1_2_full", "1_3_thumb"} {
		tmp := c.TempPath(k)
		_ = os.WriteFile(tmp, make([]byte, 10), 0o600)
		old := time.Now().Add(time.Duration(i-10) * time.Minute)
		if _, err := c.Commit(k, tmp, MediaFile{Mime: "application/pdf", Name: "x.pdf"}); err != nil {
			t.Fatal(err)
		}
		_ = os.Chtimes(filepath.Join(dir, k), old, old)
	}
	c.Trim("")
	if _, ok := c.Get("1_1_full"); ok {
		t.Fatal("oldest should be evicted")
	}
	if f, ok := c.Get("1_3_thumb"); !ok || f.Name != "x.pdf" || f.Size != 10 {
		t.Fatalf("newest kept: %+v %v", f, ok)
	}
	if _, ok := c.Get("../etc_1_full"); ok {
		t.Fatal("bad key")
	}
}

func TestRedact(t *testing.T) {
	in := "rpc error: AUTH_KEY abcdef0123456789abcdef0123456789 short"
	out := redactLong(in)
	if strings.Contains(out, "abcdef0123456789abcdef0123456789") || !strings.Contains(out, "short") {
		t.Fatal(out)
	}
}

// ---------------------------------------------------------------- RPC over a real unix socket

func startRPC(t *testing.T, s *Service) *http.Client {
	t.Helper()
	ln, err := net.Listen("unix", s.P.Sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: s.Handler()}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", s.P.Sock)
	}}, Timeout: 10 * time.Second}
}

func call(t *testing.T, c *http.Client, method, path, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, "http://telegramd"+path, strings.NewReader(body))
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func TestRPCWithoutCredentials(t *testing.T) {
	s := newTestService(t)
	c := startRPC(t, s)

	st, out := call(t, c, "GET", "/status", "")
	if st != 200 || out["credentials"] != false || out["auth"].(map[string]any)["state"] != "no_credentials" {
		t.Fatalf("%d %v", st, out)
	}
	st, out = call(t, c, "POST", "/send", `{"chat":1,"text":"x","origin":"agent"}`)
	if st != 409 || out["code"] != "TELEGRAM_NOT_CONFIGURED" {
		t.Fatalf("%d %v", st, out)
	}
	st, out = call(t, c, "POST", "/creds", `{"apiId":"abc","apiHash":"zz"}`)
	if st != 400 || out["code"] != "TELEGRAM_BAD_REQUEST" {
		t.Fatalf("%d %v", st, out)
	}
	st, out = call(t, c, "POST", "/config", `{"limits":{"perHour":9999},"agentSend":false}`)
	cfg := out["config"].(map[string]any)
	if st != 200 || cfg["agentSend"] != false || cfg["limits"].(map[string]any)["perHour"].(float64) != 600 || cfg["phone"] != "" {
		t.Fatalf("merge+clamp: %v", out)
	}
	if b, _ := os.ReadFile(s.P.Config); !strings.Contains(string(b), `"agentSend": false`) {
		t.Fatal("config not saved")
	}
	st, out = call(t, c, "POST", "/resolve", `{"username":"durov","origin":"agent"}`)
	if st != 403 {
		t.Fatalf("agents must not resolve: %d %v", st, out)
	}
	st, out = call(t, c, "POST", "/send_media", `{"chat":1,"path":"/etc/passwd","origin":"ui"}`)
	if st != 400 || out["code"] != "TELEGRAM_BAD_REQUEST" {
		t.Fatalf("spool escape: %d %v", st, out)
	}
	st, out = call(t, c, "POST", "/call/place", `{}`)
	if st != 501 || out["code"] != "TELEGRAM_CALLS_UNAVAILABLE" {
		t.Fatalf("%d %v", st, out)
	}
	st, out = call(t, c, "POST", "/login/qr", ``)
	if st != 409 || out["code"] != "TELEGRAM_NOT_CONFIGURED" {
		t.Fatalf("%d %v", st, out)
	}

	// events: hello first, then a config event after a change
	req, _ := http.NewRequest("GET", "http://telegramd/events", nil)
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	rd := bufio.NewReader(res.Body)
	line, _ := rd.ReadString('\n')
	if !strings.Contains(line, `"type":"hello"`) {
		t.Fatal(line)
	}
	call(t, c, "POST", "/config", `{"agentSend":true}`)
	line, _ = rd.ReadString('\n')
	if !strings.Contains(line, `"type":"config"`) {
		t.Fatal(line)
	}

	// valid credentials are stored sealed; the hash never comes back
	hash := strings.Repeat("ab", 16)
	st, out = call(t, c, "POST", "/creds", `{"apiId":12345,"apiHash":"`+hash+`"}`)
	if st != 200 {
		t.Fatalf("%d %v", st, out)
	}
	raw, _ := os.ReadFile(s.P.Creds)
	if strings.Contains(string(raw), hash) {
		t.Fatal("api hash in plaintext")
	}
	_, out = call(t, c, "GET", "/status", "")
	b, _ := json.Marshal(out)
	if strings.Contains(string(b), hash) || out["credentials"] != true {
		t.Fatalf("status leaks or misses creds: %s", b)
	}
	s2, err := NewService(s.P)
	if err != nil {
		t.Fatal(err)
	}
	if !s2.creds.Valid() || s2.creds.APIID != 12345 {
		t.Fatal("creds reload")
	}
	s2.Close()
}

func TestHubBacklogAndGap(t *testing.T) {
	h := NewHub()
	for i := 0; i < ringSize+10; i++ {
		h.Emit("x", i)
	}
	bl, gap, ch := h.Subscribe(5)
	defer h.Unsubscribe(ch)
	if !gap || len(bl) != ringSize {
		t.Fatalf("gap %v len %d", gap, len(bl))
	}
	bl2, gap2, ch2 := h.Subscribe(h.Seq() - 2)
	defer h.Unsubscribe(ch2)
	if gap2 || len(bl2) != 2 {
		t.Fatal("small backlog")
	}
}

func TestEnvCredentialsFile(t *testing.T) {
	dir := t.TempDir()
	p := MakePaths(dir, "", "")
	hash := strings.Repeat("0f", 16)
	_ = os.WriteFile(p.EnvCreds, []byte("# test\nexport TELEGRAM_API_ID=\"4242\"\nTELEGRAM_API_HASH="+hash+"\n"), 0o644)
	if _, err := credsFromEnvFile(p.EnvCreds); err == nil {
		t.Fatal("world-readable file must be refused")
	}
	_ = os.Chmod(p.EnvCreds, 0o600)
	s, err := NewService(p)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.creds.APIID != 4242 || s.credsSource != "file" {
		t.Fatalf("%d %s", s.creds.APIID, s.credsSource)
	}
	st := s.Status()
	b, _ := json.Marshal(st)
	if strings.Contains(string(b), hash) || st["credentialsSource"] != "file" {
		t.Fatal("status")
	}
	if err := s.SetCreds(Creds{APIID: 1, APIHash: hash}); err == nil {
		t.Fatal("file takes precedence")
	}
}

func TestQRPNG(t *testing.T) {
	s := newTestService(t)
	if _, err := s.QRPNG(); err == nil {
		t.Fatal("no QR login in progress must fail")
	}
	tok := qrlogin.NewToken([]byte("0123456789abcdef0123456789abcdef"), int(time.Now().Add(time.Minute).Unix()))
	s.mu.Lock()
	s.qrToken, s.qrExpires, s.state = &tok, tok.Expires().Unix(), stWaitQR
	s.mu.Unlock()
	b, err := s.QRPNG()
	if err != nil || len(b) < 100 || string(b[1:4]) != "PNG" {
		t.Fatalf("png: %v %d", err, len(b))
	}
	v := s.authView()
	js, _ := json.Marshal(v)
	if strings.Contains(string(js), "tg://") || strings.Contains(string(js), "token") {
		t.Fatalf("auth view must not carry the token: %s", js)
	}
}

func TestQRGeometry(t *testing.T) {
	b, err := renderQR("tg://login?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 10, 4)
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	r := img.Bounds()
	if r.Dx() != r.Dy() || r.Dx() < 200 {
		t.Fatalf("not a usable square: %v", r)
	}
	quiet := 40
	black := func(x, y int) bool { g, _, _, _ := img.At(x, y).RGBA(); return g < 0x8000 }
	minX, maxX := r.Dx(), -1
	for y := 0; y < r.Dy(); y++ {
		for x := 0; x < r.Dx(); x++ {
			if !black(x, y) {
				continue
			}
			if x < quiet || y < quiet || x >= r.Dx()-quiet || y >= r.Dy()-quiet {
				t.Fatalf("black pixel in the quiet zone at %d,%d", x, y)
			}
			minX, maxX = min(minX, x), max(maxX, x)
		}
	}
	inner := r.Dx() - 2*quiet
	if span := maxX - minX + 1; span < inner*8/10 {
		t.Fatalf("modules span %d of %d px: QR drawn too small", span, inner)
	}
}
