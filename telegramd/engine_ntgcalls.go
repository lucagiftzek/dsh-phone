//go:build ntgcalls

package main

// cgo binding to libntgcalls (LGPL-3.0, prebuilt, dynamically linked; see
// scripts/fetch-ntgcalls.sh). Only what 1:1 voice calls need: P2P call,
// key exchange, external 16-bit PCM in and out, signalling, connection
// state and the emoji key fingerprint.

/*
#cgo CFLAGS: -I${SRCDIR}/ntg/include
#cgo LDFLAGS: -L${SRCDIR}/ntg/lib -lntgcalls -Wl,-rpath,/usr/local/lib/dsh-phone
#include <stdlib.h>
#include "ntgcalls.h"
extern void tgdSignal(ntg_instance* h, int64_t key, uint8_t* data, size_t n, void* ud);
extern void tgdFrames(ntg_instance* h, int64_t key, ntg_stream_mode mode, ntg_stream_device dev, ntg_frame* frames, size_t n, void* ud);
extern void tgdConn(ntg_instance* h, int64_t key, ntg_connection_info info, void* ud);
extern void tgdEmojis(ntg_instance* h, int64_t key, char* emojis, void* ud);
extern void tgdLog(ntg_log_message m, void* ud);
*/
import "C"

import (
	"fmt"
	"log"
	"sync"
	"unsafe"
)

type ntgEngine struct {
	h  *C.ntg_instance
	mu sync.RWMutex
	cb EngineCallbacks
}

var (
	theEngine   *ntgEngine
	theEngineMu sync.Mutex
)

func newMediaEngine() MediaEngine {
	theEngineMu.Lock()
	defer theEngineMu.Unlock()
	if theEngine != nil {
		return theEngine
	}
	C.ntg_set_log_callback((C.ntg_log_cb)(unsafe.Pointer(C.tgdLog)), nil)
	e := &ntgEngine{h: C.ntg_instance_create()}
	C.ntg_on_signaling_data_callback(e.h, (C.ntg_signaling_data_callback_cb)(unsafe.Pointer(C.tgdSignal)), nil)
	C.ntg_on_frames_callback(e.h, (C.ntg_frames_callback_cb)(unsafe.Pointer(C.tgdFrames)), nil)
	C.ntg_on_connection_change_callback(e.h, (C.ntg_connection_change_callback_cb)(unsafe.Pointer(C.tgdConn)), nil)
	C.ntg_on_update_emojis_callback(e.h, (C.ntg_update_emojis_callback_cb)(unsafe.Pointer(C.tgdEmojis)), nil)
	theEngine = e
	return e
}

func ntgErr(op string, r C.ntg_result) error {
	if r == C.NTG_OK {
		return nil
	}
	msg := ""
	if p := C.ntg_last_error(); p != nil {
		msg = C.GoString(p)
	}
	return fmt.Errorf("ntgcalls %s: code %d %s", op, int(r), msg)
}

// cbytes copies b into C memory (nil for an empty slice); free with C.free.
func cbytes(b []byte) (*C.uint8_t, C.size_t) {
	if len(b) == 0 {
		return nil, 0
	}
	return (*C.uint8_t)(C.CBytes(b)), C.size_t(len(b))
}

func cfree(p unsafe.Pointer) {
	if p != nil {
		C.free(p)
	}
}

func (e *ntgEngine) Available() error { return nil }
func (e *ntgEngine) Version() string  { return C.GoString(C.ntg_get_version()) }

func (e *ntgEngine) SetCallbacks(cb EngineCallbacks) {
	e.mu.Lock()
	e.cb = cb
	e.mu.Unlock()
}

func (e *ntgEngine) callbacks() EngineCallbacks {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.cb
}

func (e *ntgEngine) Protocol() (EngineProtocol, error) {
	var p C.ntg_protocol
	if err := ntgErr("get_protocol", C.ntg_get_protocol(&p)); err != nil {
		return EngineProtocol{}, err
	}
	defer C.ntg_protocol_free(&p)
	out := EngineProtocol{MinLayer: int(p.min_layer), MaxLayer: int(p.max_layer), UDPP2P: bool(p.udp_p2p), UDPReflector: bool(p.udp_reflector)}
	if p.library_versions_len > 0 {
		vs := unsafe.Slice(p.library_versions, int(p.library_versions_len))
		for _, v := range vs {
			out.Versions = append(out.Versions, C.GoString(v))
		}
	}
	return out, nil
}

func (e *ntgEngine) CreateP2P(key int64) error {
	return ntgErr("create_p2p_call", C.ntg_create_p2p_call(e.h, C.int64_t(key)))
}

