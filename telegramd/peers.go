package main

// Peers and messages: conversion from MTProto objects to the small JSON shapes
// telegramd hands to phone-hookd. Chat ids are Bot API style marked ids:
// users keep their id, basic groups are -id, channels and supergroups are
// -(1e12 + id).

import (
	"fmt"
	"strings"

	"github.com/gotd/td/tg"
)

const channelMark = 1000000000000

func userMarked(id int64) int64    { return id }
func chatMarked(id int64) int64    { return -id }
func channelMarked(id int64) int64 { return -(channelMark + id) }

// SplitMarked returns the kind and raw id of a marked id.
func SplitMarked(id int64) (kind string, raw int64) {
	switch {
	case id > 0:
		return "user", id
	case id < -channelMark:
		return "channel", -id - channelMark
	case id < 0:
		return "group", -id
	}
	return "", 0
}

func markedOf(p tg.PeerClass) int64 {
	switch v := p.(type) {
	case *tg.PeerUser:
		return userMarked(v.UserID)
	case *tg.PeerChat:
		return chatMarked(v.ChatID)
	case *tg.PeerChannel:
		return channelMarked(v.ChannelID)
	}
	return 0
}

func userName(u *tg.User) string {
	n := strings.TrimSpace(u.FirstName + " " + u.LastName)
	if n == "" && u.Username != "" {
		n = "@" + u.Username
	}
	if n == "" && u.Deleted {
		n = "Deleted account"
	}
	if n == "" {
		n = fmt.Sprintf("User %d", u.ID)
	}
	return n
}

func firstUsername(primary string, list []tg.Username) string {
	if primary != "" {
		return primary
	}
	for _, u := range list {
		if u.Active {
			return u.Username
		}
	}
	return ""
}

func PeerFromUser(u *tg.User) Peer {
	return Peer{
		ID: userMarked(u.ID), Kind: "user", RawID: u.ID, AccessHash: u.AccessHash,
		Title: userName(u), Username: firstUsername(u.Username, u.Usernames),
		Bot: u.Bot, Self: u.Self, Deleted: u.Deleted, Verified: u.Verified, Scam: u.Scam, Min: u.Min,
	}
}

func PeerFromChat(c tg.ChatClass) (Peer, bool) {
	switch v := c.(type) {
	case *tg.Chat:
		return Peer{ID: chatMarked(v.ID), Kind: "group", RawID: v.ID, Title: v.Title, Creator: v.Creator, Left: v.Left || v.Deactivated, CanPost: !v.Left && !v.Deactivated}, true
	case *tg.ChatForbidden:
		return Peer{ID: chatMarked(v.ID), Kind: "group", RawID: v.ID, Title: v.Title, Left: true}, true
	case *tg.Channel:
		canPost := v.Creator
		if r, ok := v.GetAdminRights(); ok && r.PostMessages {
			canPost = true
		}
		if !v.Broadcast {
			// Supergroup: members may write unless banned by default rights.
			canPost = !v.Left
			if r, ok := v.GetDefaultBannedRights(); ok && r.SendMessages && !v.Creator {
				if ar, ok2 := v.GetAdminRights(); !ok2 || ar.Flags == 0 {
					canPost = false
				}
			}
		}
		return Peer{
			ID: channelMarked(v.ID), Kind: "channel", RawID: v.ID, AccessHash: v.AccessHash, Title: v.Title,
			Username: firstUsername(v.Username, v.Usernames), Broadcast: v.Broadcast, Megagroup: v.Megagroup,
			Creator: v.Creator, CanPost: canPost, Left: v.Left, Verified: v.Verified, Scam: v.Scam, Min: v.Min,
		}, true
	case *tg.ChannelForbidden:
		return Peer{ID: channelMarked(v.ID), Kind: "channel", RawID: v.ID, AccessHash: v.AccessHash, Title: v.Title, Broadcast: v.Broadcast, Megagroup: v.Megagroup, Left: true}, true
	}
	return Peer{}, false
}

// AbsorbEntities feeds every user and chat of an update or a result into the cache.
func (s *Store) AbsorbUsers(users []tg.UserClass) {
	for _, uc := range users {
		if u, ok := uc.(*tg.User); ok {
			s.PutPeer(PeerFromUser(u))
		}
	}
}

