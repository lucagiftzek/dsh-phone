package main

// Store: the MTProto update state (pts, qts, date, seq, per-channel pts),
// access hashes and the peer cache, sealed in one file and flushed at most
// every flushEvery. It implements gotd's updates.StateStorage,
// updates.ChannelAccessHasher and updates.UserAccessHasher, and
// session.Storage (separate sealed file, written at once).

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram/updates"
)

const (
	labelState   = "state"
	labelSession = "session"
	flushEvery   = 2 * time.Second
)

// Peer is one user, basic group or channel/supergroup the account has seen.
type Peer struct {
	ID         int64  `json:"id"`   // Bot API style marked id
	Kind       string `json:"kind"` // user | group | channel
	RawID      int64  `json:"rawId"`
	AccessHash int64  `json:"-"`
	Title      string `json:"title"`
	Username   string `json:"username,omitempty"`
	Bot        bool   `json:"bot,omitempty"`
	Broadcast  bool   `json:"broadcast,omitempty"` // channel (not supergroup)
	Megagroup  bool   `json:"megagroup,omitempty"`
	CanPost    bool   `json:"canPost,omitempty"`
	Creator    bool   `json:"creator,omitempty"`
	Self       bool   `json:"self,omitempty"`
	Deleted    bool   `json:"deleted,omitempty"`
	Verified   bool   `json:"verified,omitempty"`
	Scam       bool   `json:"scam,omitempty"`
	Left       bool   `json:"left,omitempty"`
	Min        bool   `json:"-"`
}

type peerDisk struct {
	Peer
	AccessHash int64 `json:"ah"`
	Min        bool  `json:"min,omitempty"`
}

type stateDisk struct {
	Owner       int64              `json:"owner"`
	HasState    bool               `json:"hasState"`
	State       updates.State      `json:"state"`
	ChannelPts  map[int64]int      `json:"channelPts"`
	ChannelHash map[int64]int64    `json:"channelHash"`
	UserHash    map[int64]int64    `json:"userHash"`
	Peers       map[int64]peerDisk `json:"peers"`
	Dialogs     map[int64]int64    `json:"dialogs"` // marked id -> last activity (unix)
}

type Store struct {
	vault       *Vault
	statePath   string
	sessionPath string

	mu    sync.Mutex
	d     stateDisk
	dirty bool
	stop  chan struct{}
	done  chan struct{}
}

func newStateDisk() stateDisk {
	return stateDisk{
		ChannelPts:  map[int64]int{},
		ChannelHash: map[int64]int64{},
		UserHash:    map[int64]int64{},
		Peers:       map[int64]peerDisk{},
		Dialogs:     map[int64]int64{},
	}
}

func OpenStore(v *Vault, statePath, sessionPath string) (*Store, error) {
	s := &Store{vault: v, statePath: statePath, sessionPath: sessionPath, d: newStateDisk(), stop: make(chan struct{}), done: make(chan struct{})}
	b, err := v.ReadSealed(statePath, labelState)
	if err != nil {
		return nil, err
	}
	if b != nil {
		d := newStateDisk()
		if err := json.Unmarshal(b, &d); err != nil {
			return nil, err
		}
		if d.ChannelPts == nil {
			d.ChannelPts = map[int64]int{}
		}
		if d.ChannelHash == nil {
			d.ChannelHash = map[int64]int64{}
		}
		if d.UserHash == nil {
			d.UserHash = map[int64]int64{}
		}
		if d.Peers == nil {
			d.Peers = map[int64]peerDisk{}
		}
		if d.Dialogs == nil {
			d.Dialogs = map[int64]int64{}
		}
		s.d = d
	}
	go s.flusher()
	return s, nil
}

func (s *Store) flusher() {
	defer close(s.done)
	t := time.NewTicker(flushEvery)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			_ = s.Flush()
		case <-s.stop:
			_ = s.Flush()
			return
		}
	}
}

func (s *Store) Close() error {
	select {
	case <-s.stop:
	default:
		close(s.stop)
	}
	<-s.done
	return nil
}

func (s *Store) Flush() error {
	s.mu.Lock()
	if !s.dirty {
		s.mu.Unlock()
		return nil
	}
	b, err := json.Marshal(s.d)
	s.dirty = false
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return s.vault.WriteSealed(s.statePath, labelState, b)
}

// Reset forgets everything (logout, or another account logged in).
func (s *Store) Reset(owner int64) {
	s.mu.Lock()
	s.d = newStateDisk()
	s.d.Owner = owner
	s.dirty = true
	s.mu.Unlock()
	_ = s.Flush()
}

// Owner returns the account id the state belongs to (0 = none yet).
func (s *Store) Owner() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.d.Owner
}

// Adopt makes userID the owner; a different previous owner resets the state.
func (s *Store) Adopt(userID int64) {
	s.mu.Lock()
	prev := s.d.Owner
	s.mu.Unlock()
	if prev != userID {
		s.Reset(userID)
	}
}

func (s *Store) touch() { s.dirty = true }

// ---------------------------------------------------------------- session.Storage

type sessionStore struct{ s *Store }

func (s *Store) Session() session.Storage { return sessionStore{s} }

func (ss sessionStore) LoadSession(ctx context.Context) ([]byte, error) {
	b, err := ss.s.vault.ReadSealed(ss.s.sessionPath, labelSession)
	if err != nil {
		return nil, err
	}
	if b == nil {
		return nil, session.ErrNotFound
	}
	return b, nil
}

func (ss sessionStore) StoreSession(ctx context.Context, data []byte) error {
	return ss.s.vault.WriteSealed(ss.s.sessionPath, labelSession, data)
}