func (e *ntgEngine) InitExchange(key int64, g int, p, random, gaHash []byte) ([]byte, error) {
	pp, pn := cbytes(p)
	defer cfree(unsafe.Pointer(pp))
	rp, rn := cbytes(random)
	defer cfree(unsafe.Pointer(rp))
	hp, hn := cbytes(gaHash)
	defer cfree(unsafe.Pointer(hp))
	dh := C.ntg_dh_config{g: C.int32_t(g), p: pp, p_len: pn, random: rp, random_len: rn}
	var out *C.uint8_t
	var outLen C.size_t
	if err := ntgErr("init_exchange", C.ntg_init_exchange(e.h, C.int64_t(key), dh, hp, hn, &out, &outLen)); err != nil {
		return nil, err
	}
	defer C.ntg_bytes_free(unsafe.Pointer(out))
	return C.GoBytes(unsafe.Pointer(out), C.int(outLen)), nil
}

func (e *ntgEngine) ExchangeKeys(key int64, peerValue []byte, fingerprint int64) ([]byte, int64, error) {
	vp, vn := cbytes(peerValue)
	defer cfree(unsafe.Pointer(vp))
	var ap C.ntg_auth_params
	if err := ntgErr("exchange_keys", C.ntg_exchange_keys(e.h, C.int64_t(key), vp, vn, C.int64_t(fingerprint), &ap)); err != nil {
		return nil, 0, err
	}
	defer C.ntg_auth_params_free(&ap)
	return C.GoBytes(unsafe.Pointer(ap.g_a_or_b), C.int(ap.g_a_or_b_len)), int64(ap.key_fingerprint), nil
}

func (e *ntgEngine) SetExternalAudio(key int64, sampleRate, channels int) error {
	return e.setExternal(key, C.NTG_STREAM_MODE_CAPTURE, sampleRate, channels)
}

func (e *ntgEngine) SetExternalPlayback(key int64, sampleRate, channels int) error {
	return e.setExternal(key, C.NTG_STREAM_MODE_PLAYBACK, sampleRate, channels)
}

func (e *ntgEngine) setExternal(key int64, mode C.ntg_stream_mode, sampleRate, channels int) error {
	{
		ad := (*C.ntg_audio_description)(C.calloc(1, C.size_t(unsafe.Sizeof(C.ntg_audio_description{}))))
		input := C.CString("")
		ad.media_source = C.NTG_MEDIA_SOURCE_EXTERNAL
		ad.sample_rate = C.uint32_t(sampleRate)
		ad.channel_count = C.uint8_t(channels)
		ad.input = input
		desc := C.ntg_media_description{microphone: ad}
		err := ntgErr("set_stream_sources", C.ntg_set_stream_sources(e.h, C.int64_t(key), mode, desc))
		C.free(unsafe.Pointer(input))
		C.free(unsafe.Pointer(ad))
		if err != nil {
			return err
		}
	}
	return nil
}

func (e *ntgEngine) Connect(key int64, servers []RTCServer, versions []string, p2pAllowed bool) error {
	var toFree []unsafe.Pointer
	defer func() {
		for _, p := range toFree {
			C.free(p)
		}
	}()
	str := func(s string) *C.char {
		if s == "" {
			return nil
		}
		p := C.CString(s)
		toFree = append(toFree, unsafe.Pointer(p))
		return p
	}
	var arr *C.ntg_rtc_server
	if len(servers) > 0 {
		arr = (*C.ntg_rtc_server)(C.calloc(C.size_t(len(servers)), C.size_t(unsafe.Sizeof(C.ntg_rtc_server{}))))
		toFree = append(toFree, unsafe.Pointer(arr))
		cs := unsafe.Slice(arr, len(servers))
		for i, s := range servers {
			cs[i].id = C.uint64_t(s.ID)
			cs[i].ipv4 = str(s.IPv4)
			cs[i].ipv6 = str(s.IPv6)
			cs[i].port = C.uint16_t(s.Port)
			cs[i].username = str(s.Username)
			cs[i].password = str(s.Password)
			cs[i].turn = C.bool(s.Turn)
			cs[i].stun = C.bool(s.Stun)
			cs[i].tcp = C.bool(s.TCP)
			if len(s.PeerTag) > 0 {
				tp, tn := cbytes(s.PeerTag)
				toFree = append(toFree, unsafe.Pointer(tp))
				cs[i].peer_tag, cs[i].peer_tag_len = tp, tn
			}
		}
	}
	var varr **C.char
	if len(versions) > 0 {
		varr = (**C.char)(C.calloc(C.size_t(len(versions)), C.size_t(unsafe.Sizeof((*C.char)(nil)))))
		toFree = append(toFree, unsafe.Pointer(varr))
		vs := unsafe.Slice(varr, len(versions))
		for i, v := range versions {
			vs[i] = str(v)
		}
	}
	return ntgErr("connect_p2p", C.ntg_connect_p2p(e.h, C.int64_t(key), arr, C.size_t(len(servers)), varr, C.size_t(len(versions)), C.bool(p2pAllowed), nil))
}

