//go:build !ntgcalls

package main

import "errors"

// Built without the call media library: everything except calls works.
type noEngine struct{}

var errNoEngine = errors.New("this telegramd was built without call support (build tag ntgcalls)")

func newMediaEngine() MediaEngine { return noEngine{} }

func (noEngine) Available() error                       { return errNoEngine }
func (noEngine) Version() string                        { return "" }
func (noEngine) Protocol() (EngineProtocol, error)      { return EngineProtocol{}, errNoEngine }
func (noEngine) SetCallbacks(EngineCallbacks)           {}
func (noEngine) CreateP2P(int64) error                  { return errNoEngine }
func (noEngine) SetExternalAudio(int64, int, int) error { return errNoEngine }
func (noEngine) SetExternalPlayback(int64, int, int) error { return errNoEngine }
func (noEngine) InitExchange(int64, int, []byte, []byte, []byte) ([]byte, error) {
	return nil, errNoEngine
}
func (noEngine) ExchangeKeys(int64, []byte, int64) ([]byte, int64, error) { return nil, 0, errNoEngine }
func (noEngine) Connect(int64, []RTCServer, []string, bool) error         { return errNoEngine }
func (noEngine) SendSignaling(int64, []byte) error                        { return errNoEngine }
func (noEngine) SendAudio(int64, []byte, int64) error                     { return errNoEngine }
func (noEngine) Mute(int64, bool) error                                   { return errNoEngine }
func (noEngine) Stop(int64) error                                         { return nil }
