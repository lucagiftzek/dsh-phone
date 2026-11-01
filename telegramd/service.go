package main

// Service: one Telegram account over MTProto (gotd/td). It owns the client
// lifecycle (credentials, connect, login by QR or code + 2FA, updates with gap
// recovery) and the operations phone-hookd calls over the RPC socket.

import (
	"bytes"
	"image"
	"image/png"

	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"rsc.io/qr"
	"strings"
	"sync"
	"time"

	"github.com/gotd/td/bin"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/telegram/auth/qrlogin"
	"github.com/gotd/td/telegram/updates"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// Auth states reported by /status.
const (
	stNoCreds    = "no_credentials"
	stConnecting = "connecting"
	stLoggedOut  = "logged_out"
	stWaitQR     = "wait_qr"
	stWaitCode   = "wait_code"
	stWaitPass   = "wait_password"
	stReady      = "ready"
	stError      = "error"
)

type Paths struct {
	Dir, Sock, Key, Cred, Config, Creds, EnvCreds, State, Session, Audit, OffFlag, Trip, Media, Spool, CallsSock string
}

func MakePaths(dir, sock, cred string) Paths {
	j := func(n string) string { return dir + "/" + n }
	if sock == "" {
		sock = j("telegramd.sock")
	}
	return Paths{Dir: dir, Sock: sock, Key: j("vault.key"), Cred: cred, Config: j("config.json"), Creds: j("api.bin"), EnvCreds: j("api.env"),
		State: j("state.bin"), Session: j("session.bin"), Audit: j("audit.jsonl"), OffFlag: j("agent-send.off"),
		Trip: j("agent-trip.json"), Media: j("media"), Spool: j("spool"), CallsSock: j("calls.sock")}
}

type Service struct {
	P      Paths
	vault  *Vault
	store  *Store
	hub    *Hub
	policy *Policy
	audit  *Audit
	media  *MediaCache
	calls  *Calls

	cfgMu sync.RWMutex
	cfg   Config

	mu          sync.Mutex
	creds       Creds
	credsSource string
	wake        chan struct{}
	client      *telegram.Client
	mgr         *updates.Manager
	state       string
	stateErr    string
	connected   bool
	me          *Peer
	qrToken     *qrlogin.Token
	qrExpires   int64
	codeHash    string
	codePhone   string
	codeType    string
	passHint    string
	loginStop   context.CancelFunc
	loggedIn    chan struct{}
	qrLoggedIn  qrlogin.LoggedIn
	restart     context.CancelFunc
	startedAt   time.Time
}

func NewService(p Paths) (*Service, error) {
	for _, d := range []string{p.Dir, p.Media, p.Spool} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
		_ = os.Chmod(d, 0o700)
	}
	v, err := OpenVault(p.Key, p.Cred)
	if err != nil {
		return nil, err
	}
	st, err := OpenStore(v, p.State, p.Session)
	if err != nil {
		return nil, err
	}
	cfg, err := LoadConfig(p.Config)
	if err != nil {
		log.Printf("config: %v (defaults used)", err)
	}
	s := &Service{P: p, vault: v, store: st, hub: NewHub(), audit: NewAudit(p.Audit), cfg: cfg, wake: make(chan struct{}, 1), loggedIn: make(chan struct{}, 1), state: stNoCreds, startedAt: time.Now()}
	s.policy = NewPolicy(s.Config, p.OffFlag, p.Trip)
	s.media = NewMediaCache(p.Media, func() int64 { return int64(s.Config().Media.CacheMB) << 20 })
	s.creds, s.credsSource = s.loadCreds()
	s.calls = newCalls(s, newMediaEngine(), func() (callAPI, error) {
		api, _, _, err := s.api(true)
		if err != nil {
			return nil, err
		}
		return api, nil
	})
	return s, nil
}