func (e *ntgEngine) SendSignaling(key int64, data []byte) error {
	p, n := cbytes(data)
	defer cfree(unsafe.Pointer(p))
	return ntgErr("send_signaling_data", C.ntg_send_signaling_data(e.h, C.int64_t(key), p, n))
}

func (e *ntgEngine) SendAudio(key int64, pcm []byte, tsMs int64) error {
	p, n := cbytes(pcm)
	defer cfree(unsafe.Pointer(p))
	fd := C.ntg_frame_data{absolute_capture_timestamp_ms: C.int64_t(tsMs)}
	return ntgErr("send_external_frame", C.ntg_send_external_frame(e.h, C.int64_t(key), C.NTG_STREAM_DEVICE_MICROPHONE, p, n, fd))
}

func (e *ntgEngine) Mute(key int64, on bool) error {
	var out C.bool
	if on {
		return ntgErr("mute", C.ntg_mute(e.h, C.int64_t(key), &out))
	}
	return ntgErr("unmute", C.ntg_unmute(e.h, C.int64_t(key), &out))
}

func (e *ntgEngine) Stop(key int64) error {
	return ntgErr("stop", C.ntg_stop(e.h, C.int64_t(key)))
}

// ---------------------------------------------------------------- callbacks from the library's threads

//export tgdSignal
func tgdSignal(h *C.ntg_instance, key C.int64_t, data *C.uint8_t, n C.size_t, _ unsafe.Pointer) {
	e := theEngine
	if e == nil {
		return
	}
	b := C.GoBytes(unsafe.Pointer(data), C.int(n))
	if cb := e.callbacks().Signal; cb != nil {
		go cb(int64(key), b)
	}
}

//export tgdFrames
func tgdFrames(h *C.ntg_instance, key C.int64_t, mode C.ntg_stream_mode, dev C.ntg_stream_device, frames *C.ntg_frame, n C.size_t, _ unsafe.Pointer) {
	e := theEngine
	if e == nil || mode != C.NTG_STREAM_MODE_PLAYBACK || n == 0 {
		return
	}
	if dev != C.NTG_STREAM_DEVICE_MICROPHONE && dev != C.NTG_STREAM_DEVICE_SPEAKER {
		return
	}
	cb := e.callbacks().Frames
	if cb == nil {
		return
	}
	for _, f := range unsafe.Slice(frames, int(n)) {
		if f.data_len == 0 {
			continue
		}
		cb(int64(key), C.GoBytes(unsafe.Pointer(f.data), C.int(f.data_len)), 1)
	}
}

//export tgdConn
func tgdConn(h *C.ntg_instance, key C.int64_t, info C.ntg_connection_info, _ unsafe.Pointer) {
	e := theEngine
	if e == nil || info.kind != C.NTG_CONNECTION_KIND_NORMAL {
		return
	}
	state := map[C.ntg_connection_state]string{
		C.NTG_CONNECTION_STATE_CONNECTING: "connecting", C.NTG_CONNECTION_STATE_CONNECTED: "connected",
		C.NTG_CONNECTION_STATE_FAILED: "failed", C.NTG_CONNECTION_STATE_TIMEOUT: "timeout", C.NTG_CONNECTION_STATE_CLOSED: "closed",
	}[info.state]
	if cb := e.callbacks().Connection; cb != nil {
		go cb(int64(key), state)
	}
}

//export tgdEmojis
func tgdEmojis(h *C.ntg_instance, key C.int64_t, emojis *C.char, _ unsafe.Pointer) {
	e := theEngine
	if e == nil || emojis == nil {
		return
	}
	s := C.GoString(emojis)
	if cb := e.callbacks().Emojis; cb != nil {
		go cb(int64(key), s)
	}
}

//export tgdLog
func tgdLog(m C.ntg_log_message, _ unsafe.Pointer) {
	if m.level < C.NTG_LOG_WARNING {
		return
	}
	src := "ntgcalls"
	if m.source == C.NTG_LOG_SOURCE_WEBRTC {
		src = "webrtc"
	}
	log.Printf("%s: %s", src, redactLong(C.GoString(m.message)))
}
