package main

// Config (non-secret, config.json, 0600), sealed API credentials (api.bin),
// typed errors, the agent send policy (limits, kill switch, allowlist) and
// the audit log.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const labelCreds = "api-credentials"

type Limits struct {
	PerChatSeconds   int `json:"perChatSeconds"`
	PerHour          int `json:"perHour"`
	PerDay           int `json:"perDay"`
	UIPerChatSeconds int `json:"uiPerChatSeconds"`
}

type MediaCfg struct {
	CacheMB        int `json:"cacheMB"`
	AutoDownloadMB int `json:"autoDownloadMB"`
	UploadMB       int `json:"uploadMB"`
}

type Config struct {
	Phone               string   `json:"phone"`
	AgentSend           bool     `json:"agentSend"`
	AgentAllow          []string `json:"agentAllow"` // marked ids or @usernames agents may write to besides existing dialogs
	AgentMarkRead       bool     `json:"agentMarkRead"`
	Limits              Limits   `json:"limits"`
	FloodWaitMaxSeconds int      `json:"floodWaitMaxSeconds"`
	Media               MediaCfg `json:"media"`
	DeviceModel         string   `json:"deviceModel"`
	Calls               CallsCfg `json:"calls"`
}

// CallsCfg: what phone-hookd does with incoming Telegram calls per Phone mode, and limits.
type CallsCfg struct {
	DND           string `json:"dnd"`           // decline | ignore
	Voicemail     string `json:"voicemail"`     // decline_text | decline | ignore
	VoicemailText string `json:"voicemailText"` // sent at most once per caller every 12 hours
	LiveNoTab     string `json:"liveNoTab"`     // ignore | decline
	DailyCap      int    `json:"dailyCap"`      // outgoing calls per day
	RingSeconds   int    `json:"ringSeconds"`   // outgoing: give up after
}

func DefaultConfig() Config {
	return Config{
		Phone:               "",
		AgentSend:           true,
		AgentAllow:          []string{},
		Limits:              Limits{PerChatSeconds: 3, PerHour: 30, PerDay: 100, UIPerChatSeconds: 1},
		FloodWaitMaxSeconds: 30,
		Media:               MediaCfg{CacheMB: 2048, AutoDownloadMB: 20, UploadMB: 50},
		DeviceModel:         "DSH Phone",
		Calls:               CallsCfg{DND: "decline", Voicemail: "decline_text", VoicemailText: "Sorry, I cannot take calls right now. Please send me a message and I will get back to you.", LiveNoTab: "ignore", DailyCap: 20, RingSeconds: 45},
	}
}

func (c *Config) normalise() {
	d := DefaultConfig()
	clamp := func(v *int, lo, hi, def int) {
		if *v == 0 {
			*v = def
		}
		if *v < lo {
			*v = lo
		}
		if *v > hi {
			*v = hi
		}
	}
	clamp(&c.Limits.PerChatSeconds, 1, 3600, d.Limits.PerChatSeconds)
	clamp(&c.Limits.PerHour, 1, 600, d.Limits.PerHour)
	clamp(&c.Limits.PerDay, 1, 2000, d.Limits.PerDay)
	clamp(&c.Limits.UIPerChatSeconds, 1, 60, d.Limits.UIPerChatSeconds)
	clamp(&c.FloodWaitMaxSeconds, 1, 300, d.FloodWaitMaxSeconds)
	clamp(&c.Media.CacheMB, 64, 65536, d.Media.CacheMB)
	clamp(&c.Media.AutoDownloadMB, 1, 2000, d.Media.AutoDownloadMB)
	clamp(&c.Media.UploadMB, 1, 2000, d.Media.UploadMB)
	clamp(&c.Calls.DailyCap, 1, 200, d.Calls.DailyCap)
	clamp(&c.Calls.RingSeconds, 10, 120, d.Calls.RingSeconds)
	oneOf := func(v *string, def string, ok ...string) {
		for _, o := range ok {
			if *v == o {
				return
			}
		}
		*v = def
	}
	oneOf(&c.Calls.DND, d.Calls.DND, "decline", "ignore")
	oneOf(&c.Calls.Voicemail, d.Calls.Voicemail, "decline_text", "decline", "ignore")
	oneOf(&c.Calls.LiveNoTab, d.Calls.LiveNoTab, "ignore", "decline")
	if len(c.Calls.VoicemailText) > 500 {
		c.Calls.VoicemailText = c.Calls.VoicemailText[:500]
	}
	if c.Calls.VoicemailText == "" {
		c.Calls.VoicemailText = d.Calls.VoicemailText
	}
	if c.AgentAllow == nil {
		c.AgentAllow = []string{}
	}
	if strings.TrimSpace(c.DeviceModel) == "" {
		c.DeviceModel = d.DeviceModel
	}
}