// loadCreds prefers the KEY=value file api.env (TELEGRAM_API_ID,
// TELEGRAM_API_HASH; 0600, written by the owner), then the sealed api.bin saved
// from Settings. The values are never logged or returned.
func (s *Service) loadCreds() (Creds, string) {
	if c, err := credsFromEnvFile(s.P.EnvCreds); err == nil && c.Valid() {
		return c, "file"
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("credentials file %s: %v", s.P.EnvCreds, err)
	}
	if b, err := s.vault.ReadSealed(s.P.Creds, labelCreds); err == nil && b != nil {
		var c Creds
		if jsonUnmarshal(b, &c) == nil && c.Valid() {
			return c, "settings"
		}
	} else if err != nil {
		log.Printf("credentials: %v", err)
	}
	return Creds{}, ""
}

// reloadCreds re-reads the credential sources; a change restarts the client.
func (s *Service) reloadCreds() {
	c, src := s.loadCreds()
	s.mu.Lock()
	changed := c != s.creds
	s.creds, s.credsSource = c, src
	r := s.restart
	s.mu.Unlock()
	if changed {
		if r != nil {
			r()
		}
		select {
		case s.wake <- struct{}{}:
		default:
		}
	}
}

func credsFromEnvFile(path string) (Creds, error) {
	st, err := os.Stat(path)
	if err != nil {
		return Creds{}, err
	}
	if st.Mode().Perm()&0o077 != 0 {
		return Creds{}, fmt.Errorf("refusing a credentials file readable by others (mode %v); chmod 600 it", st.Mode().Perm())
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return Creds{}, err
	}
	var c Creds
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "export "))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		switch strings.TrimSpace(k) {
		case "TELEGRAM_API_ID":
			fmt.Sscanf(v, "%d", &c.APIID)
		case "TELEGRAM_API_HASH":
			c.APIHash = strings.ToLower(v)
		}
	}
	if !c.Valid() {
		return Creds{}, errors.New("TELEGRAM_API_ID or TELEGRAM_API_HASH missing or malformed")
	}
	return c, nil
}

func (s *Service) Config() Config {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	return s.cfg
}

func (s *Service) SetConfig(c Config) error {
	c.normalise()
	if err := SaveConfig(s.P.Config, c); err != nil {
		return err
	}
	s.cfgMu.Lock()
	s.cfg = c
	s.cfgMu.Unlock()
	s.hub.Emit("config", map[string]any{"agentSend": c.AgentSend})
	return nil
}

func (s *Service) Close() { _ = s.store.Close() }

func (s *Service) setState(st, errText string) {
	s.mu.Lock()
	changed := s.state != st || s.stateErr != errText
	s.state, s.stateErr = st, errText
	if st != stWaitQR {
		s.qrToken, s.qrExpires = nil, 0
	}
	s.mu.Unlock()
	if changed {
		s.hub.Emit("auth", s.authView())
	}
}

func (s *Service) authView() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := map[string]any{"state": s.state, "connected": s.connected}
	if s.stateErr != "" {
		v["error"] = s.stateErr
	}
	if s.state == stWaitQR && s.qrToken != nil {
		v["qr"] = map[string]any{"expires": s.qrExpires, "image": "/login/qr.png"}
	}
	if s.state == stWaitCode {
		v["code"] = map[string]any{"phone": s.codePhone, "type": s.codeType}
	}
	if s.state == stWaitPass {
		v["password"] = map[string]any{"hint": s.passHint}
	}
	if s.me != nil {
		v["me"] = s.me
	}
	return v
}

// Status is the /status body.
func (s *Service) Status() map[string]any {
	peers, dialogs, channels := s.store.Counts()
	s.mu.Lock()
	hasCreds, src := s.creds.Valid(), s.credsSource
	s.mu.Unlock()
	c := s.Config()
	return map[string]any{
		"ok": true, "version": version, "credentials": hasCreds, "credentialsSource": src, "phone": c.Phone,
		"auth": s.authView(), "agent": s.policy.AgentState(),
		"cache":  map[string]any{"peers": peers, "dialogs": dialogs, "channels": channels, "media": s.media.Usage()},
		"uptime": int(time.Since(s.startedAt).Seconds()), "eventSeq": s.hub.Seq(),
	}
}

