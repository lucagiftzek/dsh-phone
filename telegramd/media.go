package main

// MediaCache: downloaded Telegram media under media/, one file per message
// and variant plus a small .meta JSON (mime, name). Least recently used
// files go first when the directory grows past the configured cap.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var keyRe = regexp.MustCompile(`^-?[0-9]+_[0-9]+_(full|thumb)$`)

type MediaCache struct {
	dir   string
	capFn func() int64
	mu    sync.Mutex
	locks map[string]*keyLock
}

type keyLock struct {
	mu   sync.Mutex
	refs int
}

func NewMediaCache(dir string, capFn func() int64) *MediaCache {
	return &MediaCache{dir: dir, capFn: capFn, locks: map[string]*keyLock{}}
}

// Lock serialises downloads of one key; it returns the unlock function.
func (c *MediaCache) Lock(key string) func() {
	c.mu.Lock()
	l := c.locks[key]
	if l == nil {
		l = &keyLock{}
		c.locks[key] = l
	}
	l.refs++
	c.mu.Unlock()
	l.mu.Lock()
	return func() {
		l.mu.Unlock()
		c.mu.Lock()
		l.refs--
		if l.refs == 0 {
			delete(c.locks, key)
		}
		c.mu.Unlock()
	}
}

func (c *MediaCache) path(key string) string { return filepath.Join(c.dir, key) }

func (c *MediaCache) TempPath(key string) string {
	return filepath.Join(c.dir, ".dl-"+key+"-"+time.Now().Format("150405.000000000"))
}

func (c *MediaCache) Get(key string) (MediaFile, bool) {
	if !keyRe.MatchString(key) {
		return MediaFile{}, false
	}
	p := c.path(key)
	st, err := os.Stat(p)
	if err != nil {
		return MediaFile{}, false
	}
	var m MediaFile
	if b, err := os.ReadFile(p + ".meta"); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	now := time.Now()
	_ = os.Chtimes(p, now, now)
	m.Path, m.Size = p, st.Size()
	if m.Mime == "" {
		m.Mime = "application/octet-stream"
	}
	return m, true
}

// Commit moves a finished download into place, sniffs image types, writes
// the meta file and trims the cache.
func (c *MediaCache) Commit(key, tmp string, meta MediaFile) (MediaFile, error) {
	p := c.path(key)
	if f, err := os.Open(tmp); err == nil {
		head := make([]byte, 512)
		n, _ := f.Read(head)
		f.Close()
		if sniff := http.DetectContentType(head[:n]); strings.HasPrefix(sniff, "image/") || meta.Mime == "" {
			meta.Mime = sniff
		}
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return MediaFile{}, err
	}
	if err := os.Rename(tmp, p); err != nil {
		return MediaFile{}, err
	}
	b, _ := json.Marshal(MediaFile{Mime: meta.Mime, Name: meta.Name})
	_ = writeFileAtomic(p+".meta", b)
	c.Trim(key)
	st, err := os.Stat(p)
	if err != nil {
		return MediaFile{}, err
	}
	meta.Path, meta.Size = p, st.Size()
	return meta, nil
}

type cacheEntry struct {
	key  string
	size int64
	mod  time.Time
}

func (c *MediaCache) entries() []cacheEntry {
	des, _ := os.ReadDir(c.dir)
	out := []cacheEntry{}
	for _, de := range des {
		n := de.Name()
		if strings.HasPrefix(n, ".dl-") {
			if info, err := de.Info(); err == nil && time.Since(info.ModTime()) > time.Hour {
				_ = os.Remove(filepath.Join(c.dir, n))
			}
			continue
		}
		if !keyRe.MatchString(n) {
			continue
		}
		info, err := de.Info()
		if err != nil {
			continue
		}
		out = append(out, cacheEntry{n, info.Size(), info.ModTime()})
	}
	return out
}

// Trim removes least recently used files until the cache fits its cap; keep
// is never removed (the file just downloaded).
func (c *MediaCache) Trim(keep string) {
	limit := c.capFn()
	es := c.entries()
	var total int64
	for _, e := range es {
		total += e.size
	}
	if total <= limit {
		return
	}
	sort.Slice(es, func(i, j int) bool { return es[i].mod.Before(es[j].mod) })
	for _, e := range es {
		if total <= limit {
			break
		}
		if e.key == keep {
			continue
		}
		_ = os.Remove(c.path(e.key))
		_ = os.Remove(c.path(e.key) + ".meta")
		total -= e.size
	}
}

func (c *MediaCache) Usage() map[string]any {
	es := c.entries()
	var total int64
	for _, e := range es {
		total += e.size
	}
	return map[string]any{"files": len(es), "bytes": total, "capBytes": c.capFn()}
}

func (c *MediaCache) Clear() int {
	n := 0
	for _, e := range c.entries() {
		_ = os.Remove(c.path(e.key))
		_ = os.Remove(c.path(e.key) + ".meta")
		n++
	}
	return n
}