func LoadConfig(path string) (Config, error) {
	c := DefaultConfig()
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return DefaultConfig(), fmt.Errorf("config %s: %w", path, err)
	}
	c.normalise()
	return c, nil
}

func SaveConfig(path string, c Config) error {
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(b, '\n'))
}

type Creds struct {
	APIID   int    `json:"apiId"`
	APIHash string `json:"apiHash"`
}

func (c Creds) Valid() bool { return c.APIID > 0 && len(c.APIHash) == 32 && isHex(c.APIHash) }

func isHex(s string) bool {
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F') {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------- errors

// TgErr is an error with a stable code (TELEGRAM_*), returned to hookd as
// {ok:false, code, error, retryAfter?}.
type TgErr struct {
	Code       string
	Msg        string
	Status     int
	RetryAfter int
	TgType     string
}

func (e *TgErr) Error() string { return e.Code + ": " + e.Msg }

func errf(code string, status int, format string, a ...any) *TgErr {
	return &TgErr{Code: code, Status: status, Msg: fmt.Sprintf(format, a...)}
}

// ---------------------------------------------------------------- policy

type Policy struct {
	mu        sync.Mutex
	cfg       func() Config
	offFlag   string
	tripPath  string
	trippedTo time.Time
	tripWhy   string
	agentLog  []time.Time          // agent sends in the last 24 h
	lastChat  map[string]time.Time // origin|chat -> last send
	now       func() time.Time
}

func NewPolicy(cfg func() Config, offFlag, tripPath string) *Policy {
	p := &Policy{cfg: cfg, offFlag: offFlag, tripPath: tripPath, lastChat: map[string]time.Time{}, now: time.Now}
	if b, err := os.ReadFile(tripPath); err == nil {
		var t struct {
			Until int64  `json:"until"`
			Why   string `json:"why"`
		}
		if json.Unmarshal(b, &t) == nil && t.Until > 0 {
			p.trippedTo, p.tripWhy = time.Unix(t.Until, 0), t.Why
		}
	}
	return p
}

// AgentState describes the agent send switch for /status.
func (p *Policy) AgentState() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.cfg()
	_, flag := os.Stat(p.offFlag)
	st := map[string]any{"enabled": c.AgentSend, "flagFile": flag == nil, "limits": c.Limits}
	now := p.now()
	if now.Before(p.trippedTo) {
		st["tripped"] = map[string]any{"until": p.trippedTo.Unix(), "why": p.tripWhy}
	}
	h, d := p.countsLocked(now)
	st["sentLastHour"], st["sentLastDay"] = h, d
	return st
}

func (p *Policy) countsLocked(now time.Time) (hour, day int) {
	keep := p.agentLog[:0]
	for _, t := range p.agentLog {
		if now.Sub(t) < 24*time.Hour {
			keep = append(keep, t)
			day++
			if now.Sub(t) < time.Hour {
				hour++
			}
		}
	}
	p.agentLog = keep
	return
}

// Allowed reports whether an agent may write to peer (existing dialog or allowlist).
func (p *Policy) allowListed(peer Peer) bool {
	for _, a := range p.cfg().AgentAllow {
		a = strings.TrimSpace(a)
		if a == "" {
			continue
		}
		if n, err := strconv.ParseInt(a, 10, 64); err == nil && n == peer.ID {
			return true
		}
		if peer.Username != "" && strings.EqualFold(strings.TrimPrefix(a, "@"), peer.Username) {
			return true
		}
	}
	return false
}

