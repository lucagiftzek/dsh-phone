package main

// Call audio between phone-hookd and the call media library.
//
// phone-hookd connects to calls.sock (0600, next to telegramd.sock) once per
// call, sends one JSON line {"callId": "...", "key": "..."} (the key came
// with the call event on the private event stream) and then exchanges raw
// 160-byte G.711 mu-law blocks (20 ms at 8 kHz, the hub's format) both ways.
// telegramd resamples to and from 48 kHz 16-bit mono for the engine.

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"net"
	"os"
	"sync"
	"sync/atomic"
)


type callAudio struct {
	conn   net.Conn
	up     *Upsampler
	down   *Downsampler
	send   func(pcm []byte) error
	out    chan []byte
	closed atomic.Bool
	live   atomic.Bool // the call is connected: only then audio goes to the engine
	once   sync.Once
	mu     sync.Mutex
	In     atomic.Int64 // blocks from hookd
	Out    atomic.Int64 // blocks to hookd
}

func newCallAudio(conn net.Conn) *callAudio {
	return &callAudio{conn: conn, up: NewUpsampler(), down: NewDownsampler(), out: make(chan []byte, 50)}
}

func (a *callAudio) Close() {
	a.once.Do(func() {
		a.mu.Lock()
		a.closed.Store(true)
		close(a.out)
		a.mu.Unlock()
		_ = a.conn.Close()
	})
}

// FromEngine takes 48 kHz PCM from the far end and queues mu-law blocks for hookd.
func (a *callAudio) FromEngine(pcm []byte, channels int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed.Load() {
		return
	}
	a.down.WritePCM(pcm, channels)
	for _, b := range a.down.Blocks() {
		select {
		case a.out <- b:
		default: // hookd is slow: drop rather than build latency
		}
	}
}

func (a *callAudio) writer() {
	for b := range a.out {
		if _, err := a.conn.Write(b); err != nil {
			a.Close()
			return
		}
		a.Out.Add(1)
	}
}

func (a *callAudio) reader() {
	buf := make([]byte, ulawBlock)
	for {
		if _, err := io.ReadFull(a.conn, buf); err != nil {
			return
		}
		a.In.Add(1)
		a.up.WriteULaw(buf)
		for _, f := range a.up.Frames() {
			if a.send != nil && a.live.Load() {
				_ = a.send(f)
			}
		}
	}
}

// serveCallAudio listens on path until the listener is closed.
func (s *Service) serveCallAudio(path string) (net.Listener, error) {
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	_ = os.Chmod(path, 0o600)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go s.handleCallAudio(conn)
		}
	}()
	return ln, nil
}

func (s *Service) handleCallAudio(conn net.Conn) {
	br := bufio.NewReaderSize(conn, 512)
	line, err := br.ReadSlice('\n')
	if err != nil {
		_ = conn.Close()
		return
	}
	var hello struct {
		CallID string `json:"callId"`
		Key    string `json:"key"`
	}
	if json.Unmarshal(line, &hello) != nil || s.calls == nil {
		_, _ = conn.Write([]byte("{\"ok\":false}\n"))
		_ = conn.Close()
		return
	}
	a := newCallAudio(&bufConn{Conn: conn, r: br})
	if err := s.calls.attachAudio(hello.CallID, hello.Key, a); err != nil {
		_, _ = conn.Write([]byte("{\"ok\":false}\n"))
		_ = conn.Close()
		log.Printf("call audio: refused (%v)", err)
		return
	}
	_, _ = conn.Write([]byte("{\"ok\":true}\n"))
	go a.writer()
	a.reader()
	s.calls.detachAudio(a)
	a.Close()
}

// bufConn reads through the bufio.Reader that consumed the hello line.
type bufConn struct {
	net.Conn
	r *bufio.Reader
}

func (b *bufConn) Read(p []byte) (int, error) { return b.r.Read(p) }