// SetCreds stores api_id/api_hash sealed and restarts the client with them.
func (s *Service) SetCreds(c Creds) error {
	c.APIHash = strings.ToLower(strings.TrimSpace(c.APIHash))
	if !c.Valid() {
		return errf("TELEGRAM_BAD_REQUEST", 400, "api_id must be a positive number and api_hash 32 hex characters")
	}
	if _, err := os.Stat(s.P.EnvCreds); err == nil {
		return errf("TELEGRAM_BAD_REQUEST", 409, "the credentials file api.env is in use; edit that file instead")
	}
	b, _ := jsonMarshal(c)
	if err := s.vault.WriteSealed(s.P.Creds, labelCreds, b); err != nil {
		return err
	}
	s.audit.Log(map[string]any{"action": "credentials.set", "origin": "ui"})
	s.reloadCreds()
	return nil
}

// ---------------------------------------------------------------- lifecycle

func (s *Service) Run(ctx context.Context) {
	backoff := 2 * time.Second
	for ctx.Err() == nil {
		s.mu.Lock()
		c := s.creds
		s.mu.Unlock()
		if !c.Valid() {
			s.setState(stNoCreds, "")
			select {
			case <-ctx.Done():
				return
			case <-s.wake:
			case <-time.After(30 * time.Second):
				s.reloadCreds()
			}
			continue
		}
		start := time.Now()
		err := s.runClient(ctx, c)
		if ctx.Err() != nil {
			return
		}
		if err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("telegram client stopped: %v", redactErr(err))
			if isAuthDead(err) {
				s.forgetSession("the session was revoked or expired")
				backoff = 2 * time.Second
				continue
			}
			s.setState(stError, redactErr(err))
		}
		if time.Since(start) > 2*time.Minute {
			backoff = 2 * time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		case <-s.wake:
		}
		if backoff < time.Minute {
			backoff *= 2
		}
	}
}

func isAuthDead(err error) bool {
	return tgerr.Is(err, "AUTH_KEY_UNREGISTERED", "SESSION_REVOKED", "SESSION_EXPIRED", "USER_DEACTIVATED", "USER_DEACTIVATED_BAN", "AUTH_KEY_DUPLICATED")
}

func (s *Service) forgetSession(why string) {
	_ = os.Remove(s.P.Session)
	s.store.Reset(0)
	s.mu.Lock()
	s.me = nil
	s.mu.Unlock()
	s.audit.Log(map[string]any{"action": "session.forgotten", "why": why})
	s.setState(stLoggedOut, why)
}

