package main

// Independent checks of the Diffie-Hellman material of a Telegram call,
// before anything is handed to the media library (which derives the key and
// verifies the commitment and fingerprint as well). Rules from
// https://core.telegram.org/api/end-to-end/voice-calls and
// https://core.telegram.org/mtproto/security_guidelines.

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"math/big"
	"sync"
)

const dhKeySize = 256 // bytes: 2048-bit prime and public values

var (
	bigOne = big.NewInt(1)

	safePrimeMu    sync.Mutex
	safePrimeCache = map[[32]byte]bool{}
)

// CheckDHConfig validates the group from messages.getDhConfig: a 2048-bit
// safe prime p and a generator g in 2..7 that generates a subgroup of
// order (p-1)/2 (checked through p's residue, as the guidelines require).
func CheckDHConfig(g int, pBytes []byte) error {
	p := new(big.Int).SetBytes(pBytes)
	if p.BitLen() != dhKeySize*8 {
		return fmt.Errorf("dh prime is %d bits, want %d", p.BitLen(), dhKeySize*8)
	}
	if !gConditionHolds(g, p) {
		return fmt.Errorf("dh generator %d does not satisfy its condition for this prime", g)
	}
	key := sha256.Sum256(pBytes)
	safePrimeMu.Lock()
	known, ok := safePrimeCache[key]
	safePrimeMu.Unlock()
	if ok {
		if !known {
			return errors.New("dh prime is not a safe prime")
		}
		return nil
	}
	q := new(big.Int).Rsh(new(big.Int).Sub(p, bigOne), 1)
	safe := p.ProbablyPrime(20) && q.ProbablyPrime(20)
	safePrimeMu.Lock()
	safePrimeCache[key] = safe
	safePrimeMu.Unlock()
	if !safe {
		return errors.New("dh prime is not a safe prime")
	}
	return nil
}

func gConditionHolds(g int, p *big.Int) bool {
	mod := func(m int64) int64 { return new(big.Int).Mod(p, big.NewInt(m)).Int64() }
	switch g {
	case 2:
		return mod(8) == 7
	case 3:
		return mod(3) == 2
	case 4:
		return true
	case 5:
		r := mod(5)
		return r == 1 || r == 4
	case 6:
		r := mod(24)
		return r == 19 || r == 23
	case 7:
		r := mod(7)
		return r == 3 || r == 5 || r == 6
	}
	return false
}

// CheckDHValue checks a public value g_a or g_b: 1 < v < p-1 and
// 2^(2048-64) <= v <= p - 2^(2048-64).
func CheckDHValue(vBytes, pBytes []byte) error {
	v := new(big.Int).SetBytes(vBytes)
	p := new(big.Int).SetBytes(pBytes)
	if v.Cmp(bigOne) <= 0 || v.Cmp(new(big.Int).Sub(p, bigOne)) >= 0 {
		return errors.New("dh value out of range")
	}
	bound := new(big.Int).Lsh(bigOne, uint(dhKeySize*8-64))
	if v.Cmp(bound) < 0 || v.Cmp(new(big.Int).Sub(p, bound)) > 0 {
		return errors.New("dh value too close to the edges of the group")
	}
	return nil
}

// CheckGAHash verifies the caller's commitment: SHA256(g_a) == g_a_hash.
func CheckGAHash(ga, gaHash []byte) error {
	sum := sha256.Sum256(ga)
	if len(gaHash) != len(sum) || !bytes.Equal(sum[:], gaHash) {
		return errors.New("g_a does not match the hash the caller committed to")
	}
	return nil
}