func (s *Store) AbsorbChats(chats []tg.ChatClass) {
	for _, c := range chats {
		if p, ok := PeerFromChat(c); ok {
			s.PutPeer(p)
		}
	}
}

func (s *Store) AbsorbEntities(e tg.Entities) {
	for _, u := range e.Users {
		s.PutPeer(PeerFromUser(u))
	}
	for _, c := range e.Chats {
		if p, ok := PeerFromChat(c); ok {
			s.PutPeer(p)
		}
	}
	for _, c := range e.Channels {
		if p, ok := PeerFromChat(c); ok {
			s.PutPeer(p)
		}
	}
}

// InputPeer builds the addressing object for a cached peer.
func InputPeer(p Peer) (tg.InputPeerClass, error) {
	if p.Min && p.Kind != "group" {
		return nil, fmt.Errorf("peer %d is only known from a group member list; open a conversation with it first", p.ID)
	}
	switch p.Kind {
	case "user":
		if p.Self {
			return &tg.InputPeerSelf{}, nil
		}
		return &tg.InputPeerUser{UserID: p.RawID, AccessHash: p.AccessHash}, nil
	case "group":
		return &tg.InputPeerChat{ChatID: p.RawID}, nil
	case "channel":
		return &tg.InputPeerChannel{ChannelID: p.RawID, AccessHash: p.AccessHash}, nil
	}
	return nil, fmt.Errorf("unknown peer kind %q", p.Kind)
}

func InputChannel(p Peer) *tg.InputChannel {
	return &tg.InputChannel{ChannelID: p.RawID, AccessHash: p.AccessHash}
}

func InputUser(p Peer) tg.InputUserClass {
	if p.Self {
		return &tg.InputUserSelf{}
	}
	return &tg.InputUser{UserID: p.RawID, AccessHash: p.AccessHash}
}

// ---------------------------------------------------------------- messages

type Link struct {
	Offset int    `json:"offset"`
	Length int    `json:"length"`
	URL    string `json:"url"`
}

type Media struct {
	Kind      string  `json:"kind"` // photo | video | round | voice | audio | document | sticker | gif | webpage | geo | venue | contact | poll | dice | other
	Name      string  `json:"name,omitempty"`
	Mime      string  `json:"mime,omitempty"`
	Size      int64   `json:"size,omitempty"`
	Duration  float64 `json:"duration,omitempty"`
	W         int     `json:"w,omitempty"`
	H         int     `json:"h,omitempty"`
	Thumb     bool    `json:"thumb,omitempty"`
	File      bool    `json:"file,omitempty"` // downloadable through /media
	URL       string  `json:"url,omitempty"`
	Title     string  `json:"title,omitempty"`
	Site      string  `json:"site,omitempty"`
	Desc      string  `json:"desc,omitempty"`
	Lat       float64 `json:"lat,omitempty"`
	Long      float64 `json:"long,omitempty"`
	Phone     string  `json:"phone,omitempty"`
	Emoji     string  `json:"emoji,omitempty"`
	Value     int     `json:"value,omitempty"`
	Performer string  `json:"performer,omitempty"`
}

type Msg struct {
	Chat     int64  `json:"chat"`
	ID       int    `json:"id"`
	Date     int64  `json:"date"`
	Out      bool   `json:"out"`
	From     int64  `json:"from,omitempty"`
	FromName string `json:"fromName,omitempty"`
	Text     string `json:"text"`
	ReplyTo  int    `json:"replyTo,omitempty"`
	Fwd      string `json:"fwd,omitempty"`
	Edit     int64  `json:"edit,omitempty"`
	Views    int    `json:"views,omitempty"`
	Post     bool   `json:"post,omitempty"`
	Service  string `json:"service,omitempty"`
	Group    int64  `json:"group,omitempty"`
	Media    *Media `json:"media,omitempty"`
	Links    []Link `json:"links,omitempty"`
}

