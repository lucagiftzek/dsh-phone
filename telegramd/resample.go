package main

// Audio between the phone hub (G.711 mu-law, 8 kHz, 20 ms blocks of 160
// bytes) and the call media library (16-bit PCM, 48 kHz mono, 10 ms frames
// of 960 bytes): mu-law codec and a windowed-sinc FIR for the 6x up and
// down conversion (pass band to about 3.4 kHz, the telephone band).

import (
	"encoding/binary"
	"math"
)

const (
	ulawBlock   = 160 // bytes per 20 ms at 8 kHz
	pcm48Frame  = 480 // samples per 10 ms at 48 kHz
	resampleK   = 6   // 48000 / 8000
	firTaps     = 97
	firCutoffHz = 3600.0
)

var firCoeffs = makeLowpass(firTaps, firCutoffHz/48000.0)

func makeLowpass(n int, fc float64) []float64 {
	h := make([]float64, n)
	m := float64(n - 1)
	sum := 0.0
	for i := range h {
		x := float64(i) - m/2
		var s float64
		if x == 0 {
			s = 2 * fc
		} else {
			s = math.Sin(2*math.Pi*fc*x) / (math.Pi * x)
		}
		// Blackman window
		w := 0.42 - 0.5*math.Cos(2*math.Pi*float64(i)/m) + 0.08*math.Cos(4*math.Pi*float64(i)/m)
		h[i] = s * w
		sum += h[i]
	}
	for i := range h {
		h[i] /= sum // unity gain at DC
	}
	return h
}

// ---------------------------------------------------------------- G.711 mu-law

func ulawDecode(u byte) int16 {
	u = ^u
	sign := u & 0x80
	exp := (u >> 4) & 0x07
	mant := u & 0x0f
	v := ((int(mant) << 3) + 0x84) << exp
	v -= 0x84
	if sign != 0 {
		return int16(-v)
	}
	return int16(v)
}

func ulawEncode(s int16) byte {
	const bias, clip = 0x84, 32635
	v := int(s)
	sign := 0
	if v < 0 {
		v = -v
		sign = 0x80
	}
	if v > clip {
		v = clip
	}
	v += bias
	exp := 7
	for mask := 0x4000; v&mask == 0 && exp > 0; mask >>= 1 {
		exp--
	}
	mant := (v >> (exp + 3)) & 0x0f
	return ^byte(sign | exp<<4 | mant)
}

// ---------------------------------------------------------------- up: 8 kHz mu-law -> 48 kHz PCM

type Upsampler struct {
	hist []float64 // zero-stuffed 48 kHz history, newest last
	out  []int16   // pending 48 kHz samples
}

func NewUpsampler() *Upsampler { return &Upsampler{hist: make([]float64, firTaps)} }

func (u *Upsampler) push(v float64) float64 {
	copy(u.hist, u.hist[1:])
	u.hist[firTaps-1] = v
	acc := 0.0
	for i, c := range firCoeffs {
		acc += c * u.hist[firTaps-1-i]
	}
	return acc
}

// WriteULaw consumes mu-law bytes and buffers the 48 kHz samples.
func (u *Upsampler) WriteULaw(b []byte) {
	for _, x := range b {
		s := float64(ulawDecode(x))
		for k := 0; k < resampleK; k++ {
			in := 0.0
			if k == 0 {
				in = s * resampleK // compensate the zero stuffing
			}
			u.out = append(u.out, clip16(u.push(in)))
		}
	}
}

// Frames returns complete 10 ms frames (960 bytes little-endian each).
func (u *Upsampler) Frames() [][]byte {
	var frames [][]byte
	for len(u.out) >= pcm48Frame {
		f := make([]byte, pcm48Frame*2)
		for i := 0; i < pcm48Frame; i++ {
			binary.LittleEndian.PutUint16(f[i*2:], uint16(u.out[i]))
		}
		frames = append(frames, f)
		u.out = u.out[pcm48Frame:]
	}
	if cap(u.out) > 8*pcm48Frame && len(u.out) == 0 {
		u.out = nil
	}
	return frames
}

// ---------------------------------------------------------------- down: 48 kHz PCM -> 8 kHz mu-law

type Downsampler struct {
	hist  []float64
	phase int
	out   []byte // pending mu-law bytes
}

func NewDownsampler() *Downsampler { return &Downsampler{hist: make([]float64, firTaps)} }

// WritePCM consumes 48 kHz 16-bit little-endian mono (or the first channel
// of interleaved stereo when channels == 2).
func (d *Downsampler) WritePCM(b []byte, channels int) {
	if channels < 1 {
		channels = 1
	}
	step := 2 * channels
	for i := 0; i+1 < len(b); i += step {
		s := float64(int16(binary.LittleEndian.Uint16(b[i:])))
		copy(d.hist, d.hist[1:])
		d.hist[firTaps-1] = s
		d.phase++
		if d.phase < resampleK {
			continue
		}
		d.phase = 0
		acc := 0.0
		for j, c := range firCoeffs {
			acc += c * d.hist[firTaps-1-j]
		}
		d.out = append(d.out, ulawEncode(clip16(acc)))
	}
}

// Blocks returns complete 20 ms mu-law blocks of 160 bytes.
func (d *Downsampler) Blocks() [][]byte {
	var blocks [][]byte
	for len(d.out) >= ulawBlock {
		blk := make([]byte, ulawBlock)
		copy(blk, d.out[:ulawBlock])
		blocks = append(blocks, blk)
		d.out = d.out[ulawBlock:]
	}
	if len(d.out) == 0 {
		d.out = nil
	}
	return blocks
}

func clip16(v float64) int16 {
	v = math.Round(v)
	if v > 32767 {
		return 32767
	}
	if v < -32768 {
		return -32768
	}
	return int16(v)
}
