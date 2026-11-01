package main

// Operations: updates to events, dialogs, history, send (text and media),
// read marks, username resolution and media downloads.

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gotd/td/telegram/downloader"
	"github.com/gotd/td/telegram/uploader"
	"github.com/gotd/td/tg"
)

func randInt64() int64 {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return int64(binary.LittleEndian.Uint64(b[:]) &^ (1 << 63))
}

func ChatView(p Peer) map[string]any {
	v := map[string]any{"id": p.ID, "kind": p.Kind, "title": p.Title}
	if p.Username != "" {
		v["username"] = p.Username
	}
	for k, b := range map[string]bool{"broadcast": p.Broadcast, "megagroup": p.Megagroup, "canPost": p.CanPost, "creator": p.Creator, "bot": p.Bot, "self": p.Self, "verified": p.Verified, "scam": p.Scam, "left": p.Left, "deleted": p.Deleted} {
		if b {
			v[k] = true
		}
	}
	return v
}

func (s *Service) chatViewByID(id int64) map[string]any {
	if p, ok := s.store.PeerByID(id); ok {
		return ChatView(p)
	}
	kind, _ := SplitMarked(id)
	return map[string]any{"id": id, "kind": kind, "title": fmt.Sprintf("Chat %d", id)}
}

// ---------------------------------------------------------------- updates

func (s *Service) registerHandlers(d tg.UpdateDispatcher) {
	newMsg := func(e tg.Entities, mc tg.MessageClass, typ string) {
		s.store.AbsorbEntities(e)
		m, ok := s.store.ConvertMessage(mc)
		if !ok || m.Chat == 0 {
			return
		}
		if typ == "message" {
			s.store.MarkDialog(m.Chat, m.Date)
		}
		s.hub.Emit(typ, map[string]any{"message": m, "chat": s.chatViewByID(m.Chat)})
	}
	d.OnNewMessage(func(ctx context.Context, e tg.Entities, u *tg.UpdateNewMessage) error {
		newMsg(e, u.Message, "message")
		return nil
	})
	d.OnNewChannelMessage(func(ctx context.Context, e tg.Entities, u *tg.UpdateNewChannelMessage) error {
		newMsg(e, u.Message, "message")
		return nil
	})
	d.OnEditMessage(func(ctx context.Context, e tg.Entities, u *tg.UpdateEditMessage) error {
		newMsg(e, u.Message, "message.edit")
		return nil
	})
	d.OnEditChannelMessage(func(ctx context.Context, e tg.Entities, u *tg.UpdateEditChannelMessage) error {
		newMsg(e, u.Message, "message.edit")
		return nil
	})
	d.OnDeleteMessages(func(ctx context.Context, e tg.Entities, u *tg.UpdateDeleteMessages) error {
		// Private chats and basic groups: Telegram does not say which chat.
		s.hub.Emit("message.delete", map[string]any{"chat": 0, "ids": u.Messages})
		return nil
	})
	d.OnDeleteChannelMessages(func(ctx context.Context, e tg.Entities, u *tg.UpdateDeleteChannelMessages) error {
		s.hub.Emit("message.delete", map[string]any{"chat": channelMarked(u.ChannelID), "ids": u.Messages})
		return nil
	})
	d.OnReadHistoryInbox(func(ctx context.Context, e tg.Entities, u *tg.UpdateReadHistoryInbox) error {
		s.hub.Emit("read", map[string]any{"chat": markedOf(u.Peer), "box": "in", "maxId": u.MaxID, "unread": u.StillUnreadCount})
		return nil
	})
	d.OnReadHistoryOutbox(func(ctx context.Context, e tg.Entities, u *tg.UpdateReadHistoryOutbox) error {
		s.hub.Emit("read", map[string]any{"chat": markedOf(u.Peer), "box": "out", "maxId": u.MaxID})
		return nil
	})
	d.OnReadChannelInbox(func(ctx context.Context, e tg.Entities, u *tg.UpdateReadChannelInbox) error {
		s.hub.Emit("read", map[string]any{"chat": channelMarked(u.ChannelID), "box": "in", "maxId": u.MaxID, "unread": u.StillUnreadCount})
		return nil
	})
	d.OnReadChannelOutbox(func(ctx context.Context, e tg.Entities, u *tg.UpdateReadChannelOutbox) error {
		s.hub.Emit("read", map[string]any{"chat": channelMarked(u.ChannelID), "box": "out", "maxId": u.MaxID})
		return nil
	})
	s.registerCallHandlers(d)
}

