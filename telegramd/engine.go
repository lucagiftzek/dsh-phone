package main

// MediaEngine is the call media library as telegramd sees it: one P2P call
// per key (telegramd uses the peer's user id), external PCM in and out, the
// key exchange and the signalling channel. The real implementation is
// libntgcalls through cgo (engine_ntgcalls.go, build tag "ntgcalls"); tests
// use a fake.

type RTCServer struct {
	ID       int64
	IPv4     string
	IPv6     string
	Port     int
	Username string
	Password string
	Turn     bool
	Stun     bool
	TCP      bool
	PeerTag  []byte
}

type EngineProtocol struct {
	MinLayer, MaxLayer   int
	UDPP2P, UDPReflector bool
	Versions             []string
}

type EngineCallbacks struct {
	Signal     func(key int64, data []byte)
	Frames     func(key int64, pcm []byte, channels int)
	Connection func(key int64, state string) // connecting | connected | failed | timeout | closed
	Emojis     func(key int64, emojis string)
}

type MediaEngine interface {
	Available() error
	Version() string
	Protocol() (EngineProtocol, error)
	SetCallbacks(cb EngineCallbacks)
	CreateP2P(key int64) error
	// InitExchange starts the DH: outgoing (gaHash nil) returns SHA256(g_a);
	// incoming (gaHash = the caller's commitment) returns g_b.
	InitExchange(key int64, g int, p, random, gaHash []byte) ([]byte, error)
	// ExchangeKeys completes the DH with the peer's value; outgoing passes
	// fingerprint 0 and gets g_a plus the key fingerprint for confirmCall.
	ExchangeKeys(key int64, peerValue []byte, fingerprint int64) (gaOrB []byte, keyFingerprint int64, err error)
	// SetExternalAudio sets the external capture (our audio to the peer); before Connect.
	SetExternalAudio(key int64, sampleRate, channels int) error
	// SetExternalPlayback asks for the peer's audio as PCM frames; only once the call is
	// connected (set before the negotiation, libntgcalls 3.0.5 creates the incoming channel
	// twice and crashes: "conflicting criteria" in the RTP demuxer).
	SetExternalPlayback(key int64, sampleRate, channels int) error
	Connect(key int64, servers []RTCServer, versions []string, p2pAllowed bool) error
	SendSignaling(key int64, data []byte) error
	SendAudio(key int64, pcm []byte, tsMs int64) error
	Mute(key int64, on bool) error
	Stop(key int64) error
}

const engineSampleRate = 48000