func (s *Service) runClient(parent context.Context, c Creds) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	d := tg.NewUpdateDispatcher()
	s.registerHandlers(d)
	qrIn := qrlogin.OnLoginToken(d)
	mgr := updates.New(updates.Config{
		Handler:          d,
		Storage:          s.store,
		AccessHasher:     s.store,
		UserAccessHasher: s.store,
		OnTooLong:        func() { s.hub.Emit("resync", map[string]any{"why": "difference too long"}) },
		OnChannelTooLong: func(id int64) {
			s.hub.Emit("resync", map[string]any{"why": "channel difference too long", "chat": channelMarked(id)})
		},
		OnLoadUserStateFailed: func() { s.hub.Emit("resync", map[string]any{"why": "no stored update state"}) },
	})
	cfg := s.Config()
	client := telegram.NewClient(c.APIID, c.APIHash, telegram.Options{
		SessionStorage: s.store.Session(),
		UpdateHandler:  mgr,
		Middlewares:    []telegram.Middleware{s.floodMiddleware()},
		Device: telegram.DeviceConfig{
			DeviceModel: cfg.DeviceModel, SystemVersion: "Linux", AppVersion: version,
			SystemLangCode: "en", LangCode: "en",
		},
		OnConnectionState: func(st telegram.ConnectionState) {
			s.mu.Lock()
			s.connected = st == telegram.ConnectionStateReady
			s.mu.Unlock()
		},
	})
	s.mu.Lock()
	s.client, s.mgr, s.qrLoggedIn, s.restart = client, mgr, qrIn, cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.client, s.mgr, s.restart, s.connected = nil, nil, nil, false
		if s.loginStop != nil {
			s.loginStop()
			s.loginStop = nil
		}
		s.mu.Unlock()
	}()
	s.setState(stConnecting, "")
	return client.Run(ctx, func(ctx context.Context) error {
		s.mu.Lock()
		s.connected = true
		s.mu.Unlock()
		for {
			st, err := client.Auth().Status(ctx)
			if err != nil {
				return err
			}
			if st.Authorized && st.User != nil {
				s.onAuthorized(st.User)
				return mgr.Run(ctx, client.API(), st.User.ID, updates.AuthOptions{
					OnStart: func(ctx context.Context) { s.setState(stReady, "") },
				})
			}
			s.mu.Lock()
			waiting := s.state == stWaitQR || s.state == stWaitCode || s.state == stWaitPass
			s.mu.Unlock()
			if !waiting {
				s.setState(stLoggedOut, "")
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-s.loggedIn:
			}
		}
	})
}

func (s *Service) onAuthorized(u *tg.User) {
	s.store.Adopt(u.ID)
	p := PeerFromUser(u)
	s.store.PutPeer(p)
	s.mu.Lock()
	s.me = &p
	s.mu.Unlock()
	s.hub.Emit("auth", s.authView())
}

// api returns the live client API or an error when not connected and logged in.
func (s *Service) api(needAuth bool) (*tg.Client, *telegram.Client, *updates.Manager, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.creds.Valid() {
		return nil, nil, nil, errf("TELEGRAM_NOT_CONFIGURED", 409, "enter api_id and api_hash in Settings > Phone > Telegram first")
	}
	if s.client == nil {
		return nil, nil, nil, errf("TELEGRAM_UNAVAILABLE", 503, "not connected to Telegram yet (state %s)", s.state)
	}
	if needAuth && s.me == nil {
		return nil, nil, nil, errf("TELEGRAM_NOT_LOGGED_IN", 409, "the Telegram account is not logged in (Settings > Phone > Telegram)")
	}
	return s.client.API(), s.client, s.mgr, nil
}

func (s *Service) signalLoggedIn() {
	select {
	case s.loggedIn <- struct{}{}:
	default:
	}
}

// ---------------------------------------------------------------- login