// ---------------------------------------------------------------- dialogs and history

type DialogOut struct {
	Chat     map[string]any `json:"chat"`
	Top      *Msg           `json:"top,omitempty"`
	Unread   int            `json:"unread"`
	Mentions int            `json:"mentions,omitempty"`
	ReadIn   int            `json:"readIn"`
	ReadOut  int            `json:"readOut"`
	Pinned   bool           `json:"pinned,omitempty"`
	Muted    bool           `json:"muted,omitempty"`
	Marked   bool           `json:"markedUnread,omitempty"`
	Archived bool           `json:"archived,omitempty"`
}

func (s *Service) Dialogs(ctx context.Context, limit int, archived bool) ([]DialogOut, error) {
	api, _, _, err := s.api(true)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	out := []DialogOut{}
	var offDate, offID int
	var offPeer tg.InputPeerClass = &tg.InputPeerEmpty{}
	now := int(time.Now().Unix())
	for len(out) < limit {
		req := &tg.MessagesGetDialogsRequest{OffsetDate: offDate, OffsetID: offID, OffsetPeer: offPeer, Limit: min(100, limit-len(out))}
		if archived {
			req.SetFolderID(1)
		}
		res, err := api.MessagesGetDialogs(ctx, req)
		if err != nil {
			return nil, toTgErr(err)
		}
		md, ok := res.AsModified()
		if !ok {
			break
		}
		s.store.AbsorbUsers(md.GetUsers())
		s.store.AbsorbChats(md.GetChats())
		msgs := map[string]Msg{}
		dates := map[string]int{}
		for _, mc := range md.GetMessages() {
			if m, ok := s.store.ConvertMessage(mc); ok {
				k := strconv.FormatInt(m.Chat, 10) + ":" + strconv.Itoa(m.ID)
				msgs[k], dates[k] = m, int(m.Date)
			}
		}
		page := md.GetDialogs()
		if len(page) == 0 {
			break
		}
		var last *tg.Dialog
		for _, dc := range page {
			dl, ok := dc.(*tg.Dialog)
			if !ok {
				continue
			}
			last = dl
			id := markedOf(dl.Peer)
			k := strconv.FormatInt(id, 10) + ":" + strconv.Itoa(dl.TopMessage)
			o := DialogOut{Chat: s.chatViewByID(id), Unread: dl.UnreadCount, Mentions: dl.UnreadMentionsCount, ReadIn: dl.ReadInboxMaxID, ReadOut: dl.ReadOutboxMaxID, Pinned: dl.Pinned, Marked: dl.UnreadMark, Archived: archived}
			if mu, ok := dl.NotifySettings.GetMuteUntil(); ok && mu > now {
				o.Muted = true
			}
			at := int64(0)
			if m, ok := msgs[k]; ok {
				mm := m
				o.Top, at = &mm, m.Date
			}
			s.store.MarkDialog(id, at)
			out = append(out, o)
		}
		if len(page) < req.Limit || last == nil {
			break
		}
		lk := strconv.FormatInt(markedOf(last.Peer), 10) + ":" + strconv.Itoa(last.TopMessage)
		offID, offDate = last.TopMessage, dates[lk]
		if p, ok := s.store.PeerByID(markedOf(last.Peer)); ok {
			if ip, err := InputPeer(p); err == nil {
				offPeer = ip
			}
		}
	}
	return out, nil
}

