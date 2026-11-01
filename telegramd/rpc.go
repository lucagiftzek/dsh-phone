package main

// RPC: HTTP/JSON over the private unix socket. Only phone-hookd talks to it
// (the socket is 0600 in a 0700 directory). Every answer is {ok:true,...}
// or {ok:false, code, error, retryAfter?}. Nothing secret is ever returned:
// no api_hash, no session, no password.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const version = "0.1.0"

func jsonMarshal(v any) ([]byte, error)   { return json.Marshal(v) }
func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	te := toTgErr(err)
	body := map[string]any{"ok": false, "code": te.Code, "error": te.Msg}
	if te.RetryAfter > 0 {
		body["retryAfter"] = te.RetryAfter
	}
	if te.TgType != "" {
		body["telegram"] = te.TgType
	}
	st := te.Status
	if st == 0 {
		st = 500
	}
	writeJSON(w, st, body)
}

func readJSON(r *http.Request, v any) error {
	b, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return err
	}
	if len(b) == 0 {
		return nil
	}
	if err := json.Unmarshal(b, v); err != nil {
		return errf("TELEGRAM_BAD_REQUEST", 400, "bad JSON body")
	}
	return nil
}

func qInt(r *http.Request, k string, d int) int {
	if v, err := strconv.Atoi(r.URL.Query().Get(k)); err == nil {
		return v
	}
	return d
}

func qInt64(r *http.Request, k string) int64 {
	v, _ := strconv.ParseInt(r.URL.Query().Get(k), 10, 64)
	return v
}

func qBool(r *http.Request, k string) bool {
	v := r.URL.Query().Get(k)
	return v == "1" || v == "true"
}