func (s *Service) beginLogin(st string) (context.Context, *telegram.Client, error) {
	_, client, _, err := s.api(false)
	if err != nil {
		return nil, nil, err
	}
	s.mu.Lock()
	if s.me != nil {
		s.mu.Unlock()
		return nil, nil, errf("TELEGRAM_LOGIN_STATE", 409, "already logged in")
	}
	if s.loginStop != nil {
		s.loginStop()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	s.loginStop = cancel
	s.mu.Unlock()
	s.setState(st, "")
	return ctx, client, nil
}

// LoginQR starts a QR login; the URL appears in /status (auth.qr) and in an
// "auth" event, refreshed until scanned, cancelled or 10 minutes passed.
func (s *Service) LoginQR() error {
	ctx, client, err := s.beginLogin(stWaitQR)
	if err != nil {
		return err
	}
	s.mu.Lock()
	in := s.qrLoggedIn
	s.mu.Unlock()
	go func() {
		_, err := client.QR().Auth(ctx, in, func(ctx context.Context, t qrlogin.Token) error {
			s.mu.Lock()
			tt := t
			s.qrToken, s.qrExpires = &tt, t.Expires().Unix()
			s.mu.Unlock()
			s.hub.Emit("auth", s.authView())
			return nil
		})
		s.finishLogin(ctx, client, err, "qr")
	}()
	return nil
}

func (s *Service) finishLogin(ctx context.Context, client *telegram.Client, err error, how string) {
	switch {
	case err == nil:
		s.audit.Log(map[string]any{"action": "login", "how": how})
		s.setState(stConnecting, "")
		s.signalLoggedIn()
	case errors.Is(err, auth.ErrPasswordAuthNeeded) || tgerr.Is(err, "SESSION_PASSWORD_NEEDED"):
		hint := ""
		if pw, e := client.API().AccountGetPassword(ctx); e == nil {
			hint = pw.Hint
		}
		s.mu.Lock()
		s.passHint = hint
		s.mu.Unlock()
		s.setState(stWaitPass, "")
	case errors.Is(err, context.Canceled):
		s.setState(stLoggedOut, "")
	case errors.Is(err, context.DeadlineExceeded):
		s.setState(stLoggedOut, "the login timed out, start again")
	default:
		s.setState(stLoggedOut, redactErr(err))
	}
}

// LoginPhone sends a login code (it arrives inside the Telegram app).
func (s *Service) LoginPhone(phone string) (map[string]any, error) {
	if phone == "" {
		phone = s.Config().Phone
	}
	phone = normalisePhone(phone)
	if len(phone) < 8 {
		return nil, errf("TELEGRAM_BAD_REQUEST", 400, "enter the account phone number (international format)")
	}
	ctx, client, err := s.beginLogin(stWaitCode)
	if err != nil {
		return nil, err
	}
	sent, err := client.Auth().SendCode(ctx, phone, auth.SendCodeOptions{})
	if err != nil {
		s.setState(stLoggedOut, redactErr(err))
		return nil, toTgErr(err)
	}
	sc, ok := sent.(*tg.AuthSentCode)
	if !ok {
		s.setState(stConnecting, "")
		s.signalLoggedIn()
		return map[string]any{"ok": true, "loggedIn": true}, nil
	}
	typ := strings.TrimPrefix(fmt.Sprintf("%T", sc.Type), "*tg.AuthSentCodeType")
	s.mu.Lock()
	s.codeHash, s.codePhone, s.codeType = sc.PhoneCodeHash, phone, strings.ToLower(typ)
	s.mu.Unlock()
	s.hub.Emit("auth", s.authView())
	return map[string]any{"ok": true, "type": strings.ToLower(typ)}, nil
}

func (s *Service) LoginCode(code string) error {
	_, client, _, err := s.api(false)
	if err != nil {
		return err
	}
	s.mu.Lock()
	st, hash, phone := s.state, s.codeHash, s.codePhone
	s.mu.Unlock()
	if st != stWaitCode || hash == "" {
		return errf("TELEGRAM_LOGIN_STATE", 409, "no code was requested; start the login again")
	}
	code = strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, code)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err = client.Auth().SignIn(ctx, phone, code, hash)
	if err != nil && !errors.Is(err, auth.ErrPasswordAuthNeeded) {
		var su *auth.SignUpRequired
		if errors.As(err, &su) {
			s.setState(stLoggedOut, "this number has no Telegram account")
			return errf("TELEGRAM_LOGIN_STATE", 409, "this number has no Telegram account; sign-up is not supported here")
		}
		return toTgErr(err)
	}
	s.finishLogin(ctx, client, err, "code")
	return nil
}