// ---------------------------------------------------------------- updates.StateStorage

func (s *Store) GetState(ctx context.Context, userID int64) (updates.State, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.d.Owner != userID || !s.d.HasState {
		return updates.State{}, false, nil
	}
	return s.d.State, true, nil
}

func (s *Store) SetState(ctx context.Context, userID int64, st updates.State) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.Owner, s.d.State, s.d.HasState = userID, st, true
	s.d.ChannelPts = map[int64]int{}
	s.touch()
	return nil
}

func (s *Store) set(fn func(st *updates.State)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(&s.d.State)
	s.touch()
	return nil
}

func (s *Store) SetPts(ctx context.Context, userID int64, pts int) error {
	return s.set(func(st *updates.State) { st.Pts = pts })
}
func (s *Store) SetQts(ctx context.Context, userID int64, qts int) error {
	return s.set(func(st *updates.State) { st.Qts = qts })
}
func (s *Store) SetDate(ctx context.Context, userID int64, date int) error {
	return s.set(func(st *updates.State) { st.Date = date })
}
func (s *Store) SetSeq(ctx context.Context, userID int64, seq int) error {
	return s.set(func(st *updates.State) { st.Seq = seq })
}
func (s *Store) SetDateSeq(ctx context.Context, userID int64, date, seq int) error {
	return s.set(func(st *updates.State) { st.Date, st.Seq = date, seq })
}

func (s *Store) GetChannelPts(ctx context.Context, userID, channelID int64) (int, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.d.ChannelPts[channelID]
	return p, ok, nil
}

func (s *Store) SetChannelPts(ctx context.Context, userID, channelID int64, pts int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.ChannelPts[channelID] = pts
	s.touch()
	return nil
}

func (s *Store) ForEachChannels(ctx context.Context, userID int64, f func(ctx context.Context, channelID int64, pts int) error) error {
	s.mu.Lock()
	cp := make(map[int64]int, len(s.d.ChannelPts))
	for k, v := range s.d.ChannelPts {
		cp[k] = v
	}
	s.mu.Unlock()
	for k, v := range cp {
		if err := f(ctx, k, v); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------- access hashers

func (s *Store) SetChannelAccessHash(ctx context.Context, userID, channelID, accessHash int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.ChannelHash[channelID] = accessHash
	s.touch()
	return nil
}

func (s *Store) GetChannelAccessHash(ctx context.Context, userID, channelID int64) (int64, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h, ok := s.d.ChannelHash[channelID]
	return h, ok, nil
}

func (s *Store) SetUserAccessHash(ctx context.Context, userID, targetUserID, accessHash int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.UserHash[targetUserID] = accessHash
	s.touch()
	return nil
}

func (s *Store) GetUserAccessHash(ctx context.Context, userID, targetUserID int64) (int64, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h, ok := s.d.UserHash[targetUserID]
	return h, ok, nil
}

// ---------------------------------------------------------------- peers and dialogs

// PutPeer merges p into the cache. A "min" record never replaces a full
// access hash (min hashes cannot be used to address the peer).
func (s *Store) PutPeer(p Peer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	old, ok := s.d.Peers[p.ID]
	nd := peerDisk{Peer: p, AccessHash: p.AccessHash, Min: p.Min}
	if ok && p.Min {
		if !old.Min {
			nd.AccessHash, nd.Min = old.AccessHash, false
		}
		if nd.Title == "" {
			nd.Title = old.Title
		}
		if nd.Username == "" {
			nd.Username = old.Username
		}
		nd.CanPost = nd.CanPost || old.CanPost
		nd.Creator = nd.Creator || old.Creator
	}
	nd.Peer.AccessHash, nd.Peer.Min = nd.AccessHash, nd.Min
	if ok && old.Peer == nd.Peer && old.AccessHash == nd.AccessHash && old.Min == nd.Min {
		return
	}
	s.d.Peers[p.ID] = nd
	if !nd.Min {
		switch p.Kind {
		case "user":
			s.d.UserHash[p.RawID] = nd.AccessHash
		case "channel":
			s.d.ChannelHash[p.RawID] = nd.AccessHash
		}
	}
	s.touch()
}

func (s *Store) PeerByID(id int64) (Peer, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pd, ok := s.d.Peers[id]
	if !ok {
		return Peer{}, false
	}
	p := pd.Peer
	p.AccessHash, p.Min = pd.AccessHash, pd.Min
	return p, true
}

// PeerByUsername looks a cached peer up by its public username (case-insensitive).
func (s *Store) PeerByUsername(u string) (Peer, bool) {
	u = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(u)), "@")
	if u == "" {
		return Peer{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, pd := range s.d.Peers {
		if strings.ToLower(pd.Username) == u {
			p := pd.Peer
			p.AccessHash, p.Min = pd.AccessHash, pd.Min
			return p, true
		}
	}
	return Peer{}, false
}

// MarkDialog records that the account has a conversation with id (it is in
// the dialog list, or a message arrived from or went to it).
func (s *Store) MarkDialog(id int64, at int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.d.Dialogs[id]; ok && old >= at {
		return
	}
	s.d.Dialogs[id] = at
	s.touch()
}

func (s *Store) IsDialog(id int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.d.Dialogs[id]
	return ok
}

func (s *Store) DialogIDs() []int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]int64, 0, len(s.d.Dialogs))
	for id := range s.d.Dialogs {
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return s.d.Dialogs[out[i]] > s.d.Dialogs[out[j]] })
	return out
}

func (s *Store) Counts() (peers, dialogs, channels int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.d.Peers), len(s.d.Dialogs), len(s.d.ChannelPts)
}