// ConvertMessage turns an MTProto message into a Msg; ok is false for empty messages.
func (s *Store) ConvertMessage(mc tg.MessageClass) (Msg, bool) {
	switch m := mc.(type) {
	case *tg.Message:
		out := Msg{Chat: markedOf(m.PeerID), ID: m.ID, Date: int64(m.Date), Out: m.Out, Text: m.Message, Views: m.Views, Post: m.Post, Edit: int64(m.EditDate), Group: m.GroupedID}
		s.fillFrom(&out, m.FromID, m.PeerID)
		if h, ok := m.ReplyTo.(*tg.MessageReplyHeader); ok {
			out.ReplyTo = h.ReplyToMsgID
		}
		if f, ok := m.GetFwdFrom(); ok {
			out.Fwd = f.FromName
			if out.Fwd == "" && f.FromID != nil {
				if p, ok := s.PeerByID(markedOf(f.FromID)); ok {
					out.Fwd = p.Title
				} else {
					out.Fwd = "forwarded"
				}
			}
			if out.Fwd == "" {
				out.Fwd = "forwarded"
			}
		}
		for _, e := range m.Entities {
			if u, ok := e.(*tg.MessageEntityTextURL); ok {
				out.Links = append(out.Links, Link{Offset: u.Offset, Length: u.Length, URL: u.URL})
			}
		}
		if m.Media != nil {
			out.Media = ConvertMedia(m.Media)
		}
		return out, true
	case *tg.MessageService:
		out := Msg{Chat: markedOf(m.PeerID), ID: m.ID, Date: int64(m.Date), Out: m.Out, Post: m.Post}
		s.fillFrom(&out, m.FromID, m.PeerID)
		out.Service = actionText(m.Action)
		return out, true
	}
	return Msg{}, false
}

func (s *Store) fillFrom(out *Msg, from, peer tg.PeerClass) {
	if from == nil {
		from = peer
	}
	if from == nil {
		return
	}
	out.From = markedOf(from)
	if p, ok := s.PeerByID(out.From); ok {
		out.FromName = p.Title
	}
}

func ConvertMedia(mm tg.MessageMediaClass) *Media {
	switch v := mm.(type) {
	case *tg.MessageMediaPhoto:
		md := &Media{Kind: "photo", Mime: "image/jpeg"}
		if ph, ok := v.Photo.(*tg.Photo); ok {
			if t, ok := bestPhotoSize(ph.Sizes, 0); ok {
				md.W, md.H, md.Size = t.w, t.h, int64(t.size)
			}
			md.File, md.Thumb = true, true
		}
		return md
	case *tg.MessageMediaDocument:
		md := &Media{Kind: "document"}
		d, ok := v.Document.(*tg.Document)
		if !ok {
			return md
		}
		md.Mime, md.Size, md.File = d.MimeType, d.Size, true
		md.Thumb = len(d.Thumbs) > 0
		for _, a := range d.Attributes {
			switch at := a.(type) {
			case *tg.DocumentAttributeFilename:
				md.Name = at.FileName
			case *tg.DocumentAttributeAudio:
				md.Duration = float64(at.Duration)
				md.Title, md.Performer = at.Title, at.Performer
				if at.Voice {
					md.Kind = "voice"
				} else {
					md.Kind = "audio"
				}
			case *tg.DocumentAttributeVideo:
				md.Duration, md.W, md.H = at.Duration, at.W, at.H
				if at.RoundMessage {
					md.Kind = "round"
				} else if md.Kind != "gif" {
					md.Kind = "video"
				}
			case *tg.DocumentAttributeAnimated:
				md.Kind = "gif"
			case *tg.DocumentAttributeSticker:
				md.Kind, md.Emoji = "sticker", at.Alt
			case *tg.DocumentAttributeImageSize:
				md.W, md.H = at.W, at.H
			}
		}
		return md
	case *tg.MessageMediaWebPage:
		md := &Media{Kind: "webpage"}
		if w, ok := v.Webpage.(*tg.WebPage); ok {
			md.URL, md.Title, md.Site, md.Desc = w.URL, w.Title, w.SiteName, w.Description
			if _, ok := w.GetPhoto(); ok {
				md.Thumb = true
			}
		}
		return md
	case *tg.MessageMediaGeo:
		md := &Media{Kind: "geo"}
		if g, ok := v.Geo.(*tg.GeoPoint); ok {
			md.Lat, md.Long = g.Lat, g.Long
		}
		return md
	case *tg.MessageMediaGeoLive:
		md := &Media{Kind: "geo"}
		if g, ok := v.Geo.(*tg.GeoPoint); ok {
			md.Lat, md.Long = g.Lat, g.Long
		}
		return md
	case *tg.MessageMediaVenue:
		md := &Media{Kind: "venue", Title: v.Title, Desc: v.Address}
		if g, ok := v.Geo.(*tg.GeoPoint); ok {
			md.Lat, md.Long = g.Lat, g.Long
		}
		return md
	case *tg.MessageMediaContact:
		return &Media{Kind: "contact", Name: strings.TrimSpace(v.FirstName + " " + v.LastName), Phone: v.PhoneNumber}
	case *tg.MessageMediaPoll:
		md := &Media{Kind: "poll"}
		md.Title = v.Poll.Question.Text
		return md
	case *tg.MessageMediaDice:
		return &Media{Kind: "dice", Emoji: v.Emoticon, Value: v.Value}
	}
	return &Media{Kind: "other", Name: strings.TrimPrefix(fmt.Sprintf("%T", mm), "*tg.MessageMedia")}
}