func (s *Service) LoginPassword(pw string) error {
	_, client, _, err := s.api(false)
	if err != nil {
		return err
	}
	s.mu.Lock()
	st := s.state
	s.mu.Unlock()
	if st != stWaitPass {
		return errf("TELEGRAM_LOGIN_STATE", 409, "no password is being asked for")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	_, err = client.Auth().Password(ctx, pw)
	if err != nil {
		if errors.Is(err, auth.ErrPasswordInvalid) || tgerr.Is(err, "PASSWORD_HASH_INVALID") {
			return errf("TELEGRAM_PASSWORD_INVALID", 400, "wrong Telegram password")
		}
		return toTgErr(err)
	}
	s.finishLogin(ctx, client, nil, "password")
	return nil
}

func (s *Service) LoginCancel() {
	s.mu.Lock()
	if s.loginStop != nil {
		s.loginStop()
		s.loginStop = nil
	}
	s.codeHash, s.passHint = "", ""
	loggedIn := s.me != nil
	s.mu.Unlock()
	if !loggedIn {
		s.setState(stLoggedOut, "")
	}
}

func (s *Service) Logout() error {
	api, _, _, err := s.api(true)
	if err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		_, _ = api.AuthLogOut(ctx)
		cancel()
	}
	s.forgetSession("logged out from DSH")
	s.audit.Log(map[string]any{"action": "logout", "origin": "ui"})
	s.mu.Lock()
	r := s.restart
	s.mu.Unlock()
	if r != nil {
		r()
	}
	return nil
}