func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	ok := func(w http.ResponseWriter, extra map[string]any) {
		out := map[string]any{"ok": true}
		for k, v := range extra {
			out[k] = v
		}
		writeJSON(w, 200, out)
	}
	ctxOf := func(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
		return context.WithTimeout(r.Context(), d)
	}

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		ok(w, map[string]any{"version": version})
	})
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, s.Status())
	})
	mux.HandleFunc("POST /creds", func(w http.ResponseWriter, r *http.Request) {
		var c struct {
			APIID   json.RawMessage `json:"apiId"`
			APIHash string          `json:"apiHash"`
		}
		if err := readJSON(r, &c); err != nil {
			writeErr(w, err)
			return
		}
		id, _ := strconv.Atoi(strings.Trim(strings.TrimSpace(string(c.APIID)), `"`))
		if err := s.SetCreds(Creds{APIID: id, APIHash: c.APIHash}); err != nil {
			writeErr(w, err)
			return
		}
		ok(w, map[string]any{"credentials": true})
	})
	mux.HandleFunc("GET /config", func(w http.ResponseWriter, r *http.Request) {
		ok(w, map[string]any{"config": s.Config(), "defaults": DefaultConfig()})
	})
	mux.HandleFunc("POST /config", func(w http.ResponseWriter, r *http.Request) {
		// Merge: decode onto the current config, so a partial body changes only its fields.
		c := s.Config()
		if err := readJSON(r, &c); err != nil {
			writeErr(w, err)
			return
		}
		if err := s.SetConfig(c); err != nil {
			writeErr(w, err)
			return
		}
		s.audit.Log(map[string]any{"action": "config.set", "agentSend": c.AgentSend})
		ok(w, map[string]any{"config": s.Config()})
	})

	// -- login
	mux.HandleFunc("POST /login/qr", func(w http.ResponseWriter, r *http.Request) {
		if err := s.LoginQR(); err != nil {
			writeErr(w, err)
			return
		}
		ok(w, map[string]any{"auth": s.authView()})
	})
	mux.HandleFunc("GET /login/qr.png", func(w http.ResponseWriter, r *http.Request) {
		b, err := s.QRPNG()
		if err != nil {
			writeErr(w, err)
			return
		}
		w.Header().Set("content-type", "image/png")
		w.Header().Set("cache-control", "no-store")
		w.Header().Set("x-content-type-options", "nosniff")
		_, _ = w.Write(b)
	})
	mux.HandleFunc("POST /login/phone", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Phone string `json:"phone"`
		}
		if err := readJSON(r, &b); err != nil {
			writeErr(w, err)
			return
		}
		out, err := s.LoginPhone(b.Phone)
		if err != nil {
			writeErr(w, err)
			return
		}
		out["auth"] = s.authView()
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("POST /login/code", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Code string `json:"code"`
		}
		if err := readJSON(r, &b); err != nil {
			writeErr(w, err)
			return
		}
		if err := s.LoginCode(b.Code); err != nil {
			writeErr(w, err)
			return
		}
		ok(w, map[string]any{"auth": s.authView()})
	})
	mux.HandleFunc("POST /login/password", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Password string `json:"password"`
		}
		if err := readJSON(r, &b); err != nil {
			writeErr(w, err)
			return
		}
		err := s.LoginPassword(b.Password)
		b.Password = ""
		if err != nil {
			writeErr(w, err)
			return
		}
		ok(w, map[string]any{"auth": s.authView()})
	})
	mux.HandleFunc("POST /login/cancel", func(w http.ResponseWriter, r *http.Request) {
		s.LoginCancel()
		ok(w, map[string]any{"auth": s.authView()})
	})
	mux.HandleFunc("POST /logout", func(w http.ResponseWriter, r *http.Request) {
		_ = s.Logout()
		ok(w, map[string]any{"auth": s.authView()})
	})

	// -- data
	mux.HandleFunc("GET /dialogs", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := ctxOf(r, 90*time.Second)
		defer cancel()
		ds, err := s.Dialogs(ctx, qInt(r, "limit", 200), qBool(r, "archived"))
		if err != nil {
			writeErr(w, err)
			return
		}
		ok(w, map[string]any{"dialogs": ds})
	})
	mux.HandleFunc("GET /history", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := ctxOf(r, 60*time.Second)
		defer cancel()
		ms, err := s.History(ctx, qInt64(r, "chat"), qInt(r, "before", 0), qInt(r, "limit", 50))
		if err != nil {
			writeErr(w, err)
			return
		}
		ok(w, map[string]any{"chat": s.chatViewByID(qInt64(r, "chat")), "messages": ms})
	})
	mux.HandleFunc("GET /peer", func(w http.ResponseWriter, r *http.Request) {
		var p Peer
		var found bool
		if u := r.URL.Query().Get("username"); u != "" {
			p, found = s.store.PeerByUsername(u)
		} else {
			p, found = s.store.PeerByID(qInt64(r, "chat"))
		}
		if !found {
			writeErr(w, errf("TELEGRAM_CHAT_NOT_FOUND", 404, "not in the local cache"))
			return
		}
		ok(w, map[string]any{"chat": ChatView(p), "dialog": s.store.IsDialog(p.ID)})
	})
	mux.HandleFunc("POST /resolve", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Username string `json:"username"`
			Origin   string `json:"origin"`
		}
		if err := readJSON(r, &b); err != nil {
			writeErr(w, err)
			return
		}
		if b.Origin != "ui" {
			writeErr(w, errf("TELEGRAM_CHAT_NOT_ALLOWED", 403, "only the owner can look up new usernames (Phone tab)"))
			return
		}
		ctx, cancel := ctxOf(r, 30*time.Second)
		defer cancel()
		p, err := s.Resolve(ctx, b.Username)
		if err != nil {
			writeErr(w, err)
			return
		}
		ok(w, map[string]any{"chat": ChatView(p), "dialog": s.store.IsDialog(p.ID)})
	})
	mux.HandleFunc("POST /send", func(w http.ResponseWriter, r *http.Request) {
		var b SendReq
		if err := readJSON(r, &b); err != nil {
			writeErr(w, err)
			return
		}
		ctx, cancel := ctxOf(r, 2*time.Minute)
		defer cancel()
		m, err := s.Send(ctx, b)
		if err != nil {
			writeErr(w, err)
			return
		}
		ok(w, map[string]any{"message": m})
	})
	mux.HandleFunc("POST /send_media", func(w http.ResponseWriter, r *http.Request) {
		var b SendReq
		if err := readJSON(r, &b); err != nil {
			writeErr(w, err)
			return
		}
		ctx, cancel := ctxOf(r, 15*time.Minute)
		defer cancel()
		m, err := s.SendMedia(ctx, b)
		if err != nil {
			writeErr(w, err)
			return
		}
		ok(w, map[string]any{"message": m})
	})
	mux.HandleFunc("POST /read", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Chat   int64  `json:"chat"`
			MaxID  int    `json:"maxId"`
			Origin string `json:"origin"`
		}
		if err := readJSON(r, &b); err != nil {
			writeErr(w, err)
			return
		}
		ctx, cancel := ctxOf(r, 30*time.Second)
		defer cancel()
		marked, err := s.Read(ctx, b.Chat, b.MaxID, b.Origin)
		if err != nil {
			writeErr(w, err)
			return
		}
		ok(w, map[string]any{"marked": marked})
	})
	mux.HandleFunc("GET /media", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := ctxOf(r, 16*time.Minute)
		defer cancel()
		f, err := s.Media(ctx, qInt64(r, "chat"), qInt(r, "msg", 0), qBool(r, "thumb"), qBool(r, "force"))
		if err != nil {
			writeErr(w, err)
			return
		}
		if qBool(r, "info") {
			ok(w, map[string]any{"file": f})
			return
		}
		fh, err := openRegular(f.Path)
		if err != nil {
			writeErr(w, errf("TELEGRAM_MEDIA_UNAVAILABLE", 404, "cached file vanished"))
			return
		}
		defer fh.Close()
		w.Header().Set("content-type", f.Mime)
		w.Header().Set("x-content-type-options", "nosniff")
		w.Header().Set("cache-control", "private, max-age=86400")
		w.Header().Set("x-file-name", strconv.Quote(f.Name))
		http.ServeContent(w, r, "", time.Time{}, fh)
	})
	mux.HandleFunc("POST /media/clear", func(w http.ResponseWriter, r *http.Request) {
		ok(w, map[string]any{"removed": s.media.Clear()})
	})
	mux.HandleFunc("GET /audit", func(w http.ResponseWriter, r *http.Request) {
		ok(w, map[string]any{"entries": s.audit.Tail(min(max(qInt(r, "n", 50), 1), 500))})
	})
	mux.HandleFunc("POST /agent/untrip", func(w http.ResponseWriter, r *http.Request) {
		s.policy.Untrip()
		s.audit.Log(map[string]any{"action": "safety.untrip", "origin": "ui"})
		ok(w, map[string]any{"agent": s.policy.AgentState()})
	})
	mux.HandleFunc("GET /events", func(w http.ResponseWriter, r *http.Request) {
		fl, isFl := w.(http.Flusher)
		if !isFl {
			writeErr(w, errors.New("streaming unsupported"))
			return
		}
		backlog, gap, ch := s.hub.Subscribe(qInt64(r, "since"))
		defer s.hub.Unsubscribe(ch)
		w.Header().Set("content-type", "application/x-ndjson")
		w.Header().Set("cache-control", "no-store")
		w.WriteHeader(200)
		hello := Event{Type: "hello", At: time.Now().UnixMilli(), Data: map[string]any{"version": version, "gap": gap, "seq": s.hub.Seq(), "auth": s.authView()}}
		_, _ = w.Write(encodeEvent(hello))
		for _, ev := range backlog {
			_, _ = w.Write(encodeEvent(ev))
		}
		fl.Flush()
		ping := time.NewTicker(20 * time.Second)
		defer ping.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case ev, open := <-ch:
				if !open {
					return
				}
				if _, err := w.Write(encodeEvent(ev)); err != nil {
					return
				}
				fl.Flush()
			case <-ping.C:
				if _, err := w.Write(encodeEvent(Event{Type: "ping", At: time.Now().UnixMilli()})); err != nil {
					return
				}
				fl.Flush()
			}
		}
	})
	s.registerCallRoutes(mux)
	return mux
}