// Check decides whether a send from origin to peer may go now. It does not
// record the send: call Record after Telegram accepted it.
func (p *Policy) Check(origin string, peer Peer, isDialog bool) *TgErr {
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.cfg()
	now := p.now()
	key := origin + "|" + strconv.FormatInt(peer.ID, 10)
	if origin == "agent" {
		if !c.AgentSend {
			return errf("TELEGRAM_AGENT_SEND_OFF", 403, "agent sending is switched off in Settings > Phone > Telegram")
		}
		if _, err := os.Stat(p.offFlag); err == nil {
			return errf("TELEGRAM_AGENT_SEND_OFF", 403, "agent sending is switched off by the kill switch file %s", filepath.Base(p.offFlag))
		}
		if now.Before(p.trippedTo) {
			e := errf("TELEGRAM_AGENT_SEND_OFF", 403, "agent sending is paused until %s after a Telegram spam warning (%s)", p.trippedTo.UTC().Format(time.RFC3339), p.tripWhy)
			e.RetryAfter = int(p.trippedTo.Sub(now).Seconds())
			return e
		}
		if !isDialog && !p.allowListed(peer) {
			return errf("TELEGRAM_CHAT_NOT_ALLOWED", 403, "agents may only write to existing conversations or chats on the allowlist; %s is neither", peer.Title)
		}
		if last, ok := p.lastChat[key]; ok && now.Sub(last) < time.Duration(c.Limits.PerChatSeconds)*time.Second {
			e := errf("TELEGRAM_RATE_LIMITED", 429, "at most one agent message every %d s per chat", c.Limits.PerChatSeconds)
			e.RetryAfter = c.Limits.PerChatSeconds - int(now.Sub(last).Seconds())
			return e
		}
		h, d := p.countsLocked(now)
		if h >= c.Limits.PerHour {
			e := errf("TELEGRAM_RATE_LIMITED", 429, "agent hourly limit reached (%d per hour)", c.Limits.PerHour)
			e.RetryAfter = 3600
			if len(p.agentLog) > 0 {
				for _, t := range p.agentLog {
					if now.Sub(t) < time.Hour {
						e.RetryAfter = int(time.Hour.Seconds() - now.Sub(t).Seconds())
						break
					}
				}
			}
			return e
		}
		if d >= c.Limits.PerDay {
			e := errf("TELEGRAM_RATE_LIMITED", 429, "agent daily limit reached (%d per day)", c.Limits.PerDay)
			e.RetryAfter = 3600
			return e
		}
		return nil
	}
	if last, ok := p.lastChat[key]; ok && now.Sub(last) < time.Duration(c.Limits.UIPerChatSeconds)*time.Second {
		e := errf("TELEGRAM_RATE_LIMITED", 429, "one message per %d s per chat", c.Limits.UIPerChatSeconds)
		e.RetryAfter = 1
		return e
	}
	return nil
}

func (p *Policy) Record(origin string, peer Peer) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	p.lastChat[origin+"|"+strconv.FormatInt(peer.ID, 10)] = now
	if origin == "agent" {
		p.agentLog = append(p.agentLog, now)
	}
}

// Trip pauses agent sending for d (PEER_FLOOD and similar spam signals).
func (p *Policy) Trip(d time.Duration, why string) {
	p.mu.Lock()
	p.trippedTo, p.tripWhy = p.now().Add(d), why
	b, _ := json.Marshal(map[string]any{"until": p.trippedTo.Unix(), "why": why})
	p.mu.Unlock()
	_ = writeFileAtomic(p.tripPath, b)
}

func (p *Policy) Untrip() {
	p.mu.Lock()
	p.trippedTo, p.tripWhy = time.Time{}, ""
	p.mu.Unlock()
	_ = os.Remove(p.tripPath)
}

// ---------------------------------------------------------------- audit

type Audit struct {
	mu   sync.Mutex
	path string
	max  int64
}

func NewAudit(path string) *Audit { return &Audit{path: path, max: 5 << 20} }

// Log appends one JSON line. Message text is never logged, only its size.
func (a *Audit) Log(entry map[string]any) {
	a.mu.Lock()
	defer a.mu.Unlock()
	entry["ts"] = time.Now().UTC().Format(time.RFC3339)
	b, err := json.Marshal(entry)
	if err != nil {
		return
	}
	if st, err := os.Stat(a.path); err == nil && st.Size() > a.max {
		_ = os.Rename(a.path, a.path+".1")
	}
	f, err := os.OpenFile(a.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(b, '\n'))
}

// Tail returns the last n audit lines (parsed).
func (a *Audit) Tail(n int) []json.RawMessage {
	a.mu.Lock()
	defer a.mu.Unlock()
	b, err := os.ReadFile(a.path)
	if err != nil {
		return []json.RawMessage{}
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	out := make([]json.RawMessage, 0, len(lines))
	for _, l := range lines {
		if json.Valid([]byte(l)) {
			out = append(out, json.RawMessage(l))
		}
	}
	return out
}