func normalisePhone(p string) string {
	var b strings.Builder
	for _, r := range p {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return "+" + b.String()
}

// ---------------------------------------------------------------- flood control

func (s *Service) floodMiddleware() telegram.Middleware {
	return telegram.MiddlewareFunc(func(next tg.Invoker) telegram.InvokeFunc {
		return func(ctx context.Context, in bin.Encoder, out bin.Decoder) error {
			for attempt := 0; ; attempt++ {
				err := next.Invoke(ctx, in, out)
				if err == nil {
					return nil
				}
				if d, ok := tgerr.AsFloodWait(err); ok {
					max := time.Duration(s.Config().FloodWaitMaxSeconds) * time.Second
					s.hub.Emit("flood", map[string]any{"seconds": int(d.Seconds()), "waiting": attempt == 0 && d <= max})
					if attempt == 0 && d <= max {
						select {
						case <-ctx.Done():
							return ctx.Err()
						case <-time.After(d + 500*time.Millisecond):
						}
						continue
					}
					e := errf("TELEGRAM_FLOOD_WAIT", 429, "Telegram asks to wait %d s before this request", int(d.Seconds()))
					e.RetryAfter = int(d.Seconds()) + 1
					return e
				}
				if tgerr.Is(err, "PEER_FLOOD") {
					s.policy.Trip(24*time.Hour, "PEER_FLOOD")
					s.audit.Log(map[string]any{"action": "safety.tripped", "why": "PEER_FLOOD"})
					s.hub.Emit("safety", map[string]any{"tripped": true, "why": "PEER_FLOOD", "hours": 24})
				}
				return err
			}
		}
	})
}

// toTgErr maps any error to a coded TgErr.
func toTgErr(err error) *TgErr {
	if err == nil {
		return nil
	}
	var te *TgErr
	if errors.As(err, &te) {
		return te
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return errf("TELEGRAM_TIMEOUT", 504, "Telegram did not answer in time")
	}
	if rpc, ok := tgerr.As(err); ok {
		code, status := "TELEGRAM_RPC", 502
		switch {
		case rpc.IsOneOf("PHONE_CODE_INVALID", "PHONE_CODE_EXPIRED", "PHONE_CODE_EMPTY"):
			code, status = "TELEGRAM_CODE_INVALID", 400
		case rpc.IsOneOf("PASSWORD_HASH_INVALID"):
			code, status = "TELEGRAM_PASSWORD_INVALID", 400
		case rpc.IsOneOf("CHAT_WRITE_FORBIDDEN", "CHAT_ADMIN_REQUIRED", "USER_IS_BLOCKED", "YOU_BLOCKED_USER", "CHAT_SEND_PLAIN_FORBIDDEN", "CHAT_SEND_MEDIA_FORBIDDEN", "CHAT_RESTRICTED", "USER_PRIVACY_RESTRICTED"):
			code, status = "TELEGRAM_CANNOT_POST", 403
		case rpc.IsOneOf("PEER_ID_INVALID", "CHANNEL_PRIVATE", "CHANNEL_INVALID", "USERNAME_NOT_OCCUPIED", "USERNAME_INVALID", "MSG_ID_INVALID", "CHAT_ID_INVALID"):
			code, status = "TELEGRAM_CHAT_NOT_FOUND", 404
		case rpc.IsOneOf("PEER_FLOOD"):
			code, status = "TELEGRAM_PEER_FLOOD", 429
		case rpc.IsOneOf("SLOWMODE_WAIT"):
			e := errf("TELEGRAM_FLOOD_WAIT", 429, "the chat is in slow mode")
			e.RetryAfter, e.TgType = rpc.Argument, rpc.Type
			return e
		case rpc.IsOneOf("AUTH_KEY_UNREGISTERED", "SESSION_REVOKED", "SESSION_EXPIRED", "USER_DEACTIVATED", "USER_DEACTIVATED_BAN"):
			code, status = "TELEGRAM_NOT_LOGGED_IN", 409
		case rpc.IsOneOf("FILE_PARTS_INVALID", "FILE_PART_TOO_BIG", "MEDIA_EMPTY", "MEDIA_INVALID", "PHOTO_INVALID_DIMENSIONS", "PHOTO_EXT_INVALID", "FILE_REFERENCE_EXPIRED"):
			code, status = "TELEGRAM_MEDIA_UNAVAILABLE", 400
		case rpc.IsOneOf("MESSAGE_TOO_LONG", "MESSAGE_EMPTY", "PHONE_NUMBER_INVALID", "PHONE_NUMBER_BANNED"):
			code, status = "TELEGRAM_BAD_REQUEST", 400
		}
		return &TgErr{Code: code, Status: status, Msg: "Telegram: " + rpc.Type, TgType: rpc.Type}
	}
	return errf("TELEGRAM_INTERNAL", 500, "%s", redactErr(err))
}

// redactErr keeps error text short and free of anything that looks like a
// token (long hex or base64 runs).
func redactErr(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	if len(msg) > 300 {
		msg = msg[:300]
	}
	return redactLong(msg)
}

func redactLong(s string) string {
	var b strings.Builder
	run := 0
	start := 0
	flush := func(end int) {
		if run >= 24 {
			b.WriteString("[redacted]")
		} else {
			b.WriteString(s[start:end])
		}
	}
	for i, r := range s {
		isTok := r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '_' || r == '-' || r == '+' || r == '/' || r == '='
		if isTok {
			if run == 0 {
				start = i
			}
			run++
			continue
		}
		if run > 0 {
			flush(i)
			run = 0
		}
		b.WriteRune(r)
	}
	if run > 0 {
		flush(len(s))
	}
	return b.String()
}

// QRPNG renders the current QR login token (the token never leaves as text).
func (s *Service) QRPNG() ([]byte, error) {
	s.mu.Lock()
	t := s.qrToken
	s.mu.Unlock()
	if t == nil {
		return nil, errf("TELEGRAM_LOGIN_STATE", 409, "no QR login in progress")
	}
	return renderQR(t.URL(), 10, 4)
}

// renderQR draws the QR code itself (rsc.io/qr's Image() draws modules at
// 1 px in the corner of a larger canvas): scale px per module and a quiet
// zone of quiet modules, black on white, grayscale PNG.
func renderQR(text string, scale, quiet int) ([]byte, error) {
	code, err := qr.Encode(text, qr.M)
	if err != nil {
		return nil, err
	}
	dim := (code.Size + 2*quiet) * scale
	img := image.NewGray(image.Rect(0, 0, dim, dim))
	for i := range img.Pix {
		img.Pix[i] = 0xff
	}
	for y := 0; y < code.Size; y++ {
		for x := 0; x < code.Size; x++ {
			if !code.Black(x, y) {
				continue
			}
			x0, y0 := (x+quiet)*scale, (y+quiet)*scale
			for yy := y0; yy < y0+scale; yy++ {
				row := img.Pix[yy*img.Stride:]
				for xx := x0; xx < x0+scale; xx++ {
					row[xx] = 0
				}
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