func (s *Service) peer(chat int64) (Peer, tg.InputPeerClass, error) {
	p, ok := s.store.PeerByID(chat)
	if !ok {
		return Peer{}, nil, errf("TELEGRAM_CHAT_NOT_FOUND", 404, "chat %d is not known; list chats first", chat)
	}
	ip, err := InputPeer(p)
	if err != nil {
		return p, nil, errf("TELEGRAM_CHAT_NOT_FOUND", 404, "%s", err.Error())
	}
	return p, ip, nil
}

func (s *Service) History(ctx context.Context, chat int64, before, limit int) ([]Msg, error) {
	api, _, _, err := s.api(true)
	if err != nil {
		return nil, err
	}
	_, ip, err := s.peer(chat)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	res, err := api.MessagesGetHistory(ctx, &tg.MessagesGetHistoryRequest{Peer: ip, OffsetID: before, Limit: limit})
	if err != nil {
		return nil, toTgErr(err)
	}
	md, ok := res.AsModified()
	if !ok {
		return []Msg{}, nil
	}
	s.store.AbsorbUsers(md.GetUsers())
	s.store.AbsorbChats(md.GetChats())
	out := []Msg{}
	for _, mc := range md.GetMessages() {
		if m, ok := s.store.ConvertMessage(mc); ok {
			out = append(out, m)
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- sending

type SendReq struct {
	Chat        int64  `json:"chat"`
	Text        string `json:"text"`
	ReplyTo     int    `json:"replyTo"`
	Silent      bool   `json:"silent"`
	Origin      string `json:"origin"` // ui | agent
	ChannelPost bool   `json:"channelPost"`
	Session     string `json:"session"`
	// media
	Path     string  `json:"path"`
	Kind     string  `json:"kind"`
	Name     string  `json:"name"`
	Mime     string  `json:"mime"`
	Duration float64 `json:"duration"`
}

func (r *SendReq) origin() string {
	if r.Origin == "ui" {
		return "ui"
	}
	return "agent"
}

func (s *Service) preSend(r *SendReq) (Peer, tg.InputPeerClass, error) {
	p, ip, err := s.peer(r.Chat)
	if err != nil {
		return p, nil, err
	}
	if r.ChannelPost && !(p.Kind == "channel" && p.Broadcast) {
		return p, nil, errf("TELEGRAM_CANNOT_POST", 403, "%s is not a channel", p.Title)
	}
	if p.Kind == "channel" && p.Broadcast && !p.CanPost {
		return p, nil, errf("TELEGRAM_CANNOT_POST", 403, "the account cannot post in the channel %s", p.Title)
	}
	if p.Left {
		return p, nil, errf("TELEGRAM_CANNOT_POST", 403, "the account is not a member of %s", p.Title)
	}
	if te := s.policy.Check(r.origin(), p, s.store.IsDialog(p.ID)); te != nil {
		s.audit.Log(map[string]any{"action": "send.refused", "origin": r.origin(), "session": r.Session, "chat": p.ID, "code": te.Code})
		return p, nil, te
	}
	return p, ip, nil
}

func (s *Service) Send(ctx context.Context, r SendReq) (Msg, error) {
	api, _, mgr, err := s.api(true)
	if err != nil {
		return Msg{}, err
	}
	text := strings.TrimSpace(r.Text)
	if text == "" {
		return Msg{}, errf("TELEGRAM_BAD_REQUEST", 400, "empty message")
	}
	if utf8.RuneCountInString(text) > 4096 {
		return Msg{}, errf("TELEGRAM_BAD_REQUEST", 400, "a Telegram message holds at most 4096 characters; split it")
	}
	p, ip, err := s.preSend(&r)
	if err != nil {
		return Msg{}, err
	}
	req := &tg.MessagesSendMessageRequest{Peer: ip, Message: text, RandomID: randInt64(), Silent: r.Silent}
	if r.ReplyTo > 0 {
		req.SetReplyTo(&tg.InputReplyToMessage{ReplyToMsgID: r.ReplyTo})
	}
	upd, err := api.MessagesSendMessage(ctx, req)
	if err != nil {
		te := toTgErr(err)
		s.audit.Log(map[string]any{"action": "send.failed", "origin": r.origin(), "session": r.Session, "chat": p.ID, "code": te.Code, "tg": te.TgType})
		return Msg{}, te
	}
	return s.afterSend(ctx, mgr, upd, p, r, text, "send"), nil
}

func (s *Service) afterSend(ctx context.Context, mgr updatesHandler, upd tg.UpdatesClass, p Peer, r SendReq, text, action string) Msg {
	s.policy.Record(r.origin(), p)
	m := s.extractSent(upd, p, text)
	s.store.MarkDialog(p.ID, time.Now().Unix())
	entry := map[string]any{"action": action, "origin": r.origin(), "session": r.Session, "chat": p.ID, "chars": utf8.RuneCountInString(text), "msg": m.ID}
	if r.Kind != "" {
		entry["kind"] = r.Kind
	}
	s.audit.Log(entry)
	if mgr != nil {
		_ = mgr.Handle(ctx, upd)
	}
	s.hub.Emit("message", map[string]any{"message": m, "chat": ChatView(p), "origin": r.origin()})
	return m
}

type updatesHandler interface {
	Handle(ctx context.Context, u tg.UpdatesClass) error
}

func (s *Service) extractSent(upd tg.UpdatesClass, p Peer, text string) Msg {
	pick := func(users []tg.UserClass, chats []tg.ChatClass, list []tg.UpdateClass) (Msg, bool) {
		s.store.AbsorbUsers(users)
		s.store.AbsorbChats(chats)
		for _, x := range list {
			var mc tg.MessageClass
			switch v := x.(type) {
			case *tg.UpdateNewMessage:
				mc = v.Message
			case *tg.UpdateNewChannelMessage:
				mc = v.Message
			}
			if mc != nil {
				if m, ok := s.store.ConvertMessage(mc); ok {
					return m, true
				}
			}
		}
		return Msg{}, false
	}
	switch u := upd.(type) {
	case *tg.UpdateShortSentMessage:
		m := Msg{Chat: p.ID, ID: u.ID, Date: int64(u.Date), Out: true, Text: text}
		s.mu.Lock()
		if s.me != nil {
			m.From, m.FromName = s.me.ID, s.me.Title
		}
		s.mu.Unlock()
		if u.Media != nil {
			m.Media = ConvertMedia(u.Media)
		}
		return m
	case *tg.Updates:
		if m, ok := pick(u.Users, u.Chats, u.Updates); ok {
			return m
		}
	case *tg.UpdatesCombined:
		if m, ok := pick(u.Users, u.Chats, u.Updates); ok {
			return m
		}
	}
	return Msg{Chat: p.ID, Out: true, Text: text, Date: time.Now().Unix()}
}

// inSpool checks that path is a regular file directly inside the spool dir.
func (s *Service) inSpool(path string) (string, error) {
	abs := filepath.Clean(path)
	rel, err := filepath.Rel(s.P.Spool, abs)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") || strings.ContainsRune(rel, filepath.Separator) {
		return "", errf("TELEGRAM_BAD_REQUEST", 400, "uploads must come from the telegramd spool directory")
	}
	st, err := os.Lstat(abs)
	if err != nil || !st.Mode().IsRegular() {
		return "", errf("TELEGRAM_BAD_REQUEST", 400, "upload file missing")
	}
	return abs, nil
}

func (s *Service) SendMedia(ctx context.Context, r SendReq) (Msg, error) {
	path, err := s.inSpool(r.Path)
	if err != nil {
		return Msg{}, err
	}
	defer os.Remove(path)
	api, _, mgr, err := s.api(true)
	if err != nil {
		return Msg{}, err
	}
	st, _ := os.Stat(path)
	if lim := int64(s.Config().Media.UploadMB) << 20; st.Size() > lim {
		return Msg{}, errf("TELEGRAM_MEDIA_TOO_LARGE", 413, "file is %d MB, the upload limit is %d MB", st.Size()>>20, lim>>20)
	}
	caption := strings.TrimSpace(r.Text)
	if utf8.RuneCountInString(caption) > 1024 {
		return Msg{}, errf("TELEGRAM_BAD_REQUEST", 400, "a caption holds at most 1024 characters")
	}
	p, ip, err := s.preSend(&r)
	if err != nil {
		return Msg{}, err
	}
	kind := mediaKind(r.Kind, r.Mime)
	r.Kind = kind
	name := filepath.Base(strings.TrimSpace(r.Name))
	if name == "" || name == "." || name == "/" {
		name = "file"
	}
	if kind == "voice" {
		ogg, dur, err := toVoiceOgg(ctx, path)
		if err != nil {
			return Msg{}, errf("TELEGRAM_MEDIA_UNAVAILABLE", 400, "cannot convert the voice note: %s", redactErr(err))
		}
		defer os.Remove(ogg)
		path = ogg
		if r.Duration <= 0 {
			r.Duration = dur
		}
	}
	upCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	f, err := uploader.NewUploader(api).FromPath(upCtx, path)
	if err != nil {
		return Msg{}, toTgErr(err)
	}
	var media tg.InputMediaClass
	switch kind {
	case "photo":
		media = &tg.InputMediaUploadedPhoto{File: f}
	case "voice":
		media = &tg.InputMediaUploadedDocument{File: f, MimeType: "audio/ogg", Attributes: []tg.DocumentAttributeClass{&tg.DocumentAttributeAudio{Voice: true, Duration: int(r.Duration + 0.5)}}}
	case "audio":
		media = &tg.InputMediaUploadedDocument{File: f, MimeType: orDefault(r.Mime, "audio/mpeg"), Attributes: []tg.DocumentAttributeClass{&tg.DocumentAttributeAudio{Duration: int(r.Duration + 0.5)}, &tg.DocumentAttributeFilename{FileName: name}}}
	case "video":
		media = &tg.InputMediaUploadedDocument{File: f, MimeType: orDefault(r.Mime, "video/mp4"), Attributes: []tg.DocumentAttributeClass{&tg.DocumentAttributeFilename{FileName: name}}}
	default:
		media = &tg.InputMediaUploadedDocument{File: f, MimeType: orDefault(r.Mime, "application/octet-stream"), ForceFile: true, Attributes: []tg.DocumentAttributeClass{&tg.DocumentAttributeFilename{FileName: name}}}
	}
	req := &tg.MessagesSendMediaRequest{Peer: ip, Media: media, Message: caption, RandomID: randInt64(), Silent: r.Silent}
	if r.ReplyTo > 0 {
		req.SetReplyTo(&tg.InputReplyToMessage{ReplyToMsgID: r.ReplyTo})
	}
	upd, err := api.MessagesSendMedia(ctx, req)
	if err != nil {
		te := toTgErr(err)
		s.audit.Log(map[string]any{"action": "send_media.failed", "origin": r.origin(), "session": r.Session, "chat": p.ID, "code": te.Code, "tg": te.TgType})
		return Msg{}, te
	}
	return s.afterSend(ctx, mgr, upd, p, r, caption, "send_media"), nil
}

func orDefault(v, d string) string {
	if strings.TrimSpace(v) == "" {
		return d
	}
	return v
}

func mediaKind(kind, mime string) string {
	switch kind {
	case "photo", "voice", "audio", "video", "document":
		return kind
	}
	switch {
	case mime == "image/jpeg" || mime == "image/png":
		return "photo"
	case strings.HasPrefix(mime, "audio/"):
		return "audio"
	case strings.HasPrefix(mime, "video/"):
		return "video"
	}
	return "document"
}

// toVoiceOgg converts any audio file to Telegram's voice format (Ogg Opus mono 48 kHz).
func toVoiceOgg(ctx context.Context, in string) (string, float64, error) {
	out := in + ".voice.ogg"
	c, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(c, "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", in, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-f", "ogg", out)
	if b, err := cmd.CombinedOutput(); err != nil {
		return "", 0, fmt.Errorf("ffmpeg: %v %s", err, strings.TrimSpace(string(b)))
	}
	dur := 0.0
	pc := exec.CommandContext(c, "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", out)
	if b, err := pc.Output(); err == nil {
		dur, _ = strconv.ParseFloat(strings.TrimSpace(string(b)), 64)
	}
	return out, dur, nil
}

// ---------------------------------------------------------------- read, resolve

func (s *Service) Read(ctx context.Context, chat int64, maxID int, origin string) (bool, error) {
	if origin != "ui" && !s.Config().AgentMarkRead {
		return false, nil
	}
	api, _, mgr, err := s.api(true)
	if err != nil {
		return false, err
	}
	p, ip, err := s.peer(chat)
	if err != nil {
		return false, err
	}
	if p.Kind == "channel" {
		if _, err := api.ChannelsReadHistory(ctx, &tg.ChannelsReadHistoryRequest{Channel: InputChannel(p), MaxID: maxID}); err != nil {
			return false, toTgErr(err)
		}
		return true, nil
	}
	res, err := api.MessagesReadHistory(ctx, &tg.MessagesReadHistoryRequest{Peer: ip, MaxID: maxID})
	if err != nil {
		return false, toTgErr(err)
	}
	if mgr != nil {
		_ = mgr.HandleAffected(ctx, 0, res.Pts, res.PtsCount)
	}
	return true, nil
}

// Resolve looks a public username up (UI only; agents never resolve unknown users).
func (s *Service) Resolve(ctx context.Context, username string) (Peer, error) {
	username = strings.TrimPrefix(strings.TrimSpace(username), "@")
	if username == "" {
		return Peer{}, errf("TELEGRAM_BAD_REQUEST", 400, "username missing")
	}
	if p, ok := s.store.PeerByUsername(username); ok && !p.Min {
		return p, nil
	}
	api, _, _, err := s.api(true)
	if err != nil {
		return Peer{}, err
	}
	res, err := api.ContactsResolveUsername(ctx, &tg.ContactsResolveUsernameRequest{Username: username})
	if err != nil {
		return Peer{}, toTgErr(err)
	}
	s.store.AbsorbUsers(res.Users)
	s.store.AbsorbChats(res.Chats)
	p, ok := s.store.PeerByID(markedOf(res.Peer))
	if !ok {
		return Peer{}, errf("TELEGRAM_CHAT_NOT_FOUND", 404, "@%s not found", username)
	}
	return p, nil
}

// ---------------------------------------------------------------- media download

func (s *Service) fetchMessage(ctx context.Context, api *tg.Client, p Peer, id int) (tg.MessageClass, error) {
	ids := []tg.InputMessageClass{&tg.InputMessageID{ID: id}}
	var res tg.MessagesMessagesClass
	var err error
	if p.Kind == "channel" {
		res, err = api.ChannelsGetMessages(ctx, &tg.ChannelsGetMessagesRequest{Channel: InputChannel(p), ID: ids})
	} else {
		res, err = api.MessagesGetMessages(ctx, ids)
	}
	if err != nil {
		return nil, toTgErr(err)
	}
	md, ok := res.AsModified()
	if !ok {
		return nil, errf("TELEGRAM_MEDIA_UNAVAILABLE", 404, "message not found")
	}
	s.store.AbsorbUsers(md.GetUsers())
	s.store.AbsorbChats(md.GetChats())
	for _, mc := range md.GetMessages() {
		if m, ok := mc.(*tg.Message); ok && m.ID == id {
			return m, nil
		}
	}
	return nil, errf("TELEGRAM_MEDIA_UNAVAILABLE", 404, "message %d not found", id)
}

type MediaFile struct {
	Path string `json:"-"`
	Mime string `json:"mime"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// Media returns a cached file for the media of a message (thumb = small preview).
func (s *Service) Media(ctx context.Context, chat int64, msgID int, thumb, force bool) (MediaFile, error) {
	variant := "full"
	if thumb {
		variant = "thumb"
	}
	key := fmt.Sprintf("%d_%d_%s", chat, msgID, variant)
	unlock := s.media.Lock(key)
	defer unlock()
	if f, ok := s.media.Get(key); ok {
		return f, nil
	}
	api, _, _, err := s.api(true)
	if err != nil {
		return MediaFile{}, err
	}
	p, _, err := s.peer(chat)
	if err != nil {
		return MediaFile{}, err
	}
	mc, err := s.fetchMessage(ctx, api, p, msgID)
	if err != nil {
		return MediaFile{}, err
	}
	m := mc.(*tg.Message)
	var loc tg.InputFileLocationClass
	meta := MediaFile{Mime: "image/jpeg"}
	photoLoc := func(ph *tg.Photo, maxSide int) bool {
		sz, ok := bestPhotoSize(ph.Sizes, maxSide)
		if !ok {
			return false
		}
		loc = &tg.InputPhotoFileLocation{ID: ph.ID, AccessHash: ph.AccessHash, FileReference: ph.FileReference, ThumbSize: sz.typ}
		meta.Name = fmt.Sprintf("photo-%d.jpg", msgID)
		return true
	}
	switch v := m.Media.(type) {
	case *tg.MessageMediaPhoto:
		ph, ok := v.Photo.(*tg.Photo)
		if !ok || !photoLoc(ph, map[bool]int{true: 400, false: 0}[thumb]) {
			return MediaFile{}, errf("TELEGRAM_MEDIA_UNAVAILABLE", 404, "photo not available")
		}
	case *tg.MessageMediaDocument:
		d, ok := v.Document.(*tg.Document)
		if !ok {
			return MediaFile{}, errf("TELEGRAM_MEDIA_UNAVAILABLE", 404, "document not available")
		}
		if thumb {
			sz, ok := bestPhotoSize(d.Thumbs, 400)
			if !ok {
				return MediaFile{}, errf("TELEGRAM_MEDIA_UNAVAILABLE", 404, "no preview for this file")
			}
			loc = &tg.InputDocumentFileLocation{ID: d.ID, AccessHash: d.AccessHash, FileReference: d.FileReference, ThumbSize: sz.typ}
			meta.Name = fmt.Sprintf("preview-%d.jpg", msgID)
		} else {
			if lim := int64(s.Config().Media.AutoDownloadMB) << 20; d.Size > lim && !force {
				e := errf("TELEGRAM_MEDIA_TOO_LARGE", 413, "the file is %d MB; ask for it explicitly (force) to download", d.Size>>20)
				return MediaFile{}, e
			}
			if capB := int64(s.Config().Media.CacheMB) << 20; d.Size > capB/2 {
				return MediaFile{}, errf("TELEGRAM_MEDIA_TOO_LARGE", 413, "the file is %d MB, larger than half the media cache", d.Size>>20)
			}
			loc = &tg.InputDocumentFileLocation{ID: d.ID, AccessHash: d.AccessHash, FileReference: d.FileReference}
			meta.Mime = orDefault(d.MimeType, "application/octet-stream")
			meta.Name = fmt.Sprintf("file-%d", msgID)
			for _, a := range d.Attributes {
				if fn, ok := a.(*tg.DocumentAttributeFilename); ok && fn.FileName != "" {
					meta.Name = fn.FileName
				}
			}
		}
	case *tg.MessageMediaWebPage:
		wp, ok := v.Webpage.(*tg.WebPage)
		if !ok {
			return MediaFile{}, errf("TELEGRAM_MEDIA_UNAVAILABLE", 404, "no link preview")
		}
		pc, ok := wp.GetPhoto()
		ph, ok2 := pc.(*tg.Photo)
		if !ok || !ok2 || !photoLoc(ph, 800) {
			return MediaFile{}, errf("TELEGRAM_MEDIA_UNAVAILABLE", 404, "no link preview image")
		}
	default:
		return MediaFile{}, errf("TELEGRAM_MEDIA_UNAVAILABLE", 404, "this message has no downloadable media")
	}
	tmp := s.media.TempPath(key)
	dctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	if _, err := downloader.NewDownloader().Download(api, loc).ToPath(dctx, tmp); err != nil {
		_ = os.Remove(tmp)
		return MediaFile{}, toTgErr(err)
	}
	return s.media.Commit(key, tmp, meta)
}