type sizeInfo struct {
	typ        string
	w, h, size int
}

// bestPhotoSize picks the largest size, or with maxSide > 0 the largest one
// whose longer side is <= maxSide (falling back to the smallest real size).
func bestPhotoSize(sizes []tg.PhotoSizeClass, maxSide int) (sizeInfo, bool) {
	var all []sizeInfo
	for _, s := range sizes {
		switch v := s.(type) {
		case *tg.PhotoSize:
			all = append(all, sizeInfo{v.Type, v.W, v.H, v.Size})
		case *tg.PhotoSizeProgressive:
			n := 0
			if len(v.Sizes) > 0 {
				n = v.Sizes[len(v.Sizes)-1]
			}
			all = append(all, sizeInfo{v.Type, v.W, v.H, n})
		case *tg.PhotoCachedSize:
			all = append(all, sizeInfo{v.Type, v.W, v.H, len(v.Bytes)})
		}
	}
	if len(all) == 0 {
		return sizeInfo{}, false
	}
	side := func(s sizeInfo) int { return max(s.w, s.h) }
	var best, smallest sizeInfo
	found := false
	for i, s := range all {
		if i == 0 || side(s) < side(smallest) {
			smallest = s
		}
		if maxSide > 0 && side(s) > maxSide {
			continue
		}
		if !found || side(s) > side(best) {
			best, found = s, true
		}
	}
	if !found {
		return smallest, true
	}
	return best, true
}

func actionText(a tg.MessageActionClass) string {
	switch v := a.(type) {
	case *tg.MessageActionChatCreate:
		return "created the group " + v.Title
	case *tg.MessageActionChannelCreate:
		return "created the channel " + v.Title
	case *tg.MessageActionChatEditTitle:
		return "changed the title to " + v.Title
	case *tg.MessageActionChatEditPhoto:
		return "changed the photo"
	case *tg.MessageActionChatDeletePhoto:
		return "removed the photo"
	case *tg.MessageActionChatAddUser:
		return "added members"
	case *tg.MessageActionChatDeleteUser:
		return "removed a member"
	case *tg.MessageActionChatJoinedByLink, *tg.MessageActionChatJoinedByRequest:
		return "joined the group"
	case *tg.MessageActionPinMessage:
		return "pinned a message"
	case *tg.MessageActionHistoryClear:
		return "cleared the history"
	case *tg.MessageActionPhoneCall:
		kind := "call"
		if v.Video {
			kind = "video call"
		}
		reason := ""
		switch v.Reason.(type) {
		case *tg.PhoneCallDiscardReasonMissed:
			reason = "missed"
		case *tg.PhoneCallDiscardReasonBusy:
			reason = "busy"
		case *tg.PhoneCallDiscardReasonHangup:
			reason = "ended"
		case *tg.PhoneCallDiscardReasonDisconnect:
			reason = "disconnected"
		}
		if v.Duration > 0 {
			return fmt.Sprintf("%s, %s, %d s", kind, reason, v.Duration)
		}
		return strings.TrimSuffix(kind+", "+reason, ", ")
	case *tg.MessageActionScreenshotTaken:
		return "took a screenshot"
	case *tg.MessageActionContactSignUp:
		return "joined Telegram"
	}
	return "service: " + strings.TrimPrefix(fmt.Sprintf("%T", a), "*tg.MessageAction")
}
